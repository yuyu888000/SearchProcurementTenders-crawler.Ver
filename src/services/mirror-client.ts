import axios from 'axios';
import { AwardBidder, AwardDetailKind, AwardDetailRecord, NonAwardDetailRecord } from '../types/award.js';

/**
 * g0v 政府採購網鏡像（ronnywang/pcc.g0v.ronny.tw）唯讀用戶端。
 *
 * 為什麼要有這支：官方清單端點沒有得標廠商欄位，內頁才有，但內頁受撲克牌驗證碼流量控制
 * （任意 10 分鐘最多 5 次）。鏡像的 listbydate 一個請求就回一整天全部公告，
 * 而且每筆的 companies.name_key 直接標明誰是得標廠商、誰是未得標廠商、投標廠商有幾家。
 *
 * 2026-09-23 實測（115/09/22 工程類決標 164 件）：
 *   機關名稱＋標案案號完全比對命中 151 件（92%），命中的 151 件全部都取得得標廠商。
 *   未命中的 13 件多是變更設計／後續擴充（官方案號帶 -1、-2 尾碼，鏡像收在別的案號下）；
 *   實測去尾碼再比對一件也沒多命中，所以不做模糊比對，避免把變更設計對到原案。
 *
 * 限制（呼叫端要知道）：
 *   - 有 HTTP 429 限速，3 秒間隔連打 10 次實測約兩成被擋；429 可退避重試。
 *   - 週末回 PHP warning ＋ {}（HTTP 200），那是當天沒公告，不是錯誤。
 *   - 鏡像限個人／研究等非營利用途，商業利用要走官方 OpenData。
 */

const BASE = 'https://pcc-api.openfun.app/api';
/** 每次請求之間至少間隔；鏡像是社群免費資源，不打滿 */
const THROTTLE_MS = 3000;
/** 429 退避重試次數 */
const MAX_RETRY = 3;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let lastRequestEnd = 0;

export interface MirrorAward {
  /** 得標廠商（複數決標會有多家） */
  winners: string[];
  /** 對應的統編，查不到的位置留 null */
  winnerIds: (string | null)[];
  /** 未得標廠商 */
  losers: string[];
  /** 投標廠商家數；公告沒列投標廠商時 null */
  bidderCount: number | null;
  /** 公告種類（決標公告／無法決標公告／更正決標公告…） */
  type: string;
}

/** 民國 yyyMMdd 整數轉鏡像要的西元 YYYYMMDD */
function rocToAd(roc: number): number {
  const y = Math.floor(roc / 10000) + 1911;
  return y * 10000 + (roc % 10000);
}

const norm = (s: string) => String(s || '').replace(/\s+/g, '').replace(/\(更正公告\)|（更正公告）/g, '').trim();

/** 與 resolve-service 的 caseKey 同一套：機關名稱＋標案案號 */
export function mirrorCaseKey(orgName: string, caseNo: string): string {
  return `${norm(orgName)}||${norm(caseNo)}`;
}

/**
 * name_key 的值長這樣：
 *   ["投標廠商:投標廠商2:廠商名稱", "決標品項:第1品項:得標廠商1:得標廠商"]
 *   ["投標廠商:投標廠商1:廠商名稱", "決標品項:第1品項:未得標廠商1:未得標廠商"]
 * 「未得標廠商」本身含「得標廠商」三個字，判斷得標一定要先排除未得標。
 */
function parseCompanies(brief: any): MirrorAward | null {
  const nameKey: Record<string, string[]> = brief?.companies?.name_key ?? {};
  const idKey: Record<string, string[]> = brief?.companies?.id_key ?? {};
  const names = Object.keys(nameKey);
  if (names.length === 0) return null;

  const isWinner = (keys: string[]) => keys.some(k => /得標廠商\d*:得標廠商/.test(k) && !/未得標/.test(k));
  const isLoser = (keys: string[]) => keys.some(k => /未得標廠商\d*:未得標廠商/.test(k));

  const winners = names.filter(n => isWinner(nameKey[n]));
  if (winners.length === 0) return null;

  // 統編與名稱靠「投標廠商N」的序號對起來，對不上就留 null，不硬湊
  const slotOf = (keys: string[]): string | null => {
    for (const k of keys) {
      const m = k.match(/^投標廠商:投標廠商(\d+):/);
      if (m) return m[1];
    }
    return null;
  };
  const idBySlot = new Map<string, string>();
  for (const [id, keys] of Object.entries(idKey)) {
    const slot = slotOf(keys);
    if (slot) idBySlot.set(slot, id);
  }

  const slots = new Set<string>();
  for (const keys of Object.values(nameKey)) {
    const s = slotOf(keys);
    if (s) slots.add(s);
  }

  // 複數決標的公告常常只在「投標廠商N:是否得標=否」標示落標，決標品項那邊沒有「未得標廠商N」，
  // 所以除了明寫未得標的，凡是有投標序號又不在得標名單裡的一律算落標（有投標、沒得標）
  const losers = [...new Set([
    ...names.filter(n => isLoser(nameKey[n])),
    ...names.filter(n => slotOf(nameKey[n]) !== null && !winners.includes(n)),
  ])];

  return {
    winners,
    winnerIds: winners.map(n => {
      const s = slotOf(nameKey[n]);
      return s ? idBySlot.get(s) ?? null : null;
    }),
    losers,
    bidderCount: slots.size || null,
    type: String(brief?.type ?? ''),
  };
}

