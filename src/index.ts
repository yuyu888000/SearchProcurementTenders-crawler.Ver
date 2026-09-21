import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchAndFilterTenders } from "./services/tender-service.js";
import { fetchTenderDetails, KEY_FIELDS, MAX_FETCH_PER_CALL } from "./services/detail-crawler.js";
import { toROCNumber, formatROCNumber, daysBetweenROC } from "./utils/date.js";
import { resolveCodes } from "./services/cpc-catalog.js";
import { searchByCategories } from "./services/proctrg-service.js";
import { ProctrgCrawlerService } from "./services/proctrg-crawler.js";
import { searchArchive, parseYears, currentROCYear, MIN_ROC_YEAR, MAX_YEARS_PER_CALL } from "./services/archive-service.js";
import { TenderStatusType } from "./types/tender.js";

const server = new McpServer({
  name: "taiwan-tender-searcher",
  version: "0.0.3",
}, {
  // 行為規則放 server instructions：任何 client 掛上這支 MCP 就生效，不依賴 skill 觸發或記憶命中
  instructions: `查台灣政府採購標案的固定作法：

1. 三個查詢工具的涵蓋範圍**互不重疊**，不可互相取代：
   - search_tenders：只有「等標期內」還能投標的案子（官網 dateType=isSpdt）
   - search_tender_archive：全文檢索電子公報，民國 88 年起，**含已截止的歷史案**
   - search_tenders_by_category：**用標的分類代碼**查（民國 99 年起，招標／決標皆可）。
     只有這支能真的按分類篩選，而且**會翻頁抓完整筆數**（另兩支各有 100 筆上限）。
     使用者一講到標的分類代碼（52、521、8672…）或「某一類的案子全部」，就用這支，
     不要退回用關鍵字猜。它一次日期區間上限 186 天，超過要自行拆段。
2. 使用者沒有明確限定範圍時，**兩個工具都要跑**，並把結果分成兩段回報：
   「等標期內（還能投標）」與「已截止／歷史案（僅供參考，不能投標）」。
   每段都要標明筆數；某段是 0 筆也要明寫「0 筆」，**不可靜默省略**（省略會被誤讀成沒查過）。
3. 只有使用者明講「只要現在能投的」才可以只跑 search_tenders。
   反之，使用者問的案子查不到時，要先確認是不是已截止、改用 search_tender_archive 再答，
   不要把「工具查不到」講成「這個案子不存在」。
4. 判斷案子性質與可投性，用 get_tender_detail 看「標的分類」與「廠商資格摘要」兩個欄位，
   不要只靠標案名稱關鍵字（分類碼比關鍵字可靠，但資格摘要才決定誰能投）。
   要「整批」依分類篩選時改用 search_tenders_by_category，不要拿 get_tender_detail 逐筆掃。
5. 官網這幾個查詢頁都沒有「縣市」欄位。要依縣市篩選只能比對機關名稱（會有偏差：
   中央機關在該縣市的案子撈不到、該縣市機關在外縣市的案子會被留下），
   精確的履約地點要用 get_tender_detail 逐筆確認。**回報時要講清楚用的是哪一種**。
6. get_tender_detail 受網站流量控制，一次最多 8 筆未快取的案子。遇到驗證碼頁就附連結
   請使用者人工開啟，**不要重試迴圈，也不要試圖繞過驗證碼**。`,
});

