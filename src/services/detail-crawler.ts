import axios from 'axios';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TenderDetail } from '../types/tender.js';

/**
 * 標案內頁抓取。
 *
 * 政府採購網對內頁有流量控制：連續抓約 8 筆後整個 IP 會被切到「撲克牌驗證碼」頁，
 * 之後連先前成功過的頁面也一律被擋，降低間隔也救不回來（要等冷卻）。
 * 因此這裡的策略是「省著用」而不是「想辦法多抓」：
 *   1. 本地快取，同一案永不重抓
 *   2. 單次上限 8 筆、序列抓取並節流
 *   3. 跨呼叫滾動額度（5 分鐘 20 次）——單次上限擋不住「連續呼叫十次」
 *   4. 一遇驗證碼立刻中止整批，並冷卻 20 分鐘才再送請求；未完成的誠實回報
 * 絕不繞過或破解驗證碼。
 */

const DETAIL_BASE = 'https://web.pcc.gov.tw/tps/QueryTender/query/searchTenderDetail';

/** 單次最多抓幾筆未快取的案子 */
export const MAX_FETCH_PER_CALL = 8;
/** 連續請求間隔（毫秒） */
const THROTTLE_MS = 1500;

/**
 * 跨呼叫的滾動額度。單次上限只擋得住一次呼叫，擋不住「連續呼叫十次」——
 * 決標內頁就是這樣被鎖掉的（2026-09-14 起連鎖多日），而招標內頁是目前唯一還能用的內頁。
 * 額度取自 2026-09-22 實測：15 秒間隔連抓 17 筆未被擋 → 平均 15 秒/筆＝5 分鐘 20 筆，
 * 既維持互動查詢的手感（單次 8 筆仍是 1.5 秒間隔、12 秒抓完），又擋掉把 MCP 當爬蟲用的情境。
 * 大量補資料請寫獨立腳本，不要迴圈呼叫本工具。
 */
export const TENDER_WINDOW_MAX = 20;
export const TENDER_WINDOW_MS = 5 * 60 * 1000;
/** 撞到驗證碼後，整個工具冷卻這麼久（網站鎖 20 分鐘以上，期間再打只會延長封鎖） */
export const TENDER_COOLDOWN_MS = 20 * 60 * 1000;

let windowStamps: number[] = [];
let blockedUntil = 0;

/**
 * 只給驗收腳本用：清空額度與冷卻狀態。
 * seedUsed 預先塞入 N 筆「剛剛送出」的紀錄，用來驗證額度用完的分支（否則要真的打 20 次網路請求）；
 * seedBlockedMs 則把冷卻設在 N 毫秒之後。
 */
export function resetTenderDetailWindow(seedUsed = 0, seedBlockedMs = 0): void {
  const now = Date.now();
  windowStamps = Array.from({ length: seedUsed }, () => now);
  blockedUntil = seedBlockedMs ? now + seedBlockedMs : 0;
}

/** 目前額度狀態（驗收與回報用）。used 是滾動視窗內已送出的請求數 */
export function getTenderDetailQuota(): { used: number; max: number; windowMs: number; blockedUntil: number } {
  const now = Date.now();
  windowStamps = windowStamps.filter(t => t > now - TENDER_WINDOW_MS);
  return { used: windowStamps.length, max: TENDER_WINDOW_MAX, windowMs: TENDER_WINDOW_MS, blockedUntil };
}

/** 額度已滿時回傳最早可再請求的時刻（ms），還有額度回 0 */
function windowFullUntil(now: number): number {
  windowStamps = windowStamps.filter(t => t > now - TENDER_WINDOW_MS);
  return windowStamps.length >= TENDER_WINDOW_MAX ? Math.min(...windowStamps) + TENDER_WINDOW_MS : 0;
}

/** 無條件進位到整分，照著顯示的時間來查一定已有額度 */
function taipeiHHmm(ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(Math.ceil(ms / 60000) * 60000)).map(x => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}