export interface MirrorCaseRef {
  unitId: string;
  jobNumber: string;
  unitName: string;
  /** 公告檔名，例 BDM-1-71287821 */
  filename: string;
  type: string;
}

export interface DayIndexResult {
  /** 機關＋案號 → 得標資訊；當天沒公告時是空的 */
  index: Map<string, MirrorAward>;
  /** 收文編號（官方 pk base64 解開就是這串數字）→ 案件位址，用來從 pk 直接定位鏡像案件 */
  byFiling: Map<string, MirrorCaseRef>;
  /** 當天公告總筆數（含招標公告等非決標類） */
  records: number;
  /** 實際送出的 HTTP 請求數（含退避重試） */
  requests: number;
  /** 取不到時的原因；成功是 undefined */
  error?: string;
}

/**
 * 日索引短期快取。
 * 逐案補欄位時，每個案子都要先有當天的日索引才能定位，沒有快取的話同一天會被重抓 N 次
 * （實測 3 個案子打了 7 次請求而不是 4 次），564 件就會多花半小時，也是白打人家的伺服器。
 * 過去日期的公告不會再變，短期快取很安全；只留幾天份，免得整包 JSON 佔記憶體。
 */
const DAY_CACHE_TTL_MS = 10 * 60_000;
const DAY_CACHE_MAX = 5;
const dayCache = new Map<number, { at: number; result: DayIndexResult }>();

/** 抓某一天（民國 yyyMMdd）的全部公告，建成 機關＋案號 → 得標資訊 的索引 */
export async function fetchDayIndex(rocDate: number, opts: { force?: boolean } = {}): Promise<DayIndexResult> {
  const hit = dayCache.get(rocDate);
  // force：最近幾天鏡像還在陸續收錄，快取裡那份可能是收錄一半的舊索引
  if (!opts.force && hit && Date.now() - hit.at < DAY_CACHE_TTL_MS) {
    // 回報 requests: 0，呼叫端的連線統計才不會把快取命中算成真的請求
    return { ...hit.result, requests: 0 };
  }
  const fresh = await fetchDayIndexUncached(rocDate);
  // 失敗的不要快取，下次要能重試
  if (!fresh.error) {
    dayCache.set(rocDate, { at: Date.now(), result: fresh });
    while (dayCache.size > DAY_CACHE_MAX) dayCache.delete(dayCache.keys().next().value as number);
  }
  return fresh;
}

