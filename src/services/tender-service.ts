import { WebCrawlerService } from './web-crawler.js';
import { DateFilter, SearchParams, Tender } from '../types/tender.js';
import { parseROCDate, getRemainingDays, calculateTenderPeriod, rocStringToNumber } from '../utils/date.js';

export class TenderService {
  private crawler = new WebCrawlerService();

  /**
   * 標案查詢：僅使用 Web Crawler 確保資料最即時且直接來自官網
   * 日期區間在本地過濾（官網 dateType=isDate 實測無法使用，見 web-crawler.search 註解）
   */
  async fetchAndFilterTenders(keyword: string, filter: DateFilter = {}, orgName?: string) {
    try {
      // stdio MCP 的 stdout 是 JSON-RPC 通道，log 一律走 stderr
      console.error(`[Crawler] 正在從政府採購網查詢: 標案名稱=${keyword || '(未給)'} 機關=${orgName || '(未給)'}`);

      const crawlerParams: SearchParams = { tenderName: keyword, orgName };

      const { tenders, truncated } = await this.crawler.search(crawlerParams);
      const matched = tenders.filter(t => this.matchesDateFilter(t, filter));

      const results = matched.map(t => this.formatTender(t));

      return {
        results,
        totalBeforeFilter: tenders.length,
        hasMore: truncated,
        source: 'web'
      };

    } catch (error: any) {
      console.error(`[Crawler Error] 查詢失敗: ${error.message}`);
      throw new Error(`無法從政府採購網取得資料: ${error.message}`);
    }
  }

  /**
   * 公告日期與截止投標日各自套用區間；未給的條件視為不限。
   * 日期解析不出來的案子一律保留，寧可多給也不要誤刪。
   */
  private matchesDateFilter(t: Tender, f: DateFilter): boolean {
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

  /**
   * 格式化標案資料，計算日期差等資訊
   */
  private formatTender(t: Tender) {
    let remainingDays = "-";
    let tenderPeriod = "-";
    
    const deadlineDate = parseROCDate(t.endDate);
    const publishDate = parseROCDate(t.publishDate);

    if (deadlineDate) {
      remainingDays = getRemainingDays(deadlineDate);
    }
    
    if (deadlineDate && publishDate) {
      tenderPeriod = calculateTenderPeriod(publishDate, deadlineDate);
    }

    return {
      publishDate: t.publishDate,
      deadline: t.endDate,
      tenderPeriod,
      remainingDays,
      type: `${t.tenderWay} (${t.tenderType})`,
      caseId: t.id,
      title: t.name,
      orgName: t.orgName,
      budget: (t.budget ?? 0) > 0 ? t.budget!.toLocaleString() : "未提供或需登入",
      link: t.link,
      viewLink: t.link,
      source: t.source || 'web'
    };
  }
}

// 導出實例
const service = new TenderService();
export const fetchAndFilterTenders = (keyword: string, filter?: DateFilter, orgName?: string) =>
  service.fetchAndFilterTenders(keyword, filter, orgName);