server.tool(
  "search_tenders",
  "Search for Taiwan government procurement tenders (web.pcc.gov.tw), optionally narrowed by an announcement-date range (publishFrom/publishTo) and/or a bid-deadline range (deadlineFrom/deadlineTo). Can also search by procuring agency name (orgName, partial match: '空軍' matches '國防部空軍司令部'). At least one of keyword / orgName is required; giving both narrows to tenders matching name AND agency. Note the agency is the one that PUBLISHES the tender, which is often NOT the unit named as the construction site. Scope is limited to tenders still open for bidding (等標期內); closed/historical tenders are not covered. This tool returns a pre-formatted Markdown table. The LLM MUST output this table verbatim to the user without modifying its format, columns, or content.",
  {
    keyword: z.string().optional().describe("Tender-NAME keyword (e.g., 'indoor renovation'). Matches the tender name only - not the case number, not the agency."),
    orgName: z.string().optional().describe("機關名稱，部分比對（例：空軍、國防部空軍司令部）。keyword 與 orgName 至少要給一個。"),
    publishFrom: z.string().optional().describe("公告日期起 (民國或西元皆可：115/07/01、1150701、2026-07-01)"),
    publishTo: z.string().optional().describe("公告日期迄 (同上格式)"),
    deadlineFrom: z.string().optional().describe("截止投標日起 (同上格式)"),
    deadlineTo: z.string().optional().describe("截止投標日迄 (同上格式)"),
  },
  async ({ keyword, orgName, publishFrom, publishTo, deadlineFrom, deadlineTo }) => {
    try {
      if (!keyword && !orgName) {
        return { content: [{ type: "text", text: "請至少給 keyword（標案名稱關鍵字）或 orgName（機關名稱）其中一個。" }] };
      }
      const label = [keyword && `「${keyword}」`, orgName && `機關「${orgName}」`].filter(Boolean).join('＋');
      const raw = { publishFrom, publishTo, deadlineFrom, deadlineTo };
      const filter = {
        publishFrom: toROCNumber(publishFrom),
        publishTo: toROCNumber(publishTo),
        deadlineFrom: toROCNumber(deadlineFrom),
        deadlineTo: toROCNumber(deadlineTo),
      };

      // 有給日期卻解析不出來，直接告訴使用者，不要默默當成不限
      const bad = (Object.keys(raw) as (keyof typeof raw)[])
        .filter(k => raw[k] && filter[k] == null);
      if (bad.length > 0) {
        return { content: [{ type: "text", text: `日期格式無法解析：${bad.map(k => `${k}="${raw[k]}"`).join('、')}。請用 115/07/01 或 2026-07-01 這類格式。` }] };
      }

      const range = (from: number | null, to: number | null) =>
        from == null && to == null ? '' : `${from ? formatROCNumber(from) : '不限'} ~ ${to ? formatROCNumber(to) : '不限'}`;
      const conditions = [
        range(filter.publishFrom, filter.publishTo) && `公告日 ${range(filter.publishFrom, filter.publishTo)}`,
        range(filter.deadlineFrom, filter.deadlineTo) && `截止投標 ${range(filter.deadlineFrom, filter.deadlineTo)}`,
      ].filter(Boolean).join('｜');

      const { results, totalBeforeFilter, hasMore } = await fetchAndFilterTenders(keyword ?? '', filter, orgName);

      if (results.length === 0) {
        const suffix = conditions ? `（條件：${conditions}；等標期內共掃描 ${totalBeforeFilter} 筆）` : '';
        return { content: [{ type: "text", text: `找不到與 ${label} 相關且可投標的案件。${suffix}` }] };
      }

      // 格式化為高品質 Markdown 表格
      let markdownTable = `### ${label} 標案搜尋結果 (共 ${results.length} 筆)\n\n`;
      if (conditions) {
        markdownTable += `> 篩選條件：${conditions}　(等標期內共 ${totalBeforeFilter} 筆，符合 ${results.length} 筆)\n\n`;
      }
      markdownTable += `| 案號 | 標案名稱 | 預算金額 | 公告日 | 截止投標 | 剩餘天數 | 連結 |\n`;
      markdownTable += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

      results.forEach(t => {
        // 標案名稱過長時適度截斷，保持表格美觀
        const displayTitle = t.title.length > 35 ? t.title.substring(0, 33) + '...' : t.title;
        markdownTable += `| **${t.caseId}** | ${displayTitle} | ${t.budget} | ${t.publishDate} | ${t.deadline} | **${t.remainingDays}** | [查看](${t.viewLink}) |\n`;
      });

      if (results.length === 0) {
        markdownTable = `### ${label} 搜尋結果\n\n目前沒有搜尋到相關標案。`;
      } else if (hasMore) {
        markdownTable += `\n> *註：關鍵字命中數超過抓取上限（500 筆），結果可能不完整，請縮小關鍵字或加上日期條件。*\n`;
      }

      return {
        content: [
          {
            type: "text", 
            text: markdownTable
          },
          {
            type: "text",
            text: `(隱藏分析數據：共找到 ${results.length} 筆資料，來源：${(results as any).source || 'web'})`
          }
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `搜尋失敗: ${error.message}` }] };
    }
  }
);

