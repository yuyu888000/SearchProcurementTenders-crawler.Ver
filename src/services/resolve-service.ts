import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AwardCategory, AwardRow } from '../types/award.js';
import { queryAwards, awardDedupKey } from './award-service.js';
import { fetchAwardDetails, AWARD_DETAIL_CACHE_FILE } from './award-detail-crawler.js';
import { loadVendorDirectory, orderByLocality } from './vendor-directory.js';
import { countyFromOrgName } from './award-locations.js';

/**
 * 批次補得標廠商。
 *
 * 為什麼要有這支：清單端點查不到得標廠商，內頁才有，但內頁受驗證碼流量控制
 * （任意 10 分鐘最多 5 次請求），341 件純靠內頁要十幾個小時。
 * 實務上大部分案子可以用「免費」的清單端點解掉——同一家廠商常重複得標，
 * 拿已知廠商名去 gottenVendorName 反查，一次查詢就能一次解掉好幾案。
 *
 * 所以這支的策略是：
 *   1) 反查（免費、不受流量控制）：用已知廠商名／統編反查，能解幾件算幾件
 *   2) 名錄反查（免費但量大）：拿商工登記＋建築師名冊的公司全名逐一反查，在地廠商優先
 *   3) 內頁（受限）：剩下的依決標金額由大到小逐案開，抓到新廠商名就丟回第 1 步
 * 跑很久，所以做成背景工作＋狀態落檔，可續跑、可查進度。
 */

// build 後此檔在 build/services/，狀態固定放專案根的 .cache/resolve-jobs/
// ⚠️ 不可用 process.cwd()：MCP 由 GUI 啟動時 CWD 是 C:\Windows\System32
const JOB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'resolve-jobs');

/** 反查查詢之間的節流（清單端點沒有驗證碼限制，但不把公家端點打滿） */
const LOOKUP_GAP_MS = 1800;
/** 內頁被額度擋住時，等多久再看一次 */
const WINDOW_WAIT_MS = 60_000;
/** 內頁被驗證碼擋住時的冷卻 */
const BLOCK_WAIT_MS = 10 * 60_000;

export type ResolveSource = '內頁完整' | '反查' | '名錄反查' | '快取';
export type DirectoryMode = 'off' | 'local' | 'all';

export interface ResolveCase {
  pk: string;
  url: string;
  caseNo: string;
  orgName: string;
  tenderName: string;
  amount: number | null;
  awardNoticeDate: string;
  status: 'unknown' | 'resolved' | 'failed';
  winner?: string;
  winnerId?: string | null;
  bidderCount?: number | null;
  losers?: string[];
  budget?: number | null;
  totalAward?: number | null;
  source?: ResolveSource;
  message?: string;
}

export interface ResolveJob {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  /** 反查時要套用的查詢範圍（與案件清單同一個區間，範圍越窄反查越準） */
  range: { from: number; to: number; category?: AwardCategory };
  state: 'running' | 'paused' | 'done' | 'error';
  message: string;
  cases: ResolveCase[];
  /** 待反查的廠商名／統編 */
  vendorQueue: string[];
  /** 已反查過的，不重複查 */
  triedVendors: string[];
  stats: { total: number; resolved: number; failed: number; lookups: number; detailFetches: number; solvedByLookup: number; solvedByDetail: number; solvedByDirectory?: number };
  /** 名錄反查；舊版工作檔沒有這欄，視同 off */
  directory?: {
    mode: DirectoryMode;
    /** 判斷在地用的縣市 */
    counties: string[];
    built: boolean;
    /** 待反查的名錄廠商（已排好在地優先） */
    queue: { name: string; id: string }[];
    total: number;
    tried: number;
  };
  /** rank_by_topic 的排名：內頁依 A→B→C 抓；舊版工作檔沒有這欄，照金額排 */
  priority?: JobPriority;
}

export interface JobPriority {
  rankId: string;
  topic: string;
  /** true＝C 組不開內頁（免費反查照做） */
  skipGroupC: boolean;
  ranks: Record<string, { group: 'A' | 'B' | 'C'; score: number }>;
}

const GROUP_ORDER = { A: 0, B: 1, C: 2 } as const;
/** 沒在排名裡的案子排在 B 與 C 之間：不知道相關性，不該被當成低分略過 */
const UNRANKED = 1.5;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function jobPath(id: string): string {
  return join(JOB_DIR, `${id}.json`);
}

