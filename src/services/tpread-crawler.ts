import axios from 'axios';
import * as cheerio from 'cheerio';
import { TpReadCate, TpReadSearchParams, TpReadTender } from '../types/tender.js';
import { rocNumberToADSlash, rocStringToNumber } from '../utils/date.js';

/** 採購性質 → 官網 radProctrgCate 的值 */
const CATE_RADIO: Record<TpReadCate, string> = {
  '工程類': 'RAD_PROCTRG_CATE_1',
  '財物類': 'RAD_PROCTRG_CATE_2',
  '勞務類': 'RAD_PROCTRG_CATE_3',
};

/**
 * 公開閱覽查詢（readTpRead）—— 官網「標案相關／公開閱覽查詢」的專屬入口，
 * 查的是「招標文件公開閱覽公告」，和招標公告是不同的公告池：
 * 公開閱覽是機關在正式招標前把招標文件掛出來給廠商表示意見，**還不能投標**。
 *
 * 踩過的坑：
 *  1. 表單 method="post"，但 GET 帶 query string 一樣通（本檔用 GET，方便帶分頁參數）。
 *  2. **日期要送西元**（2026/09/01）。送民國（115/09/01）伺服器回「共有 0 筆資料」，
 *     不報錯、也沒有任何提示，極易誤判成真的沒案子。
 *  3. 日期區間是「**期間有交集就命中**」：查 09/19~09/19 會撈到 09/17─09/30 的案子，
 *     不是只比對起日。這正好對應使用者問的「某段時間可以閱覽的案子」。
 *  4. 分頁可用（d-<id>-p 直接帶頁碼），pageSize 實測到 5000 都吃，
 *     但單頁 5000 筆的 HTML 有 3.5MB，所以固定 500 一頁自動翻。
 *  5. 官網此查詢**沒有縣市欄位**，縣市一律由呼叫端比對機關名稱。
 *  6. 採購性質（radProctrgCate）是伺服器端真的有篩：實測 115/09/01~115/09/21
 *     工程 101＋財物 25＋勞務 297 ＝ 不限 423，三類互斥、不重不漏。
 */
export class TpReadCrawlerService {
  private readonly baseUrl = 'https://web.pcc.gov.tw/prkms/tpRead/common/readTpRead';

  /** 單頁筆數（官網吃更大，但 HTML 會爆） */
  static readonly PAGE_SIZE = 500;

  private readonly headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9',
    'Referer': 'https://web.pcc.gov.tw/prkms/tpRead/common/indexTpRead',
  };

  async search(params: TpReadSearchParams): Promise<{ tenders: TpReadTender[]; total: number; truncated: boolean }> {
    const maxPages = params.maxPages ?? 10;
    const all: TpReadTender[] = [];
    const seen = new Set<string>();
    let pageParam = '';
    let total = 0;
    let truncated = false;

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1 && !pageParam) break;

      const qs = this.buildQuery(params);
      if (page > 1) qs.set(pageParam, String(page));

      const html = await this.fetchHtml(`${this.baseUrl}?${qs.toString()}`);
      // 分頁參數名是 displaytag 產生的（d-447556-p），要從回應裡撈
      if (!pageParam) pageParam = html.match(/(d-\d+-p)=/)?.[1] ?? '';
      if (page === 1) total = this.parseTotal(html);

      const rows = this.parseRows(html);
      const fresh = rows.filter(r => !seen.has(r.key));
      fresh.forEach(r => seen.add(r.key));
      all.push(...fresh);

      if (rows.length < TpReadCrawlerService.PAGE_SIZE || fresh.length === 0) break;
      if (page === maxPages && all.length < total) truncated = true;
    }

    return { tenders: all, total, truncated };
  }

  private buildQuery(p: TpReadSearchParams): URLSearchParams {
    return new URLSearchParams({
      pageSize: String(TpReadCrawlerService.PAGE_SIZE),
      firstSearch: 'false',
      orgId: '',
      orgName: '',
      tenderId: '',
      tenderName: '',
      radProctrgCate: p.cate ? CATE_RADIO[p.cate] : '',
      fkPmsProcurementRange: '',
      queryStartDate: rocNumberToADSlash(p.reviewFrom),
      queryEndDate: rocNumberToADSlash(p.reviewTo),
    });
  }

  private async fetchHtml(fullUrl: string): Promise<string> {
    try {
      const response = await axios.get(fullUrl, { headers: this.headers, responseType: 'text', timeout: 60000 });
      return String(response.data);
    } catch (error: any) {
      console.error('TpRead Crawler Error:', error.message);
      throw new Error(`公開閱覽查詢抓取失敗: ${error.message}`);
    }
  }

  /** 「共有<span class="red"> 423 </span>筆資料」——數字被標籤包住，別用純文字比對 */
  private parseTotal(html: string): number {
    const m = html.match(/共有(?:<[^>]*>|\s)*([\d,]+)(?:<[^>]*>|\s)*筆資料/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  }

  /**
   * 資料列欄位：項次 | 機關名稱 | 標案案號 | 標案名稱 | 公告次數 | 公開閱覽期間 | 功能選項
   * ⚠️ 標案名稱包在 Geps3.CNS.pageCode2Img("...") 的 JS 裡，不是純文字。
   * 查無資料時 tbody 仍有一列「無符合條件資料」，靠項次必須是數字擋掉。
   */
  private parseRows(html: string): TpReadTender[] {
    const $ = cheerio.load(html);
    const out: TpReadTender[] = [];

    $('#tpRead tbody tr').each((_, el) => {
      const cols = $(el).find('td');
      if (cols.length < 6) return;

      const cell = (i: number) => $(cols[i]).text().trim().replace(/\s+/g, ' ');
      if (!/^\d+$/.test(cell(0))) return; // 跳過「無符合條件資料」與說明列

      const name = $(cols[3]).text().match(/pageCode2Img\("([^"]*)"\)/)?.[1]?.trim() ?? '';
      const href = $(el).find('a[href*="pk="]').first().attr('href') ?? '';
      const link = href ? new URL(href, 'https://web.pcc.gov.tw').toString() : '';

      // 期間分隔符是全形製表線 ─（U+2500），不是連字號
      const period = cell(5);
      const [from, to] = period.split(/[─—–-]/).map(s => rocStringToNumber(s.trim()));

      out.push({
        key: link || `${cell(1)}|${cell(2)}|${cell(4)}`,
        orgName: cell(1),
        caseId: cell(2),
        name,
        noticeTimes: cell(4),
        period,
        reviewFrom: from ?? null,
        reviewTo: to ?? null,
        link,
      });
    });

    return out;
  }
}