server.tool(
  "get_tender_detail",
  `Fetch the DETAIL page of specific tenders from web.pcc.gov.tw, given the links returned by search_tenders (or raw pk values). Returns fields that the search listing does NOT contain: 標的分類 (category code, e.g. 5177 室內裝潢工程 / 5179 其他裝修工程), 廠商資格摘要 (vendor qualification), 截止投標 with time-of-day, 決標方式, 押標金, 履約地點/期限, and agency contact info. Use this to judge whether a tender really is the type of work the user wants — the category code is far more reliable than keyword matching on the tender name. IMPORTANT: the site rate-limits detail pages; at most ${MAX_FETCH_PER_CALL} uncached tenders per call, results are cached locally so re-querying the same tender is free. If the site returns its CAPTCHA page the remaining items are reported as not-retrieved with their links — do NOT retry in a loop, tell the user to open those links manually.`,
  {
    cases: z.array(z.string()).min(1).describe("標案內頁連結（search_tenders 回傳的「查看」網址）或 pk 值，一次最多建議 8 筆"),
    full: z.boolean().optional().describe("true 則回傳內頁全部欄位（約 70 項），預設只回精選欄位"),
  },
  async ({ cases, full }) => {
    try {
      const { details, blocked, fetched } = await fetchTenderDetails(cases);

      let out = `### 標案內頁明細（${details.length} 筆）\n\n`;
      const failed: typeof details = [];

      details.forEach((d, i) => {
        if (!d.ok) { failed.push(d); return; }

        const f = d.fields;
        const title = f['標案名稱'] || '(無標案名稱)';
        const caseId = f['標案案號'] || d.pk;
        out += `#### ${i + 1}. ${title}\n`;
        out += `案號 \`${caseId}\`　${d.cached ? '（本地快取）' : '（本次抓取）'}\n\n`;
        out += `| 欄位 | 內容 |\n| :--- | :--- |\n`;

        const keys = full ? Object.keys(f) : KEY_FIELDS.filter(k => f[k]);
        keys.forEach(k => {
          if (k === '標案名稱' || k === '標案案號') return;
          const v = (f[k] || '').replace(/\|/g, '\\|');
          if (!v) return;
          out += `| ${k} | ${v.length > 300 ? v.slice(0, 300) + '…' : v} |\n`;
        });
        out += `\n[開啟內頁](${d.url})\n\n`;
      });

      if (failed.length > 0) {
        out += `---\n\n**以下 ${failed.length} 筆未取得，請自行點開確認：**\n\n`;
        failed.forEach(d => {
          const why = d.reason === 'captcha' ? '網站流量控制（驗證碼）'
            : d.reason === 'parse' ? (d.message || '內頁版型不符，可能非一般招標公告')
            : d.message || '連線失敗';
          out += `- ${d.url ? `[${d.pk}](${d.url})` : d.input} — ${why}\n`;
        });
        if (blocked) {
          out += `\n> 政府採購網已對本次連線啟動流量控制。這是網站的防自動化機制，不是違規紀錄。請稍後再試，或在瀏覽器開啟上列連結（會要求點選撲克牌驗證）。**不要重複重試**。\n`;
        }
      }

      out += `\n> 本次實際連線抓取 ${fetched} 筆，其餘來自本地快取。\n`;

      return { content: [{ type: "text", text: out }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `取得標案明細失敗: ${error.message}` }] };
    }
  }
);