// build 後此檔在 build/services/，快取固定放專案根的 .cache/
// ⚠️ 不可用 process.cwd()：MCP 由 GUI 啟動時 CWD 是 C:\Windows\System32，寫入會被拒
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache');
const CACHE_FILE = join(CACHE_DIR, 'tender-details.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9',
};

/** 預設回傳的精選欄位（依此順序輸出）；full 模式則回全部 */
export const KEY_FIELDS = [
  '機關名稱', '標案案號', '標案名稱', '標的分類',
  '預算金額', '採購金額級距', '招標方式', '決標方式',
  '截止投標', '開標時間', '開標地點', '是否須繳納押標金',
  '履約地點', '履約期限', '廠商資格摘要',
  '聯絡人', '聯絡電話', '電子郵件信箱',
];

type CacheShape = Record<string, { url: string; fields: Record<string, string>; savedAt: string }>;

let cache: CacheShape | null = null;

async function loadCache(): Promise<CacheShape> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as CacheShape;
  } catch {
    cache = {};
  }
  return cache;
}

async function saveCache(): Promise<void> {
  if (!cache) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e: any) {
    console.error(`[Detail] 快取寫入失敗（不影響查詢結果）: ${e.message}`);
  }
}

/** 從連結或純字串取出 pkPmsMain；支援 tpam?pk=、searchTenderDetail?pkPmsMain=、或直接給 pk */
export function extractPk(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/[?&](?:pk|pkPmsMain)=([^&\s]+)/i);
  if (m) return decodeURIComponent(m[1]);
  // 不是網址就當成 pk 本身（base64，允許結尾 =）
  if (/^[A-Za-z0-9+/]+=*$/.test(s)) return s;
  return null;
}

/**
 * 決標／無法決標公告的 pk 是 pkAtmMain，與招標內頁的 pkPmsMain 是不同編號空間。
 * 餵進 searchTenderDetail 不會報錯，而是回傳「剛好同號的另一個招標案」——靜默的錯答案，
 * 所以這裡先攔下來，指向 get_award_detail。純 pk 無路徑可判，只能依既有行為當招標 pk。
 */
export function detectAwardLink(input: string): 'award' | 'nonAward' | null {
  const s = input.trim();
  if (/\/common\/nonAtm\?|QueryAtmNonAwardDetail/i.test(s)) return 'nonAward';
  if (/\/common\/atm\?|QueryAtmAwardDetail/i.test(s)) return 'award';
  if (/[?&]pkAtmMain=/i.test(s)) return 'award';
  return null;
}

function isCaptchaPage(html: string): boolean {
  return html.includes('撲克牌') || (html.includes('A區') && html.includes('B區') && html.includes('重新整理'));
}

/** 內頁是 td/td 相鄰配對（第一格 label、第二格 value），不是 th/td */
function parseFields(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};
  $('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length >= 2) {
      const k = $(tds[0]).text().trim().replace(/\s+/g, ' ');
      if (!k || k.length > 60) return;
      if (fields[k] !== undefined) return; // 同名只取第一個
      fields[k] = $(tds[1]).text().trim().replace(/\s+/g, ' ');
    }
  });
  return fields;
}

