import ExcelJS from 'exceljs';
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, basename } from 'node:path';
import { AwardRow } from '../types/award.js';
import { ResolveJob } from './resolve-service.js';
import { countyOfLocation, countyFromOrgName, locationLabel } from './award-locations.js';

/**
 * 決標資料匯出成多工作表 Excel：說明／明細／縣市統計／機關排行／廠商排行（有廠商資料才有）／金額級距。
 * 資料來源兩種：search_awards 同一套清單查詢（沒有廠商欄），或 resolve_award_vendors 的工作（有廠商欄）。
 */

export interface ExportCase {
  awardNoticeDate: string;
  county: string;
  location: string;
  orgName: string;
  caseNo: string;
  tenderName: string;
  tenderWay: string;
  category: string;
  amount: number | null;
  isCorrection: boolean | null;
  winner: string;
  winnerId: string;
  source: string;
  url: string;
}

export interface ExcelExportResult {
  path: string;
  sheets: { name: string; rows: number }[];
  caseCount: number;
  totalAmount: number;
  countyTop: { county: string; count: number; amount: number }[];
  orgTop: { org: string; count: number; amount: number }[];
  vendorTop: { vendor: string; count: number; amount: number }[];
  vendorCoverage: { resolved: number; total: number } | null;
}

const DEFAULT_EXPORT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'exports');
const UNKNOWN_COUNTY = '（未能判斷）';
/** 複數決標在官網與 resolve 工作裡都是「A / B」 */
const WINNER_SEP = ' / ';

export function rowsToExportCases(rows: AwardRow[]): ExportCase[] {
  return rows.map(r => ({
    awardNoticeDate: r.awardNoticeDate,
    // 「其他」桶與不限地點改用機關名稱推
    county: countyOfLocation(r.execLocation) ?? countyFromOrgName(r.orgName) ?? UNKNOWN_COUNTY,
    location: r.execLocation ? locationLabel(r.execLocation) : '',
    orgName: r.orgName,
    caseNo: r.caseNo,
    tenderName: r.tenderName,
    tenderWay: r.tenderWay,
    category: r.category,
    amount: r.amount,
    isCorrection: r.isCorrection,
    winner: '',
    winnerId: '',
    source: '',
    url: r.url,
  }));
}

export function jobToExportCases(job: ResolveJob): ExportCase[] {
  return job.cases.map(c => ({
    awardNoticeDate: c.awardNoticeDate,
    county: countyFromOrgName(c.orgName) ?? UNKNOWN_COUNTY,
    location: '',
    orgName: c.orgName,
    caseNo: c.caseNo,
    tenderName: c.tenderName,
    tenderWay: '',
    category: job.range.category ?? '',
    amount: c.amount,
    isCorrection: null,
    winner: c.status === 'resolved' ? (c.winner ?? '') : '',
    winnerId: c.winnerId ?? '',
    source: c.status === 'resolved' ? (c.source ?? '') : c.status === 'failed' ? `失敗：${c.message ?? ''}` : '未解出',
    url: c.url,
  }));
}

function groupBy<K>(cases: ExportCase[], keyOf: (c: ExportCase) => K[]): Map<K, { count: number; amount: number; multi: number }> {
  const m = new Map<K, { count: number; amount: number; multi: number }>();
  for (const c of cases) {
    const keys = keyOf(c);
    for (const k of keys) {
      const g = m.get(k) ?? { count: 0, amount: 0, multi: 0 };
      g.count++;
      g.amount += c.amount ?? 0;
      if (keys.length > 1) g.multi++;
      m.set(k, g);
    }
  }
  return m;
}

const AMOUNT_BANDS: { label: string; test: (n: number | null) => boolean }[] = [
  { label: '未公開／空白', test: n => n == null },
  { label: '未達 150 萬', test: n => n != null && n < 1_500_000 },
  { label: '150 萬～未達 1,000 萬', test: n => n != null && n >= 1_500_000 && n < 10_000_000 },
  { label: '1,000 萬～未達 5,000 萬', test: n => n != null && n >= 10_000_000 && n < 50_000_000 },
  { label: '5,000 萬以上', test: n => n != null && n >= 50_000_000 },
];