server.tool(
  "search_tender_archive",
  `Search the FULL-TEXT bulletin archive (電子公報全文檢索) of web.pcc.gov.tw. This is the ONLY way to find tenders whose bidding period has already CLOSED — search_tenders covers ONLY tenders still open for bidding (等標期內). Covers ROC years ${MIN_ROC_YEAR} to ${currentROCYear()}; the site accepts one year per request, so this tool queries at most ${MAX_YEARS_PER_CALL} years per call. Returns 種類 (招標公告 / 決標公告 / 無法決標公告), 機關名稱, 標案案號, 標案名稱, 招標公告日期, 截止投標日期, plus a detail link whose pk can be passed straight to get_tender_detail. Results are split into 等標期內 (still open) and 已截止／歷史 (closed) sections. Each year returns at most the 100 most recent matches (the site caps one response at 100 rows and its pagination needs a real browser session), and the output states the site-wide hit count whenever it is larger — narrow with a 標案案號, a tighter keyword, or one year per call instead of expecting more rows. Unless the user explicitly asked only for tenders they can still bid on, run this tool ALONGSIDE search_tenders and report both sections with their counts — write "0 筆" explicitly for an empty section instead of omitting it. This tool returns pre-formatted Markdown; output it verbatim without changing its structure.`,
  {
    keyword: z.string().min(1).describe("全文查詢字串。支援布林語法：AND（或 , &）、OR（或 ; |）、NOT（或 !）與括號；含保留字請用雙引號包住。也可直接放標案案號。"),
    years: z.string().optional().describe(`民國年度，官網一次只吃一年，本工具一次最多 ${MAX_YEARS_PER_CALL} 年。可寫 115、114,115、113-115。預設當年（${currentROCYear()}），範圍 ${MIN_ROC_YEAR}~${currentROCYear()}。`),
    statusTypes: z.array(z.enum(["招標", "決標", "公開閱覽及公開徵求", "政府採購預告"])).optional().describe("公報種類，預設 ['招標']。要查決標結果或無法決標請加 '決標'。"),
    publishFrom: z.string().optional().describe("招標公告日期起 (民國或西元皆可：115/07/01、1150701、2026-07-01)"),
    publishTo: z.string().optional().describe("招標公告日期迄 (同上格式)"),
    deadlineFrom: z.string().optional().describe("截止投標日起 (同上格式)"),
    deadlineTo: z.string().optional().describe("截止投標日迄 (同上格式)"),
    fullText: z.boolean().optional().describe("預設 false＝只比對機關名稱與標案名稱。true 會比對公告全文，命中數暴增，只在窄關鍵字時用。"),
  },
  async ({ keyword, years, statusTypes, publishFrom, publishTo, deadlineFrom, deadlineTo, fullText }) => {
    try {
      const { years: yearList, invalid } = parseYears(years);
      if (invalid.length > 0) {
        return { content: [{ type: "text", text: `年度無法解析或超出範圍（${MIN_ROC_YEAR}~${currentROCYear()}）：${invalid.join('、')}。請用民國年，例如 115 或 113-115。` }] };
      }
      if (yearList.length > MAX_YEARS_PER_CALL) {
        return { content: [{ type: "text", text: `一次最多查 ${MAX_YEARS_PER_CALL} 個年度（本次給了 ${yearList.length} 個：${yearList.join('、')}），請分批查詢。` }] };
      }

      const raw = { publishFrom, publishTo, deadlineFrom, deadlineTo };
      const filter = {
        publishFrom: toROCNumber(publishFrom),
        publishTo: toROCNumber(publishTo),
        deadlineFrom: toROCNumber(deadlineFrom),
        deadlineTo: toROCNumber(deadlineTo),
      };
      // 有給日期卻解析不出來，直接告訴使用者，不要默默當成不限
      const bad = (Object.keys(raw) as (keyof typeof raw)[]).filter(k => raw[k] && filter[k] == null);
      if (bad.length > 0) {
        return { content: [{ type: "text", text: `日期格式無法解析：${bad.map(k => `${k}="${raw[k]}"`).join('、')}。請用 115/07/01 或 2026-07-01 這類格式。` }] };
      }

      const kinds = (statusTypes ?? ["招標"]) as TenderStatusType[];
      const { results, scanned, siteTotal, truncated } = await searchArchive(
        keyword, yearList, kinds, filter, { matchNameOnly: !fullText }
      );

      const scope = `${yearList.join('、')} 年度公報｜種類 ${kinds.join('、')}｜${fullText ? '全文比對' : '只比對機關名與標案名'}`;
      if (results.length === 0) {
        return { content: [{ type: "text", text: `### 全文檢索「${keyword}」：0 筆\n\n> 範圍：${scope}\n> 官網該關鍵字命中 ${siteTotal} 筆，本次掃描 ${scanned} 筆，套用日期條件後 0 筆。\n\n查不到不代表案子不存在——可放寬年度、改用標案案號當關鍵字，或加 fullText=true 比對公告全文。` }] };
      }

      const open = results.filter(r => !r.closed);
      const closed = results.filter(r => r.closed);

      const table = (rows: typeof results) => {
        let t = `| 種類 | 機關 | 案號 | 標案名稱 | 公告日 | 截止投標 | 狀態 | 連結 |\n`;
        t += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
        rows.forEach(r => {
          const title = r.title.length > 35 ? r.title.slice(0, 33) + '...' : r.title;
          t += `| ${r.kind} | ${r.orgName} | **${r.caseId}** | ${title} | ${r.publishDate} | ${r.deadline || '-'} | ${r.status} | ${r.link ? `[查看](${r.link})` : '-'} |\n`;
        });
        return t;
      };

      let out = `### 全文檢索「${keyword}」（共 ${results.length} 筆）\n\n> 範圍：${scope}\n\n`;
      out += `#### 等標期內（還能投標）：${open.length} 筆\n\n`;
      out += open.length > 0 ? table(open) + '\n' : `（0 筆）\n\n`;
      out += `#### 已截止／歷史案（僅供參考，不能投標）：${closed.length} 筆\n\n`;
      out += closed.length > 0 ? table(closed) + '\n' : `（0 筆）\n\n`;
      out += `> 官網該關鍵字命中 ${siteTotal} 筆，本次掃描 ${scanned} 筆，套用條件後 ${results.length} 筆。\n`;
      if (truncated) {
        out += `> **註：官網命中 ${siteTotal} 筆，但單次只取得最新 100 筆／年度（官網分頁需瀏覽器 session、pageSize 硬上限 100），結果不完整。請縮小條件：改用標案案號、更精準的關鍵字，或逐年分開查。**\n`;
      }
      out += `> 「查看」連結可直接餵給 get_tender_detail 取標的分類與廠商資格（一次最多 8 筆）。\n`;

      return { content: [{ type: "text", text: out }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `全文檢索失敗: ${error.message}` }] };
    }
  }
);

