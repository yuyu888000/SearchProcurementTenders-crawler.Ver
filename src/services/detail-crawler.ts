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
 *   3. 一遇驗證碼立刻中止整批（繼續打只是徒增負擔），未完成的誠實回報
 * 絕不繞過或破解驗證碼。
 */

const DETAIL_BASE = 'https://web.pcc.gov.tw/tps/QueryTender/query/searchTenderDetail';

/** 單次最多抓幾筆未快取的案子 */
export const MAX_FETCH_PER_CALL = 8;
/** 連續請求間隔（毫秒） */
const THROTTLE_MS = 1500;

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
    if (fetched >= MAX_FETCH_PER_CALL) {
      details.push({ input, pk, url, ok: false, reason: 'error', message: `超過單次抓取上限（${MAX_FETCH_PER_CALL} 筆），請分批查詢`, fields: {}, cached: false });
      continue;
    }

    if (fetched > 0) await sleep(THROTTLE_MS);
    const r = await fetchOne(pk);
    fetched++;

    if (r.fields) {
      store[pk] = { url, fields: r.fields, savedAt: new Date().toISOString() };
      dirty = true;
      details.push({ input, pk, url, ok: true, fields: r.fields, cached: false });
    } else {
      if (r.reason === 'captcha') blocked = true; // 之後的一律不再打
      details.push({ input, pk, url, ok: false, reason: r.reason, message: r.message, fields: {}, cached: false });
    }
  }

  if (dirty) await saveCache();
  return { details, blocked, fetched };
}