/** 原子寫入，避免半寫狀態 */
async function saveJob(job: ResolveJob): Promise<void> {
  job.updatedAt = nowIso();
  await mkdir(JOB_DIR, { recursive: true });
  const tmp = `${jobPath(job.id)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(job, null, 1), 'utf8');
  try {
    await rename(tmp, jobPath(job.id));
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export async function loadJob(id: string): Promise<ResolveJob | null> {
  try {
    return JSON.parse(await readFile(jobPath(id), 'utf8')) as ResolveJob;
  } catch {
    return null;
  }
}

export async function listJobs(): Promise<ResolveJob[]> {
  try {
    const files = (await readdir(JOB_DIR)).filter(f => f.endsWith('.json'));
    const jobs = await Promise.all(files.map(f => loadJob(f.replace(/\.json$/, ''))));
    return jobs.filter((j): j is ResolveJob => Boolean(j)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function makeJobId(seed: string): string {
  // 不用亂數：同一批案子重跑會得到同一個 id，避免堆出一堆孤兒工作
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `job_${h.toString(36)}`;
}

/** 從既有的內頁快取撈出已知廠商名與統編，當作反查的種子 */
export async function seedVendorsFromCache(cacheFile = AWARD_DETAIL_CACHE_FILE): Promise<string[]> {
  try {
    const store = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, any>;
    const out = new Set<string>();
    for (const v of Object.values(store)) {
      const rec = v?.record;
      if (!rec || rec.pageType !== 'award') continue;
      for (const b of rec.bidders ?? []) {
        if (b?.name) out.add(String(b.name));
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

export interface CreateJobInput {
  label: string;
  range: { from: number; to: number; category?: AwardCategory };
  rows: AwardRow[];
  seedVendors?: string[];
  /** 預設 off（呼叫端要明確開啟，名錄動輒數千家） */
  directory?: DirectoryMode;
  /** 名錄在地優先用；不給就從機關名稱推 */
  counties?: string[];
}

export async function createJob(input: CreateJobInput): Promise<ResolveJob> {
  const cases: ResolveCase[] = input.rows.map(r => ({
    pk: r.pk,
    url: r.url,
    caseNo: r.caseNo,
    orgName: r.orgName,
    tenderName: r.tenderName,
    amount: r.amount,
    awardNoticeDate: r.awardNoticeDate,
    status: 'unknown',
  }));
  const id = makeJobId(`${input.range.from}-${input.range.to}-${input.range.category ?? ''}-${cases.map(c => c.pk).join(',')}`);
  const existing = await loadJob(id);
  if (existing) return existing;

  const job: ResolveJob = {
    id,
    label: input.label,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    range: input.range,
    state: 'paused',
    message: '尚未開始',
    cases,
    vendorQueue: [...new Set(input.seedVendors ?? [])],
    triedVendors: [],
    stats: { total: cases.length, resolved: 0, failed: 0, lookups: 0, detailFetches: 0, solvedByLookup: 0, solvedByDetail: 0, solvedByDirectory: 0 },
    directory: {
      mode: input.directory ?? 'off',
      counties: input.counties?.length ? input.counties : inferCounties(cases),
      built: false,
      queue: [],
      total: 0,
      tried: 0,
    },
  };
  await saveJob(job);
  return job;
}

const norm = (s: string) => String(s || '').replace(/\s+/g, '').replace(/\(更正公告\)|（更正公告）/g, '').trim();
const caseKey = (orgName: string, caseNo: string) => `${norm(orgName)}||${norm(caseNo)}`;

function recount(job: ResolveJob): void {
  job.stats.resolved = job.cases.filter(c => c.status === 'resolved').length;
  job.stats.failed = job.cases.filter(c => c.status === 'failed').length;
}

/**
 * 把反查命中的廠商併進既有得標廠商（「A / B」格式，與官網複數決標一致）。
 * gottenVendorName 是部分比對：查「大有工程顧問有限公司」也會命中「新大有工程顧問有限公司」的案子，
 * 所以名稱若是另一個名稱的子字串就丟掉短的。
 */
function mergeWinners(current: string | undefined, vendor: string): string {
  const names = [...new Set([...(current ? current.split(' / ') : []), vendor].map(s => s.trim()).filter(Boolean))];
  return names.filter(n => !names.some(m => m !== n && m.includes(n))).join(' / ');
}

/** 從機關名稱推縣市（「臺中市政府水利局」→臺中市）；中央機關推不出來就略過 */
function inferCounties(cases: ResolveCase[]): string[] {
  const found = new Set<string>();
  for (const c of cases) {
    const county = countyFromOrgName(c.orgName);
    if (county) found.add(county);
  }
  return [...found];
}

/**
 * 一次反查：用一個廠商名／統編查同區間的決標案，命中就標記。回傳新解出的件數。
 * knownId：名錄帶來的統編，命中時一併記下。
 */
async function lookupVendor(job: ResolveJob, vendor: string, opts: { source?: ResolveSource; knownId?: string } = {}): Promise<number> {
  const source = opts.source ?? '反查';
  const byId = /^\d{8}$/.test(vendor);
  const q = byId
    ? { from: job.range.from, to: job.range.to, category: job.range.category, gottenVendorId: vendor }
    : { from: job.range.from, to: job.range.to, category: job.range.category, gottenVendorName: vendor };
  const r = await queryAwards(q, { maxRows: 300 });
  job.stats.lookups += r.requests;
  if (r.blocked) throw new Error('清單端點被擋');
  if (r.error) return 0;

  // 已由反查解出的也要納入：複數決標案的每家得標廠商會各自命中同一案，只留第一家會漏
  const open = job.cases.filter(c => c.status === 'unknown' || (c.status === 'resolved' && (c.source === '反查' || c.source === '名錄反查')));
  const id = byId ? vendor : (opts.knownId || null);
  const byKey = new Map(open.map(c => [caseKey(c.orgName, c.caseNo), c]));
  const byPk = new Map(open.map(c => [c.pk, c]));
  let hit = 0;
  for (const row of r.rows) {
    const c = byPk.get(row.pk) ?? byKey.get(caseKey(row.orgName, row.caseNo));
    if (!c) continue;
    if (c.status === 'unknown') {
      c.status = 'resolved';
      c.winner = vendor;
      c.winnerId = id;
      c.source = source;
      hit++;
      continue;
    }
    c.winner = mergeWinners(c.winner, vendor);
    // 先前的得標廠商沒有統編時不補，免得統編與名稱對不上
    if (id && c.winnerId) c.winnerId = mergeWinners(c.winnerId, id);
  }
  return hit;
}

/** 一次內頁：解一件，順便把新廠商名丟回反查佇列 */
async function fetchOneDetail(job: ResolveJob, target: ResolveCase): Promise<'ok' | 'limit' | 'blocked' | 'failed'> {
  const batch = await fetchAwardDetails([target.url || target.pk]);
  job.stats.detailFetches += batch.fetched;
  const r = batch.results[0];
  if (!r) return 'failed';

  if (r.ok && r.record && r.record.pageType === 'award') {
    const rec = r.record;
    const winners = rec.winners.map(b => b.name).filter(Boolean);
    target.status = 'resolved';
    target.winner = winners.join(' / ');
    target.winnerId = rec.winners.map(b => b.vendorId).filter(Boolean).join(' / ') || null;
    target.bidderCount = rec.bidderCount;
    target.losers = rec.losers.map(b => b.name).filter(Boolean);
    target.budget = rec.budget;
    target.totalAward = rec.totalAward;
    target.source = r.cached ? '快取' : '內頁完整';
    if (!r.cached) job.stats.solvedByDetail++;
    for (const b of rec.bidders) {
      if (b.name && !job.triedVendors.includes(b.name) && !job.vendorQueue.includes(b.name)) job.vendorQueue.push(b.name);
    }
    return 'ok';
  }
  if (r.ok && r.record) { // 無法決標公告：沒有得標廠商，標為已處理
    target.status = 'resolved';
    target.winner = '（無法決標）';
    target.source = r.cached ? '快取' : '內頁完整';
    return 'ok';
  }
  if (r.failure === 'limit') return 'limit';
  if (r.failure === 'cooldown' || r.failure === 'blocked') return 'blocked';
  target.status = 'failed';
  target.message = r.message;
  return 'failed';
}

/** 背景工作：反查與內頁交替，直到全解完或被叫停 */
export async function runJob(id: string, opts: { maxMinutes?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.maxMinutes ?? 720) * 60_000;
  for (;;) {
    const job = await loadJob(id);
    if (!job || job.state === 'paused' || job.state === 'done') return;
    if (Date.now() > deadline) {
      job.state = 'paused';
      job.message = '達到本次執行時間上限，可再次啟動續跑';
      await saveJob(job);
      return;
    }

    // 1. 先把免費的反查做完
    const vendor = job.vendorQueue.shift();
    if (vendor) {
      job.triedVendors.push(vendor);
      try {
        const hit = await lookupVendor(job, vendor);
        job.stats.solvedByLookup += hit;
        recount(job);
        job.message = `反查「${vendor}」命中 ${hit} 件｜已解 ${job.stats.resolved}/${job.stats.total}`;
        await saveJob(job);
      } catch (e: any) {
        job.vendorQueue.unshift(vendor);
        job.triedVendors.pop();
        job.message = `反查暫停：${e.message}，${Math.round(BLOCK_WAIT_MS / 60000)} 分鐘後再試`;
        await saveJob(job);
        await sleep(BLOCK_WAIT_MS);
        continue;
      }
      await sleep(LOOKUP_GAP_MS);
      continue;
    }

    // 2. 名錄反查：同樣免費，但一家一次查詢、動輒數千家，所以排在種子反查之後、內頁之前
    const dir = job.directory;
    if (dir && dir.mode !== 'off' && job.cases.some(c => c.status === 'unknown')) {
      if (!dir.built) {
        const loaded = await loadVendorDirectory();
        const tried = new Set(job.triedVendors);
        const { local, rest } = orderByLocality(loaded.entries.filter(e => !tried.has(e.name)), dir.counties);
        // 推不出縣市時沒辦法分在地，只能全掃
        const picked = dir.mode === 'local' && dir.counties.length ? local : [...local, ...rest];
        dir.queue = picked.map(e => ({ name: e.name, id: e.id }));
        dir.total = dir.queue.length;
        dir.built = true;
        job.message = `名錄 ${loaded.entries.length} 家${loaded.fromCache ? '（快取）' : ''}，本工作反查 ${dir.total} 家`
          + `（${dir.mode === 'local' && dir.counties.length ? '只掃在地：' + dir.counties.join('、') : '全部'}）`
          + (loaded.errors.length ? `｜名錄部分失敗：${loaded.errors.join('；')}` : '');
        await saveJob(job);
        continue;
      }
      const next = dir.queue.shift();
      if (next) {
        job.triedVendors.push(next.name);
        dir.tried++;
        try {
          const hit = await lookupVendor(job, next.name, { source: '名錄反查', knownId: next.id });
          job.stats.solvedByDirectory = (job.stats.solvedByDirectory ?? 0) + hit;
          recount(job);
          job.message = `名錄反查 ${dir.tried}/${dir.total}「${next.name}」命中 ${hit} 件｜已解 ${job.stats.resolved}/${job.stats.total}`;
          await saveJob(job);
        } catch (e: any) {
          dir.queue.unshift(next);
          dir.tried--;
          job.triedVendors.pop();
          job.message = `名錄反查暫停：${e.message}，${Math.round(BLOCK_WAIT_MS / 60000)} 分鐘後再試`;
          await saveJob(job);
          await sleep(BLOCK_WAIT_MS);
          continue;
        }
        await sleep(LOOKUP_GAP_MS);
        continue;
      }
    }

    // 3. 反查做完了，剩下的走內頁：有排名就 A→B→C（組內分數高、金額大的先），沒有就金額大的先
    const { pending, skipped } = detailQueue(job);
    if (pending.length === 0) {
      recount(job);
      job.state = 'done';
      job.message = `完成：已解 ${job.stats.resolved}/${job.stats.total}${job.stats.failed ? `，失敗 ${job.stats.failed}` : ''}`
        + (skipped ? `｜C 組 ${skipped} 件依 skipGroupC 設定未開內頁（仍未解）` : '');
      await saveJob(job);
      return;
    }

    const outcome = await fetchOneDetail(job, pending[0]);
    recount(job);
    if (outcome === 'limit') {
      job.message = `內頁額度用完，等 ${Math.round(WINDOW_WAIT_MS / 1000)} 秒｜已解 ${job.stats.resolved}/${job.stats.total}，剩 ${pending.length}`;
      await saveJob(job);
      await sleep(WINDOW_WAIT_MS);
      continue;
    }
    if (outcome === 'blocked') {
      job.message = `內頁被流量控制擋住，冷卻 ${Math.round(BLOCK_WAIT_MS / 60000)} 分鐘｜已解 ${job.stats.resolved}/${job.stats.total}`;
      await saveJob(job);
      await sleep(BLOCK_WAIT_MS);
      continue;
    }
    job.message = `內頁 ${pending[0].caseNo}：${outcome === 'ok' ? pending[0].winner : '失敗'}｜已解 ${job.stats.resolved}/${job.stats.total}`;
    await saveJob(job);
  }
}

/** 內頁待抓佇列；skipGroupC 時 C 組不進佇列 */
export function detailQueue(job: ResolveJob): { pending: ResolveCase[]; skipped: number } {
  const p = job.priority;
  const order = (c: ResolveCase) => {
    const r = p?.ranks[c.pk];
    return r ? GROUP_ORDER[r.group] : UNRANKED;
  };
  const unknown = job.cases.filter(c => c.status === 'unknown');
  const pending = unknown
    .filter(c => !(p?.skipGroupC && p.ranks[c.pk]?.group === 'C'))
    .sort((a, b) => !p
      ? (b.amount ?? 0) - (a.amount ?? 0)
      : order(a) - order(b) || (p.ranks[b.pk]?.score ?? -1) - (p.ranks[a.pk]?.score ?? -1) || (b.amount ?? 0) - (a.amount ?? 0));
  return { pending, skipped: unknown.length - pending.length };
}

/** 掛上或更新排名（可對既有工作加掛，下一次抓內頁起生效） */
export async function setJobPriority(id: string, priority: JobPriority | undefined): Promise<ResolveJob | null> {
  const job = await loadJob(id);
  if (!job) return null;
  job.priority = priority;
  await saveJob(job);
  return job;
}

export async function setJobState(id: string, state: 'running' | 'paused'): Promise<ResolveJob | null> {
  const job = await loadJob(id);
  if (!job) return null;
  if (job.state === 'done') return job;
  job.state = state;
  job.message = state === 'running' ? '啟動中' : '已暫停（可再啟動續跑）';
  await saveJob(job);
  return job;
}

export function jobSummary(job: ResolveJob): string {
  const s = job.stats;
  const pct = s.total ? Math.round((s.resolved / s.total) * 100) : 0;
  const unknown = job.cases.filter(c => c.status === 'unknown');
  const amt = (rows: ResolveCase[]) => rows.reduce((t, c) => t + (c.amount ?? 0), 0);
  const totalAmt = amt(job.cases), gotAmt = amt(job.cases.filter(c => c.status === 'resolved'));
  const fmt = (n: number) => n.toLocaleString('en-US');
  return [
    `- 狀態：${job.state === 'running' ? '執行中' : job.state === 'done' ? '已完成' : job.state === 'paused' ? '已暫停' : '錯誤'}｜${job.message}`,
    `- 進度：${fmt(s.resolved)} / ${fmt(s.total)} 件（${pct}%）｜金額涵蓋 ${fmt(gotAmt)} / ${fmt(totalAmt)} 元`,
    `- 來源：反查解出 ${fmt(s.solvedByLookup)} 件（免費）｜名錄反查解出 ${fmt(s.solvedByDirectory ?? 0)} 件（免費）｜內頁解出 ${fmt(s.solvedByDetail)} 件（受流量控制）｜失敗 ${fmt(s.failed)} 件`,
    `- 連線：清單端點 ${fmt(s.lookups)} 次｜內頁 ${fmt(s.detailFetches)} 次`,
    `- 待解 ${fmt(unknown.length)} 件；反查佇列尚有 ${fmt(job.vendorQueue.length)} 家廠商`
      + (job.directory && job.directory.mode !== 'off'
        ? `；名錄 ${job.directory.built ? `${fmt(job.directory.tried)}/${fmt(job.directory.total)} 家` : '尚未載入'}`
        : ''),
    ...(job.priority ? [(() => {
      const g = { A: 0, B: 0, C: 0, none: 0 };
      for (const c of unknown) { const r = job.priority!.ranks[c.pk]; if (r) g[r.group]++; else g.none++; }
      return `- 內頁順序：依排名 \`${job.priority.rankId}\`（${job.priority.topic}）A→B→C｜待解 A ${fmt(g.A)}／B ${fmt(g.B)}／C ${fmt(g.C)}${g.none ? `／不在排名 ${fmt(g.none)}（排在 B 之後）` : ''}${job.priority.skipGroupC ? '｜C 組不開內頁' : ''}`;
    })()] : []),
    `- 更新時間 ${job.updatedAt}`,
  ].join('\n');
}