async function fetchDayIndexUncached(rocDate: number): Promise<DayIndexResult> {
  const url = `${BASE}/listbydate?date=${rocToAd(rocDate)}`;
  let requests = 0;
  let lastError = '';

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const wait = THROTTLE_MS - (Date.now() - lastRequestEnd);
    if (wait > 0) await sleep(wait);

    let res;
    try {
      requests++;
      res = await axios.get(url, { timeout: 60000, responseType: 'text', validateStatus: () => true, transformResponse: r => r });
    } catch (e: any) {
      lastRequestEnd = Date.now();
      lastError = `連線失敗：${e.message}`;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    lastRequestEnd = Date.now();

    if (res.status === 429) {
      lastError = '鏡像限速（429）';
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (res.status !== 200) {
      lastError = `HTTP ${res.status}`;
      await sleep(2000 * (attempt + 1));
      continue;
    }

    let parsed: any;
    try {
      // 沒公告的日子回的是 PHP warning ＋ {}，開頭不是 { 就先切掉雜訊
      const body = String(res.data ?? '');
      const start = body.indexOf('{');
      parsed = start >= 0 ? JSON.parse(body.slice(start)) : {};
    } catch {
      lastError = '回應不是合法 JSON';
      await sleep(2000 * (attempt + 1));
      continue;
    }

    const records: any[] = Array.isArray(parsed?.records) ? parsed.records : [];
    const index = new Map<string, MirrorAward>();
    const byFiling = new Map<string, MirrorCaseRef>();
    for (const r of records) {
      const filename = String(r?.filename ?? '');
      const filing = filingNumberOf(filename);
      if (filing) {
        byFiling.set(filing, {
          unitId: String(r?.unit_id ?? ''),
          jobNumber: String(r?.job_number ?? ''),
          unitName: String(r?.unit_name ?? ''),
          filename,
          type: String(r?.brief?.type ?? ''),
        });
      }
      const award = parseCompanies(r?.brief);
      if (!award) continue;
      const key = mirrorCaseKey(r?.unit_name ?? '', r?.job_number ?? '');
      // 同一天同案號有多筆（決標＋更正決標）時保留先出現的，更正的資訊不一定更完整
      if (!index.has(key)) index.set(key, award);
    }
    return { index, byFiling, records: records.length, requests };
  }

  return { index: new Map(), byFiling: new Map(), records: 0, requests, error: lastError || '未知錯誤' };
}

// ---------- 從 pk 直接取單案完整明細 ----------

/** 公告檔名 BDM-1-71287821 → 收文編號 71287821；官方 pk 就是這串數字的 base64 */
export function filingNumberOf(filename: string): string | null {
  const m = String(filename || '').match(/(\d+)$/);
  return m ? m[1] : null;
}

/** 官方 pk（base64）→ 收文編號；不是純數字就回 null（那不是這套編號） */
export function filingNumberFromPk(pk: string): string | null {
  try {
    const s = Buffer.from(pk, 'base64').toString('utf8');
    return /^\d+$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** 「3,436,364元」→ 3436364；未公開／空白回 null */
function money(v: unknown): number | null {
  const m = String(v ?? '').replace(/,/g, '').match(/(\d+)\s*元/);
  return m ? parseInt(m[1], 10) : null;
}
const text = (v: unknown) => String(v ?? '').trim();

/**
 * 同一個欄位在不同版型的決標公告掛在不同區段底下：
 *   公開招標 → 「已公告資料:預算金額」
 *   限制性招標(未經公開評選或公開徵求) → 「採購資料:預算金額」
 * 只認一種會把限制性招標的預算金額、決標方式、標案名稱、案號全部誤判成「沒有」。
 * 所以先試已知區段，再退回掃「任一區段:欄位名」，避免日後又冒出第三種版型。
 */
const AWARD_SECTIONS = ['已公告資料', '採購資料'];
function field(d: Record<string, any>, name: string): string {
  for (const sec of AWARD_SECTIONS) {
    const v = text(d[`${sec}:${name}`]);
    if (v) return v;
  }
  const suffix = `:${name}`;
  for (const [k, v] of Object.entries(d)) {
    // 只收單層區段，別誤抓「投標廠商:投標廠商1:決標金額」這種第二層的
    if (k.endsWith(suffix) && k.indexOf(':') === k.length - suffix.length) {
      const t = text(v);
      if (t) return t;
    }
  }
  return '';
}

/**
 * 鏡像 /api/tender 的 detail 是「前綴:欄位」的扁平物件，例如
 *   投標廠商:投標廠商2:廠商名稱、決標資料:總決標金額。
 * 這裡把它組回與官方內頁解析同一個 AwardDetailRecord 形狀，下游才不用分兩套。
 */
function buildAwardRecord(d: Record<string, any>): AwardDetailRecord | null {
  const bidders: AwardBidder[] = [];
  for (let i = 1; ; i++) {
    const name = text(d[`投標廠商:投標廠商${i}:廠商名稱`]);
    if (!name) break;
    bidders.push({
      no: i,
      vendorId: text(d[`投標廠商:投標廠商${i}:廠商代碼`]),
      name,
      won: text(d[`投標廠商:投標廠商${i}:是否得標`]),
      orgType: text(d[`投標廠商:投標廠商${i}:組織型態`]),
      trade: text(d[`投標廠商:投標廠商${i}:廠商業別`]),
      address: text(d[`投標廠商:投標廠商${i}:廠商地址`]),
      phone: text(d[`投標廠商:投標廠商${i}:廠商電話`]),
      sme: text(d[`投標廠商:投標廠商${i}:是否為中小企業`]),
      amount: money(d[`投標廠商:投標廠商${i}:決標金額`]),
      period: text(d[`投標廠商:投標廠商${i}:履約起迄日期`]),
    });
  }
  const winners = bidders.filter(b => b.won === '是');
  // 與官方內頁同一套把關：家數與得標廠商缺一就不採用，寧可回頭走官方頁
  const countRaw = text(d['投標廠商:投標廠商家數']);
  const bidderCount = /^\d+$/.test(countRaw) ? parseInt(countRaw, 10) : null;
  if (bidderCount == null || winners.length === 0) return null;

  const budget = money(field(d, '預算金額'));
  const totalAward = money(d['決標資料:總決標金額']);
  return {
    pageType: 'award',
    orgName: text(d['機關資料:機關名稱']),
    caseNo: field(d, '標案案號'),
    tenderName: field(d, '標案名稱'),
    category: field(d, '標的分類'),
    tenderWay: field(d, '招標方式'),
    awardWay: field(d, '決標方式'),
    budget,
    floorPrice: money(d['決標資料:底價金額']),
    totalAward,
    awardDate: text(d['決標資料:決標日期']),
    awardNoticeDate: text(d['決標資料:決標公告日期']),
    execArea: field(d, '履約地點（含地區）') || field(d, '履約地點'),
    period: winners[0]?.period ?? '',
    bidderCount,
    jointBid: field(d, '是否共同投標'),
    bidders,
    winners,
    losers: bidders.filter(b => b.won !== '是'),
    discountRate: budget && totalAward ? Math.round((1 - totalAward / budget) * 10000) / 100 : null,
  };
}

function buildNonAwardRecord(d: Record<string, any>): NonAwardDetailRecord | null {
  const reason = text(d['無法決標公告:無法決標的理由']);
  if (!reason) return null;
  return {
    pageType: 'nonAward',
    orgName: text(d['無法決標公告:機關名稱']),
    caseNo: text(d['無法決標公告:標案案號']),
    tenderName: text(d['無法決標公告:標案名稱']),
    category: text(d['無法決標公告:標的分類']),
    reason,
    originalBulletinDate: text(d['無法決標公告:原招標公告之刊登採購公報日期']),
    nonAwardNoticeDate: text(d['無法決標公告:無法決標公告日期']),
    continueSameCase: text(d['無法決標公告:是否沿用本案號及原招標方式續行招標']),
  };
}

export interface MirrorDetailResult {
  record?: AwardDetailRecord | NonAwardDetailRecord;
  /** 內頁全部欄位，形狀與官方內頁解析一致 */
  pairs?: [string, string][];
  requests: number;
  error?: string;
}

/**
 * 取單案完整明細。一個案號在鏡像會有整個生命週期的多筆公告（招標→無法決標→決標），
 * 所以用收文編號挑出要的那一筆，挑不到就當失敗，讓呼叫端回頭走官方內頁。
 */
export async function fetchCaseDetail(
  ref: MirrorCaseRef,
  filing: string,
  wantKind: AwardDetailKind,
): Promise<MirrorDetailResult> {
  const url = `${BASE}/tender?unit_id=${encodeURIComponent(ref.unitId)}&job_number=${encodeURIComponent(ref.jobNumber)}`;
  let requests = 0;
  let lastError = '';

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const wait = THROTTLE_MS - (Date.now() - lastRequestEnd);
    if (wait > 0) await sleep(wait);

    let res;
    try {
      requests++;
      res = await axios.get(url, { timeout: 60000, responseType: 'text', validateStatus: () => true, transformResponse: r => r });
    } catch (e: any) {
      lastRequestEnd = Date.now();
      lastError = `連線失敗：${e.message}`;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    lastRequestEnd = Date.now();

    if (res.status === 429) {
      lastError = '鏡像限速（429）';
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (res.status !== 200) {
      lastError = `HTTP ${res.status}`;
      await sleep(2000 * (attempt + 1));
      continue;
    }

    let parsed: any;
    try {
      const body = String(res.data ?? '');
      const start = body.indexOf('{');
      parsed = start >= 0 ? JSON.parse(body.slice(start)) : {};
    } catch {
      lastError = '回應不是合法 JSON';
      await sleep(2000 * (attempt + 1));
      continue;
    }

    const records: any[] = Array.isArray(parsed?.records) ? parsed.records : [];
    const hit = records.find(r => filingNumberOf(String(r?.filename ?? '')) === filing);
    if (!hit) return { requests, error: `鏡像這個案號下找不到收文編號 ${filing} 的公告` };

    const d: Record<string, any> = hit.detail ?? {};
    const record = wantKind === 'award' ? buildAwardRecord(d) : buildNonAwardRecord(d);
    if (!record) return { requests, error: `鏡像欄位不足以組出${wantKind === 'award' ? '決標' : '無法決標'}明細` };

    const pairs: [string, string][] = Object.entries(d)
      .filter(([k, v]) => k !== 'url' && k !== 'fetched_at' && typeof v !== 'object')
      .map(([k, v]) => [k, String(v)]);
    return { record, pairs, requests };
  }

  return { requests, error: lastError || '未知錯誤' };
}
