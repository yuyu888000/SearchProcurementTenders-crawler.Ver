import ExcelJS from 'exceljs';
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
import { AWARD_DETAIL_CACHE_FILE, awardDetailUrl } from './award-detail-crawler.js';
import { lookupAwardDate } from './award-pk-index.js';
import { fetchDayIndex, fetchCaseDetail, filingNumberFromPk } from './mirror-client.js';
import { toROCNumber } from '../utils/date.js';
import { AwardDetailKind, AwardDetailRecord, NonAwardDetailRecord } from '../types/award.js';

/**
 * 決標案「標的分類」細碼補齊。
 *
 * 為什麼要有這支：決標查詢清單頁的標的分類只有「勞務類」這種大類，細碼（8672 工程服務）只在決標公告內頁。
 * 內頁有驗證碼額度，所以依序走：本機內頁快取（官方頁／人工另存，含更正後現行版）→ g0v 鏡像（不佔額度，
 * 但可能是更正前舊版）→ 都沒有就列出連結請使用者手存，再用 parse_award_html 讀進快取後重跑。
 */

export const CATEGORY_CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'award-categories.json');
/** 鏡像查無的案子多久內不重查（鏡像會補收，但不必每次都打） */
const MISS_RETRY_MS = 7 * 24 * 3600 * 1000;
export const DEFAULT_MIRROR_PER_CALL = 40;

/** 中類：官方代碼表是平的，這兩組上層名稱是使用者指定的；其他代碼在表上即最上層，中類沿用細項 */
const MID_GROUPS: [string, string][] = [
  ['867', '867 建築,工程及其他技術服務(含技術監造服務)'],
  ['52', '52 施工服務'],
];

export const CATEGORY_COLUMNS = ['標的類別', '標的中類', '標的細項', '標的分類來源'] as const;

export interface SplitCategory { cat: string; mid: string; item: string }

/** 「<勞務類>8672工程服務」「<勞務類> 8672 工程服務」「勞務類 8672 - 工程服務」→ 三欄；認不得回 null */
export function splitCategory(raw: string): SplitCategory | null {
  const s = String(raw ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const m = /^<?\s*(工程類|財物類|勞務類)\s*>?\s*(\d+)\s*-?\s*(.+)$/.exec(s);
  if (!m) return null;
  const [, cat, code, rest] = m;
  // 部分官方頁在分類後面接一段提示（如 94 類的環境用藥法規說明）；官方分類名稱不含空白，取到第一個空白為止
  const item = `${code} ${rest.trim().split(' ')[0]}`;
  const group = MID_GROUPS.find(([p]) => code.startsWith(p) && code !== p);
  return { cat, mid: group ? group[1] : item, item };
}

type Source = '決標公告內頁(快取)' | '決標公告(鏡像)';
interface CatEntry { raw?: string; status: 'ok' | 'miss'; at: string; why?: string }
type CatCache = Record<string, CatEntry>;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return fallback; }
}
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1), 'utf8');
  await rename(tmp, file);
}

export interface CategoryFillOptions {
  path: string;
  sheetName?: string;
  maxMirror?: number;
  outputPath?: string;
  /** 測試用 */
  detailCacheFile?: string;
  categoryCacheFile?: string;
}

export interface CategoryFillResult {
  sheet: string;
  total: number;
  alreadyFilled: number;
  filled: Record<Source, number>;
  mirrorRequests: number;
  /** 本次鏡像沒輪到（受 maxMirror 限制），再呼叫一次會接著查 */
  pendingMirror: number;
  /** 快取與鏡像都沒有：需要人工另存 HTML */
  missing: { row: number; pk: string; org: string; caseNo: string; url: string; why: string }[];
  unrecognized: { row: number; pk: string; raw: string }[];
  outputPath: string | null;
}

const text = (v: ExcelJS.CellValue): string => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map(t => t.text).join('');
    if ('text' in v) return String((v as any).text);
    if ('result' in v) return String((v as any).result ?? '');
    if (v instanceof Date) return `${v.getFullYear()}-${v.getMonth() + 1}-${v.getDate()}`;
  }
  return String(v).trim();
};

async function pickOutputPath(src: string, wanted?: string): Promise<string> {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const base = wanted ?? join(dirname(src), `${basename(src, extname(src))}_標的分類_${ymd}.xlsx`);
  const exists = async (p: string) => access(p).then(() => true, () => false);
  if (!(await exists(base))) return base;
  const stamp = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  return base.replace(/\.xlsx$/i, `_${stamp}.xlsx`);
}

