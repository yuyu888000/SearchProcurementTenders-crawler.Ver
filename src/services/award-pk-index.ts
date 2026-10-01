import { readFile, writeFile, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AwardRow } from '../types/award.js';
import { rocStringToNumber } from '../utils/date.js';

/**
 * pk → 決標公告日 的索引。
 *
 * 為什麼要有這支：g0v 鏡像是用「日期」出貨的（listbydate 一次一整天），
 * 但 get_award_detail 收到的只有一個 pk，pk 本身看不出日期，所以走不了鏡像那條快路。
 * 清單查詢（search_awards）每一列都同時有 pk 與決標公告日，順手記下來就補上了這一段。
 * 純屬加速用的快取：查不到就照原本的官方內頁流程走，不影響正確性。
 */

// build 後此檔在 build/services/，快取固定放專案根的 .cache/
// ⚠️ 不可依賴工作目錄：MCP 由 GUI 啟動時 CWD 是 C:\Windows\System32，寫入會被拒
export const AWARD_PK_INDEX_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'award-pk-dates.json');

/** 上限；超過就從最舊的丟（Map 的插入順序就是先後） */
const MAX_ENTRIES = 50_000;
const FLUSH_DELAY_MS = 2000;

let index: Map<string, number> | null = null;
/** 上次讀檔時的 mtime；別的行程寫新內容進來要能發現 */
let loadedMtimeMs = 0;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;
let tmpSeq = 0;

/**
 * Claude Desktop 與 Claude Code 會各開一個 MCP 行程，共用這一份索引檔。
 * 只在記憶體快取會讓「A 行程剛查過的清單、B 行程查內頁時卻讀不到日期」，
 * 於是靜默退回官方內頁去撞額度——這正是這份索引要避免的事。
 * 所以每次讀取都看一下檔案 mtime，變了就把磁碟內容併進來（本行程未寫檔的部分以磁碟為準）。
 */
async function load(file: string): Promise<Map<string, number>> {
  let mtimeMs = 0;
  try { mtimeMs = (await stat(file)).mtimeMs; } catch { /* 還沒有檔案 */ }

  if (index && mtimeMs === loadedMtimeMs) return index;

  let disk: Map<string, number>;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, number>;
    disk = new Map(Object.entries(parsed).filter(([, v]) => typeof v === 'number'));
  } catch {
    disk = new Map();
  }
  // 合併而非覆蓋：本行程剛記下、還沒 flush 的項目不能被磁碟版本洗掉
  if (index) for (const [k, v] of index) if (!disk.has(k)) disk.set(k, v);
  index = disk;
  loadedMtimeMs = mtimeMs;
  return index;
}

async function flush(file: string): Promise<void> {
  if (!dirty || !index) return;
  dirty = false;
  // 超量就砍掉最舊的一段
  if (index.size > MAX_ENTRIES) {
    const keep = [...index.entries()].slice(-MAX_ENTRIES);
    index = new Map(keep);
  }
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(Object.fromEntries(index)), 'utf8');
    await rename(tmp, file);
    try { loadedMtimeMs = (await stat(file)).mtimeMs; } catch { /* 取不到就下次重讀，無害 */ }
  } catch (e: any) {
    await unlink(tmp).catch(() => undefined);
    console.error(`[AwardPkIndex] 寫入失敗（不影響查詢結果）: ${e.message}`);
  }
}

/** 記下這批清單列的 pk → 決標公告日；寫檔延後合併，不擋查詢 */
export function rememberAwardDates(rows: AwardRow[], file = AWARD_PK_INDEX_FILE): void {
  void (async () => {
    const map = await load(file);
    for (const r of rows) {
      if (!r.pk) continue;
      const d = rocStringToNumber(r.awardNoticeDate);
      if (d == null) continue;
      if (map.get(r.pk) === d) continue;
      map.delete(r.pk); // 重設插入順序，常用的不會被當成最舊的丟掉
      map.set(r.pk, d);
      dirty = true;
    }
    if (dirty && !flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = null; void flush(file); }, FLUSH_DELAY_MS);
      flushTimer.unref?.();
    }
  })();
}

/** 查某個 pk 的決標公告日（民國 yyyMMdd）；沒記過回 null */
export async function lookupAwardDate(pk: string, file = AWARD_PK_INDEX_FILE): Promise<number | null> {
  const map = await load(file);
  return map.get(pk) ?? null;
}
