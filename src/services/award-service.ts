import axios from 'axios';
import * as cheerio from 'cheerio';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AwardCategory, AwardQuery, AwardQueryResult, AwardRow, AwardStatus,
  ExecLocationOption, LocationStat, MultiLocationResult,
} from '../types/award.js';
import { rocStringToNumber } from '../utils/date.js';
import { locationLabel } from './award-locations.js';

/**
 * 決標查詢（決標公告清單）readTenderAgent。
 * 這支清單端點沒有內頁那種驗證碼流量控制，但仍一律節流；
 * 標的分類／履約地點／決標公告日區間三個篩選實測都在伺服器端生效。
 */

const INDEX_URL = 'https://web.pcc.gov.tw/prkms/tender/common/agent/indexTenderAgent';
const READ_URL = 'https://web.pcc.gov.tw/prkms/tender/common/agent/readTenderAgent';
const SITE_ORIGIN = 'https://web.pcc.gov.tw';

export const PAGE_SIZE = 100;
const THROTTLE_MS = 1500;
/** 官網決標查詢只提供 112/07/01 之後的資料 */
export const AWARD_DATA_START_ROC = 1120701;
/** 官網前端對未登入者的區間上限（天），超過會被導走 */
export const MAX_RANGE_DAYS = 186;

// build 後此檔在 build/services/，匯出檔固定放專案根的 .cache/exports/
// ⚠️ 不可依賴工作目錄：MCP 由 GUI 啟動時 CWD 是 C:\Windows\System32，寫入會被拒
const EXPORT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'exports');

// Node 內建 fetch 會被 WAF 擋，必須 axios＋這組 headers
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9',
  'Referer': INDEX_URL,
};

const CATEGORY_CODE: Record<AwardCategory, string> = {
  '工程': 'RAD_PROCTRG_CATE_1',
  '財物': 'RAD_PROCTRG_CATE_2',
  '勞務': 'RAD_PROCTRG_CATE_3',
};

