import { CpcCategory, ProctrgTender } from '../types/tender.js';
import { ProctrgCrawlerService } from './proctrg-crawler.js';

export interface CategoryQuery {
  cats: CpcCategory[];
  kind: '招標' | '決標';
  tenderStatus?: string;
  tenderWay?: string;
  publishFrom: number;
  publishTo: number;
  /** 只保留機關名稱含其中任一字串的案子（縣市篩選用） */
  orgNameIncludes?: string[];
  /** 標案名稱含其中任一字串就排除（例：變更設計） */
  excludeTitleKeywords?: string[];
  maxPages?: number;
}

export interface CategoryStat {
  code: string;
  label: string;
  /** 官網對這個分類回報的總筆數 */
  siteTotal: number;
  /** 實際抓下來的筆數 */
  fetched: number;
  truncated: boolean;
}

export interface CategoryResult {
  results: ProctrgTender[];
  stats: CategoryStat[];
  /** 跨分類去重後、套用篩選前的筆數 */
  dedupedBeforeFilter: number;
  /** 被機關名稱篩掉的筆數 */
  droppedByOrg: number;
  /** 被標案名稱排除字篩掉的筆數 */
  droppedByExclude: number;
}

/**
 * 逐一查詢每個標的分類（官網一次只吃一個分類），合併並去重。
 * 同一個標案可能同時被多個分類命中嗎？不會——標的分類是單一欄位，
 * 但上層分類（如 867）與子分類（8671~8676）查出來的結果會重疊，所以仍需去重。
 */
export async function searchByCategories(q: CategoryQuery): Promise<CategoryResult> {
  const crawler = new ProctrgCrawlerService();
  const merged = new Map<string, ProctrgTender>();
  const stats: CategoryStat[] = [];

  for (const cat of q.cats) {
    const { tenders, total, truncated } = await crawler.search({
      pk: cat.pk,
      cate: cat.cate,
      kind: q.kind,
      tenderStatus: q.tenderStatus,
      tenderWay: q.tenderWay,
      publishFrom: q.publishFrom,
      publishTo: q.publishTo,
      maxPages: q.maxPages,
    });

    stats.push({ code: cat.code, label: cat.label, siteTotal: total, fetched: tenders.length, truncated });

    for (const t of tenders) {
      const prev = merged.get(t.key);
      if (prev) {
        // 已被更上層/其他分類收錄過，補記這筆也命中本分類，方便使用者回溯
        if (!prev.matchedCode.split('、').includes(cat.code)) {
          prev.matchedCode += `、${cat.code}`;
          prev.matchedLabel += `、${cat.label}`;
        }
        continue;
      }
      merged.set(t.key, { ...t, matchedCode: cat.code, matchedLabel: cat.label });
    }
  }

  let rows = [...merged.values()];
  const dedupedBeforeFilter = rows.length;

  let droppedByOrg = 0;
  if (q.orgNameIncludes?.length) {
    const before = rows.length;
    rows = rows.filter(r => q.orgNameIncludes!.some(k => r.orgName.includes(k)));
    droppedByOrg = before - rows.length;
  }

  let droppedByExclude = 0;
  if (q.excludeTitleKeywords?.length) {
    const before = rows.length;
    rows = rows.filter(r => !q.excludeTitleKeywords!.some(k => r.name.includes(k)));
    droppedByExclude = before - rows.length;
  }

  // 公告日期新的排前面
  rows.sort((a, b) => b.publishDate.localeCompare(a.publishDate));

  return { results: rows, stats, dedupedBeforeFilter, droppedByOrg, droppedByExclude };
}
