import axios from 'axios';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 反查用的廠商名錄：經濟部商工登記（公司）＋建築師開業名冊（事務所）。
 *
 * 種子廠商反查只解得出「以前看過的廠商」得標的案子；名錄讓沒看過的廠商也能用
 * 完整名稱去清單端點反查。實測 558 件：種子反查解 334 件後，只掃中彰投雲在地 1,605 家
 * 就再解 110 件；外縣市 5,584 家估計只多 20～40 件卻要多 3 小時，所以預設在地優先。
 * 技師事務所沒有開放名錄，只能靠內頁。
 */

export interface DirectoryEntry {
  name: string;
  /** 統一編號；建築師事務所沒有 */
  id: string;
  /** 登記地址或所在地，用來判斷是否在地 */
  loc: string;
  src: string;
}

export interface DirectoryLoadResult {
  entries: DirectoryEntry[];
  fetchedAt: string;
  fromCache: boolean;
  errors: string[];
}

/** 已解出的工程技術服務得標廠商型態：工程顧問、技術顧問、景觀、設計、環境、測量類公司 */
export const DIRECTORY_KEYWORDS = ['工程顧問', '技術顧問', '景觀', '工程設計', '環境工程', '測量'];

const GCIS_API = 'https://data.gcis.nat.gov.tw/od/data/api/6BBA2268-1367-4B42-9CCA-BC17499EBE8C';
// 官方主機 data.moi.gov.tw 常逾時，用 data.gov.tw 的品質檢測鏡像（dataset 9517，每日更新）
const ARCHITECT_URL = 'https://quality.data.gov.tw/dq_download_json.php?nid=9517&md5_url=f951e04a4a3a8a7ee605f23a1402344e';
const PAGE_SIZE = 500;
const PAGE_GAP_MS = 700;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 呼叫時才讀環境變數：測試在 import 之後才設定暫存路徑
function cacheFile(): string {
  return process.env.VENDOR_DIRECTORY_FILE
    ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'vendor-directory.json');
}

async function fetchCompanies(keyword: string): Promise<DirectoryEntry[]> {
  const out: DirectoryEntry[] = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    // ⚠️ 少了「and Company_Status eq 01」API 會回空字串而不是錯誤
    const url = `${GCIS_API}?$format=json&$filter=Company_Name like ${encodeURIComponent(keyword)} and Company_Status eq 01&$skip=${skip}&$top=${PAGE_SIZE}`;
    const r = await axios.get(url, { timeout: 60_000, validateStatus: () => true });
    if (r.status !== 200) throw new Error(`商工登記「${keyword}」HTTP ${r.status}`);
    const rows = Array.isArray(r.data) ? r.data : [];
    for (const x of rows) {
      const name = String(x?.Company_Name ?? '').trim();
      if (name) out.push({ name, id: String(x?.Business_Accounting_NO ?? ''), loc: String(x?.Company_Location ?? ''), src: `商工登記:${keyword}` });
    }
    if (rows.length < PAGE_SIZE) return out;
    await sleep(PAGE_GAP_MS);
  }
}

async function fetchArchitects(): Promise<DirectoryEntry[]> {
  const r = await axios.get(ARCHITECT_URL, { timeout: 90_000, validateStatus: () => true });
  if (r.status !== 200) throw new Error(`建築師名冊 HTTP ${r.status}`);
  const rows = Array.isArray(r.data) ? r.data : [];
  return rows
    .map((x: any) => ({ name: String(x?.['事務所名稱'] ?? '').replace(/\s+/g, ''), id: '', loc: String(x?.['事務所所在地'] ?? ''), src: '建築師名冊' }))
    .filter((e: DirectoryEntry) => e.name);
}

async function readCache(): Promise<{ fetchedAt: string; entries: DirectoryEntry[] } | null> {
  try {
    const c = JSON.parse(await readFile(cacheFile(), 'utf8'));
    return Array.isArray(c?.entries) ? c : null;
  } catch {
    return null;
  }
}

/** 取名錄：7 天內的快取直接用；過期就重抓，重抓全失敗時退回舊快取 */
export async function loadVendorDirectory(): Promise<DirectoryLoadResult> {
  const cached = await readCache();
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < MAX_AGE_MS) {
    return { entries: cached.entries, fetchedAt: cached.fetchedAt, fromCache: true, errors: [] };
  }

  const byName = new Map<string, DirectoryEntry>();
  const errors: string[] = [];
  for (const kw of DIRECTORY_KEYWORDS) {
    try {
      for (const e of await fetchCompanies(kw)) if (!byName.has(e.name)) byName.set(e.name, e);
    } catch (e: any) {
      errors.push(e.message);
    }
    await sleep(PAGE_GAP_MS);
  }
  try {
    for (const e of await fetchArchitects()) if (!byName.has(e.name)) byName.set(e.name, e);
  } catch (e: any) {
    errors.push(e.message);
  }

  if (byName.size === 0) {
    if (cached) return { entries: cached.entries, fetchedAt: cached.fetchedAt, fromCache: true, errors };
    return { entries: [], fetchedAt: new Date().toISOString(), fromCache: false, errors };
  }

  const result = { fetchedAt: new Date().toISOString(), entries: [...byName.values()] };
  await mkdir(dirname(cacheFile()), { recursive: true });
  await writeFile(cacheFile(), JSON.stringify(result), 'utf8');
  return { ...result, fromCache: false, errors };
}

/** 縣市名取前兩字比對地址（「臺中市」→「臺中」，也吃得到舊制「臺中縣」與「台中」寫法） */
export function orderByLocality(entries: DirectoryEntry[], counties: string[]): { local: DirectoryEntry[]; rest: DirectoryEntry[] } {
  const heads = [...new Set(counties.map(c => c.replace(/台/g, '臺').slice(0, 2)).filter(Boolean))];
  const local: DirectoryEntry[] = [];
  const rest: DirectoryEntry[] = [];
  for (const e of entries) {
    const loc = e.loc.replace(/台/g, '臺');
    (heads.some(h => loc.includes(h)) ? local : rest).push(e);
  }
  return { local, rest };
}