const STATUS_CODE: Record<AwardStatus, string> = {
  '決標': 'TENDER_STATUS_1',
  '無法決標': 'TENDER_STATUS_2',
  '撤銷': 'TENDER_STATUS_3',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- 日期 ----------

/** 民國 yyyMMdd 整數是否為真實存在的日期（toROCNumber 不擋 2/31） */
export function isValidRocNumber(n: number): boolean {
  const y = Math.floor(n / 10000) + 1911, m = Math.floor((n % 10000) / 100), d = n % 100;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 1150711 → 2026/07/11（官網參數吃西元） */
export function rocNumberToWestern(n: number): string {
  const y = Math.floor(n / 10000) + 1911, m = Math.floor((n % 10000) / 100), d = n % 100;
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

export function todayRocNumber(): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number);
  return (parts[0] - 1911) * 10000 + parts[1] * 100 + parts[2];
}

export function rocDaysBetween(a: number, b: number): number {
  const t = (n: number) => Date.UTC(Math.floor(n / 10000) + 1911, Math.floor((n % 10000) / 100) - 1, n % 100);
  return Math.round(Math.abs(t(b) - t(a)) / 86400000);
}

// ---------- 解析 ----------

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * 解析清單頁。資料表要挑「第一格是數字且 td ≥ 9 的列」最多的那張：
 * 查詢表單那張表有 26 列（含 1 列 ≥9 格），結果少時用「tr 最多」會誤選而靜默回 0 筆。
 * siteTotal 為 null 代表頁面不是預期的結果頁。
 */
export function parseAwardListHtml(html: string): { siteTotal: number | null; rows: Omit<AwardRow, 'execLocation'>[]; pagerKey: string | null } {
  const $ = cheerio.load(html);
  const isDataRow = (tr: any) => {
    const tds = $(tr).children('td');
    return tds.length >= 9 && /^\d+$/.test(clean($(tds[0]).text()));
  };

  let best: any = null;
  let bestN = 0;
  $('table').each((_, t) => {
    const n = $(t).find('tr').filter((_, tr) => isDataRow(tr)).length;
    if (n > bestN) { bestN = n; best = t; }
  });

  const rows: Omit<AwardRow, 'execLocation'>[] = [];
  if (best) {
    $(best).find('tr').each((_, tr) => {
      if (!isDataRow(tr)) return;
      const tds = $(tr).children('td');
      const cell = (i: number) => clean($(tds[i]).text());

      const caseHtml = $(tds[2]).html() || '';
      const caseHead = cheerio.load(caseHtml.split(/<br\s*\/?>/i)[0]).root().text();
      const isCorrection = /更正公告/.test(caseHead);
      const caseNo = clean(caseHead.replace(/\(\s*更正公告\s*\)|（\s*更正公告\s*）/g, ''));

      const nm = caseHtml.match(/pageCode2Img\("((?:[^"\\]|\\.)*)"\)/);
      const tenderName = nm
        ? nm[1].replace(/\\(.)/g, '$1').trim()
        : clean($(tds[2]).find('a[title]').first().attr('title') || '');

      // 「檢視」連結在最後一格；找不到就退而取整列第一個帶 pk 的連結
      const viewA = $(tds[tds.length - 1]).find('a[href*="pk="]').first();
      const href = (viewA.length ? viewA : $(tr).find('a[href*="pk="]').first()).attr('href') || '';
      const lm = href.match(/\/urlSelector\/common\/(\w+)\?pk=([^&"'\s]+)/);
      const pkm = href.match(/[?&]pk=([^&"'\s]+)/);
      const pk = pkm ? decodeURIComponent(pkm[1]) : '';
      const linkType = lm ? lm[1] : '';

      const amountText = cell(6).replace(/,/g, '');
      const amount = /^\d+$/.test(amountText) ? parseInt(amountText, 10) : null;

      const awardSeq = cell(7);
      const nonAwardSeq = cell(8);

      rows.push({
        pk,
        linkType,
        url: href ? (href.startsWith('http') ? href : SITE_ORIGIN + href) : '',
        orgName: cell(1),
        caseNo,
        isCorrection,
        tenderName,
        tenderWay: cell(3),
        category: cell(4),
        awardNoticeDate: cell(5),
        amount,
        awardSeq,
        nonAwardSeq,
        isNonAward: linkType === 'nonAtm' || (!awardSeq && Boolean(nonAwardSeq)),
      });
    });
  }

  const tm = html.match(/共有[\s\S]{0,80}?筆/);
  const num = tm ? tm[0].replace(/<[^>]+>/g, '').match(/[\d,]+/) : null;
  const siteTotal = num ? parseInt(num[0].replace(/,/g, ''), 10) : null;
  // 翻頁參數 d-<數字>-p 的數字每次查詢固定但不可寫死
  const pagerKey = (html.match(/d-\d+-p=\d+/) || [''])[0].split('-p=')[0] || null;
  return { siteTotal, rows, pagerKey };
}

// ---------- 連線 ----------

class BlockedError extends Error {}

let lastRequestEnd = 0;
let requestCounter = 0;

async function fetchListPage(params: Record<string, string>): Promise<string> {
  const url = `${READ_URL}?${new URLSearchParams(params).toString()}`;
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const gap = attempt === 1 ? THROTTLE_MS : 5000 * (attempt - 1);
    const wait = lastRequestEnd + gap - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const res = await axios.get(url, { headers: HEADERS, responseType: 'arraybuffer', timeout: 45000, validateStatus: () => true });
      const html = Buffer.from(res.data).toString('utf8');
      // 驗證碼不重試、不繞過，直接停
      if (html.includes('撲克牌') || (/captcha/i.test(html) && !html.includes('共有'))) {
        throw new BlockedError('官網回傳驗證碼頁（流量控制），已停止查詢');
      }
      if (html.includes('Web Page Blocked')) {
        lastErr = new BlockedError('官網 WAF 封鎖（Web Page Blocked）');
        continue;
      }
      if (res.status >= 400) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return html;
    } catch (e: any) {
      if (e instanceof BlockedError) throw e;
      lastErr = e;
    } finally {
      lastRequestEnd = Date.now();
      requestCounter++;
    }
  }
  throw lastErr ?? new Error('連線失敗');
}

function buildParams(q: AwardQuery): Record<string, string> {
  return {
    isBinding: 'N', isLogIn: 'N', firstSearch: 'false', isQuery: 'true', pageSize: String(PAGE_SIZE),
    orgName: q.orgName ?? '', orgId: '',
    tenderName: q.tenderName ?? '', tenderId: '',
    tenderStatus: STATUS_CODE[q.status ?? '決標'],
    tenderWay: 'TENDER_WAY_ALL_DECLARATION',
    radProctrgCate: q.category ? CATEGORY_CODE[q.category] : '',
    tenderRange: 'TENDER_RANGE_ALL', item: '',
    gottenVendorName: q.gottenVendorName ?? '', gottenVendorId: q.gottenVendorId ?? '',
    submitVendorName: q.submitVendorName ?? '', submitVendorId: q.submitVendorId ?? '',
    execLocation: q.execLocation ?? '',
    priorityCate: '', radReConstruct: '', policyAdvocacy: '', isCpp: '',
    awardAnnounceStartDate: rocNumberToWestern(q.from),
    awardAnnounceEndDate: rocNumberToWestern(q.to),
  };
}

/**
 * 通用決標查詢（單一履約地點代碼），自動翻頁到抓完或達 maxRows。
 * maxRows=0 仍會打第一頁，用來取得官網總數。
 */
export async function queryAwards(q: AwardQuery, opts: { maxRows?: number } = {}): Promise<AwardQueryResult> {
  const maxRows = Math.max(0, opts.maxRows ?? Infinity);
  const params = buildParams(q);
  const startCount = requestCounter;
  const tag = (r: Omit<AwardRow, 'execLocation'>): AwardRow => ({ ...r, execLocation: q.execLocation ?? '' });
  const done = (siteTotal: number, rows: AwardRow[], extra: Partial<AwardQueryResult> = {}): AwardQueryResult => ({
    siteTotal, rows, truncated: false, requests: requestCounter - startCount, ...extra,
  });

  let rows: AwardRow[] = [];
  let siteTotal = 0;
  // 清單依決標公告日新到舊排序；翻頁途中若有新公告插到最前面，後面每頁都會位移一格，
  // 造成「上頁最後一列重複＋新的那筆永遠抓不到」，而筆數仍然對得上。所以逐頁核對總數與 pk，變動就整批重翻。
  const MAX_ATTEMPTS = 2;
  try {
    for (let attempt = 1; ; attempt++) {
      const first = parseAwardListHtml(await fetchListPage(params));
      if (first.siteTotal == null) {
        return done(0, [], { error: '官網回應不是預期的結果頁（找不到「共有 N 筆」），可能查詢條件被拒' });
      }
      siteTotal = first.siteTotal;
      if (siteTotal > 0 && first.rows.length === 0) {
        return done(siteTotal, [], { error: `官網顯示共有 ${siteTotal} 筆，但第 1 頁一列都解析不到（頁面版型可能變了）` });
      }
      rows = first.rows.map(tag);
      const seenPk = new Set(rows.map(r => r.pk));

      let shifted: string | null = null;
      const pages = Math.ceil(siteTotal / PAGE_SIZE);
      if (pages > 1 && first.rows.length !== PAGE_SIZE) {
        shifted = `第 1 頁只有 ${first.rows.length} 列（非末頁應為 ${PAGE_SIZE} 列）`;
      }
      for (let p = 2; !shifted && p <= pages && rows.length < maxRows; p++) {
        if (!first.pagerKey) {
          return done(siteTotal, rows.slice(0, maxRows), { error: '找不到翻頁參數 d-<數字>-p，第 2 頁之後沒抓' });
        }
        const pg = parseAwardListHtml(await fetchListPage({ ...params, [`${first.pagerKey}-p`]: String(p) }));
        if (pg.siteTotal !== siteTotal) {
          shifted = `官網總數在翻頁期間變動（第 1 頁 ${siteTotal} 筆 → 第 ${p} 頁 ${pg.siteTotal ?? '?'} 筆）`;
          break;
        }
        if (pg.rows.length === 0) {
          return done(siteTotal, rows.slice(0, maxRows), { error: `第 ${p} 頁回傳 0 列（官網資料可能在翻頁期間變動）` });
        }
        const dup = pg.rows.find(r => r.pk && seenPk.has(r.pk));
        if (dup) {
          shifted = `第 ${p} 頁出現與前頁重複的公告（${dup.caseNo}），清單在翻頁期間位移`;
          break;
        }
        // 非末頁一定滿 PAGE_SIZE；少列代表清單位移（maxRows 截斷時末端核對會被跳過，只能在這裡抓）
        if (p < pages && pg.rows.length !== PAGE_SIZE) {
          shifted = `第 ${p} 頁只有 ${pg.rows.length} 列（非末頁應為 ${PAGE_SIZE} 列）`;
          break;
        }
        pg.rows.forEach(r => seenPk.add(r.pk));
        rows = rows.concat(pg.rows.map(tag));
      }

      if (!shifted) break;
      if (attempt >= MAX_ATTEMPTS) {
        return done(siteTotal, rows.slice(0, maxRows), {
          error: `${shifted}；已重翻 ${MAX_ATTEMPTS} 次仍不一致，結果可能漏抓。請稍後重查，或把 to 設為昨天以避開當天新公告`,
        });
      }
    }
  } catch (e: any) {
    return done(siteTotal, rows.slice(0, maxRows), { error: e.message || String(e), blocked: e instanceof BlockedError });
  }

  const truncated = rows.length > maxRows || (rows.length < siteTotal && rows.length >= maxRows);
  if (!truncated && rows.length !== siteTotal) {
    return done(siteTotal, rows, { error: `實抓 ${rows.length} 筆與官網 ${siteTotal} 筆不符` });
  }
  return done(siteTotal, rows.slice(0, maxRows), { truncated });
}

export function awardDedupKey(r: AwardRow): string {
  return `${r.orgName}||${r.caseNo}||${r.awardSeq || r.nonAwardSeq}`;
}

/**
 * 履約地點是單選，多個代碼逐一查再合併。
 * 每個代碼至少打第一頁拿官網總數，所以就算 maxRows 用完，摘要仍有完整的官網筆數。
 */
export async function queryAwardsByLocations(
  base: Omit<AwardQuery, 'execLocation'>,
  locations: ExecLocationOption[],
  opts: { maxRows: number },
): Promise<MultiLocationResult> {
  const perLocation: LocationStat[] = [];
  let all: AwardRow[] = [];
  let requests = 0;
  let blocked = false;

  for (const loc of locations) {
    if (blocked) {
      perLocation.push({ ...loc, siteTotal: null, fetched: 0, truncated: false, skipped: true });
      continue;
    }
    const remaining = Math.max(0, opts.maxRows - all.length);
    const r = await queryAwards({ ...base, execLocation: loc.code }, { maxRows: remaining });
    requests += r.requests;
    if (r.blocked) blocked = true;
    perLocation.push({ ...loc, siteTotal: r.error && r.siteTotal === 0 && r.rows.length === 0 ? null : r.siteTotal, fetched: r.rows.length, truncated: r.truncated, error: r.error });
    all = all.concat(r.rows);
  }

  const seen = new Map<string, AwardRow>();
  for (const r of all) {
    const k = awardDedupKey(r);
    if (!seen.has(k)) seen.set(k, r);
  }
  const rows = [...seen.values()]
    .map((r, i) => ({ r, i, d: rocStringToNumber(r.awardNoticeDate) ?? 0 }))
    .sort((a, b) => b.d - a.d || a.i - b.i)
    .map(x => x.r);

  return {
    perLocation,
    rows,
    siteTotal: perLocation.reduce((s, p) => s + (p.siteTotal ?? 0), 0),
    siteTotalIsLowerBound: perLocation.some(p => p.siteTotal == null),
    fetchedTotal: all.length,
    duplicates: all.length - rows.length,
    truncated: perLocation.some(p => p.truncated),
    requests,
    hasError: perLocation.some(p => p.error || p.skipped),
  };
}

// ---------- 匯出 ----------

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** 全部結果寫成 CSV（UTF-8 BOM，Excel 直接開不亂碼）與 JSON */
export async function exportAwards(rows: AwardRow[], meta: Record<string, unknown>): Promise<{ csvPath: string; jsonPath: string }> {
  await mkdir(EXPORT_DIR, { recursive: true });
  const base = join(EXPORT_DIR, `awards_${timestamp()}`);
  const csvPath = `${base}.csv`;
  const jsonPath = `${base}.json`;

  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['決標公告日', '履約地點', '履約地點代碼', '機關名稱', '標案案號', '標案名稱', '招標方式', '標的分類',
    '決標金額', '決標公告序號', '無法決標公告序號', '是否更正公告', '是否無法決標', '連結型態', 'pk', '連結'];
  const lines = rows.map(r => [
    r.awardNoticeDate, locationLabel(r.execLocation), r.execLocation, r.orgName, r.caseNo, r.tenderName, r.tenderWay, r.category,
    r.amount ?? '', r.awardSeq, r.nonAwardSeq, r.isCorrection ? '是' : '否', r.isNonAward ? '是' : '否', r.linkType, r.pk, r.url,
  ].map(esc).join(','));
  await writeFile(csvPath, '\uFEFF' + [head.map(esc).join(','), ...lines].join('\r\n') + '\r\n', 'utf8');
  await writeFile(jsonPath, JSON.stringify({ ...meta, exportedAt: new Date().toISOString(), rowCount: rows.length, rows }, null, 1), 'utf8');
  return { csvPath, jsonPath };
}

// ---------- 用廠商反查案件（find_awards_by_vendor） ----------

/** 8 碼數字＝統一編號，其餘當廠商名稱（部分比對） */
export function isVendorId(s: string): boolean {
  return /^\d{8}$/.test(s.trim());
}

export interface VendorAwardResult {
  vendor: string;
  byId: boolean;
  /** 得標的案子 */
  won: AwardRow[];
  /** 有投標但沒得標的案子（role 含 bidder 時才有） */
  lost: AwardRow[];
  siteTotalWon: number;
  siteTotalBid: number | null;
  truncated: boolean;
  requests: number;
  error?: string;
  blocked?: boolean;
}

/**
 * 一家廠商查一次（得標）；要落標紀錄就再查一次投標廠商欄，兩者相減。
 * 官網三個欄位實測皆有效（2026-09-16）：gottenVendorId／gottenVendorName／submitVendorId／submitVendorName，
 * 名稱是部分比對——「中興工程顧問」會連「中興工程顧問社」一起命中，能給統編就給統編。
 */
export async function queryAwardsByVendor(
  base: Omit<AwardQuery, 'execLocation' | 'gottenVendorName' | 'gottenVendorId' | 'submitVendorName' | 'submitVendorId'>,
  vendor: string,
  opts: { maxRows: number; includeBids: boolean },
): Promise<VendorAwardResult> {
  const v = vendor.trim();
  const byId = isVendorId(v);
  const wonQ: AwardQuery = byId ? { ...base, gottenVendorId: v } : { ...base, gottenVendorName: v };
  const won = await queryAwards(wonQ, { maxRows: opts.maxRows });
  const out: VendorAwardResult = {
    vendor: v, byId, won: won.rows, lost: [],
    siteTotalWon: won.siteTotal, siteTotalBid: null,
    truncated: won.truncated, requests: won.requests, error: won.error, blocked: won.blocked,
  };
  if (!opts.includeBids || won.blocked) return out;

  const bidQ: AwardQuery = byId ? { ...base, submitVendorId: v } : { ...base, submitVendorName: v };
  const bid = await queryAwards(bidQ, { maxRows: opts.maxRows });
  out.requests += bid.requests;
  out.siteTotalBid = bid.siteTotal;
  if (bid.error) out.error = out.error ? `${out.error}；投標查詢：${bid.error}` : `投標查詢：${bid.error}`;
  if (bid.blocked) out.blocked = true;
  out.truncated = out.truncated || bid.truncated;
  const wonKeys = new Set(won.rows.map(awardDedupKey));
  out.lost = bid.rows.filter(r => !wonKeys.has(awardDedupKey(r)));
  return out;
}