/** 不覆蓋既有檔案：同名就在後面加時間戳 */
async function pickPath(dir: string, fileName: string | undefined): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const safe = (fileName ? basename(fileName) : '').replace(/[\\/:*?"<>|]/g, '_').replace(/\.xlsx$/i, '').trim();
  const first = join(dir, `${safe || `awards_${stamp}`}.xlsx`);
  try {
    await stat(first);
  } catch {
    return first;
  }
  return join(dir, `${safe || 'awards'}_${stamp}_${String(Date.now() % 1000).padStart(3, '0')}.xlsx`);
}

export async function writeAwardsWorkbook(
  cases: ExportCase[],
  meta: { title: string; conditions: [string, string][]; hasVendor: boolean },
  opts: { outputDir?: string; fileName?: string } = {},
): Promise<ExcelExportResult> {
  let dir = DEFAULT_EXPORT_DIR;
  if (opts.outputDir) {
    if (!isAbsolute(opts.outputDir)) throw new Error(`outputDir 要給絕對路徑：${opts.outputDir}`);
    const s = await stat(opts.outputDir).catch(() => null);
    // 不自動建資料夾，避免路徑打錯時默默建出一個新目錄
    if (!s?.isDirectory()) throw new Error(`outputDir 不存在或不是資料夾：${opts.outputDir}`);
    dir = opts.outputDir;
  } else {
    await mkdir(dir, { recursive: true });
  }
  const path = await pickPath(dir, opts.fileName);

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const sheets: { name: string; rows: number }[] = [];
  const AMOUNT_FMT = '#,##0';
  const PCT_FMT = '0.0%';

  const addTable = (name: string, columns: { header: string; key: string; width: number; fmt?: string }[], rows: Record<string, unknown>[]) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width, style: c.fmt ? { numFmt: c.fmt } : {} }));
    for (const r of rows) ws.addRow(r);
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    sheets.push({ name, rows: rows.length });
    return ws;
  };

  const totalAmount = cases.reduce((t, c) => t + (c.amount ?? 0), 0);
  const splitWinners = (c: ExportCase) => c.winner ? c.winner.split(WINNER_SEP).map(s => s.trim()).filter(Boolean) : [];
  const resolvedCount = cases.filter(c => c.winner).length;

  // 說明
  const info = wb.addWorksheet('說明');
  info.columns = [{ width: 22 }, { width: 90 }];
  const infoRows: [string, string][] = [
    ['報表', meta.title],
    ['產出時間', new Date().toLocaleString('zh-TW', { hour12: false })],
    ...meta.conditions,
    ['案件數', cases.length.toLocaleString('en-US')],
    ['決標金額合計', `${totalAmount.toLocaleString('en-US')} 元`],
    ...(meta.hasVendor ? [['得標廠商涵蓋', `${resolvedCount} / ${cases.length} 件`] as [string, string]] : []),
    ['', ''],
    ['注意 1', '決標公告日不等於決標日（公告通常晚 1～20 天），區間右端最近的案子可能還沒公告，建議約 30 天後重查。'],
    ['注意 2', '履約地點是機關自填的粗欄位，不一定是實際施作地點；「其他」桶與中央機關的縣市由機關名稱推斷，推不出來列為「（未能判斷）」。'],
    ['注意 3', '更正公告顯示的是更正日，不是原決標公告日。'],
    ...(meta.hasVendor ? [
      ['注意 4', '複數決標（開口契約同時決標給多家）的得標廠商以「 / 」分隔；廠商排行中每家都計入該案完整決標金額，所以廠商排行的金額加總會大於案件金額合計。'] as [string, string],
      ['注意 5', '資料來源為「反查」「名錄反查」的案子只有廠商名稱（名錄反查另有統編），沒有投標家數、落標廠商等內頁欄位。'] as [string, string],
    ] : []),
  ];
  for (const r of infoRows) info.addRow(r);
  info.getColumn(1).font = { bold: true };
  info.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  sheets.push({ name: '說明', rows: infoRows.length });

  // 明細
  const detailCols = [
    { header: '決標公告日', key: 'date', width: 12 },
    { header: '縣市', key: 'county', width: 10 },
    { header: '履約地點', key: 'location', width: 18 },
    { header: '機關', key: 'org', width: 28 },
    { header: '案號', key: 'caseNo', width: 18 },
    { header: '標案名稱', key: 'name', width: 60 },
    { header: '標的分類', key: 'category', width: 10 },
    { header: '招標方式', key: 'way', width: 22 },
    { header: '決標金額', key: 'amount', width: 14, fmt: AMOUNT_FMT },
    { header: '更正公告', key: 'corr', width: 9 },
    ...(meta.hasVendor ? [
      { header: '得標廠商', key: 'winner', width: 36 },
      { header: '得標廠商統編', key: 'winnerId', width: 14 },
      { header: '得標家數', key: 'winnerCount', width: 9 },
      { header: '資料來源', key: 'source', width: 12 },
    ] : []),
    { header: '連結', key: 'url', width: 10 },
  ];
  const sorted = cases.slice().sort((a, b) => b.awardNoticeDate.localeCompare(a.awardNoticeDate) || (b.amount ?? 0) - (a.amount ?? 0));
  const detail = addTable('明細', detailCols, sorted.map(c => ({
    date: c.awardNoticeDate, county: c.county, location: c.location, org: c.orgName, caseNo: c.caseNo, name: c.tenderName,
    category: c.category, way: c.tenderWay, amount: c.amount, corr: c.isCorrection == null ? '' : c.isCorrection ? '是' : '',
    winner: c.winner, winnerId: c.winnerId, winnerCount: splitWinners(c).length || '', source: c.source,
    url: c.url ? { text: '公告', hyperlink: c.url } : '',
  })));
  // 案號、統編存成文字，Excel 才不會吃掉前導零或轉成科學記號
  for (const key of ['caseNo', 'winnerId']) {
    const col = detail.columns.find(c => c.key === key);
    if (col) col.numFmt = '@';
  }

  // 縣市統計
  const byCounty = [...groupBy(cases, c => [c.county])].sort((a, b) => b[1].amount - a[1].amount);
  addTable('縣市統計', [
    { header: '縣市', key: 'k', width: 14 },
    { header: '件數', key: 'count', width: 8 },
    { header: '決標金額合計', key: 'amount', width: 18, fmt: AMOUNT_FMT },
    { header: '金額占比', key: 'pct', width: 10, fmt: PCT_FMT },
  ], byCounty.map(([k, g]) => ({ k, count: g.count, amount: g.amount, pct: totalAmount ? g.amount / totalAmount : 0 })));

  // 機關排行
  const byOrg = [...groupBy(cases, c => [c.orgName])].sort((a, b) => b[1].amount - a[1].amount || b[1].count - a[1].count);
  addTable('機關排行', [
    { header: '排名', key: 'rank', width: 6 },
    { header: '機關', key: 'k', width: 32 },
    { header: '件數', key: 'count', width: 8 },
    { header: '決標金額合計', key: 'amount', width: 18, fmt: AMOUNT_FMT },
    { header: '平均每件', key: 'avg', width: 14, fmt: AMOUNT_FMT },
  ], byOrg.map(([k, g], i) => ({ rank: i + 1, k, count: g.count, amount: g.amount, avg: Math.round(g.amount / g.count) })));

  // 廠商排行
  let vendorTop: ExcelExportResult['vendorTop'] = [];
  if (meta.hasVendor) {
    const idOf = new Map<string, string>();
    for (const c of cases) {
      const names = splitWinners(c);
      const ids = c.winnerId ? c.winnerId.split(WINNER_SEP).map(s => s.trim()) : [];
      // 名稱與統編數量一致時才配對，避免張冠李戴
      if (names.length === ids.length) names.forEach((n, i) => { if (ids[i] && !idOf.has(n)) idOf.set(n, ids[i]); });
    }
    const byVendor = [...groupBy(cases.filter(c => c.winner), splitWinners)].sort((a, b) => b[1].amount - a[1].amount || b[1].count - a[1].count);
    addTable('廠商排行', [
      { header: '排名', key: 'rank', width: 6 },
      { header: '得標廠商', key: 'k', width: 36 },
      { header: '統編', key: 'id', width: 12 },
      { header: '得標件數', key: 'count', width: 9 },
      { header: '其中複數決標', key: 'multi', width: 12 },
      { header: '參與案件決標金額合計', key: 'amount', width: 20, fmt: AMOUNT_FMT },
    ], byVendor.map(([k, g], i) => ({ rank: i + 1, k, id: idOf.get(k) ?? '', count: g.count, multi: g.multi, amount: g.amount })));
    vendorTop = byVendor.slice(0, 10).map(([vendor, g]) => ({ vendor, count: g.count, amount: g.amount }));
  }

  // 金額級距
  addTable('金額級距', [
    { header: '決標金額級距', key: 'k', width: 24 },
    { header: '件數', key: 'count', width: 8 },
    { header: '件數占比', key: 'cpct', width: 10, fmt: PCT_FMT },
    { header: '決標金額合計', key: 'amount', width: 18, fmt: AMOUNT_FMT },
  ], AMOUNT_BANDS.map(b => {
    const hit = cases.filter(c => b.test(c.amount));
    return { k: b.label, count: hit.length, cpct: cases.length ? hit.length / cases.length : 0, amount: hit.reduce((t, c) => t + (c.amount ?? 0), 0) };
  }));

  await wb.xlsx.writeFile(path);

  return {
    path,
    sheets,
    caseCount: cases.length,
    totalAmount,
    countyTop: byCounty.slice(0, 10).map(([county, g]) => ({ county, count: g.count, amount: g.amount })),
    orgTop: byOrg.slice(0, 10).map(([org, g]) => ({ org, count: g.count, amount: g.amount })),
    vendorTop,
    vendorCoverage: meta.hasVendor ? { resolved: resolvedCount, total: cases.length } : null,
  };
}
