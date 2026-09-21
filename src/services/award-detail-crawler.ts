import axios from 'axios';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AwardBidder, AwardDetailBatch, AwardDetailInput, AwardDetailKind, AwardDetailRecord,
  AwardDetailResult, NonAwardDetailRecord,
} from '../types/award.js';

/**
 * 決標公告／無法決標公告內頁（得標廠商唯一的完整來源，清單沒有廠商欄）。
 *
 * 內頁有流量控制：約連抓 5~8 筆就跳撲克牌驗證碼、鎖 20 分鐘以上，而且被鎖期間再打只會延長。
 * 所以策略是省著用：解析結果能確認才快取且永不重抓、任意 10 分鐘最多 5 次內頁請求（種類不符、解析失敗、
 * 連線錯誤也佔額度）、單次呼叫也最多 5 次、序列＋間隔 3 秒、一遇驗證碼就停整批並在冷卻期內拒絕再連線。
 * 額度與冷卻起點寫在 .cache/award-rate.json，Claude Desktop 與 Claude Code 兩個行程合計仍是同一份額度。
 * 絕不重試、絕不繞過驗證碼。
 */

const SITE_ORIGIN = 'https://web.pcc.gov.tw';
const AWARD_DETAIL_URL = `${SITE_ORIGIN}/tps/atm/AtmAwardWithoutSso/QueryAtmAwardDetail?pkAtmMain=`;
const NON_AWARD_DETAIL_URL = `${SITE_ORIGIN}/tps/atm/AtmNonAwardWithoutSso/QueryAtmNonAwardDetail?pkAtmMain=`;

export const MAX_AWARD_FETCH_PER_CALL = 5;
export const MAX_AWARD_CASES = 50;
export const AWARD_FETCH_INTERVAL_MS = 3000;
/** 實測封鎖約 25 分鐘；冷卻期內連線只會延長封鎖 */
export const AWARD_BLOCK_COOLDOWN_MS = 20 * 60 * 1000;
/** 跨呼叫（含並行呼叫）共用的滾動額度：任意 10 分鐘內最多 5 次內頁請求。實測連抓 5 筆就被鎖，單次上限擋不住連續多次呼叫 */
export const DETAIL_WINDOW_MAX = 5;
export const DETAIL_WINDOW_MS = 10 * 60 * 1000;
/** full=true 時只對前幾筆成功案附全部欄位：每筆約 3 千字元，50 筆全附會塞爆對話 */
export const FULL_FIELDS_MAX_CASES = 5;

// build 後此檔在 build/services/，快取固定放專案根的 .cache/
// ⚠️ 不可依賴工作目錄：MCP 由 GUI 啟動時 CWD 是 C:\Windows\System32，寫入會被拒
export const AWARD_DETAIL_CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'award-details.json');
/** 滾動額度與冷卻起點：Claude Desktop 與 Claude Code 會各開一個 MCP 行程，靠這個檔共用同一份額度 */
export const AWARD_RATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'award-rate.json');

// Node 內建 fetch 會被 WAF 擋，必須 axios＋這組 headers
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9',
  'Referer': 'https://web.pcc.gov.tw/prkms/tender/common/agent/indexTenderAgent',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- 輸入正規化 ----------

export function awardDetailUrl(kind: AwardDetailKind, pk: string): string {
  return (kind === 'award' ? AWARD_DETAIL_URL : NON_AWARD_DETAIL_URL) + encodeURIComponent(pk);
}

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const isPk = (s: string) => /^[A-Za-z0-9+/]{4,}={0,2}$/.test(s) && s.length % 4 === 0;
/**
 * 實測 pkAtmMain 都是「base64 解開是純數字」。連結裡的 pk 也套同一標準：
 * 沒有這道檢查，abcd、/tps/x 這類字串會被當成 pk，截斷過的 pk 也看不出來。
 */
const isPkValue = (s: string) => isPk(s) && /^\d+$/.test(Buffer.from(s, 'base64').toString('latin1'));