async function fetchOne(pk: string): Promise<{ fields?: Record<string, string>; reason?: 'captcha' | 'parse' | 'error'; message?: string }> {
  const url = `${DETAIL_BASE}?pkPmsMain=${encodeURIComponent(pk)}`;
  try {
    const res = await axios.get(url, { headers: HEADERS, responseType: 'arraybuffer', timeout: 25000, maxRedirects: 5 });
    let html = Buffer.from(res.data).toString('utf8');
    const ct = String(res.headers['content-type'] || '').toLowerCase();
    if (ct.includes('big5') || html.includes('charset=big5')) html = iconv.decode(Buffer.from(res.data), 'big5');

    if (isCaptchaPage(html)) return { reason: 'captcha' };

    const fields = parseFields(html);
    // 沒有標案案號代表不是預期的內頁版型
    if (!fields['標案案號'] && !fields['標案名稱']) return { reason: 'parse' };
    return { fields };
  } catch (e: any) {
    return { reason: 'error', message: e.message };
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * 批次取得標案內頁。已快取的直接回，未快取的序列抓取；
 * 一旦遇到驗證碼就中止後續（該次之後的案子標為 captcha 未取得）。
 */
export async function fetchTenderDetails(inputs: string[]): Promise<{ details: TenderDetail[]; blocked: boolean; fetched: number }> {
  const store = await loadCache();
  const details: TenderDetail[] = [];
  let blocked = false;
  let fetched = 0;
  let dirty = false;

  for (const input of inputs) {
    const awardKind = detectAwardLink(input);
    if (awardKind) {
      const label = awardKind === 'award' ? '決標公告' : '無法決標公告';
      details.push({
        input, pk: '', url: input.trim(), ok: false, reason: 'award',
        message: `這是${label}的連結，它的 pk 與招標內頁不同編號空間，餵進來會取回別的案子。請改用 get_award_detail 查這一筆（可取得得標廠商、投標家數、落標廠商）。`,
        fields: {}, cached: false,
      });
      continue;
    }
    const pk = extractPk(input);
    if (!pk) {
      details.push({ input, pk: '', url: '', ok: false, reason: 'parse', message: '無法從輸入取出標案識別碼（pk）', fields: {}, cached: false });
      continue;
    }
    const url = `${DETAIL_BASE}?pkPmsMain=${encodeURIComponent(pk)}`;

    const hit = store[pk];
    if (hit) {
      details.push({ input, pk, url, ok: true, fields: hit.fields, cached: true });
      continue;
    }

    if (blocked) {
      details.push({ input, pk, url, ok: false, reason: 'captcha', fields: {}, cached: false });
      continue;
    }
    const now = Date.now();
    if (now < blockedUntil) {
      details.push({ input, pk, url, ok: false, reason: 'captcha',
        message: `先前已撞到驗證碼，本工具冷卻至 ${taipeiHHmm(blockedUntil)} 才會再送請求（期間再打只會延長封鎖）。已快取的案子不受影響。`,
        fields: {}, cached: false });
      continue;
    }
    if (fetched >= MAX_FETCH_PER_CALL) {
      details.push({ input, pk, url, ok: false, reason: 'error', message: `超過單次抓取上限（${MAX_FETCH_PER_CALL} 筆），請分批查詢`, fields: {}, cached: false });
      continue;
    }
    const until = windowFullUntil(now);
    if (until) {
      details.push({ input, pk, url, ok: false, reason: 'error',
        message: `任意 ${TENDER_WINDOW_MS / 60000} 分鐘內最多 ${TENDER_WINDOW_MAX} 次內頁請求（跨呼叫共用），最早可在 ${taipeiHHmm(until)} 再查。要大量補資料請改寫獨立腳本，不要迴圈呼叫本工具。`,
        fields: {}, cached: false });
      continue;
    }

    if (fetched > 0) await sleep(THROTTLE_MS);
    windowStamps.push(Date.now());
    const r = await fetchOne(pk);
    fetched++;

    if (r.fields) {
      store[pk] = { url, fields: r.fields, savedAt: new Date().toISOString() };
      dirty = true;
      details.push({ input, pk, url, ok: true, fields: r.fields, cached: false });
    } else {
      if (r.reason === 'captcha') { blocked = true; blockedUntil = Date.now() + TENDER_COOLDOWN_MS; } // 之後的一律不再打
      details.push({ input, pk, url, ok: false, reason: r.reason, message: r.message, fields: {}, cached: false });
    }
  }

  if (dirty) await saveCache();
  return { details, blocked, fetched };
}
