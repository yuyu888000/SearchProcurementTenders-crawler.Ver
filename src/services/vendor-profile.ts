import { readFile } from 'node:fs/promises';
import { AwardCategory, AwardRow, AwardDetailRecord } from '../types/award.js';
import { queryAwardsByVendor, awardDedupKey, MAX_RANGE_DAYS } from './award-service.js';
import { AWARD_DETAIL_CACHE_FILE } from './award-detail-crawler.js';
import { countyFromOrgName } from './award-locations.js';

/**
 * 廠商側寫：一段期間內得標／投標未得標的案子彙整成件數、金額、得標率、往來機關、縣市、分類、月份趨勢；
 * 競標對手只能從內頁的投標廠商名單看出來，所以只用「已經抓過的內頁快取」，不另外開內頁（受流量控制）。
 * 期間超過官網單次上限 186 天時自動切段查詢再合併去重。
 */

export interface ProfileInput {
  vendor: string;
  from: number;
  to: number;
  category?: AwardCategory;
  includeBids: boolean;
  maxRowsPerSegment: number;
}

export interface CountRow { key: string; won: number; wonAmount: number; lost: number }
export interface Competitor { name: string; vendorId: string; meetings: number; theyWon: number; weWon: number }

export interface VendorProfile {
  vendor: string;
  byId: boolean;
  segments: { from: number; to: number; won: number; lost: number; error?: string }[];
  won: AwardRow[];
  lost: AwardRow[];
  wonAmount: number;
  wonAmountUnknown: number;
  largest: AwardRow | null;
  winRate: number | null;
  orgs: CountRow[];
  counties: CountRow[];
  categories: CountRow[];
  months: CountRow[];
  competitors: Competitor[];
  detailCoverage: { cached: number; total: number };
  /** 快取件數太少，對手分析不具代表性 */
  competitorInsufficient: boolean;
  requests: number;
  truncated: boolean;
  /** 查詢途中被擋，後面的區段沒查 */
  blocked: boolean;
  errors: string[];
}

const MIN_CACHED_FOR_COMPETITORS = 5;

function rocAddDays(n: number, days: number): number {
  const dt = new Date(Date.UTC(Math.floor(n / 10000) + 1911, Math.floor((n % 10000) / 100) - 1, n % 100 + days));
  return (dt.getUTCFullYear() - 1911) * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
}

/** 把 [from, to] 切成每段相差不超過 MAX_RANGE_DAYS 天的區段 */
export function splitRange(from: number, to: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let start = from;
  while (start <= to) {
    const end = Math.min(rocAddDays(start, MAX_RANGE_DAYS), to);
    out.push({ from: start, to: end });
    start = rocAddDays(end, 1);
  }
  return out;
}

function tally(rows: AwardRow[], lost: AwardRow[], keyOf: (r: AwardRow) => string): CountRow[] {
  const m = new Map<string, CountRow>();
  const get = (k: string) => { const r = m.get(k) ?? { key: k, won: 0, wonAmount: 0, lost: 0 }; m.set(k, r); return r; };
  for (const r of rows) { const g = get(keyOf(r)); g.won++; g.wonAmount += r.amount ?? 0; }
  for (const r of lost) get(keyOf(r)).lost++;
  return [...m.values()];
}

const normName = (s: string) => s.replace(/\s+/g, '').replace(/台/g, '臺');