// pk 只收 base64 與 % 字元，而且後面必須緊接分隔（結尾／& # 空白 ) ] > ` " ' 全形標點）：
// 少了這個界線，...atm?pk=NzEy!ODE3MTM= 會被截成 NzEy（解碼＝712）而抓到別的案子。
// [決標公告](url)、<url> 這類包裝的尾端 ] ) > 則照樣不會被吃進 pk。
const LINK_PATTERNS: [RegExp, AwardDetailKind][] = [
  [/\/prkms\/urlSelector\/common\/atm\?(?:[^#\s]*?&(?:amp;)?)?pk=([A-Za-z0-9+/=%]*)(?=$|[&#\s)\]>`"'，。（）])/i, 'award'],
  [/\/prkms\/urlSelector\/common\/nonAtm\?(?:[^#\s]*?&(?:amp;)?)?pk=([A-Za-z0-9+/=%]*)(?=$|[&#\s)\]>`"'，。（）])/i, 'nonAward'],
  [/\/tps\/atm\/AtmAwardWithoutSso\/QueryAtmAwardDetail\?(?:[^#\s]*?&(?:amp;)?)?pkAtmMain=([A-Za-z0-9+/=%]*)(?=$|[&#\s)\]>`"'，。（）])/i, 'award'],
  [/\/tps\/atm\/AtmNonAwardWithoutSso\/QueryAtmNonAwardDetail\?(?:[^#\s]*?&(?:amp;)?)?pkAtmMain=([A-Za-z0-9+/=%]*)(?=$|[&#\s)\]>`"'，。（）])/i, 'nonAward'],
];

/** 從對話貼過來的純 pk 常被 ` < > [ ] ( ) 或引號包住，先剝掉再判斷 */
const stripWrappers = (s: string) => s.replace(/^[`<>[\]()"'“”‘’\s]+/, '').replace(/[`<>[\]()"'“”‘’\s]+$/, '');

const KIND_LABEL: Record<AwardDetailKind, string> = { award: '決標公告', nonAward: '無法決標公告' };

export type NormalizedAwardInput =
  | { ok: true; value: AwardDetailInput }
  | { ok: false; failure: 'invalid' | 'tender'; message: string };

export function normalizeAwardInput(raw: string): NormalizedAwardInput {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, failure: 'invalid', message: '空字串，請給決標公告連結或 pk' };

  // 招標公告與決標公告的 pk 是不同編號空間，拿去打決標內頁會回別的案子
  if (/\/urlSelector\/common\/tpam\?/i.test(s) || /searchTenderDetail\?[^#\s]*pkPmsMain=/i.test(s)) {
    return { ok: false, failure: 'tender', message: '這是招標公告連結，不是決標公告；招標公告請改用 get_tender_detail' };
  }

  for (const [re, kind] of LINK_PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    const pk = safeDecode(m[1]);
    if (!isPkValue(pk)) return { ok: false, failure: 'invalid', message: `連結裡的 pk「${m[1]}」格式不對` };
    return { ok: true, value: { input: s, kind, pk, url: awardDetailUrl(kind, pk), assumedKind: false } };
  }

  // 純 pk：與連結裡的 pk 同標準（base64 解開是數字），外層包的符號先剝掉
  const bare = safeDecode(stripWrappers(s));
  if (isPkValue(bare)) {
    return { ok: true, value: { input: s, kind: 'award', pk: bare, url: awardDetailUrl('award', bare), assumedKind: true } };
  }
  return { ok: false, failure: 'invalid', message: '無法辨識：請給 search_awards 表格裡的決標公告／無法決標公告連結，或 pk 值' };
}

// ---------- 解析 ----------

const NAMED_ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

const cellText = (inner: string) => decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * 內頁是 tr 內 td/td 相鄰配對（第一格 label、之後第一個非空格為 value）。
 * 刻意用非貪婪 regex 切 tr 而不是 DOM：「決標方式」格內嵌一張表，DOM 會把評選委員名單按鈕字樣併進值裡。
 * 被註解掉的整列（<!-- <tr>… -->）要先拿掉，不然會冒出假欄位。
 */
export function extractAwardPairs(html: string): [string, string][] {
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const out: [string, string][] = [];
  for (const m of body.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const cells = [...m[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x => cellText(x[1]));
    if (cells.length >= 2) out.push([cells[0], cells.slice(1).find(Boolean) ?? '']);
  }
  return out;
}

function parseMoney(s: string): number | null {
  const m = s.replace(/,/g, '').match(/(\d+)\s*元/);
  return m ? parseInt(m[1], 10) : null;
}

function finder(pairs: [string, string][]) {
  return (label: string, fallback?: RegExp): string => {
    const hit = pairs.find(([k]) => k === label) ?? (fallback ? pairs.find(([k]) => fallback.test(k)) : undefined);
    return hit ? hit[1] : '';
  };
}

const BIDDER_END = /^(簽約廠商家數|決標品項數?|決標資料|得標廠商\d+|第\d+品項)$/;

export function parseAwardRecord(pairs: [string, string][]): AwardDetailRecord {
  const find = finder(pairs);
  const bidders: AwardBidder[] = [];
  let cur: AwardBidder | null = null;
  for (const [k, v] of pairs) {
    const m = /^投標廠商(\d+)$/.exec(k);
    if (m) {
      cur = { no: parseInt(m[1], 10), vendorId: '', name: '', won: '', orgType: '', trade: '', address: '', phone: '', sme: '', amount: null, period: '' };
      bidders.push(cur);
      continue;
    }
    if (!cur) continue;
    if (BIDDER_END.test(k)) { cur = null; continue; }
    switch (k) {
      case '廠商代碼': cur.vendorId = v; break;
      case '廠商名稱': cur.name = v; break;
      case '是否得標': cur.won = v; break;
      case '組織型態': cur.orgType = v; break;
      case '廠商業別': cur.trade = v; break;
      case '廠商地址': cur.address = v; break;
      case '廠商電話': cur.phone = v; break;
      case '是否為中小企業': cur.sme = v; break;
      case '決標金額': cur.amount = parseMoney(v); break;
      case '履約起迄日期': cur.period = v; break;
    }
  }

  const budget = parseMoney(find('預算金額'));
  const totalAward = parseMoney(find('總決標金額'));
  const countText = find('投標廠商家數').match(/\d+/);
  // 品項區（第N品項→得標廠商N）有品項層級的底價金額排在前面，全案底價在「決標公告序號」之後；
  // 複數決標時品項底價≠全案底價，找不到全案那格寧可留空也不拿品項的充數
  const seqIdx = pairs.findIndex(([k]) => k === '決標公告序號');
  const floorText = (seqIdx >= 0 ? finder(pairs.slice(seqIdx))('底價金額') : '')
    || (find('是否複數決標').startsWith('是') ? '' : find('底價金額'));
  return {
    pageType: 'award',
    orgName: find('機關名稱'),
    caseNo: find('標案案號'),
    tenderName: find('標案名稱'),
    category: find('標的分類'),
    tenderWay: find('招標方式'),
    awardWay: find('決標方式'),
    budget,
    floorPrice: parseMoney(floorText),
    totalAward,
    awardDate: find('決標日期'),
    awardNoticeDate: find('決標公告日期'),
    execArea: find('履約地點（含地區）', /^履約地點[（(]含地區[)）]$/),
    period: find('履約起迄日期'),
    bidderCount: countText ? parseInt(countText[0], 10) : null,
    jointBid: find('是否共同投標'),
    bidders,
    winners: bidders.filter(b => b.won.startsWith('是')),
    losers: bidders.filter(b => b.won.startsWith('否')),
    discountRate: budget != null && totalAward != null && budget > 0
      ? Math.round((1 - totalAward / budget) * 10000) / 100
      : null,
  };
}

export function parseNonAwardRecord(pairs: [string, string][]): NonAwardDetailRecord {
  const find = finder(pairs);
  return {
    pageType: 'nonAward',
    orgName: find('機關名稱'),
    caseNo: find('標案案號'),
    tenderName: find('標案名稱'),
    category: find('標的分類'),
    reason: find('無法決標的理由', /無法決標的?理由/),
    originalBulletinDate: find('原招標公告之刊登採購公報日期', /原招標公告.*刊登.*日期/),
    nonAwardNoticeDate: find('無法決標公告日期', /^無法決標公告日期/),
    continueSameCase: find('是否沿用本案號及原招標方式續行招標', /沿用本案號/),
  };
}

export type AwardPageParse =
  | { type: 'award'; record: AwardDetailRecord; pairs: [string, string][]; ambiguous?: boolean }
  | { type: 'nonAward'; record: NonAwardDetailRecord; pairs: [string, string][]; ambiguous?: boolean }
  | { type: 'blocked'; message: string }
  | { type: 'parse'; message: string };

export type AwardPageOk = Extract<AwardPageParse, { type: 'award' | 'nonAward' }>;

/**
 * 依內容判別頁面種類，不信任呼叫端給的 kind。
 * preferKind 只有在「投標廠商家數」與「無法決標的理由」兩種欄位並存（ambiguous）時才採用——
 * 這種頁面沒有真實樣本，光看內容判不出來，只能靠連結裡的路徑。
 */
export function parseAwardDetailHtml(html: string, preferKind?: AwardDetailKind | null): AwardPageParse {
  const hasAward = html.includes('投標廠商家數');
  const hasNonAward = html.includes('無法決標的理由');
  if (hasAward || hasNonAward) {
    const pairs = extractAwardPairs(html);
    // 「無法決標的理由」欄優先：決標內頁素材 9 份都沒有這個字，無法決標公告卻可能也列投標廠商家數
    const nonAwardLabel = pairs.some(([k]) => /無法決標的?理由/.test(k));
    const awardLabel = pairs.some(([k]) => k === '投標廠商家數');
    const ambiguous = nonAwardLabel && awardLabel;
    const asAward = ambiguous ? preferKind === 'award' : (!nonAwardLabel && hasAward);
    const record = asAward ? parseAwardRecord(pairs) : parseNonAwardRecord(pairs);
    if (!record.caseNo && !record.tenderName) {
      return { type: 'parse', message: `內頁版型不符：找不到標案案號與標案名稱（回應 ${html.length} 字元）` };
    }
    return asAward
      ? { type: 'award', record: record as AwardDetailRecord, pairs, ambiguous }
      : { type: 'nonAward', record: record as NonAwardDetailRecord, pairs, ambiguous };
  }
  if (/驗證碼|撲克|請輸入圖形/.test(html)) return { type: 'blocked', message: '網站流量控制（驗證碼頁）' };
  if (html.includes('Web Page Blocked')) return { type: 'blocked', message: '網站防火牆封鎖（Web Page Blocked）' };
  return { type: 'parse', message: `內頁版型不符，不是決標或無法決標公告（回應 ${html.length} 字元）` };
}

// ---------- 連線（全模組共用一條序列通道，並行呼叫也維持間隔） ----------

let lastRequestEnd = 0;
let lane: Promise<unknown> = Promise.resolve();
let blockedAt = 0;

function inLane<T>(fn: () => Promise<T>): Promise<T> {
  const run = lane.then(fn);
  lane = run.catch(() => undefined);
  return run;
}

function cooldownRemainingMs(): number {
  return blockedAt ? Math.max(0, blockedAt + AWARD_BLOCK_COOLDOWN_MS - Date.now()) : 0;
}

/** 只給驗收腳本用：清除冷卻狀態（不影響請求間隔） */
export function resetAwardBlockCooldown(): void {
  blockedAt = 0;
}

/** 只給驗收腳本用：指定冷卻起點，驗證冷卻訊息的時間格式 */
export function setAwardBlockedAt(ms: number): void {
  blockedAt = ms;
}

// 滾動額度只用這個時鐘；請求間隔與冷卻仍用真實時間（假時鐘不前進會讓間隔迴圈卡死）
let windowClock: () => number = () => Date.now();
let windowStamps: number[] = [];

/** 只給驗收腳本用：替換滾動額度的時鐘（null 還原），測試不必真的等 10 分鐘 */
export function setAwardDetailClock(now: (() => number) | null): void {
  windowClock = now ?? (() => Date.now());
}

/** 只給驗收腳本用：清空滾動額度紀錄 */
export function resetAwardDetailWindow(): void {
  windowStamps = [];
}

/** 額度已滿時回傳最早可再請求的時刻（ms），還有額度回 0 */
function windowFullUntil(): number {
  const now = windowClock();
  windowStamps = windowStamps.filter(t => t > now - DETAIL_WINDOW_MS);
  return windowStamps.length >= DETAIL_WINDOW_MAX ? Math.min(...windowStamps) + DETAIL_WINDOW_MS : 0;
}

function formatTaipei(ms: number, withDate: boolean): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return withDate ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : `${p.hour}:${p.minute}`;
}

function windowLimitMessage(until: number): string {
  // 無條件進位到整分，照著顯示的時間來查一定已有額度
  return `任意 ${DETAIL_WINDOW_MS / 60000} 分鐘內最多 ${DETAIL_WINDOW_MAX} 次內頁請求，最早可在 ${formatTaipei(Math.ceil(until / 60000) * 60000, false)} 再查`;
}

// ---------- 跨行程共用的額度檔 ----------

interface RateState {
  /** 已送出的內頁請求時間戳（windowClock 的時間） */
  stamps: number[];
  /** 冷卻起點；0＝沒被擋 */
  blockedAt: number;
}

async function backupBrokenRate(file: string, why: string): Promise<void> {
  try {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(file, backup);
    console.error(`[AwardDetail] 額度檔${why}，已改名保留為 ${backup}`);
  } catch {
    // 連備份都失敗就當成空的：額度檔壞掉不可以讓工具掛掉
  }
}

/** 讀額度檔：不存在＝空；讀不出或內容損毀＝改名備份後當空，絕不往外丟例外 */
async function readRateState(file: string): Promise<RateState> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e: any) {
    if (e?.code !== 'ENOENT') await backupBrokenRate(file, `讀取失敗（${e?.code || e?.message}）`);
    return { stamps: [], blockedAt: 0 };
  }
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.stamps)) {
    await backupBrokenRate(file, '內容損毀');
    return { stamps: [], blockedAt: 0 };
  }
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    stamps: parsed.stamps.map(num).filter((t: number | null): t is number => t !== null),
    blockedAt: num(parsed.blockedAt) ?? 0,
  };
}

/** 發請求前把磁碟上的狀態併進記憶體：時間戳取聯集、blockedAt 取較晚的（另一個行程被擋，這個行程也要停） */
async function mergeRateFromDisk(file: string): Promise<void> {
  const disk = await readRateState(file);
  if (disk.stamps.length) {
    const cutoff = windowClock() - DETAIL_WINDOW_MS;
    windowStamps = [...new Set([...windowStamps, ...disk.stamps])].filter(t => t > cutoff).sort((a, b) => a - b);
  }
  if (disk.blockedAt > blockedAt) blockedAt = disk.blockedAt;
}

async function saveRateState(file: string): Promise<void> {
  const cutoff = windowClock() - DETAIL_WINDOW_MS;
  const state: RateState = { stamps: windowStamps.filter(t => t > cutoff), blockedAt };
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeJsonAtomic(file, state);
  } catch (e: any) {
    console.error(`[AwardDetail] 額度檔寫入失敗（不影響本次結果）: ${e.message}`);
  }
}

type PageOutcome = AwardPageParse | { type: 'error'; message: string } | { type: 'limit'; message: string };

/** 判定封鎖：blockedAt 同步設定（不能等呼叫端 await 接續才設），再把狀態寫給另一個行程看 */
async function markBlocked(rateFile: string, message: string): Promise<PageOutcome> {
  blockedAt = Date.now();
  await saveRateState(rateFile);
  return { type: 'blocked', message };
}

async function requestPage(url: string, preferKind: AwardDetailKind | null, rateFile: string): Promise<PageOutcome> {
  // 在序列通道內檢查並登記額度：並行呼叫排隊時各自的事前檢查可能都看到還有額度
  const until = windowFullUntil();
  if (until) return { type: 'limit', message: windowLimitMessage(until) };
  while (Date.now() - lastRequestEnd < AWARD_FETCH_INTERVAL_MS) {
    await sleep(AWARD_FETCH_INTERVAL_MS - (Date.now() - lastRequestEnd));
  }
  // 額度算的是「請求次數」：種類不符、解析失敗、連線錯誤一樣佔用，所以送出前就記帳並寫檔
  windowStamps.push(windowClock());
  await saveRateState(rateFile);
  try {
    const res = await axios.get(url, { headers: HEADERS, responseType: 'arraybuffer', timeout: 30000, maxRedirects: 5, validateStatus: () => true });
    const html = Buffer.from(res.data).toString('utf8');
    // 不論狀態碼先判別封鎖頁（WAF 回 500、驗證碼頁狀態碼不固定），再看狀態碼
    if (html.includes('Web Page Blocked')) return await markBlocked(rateFile, `網站防火牆封鎖（Web Page Blocked，HTTP ${res.status}）`);
    const page = parseAwardDetailHtml(html, preferKind);
    if (page.type === 'blocked') return await markBlocked(rateFile, `${page.message}（HTTP ${res.status}）`);
    if (res.status === 403 || res.status === 429 || res.status >= 500) return await markBlocked(rateFile, `網站拒絕連線（HTTP ${res.status}）`);
    if (res.status >= 400) return { type: 'error', message: `HTTP ${res.status}` };
    return page;
  } catch (e: any) {
    return { type: 'error', message: `連線失敗：${e.code || e.message}` };
  } finally {
    lastRequestEnd = Date.now();
  }
}

// ---------- 快取 ----------

interface CacheEntry {
  kind: AwardDetailKind;
  pk: string;
  url: string;
  record: AwardDetailRecord | NonAwardDetailRecord;
  pairs: [string, string][];
  savedAt: string;
}
type CacheShape = Record<string, CacheEntry>;

const caches = new Map<string, CacheShape>();
let tmpSeq = 0;

const isCacheShape = (x: unknown): x is CacheShape => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * 快取項可能來自舊版或被手改過：record／pairs 形狀不對就當作沒命中。
 * 不驗的話會回 ok+cached 卻在輸出裡整筆消失（使用者只看到摘要說有快取）。
 */
function validEntry(e: CacheEntry | undefined): CacheEntry | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const rec = e.record as unknown as { pageType?: string } | null;
  if (!rec || typeof rec !== 'object' || (rec.pageType !== 'award' && rec.pageType !== 'nonAward')) return undefined;
  if (!Array.isArray(e.pairs)) return undefined;
  return e;
}

async function loadCache(file: string): Promise<CacheShape> {
  const known = caches.get(file);
  if (known) return known;
  let store: CacheShape = {};
  let memoize = true;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    store = isCacheShape(parsed) ? parsed : {};
  } catch (e: any) {
    // ENOENT 或內容不是 JSON 物件＝真的沒有快取；EBUSY／EPERM 這類暫時性錯誤不可記成空快取，否則整個行程之後都讀不到
    if (e?.code && e.code !== 'ENOENT') {
      console.error(`[AwardDetail] 快取讀取失敗（暫時性，不記為空）: ${e.code}`);
      memoize = false;
    }
  }
  if (memoize) caches.set(file, store);
  return store;
}

/** 讀磁碟上的快取：不存在回 {}；損毀（不是 JSON 物件）先改名成 .corrupt-時間戳 保留再回 {}；其他讀取錯誤往外丟（不可覆蓋） */
async function readDiskCacheForMerge(file: string): Promise<CacheShape> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (isCacheShape(parsed)) return parsed;
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(file, backup);
  console.error(`[AwardDetail] 快取檔損毀，已改名保留為 ${backup}`);
  return {};
}

/** 先寫暫存檔再改名：寫到一半被中斷不會毀掉原檔。rename 失敗要把暫存檔清掉，不然快取資料夾會越積越多 .tmp */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1), 'utf8');
  try {
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** 把磁碟上的快取併進記憶體（別的 MCP 行程抓到的）；讀取錯誤往外丟由呼叫端決定 */
async function mergeDiskCacheInto(file: string, store: CacheShape): Promise<void> {
  const disk = await readDiskCacheForMerge(file);
  for (const [k, v] of Object.entries(disk)) {
    if (!(k in store)) store[k] = v;
  }
}

async function saveCache(file: string, store: CacheShape): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    // 寫入前重讀磁碟合併：Claude Desktop 與 Claude Code 可能各開一個 MCP 行程共用這個檔，直接覆蓋會丟掉對方抓的
    await mergeDiskCacheInto(file, store);
    await writeJsonAtomic(file, store);
  } catch (e: any) {
    console.error(`[AwardDetail] 快取寫入失敗（不影響本次結果）: ${e.message}`);
  }
}

// ---------- 批次 ----------

type LaneOutcome =
  | { kind: 'cached'; entry: CacheEntry }
  | { kind: 'cooldown' }
  | { kind: 'page'; page: PageOutcome };

/**
 * 序列通道內的一步：先確認沒有人搶先抓到（記憶體→磁碟），再看冷卻與跨行程額度，最後才連線。
 * 排隊可能等上好幾秒，這期間另一個 MCP 行程或並行呼叫可能已經抓到同一案、或已經被網站擋住。
 */
async function fetchOneInLane(
  file: string, store: CacheShape, rateFile: string, key: string, url: string, preferKind: AwardDetailKind | null,
): Promise<LaneOutcome> {
  const mem = validEntry(store[key]);
  if (mem) return { kind: 'cached', entry: mem };
  try {
    await mergeDiskCacheInto(file, store);
  } catch (e: any) {
    console.error(`[AwardDetail] 連線前重讀快取失敗（略過）: ${e.code || e.message}`);
  }
  const fresh = validEntry(store[key]);
  if (fresh) return { kind: 'cached', entry: fresh };
  await mergeRateFromDisk(rateFile);
  if (cooldownRemainingMs() > 0) return { kind: 'cooldown' };
  return { kind: 'page', page: await requestPage(url, preferKind, rateFile) };
}

/**
 * 解析結果無法確認就不寫快取（快取是永久的，錯的比沒有更糟）：
 * 無法決標頁的欄位名是推測的、決標公告必有得標廠商、兩種欄位並存時純 pk 判不出種類。
 */
function rejectReason(page: AwardPageOk, kind: AwardDetailKind, assumedKind: boolean): string {
  if (page.ambiguous && assumedKind) {
    return '頁面同時有「投標廠商家數」與「無法決標的理由」，純 pk 無法判斷是哪一種公告，未快取（請改給完整連結）';
  }
  if (!assumedKind && page.type !== kind) {
    return `連結是${KIND_LABEL[kind]}、頁面像${KIND_LABEL[page.type]}，未快取`;
  }
  if (page.type === 'award') {
    if (page.record.bidderCount == null) return '決標頁解析不到投標廠商家數（版型可能不同），未快取';
    if (page.record.winners.length === 0) return '決標頁解析不到得標廠商（決標公告必有得標廠商，版型可能不同），未快取';
  } else if (!page.record.reason.trim()) {
    return '無法決標頁解析不到「無法決標的理由」（版型可能不同），未快取';
  }
  return '';
}

export async function fetchAwardDetails(inputs: string[], opts: { cacheFile?: string } = {}): Promise<AwardDetailBatch> {
  if (inputs.length > MAX_AWARD_CASES) {
    throw new Error(`一次最多 ${MAX_AWARD_CASES} 筆，本次給了 ${inputs.length} 筆，請分批`);
  }
  const file = opts.cacheFile ?? AWARD_DETAIL_CACHE_FILE;
  // 額度檔與快取檔同一個資料夾，預設就是專案根 .cache/award-rate.json
  const rateFile = opts.cacheFile ? join(dirname(opts.cacheFile), 'award-rate.json') : AWARD_RATE_FILE;
  const store = await loadCache(file);
  const results: AwardDetailResult[] = [];
  const firstIndex = new Map<string, number>();
  let fetched = 0;
  let cachedCount = 0;
  let overLimit = 0;
  let duplicates = 0;
  let blocked = false;
  let cooldown = false;

  for (const input of inputs) {
    const n = normalizeAwardInput(input);
    if (!n.ok) {
      results.push({ input, pk: '', url: '', assumedKind: false, ok: false, cached: false, failure: n.failure, message: n.message });
      continue;
    }
    const { kind, pk, url, assumedKind } = n.value;
    const base = { input, kind, pk, url, assumedKind };
    const key = `${kind}:${pk}`;

    // 重複輸入先合併再查快取：否則本次才抓到的案子，第二次出現會被算成快取
    const first = firstIndex.get(key);
    if (first !== undefined) {
      duplicates++;
      results.push({ ...results[first], input, duplicateOf: first });
      continue;
    }
    firstIndex.set(key, results.length);

    const hit = validEntry(store[key]);
    if (hit) {
      cachedCount++;
      results.push({ ...base, ok: true, cached: true, record: hit.record, pairs: hit.pairs, savedAt: hit.savedAt });
      continue;
    }

    let r: AwardDetailResult;
    const windowUntil = blocked || cooldownRemainingMs() > 0 ? 0 : windowFullUntil();
    if (blocked) {
      r = { ...base, ok: false, cached: false, failure: 'blocked', message: '本批前面已遇到流量控制，未連線' };
    } else if (cooldownRemainingMs() > 0) {
      cooldown = true;
      r = { ...base, ok: false, cached: false, failure: 'cooldown', message: cooldownMessage() };
    } else if (windowUntil || fetched >= MAX_AWARD_FETCH_PER_CALL) {
      overLimit++;
      r = { ...base, ok: false, cached: false, failure: 'limit', message: windowUntil ? windowLimitMessage(windowUntil) : `超過單次上限 ${MAX_AWARD_FETCH_PER_CALL} 筆，本次未抓，請下次再查` };
    } else {
      // 排隊期間可能有別的行程剛抓到同一案、剛被擋或剛用完額度，輪到時全部再確認一次
      const outcome = await inLane(() => fetchOneInLane(file, store, rateFile, key, url, assumedKind ? null : kind));
      if (outcome.kind === 'cached') {
        cachedCount++;
        r = { ...base, ok: true, cached: true, record: outcome.entry.record, pairs: outcome.entry.pairs, savedAt: outcome.entry.savedAt };
      } else if (outcome.kind === 'cooldown') {
        cooldown = true;
        r = { ...base, ok: false, cached: false, failure: 'cooldown', message: cooldownMessage() };
      } else if (outcome.page.type === 'limit') {
        overLimit++;
        r = { ...base, ok: false, cached: false, failure: 'limit', message: outcome.page.message };
      } else {
        const page = outcome.page;
        fetched++;
        if (page.type === 'award' || page.type === 'nonAward') {
          const reject = rejectReason(page, kind, assumedKind);
          if (reject) {
            r = { ...base, ok: false, cached: false, failure: 'parse', message: reject };
          } else {
            store[key] = { kind, pk, url, record: page.record, pairs: page.pairs, savedAt: new Date().toISOString() };
            await saveCache(file, store);
            r = { ...base, ok: true, cached: false, record: page.record, pairs: page.pairs };
          }
        } else if (page.type === 'blocked') {
          // blockedAt 已在 requestPage 內判定的當下設定並寫檔
          blocked = true;
          r = { ...base, ok: false, cached: false, failure: 'blocked', message: page.message };
        } else {
          r = { ...base, ok: false, cached: false, failure: page.type, message: page.message };
        }
      }
    }
    results.push(r);
  }

  return { results, fetched, cachedCount, blocked, cooldown, overLimit, duplicates };
}

function cooldownMessage(): string {
  // 一律走 formatTaipei（hourCycle h23）：zh-TW 的 12 小時制關閉旗標會把午夜 00:05 印成 24:05
  return `${formatTaipei(blockedAt, false)} 已遇到網站流量控制，冷卻中（約 ${Math.ceil(cooldownRemainingMs() / 60000)} 分鐘後才會再連線內頁）`;
}

// ---------- 輸出 ----------

const fmtMoney = (n: number | null, blank = '未公開') => (n == null ? blank : `${n.toLocaleString('en-US')} 元`);
// < > 要轉成實體：標的分類「<勞務類> 8672 工程服務」會被部分渲染器當 HTML 標籤吃掉
const cell = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
// 表格以外（#### 標題、機關／案號行、未取得清單的輸入字串）還要多跳脫反引號，否則會起一段 code span 吃掉後面的字
const inlineText = (s: string) => cell(s).replace(/`/g, '\\`');
const vendorLabel = (b: AwardBidder) => `${b.name || '(無名稱)'}（統編 ${b.vendorId || '無'}）`;

function renderAward(rec: AwardDetailRecord): string {
  let out = `| 項目 | 內容 |\n| :--- | :--- |\n`;
  const row = (k: string, v: string) => { out += `| ${k} | ${cell(v || '-')} |\n`; };
  row('得標廠商', rec.winners.length ? rec.winners.map(vendorLabel).join('、') : '（內頁未列出得標廠商）');
  const listed = rec.bidderCount != null && rec.bidderCount !== rec.bidders.length ? `（內頁列出 ${rec.bidders.length} 家）` : '';
  row('投標家數', rec.bidderCount == null ? '-' : `${rec.bidderCount}${listed}`);
  row('落標廠商', rec.losers.length ? rec.losers.map(vendorLabel).join('、') : '無');
  row('預算金額', fmtMoney(rec.budget));
  if (rec.floorPrice != null) row('底價金額', fmtMoney(rec.floorPrice));
  row('總決標金額', fmtMoney(rec.totalAward));
  row('減標率', rec.discountRate == null ? '-（預算金額或總決標金額未公開）' : `${rec.discountRate.toFixed(2)}%`);
  row('決標方式', rec.awardWay);
  row('決標日期', rec.awardDate);
  row('決標公告日期', rec.awardNoticeDate);
  row('履約地點（含地區）', rec.execArea);
  row('履約起迄', rec.period);

  if (rec.bidders.length) {
    out += `\n**投標廠商（${rec.bidders.length} 家）**\n\n`;
    out += `| 序號 | 廠商名稱 | 統編 | 是否得標 | 中小企業 | 地址 | 決標金額 |\n`;
    out += `| ---: | :--- | :--- | :--- | :--- | :--- | ---: |\n`;
    for (const b of rec.bidders) {
      const sme = (b.sme.match(/^[是否]/) || [b.sme])[0];
      out += `| ${b.no} | ${cell(b.name)} | ${cell(b.vendorId)} | ${cell(b.won)} | ${cell(sme)} | ${cell(b.address)} | ${b.amount == null ? '-' : fmtMoney(b.amount)} |\n`;
    }
  }
  return out;
}

function renderNonAward(rec: NonAwardDetailRecord): string {
  let out = `| 項目 | 內容 |\n| :--- | :--- |\n`;
  const row = (k: string, v: string) => { out += `| ${k} | ${cell(v || '-')} |\n`; };
  row('無法決標的理由', rec.reason);
  row('原招標公告之刊登採購公報日期', rec.originalBulletinDate);
  row('無法決標公告日期', rec.nonAwardNoticeDate);
  row('是否沿用本案號及原招標方式續行招標', rec.continueSameCase);
  row('標的分類', rec.category);
  return out;
}

function failureText(r: AwardDetailResult): string {
  switch (r.failure) {
    case 'blocked': return r.message || '網站流量控制';
    case 'cooldown': return r.message || '冷卻中';
    case 'limit': return r.message || '超過流量額度';
    case 'tender': return r.message || '招標公告連結，請改用 get_tender_detail';
    case 'invalid': return r.message || '無法辨識的輸入';
    case 'parse': return r.message?.includes('未快取') ? r.message : `${r.message || '內頁版型不符'}；未寫入快取`;
    default: return r.message || '連線失敗';
  }
}

export function renderAwardDetails(batch: AwardDetailBatch, opts: { full?: boolean } = {}): string {
  const { results } = batch;
  const unique = results.map((r, i) => ({ r, i })).filter(x => x.r.duplicateOf == null);
  const dupNos = (i: number) => results.map((x, j) => (x.duplicateOf === i ? j + 1 : 0)).filter(Boolean);
  const dupCount = results.length - unique.length;
  let out = `### 決標公告內頁（${results.length} 筆${dupCount ? `，不重複 ${unique.length} 筆` : ''}）\n\n`;

  let fullShown = 0;
  let fullOmitted = 0;
  for (const { r, i } of unique) {
    if (!r.ok || !r.record) continue;
    const rec = r.record;
    const savedAt = r.savedAt ? Date.parse(r.savedAt) : NaN;
    const source = !r.cached ? '（本次抓取）' : Number.isNaN(savedAt) ? '（本地快取）' : `（本地快取，${formatTaipei(savedAt, true)} 抓取）`;
    out += `#### ${i + 1}. ${inlineText(rec.tenderName || '(無標案名稱)')}\n`;
    out += `機關 ${inlineText(rec.orgName || '-')}｜案號 \`${inlineText(rec.caseNo || '-')}\`｜${rec.pageType === 'award' ? '決標公告' : '**無法決標公告**'}｜${source}\n\n`;
    if (r.assumedKind) out += `> 輸入是純 pk，沒有路徑可判斷種類，預設當決標公告查詢。\n\n`;
    const dups = dupNos(i);
    if (dups.length) out += `> 第 ${dups.join('、')} 筆與本筆是同一案，已合併。\n\n`;
    out += rec.pageType === 'award' ? renderAward(rec) : renderNonAward(rec);

    if (opts.full && r.pairs?.length) {
      if (fullShown < FULL_FIELDS_MAX_CASES) {
        fullShown++;
        const pairs = r.pairs.filter(([k, v]) => k && v);
        out += `\n**全部內頁欄位（${pairs.length} 項，依內頁順序）**\n\n| 欄位 | 內容 |\n| :--- | :--- |\n`;
        for (const [k, v] of pairs) out += `| ${cell(k)} | ${cell(v.length > 300 ? v.slice(0, 300) + '…' : v)} |\n`;
      } else {
        fullOmitted++;
        out += `\n> 全部欄位只列前 ${FULL_FIELDS_MAX_CASES} 筆，本筆省略（要看請單獨再查這筆並設 full=true，走快取不耗額度）。\n`;
      }
    }
    out += `\n[開啟內頁](${r.url})\n\n`;
  }

  const failed = unique.filter(x => !x.r.ok);
  const okFetched = unique.filter(x => x.r.ok && !x.r.cached).length;
  const okCached = unique.filter(x => x.r.ok && x.r.cached).length;

  out += `---\n\n#### 摘要\n\n`;
  out += `- 本次實抓 ${okFetched} 筆、快取 ${okCached} 筆、未取得 ${failed.length} 筆（本次連線內頁 ${batch.fetched} 次）`;
  out += dupCount ? `；重複輸入 ${dupCount} 筆已合併\n` : '\n';
  if (fullOmitted) out += `- full=true：全部欄位只列前 ${FULL_FIELDS_MAX_CASES} 筆，其餘 ${fullOmitted} 筆只給精選表\n`;
  if (failed.length) {
    out += `- 未取得：\n`;
    for (const { r, i } of failed) {
      const where = r.url ? `[${r.pk}](${r.url})` : `\`${inlineText(r.input)}\``;
      const dups = dupNos(i);
      out += `  - 第 ${i + 1} 筆 ${where} — ${failureText(r)}${r.assumedKind ? '（純 pk 預設當決標公告）' : ''}${dups.length ? `（第 ${dups.join('、')} 筆同案已合併）` : ''}\n`;
    }
  }
  if (batch.overLimit > 0) {
    out += `\n> 內頁有流量控制：任意 ${DETAIL_WINDOW_MS / 60000} 分鐘內最多 ${DETAIL_WINDOW_MAX} 次內頁請求（種類不符、解析失敗、連線錯誤也會佔額度），跨呼叫共用；單次呼叫也最多 ${MAX_AWARD_FETCH_PER_CALL} 次。其餘 ${batch.overLimit} 筆請照上列時間之後再查，不要馬上重查；已查過的案子走本地快取，重查不耗額度。\n`;
  }
  if (batch.blocked || batch.cooldown) {
    out += `\n> 政府採購網已對本次連線啟動流量控制（內頁約連抓 5~8 筆就會跳撲克牌驗證碼，鎖 20 分鐘以上）。這是網站的防自動化機制，不是違規紀錄。請稍後再試，或在瀏覽器開啟上列連結（會要求點選撲克牌驗證）。**不要重複重試**，被鎖期間再連線只會延長封鎖。\n`;
  }
  return out;
}