export async function fillCategoriesInWorkbook(opts: CategoryFillOptions): Promise<CategoryFillResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(opts.path);

  const headersOf = (ws: ExcelJS.Worksheet) => {
    const h = new Map<string, number>();
    ws.getRow(1).eachCell((c, col) => { const t = text(c.value); if (t) h.set(t, col); });
    return h;
  };
  const ws = opts.sheetName ? wb.getWorksheet(opts.sheetName) : wb.worksheets.find(s => headersOf(s).has('pk'));
  if (!ws) throw new Error(opts.sheetName ? `找不到工作表「${opts.sheetName}」` : '找不到第一列有「pk」欄的工作表；請用 sheetName 指定');
  const H = headersOf(ws);
  const pkCol = H.get('pk');
  if (!pkCol) throw new Error(`工作表「${ws.name}」第一列沒有「pk」欄（決標公告網址 ?pk= 後面那段）`);
  const dateCol = H.get('決標公告日') ?? H.get('決標公告日_西元');
  const orgCol = H.get('機關'), caseCol = H.get('案號');

  // 沒有的欄位接在最右邊；標頭沿用 pk 欄的樣式
  let next = ws.columnCount + 1;
  const col: Record<string, number> = {};
  for (const name of CATEGORY_COLUMNS) {
    col[name] = H.get(name) ?? next++;
    const hc = ws.getCell(1, col[name]);
    if (!text(hc.value)) { hc.value = name; hc.style = { ...ws.getCell(1, pkCol).style }; }
  }

  const detail = await readJson<Record<string, any>>(opts.detailCacheFile ?? AWARD_DETAIL_CACHE_FILE, {});
  const catFile = opts.categoryCacheFile ?? CATEGORY_CACHE_FILE;
  const catCache = await readJson<CatCache>(catFile, {});

  const res: CategoryFillResult = {
    sheet: ws.name, total: 0, alreadyFilled: 0,
    filled: { '決標公告內頁(快取)': 0, '決標公告(鏡像)': 0 },
    mirrorRequests: 0, pendingMirror: 0, missing: [], unrecognized: [], outputPath: null,
  };

  const write = (r: number, raw: string, source: Source, pk: string): boolean => {
    const s = splitCategory(raw);
    if (!s) { res.unrecognized.push({ row: r, pk, raw }); return false; }
    ws.getCell(r, col['標的類別']).value = s.cat;
    ws.getCell(r, col['標的中類']).value = s.mid;
    ws.getCell(r, col['標的細項']).value = s.item;
    ws.getCell(r, col['標的分類來源']).value = source;
    res.filled[source]++;
    return true;
  };

  const needMirror: { r: number; pk: string; date: number | null }[] = [];
  const url = (pk: string) => `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${pk}`;
  const info = (r: number) => ({ org: orgCol ? text(ws.getCell(r, orgCol).value) : '', caseNo: caseCol ? text(ws.getCell(r, caseCol).value) : '' });

  for (let r = 2; r <= ws.rowCount; r++) {
    const pk = text(ws.getCell(r, pkCol).value);
    if (!pk) continue;
    res.total++;
    if (text(ws.getCell(r, col['標的細項']).value)) { res.alreadyFilled++; continue; }

    // 1. 內頁快取：官方頁或人工另存，是現行版（含更正），優先於鏡像
    const rec = detail[`award:${pk}`]?.record;
    if (rec?.category && write(r, rec.category, '決標公告內頁(快取)', pk)) continue;

    // 2. 已查過的鏡像結果
    const c = catCache[pk];
    if (c?.status === 'ok' && c.raw && write(r, c.raw, '決標公告(鏡像)', pk)) continue;
    if (c?.status === 'miss' && Date.now() - Date.parse(c.at) < MISS_RETRY_MS) {
      res.missing.push({ row: r, pk, ...info(r), url: url(pk), why: c.why ?? '鏡像未收錄' });
      continue;
    }
    const dateText = dateCol ? text(ws.getCell(r, dateCol).value) : '';
    needMirror.push({ r, pk, date: toROCNumber(dateText) ?? await lookupAwardDate(pk) });
  }

  // 3. 鏡像：同一天的排在一起，日索引只抓一次
  needMirror.sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  const cap = opts.maxMirror ?? DEFAULT_MIRROR_PER_CALL;
  let done = 0;
  for (const t of needMirror) {
    if (done >= cap) { res.pendingMirror++; continue; }
    const filing = filingNumberFromPk(t.pk);
    let entry: CatEntry;
    if (!filing) entry = { status: 'miss', at: new Date().toISOString(), why: 'pk 不是決標公告編號' };
    else if (!t.date) entry = { status: 'miss', at: new Date().toISOString(), why: '缺決標公告日（表內無此欄，也沒被 search_awards 查過）' };
    else {
      done++;
      const day = await fetchDayIndex(t.date);
      res.mirrorRequests += day.requests;
      const ref = day.error ? undefined : day.byFiling.get(filing);
      if (day.error) { res.pendingMirror++; continue; }         // 連線／限速問題：不記 miss，下次重試
      if (!ref) entry = { status: 'miss', at: new Date().toISOString(), why: '鏡像當日索引無此公告' };
      else {
        const d = await fetchCaseDetail(ref, filing, 'award');
        res.mirrorRequests += d.requests;
        if (d.record?.category) entry = { status: 'ok', raw: d.record.category, at: new Date().toISOString() };
        else if (/找不到|欄位不足/.test(d.error ?? '')) entry = { status: 'miss', at: new Date().toISOString(), why: d.error };
        else { res.pendingMirror++; continue; }
      }
    }
    catCache[t.pk] = entry;
    await writeJsonAtomic(catFile, catCache);                    // 逐筆落地：中斷後重跑不重查
    if (entry.status === 'ok' && entry.raw && write(t.r, entry.raw, '決標公告(鏡像)', t.pk)) continue;
    res.missing.push({ row: t.r, pk: t.pk, ...info(t.r), url: url(t.pk), why: entry.why ?? '分類格式認不得' });
  }

  const out = await pickOutputPath(opts.path, opts.outputPath);
  try {
    await wb.xlsx.writeFile(out);
  } catch (e: any) {
    if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error(`存檔被拒（${e.code}）：${out} 可能正在 Excel 開著，請關閉後重跑（已查到的結果都在快取，不會重查）`);
    throw e;
  }
  res.outputPath = out;
  return res;
}

