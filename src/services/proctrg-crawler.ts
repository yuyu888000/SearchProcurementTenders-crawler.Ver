import axios from 'axios';
import * as cheerio from 'cheerio';
import { ProctrgSearchParams, ProctrgTender } from '../types/tender.js';
import { rocNumberToADSlash } from '../utils/date.js';
import { CATE_FIELD } from './cpc-catalog.js';

/**
 * 標的分類查詢（readTenderProctrg）—— 唯一能「用標的分類直接篩選」的官方入口。
 *
 * 與另外兩支的差異（踩過的坑都寫在這）：
 *  1. 表單標的是 method="post"，但它的送出函式 proctrgTenderSearch() 裡寫著
 *     「改用 get 送出」，實際是 window.location = action + '?' + serialize()。
 *     用 POST 打會拿到一張沒有結果的查詢表單頁，而且 HTTP 200、沒有任何錯誤訊息。
 *  2. 日期必須送「西元」(2026/07/01)。畫面上填民國只是顯示，前端送出前已轉換，
 *     伺服器對民國年會當成「99 年以前」而靜默回空表單頁。
 *  3. 分類要送內部 pk（見 cpc-catalog.ts），不是 8672 這種代碼。
 *  4. ★ 這支的分頁是可用的（d-<id>-p=2 直接帶就有第 2 頁），
 *     不像 readBulletion 那支是 session 狀態式、只能拿最新 100 筆。
 *     因此這裡會自動翻頁抓完整筆數。
 *  5. 未登入時公告日期區間上限 186 天，超過官網會直接導去全文檢索頁。
 */
export class ProctrgCrawlerService {
  private readonly baseUrl = 'https://web.pcc.gov.tw/prkms/tender/common/proctrg/readTenderProctrg';

  /** 官網單頁上限 */
  static readonly PAGE_SIZE = 100;
  /** 未登入的公告日期區間上限（天） */
  static readonly MAX_DAY_SPAN = 186;

  private readonly headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9',
    'Referer': 'https://web.pcc.gov.tw/prkms/tender/common/proctrg/indexTenderProctrg',
  };

  async search(params: ProctrgSearchParams): Promise<{ tenders: ProctrgTender[]; total: number; truncated: boolean }> {
    const maxPages = params.maxPages ?? 30;
    const all: ProctrgTender[] = [];
    const seen = new Set<string>();
    let pageParam = '';
    let total = 0;
    let truncated = false;

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1 && !pageParam) break;

      const qs = this.buildQuery(params);
      if (page > 1) qs.set(pageParam, String(page));

      const html = await this.fetchHtml(`${this.baseUrl}?${qs.toString()}`);
      // 分頁參數名每次查詢都不同（displaytag 產生的 d-16396-p），要從回應裡撈
      if (!pageParam) pageParam = html.match(/(d-\d+-p)=/)?.[1] ?? '';
      if (page === 1) total = this.parseTotal(html);

      const rows = this.parseRows(html);
      const fresh = rows.filter(r => !seen.has(r.key));
      fresh.forEach(r => seen.add(r.key));
      all.push(...fresh);

      if (rows.length < ProctrgCrawlerService.PAGE_SIZE || fresh.length === 0) break;
      if (page === maxPages && all.length < total) truncated = true;
    }

    return { tenders: all, total, truncated };
  }

  private buildQuery(p: ProctrgSearchParams): URLSearchParams {
    const { radio, param } = CATE_FIELD[p.cate];
    const qs = new URLSearchParams({
      pageSize: String(ProctrgCrawlerService.PAGE_SIZE),
      firstSearch: 'false',
      // 招標=tpam、決標=atm，官網是靠這個 hidden 欄位分流，不是靠那兩顆 radio
      searchType: p.kind === '決標' ? 'atm' : 'tpam',
      isBinding: 'N',
      isLogIn: 'N',
      level_1: 'on',
      tenderWay: p.tenderWay || 'TENDER_WAY_ALL_DECLARATION',
      proctrgCode1: '',
      proctrgCode2: '',
      proctrgCode3: '',
      radProctrgCate: radio,
      dateType: 'isDate',
      tenderStartDate: rocNumberToADSlash(p.publishFrom),
      tenderEndDate: rocNumberToADSlash(p.publishTo),
    });
    qs.set(param, p.pk);
    if (p.kind === '決標') qs.set('tenderStatus', p.tenderStatus || 'TENDER_STATUS_0');
    return qs;
  }

  private async fetchHtml(url: string): Promise<string> {
    try {
      const res = await axios.get(url, { headers: this.headers, responseType: 'text', timeout: 40000 });
      return String(res.data);
    } catch (error: any) {
      throw new Error(`標的分類查詢抓取失敗: ${error.message}`);
    }
  }

  /** 「共有<span class="red"> 1,264 </span>筆資料」——數字被標籤包住 */
  private parseTotal(html: string): number {
    const m = html.match(/共有(?:<[^>]*>|\s)*([\d,]+)(?:<[^>]*>|\s)*筆資料/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  }

  /**
   * 欄位：項次 | 機關名稱 | 標案案號+標案名稱 | 招標方式 | 標的分類 |
   *       公告日期 | 決標金額 | 決標公告 | 無法決標 | 功能選項
   * ⚠️ 標案名稱一樣包在 Geps3.CNS.pageCode2Img("...") 裡，純文字取不到。
   */
  private parseRows(html: string): ProctrgTender[] {
    const $ = cheerio.load(html);
    const out: ProctrgTender[] = [];

    $('table tr').each((_, el) => {
      const cols = $(el).find('td');
      if (cols.length < 9) return;

      const cell = (i: number) => $(cols[i]).text().trim().replace(/\s+/g, ' ');
      if (!/^\d+$/.test(cell(0))) return; // 跳過表頭與說明列

      const rawCase = $(cols[2]).text();
      const name = rawCase.match(/pageCode2Img\("([^"]*)"\)/)?.[1]?.trim() ?? '';
      const caseId = rawCase.split(/\s*var\s+hw\s*=/)[0].trim().replace(/\s+/g, ' ');

      const href = $(el).find('a[href*="pk="]').first().attr('href') ?? '';
      const link = href ? new URL(href, 'https://web.pcc.gov.tw').toString() : '';

      out.push({
        key: link || `${caseId}#${name}`,
        orgName: cell(1),
        caseId,
        name,
        tenderWay: cell(3),
        publishDate: cell(5),
        awardAmount: cell(6),
        link,
        matchedCode: '',
        matchedLabel: '',
      });
    });

    return out;
  }
}
