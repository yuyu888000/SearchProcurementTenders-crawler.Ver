import axios from 'axios';
import * as cheerio from 'cheerio';
import { ArchiveSearchParams, ArchiveTender } from '../types/tender.js';

/**
 * 全文檢索（電子公報）抓取 —— 這是唯一能查到「已截止歷史標案」的官方路徑。
 *
 * 與 web-crawler 互補，兩者涵蓋範圍互不重疊：
 *   - readTenderBasic（dateType=isSpdt）：等標期內、還能投標
 *   - readBulletion                    ：民國 88 年起的公報，含已截止
 * 純 HTML、無 JS 渲染、免登入，因此 axios 就夠，不需要 Playwright/puppeteer。
 *
 * ⚠️ 不做翻頁：官網分頁是伺服器 session 狀態式的。實測帶上 `d-<id>-p=2`（連官網自己
 * 產生的連結原封不動也一樣）在 GET／POST／完整 cookie jar／正確 Referer 四種組合下
 * 都只回沒有結果的查詢表單頁；同一個網址在瀏覽器裡卻正常。`pageSize` 也硬上限 100
 * （帶 200/500/1000 一律只回 100 筆）。
 * 因此策略是「一次一年度取最新 100 筆，並誠實回報官網命中總數」，
 * 超出就請使用者縮小條件（換年度、加日期區間、用更精準的關鍵字或標案案號），
 * 不用瀏覽器自動化去硬翻。
 */
export class BulletionCrawlerService {
  private readonly baseUrl = 'https://web.pcc.gov.tw/prkms/tender/common/bulletion/readBulletion';

  /** 官網單次回傳硬上限 */
  static readonly PAGE_LIMIT = 100;

  private readonly defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9',
    'Referer': 'https://web.pcc.gov.tw/prkms/tender/common/bulletion/indexBulletion',
  };

  /**
   * 查指定民國年度的公報（timeRange 官網一次只吃一年，多年份由呼叫端逐年呼叫）。
   * 依招標公告日期排序，取最新的 100 筆。
   */
  async search(params: ArchiveSearchParams): Promise<{ tenders: ArchiveTender[]; truncated: boolean; total: number }> {
    const urlParams = new URLSearchParams();
    urlParams.set('querySentence', params.querySentence);
    for (const s of params.statusTypes) urlParams.append('tenderStatusType', s);
    urlParams.set('sortCol', 'TENDER_NOTICE_DATE');
    urlParams.set('timeRange', String(params.year));
    urlParams.set('pageSize', String(BulletionCrawlerService.PAGE_LIMIT));
    // 不加此旗標會比對公告全文，關鍵字稍寬命中量就爆掉
    if (params.matchNameOnly !== false) urlParams.set('onlyOrgAndTenderName', 'true');

    const html = await this.fetchHtml(`${this.baseUrl}?${urlParams.toString()}`);
    const total = this.parseTotal(html);
    const tenders = this.parseRows(html, params.year);

    return { tenders, truncated: total > tenders.length, total };
  }

  private async fetchHtml(fullUrl: string): Promise<string> {
    try {
      const response = await axios.get(fullUrl, {
        headers: this.defaultHeaders,
        responseType: 'text',
        timeout: 40000,
      });
      return String(response.data);
    } catch (error: any) {
      console.error('Bulletion Crawler Error:', error.message);
      throw new Error(`全文檢索抓取失敗: ${error.message}`);
    }
  }

  /** 頁面上的「共有<span class="red"> 244 </span>筆資料」——數字被標籤包住，別用純文字比對 */
  private parseTotal(html: string): number {
    const m = html.match(/共有(?:<[^>]*>|\s)*([\d,]+)(?:<[^>]*>|\s)*筆資料/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  }

  /**
   * 資料列欄位：項次 | 種類 | 機關名稱 | 標案案號+標案名稱 | 招標公告日期 |
   *            決標或無法決標公告 | 截止投標日期 | 公開閱覽/徵求日期 | 預告公告日期 | 功能選項
   * ⚠️ 標案名稱不是純文字，包在 Geps3.CNS.pageCode2Img("...") 的 JS 裡，必須另外抽。
   */
  private parseRows(html: string, year: number): ArchiveTender[] {
    const $ = cheerio.load(html);
    const out: ArchiveTender[] = [];

    $('table tr').each((_, el) => {
      const cols = $(el).find('td');
      if (cols.length < 9) return;

      const cell = (i: number) => $(cols[i]).text().trim().replace(/\s+/g, ' ');
      const idx = cell(0);
      if (!/^\d+$/.test(idx)) return; // 跳過表頭與說明列

      const rawCase = $(cols[3]).text();
      const name = rawCase.match(/pageCode2Img\("([^"]*)"\)/)?.[1]?.trim() ?? '';
      const caseId = rawCase.split(/\s*var\s+hw\s*=/)[0].trim().replace(/\s+/g, ' ');

      const href = $(el).find('a[href*="pk="]').first().attr('href') ?? '';
      const link = href ? new URL(href, 'https://web.pcc.gov.tw').toString() : '';

      // 官網「種類」欄把無法決標公告也寫成「決標公告」；真正的區別在連結路徑
      // （atm＝決標、nonAtm＝無法決標）與「決標或無法決標公告」欄的 (無法決標) 後綴。
      const awardCol = cell(5);
      const isNonAward = /nonAtm\?/i.test(link) || /無法決標/.test(awardCol);
      const siteKind = cell(1);
      const kind = isNonAward ? '無法決標公告'
        : /\/common\/atm\?/i.test(link) ? '決標公告'
        : siteKind;

      out.push({
        key: link || `${caseId}#${idx}#${year}`,
        kind,
        siteKind,
        isNonAward,
        orgName: cell(2),
        caseId,
        name,
        publishDate: cell(4),
        awardDate: cell(5),
        endDate: cell(6),
        year,
        link,
      });
    });

    return out;
  }
}