/**
 * 待查重查：fillCategoriesInWorkbook 查無的案子會記 7 天 miss，但「鏡像當日索引無此公告」多半只是
 * 鏡像還沒收錄（公告後一兩天才補齊），7 天內不會再問。這裡無視 miss、強制重抓當日索引再查一次，
 * 查到就把分類寫回快取，順便帶回得標廠商與金額，呼叫端不必再開官方內頁。
 */
export interface RecheckCase { pk: string; date?: string; kind?: AwardDetailKind }

export interface RecheckResolved {
  pk: string; date: number | null; raw: string; split: SplitCategory | null; source: Source;
  orgName?: string; caseNo?: string; tenderName?: string;
  winners?: { name: string; vendorId: string; amount: number | null }[];
  totalAward?: number | null; budget?: number | null; bidderCount?: number | null;
}

export interface RecheckResult {
  total: number;
  resolved: RecheckResolved[];
  stillMissing: { pk: string; date: number | null; url: string; why: string }[];
  /** 連線／限速失敗或超過 maxMirror，下次再查 */
  pendingMirror: string[];
  mirrorRequests: number;
}

export async function recheckPendingCategories(opts: {
  cases: RecheckCase[];
  maxMirror?: number;
  detailCacheFile?: string;
  categoryCacheFile?: string;
}): Promise<RecheckResult> {
  const detail = await readJson<Record<string, any>>(opts.detailCacheFile ?? AWARD_DETAIL_CACHE_FILE, {});
  const catFile = opts.categoryCacheFile ?? CATEGORY_CACHE_FILE;
  const catCache = await readJson<CatCache>(catFile, {});
  const url = (kind: AwardDetailKind, pk: string) =>
    kind === 'award' ? `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${pk}` : awardDetailUrl(kind, pk);
  const res: RecheckResult = { total: 0, resolved: [], stillMissing: [], pendingMirror: [], mirrorRequests: 0 };
  // 寫入前重讀合併，不蓋掉別的行程剛寫的案子；別處已查到（ok）的不降級成 miss
  const save = async (pk: string, entry: CatEntry) => {
    const cur = await readJson<CatCache>(catFile, {});
    if (entry.status === 'miss' && cur[pk]?.status === 'ok') return;
    cur[pk] = entry;
    await writeJsonAtomic(catFile, cur);
  };

  const need: { pk: string; kind: AwardDetailKind; date: number | null; badDate?: string }[] = [];
  const seen = new Set<string>();
  for (const c of opts.cases) {
    const pk = c.pk.trim();
    const kind = c.kind ?? 'award';
    if (!pk || seen.has(pk)) continue;
    seen.add(pk);
    res.total++;
    const given = toROCNumber(c.date);
    const date = given ?? await lookupAwardDate(pk);
    const badDate = c.date?.trim() && !given ? c.date.trim() : undefined;
    const rec = detail[`${kind}:${pk}`]?.record;
    if (rec?.category) {
      res.resolved.push({ pk, date, raw: rec.category, split: splitCategory(rec.category), source: '決標公告內頁(快取)', ...pickDetail(rec) });
      continue;
    }
    const cached = catCache[pk];
    if (cached?.status === 'ok' && cached.raw) {
      res.resolved.push({ pk, date, raw: cached.raw, split: splitCategory(cached.raw), source: '決標公告(鏡像)' });
      continue;
    }
    need.push({ pk, kind, date, badDate });                     // miss 一律重查
  }

  need.sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  const cap = opts.maxMirror ?? DEFAULT_MIRROR_PER_CALL;
  const refreshed = new Set<number>();
  // 某天的索引抓失敗（限速／斷線）就不再為同日其他案子重抓，免得對已在限速的鏡像連打
  const failedDates = new Set<number>();
  let done = 0;
  for (const t of need) {
    const filing = filingNumberFromPk(t.pk);
    const link = url(t.kind, t.pk);
    if (!filing) { res.stillMissing.push({ pk: t.pk, date: t.date, url: link, why: 'pk 不是決標公告編號' }); continue; }
    if (!t.date) {
      const why = t.badDate ? `日期格式認不得：${t.badDate}（請用 115/09/29 或 2026-09-29）` : '缺決標公告日（未提供，也沒被 search_awards 查過）';
      res.stillMissing.push({ pk: t.pk, date: null, url: link, why });
      continue;
    }
    if (done >= cap || failedDates.has(t.date)) { res.pendingMirror.push(t.pk); continue; }
    done++;
    // 同一天只強制重抓一次，之後同日的案子用剛抓的新索引
    const day = await fetchDayIndex(t.date, { force: !refreshed.has(t.date) });
    res.mirrorRequests += day.requests;
    if (day.error) { failedDates.add(t.date); res.pendingMirror.push(t.pk); continue; }
    refreshed.add(t.date);
    const ref = day.byFiling.get(filing);
    if (!ref) {
      const why = '重查時鏡像當日索引仍無此公告';
      await save(t.pk, { status: 'miss', at: new Date().toISOString(), why });
      res.stillMissing.push({ pk: t.pk, date: t.date, url: link, why });
      continue;
    }
    const d = await fetchCaseDetail(ref, filing, t.kind);
    res.mirrorRequests += d.requests;
    const rec = d.record;
    if (rec?.category) {
      await save(t.pk, { status: 'ok', raw: rec.category, at: new Date().toISOString() });
      res.resolved.push({ pk: t.pk, date: t.date, raw: rec.category, split: splitCategory(rec.category), source: '決標公告(鏡像)', ...pickDetail(rec) });
    } else if (/找不到|欄位不足/.test(d.error ?? '')) {
      await save(t.pk, { status: 'miss', at: new Date().toISOString(), why: d.error });
      res.stillMissing.push({ pk: t.pk, date: t.date, url: link, why: d.error ?? '鏡像欄位不足' });
    } else res.pendingMirror.push(t.pk);
  }
  return res;
}

function pickDetail(rec: AwardDetailRecord | NonAwardDetailRecord) {
  if (rec.pageType !== 'award') return { orgName: rec.orgName, caseNo: rec.caseNo, tenderName: rec.tenderName };
  return {
    orgName: rec.orgName, caseNo: rec.caseNo, tenderName: rec.tenderName,
    winners: (rec.winners ?? []).map(w => ({ name: w.name, vendorId: w.vendorId, amount: w.amount })),
    totalAward: rec.totalAward, budget: rec.budget, bidderCount: rec.bidderCount,
  };
}