export async function buildVendorProfile(input: ProfileInput, opts: { cacheFile?: string } = {}): Promise<VendorProfile> {
  const vendor = input.vendor.trim();
  const segments: VendorProfile['segments'] = [];
  const wonMap = new Map<string, AwardRow>();
  const lostMap = new Map<string, AwardRow>();
  const errors: string[] = [];
  let byId = /^\d{8}$/.test(vendor);
  let requests = 0, truncated = false, blocked = false;

  for (const seg of splitRange(input.from, input.to)) {
    const r = await queryAwardsByVendor(
      { from: seg.from, to: seg.to, category: input.category, status: '決標' },
      vendor,
      { maxRows: input.maxRowsPerSegment, includeBids: input.includeBids },
    );
    byId = r.byId;
    requests += r.requests;
    truncated ||= r.truncated;
    for (const row of r.won) wonMap.set(awardDedupKey(row), row);
    for (const row of r.lost) lostMap.set(awardDedupKey(row), row);
    segments.push({ ...seg, won: r.won.length, lost: r.lost.length, error: r.error });
    if (r.error) errors.push(`${seg.from}~${seg.to}：${r.error}`);
    if (r.blocked) { blocked = true; break; }
  }
  // 更正公告可能跨段出現：某段算得標、另一段因為沒查到得標而被算成未得標
  for (const k of wonMap.keys()) lostMap.delete(k);

  const won = [...wonMap.values()].sort((a, b) => b.awardNoticeDate.localeCompare(a.awardNoticeDate));
  const lost = [...lostMap.values()].sort((a, b) => b.awardNoticeDate.localeCompare(a.awardNoticeDate));
  const wonAmount = won.reduce((t, r) => t + (r.amount ?? 0), 0);
  const largest = won.filter(r => r.amount != null).sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))[0] ?? null;

  const byAmount = (a: CountRow, b: CountRow) => b.wonAmount - a.wonAmount || b.won - a.won || b.lost - a.lost;
  const orgs = tally(won, lost, r => r.orgName).sort(byAmount);
  const counties = tally(won, lost, r => countyFromOrgName(r.orgName) ?? '（未能判斷）').sort(byAmount);
  const categories = tally(won, lost, r => r.category || '（空白）').sort(byAmount);
  const months = tally(won, lost, r => r.awardNoticeDate.slice(0, 6)).sort((a, b) => a.key.localeCompare(b.key));

  // 競標對手：只讀內頁快取
  let store: Record<string, { record?: AwardDetailRecord }> = {};
  try {
    store = JSON.parse(await readFile(opts.cacheFile ?? AWARD_DETAIL_CACHE_FILE, 'utf8'));
  } catch {
    store = {};
  }
  // 名稱模式與清單一樣是部分比對：先找完全同名，沒有才找名稱包含查詢字的
  const findSelf = <T extends { vendorId: string; name: string }>(bidders: T[]): T | undefined => byId
    ? bidders.find(b => b.vendorId === vendor)
    : bidders.find(b => normName(b.name) === normName(vendor)) ?? bidders.find(b => normName(b.name).includes(normName(vendor)));
  const comp = new Map<string, Competitor>();
  const all = [...won, ...lost];
  let cached = 0;
  for (const row of all) {
    const rec = store[`award:${row.pk}`]?.record;
    if (!rec || rec.pageType !== 'award' || !Array.isArray(rec.bidders)) continue;
    const self = findSelf(rec.bidders);
    // 名稱模式下部分比對可能把別家的案子帶進來；內頁名單裡找不到本人就不列入
    if (!self) continue;
    cached++;
    const weWon = /是/.test(self.won);
    for (const b of rec.bidders) {
      if (b === self || !b.name) continue;
      const key = b.vendorId || normName(b.name);
      const c = comp.get(key) ?? { name: b.name, vendorId: b.vendorId, meetings: 0, theyWon: 0, weWon: 0 };
      c.meetings++;
      if (/是/.test(b.won)) c.theyWon++;
      if (weWon) c.weWon++;
      comp.set(key, c);
    }
  }

  return {
    vendor,
    byId,
    segments,
    won,
    lost,
    wonAmount,
    wonAmountUnknown: won.filter(r => r.amount == null).length,
    largest,
    winRate: input.includeBids && won.length + lost.length > 0 ? won.length / (won.length + lost.length) : null,
    orgs,
    counties,
    categories,
    months,
    competitors: [...comp.values()].sort((a, b) => b.meetings - a.meetings || b.theyWon - a.theyWon),
    detailCoverage: { cached, total: all.length },
    competitorInsufficient: cached < MIN_CACHED_FOR_COMPETITORS,
    requests,
    truncated,
    blocked,
    errors,
  };
}