server.tool(
  "search_tenders_by_category",
  `Search web.pcc.gov.tw by 標的分類 (procurement CATEGORY CODE, e.g. 8672 工程服務 / 521 建築施工服務) over an announcement-date range — the ONLY tool here that filters by category instead of guessing from the tender name. Use it whenever the user names category codes, or wants "all tenders of this kind" rather than a keyword match.

Unlike search_tender_archive this endpoint paginates properly, so it returns the COMPLETE result set (not just the newest 100) and reports the site's own total for cross-checking. Covers 招標公告 and 決標公告 (決標 needs tenderKind='決標'), ROC year 99 onward.

Limits: the site allows at most ${ProctrgCrawlerService.MAX_DAY_SPAN} days between publishFrom and publishTo without login — a wider range is rejected with instructions to split it. The site has no 縣市 field, so orgNameIncludes filters on 機關名稱 text (a 臺中市 agency may still procure elsewhere, and a central agency may procure in 臺中 — say so when reporting). Returns pre-formatted Markdown; output it verbatim.`,
  {
    categoryCodes: z.array(z.string()).min(1).describe("標的分類代碼，例 ['52','521','522','867','8671','8672','8673','8674']。上層碼與子碼可同時給，結果會自動去重。"),
    categoryType: z.enum(["工程類", "財物類", "勞務類"]).optional().describe("代碼所屬大類。同一代碼若在多個大類重複出現才需要指定。"),
    tenderKind: z.enum(["招標", "決標"]).optional().describe("查招標公告或決標公告，預設 招標。"),
    awardStatus: z.enum(["不限", "決標公告", "無法決標", "撤銷公告"]).optional().describe("標案狀態，只在 tenderKind='決標' 時有作用，預設 不限。"),
    publishFrom: z.string().describe("公告日期起（民國或西元皆可：115/07/01、1150701、2026-07-01）"),
    publishTo: z.string().describe("公告日期迄（同上格式）"),
    tenderWay: z.string().optional().describe("招標方式代碼，例 TENDER_WAY_1（公開招標）。預設不限。"),
    orgNameIncludes: z.array(z.string()).optional().describe("只留機關名稱含其中任一字串的案子，例 ['臺中','台中','彰化','雲林','南投']。注意這是機關名稱、不是履約地點。"),
    excludeTitleKeywords: z.array(z.string()).optional().describe("標案名稱含其中任一字串就排除，例 ['變更設計']。"),
    maxPages: z.number().optional().describe("每個分類最多翻幾頁（每頁 100 筆），預設 30。"),
  },
  async ({ categoryCodes, categoryType, tenderKind, awardStatus, publishFrom, publishTo, tenderWay, orgNameIncludes, excludeTitleKeywords, maxPages }) => {
    try {
      const from = toROCNumber(publishFrom);
      const to = toROCNumber(publishTo);
      const badDates = [!from && `publishFrom="${publishFrom}"`, !to && `publishTo="${publishTo}"`].filter(Boolean);
      if (badDates.length > 0) {
        return { content: [{ type: "text", text: `日期格式無法解析：${badDates.join('、')}。請用 115/07/01 或 2026-07-01 這類格式。` }] };
      }
      if (from! > to!) {
        return { content: [{ type: "text", text: `公告日期起 ${formatROCNumber(from!)} 晚於迄 ${formatROCNumber(to!)}，請對調。` }] };
      }
      const span = daysBetweenROC(from!, to!);
      if (span > ProctrgCrawlerService.MAX_DAY_SPAN) {
        return { content: [{ type: "text", text: `公告日期區間 ${formatROCNumber(from!)} ~ ${formatROCNumber(to!)} 共 ${span} 天，超過官網未登入時的 ${ProctrgCrawlerService.MAX_DAY_SPAN} 天上限（超過會被導去全文檢索頁）。請拆成多段分別查詢後合併。` }] };
      }

      const { found, missing, ambiguous } = await resolveCodes(categoryCodes, categoryType);
      if (ambiguous.length > 0) {
        const lines = ambiguous.map(a => `${a.code}（${a.cates.join('、')}）`).join('；');
        return { content: [{ type: "text", text: `以下代碼在多個大類都存在，請加上 categoryType 指定：${lines}` }] };
      }
      if (found.length === 0) {
        return { content: [{ type: "text", text: `給的代碼都查不到：${missing.join('、')}。標的分類代碼可在官網「標的分類查詢」頁的下拉選單看到。` }] };
      }

      const kind = tenderKind ?? '招標';
      const STATUS_MAP: Record<string, string> = {
        '不限': 'TENDER_STATUS_0', '決標公告': 'TENDER_STATUS_1',
        '無法決標': 'TENDER_STATUS_2', '撤銷公告': 'TENDER_STATUS_3',
      };

      const { results, stats, dedupedBeforeFilter, droppedByOrg, droppedByExclude } = await searchByCategories({
        cats: found,
        kind,
        tenderStatus: STATUS_MAP[awardStatus ?? '不限'],
        tenderWay,
        publishFrom: from!,
        publishTo: to!,
        orgNameIncludes,
        excludeTitleKeywords,
        maxPages,
      });

      const scope = [
        `公告日 ${formatROCNumber(from!)} ~ ${formatROCNumber(to!)}（${span} 天）`,
        `${kind}${kind === '決標' ? `／${awardStatus ?? '不限'}` : ''}`,
        `分類 ${found.map(f => f.code).join('、')}`,
      ].join('｜');

      let out = `### 標的分類查詢結果（共 ${results.length} 筆）\n\n> 範圍：${scope}\n\n`;

      out += `#### 各分類命中數\n\n| 代碼 | 名稱 | 官網總筆數 | 實際抓取 |\n| :--- | :--- | ---: | ---: |\n`;
      stats.forEach(s => {
        out += `| ${s.code} | ${s.label} | ${s.siteTotal} | ${s.fetched}${s.truncated ? ' ⚠️未抓完' : ''} |\n`;
      });
      out += `\n合計 ${stats.reduce((n, s) => n + s.fetched, 0)} 筆，跨分類去重後 ${dedupedBeforeFilter} 筆`;
      if (droppedByOrg > 0) out += `，機關名稱篩掉 ${droppedByOrg} 筆`;
      if (droppedByExclude > 0) out += `，標案名稱排除字篩掉 ${droppedByExclude} 筆`;
      out += `，最終 ${results.length} 筆。\n\n`;

      if (missing.length > 0) out += `> 注意：代碼 ${missing.join('、')} 查無此分類，已略過。\n\n`;
      if (orgNameIncludes?.length) {
        out += `> 縣市是用「機關名稱」比對（${orgNameIncludes.join('、')}）。官網此查詢沒有履約地點欄位，中央機關在該縣市的案子不會被撈到，該縣市機關在外縣市的案子則會被留下。要精確判斷履約地點需用 get_tender_detail 逐筆確認。\n\n`;
      }

      if (results.length === 0) {
        out += `套用條件後 0 筆。\n`;
        return { content: [{ type: "text", text: out }] };
      }

      out += `#### 明細\n\n| 機關 | 案號 | 標案名稱 | 招標方式 | 公告日 | ${kind === '決標' ? '決標金額' : '預算金額'} | 分類 | 連結 |\n`;
      out += `| :--- | :--- | :--- | :--- | :--- | ---: | :--- | :--- |\n`;
      results.forEach(r => {
        const title = r.name.length > 35 ? r.name.slice(0, 33) + '...' : r.name;
        out += `| ${r.orgName} | **${r.caseId}** | ${title} | ${r.tenderWay} | ${r.publishDate} | ${r.awardAmount || '-'} | ${r.matchedCode} | ${r.link ? `[查看](${r.link})` : '-'} |\n`;
      });

      const anyTruncated = stats.some(s => s.truncated);
      if (anyTruncated) {
        out += `\n> **註：有分類未抓完（已達 maxPages 上限）。請調高 maxPages 或縮短日期區間。**\n`;
      }
      out += `\n> 「查看」連結可直接餵給 get_tender_detail 取廠商資格與履約地點（一次最多 8 筆）。\n`;

      return { content: [{ type: "text", text: out }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `標的分類查詢失敗: ${error.message}` }] };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Taiwan Tender MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server fatal error:", error);
  process.exit(1);
});
