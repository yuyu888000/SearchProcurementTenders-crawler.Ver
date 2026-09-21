import { BulletionCrawlerService } from './bulletion-crawler.js';
import { ArchiveTender, DateFilter, TenderStatusType } from '../types/tender.js';
import { parseROCDate, getRemainingDays, rocStringToNumber } from '../utils/date.js';

/** 官網 timeRange 選項下限（民國 88 年） */
export const MIN_ROC_YEAR = 88;
/** 一次呼叫最多查幾個年度，避免關鍵字太寬時打太多次 */
export const MAX_YEARS_PER_CALL = 3;

export function currentROCYear(): number {
  return new Date().getFullYear() - 1911;
}

/**
 * 解析年度輸入：「115」「114,115」「113-115」皆可，未給則用當年。
 * 超出 88~今年 的年度直接剔除，回傳由新到舊排序。
 */
export function parseYears(input?: string): { years: number[]; invalid: string[] } {
  const max = currentROCYear();
  if (!input || !input.trim()) return { years: [max], invalid: [] };

  const years = new Set<number>();
  const invalid: string[] = [];

  for (const part of input.split(/[,，、\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d{2,3})\s*[-~－～]\s*(\d{2,3})$/);
    if (range) {
      const [a, b] = [parseInt(range[1], 10), parseInt(range[2], 10)].sort((x, y) => x - y);
      if (a < MIN_ROC_YEAR || b > max) { invalid.push(part); continue; }
      for (let y = a; y <= b; y++) years.add(y);
      continue;
    }
    const one = part.match(/^(\d{2,3})$/);
    const y = one ? parseInt(one[1], 10) : NaN;
    if (!one || y < MIN_ROC_YEAR || y > max) { invalid.push(part); continue; }
    years.add(y);
  }

  return { years: [...years].sort((a, b) => b - a), invalid };
}

export interface ArchiveResult {
  kind: string;
  /** 是否為無法決標公告（官網「種類」欄會誤寫成決標公告） */
  isNonAward: boolean;
  orgName: string;
  caseId: string;
  title: string;
  publishDate: string;
  deadline: string;
  awardDate: string;
  /** 「已截止」/「今日截止」/「N 天」——用來分等標期內與非等標期內 */
  status: string;
  /** 截止日已過（或已決標）＝非等標期內 */
  closed: boolean;
  year: number;
  link: string;
}

/**
 * 全文檢索查詢：逐年抓取後在本地套日期區間。
 * 官網 timeRange 只有「年」粒度，日期區間一律本地篩（與 search_tenders 同一套理由）。
 */
export async function searchArchive(
  querySentence: string,
  years: number[],
  statusTypes: TenderStatusType[],
  filter: DateFilter = {},
  opts: { matchNameOnly?: boolean } = {}
) {
  const crawler = new BulletionCrawlerService();
  const all: ArchiveTender[] = [];
  let truncated = false;
  let siteTotal = 0;

  for (const year of years) {
    console.error(`[Bulletion] 全文檢索 ${year} 年度：${querySentence}`);
    const r = await crawler.search({
      querySentence,
      year,
      statusTypes,
      matchNameOnly: opts.matchNameOnly,
    });
    all.push(...r.tenders);
    siteTotal += r.total;
    if (r.truncated) truncated = true;
  }

  const matched = all.filter(t => matchesDateFilter(t, filter));
  return {
    results: matched.map(toResult),
    scanned: all.length,
    siteTotal,
    truncated,
  };
}

/** 未給的條件視為不限；日期解析不出來的一律保留，寧可多給也不要誤刪 */
function matchesDateFilter(t: ArchiveTender, f: DateFilter): boolean {
  const inRange = (dateStr: string, from?: number | null, to?: number | null) => {
    if (from == null && to == null) return true;
    const n = rocStringToNumber(dateStr);
    if (n == null) return true;
    if (from != null && n < from) return false;
    if (to != null && n > to) return false;
    return true;
  };

  return inRange(t.publishDate, f.publishFrom, f.publishTo)
    && inRange(t.endDate, f.deadlineFrom, f.deadlineTo);
}

function toResult(t: ArchiveTender): ArchiveResult {
  const deadline = parseROCDate(t.endDate);
  const status = deadline ? getRemainingDays(deadline)
    : t.isNonAward ? '無法決標'
    : (t.awardDate ? '已決標' : '-');
  // 決標／無法決標公告本身就是結案紀錄；沒有截止日可判時，看有沒有決標日
  const closed = t.kind.includes('決標') || (deadline ? deadline.getTime() < Date.now() : Boolean(t.awardDate));

  return {
    kind: t.kind,
    isNonAward: t.isNonAward,
    orgName: t.orgName,
    caseId: t.caseId,
    title: t.name,
    publishDate: t.publishDate,
    deadline: t.endDate,
    awardDate: t.awardDate,
    status,
    closed,
    year: t.year,
    link: t.link,
  };
}
