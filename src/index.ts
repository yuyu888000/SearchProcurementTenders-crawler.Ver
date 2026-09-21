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
import {
  queryAwardsByLocations, queryAwardsByVendor, exportAwards, isValidRocNumber, rocNumberToWestern, todayRocNumber, rocDaysBetween,
  AWARD_DATA_START_ROC, MAX_RANGE_DAYS,
} from "./services/award-service.js";
import { resolveCounties, listCounties, OTHER_LOCATION_CODE } from "./services/award-locations.js";
import { ExecLocationOption } from "./types/award.js";
import {
  fetchAwardDetails, renderAwardDetails, MAX_AWARD_FETCH_PER_CALL, MAX_AWARD_CASES,
  DETAIL_WINDOW_MAX, DETAIL_WINDOW_MS, FULL_FIELDS_MAX_CASES,
} from "./services/award-detail-crawler.js";
import {
  createJob, loadJob, listJobs, runJob, setJobState, jobSummary, seedVendorsFromCache, setJobPriority, JobPriority,
} from "./services/resolve-service.js";
import { rowsToExportCases, jobToExportCases, writeAwardsWorkbook, ExportCase } from "./services/award-excel.js";
import { buildVendorProfile, splitRange, CountRow } from "./services/vendor-profile.js";
import { extractPk } from "./services/detail-crawler.js";
import { hasGroqKey, NO_KEY_MESSAGE } from "./services/groq-client.js";
import {
  createRankJob, loadRankJob, listRankJobs, runRankJob, setRankState, rankSummary, rankCounts, compareRank, RankItem, BATCH_SIZE, MAX_RECHECK,
  suggestTerms,
} from "./services/topic-rank.js";
import { newUsage } from "./services/groq-client.js";
import { AwardRow } from "./types/award.js";
import { awardDedupKey } from "./services/award-service.js";
import { readFile as readFileAsync, mkdir as mkdirAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname as pathDirname, join as pathJoin, isAbsolute } from "node:path";

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
5. search_tenders／search_tender_archive／search_tenders_by_category 這三支的查詢頁
   都沒有「縣市」欄位。要依縣市篩選只能比對機關名稱（會有偏差：中央機關在該縣市的
   案子撈不到、該縣市機關在外縣市的案子會被留下），精確的履約地點要用
   get_tender_detail 逐筆確認。**回報時要講清楚用的是哪一種**。
   **search_awards 例外**：它有官網的履約地點（縣市）篩選，查決標案的縣市直接用它，見第 7 條。
6. get_tender_detail 受網站流量控制，一次最多 8 筆未快取的案子。遇到驗證碼頁就附連結
   請使用者人工開啟，**不要重試迴圈，也不要試圖繞過驗證碼**。
7. 查「已決標」案件（某期間／某縣市／某分類的決標案、決標金額）一律用 search_awards，
   **不要用 search_tender_archive 篩決標日期**——archive 的公告日是招標公告日，會篩錯。
8. 要查得標廠商／投標家數／落標廠商，用 get_award_detail（餵 search_awards 表格裡的連結）。
   **不要把決標公告或無法決標公告的連結餵給 get_tender_detail**——pk 屬於不同編號空間，會回傳別的案子。
   get_award_detail 任意 ${DETAIL_WINDOW_MS / 60000} 分鐘內最多 ${DETAIL_WINDOW_MAX} 次內頁請求（種類不符、解析失敗、連線錯誤也會佔額度），
   跨呼叫與跨行程共用，超出的會附最早可再查的時間；遇到驗證碼就停，不要重試。`,
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
  `Fetch the DETAIL page of specific tenders from web.pcc.gov.tw, given the links returned by search_tenders (or raw pk values). Returns fields that the search listing does NOT contain: 標的分類 (category code, e.g. 5177 室內裝潢工程 / 5179 其他裝修工程), 廠商資格摘要 (vendor qualification), 截止投標 with time-of-day, 決標方式, 押標金, 履約地點/期限, and agency contact info. Use this to judge whether a tender really is the type of work the user wants — the category code is far more reliable than keyword matching on the tender name. IMPORTANT: the site rate-limits detail pages; at most ${MAX_FETCH_PER_CALL} uncached tenders per call, results are cached locally so re-querying the same tender is free. If the site returns its CAPTCHA page the remaining items are reported as not-retrieved with their links — do NOT retry in a loop, tell the user to open those links manually. SCOPE: this tool is for TENDER notices (招標公告) only. Award-notice links — 決標公告 (…/common/atm?pk=), 無法決標公告 (…/common/nonAtm?pk=), or any URL carrying pkAtmMain=, which is what search_awards and search_tender_archive return for awards — live in a DIFFERENT key space and are now rejected WITHOUT a request; use get_award_detail for those. (Before this guard, feeding an award pk here silently returned a DIFFERENT tender that happened to share the number.)`,
  {
    cases: z.array(z.string()).min(1).describe("標案內頁連結（search_tenders 回傳的「查看」網址）或 pk 值，一次最多建議 8 筆"),
    full: z.boolean().optional().describe("true 則回傳內頁全部欄位（約 70 項），預設只回精選欄位"),
    rankId: z.string().optional().describe("rank_by_topic 的 rankId（招標來源）：先把 cases 依 A→B→C 排序再抓，單次上限用在最相關的案子"),
  },
  async ({ cases, full, rankId }) => {
    try {
      let ordered = cases;
      let rankNote = "";
      if (rankId) {
        const rank = await loadRankJob(rankId);
        if (!rank) return { content: [{ type: "text", text: `找不到排名 ${rankId}，用 rank_by_topic action="list" 查。` }] };
        if (rank.source === "awards") return { content: [{ type: "text", text: `排名 ${rankId} 是決標案（source="awards"），決標 pk 與招標內頁不同編號空間，不能用在 get_tender_detail。` }] };
        const byPk = new Map(rank.items.map(i => [i.pk, i]));
        const order = { A: 0, B: 1, C: 2 } as const;
        const keyed = cases.map((c, idx) => ({ c, idx, it: byPk.get(extractPk(c) ?? "") }));
        // 不在排名裡的排在 B 之後、C 之前；同組分數高先，其餘保持原順序
        const rankOf = (x: typeof keyed[number]) => x.it ? order[x.it.group ?? "C"] : 1.5;
        keyed.sort((a, b) => rankOf(a) - rankOf(b) || (b.it?.score ?? -1) - (a.it?.score ?? -1) || a.idx - b.idx);
        ordered = keyed.map(x => x.c);
        const cnt = { A: 0, B: 0, C: 0, none: 0 };
        for (const x of keyed) { if (x.it) cnt[x.it.group ?? "C"]++; else cnt.none++; }
        rankNote = `> 依排名 \`${rankId}\`（${rank.topic}）排序後抓取：A ${cnt.A}／B ${cnt.B}／C ${cnt.C}${cnt.none ? `／不在排名 ${cnt.none}` : ""}${cases.length > MAX_FETCH_PER_CALL ? `｜單次最多抓 ${MAX_FETCH_PER_CALL} 筆未快取的案子，排在後面的會列為未取得` : ""}\n\n`;
      }
      const { details, blocked, fetched } = await fetchTenderDetails(ordered);

      let out = `### 標案內頁明細（${details.length} 筆）\n\n${rankNote}`;
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
            : d.reason === 'award' ? (d.message || '這是決標類公告連結，請改用 get_award_detail')
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
  `Search the FULL-TEXT bulletin archive (電子公報全文檢索) of web.pcc.gov.tw. This is the ONLY way to find tenders whose bidding period has already CLOSED — search_tenders covers ONLY tenders still open for bidding (等標期內). Covers ROC years ${MIN_ROC_YEAR} to ${currentROCYear()}; the site accepts one year per request, so this tool queries at most ${MAX_YEARS_PER_CALL} years per call. Returns 種類 (招標公告 / 決標公告 / 無法決標公告), 機關名稱, 標案案號, 標案名稱, and BOTH dates the bulletin carries: 招標公告日 and 決標/無法決標公告日, plus 截止投標日期 and a detail link. TWO CORRECTNESS NOTES: (a) the site's own 種類 column labels 無法決標公告 as 決標公告 — this tool re-derives it from the link type (atm vs nonAtm) and the "(無法決標)" suffix, so trust the 種類 column here, not the site's; (b) this tool's publishFrom/publishTo filter and the bulletin's sort key are the 招標公告日, NOT the award date — for "which cases were awarded in period X" use search_awards instead, which filters server-side on 決標公告日. Feed 招標公告 links to get_tender_detail and 決標/無法決標公告 links to get_award_detail (different key spaces). Results are split into 等標期內 (still open) and 已截止／歷史 (closed) sections. Each year returns at most the 100 most recent matches (the site caps one response at 100 rows and its pagination needs a real browser session), and the output states the site-wide hit count whenever it is larger — narrow with a 標案案號, a tighter keyword, or one year per call instead of expecting more rows. Unless the user explicitly asked only for tenders they can still bid on, run this tool ALONGSIDE search_tenders and report both sections with their counts — write "0 筆" explicitly for an empty section instead of omitting it. This tool returns pre-formatted Markdown; output it verbatim without changing its structure.`,
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
        let t = `| 種類 | 機關 | 案號 | 標案名稱 | 招標公告日 | 決標/無法決標公告日 | 截止投標 | 狀態 | 連結 |\n`;
        t += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
        rows.forEach(r => {
          const title = r.title.length > 35 ? r.title.slice(0, 33) + '...' : r.title;
          t += `| ${r.kind} | ${r.orgName} | **${r.caseId}** | ${title} | ${r.publishDate || '-'} | ${r.awardDate || '-'} | ${r.deadline || '-'} | ${r.status} | ${r.link ? `[查看](${r.link})` : '-'} |\n`;
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
      out += `> 「種類」已依連結型態修正：官網該欄把無法決標公告也寫成「決標公告」，本表以 atm／nonAtm 與「(無法決標)」後綴判定。\n`;
      out += `> 日期有兩欄：「招標公告日」是公報排序與本工具日期篩選的依據；「決標/無法決標公告日」是決標側的日期。**要依決標期間查案件請用 search_awards**，用本工具的日期條件會篩到招標公告日。\n`;
      out += `> 招標公告的「查看」連結可餵給 get_tender_detail；決標／無法決標公告的連結要餵 get_award_detail（兩者 pk 屬不同編號空間）。\n`;

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

server.tool(
  "search_awards",
  `Query AWARDED cases (決標公告) from web.pcc.gov.tw's award-query endpoint (決標查詢 readTenderAgent). Use this — NOT search_tender_archive — for any question about awards in a period (決標案件、決標金額、某期間某縣市的決標): search_tender_archive's date is the 招標公告日 and gives wrong answers for award dates. Server-side filters verified to work: 決標公告日 range (from/to), 標的分類 (category), 履約地點 (counties — status 決標 only, see limit 5; each county auto-expands to ALL of its site codes, including the separate 原住民地區 codes and legacy pre-merger county codes such as 臺中縣, queried one by one and merged/deduplicated by 機關＋案號＋決標公告序號), plus 機關名稱 / 標案名稱 partial match and status (決標／無法決標／撤銷). Auto-paginates (100 rows/page, ≥1.5 s between requests; the listing endpoint has no CAPTCHA rate limit, detail pages are never opened). The summary reports, for every site code, 官網共有 N 筆 vs 實抓 M 筆, the total, the sum of 決標金額 and the number of correction notices, and states explicitly when maxRows truncated the result. Site limits: data only from 112/07/01 onward; one call's date range may not exceed ${MAX_RANGE_DAYS} days. The listing has NO winning-vendor column. When there are more rows than previewRows, ALL rows are written to CSV (UTF-8 with BOM, Chinese headers) and JSON under the project's .cache/exports/ and both absolute paths are returned. SEMANTIC LIMITS — tell the user whenever they affect the answer: (1) 決標公告日 ≠ 決標日: the notice usually lags the award by 1~20 days, so the right end of a recent range is structurally UNDERCOUNTED (re-query around T+30 days for completeness). (2) 履約地點 is a coarse field self-reported by the agency; it is NOT necessarily the actual work site. (3) There is an 「其他」 bucket (EXECUTE_LOCATION_20000007): cases of agencies located in the requested counties are sometimes filed there — set includeOther=true to add it (the bucket is nationwide, so judge its rows by 機關名稱). (4) Rows flagged 更正公告 show the CORRECTION date, not the original award notice date (the original can be much earlier); the date filter matches original OR correction date. (5) The 履約地點 filter does NOT work for 無法決標 notices (measured 勞務 115/07/11~09/11: 3,960 nationwide vs 6 for 臺中市 and 0 for 雲林縣; 撤銷 results likewise lose their 無法決標 rows), so status 無法決標／撤銷 combined with counties is REJECTED — query nationwide without counties and narrow with orgName instead. This tool returns pre-formatted Markdown; output it verbatim without changing its structure.`,
  {
    from: z.string().describe("決標公告日起（必填）。民國或西元皆可：115/07/11、1150711、2026-07-11、2026/07/11"),
    to: z.string().optional().describe("決標公告日迄（同上格式），預設今天"),
    category: z.enum(["工程", "財物", "勞務"]).optional().describe("標的分類；不填＝全部"),
    counties: z.array(z.string()).optional().describe("縣市名陣列，例 ['南投縣','臺中市']；台/臺皆可、可省略縣市字（有歧義如「新竹」會要求指明）。每個縣市自動展開成它全部的履約地點代碼（含原住民地區、舊制縣代碼）。不填＝全國。只能搭配 status=決標（官網履約地點篩選對無法決標公告無效）"),
    includeOther: z.boolean().optional().describe("有給 counties 時是否加查履約地點「其他」桶（全國性），預設 false"),
    orgName: z.string().optional().describe("機關名稱，部分比對"),
    tenderName: z.string().optional().describe("標案名稱，部分比對"),
    status: z.enum(["決標", "無法決標", "撤銷"]).optional().describe("標案狀態，預設 決標（決標公告）。無法決標／撤銷 不可搭配 counties，要縮小範圍請用 orgName"),
    maxRows: z.number().int().min(1).max(3000).optional().describe("最多回傳幾列，預設 500，上限 3000"),
    previewRows: z.number().int().min(0).max(500).optional().describe("回傳文字的表格只列前幾列，預設 50；結果多於此數時全部結果另存 CSV＋JSON"),
  },
  async ({ from, to, category, counties, includeOther, orgName, tenderName, status, maxRows, previewRows }) => {
    const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
    try {
      const cap = maxRows ?? 500;
      const preview = previewRows ?? 50;
      const st = status ?? "決標";

      // 有給日期卻解析不出來，直接告訴使用者，不要默默當成不限
      const fromN = toROCNumber(from);
      const toN = to ? toROCNumber(to) : todayRocNumber();
      const bad = [
        (fromN == null || !isValidRocNumber(fromN)) && `from="${from}"`,
        (toN == null || !isValidRocNumber(toN)) && `to="${to}"`,
      ].filter(Boolean);
      if (bad.length > 0 || fromN == null || toN == null) {
        return reply(`日期格式無法解析：${bad.join('、')}。請用 115/07/11 或 2026-07-11 這類格式（無法解析的日期不會被當成不限日期）。`);
      }
      if (fromN > toN) {
        return reply(`決標公告日起 ${formatROCNumber(fromN)} 晚於迄 ${formatROCNumber(toN)}，請對調。`);
      }
      if (toN < AWARD_DATA_START_ROC) {
        return reply(`官網決標查詢只提供 112/07/01 之後的資料，${formatROCNumber(fromN)} ~ ${formatROCNumber(toN)} 整段早於此，查不到。更早的決標案只能用 search_tender_archive 全文檢索（其日期是招標公告日）。`);
      }
      const notes: string[] = [];
      let effFrom = fromN;
      if (fromN < AWARD_DATA_START_ROC) {
        effFrom = AWARD_DATA_START_ROC;
        notes.push(`起日 ${formatROCNumber(fromN)} 早於官網資料下限 112/07/01，已改從 112/07/01 起查；更早的決標案此端點不提供。`);
      }
      const days = rocDaysBetween(effFrom, toN);
      if (days > MAX_RANGE_DAYS) {
        return reply(`決標公告日區間 ${formatROCNumber(effFrom)} ~ ${formatROCNumber(toN)} 相差 ${days} 天，超過官網未登入查詢上限 ${MAX_RANGE_DAYS} 天。請分段查詢；分段合併時更正公告可能在兩段各出現一次，要以 機關＋案號 去重。`);
      }

      let locations: ExecLocationOption[];
      let scopeText: string;
      if (counties && counties.some(c => c.trim())) {
        // 官網履約地點篩選對無法決標公告（nonAtm）幾乎無效，照查會回嚴重偏低的筆數，寧可拒絕
        if (st !== '決標') {
          return reply(`status=${st} 不能搭配 counties：官網的「履約地點」篩選對無法決標公告幾乎無效（撤銷查詢裡的無法決標列也一樣），照查會得到嚴重偏低的筆數，不能當成該縣市的清單，所以本工具不接受這個組合。

實測（勞務、115/07/11~09/11）：無法決標全國 3,960 筆，但履約地點＝臺中市只有 6 筆、雲林縣 0 筆，全國結果裡的「臺中市豐原區公所 11506B」不在臺中市代碼的結果中；撤銷查詢的決標公告列篩得到，無法決標列（例：新北市政府消防局、臺北市濱江實驗國民中學、國立土庫高級商工職業學校）在各自縣市代碼下都篩不到。

改法：拿掉 counties 改查全國（官網總數才正確），用 orgName 以機關名稱縮小，例如 orgName="臺中市" 會命中臺中市政府各局處、區公所、市立學校；中央機關或國立學校在該縣市的案子不會命中，要另外用機關名查。結果超過 maxRows 時請縮短日期區間。`);
        }
        const { groups, invalid } = resolveCounties(counties);
        if (invalid.length > 0) {
          const why = invalid.map(i => i.candidates.length > 0 ? `「${i.input}」有歧義：${i.candidates.join('／')}` : `「${i.input}」`).join('；');
          return reply(`縣市名無法辨識：${why}。可用縣市：${listCounties().join('、')}`);
        }
        locations = groups.flatMap(g => g.locations);
        scopeText = groups.map(g => `${g.county}（${g.locations.length} 個代碼）`).join('、');
        if (includeOther) {
          locations.push({ code: OTHER_LOCATION_CODE, label: '其他' });
          scopeText += '＋「其他」桶（全國性）';
        }
      } else {
        locations = [{ code: '', label: '不限（全國）' }];
        scopeText = '全國（不限）';
        if (includeOther) notes.push('未指定 counties 時本來就是全國查詢（已含「其他」），includeOther 不另外查。');
      }

      const r = await queryAwardsByLocations(
        { from: effFrom, to: toN, category, orgName, tenderName, status: st },
        locations,
        { maxRows: cap },
      );

      const fmt = (n: number) => n.toLocaleString('en-US');
      const statusText = st === '決標' ? '決標公告' : st === '撤銷' ? '撤銷公告' : '無法決標';
      const cond = [
        `決標公告日 ${formatROCNumber(effFrom)} ~ ${formatROCNumber(toN)}（送出 ${rocNumberToWestern(effFrom)}~${rocNumberToWestern(toN)}）`,
        `標的分類 ${category ?? '不限'}`,
        `狀態 ${statusText}`,
        `履約地點 ${scopeText}`,
        orgName && `機關含「${orgName}」`,
        tenderName && `標案名稱含「${tenderName}」`,
      ].filter(Boolean).join('｜');

      // 有代碼沒拿到官網總數時，加總只是下限
      const siteTotalTxt = (r.siteTotalIsLowerBound ? '至少 ' : '') + fmt(r.siteTotal);
      let out = `### 決標查詢：回傳 ${fmt(r.rows.length)} 筆（官網共有 ${siteTotalTxt} 筆）\n\n> 條件：${cond}\n\n`;
      out += `#### 各履約地點代碼\n\n`;
      for (const p of r.perLocation) {
        const state = p.skipped ? '未查（前面已遭官網封鎖）'
          : p.error ? `失敗：${p.error}`
          : p.truncated ? '達 maxRows 截斷'
          : p.fetched === p.siteTotal ? '完整' : '筆數不符';
        out += `- ${p.label}（${p.code || '不限'}）：官網共有 ${p.siteTotal == null ? '?' : fmt(p.siteTotal)} 筆／實抓 ${fmt(p.fetched)} 筆｜${state}\n`;
      }

      const withAmount = r.rows.filter(x => x.amount != null);
      const amountSum = withAmount.reduce((s, x) => s + (x.amount ?? 0), 0);
      const corrections = r.rows.filter(x => x.isCorrection).length;
      out += `\n#### 摘要\n\n`;
      out += `- 總筆數：官網共有 ${siteTotalTxt} 筆；實抓 ${fmt(r.fetchedTotal)} 筆；合併去重後回傳 ${fmt(r.rows.length)} 筆`;
      out += r.duplicates > 0 ? `（去除重複 ${r.duplicates} 筆，鍵＝機關＋案號＋決標公告序號）\n` : `\n`;
      out += `- 決標金額合計：${fmt(amountSum)} 元（${fmt(withAmount.length)} 筆有金額；未公開／空白 ${fmt(r.rows.length - withAmount.length)} 筆不計）\n`;
      out += `- 更正公告：${fmt(corrections)} 筆（這些列顯示的是更正日，不是原決標公告日）\n`;
      if (r.truncated) {
        out += `- **已截斷：官網共有 ${siteTotalTxt} 筆，maxRows=${cap}，實際只回傳 ${fmt(r.rows.length)} 筆。要完整結果請調高 maxRows（上限 3000）或縮小條件。**\n`;
      }
      if (r.hasError) {
        out += `- **有代碼查詢失敗或未查，結果不完整（見上方各代碼狀態）。**\n`;
      }
      if (st === '撤銷') notes.push('撤銷公告列的日期欄可能是原公告日而非撤銷日（實測出現區間外日期）。');
      notes.forEach(n => { out += `- ${n}\n`; });
      out += `- 本次連線 ${r.requests} 次（僅清單端點，未開內頁）\n`;
      out += `\n> 提醒：決標公告日 ≠ 決標日，公告通常落後 1～20 天，區間右端會低估｜履約地點是機關自填的粗欄位，不等於實際施作地｜有「其他」桶，本次${locations.some(l => l.code === OTHER_LOCATION_CODE || l.code === '') ? '已涵蓋' : '未查（可加 includeOther=true）'}｜清單沒有得標廠商欄位\n`;

      if (r.rows.length > preview) {
        try {
          const { csvPath, jsonPath } = await exportAwards(r.rows, {
            query: { from: formatROCNumber(effFrom), to: formatROCNumber(toN), category: category ?? null, status: st, counties: counties ?? null, includeOther: Boolean(includeOther), orgName: orgName ?? null, tenderName: tenderName ?? null, maxRows: cap },
            perLocation: r.perLocation,
            siteTotal: r.siteTotal,
            truncated: r.truncated,
          });
          out += `\n**全部 ${fmt(r.rows.length)} 筆已匯出（下表只列前 ${preview} 筆）：**\n- CSV：${csvPath}\n- JSON：${jsonPath}\n`;
        } catch (e: any) {
          out += `\n**匯出檔寫入失敗：${e.message}**（下表只列前 ${preview} 筆，其餘沒有輸出）\n`;
        }
      }

      if (r.rows.length === 0) {
        out += `\n（0 筆）\n`;
      } else if (preview > 0) {
        const cellText = (s: string) => s.replace(/\|/g, '\\|');
        out += `\n#### 前 ${Math.min(preview, r.rows.length)} 筆\n\n`;
        out += `| 決標公告日 | 履約地點 | 機關 | 案號 | 標案名稱 | 招標方式 | 決標金額 | 更正 | 連結 |\n`;
        out += `| :--- | :--- | :--- | :--- | :--- | :--- | ---: | :--- | :--- |\n`;
        for (const x of r.rows.slice(0, preview)) {
          const place = (locations.find(l => l.code === x.execLocation)?.label ?? '').replace('(非原住民地區)', '');
          const title = x.tenderName.length > 35 ? x.tenderName.slice(0, 33) + '...' : x.tenderName;
          const link = x.url ? `[${x.isNonAward ? '無法決標公告' : '決標公告'}](${x.url})` : '-';
          out += `| ${x.awardNoticeDate} | ${place} | ${cellText(x.orgName)} | ${cellText(x.caseNo)} | ${cellText(title)} | ${x.tenderWay} | ${x.amount == null ? (x.isNonAward ? '-' : '未公開') : fmt(x.amount)} | ${x.isCorrection ? '更正' : ''} | ${link} |\n`;
        }
      }

      return reply(out);
    } catch (error: any) {
      return reply(`決標查詢失敗: ${error.message}`);
    }
  }
);

server.tool(
  "get_award_detail",
  `Fetch the AWARD NOTICE detail page (決標公告內頁 QueryAtmAwardDetail, or 無法決標公告 QueryAtmNonAwardDetail) for cases given as the links in search_awards' table (or raw pk values). This is the ONLY complete source of winning vendors — the award listing has no vendor column. Per case it returns 得標廠商 with 統編, 投標廠商家數, 落標廠商, 預算金額, 總決標金額, 減標率 (1 − 總決標金額/預算金額), 決標方式, 決標日期, 決標公告日期, 履約地點（含地區）, 履約起迄, and a bidder table (序號/廠商名稱/統編/是否得標/中小企業/地址/決標金額); 無法決標 notices show the reason and dates. full=true appends every field on the page, but only for the first ${FULL_FIELDS_MAX_CASES} successful cases (the rest get the summary table only). LIMITS — tell the user whenever they affect the answer: (1) RATE LIMIT: the site CAPTCHA-locks detail pages after roughly 5~8 consecutive requests (the lock lasts 20+ minutes), so each call makes at most ${MAX_AWARD_FETCH_PER_CALL} detail-page requests, sequentially and ≥3 s apart, and this server makes at most ${DETAIL_WINDOW_MAX} detail-page requests in ANY rolling ${DETAIL_WINDOW_MS / 60000}-minute window, shared across all calls (including concurrent ones) and across MCP processes — 任意 ${DETAIL_WINDOW_MS / 60000} 分鐘內最多 ${DETAIL_WINDOW_MAX} 次內頁請求（種類不符、解析失敗、連線錯誤也會佔額度）; cases whose parse can be trusted are cached locally, and re-querying them is free and does not use that quota. Cases beyond the quota are listed as not retrieved with the earliest time they can be fetched — query them in a LATER call after that time, do not loop. If the CAPTCHA page appears the whole batch stops immediately and this server refuses further detail requests for 20 minutes (cached cases still return): do NOT retry and never try to bypass the CAPTCHA; give the user the links to open manually. (2) 統編 may be MASKED (e.g. F1275*****, sole proprietors / individuals) — it is reported as-is, never guess the hidden digits. (3) 決標公告日期 ≠ 決標日期: the notice usually lags the award by 1~20 days. (4) Pass the FULL link: a bare pk carries no path to tell 決標 from 無法決標, so it is treated as a 決標公告. (5) Tender-notice links (tpam?pk= / searchTenderDetail?pkPmsMain=) are rejected — use get_tender_detail for 招標公告; conversely never feed 決標／無法決標 links to get_tender_detail (different pk key space, it returns a WRONG case). This tool returns pre-formatted Markdown; output it verbatim without changing its structure.`,
  {
    cases: z.array(z.string()).min(1).max(MAX_AWARD_CASES).describe(`search_awards 表格裡的「決標公告／無法決標公告」連結，或 pk 值（純 pk 預設當決標公告），1~${MAX_AWARD_CASES} 筆；每次最多 ${MAX_AWARD_FETCH_PER_CALL} 次內頁請求，且任意 ${DETAIL_WINDOW_MS / 60000} 分鐘內合計最多 ${DETAIL_WINDOW_MAX} 次內頁請求（跨呼叫與跨行程共用）`),
    full: z.boolean().optional().describe(`true 則另附內頁全部欄位（只列前 ${FULL_FIELDS_MAX_CASES} 筆成功案），預設 false 只回精選欄位與投標廠商表`),
  },
  async ({ cases, full }) => {
    try {
      const batch = await fetchAwardDetails(cases);
      return { content: [{ type: "text", text: renderAwardDetails(batch, { full: Boolean(full) }) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `取得決標公告內頁失敗: ${error.message}` }] };
    }
  }
);

server.tool(
  "find_awards_by_vendor",
  `Find which cases a VENDOR won (and optionally which it merely bid on and lost) from web.pcc.gov.tw's award-query listing. Give a 統一編號 (8 digits, exact and safest) or a company name (PARTIAL match: 「中興工程顧問」 also matches 「中興工程顧問社」, a different company). Verified live 2026-09-16: gottenVendorId / gottenVendorName / submitVendorId / submitVendorName all filter server-side, and the listing endpoint has NO CAPTCHA rate limit, so one vendor costs about one request — this is the fast way to answer "what has firm X won lately", competitor tracking, or checking a vendor before working with them. includeBids=true additionally queries the BIDDER field and reports 投標但未得標 cases (won set subtracted), which otherwise would require opening each award notice. Results are NATIONWIDE (no 履約地點 filter) within the 決標公告日 range; the site only covers 112/07/01 onward and one call's range may not exceed ${MAX_RANGE_DAYS} days. The listing gives 決標金額 but NOT the vendor's own share in a joint bid — use get_award_detail on a specific case for bidder-level numbers. CAVEATS: (1) name matching is substring-based, so a short name can pull in unrelated firms and a firm registered under a slightly different legal name will be missed — prefer 統一編號; (2) 決標公告日 ≠ 決標日 (the notice lags 1~20 days), so recent cases may not be listed yet; (3) rows flagged 更正公告 show the correction date. This tool returns pre-formatted Markdown; output it verbatim.`,
  {
    vendors: z.array(z.string().min(2)).min(1).max(20).describe("廠商統一編號（8 碼數字，精準）或廠商名稱（部分比對），一次最多 20 家"),
    from: z.string().describe("決標公告日起（必填）。民國或西元皆可：115/07/11、1150711、2026-07-11"),
    to: z.string().optional().describe("決標公告日迄（同上格式），預設今天"),
    category: z.enum(["工程", "財物", "勞務"]).optional().describe("標的分類；不填＝全部"),
    includeBids: z.boolean().optional().describe("true 則另查「投標廠商」欄，列出投標但未得標的案子（每家多一次請求），預設 false"),
    maxRowsPerVendor: z.number().int().min(1).max(1000).optional().describe("每家廠商最多回傳幾列，預設 200"),
    previewRows: z.number().int().min(0).max(200).optional().describe("每家在表格中最多列出幾列，預設 30；超過的全部結果會另存 CSV＋JSON"),
  },
  async ({ vendors, from, to, category, includeBids, maxRowsPerVendor, previewRows }) => {
    const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
    try {
      const cap = maxRowsPerVendor ?? 200;
      const preview = previewRows ?? 30;

      const fromN = toROCNumber(from);
      const toN = to ? toROCNumber(to) : todayRocNumber();
      if (fromN == null || !isValidRocNumber(fromN) || toN == null || !isValidRocNumber(toN)) {
        return reply(`日期格式無法解析：${fromN == null || !isValidRocNumber(fromN) ? `from="${from}"` : ''}${toN == null || !isValidRocNumber(toN) ? ` to="${to}"` : ''}。請用 115/07/11 或 2026-07-11 這類格式。`);
      }
      if (fromN > toN) return reply(`起日 ${formatROCNumber(fromN)} 晚於迄日 ${formatROCNumber(toN)}，請對調。`);
      if (toN < AWARD_DATA_START_ROC) return reply(`官網決標查詢只提供 112/07/01 之後的資料，${formatROCNumber(fromN)} ~ ${formatROCNumber(toN)} 整段早於此。`);
      const effFrom = Math.max(fromN, AWARD_DATA_START_ROC);
      const days = rocDaysBetween(effFrom, toN);
      if (days > MAX_RANGE_DAYS) {
        return reply(`決標公告日區間相差 ${days} 天，超過官網上限 ${MAX_RANGE_DAYS} 天，請分段查詢。`);
      }

      const fmt = (n: number) => n.toLocaleString('en-US');
      const uniq = [...new Set(vendors.map(v => v.trim()).filter(Boolean))];
      const results = [];
      for (const v of uniq) {
        results.push(await queryAwardsByVendor(
          { from: effFrom, to: toN, category, status: '決標' },
          v,
          { maxRows: cap, includeBids: Boolean(includeBids) },
        ));
        if (results[results.length - 1].blocked) break;
      }

      let out = `### 廠商反查決標案件（${results.length} 家）\n\n`;
      out += `> 決標公告日 ${formatROCNumber(effFrom)} ~ ${formatROCNumber(toN)}｜標的分類 ${category ?? '不限'}｜全國（不限履約地點）｜${includeBids ? '含投標未得標' : '只查得標'}\n\n`;

      const allRows: typeof results[number]['won'] = [];
      for (const r of results) {
        const wonAmt = r.won.reduce((s, x) => s + (x.amount ?? 0), 0);
        out += `#### ${r.vendor}${r.byId ? '（統編）' : '（名稱部分比對）'}\n\n`;
        if (r.error) out += `- **查詢異常：${r.error}**\n`;
        out += `- 得標 ${fmt(r.won.length)} 件（官網共 ${fmt(r.siteTotalWon)} 件）｜決標金額合計 ${fmt(wonAmt)} 元\n`;
        if (includeBids) {
          out += r.siteTotalBid == null
            ? `- 投標未得標：未查詢\n`
            : `- 投標未得標 ${fmt(r.lost.length)} 件（投標總計 ${fmt(r.siteTotalBid)} 件，扣掉得標 ${fmt(r.won.length)} 件）\n`;
        }
        if (r.truncated) out += `- **已達 maxRowsPerVendor=${cap} 截斷，官網件數見上方**\n`;

        const rows = [...r.won.map(x => ({ x, tag: '得標' })), ...r.lost.map(x => ({ x, tag: '投標未得標' }))];
        allRows.push(...r.won, ...r.lost);
        if (rows.length === 0) {
          out += `\n（這個區間內查無案件）\n\n`;
          continue;
        }
        out += `\n| 決標公告日 | 結果 | 機關 | 案號 | 標案名稱 | 決標金額 | 更正 | 連結 |\n`;
        out += `| :--- | :--- | :--- | :--- | :--- | ---: | :--- | :--- |\n`;
        for (const { x, tag } of rows.slice(0, preview)) {
          const title = x.tenderName.length > 32 ? x.tenderName.slice(0, 30) + '...' : x.tenderName;
          const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          out += `| ${x.awardNoticeDate} | ${tag} | ${cell(x.orgName)} | ${cell(x.caseNo)} | ${cell(title)} | ${x.amount == null ? '未公開' : fmt(x.amount)} | ${x.isCorrection ? '更正' : ''} | ${x.url ? `[公告](${x.url})` : '-'} |\n`;
        }
        if (rows.length > preview) out += `\n> 這家還有 ${fmt(rows.length - preview)} 列未列出（見下方匯出檔）。\n`;
        out += `\n`;
      }

      if (allRows.length > preview) {
        try {
          const { csvPath, jsonPath } = await exportAwards(allRows, {
            tool: 'find_awards_by_vendor', vendors: uniq, includeBids: Boolean(includeBids),
            from: formatROCNumber(effFrom), to: formatROCNumber(toN), category: category ?? null,
          });
          out += `**全部 ${fmt(allRows.length)} 列已匯出：**\n- CSV：${csvPath}\n- JSON：${jsonPath}\n\n`;
        } catch (e: any) {
          out += `**匯出檔寫入失敗：${e.message}**\n\n`;
        }
      }

      const blocked = results.some(r => r.blocked);
      if (blocked) out += `> **官網對本次連線啟動流量控制，已停止後續廠商的查詢（清單端點少見，請稍後再試，不要重複重試）。**\n`;
      out += `> 本次連線 ${fmt(results.reduce((s, r) => s + r.requests, 0))} 次（僅清單端點）。\n`;
      out += `> 名稱是部分比對（「中興工程顧問」會連「中興工程顧問社」一起命中），要精準請給 8 碼統一編號；決標公告日落後決標日 1~20 天，最近的案子可能還沒公告。\n`;
      out += `> 清單沒有共同投標時各家的分攤金額，要看個別廠商金額請對該案用 get_award_detail。\n`;

      return reply(out);
    } catch (error: any) {
      return reply(`廠商反查失敗: ${error.message}`);
    }
  }
);

server.tool(
  "resolve_award_vendors",
  `Batch-resolve WINNING VENDORS for a whole set of awarded cases, working around the detail-page CAPTCHA rate limit. Runs as a BACKGROUND JOB with a persisted, resumable state file — start it, then poll with action="status"; it keeps going while this MCP server process lives (restarting Claude restarts the process, so re-run action="start" with the same jobId to resume). Strategy, alternating automatically: (1) FREE lookups — the same firm usually wins several cases, so every known vendor name/統編 is reverse-queried on the listing endpoint (no CAPTCHA limit), often resolving many cases per request; every vendor newly discovered from a detail page is queued for lookup too; (2) DIRECTORY lookups (directory param, default "local") — full legal names from the MOEA company registry (工程顧問/技術顧問/景觀/工程設計/環境工程/測量) plus the architect-office roster are reverse-queried one per request, firms registered in the cases' counties first; "local" scans only those (measured: 1,605 local firms resolved 110 of 221 leftover cases in ~55 min, while the other ~5,600 firms would add ~3 h for ~20-40 more), "all" continues nationwide, "off" skips; the directory is cached 7 days; 技師事務所 have no open roster so they still need detail pages; (3) RATE-LIMITED detail pages — whatever is left is opened one by one, largest 決標金額 first, honouring the shared ${DETAIL_WINDOW_MAX}-requests-per-${DETAIL_WINDOW_MS / 60000}-minutes budget, so the valuable cases land first and the job survives being interrupted. Measured on a real 341-case batch: detail pages alone would take ~14 h; with lookups most cases resolve in a fraction of that. action="start" takes either explicit cases (pk/links) or a query (from/to/category/counties) that it runs through the same search as search_awards. action="result" returns the table and writes CSV+JSON under .cache/exports/. NOTE: lookup-resolved rows give the vendor name (and 統編 when looked up by id) but NOT 投標家數/落標廠商/預算/減標率 — those only come from the detail page; the 資料來源 column says which is which.`,
  {
    action: z.enum(["start", "status", "stop", "result", "list"]).describe("start=建立或續跑工作｜status=查進度｜stop=暫停｜result=取結果與匯出｜list=列出所有工作"),
    jobId: z.string().optional().describe("status／stop／result 必填；start 帶上則續跑該工作"),
    from: z.string().optional().describe("start 用：決標公告日起（民國或西元）"),
    to: z.string().optional().describe("start 用：決標公告日迄，預設今天"),
    category: z.enum(["工程", "財物", "勞務"]).optional().describe("start 用：標的分類"),
    counties: z.array(z.string()).optional().describe("start 用：縣市（同 search_awards，會自動展開全部代碼）"),
    includeOther: z.boolean().optional().describe("start 用：是否加查履約地點「其他」桶"),
    cases: z.array(z.string()).optional().describe("start 用：直接給決標公告連結或 pk（給了就不另外查清單）"),
    label: z.string().optional().describe("start 用：工作名稱，方便之後辨識"),
    maxCases: z.number().int().min(1).max(3000).optional().describe("start 用：案件數上限，預設 1000"),
    directory: z.enum(["off", "local", "all"]).optional().describe("start 用：名錄反查範圍。local＝只掃案件所在縣市登記的公司（預設，性價比最高）｜all＝在地掃完再掃全國（多數千次查詢、數小時）｜off＝不用名錄"),
    rankId: z.string().optional().describe("start 用：rank_by_topic 的 rankId（決標來源）。內頁改依 A→B→C 順序抓（組內分數高、金額大的先）；可對既有 jobId 加掛。免費反查不受影響"),
    skipGroupC: z.boolean().optional().describe("start 用：搭配 rankId，true＝C 組不開內頁（仍會被免費反查解出），預設 false"),
  },
  async ({ action, jobId, from, to, category, counties, includeOther, cases, label, maxCases, directory, rankId, skipGroupC }) => {
    const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
    try {
      if (action === "list") {
        const jobs = await listJobs();
        if (jobs.length === 0) return reply(`目前沒有補廠商工作。用 action="start" 建立一個。`);
        let out = `### 補廠商工作（${jobs.length} 個）\n\n| 工作 ID | 名稱 | 狀態 | 進度 | 更新時間 |\n| :--- | :--- | :--- | :--- | :--- |\n`;
        for (const j of jobs) out += `| \`${j.id}\` | ${j.label} | ${j.state} | ${j.stats.resolved}/${j.stats.total} | ${j.updatedAt} |\n`;
        return reply(out);
      }

      if (action === "status" || action === "stop" || action === "result") {
        if (!jobId) return reply(`action="${action}" 需要 jobId，用 action="list" 查現有工作。`);
        if (action === "stop") {
          const j = await setJobState(jobId, "paused");
          return reply(j ? `### 已暫停 \`${jobId}\`\n\n${jobSummary(j)}\n\n> 再用 action="start" 帶同一個 jobId 就會從斷點續跑（已解出的不會重查）。` : `找不到工作 ${jobId}`);
        }
        const job = await loadJob(jobId);
        if (!job) return reply(`找不到工作 ${jobId}，用 action="list" 查現有工作。`);
        if (action === "status") {
          const recent = job.cases.filter(c => c.status === "resolved").slice(-5);
          let out = `### 補廠商進度 \`${job.id}\`（${job.label}）\n\n${jobSummary(job)}\n`;
          if (recent.length) {
            out += `\n最近解出：\n`;
            for (const c of recent) out += `- ${c.caseNo} ${c.orgName} → **${c.winner}**（${c.source}）\n`;
          }
          return out.length ? reply(out) : reply(jobSummary(job));
        }

        // result
        const fmt = (n: number) => n.toLocaleString("en-US");
        let out = `### 補廠商結果 \`${job.id}\`（${job.label}）\n\n${jobSummary(job)}\n\n`;
        const rows = job.cases.slice().sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
        out += `| 決標公告日 | 機關 | 案號 | 標案名稱 | 決標金額 | 得標廠商 | 資料來源 |\n| :--- | :--- | :--- | :--- | ---: | :--- | :--- |\n`;
        const cell = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        for (const c of rows.slice(0, 50)) {
          const title = c.tenderName.length > 30 ? c.tenderName.slice(0, 28) + "..." : c.tenderName;
          out += `| ${c.awardNoticeDate} | ${cell(c.orgName)} | ${cell(c.caseNo)} | ${cell(title)} | ${c.amount == null ? "未公開" : fmt(c.amount)} | ${c.winner ? cell(c.winner) : "（未取得）"} | ${c.source ?? "-"} |\n`;
        }
        if (rows.length > 50) out += `\n> 表格只列前 50 件（依決標金額排序），完整結果見匯出檔。\n`;
        try {
          const { csvPath, jsonPath } = await exportAwards(
            rows.map(c => ({
              pk: c.pk, linkType: "atm", url: c.url, orgName: c.orgName, caseNo: c.caseNo, isCorrection: false,
              tenderName: `${c.tenderName}`, tenderWay: "", category: "", awardNoticeDate: c.awardNoticeDate,
              amount: c.amount, awardSeq: "", nonAwardSeq: "", isNonAward: false, execLocation: "",
            })),
            { tool: "resolve_award_vendors", jobId: job.id, label: job.label, stats: job.stats, winners: rows.map(c => ({ caseNo: c.caseNo, orgName: c.orgName, winner: c.winner ?? null, winnerId: c.winnerId ?? null, source: c.source ?? null, bidderCount: c.bidderCount ?? null, losers: c.losers ?? null, budget: c.budget ?? null, totalAward: c.totalAward ?? null })) },
          );
          out += `\n**匯出：**\n- CSV：${csvPath}\n- JSON（含得標廠商、統編、落標名單、預算）：${jsonPath}\n`;
        } catch (e: any) {
          out += `\n**匯出失敗：${e.message}**\n`;
        }
        out += `\n> 「反查」來源只有得標廠商名稱（用統編查的另有統編），沒有投標家數／落標廠商／預算／減標率；那些只在內頁有。\n`;
        return reply(out);
      }

      // ---- start ----
      // 排名先驗證，免得清單查完、工作建好才發現 rankId 不能用
      let priority: JobPriority | undefined;
      if (skipGroupC && !rankId) return reply(`skipGroupC 要搭配 rankId 使用。`);
      if (rankId) {
        const rank = await loadRankJob(rankId);
        if (!rank) return reply(`找不到排名 ${rankId}，用 rank_by_topic action="list" 查。`);
        if (rank.source === "tenders") return reply(`排名 ${rankId} 是招標案（source="tenders"），pk 與決標公告不同編號空間，不能用在補得標廠商；請用決標來源重新排名。`);
        if (rank.state !== "done") return reply(`排名 ${rankId} 還沒完成（${rank.state}：${rank.message}），分組會再變動，請等完成後再掛上。`);
        priority = { rankId, topic: rank.topic, skipGroupC: Boolean(skipGroupC), ranks: Object.fromEntries(rank.items.map(i => [i.pk, { group: i.group ?? "C", score: i.score }])) };
      }

      let job = jobId ? await loadJob(jobId) : null;
      if (!job) {
        const fromN = from ? toROCNumber(from) : null;
        const toN = to ? toROCNumber(to) : todayRocNumber();
        if (!cases?.length && (fromN == null || !isValidRocNumber(fromN))) {
          return reply(`start 需要 cases（決標公告連結／pk）或 from（決標公告日起）。給 from 時格式要像 115/07/11 或 2026-07-11。`);
        }
        let rows: any[] = [];
        let rangeFrom = fromN ?? AWARD_DATA_START_ROC;
        const rangeTo = toN == null || !isValidRocNumber(toN) ? todayRocNumber() : toN;

        if (cases?.length) {
          // 直接給案子：從連結取 pk，其餘欄位待內頁補
          rows = cases.slice(0, maxCases ?? 1000).map(s => {
            const m = String(s).match(/[?&]pk(?:AtmMain)?=([A-Za-z0-9+/=%]+)/i);
            const pk = m ? decodeURIComponent(m[1]) : String(s).trim();
            return { pk, linkType: "atm", url: /^https?:/i.test(String(s)) ? String(s).trim() : `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${encodeURIComponent(pk)}`, orgName: "", caseNo: "", isCorrection: false, tenderName: "(待內頁補)", tenderWay: "", category: "", awardNoticeDate: "", amount: null, awardSeq: "", nonAwardSeq: "", isNonAward: false, execLocation: "" };
          });
        } else {
          const locs: ExecLocationOption[] = (() => {
            if (!counties?.length) return [{ code: "", label: "不限（全國）" }];
            const { groups, invalid } = resolveCounties(counties);
            if (invalid.length) throw new Error(`縣市名無法辨識：${invalid.map(i => i.input).join("、")}。可用：${listCounties().join("、")}`);
            const list = groups.flatMap(g => g.locations);
            if (includeOther) list.push({ code: OTHER_LOCATION_CODE, label: "其他" });
            return list;
          })();
          const r = await queryAwardsByLocations({ from: rangeFrom, to: rangeTo, category, status: "決標" }, locs, { maxRows: maxCases ?? 1000 });
          rows = r.rows;
          if (!rows.length) return reply(`這個條件查不到決標案件，請放寬條件後再建立工作。`);
        }

        const seeds = await seedVendorsFromCache();
        job = await createJob({
          label: label ?? `${formatROCNumber(rangeFrom)}~${formatROCNumber(rangeTo)}${category ? " " + category : ""}${counties?.length ? " " + counties.join("/") : ""}`,
          range: { from: rangeFrom, to: rangeTo, category },
          rows,
          seedVendors: seeds,
          directory: directory ?? "local",
          counties,
        });
      }

      let rankNote = "";
      if (priority) {
        job = (await setJobPriority(job.id, priority)) ?? job;
        const matched = job.cases.filter(c => priority!.ranks[c.pk]).length;
        rankNote = `\n> 已掛上排名 \`${priority.rankId}\`：${matched}/${job.cases.length} 件在排名裡${matched < job.cases.length ? "（其餘排在 B 組之後、C 組之前）" : ""}${priority.skipGroupC ? "；C 組不開內頁" : ""}。`;
        if (matched === 0) rankNote += `**沒有任何案子對得上排名，順序等同沒掛**——請確認排名與這個工作是同一批決標案。`;
      }

      const started = await setJobState(job.id, "running");
      // 背景跑，不阻塞這次呼叫；狀態都落在工作檔裡，用 action="status" 查
      void runJob(job.id).catch(async (e: any) => {
        const j = await loadJob(job!.id);
        if (j) { j.state = "error"; j.message = `執行失敗：${e.message}`; await setJobState(j.id, "paused"); }
      });

      return reply(`### 已啟動補廠商工作 \`${job.id}\`\n\n${jobSummary(started ?? job)}\n\n> 種子廠商 ${job.vendorQueue.length} 家（來自先前抓過的內頁快取），先做免費反查，再用名錄反查（${job.directory?.mode ?? "off"}），最後用內頁補剩下的。名錄掃描一家約 2 秒，在地名錄通常一千多家、約 1 小時。${rankNote}\n> 用 \`action="status", jobId="${job.id}"\` 查進度；\`action="result"\` 取結果與匯出檔；\`action="stop"\` 暫停。\n> 這個工作跑在 MCP 伺服器行程裡：重開 Claude 會中斷，再用同一個 jobId 執行 start 即可續跑，已解出的不會重查。`);
    } catch (error: any) {
      return reply(`補廠商工作失敗: ${error.message}`);
    }
  }
);

server.tool(
  "export_awards_excel",
  `Export awarded cases to a multi-sheet Excel (.xlsx) report: 說明 (conditions, totals, caveats) / 明細 (every case, amounts as numbers, 案號 and 統編 as text, link column) / 縣市統計 / 機關排行 / 廠商排行 (only when vendor data exists; a multi-award case credits its full amount to each winner, stated in the sheet) / 金額級距. Two sources: (a) jobId of a resolve_award_vendors job — includes 得標廠商, 統編, 資料來源 and coverage; (b) a query (from/to/category/counties/includeOther/orgName/tenderName) run through the same listing search as search_awards — no vendor columns (the listing has none; use resolve_award_vendors first if vendors are needed). Counties come from 履約地點, and for the 「其他」 bucket, nationwide queries and resolve jobs they are inferred from the agency name (unrecognised → 「（未能判斷）」). The file goes to the project's .cache/exports/ unless outputDir (an EXISTING absolute folder) is given; existing files are never overwritten (a timestamp is appended). Same site limits as search_awards: data from 112/07/01, ≤${MAX_RANGE_DAYS} days per call, 決標公告日 ≠ 決標日. Returns Markdown with the absolute file path and a short summary; output it verbatim.`,
  {
    jobId: z.string().optional().describe("resolve_award_vendors 的工作 ID（有得標廠商欄）；給了就不用下面的查詢條件"),
    from: z.string().optional().describe("決標公告日起（沒給 jobId 時必填）。民國或西元皆可：115/07/11、2026-07-11"),
    to: z.string().optional().describe("決標公告日迄，預設今天"),
    category: z.enum(["工程", "財物", "勞務"]).optional().describe("標的分類；不填＝全部"),
    counties: z.array(z.string()).optional().describe("縣市名陣列（同 search_awards，自動展開全部代碼）；不填＝全國"),
    includeOther: z.boolean().optional().describe("有給 counties 時是否加查「其他」桶，預設 false"),
    orgName: z.string().optional().describe("機關名稱，部分比對"),
    tenderName: z.string().optional().describe("標案名稱，部分比對"),
    maxRows: z.number().int().min(1).max(5000).optional().describe("查詢模式最多幾列，預設 3000"),
    outputDir: z.string().optional().describe("輸出資料夾（絕對路徑，必須已存在）；不填＝專案 .cache/exports/"),
    fileName: z.string().optional().describe("檔名（不含路徑，可省略 .xlsx）；同名檔已存在時自動加時間戳，不覆蓋"),
  },
  async ({ jobId, from, to, category, counties, includeOther, orgName, tenderName, maxRows, outputDir, fileName }) => {
    const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
    try {
      let cases: ExportCase[];
      let meta: { title: string; conditions: [string, string][]; hasVendor: boolean };
      const notes: string[] = [];

      if (jobId) {
        const job = await loadJob(jobId);
        if (!job) return reply(`找不到補廠商工作 ${jobId}，用 resolve_award_vendors action="list" 查現有工作。`);
        cases = jobToExportCases(job);
        meta = {
          title: `決標案件與得標廠商（${job.label}）`,
          conditions: [
            ["資料來源", `resolve_award_vendors 工作 ${job.id}`],
            ["決標公告日", `${formatROCNumber(job.range.from)} ~ ${formatROCNumber(job.range.to)}`],
            ["標的分類", job.range.category ?? "不限"],
            ["工作狀態", `${job.state}｜${job.message}`],
          ],
          hasVendor: true,
        };
        if (job.state !== "done") notes.push(`工作尚未完成（${job.state}），未解出的案子得標廠商欄留空、資料來源標「未解出」。`);
      } else {
        if (!from) return reply(`需要 jobId（匯出補廠商結果）或 from（決標公告日起，匯出清單查詢結果）。`);
        const fromN = toROCNumber(from);
        const toN = to ? toROCNumber(to) : todayRocNumber();
        if (fromN == null || !isValidRocNumber(fromN) || toN == null || !isValidRocNumber(toN)) {
          return reply(`日期格式無法解析（from="${from}"${to ? `、to="${to}"` : ""}）。請用 115/07/11 或 2026-07-11 這類格式。`);
        }
        if (fromN > toN) return reply(`決標公告日起 ${formatROCNumber(fromN)} 晚於迄 ${formatROCNumber(toN)}，請對調。`);
        if (toN < AWARD_DATA_START_ROC) return reply(`官網決標查詢只提供 112/07/01 之後的資料，查不到 ${formatROCNumber(fromN)} ~ ${formatROCNumber(toN)}。`);
        const effFrom = Math.max(fromN, AWARD_DATA_START_ROC);
        if (effFrom !== fromN) notes.push(`起日早於官網資料下限，已改從 112/07/01 起查。`);
        const days = rocDaysBetween(effFrom, toN);
        if (days > MAX_RANGE_DAYS) {
          return reply(`決標公告日區間相差 ${days} 天，超過官網查詢上限 ${MAX_RANGE_DAYS} 天。請分段匯出。`);
        }

        let locations: ExecLocationOption[] = [{ code: "", label: "不限（全國）" }];
        let scopeText = "全國（不限）";
        if (counties && counties.some(c => c.trim())) {
          const { groups, invalid } = resolveCounties(counties);
          if (invalid.length > 0) {
            const why = invalid.map(i => i.candidates.length > 0 ? `「${i.input}」有歧義：${i.candidates.join("／")}` : `「${i.input}」`).join("；");
            return reply(`縣市名無法辨識：${why}。可用縣市：${listCounties().join("、")}`);
          }
          locations = groups.flatMap(g => g.locations);
          scopeText = groups.map(g => g.county).join("、");
          if (includeOther) {
            locations.push({ code: OTHER_LOCATION_CODE, label: "其他" });
            scopeText += "＋「其他」桶";
          }
        }

        const r = await queryAwardsByLocations(
          { from: effFrom, to: toN, category, orgName, tenderName, status: "決標" },
          locations,
          { maxRows: maxRows ?? 3000 },
        );
        if (!r.rows.length) return reply(`這個條件查不到決標案件${r.hasError ? "（部分查詢失敗，請稍後再試）" : ""}，沒有產出檔案。`);
        if (r.truncated) notes.push(`結果超過 maxRows（${maxRows ?? 3000}）被截斷，官網共 ${r.siteTotal.toLocaleString("en-US")} 筆；請縮短區間或提高 maxRows。`);
        if (r.hasError) notes.push(`部分履約地點代碼查詢失敗，資料可能不完整。`);
        cases = rowsToExportCases(r.rows);
        meta = {
          title: "決標案件清單",
          conditions: [
            ["資料來源", "政府電子採購網 決標查詢（清單端點，無得標廠商欄）"],
            ["決標公告日", `${formatROCNumber(effFrom)} ~ ${formatROCNumber(toN)}`],
            ["標的分類", category ?? "不限"],
            ["履約地點", scopeText],
            ...(orgName ? [["機關名稱含", orgName] as [string, string]] : []),
            ...(tenderName ? [["標案名稱含", tenderName] as [string, string]] : []),
            ["官網總筆數", `${r.siteTotal.toLocaleString("en-US")}${r.siteTotalIsLowerBound ? "（下限）" : ""}；實抓去重 ${r.rows.length.toLocaleString("en-US")}`],
          ],
          hasVendor: false,
        };
      }

      const res = await writeAwardsWorkbook(cases, meta, { outputDir, fileName });
      const fmt = (n: number) => n.toLocaleString("en-US");
      let out = `### 已匯出 Excel\n\n**檔案**：\`${res.path}\`\n\n`;
      out += `- 案件 ${fmt(res.caseCount)} 件｜決標金額合計 ${fmt(res.totalAmount)} 元`;
      if (res.vendorCoverage) out += `｜得標廠商 ${fmt(res.vendorCoverage.resolved)}/${fmt(res.vendorCoverage.total)} 件`;
      out += `\n- 工作表：${res.sheets.map(s => `${s.name}（${fmt(s.rows)}）`).join("、")}\n`;
      if (res.countyTop.length) out += `- 縣市（金額前 5）：${res.countyTop.slice(0, 5).map(c => `${c.county} ${fmt(c.count)} 件 ${fmt(c.amount)} 元`).join("；")}\n`;
      if (res.orgTop.length) out += `- 機關（金額前 5）：${res.orgTop.slice(0, 5).map(o => `${o.org} ${fmt(o.count)} 件 ${fmt(o.amount)} 元`).join("；")}\n`;
      if (res.vendorTop.length) out += `- 廠商（金額前 5，複數決標每家都計完整金額）：${res.vendorTop.slice(0, 5).map(v => `${v.vendor} ${fmt(v.count)} 件`).join("；")}\n`;
      if (notes.length) out += `\n> ${notes.join("\n> ")}\n`;
      return reply(out);
    } catch (error: any) {
      return reply(`匯出 Excel 失敗: ${error.message}`);
    }
  }
);

server.tool(
  "vendor_profile",
  `Profile ONE vendor over a period: cases won (count, total 決標金額, average, largest), cases bid on but lost and the resulting win rate, top agencies, counties (inferred from agency names), 標的分類 mix, monthly trend, and — from ALREADY-CACHED detail pages only — frequent co-bidders (how often they met, who won). Built on the listing endpoint (no CAPTCHA limit): each period segment costs ~2 requests (won + bid), and a period longer than ${MAX_RANGE_DAYS} days is split automatically and merged/deduplicated. Default period is the last 365 days (site data starts 112/07/01). Give a 統一編號 (8 digits, exact) whenever possible; a name is a PARTIAL match and can pull in other firms whose names contain it. CAVEATS to relay: (1) 決標金額 is the whole award, not this vendor's share in joint bids or multi-award contracts; (2) win rate counts award notices only (無法決標 cases are not in the bidder listing); (3) the competitor section never opens detail pages (they are CAPTCHA rate-limited) — coverage is reported as cached/total and flagged insufficient under 5 cases; run get_award_detail on the vendor's cases first to enrich it. Returns pre-formatted Markdown; output it verbatim.`,
  {
    vendor: z.string().min(1).describe("廠商統一編號（8 碼，精準，建議）或名稱（部分比對）"),
    from: z.string().optional().describe("決標公告日起，預設一年前（不早於 112/07/01）；民國或西元皆可"),
    to: z.string().optional().describe("決標公告日迄，預設今天"),
    category: z.enum(["工程", "財物", "勞務"]).optional().describe("標的分類；不填＝全部"),
    includeBids: z.boolean().optional().describe("是否查投標未得標（算得標率），預設 true，每段多 1 次請求"),
    maxRowsPerSegment: z.number().int().min(1).max(2000).optional().describe("每段每種查詢最多幾列，預設 500"),
    top: z.number().int().min(1).max(50).optional().describe("各排行列幾名，預設 10"),
  },
  async ({ vendor, from, to, category, includeBids, maxRowsPerSegment, top }) => {
    const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
    try {
      const toN = to ? toROCNumber(to) : todayRocNumber();
      if (toN == null || !isValidRocNumber(toN)) return reply(`日期格式無法解析：to="${to}"。請用 115/07/11 或 2026-07-11 這類格式。`);
      let fromN: number;
      if (from) {
        const f = toROCNumber(from);
        if (f == null || !isValidRocNumber(f)) return reply(`日期格式無法解析：from="${from}"。請用 115/07/11 或 2026-07-11 這類格式。`);
        fromN = f;
      } else {
        const t = new Date(Date.UTC(Math.floor(toN / 10000) + 1911, Math.floor((toN % 10000) / 100) - 1, toN % 100 - 365));
        fromN = (t.getUTCFullYear() - 1911) * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
      }
      if (fromN > toN) return reply(`決標公告日起 ${formatROCNumber(fromN)} 晚於迄 ${formatROCNumber(toN)}，請對調。`);
      if (toN < AWARD_DATA_START_ROC) return reply(`官網決標查詢只提供 112/07/01 之後的資料。`);
      const notes: string[] = [];
      if (fromN < AWARD_DATA_START_ROC) {
        fromN = AWARD_DATA_START_ROC;
        notes.push("起日早於官網資料下限，已改從 112/07/01 起算。");
      }

      const bids = includeBids ?? true;
      const n = top ?? 10;
      const p = await buildVendorProfile({ vendor, from: fromN, to: toN, category, includeBids: bids, maxRowsPerSegment: maxRowsPerSegment ?? 500 });
      const fmt = (x: number) => x.toLocaleString("en-US");
      const cell = (s: string) => String(s ?? "").replace(/\|/g, "\\|");
      const segCount = splitRange(fromN, toN).length;

      let out = `### 廠商側寫：${cell(p.vendor)}（${p.byId ? "統編" : "名稱部分比對"}）\n\n`;
      out += `> 決標公告日 ${formatROCNumber(fromN)} ~ ${formatROCNumber(toN)}｜標的分類 ${category ?? "不限"}｜${segCount > 1 ? `分 ${segCount} 段查詢合併｜` : ""}清單端點 ${fmt(p.requests)} 次\n\n`;

      if (p.won.length === 0 && p.lost.length === 0) {
        out += `這段期間查不到${bids ? "得標或投標" : "得標"}紀錄。${p.byId ? "" : "名稱是部分比對，請確認寫法或改用統一編號。"}\n`;
        if (p.errors.length) out += `\n> 查詢錯誤：${p.errors.join("；")}\n`;
        return reply(out);
      }

      out += `#### 概況\n\n`;
      out += `- **得標 ${fmt(p.won.length)} 件**｜決標金額合計 **${fmt(p.wonAmount)} 元**${p.wonAmountUnknown ? `（另有 ${p.wonAmountUnknown} 件金額未公開）` : ""}｜平均每件 ${fmt(Math.round(p.wonAmount / Math.max(1, p.won.length - p.wonAmountUnknown)))} 元\n`;
      if (p.largest) out += `- 最大案：${cell(p.largest.orgName)}「${cell(p.largest.tenderName)}」${fmt(p.largest.amount ?? 0)} 元（${p.largest.awardNoticeDate}）\n`;
      if (bids) out += `- 投標未得標 ${fmt(p.lost.length)} 件｜**得標率 ${p.winRate == null ? "—" : (p.winRate * 100).toFixed(1) + "%"}**（以決標公告計，不含無法決標）\n`;

      const table = (title: string, rows: CountRow[], label: string) => {
        if (!rows.length) return "";
        let t = `\n#### ${title}\n\n| ${label} | 得標件數 | 得標金額 |${bids ? " 未得標件數 |" : ""}\n| :--- | ---: | ---: |${bids ? " ---: |" : ""}\n`;
        for (const r of rows) t += `| ${cell(r.key)} | ${fmt(r.won)} | ${fmt(r.wonAmount)} |${bids ? ` ${fmt(r.lost)} |` : ""}\n`;
        return t;
      };
      out += table(`主要往來機關（前 ${Math.min(n, p.orgs.length)} / 共 ${p.orgs.length} 個）`, p.orgs.slice(0, n), "機關");
      out += table("縣市分布（由機關名稱推斷）", p.counties.slice(0, n), "縣市");
      out += table("標的分類", p.categories, "分類");
      out += table("月份趨勢（決標公告月）", p.months, "年/月");

      out += `\n#### 常同場競標的對手\n\n`;
      out += `內頁快取涵蓋 ${fmt(p.detailCoverage.cached)} / ${fmt(p.detailCoverage.total)} 件。`;
      if (p.competitorInsufficient) {
        out += `**快取案件不足 5 件，無法做有代表性的對手分析**。可先對這家的案子用 get_award_detail 抓內頁（受流量控制，10 分鐘 5 件）再重跑。\n`;
      } else {
        out += `只統計快取裡的案子，不代表全部。\n`;
      }
      if (p.competitors.length) {
        out += `\n| 對手 | 統編 | 同場次數 | 對手得標 | 本廠商得標 |\n| :--- | :--- | ---: | ---: | ---: |\n`;
        for (const c of p.competitors.slice(0, n)) out += `| ${cell(c.name)} | ${c.vendorId} | ${c.meetings} | ${c.theyWon} | ${c.weWon} |\n`;
      }

      if (p.won.length) {
        out += `\n#### 最近得標（前 ${Math.min(n, p.won.length)} 件）\n\n| 決標公告日 | 機關 | 標案名稱 | 決標金額 |\n| :--- | :--- | :--- | ---: |\n`;
        for (const r of p.won.slice(0, n)) out += `| ${r.awardNoticeDate} | ${cell(r.orgName)} | [${cell(r.tenderName)}](${r.url}) | ${r.amount == null ? "未公開" : fmt(r.amount)} |\n`;
      }

      if (!p.byId) notes.push("名稱是部分比對：名稱包含這串字的其他公司也會被算進來，要精準請改用 8 碼統一編號。");
      notes.push("決標金額是整件決標金額，共同投標或複數決標時不是這家廠商的分得金額。");
      if (p.truncated) notes.push("有區段結果超過 maxRowsPerSegment 被截斷，數字偏低；請提高上限或縮短期間。");
      if (p.blocked) notes.push("查詢途中被官網擋下，後面的區段沒有查，數字不完整。");
      if (p.errors.length) notes.push(`部分查詢失敗：${p.errors.join("；")}`);
      out += `\n> ${notes.join("\n> ")}\n`;
      return reply(out);
    } catch (error: any) {
      return reply(`廠商側寫失敗: ${error.message}`);
    }
  }
);

const RANK_EXPORT_DIR = pathJoin(pathDirname(fileURLToPath(import.meta.url)), "..", ".cache", "exports");

server.tool(
  "rank_by_topic",
  `Sort a whole list of tenders or awarded cases by TOPIC using an LLM on Groq (needs env GROQ_API_KEY; all other tools work without it), so rate-limited detail pages are spent on the right cases. It reads ONLY 機關名稱 + 標案名稱 — it never opens detail pages and never changes any site data. Every case lands in one group: A 必納 = tender name contains one of the given keywords (ALWAYS kept, the AI score can never remove it); B AI 補抓 = no keyword hit but AI score ≥2 (catches cases keywords miss — MUST be confirmed by a human, not used directly for statistics); C 低分 = neither (kept, listed last, never deleted). Runs as a BACKGROUND JOB with a persisted state file: action="start" returns a rankId immediately, poll action="status", then action="result" for tables + CSV/JSON export. Pass the rankId to resolve_award_vendors or get_tender_detail to fetch A→B→C. Case list comes from exactly one of: source="awards" (same filters as search_awards), source="tenders" (same filters as search_tenders, open-for-bidding only), or exportFile (absolute path of a JSON written by search_awards/export). MEASURED 2026-09-17 on 2,031 勞務 awards (topic 工程技術服務, compared with keyword labels + manual adjudication): the AI found ~27 real cases keywords missed but ~70 of its 436 positives were wrong (mostly the construction/maintenance work itself, not the service); in 40-item batches it scored obvious 「…委託監造設計案」 as 0 while a single re-ask gave 3, so this tool uses ${BATCH_SIZE}-item batches and re-asks (up to ${MAX_RECHECK}) low-scored cases whose name contains an AI-suggested topic term. Speed is bounded by the free Groq quota (~8,000 tokens/min ≈ 2,000 cases in ~17 min); scores are cached per model+topic+name, so re-runs and resumes are free. Tell the user: B needs review; A cases the AI scored low are listed for review too (keyword false positives). Output Markdown verbatim.`,
  {
    action: z.enum(["start", "status", "stop", "result", "list"]).describe("start=建立或續跑｜status=查進度｜stop=暫停｜result=取分組結果與匯出｜list=列出所有排名工作"),
    rankId: z.string().optional().describe("status／stop／result 必填；start 帶上則續跑"),
    topic: z.string().optional().describe("start 用：一句話描述要找什麼，例：「工程技術服務（規劃、設計、監造、專案管理、檢測鑑定）」「室內裝修工程」"),
    keywords: z.array(z.string()).optional().describe("start 用：必納關鍵字，標案名稱含任一個就進 A 組、AI 不能移出，例：['監造','委託技術服務']"),
    source: z.enum(["awards", "tenders"]).optional().describe("start 用：awards＝決標案（同 search_awards 條件）｜tenders＝等標期內招標案（同 search_tenders 條件）。給 exportFile 時不用填"),
    exportFile: z.string().optional().describe("start 用：search_awards 匯出的 JSON 絕對路徑（.cache/exports/awards_*.json），給了就不重新查清單"),
    from: z.string().optional().describe("awards：決標公告日起"),
    to: z.string().optional().describe("awards：決標公告日迄，預設今天"),
    category: z.enum(["工程", "財物", "勞務"]).optional().describe("awards：標的分類"),
    counties: z.array(z.string()).optional().describe("awards：縣市（自動展開全部履約地點代碼）"),
    includeOther: z.boolean().optional().describe("awards：加查「其他」桶"),
    orgName: z.string().optional().describe("awards／tenders：機關名稱部分比對"),
    tenderName: z.string().optional().describe("awards：標案名稱部分比對"),
    keyword: z.string().optional().describe("tenders：標案名稱關鍵字（與 orgName 至少給一個）"),
    publishFrom: z.string().optional().describe("tenders：公告日起"),
    publishTo: z.string().optional().describe("tenders：公告日迄"),
    deadlineFrom: z.string().optional().describe("tenders：截止投標日起"),
    deadlineTo: z.string().optional().describe("tenders：截止投標日迄"),
    maxCases: z.number().int().min(1).max(3000).optional().describe("start 用：案件數上限，預設 1000"),
    previewRows: z.number().int().min(0).max(300).optional().describe("result 用：每組表格最多列幾筆，預設 40；全部結果另存 CSV＋JSON"),
  },
  async (args) => {
    const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
    const fmt = (n: number) => n.toLocaleString("en-US");
    const cell = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    try {
      const { action, rankId } = args;
      if (action === "list") {
        const jobs = await listRankJobs();
        if (!jobs.length) return reply(`目前沒有排名工作。用 action="start" 建立。`);
        let out = `### 主題排名工作（${jobs.length} 個）\n\n| rankId | 主題 | 狀態 | 評分 | A/B/C | 更新時間 |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
        for (const j of jobs) {
          const c = rankCounts(j);
          out += `| \`${j.id}\` | ${cell(j.topic)} | ${j.state} | ${c.scored}/${c.total} | ${c.A}/${c.B}/${c.C} | ${j.updatedAt} |\n`;
        }
        return reply(out);
      }

      if (action === "status" || action === "stop" || action === "result") {
        if (!rankId) return reply(`action="${action}" 需要 rankId，用 action="list" 查現有工作。`);
        if (action === "stop") {
          const j = await setRankState(rankId, "paused");
          return reply(j ? `### 已暫停 \`${rankId}\`\n\n${rankSummary(j)}\n\n> 再用 action="start" 帶同一個 rankId 就會續跑，已評分的不重算。` : `找不到排名工作 ${rankId}`);
        }
        const job = await loadRankJob(rankId);
        if (!job) return reply(`找不到排名工作 ${rankId}，用 action="list" 查現有工作。`);
        if (action === "status") return reply(`### 主題排名進度 \`${job.id}\`\n\n${rankSummary(job)}`);

        // result
        const preview = args.previewRows ?? 40;
        const sorted = job.items.slice().sort(compareRank);
        const A = sorted.filter(i => i.group === "A"), B = sorted.filter(i => i.group === "B"), C = sorted.filter(i => i.group === "C");
        const aLow = A.filter(i => i.score >= 0 && i.score < 2);
        const table = (rows: RankItem[], withHits: boolean) => {
          let t = `| AI 分數 | ${withHits ? "命中關鍵字 | " : ""}機關 | 案號 | 標案名稱 | 金額 | 日期 | 連結 |\n| ---: | ${withHits ? ":--- | " : ""}:--- | :--- | :--- | ---: | :--- | :--- |\n`;
          for (const i of rows.slice(0, preview)) {
            t += `| ${i.score < 0 ? "未評" : i.score}${i.rechecked && i.score >= 0 ? "（複查）" : ""} | ${withHits ? cell((i.keywordHits ?? []).join("、")) + " | " : ""}${cell(i.orgName)} | ${cell(i.caseNo)} | ${cell(i.tenderName)} | ${i.amount == null ? "-" : fmt(i.amount)} | ${i.date} | ${i.url ? `[開啟](${i.url})` : "-"} |\n`;
          }
          if (rows.length > preview) t += `\n> 另有 ${fmt(rows.length - preview)} 筆未列出，見匯出檔。\n`;
          return t;
        };

        let out = `### 主題排名結果 \`${job.id}\`\n\n${rankSummary(job)}\n`;
        if (job.state !== "done") out += `\n> **工作尚未完成，下列分組會隨評分進度改變。**\n`;
        out += `\n#### A 必納（名稱命中關鍵字，一律保留）：${fmt(A.length)} 筆\n\n${A.length ? table(A, true) : "（0 筆）\n"}`;
        if (aLow.length) {
          out += `\n**A 組裡 AI 判低分的 ${fmt(aLow.length)} 筆**（可能是關鍵字誤判，仍保留在 A 組，建議人工看一下）：${aLow.slice(0, 15).map(i => `${cell(i.tenderName)}（${i.score}）`).join("；")}${aLow.length > 15 ? "…" : ""}\n`;
        }
        out += `\n#### B AI 補抓（關鍵字沒命中、AI 評 2~3 分）：${fmt(B.length)} 筆 — ⚠️ 需人工確認\n\n${B.length ? table(B, false) : "（0 筆）\n"}`;
        out += `\n#### C 低分：${fmt(C.length)} 筆（未刪除，排在最後；完整清單見匯出檔）\n`;
        if (job.recheckTerms?.length) {
          out += `\n> 單筆複查用的主題詞（AI 產生）：${job.recheckTerms.join("、")}｜複查 ${fmt(job.items.filter(i => i.rechecked && i.score >= 0).length)} 筆${job.recheckSkipped ? `，另有 ${fmt(job.recheckSkipped)} 筆超過上限 ${MAX_RECHECK} 未複查（依金額排序取前面）` : ""}\n`;
        }

        try {
          await mkdirAsync(RANK_EXPORT_DIR, { recursive: true });
          const base = pathJoin(RANK_EXPORT_DIR, `${job.id}`);
          const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
          const head = ["分組", "AI分數", "已複查", "命中關鍵字", "機關", "案號", "標案名稱", "金額", "日期", "連結", "pk"];
          const lines = sorted.map(i => [i.group, i.score, i.rechecked ? "是" : "", (i.keywordHits ?? []).join("、"), i.orgName, i.caseNo, i.tenderName, i.amount ?? "", i.date, i.url, i.pk].map(esc).join(","));
          await writeFileAsync(`${base}.csv`, "\uFEFF" + [head.map(esc).join(","), ...lines].join("\r\n"), "utf8");
          await writeFileAsync(`${base}.json`, JSON.stringify({ rankId: job.id, topic: job.topic, keywords: job.keywords, conditions: job.conditions, state: job.state, model: job.model, items: sorted }, null, 1), "utf8");
          out += `\n**匯出：**\n- CSV：${base}.csv\n- JSON：${base}.json\n`;
        } catch (e: any) {
          out += `\n**匯出失敗：${e.message}**\n`;
        }
        out += `\n> AI 只看機關與標案名稱打分，不開內頁、不改任何官網資料。B 組是「可能相關」，統計或交付前要人工確認；要開內頁時把 rankId 傳給 resolve_award_vendors 或 get_tender_detail，會依 A→B→C 順序抓。\n`;
        return reply(out);
      }

      // ---- start ----
      if (!hasGroqKey()) return reply(NO_KEY_MESSAGE);
      let job = rankId ? await loadRankJob(rankId) : null;
      if (rankId && !job) return reply(`找不到排名工作 ${rankId}。`);
      if (!job) {
        const topic = args.topic?.trim();
        if (!topic) return reply(`start 需要 topic（一句話描述要找的主題）。`);
        const keywords = [...new Set((args.keywords ?? []).map(k => k.trim()).filter(Boolean))];
        const cap = args.maxCases ?? 1000;
        let items: Omit<RankItem, "score">[] = [];
        let conditions = "";
        let source: "awards" | "tenders" | "export";

        if (args.exportFile) {
          source = "export";
          if (!isAbsolute(args.exportFile) || !/\.json$/i.test(args.exportFile)) return reply(`exportFile 要是 .json 的絕對路徑。`);
          const data = JSON.parse(await readFileAsync(args.exportFile, "utf8"));
          const rows: any[] = Array.isArray(data?.rows) ? data.rows : [];
          if (!rows.length) return reply(`exportFile 裡找不到 rows 陣列（要用 search_awards 匯出的 JSON）。`);
          items = rows.slice(0, cap).map(r => ({ pk: String(r.pk ?? ""), url: String(r.url ?? ""), orgName: String(r.orgName ?? ""), caseNo: String(r.caseNo ?? ""), tenderName: String(r.tenderName ?? ""), amount: typeof r.amount === "number" ? r.amount : null, date: String(r.awardNoticeDate ?? "") }));
          conditions = `匯出檔 ${args.exportFile}（${fmt(rows.length)} 筆${rows.length > cap ? `，取前 ${fmt(cap)}` : ""}）`;
        } else if (args.source === "awards") {
          source = "awards";
          const fromN = args.from ? toROCNumber(args.from) : null;
          const toN = args.to ? toROCNumber(args.to) : todayRocNumber();
          if (fromN == null || !isValidRocNumber(fromN) || toN == null || !isValidRocNumber(toN)) return reply(`source="awards" 需要可解析的 from（與 to），例：115/07/11 或 2026-07-11。`);
          if (fromN > toN) return reply(`決標公告日起晚於迄，請對調。`);
          const effFrom = Math.max(fromN, AWARD_DATA_START_ROC);
          if (rocDaysBetween(effFrom, toN) > MAX_RANGE_DAYS) return reply(`決標公告日區間超過官網上限 ${MAX_RANGE_DAYS} 天，請分段，或先用 search_awards 查好再用 exportFile。`);
          let locations: ExecLocationOption[] = [{ code: "", label: "不限（全國）" }];
          if (args.counties?.some(c => c.trim())) {
            const { groups, invalid } = resolveCounties(args.counties);
            if (invalid.length) return reply(`縣市名無法辨識：${invalid.map(i => i.input).join("、")}。可用：${listCounties().join("、")}`);
            locations = groups.flatMap(g => g.locations);
            if (args.includeOther) locations.push({ code: OTHER_LOCATION_CODE, label: "其他" });
          }
          const r = await queryAwardsByLocations({ from: effFrom, to: toN, category: args.category, orgName: args.orgName, tenderName: args.tenderName, status: "決標" }, locations, { maxRows: cap });
          if (!r.rows.length) return reply(`這個條件查不到決標案件${r.hasError ? "（部分查詢失敗）" : ""}，沒有建立工作。`);
          items = r.rows.map(x => ({ pk: x.pk, url: x.url, orgName: x.orgName, caseNo: x.caseNo, tenderName: x.tenderName, amount: x.amount, date: x.awardNoticeDate }));
          conditions = [`決標公告日 ${formatROCNumber(effFrom)}~${formatROCNumber(toN)}`, `分類 ${args.category ?? "不限"}`, `縣市 ${args.counties?.join("、") || "全國"}${args.includeOther ? "＋其他" : ""}`, args.orgName && `機關含「${args.orgName}」`, args.tenderName && `名稱含「${args.tenderName}」`, `官網 ${fmt(r.siteTotal)} 筆／取 ${fmt(r.rows.length)} 筆${r.truncated ? "（已截斷）" : ""}`].filter(Boolean).join("｜");
        } else if (args.source === "tenders") {
          source = "tenders";
          if (!args.keyword && !args.orgName) return reply(`source="tenders" 需要 keyword 或 orgName（官網招標查詢的限制）。`);
          const filter = { publishFrom: toROCNumber(args.publishFrom), publishTo: toROCNumber(args.publishTo), deadlineFrom: toROCNumber(args.deadlineFrom), deadlineTo: toROCNumber(args.deadlineTo) };
          const { results, totalBeforeFilter, hasMore } = await fetchAndFilterTenders(args.keyword ?? "", filter, args.orgName);
          if (!results.length) return reply(`這個條件查不到等標期內的招標案，沒有建立工作。`);
          items = results.slice(0, cap).map(t => ({ pk: extractPk(t.link) ?? t.link, url: t.link, orgName: t.orgName ?? "", caseNo: t.caseId, tenderName: t.title, amount: typeof t.budget === "string" && /^[\d,]+$/.test(t.budget) ? Number(t.budget.replace(/,/g, "")) : null, date: t.publishDate }));
          conditions = [`等標期內招標`, args.keyword && `名稱含「${args.keyword}」`, args.orgName && `機關含「${args.orgName}」`, `掃描 ${fmt(totalBeforeFilter)} 筆／符合 ${fmt(results.length)} 筆${hasMore ? "（官網結果超過 500 筆，已截斷）" : ""}`].filter(Boolean).join("｜");
        } else {
          return reply(`start 需要案件來源：source="awards"、source="tenders"，或 exportFile。`);
        }

        job = await createRankJob({ topic, keywords, source, conditions, items });
      }

      if (job.state === "done") return reply(`### 這個排名已完成 \`${job.id}\`\n\n${rankSummary(job)}\n\n> 用 action="result" 取分組結果。`);
      const started = await setRankState(job.id, "running");
      void runRankJob(job.id).catch(() => undefined);
      return reply(`### 已啟動主題排名 \`${job.id}\`\n\n${rankSummary(started ?? job)}\n\n> 背景執行中，用 \`action="status", rankId="${job.id}"\` 查進度、\`action="result"\` 取結果。每 ${BATCH_SIZE} 筆一批，被 Groq 限速時自動等待；重開 Claude 會中斷，用同一個 rankId 再 start 即可續跑（已評分的不重算）。`);
    } catch (error: any) {
      return reply(`主題排名失敗: ${error.message}`);
    }
  }
);

server.tool(
  "expand_keywords",
  `Widen a NAME-keyword search with synonyms: tender-name matching misses cases worded differently (「室內裝修」 vs 「裝潢」「內裝」「整修」). An LLM on Groq (env GROQ_API_KEY) proposes up to maxTerms terms for the topic — skipped entirely if you pass terms yourself — then EVERY term is queried on the real site listing and the results are merged and deduplicated. Only the term list is AI-generated; every returned row is real site data, so values cannot be wrong, but a broad term can pull in unrelated cases. Output: per-term table (命中筆數, 只靠這個詞才找到的筆數, errors/truncation — use it to drop useless or too-broad terms), the merged table with which terms matched each row, and a JSON/CSV export (for source="awards" the JSON is the same format as search_awards, so it can go straight into rank_by_topic exportFile). source="tenders" = open-for-bidding tenders (search_tenders scope; each term ≈1~5 listing requests); source="awards" = awarded cases (search_awards scope, same date/category/county filters; each term costs one or more requests PER 履約地點 code, ≥1.5 s apart — 10 terms × 4 counties can take several minutes). The listing endpoints have no CAPTCHA limit; detail pages are never opened. Output Markdown verbatim.`,
  {
    topic: z.string().min(2).describe("要找的主題，例：「室內裝修工程」"),
    source: z.enum(["tenders", "awards"]).describe("tenders＝等標期內招標案｜awards＝決標案"),
    seeds: z.array(z.string()).optional().describe("一定要查的詞（使用者自己的關鍵字），會和 AI 產生的詞一起查"),
    terms: z.array(z.string()).optional().describe("直接指定要查的詞，給了就不呼叫 AI（例如刪掉上一次太寬的詞後重查）"),
    maxTerms: z.number().int().min(1).max(15).optional().describe("AI 最多產生幾個詞，預設 8"),
    orgName: z.string().optional().describe("機關名稱部分比對（兩種來源都可用）"),
    publishFrom: z.string().optional().describe("tenders：公告日起"),
    publishTo: z.string().optional().describe("tenders：公告日迄"),
    deadlineFrom: z.string().optional().describe("tenders：截止投標日起"),
    deadlineTo: z.string().optional().describe("tenders：截止投標日迄"),
    from: z.string().optional().describe("awards：決標公告日起（必填）"),
    to: z.string().optional().describe("awards：決標公告日迄，預設今天"),
    category: z.enum(["工程", "財物", "勞務"]).optional().describe("awards：標的分類"),
    counties: z.array(z.string()).optional().describe("awards：縣市（自動展開全部履約地點代碼）"),
    includeOther: z.boolean().optional().describe("awards：加查「其他」桶"),
    maxRowsPerTerm: z.number().int().min(1).max(3000).optional().describe("awards：每個詞最多取幾列，預設 500"),
    previewRows: z.number().int().min(0).max(300).optional().describe("合併表格最多列幾筆，預設 40"),
  },
  async (args) => {
    const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
    const fmt = (n: number) => n.toLocaleString("en-US");
    const cell = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const clean = (list?: string[]) => (list ?? []).map(s => s.trim()).filter(s => s.length >= 1);
    try {
      // ---- 查詢條件先驗證，免得 AI 額度花了才發現日期錯 ----
      let awardBase: { from: number; to: number; locations: ExecLocationOption[]; scope: string } | null = null;
      let tenderFilter: { publishFrom: number | null; publishTo: number | null; deadlineFrom: number | null; deadlineTo: number | null } | null = null;
      if (args.source === "awards") {
        const fromN = args.from ? toROCNumber(args.from) : null;
        const toN = args.to ? toROCNumber(args.to) : todayRocNumber();
        if (fromN == null || !isValidRocNumber(fromN) || toN == null || !isValidRocNumber(toN)) return reply(`source="awards" 需要可解析的 from（與 to），例：115/07/11 或 2026-07-11。`);
        if (fromN > toN) return reply(`決標公告日起晚於迄，請對調。`);
        const effFrom = Math.max(fromN, AWARD_DATA_START_ROC);
        if (rocDaysBetween(effFrom, toN) > MAX_RANGE_DAYS) return reply(`決標公告日區間超過官網上限 ${MAX_RANGE_DAYS} 天，請分段。`);
        let locations: ExecLocationOption[] = [{ code: "", label: "不限（全國）" }];
        let scope = "全國";
        if (args.counties?.some(c => c.trim())) {
          const { groups, invalid } = resolveCounties(args.counties);
          if (invalid.length) return reply(`縣市名無法辨識：${invalid.map(i => i.input).join("、")}。可用：${listCounties().join("、")}`);
          locations = groups.flatMap(g => g.locations);
          scope = groups.map(g => g.county).join("、");
          if (args.includeOther) { locations.push({ code: OTHER_LOCATION_CODE, label: "其他" }); scope += "＋其他"; }
        }
        awardBase = { from: effFrom, to: toN, locations, scope };
      } else {
        const raw = { publishFrom: args.publishFrom, publishTo: args.publishTo, deadlineFrom: args.deadlineFrom, deadlineTo: args.deadlineTo };
        tenderFilter = { publishFrom: toROCNumber(raw.publishFrom), publishTo: toROCNumber(raw.publishTo), deadlineFrom: toROCNumber(raw.deadlineFrom), deadlineTo: toROCNumber(raw.deadlineTo) };
        const bad = (Object.keys(raw) as (keyof typeof raw)[]).filter(k => raw[k] && tenderFilter![k] == null);
        if (bad.length) return reply(`日期格式無法解析：${bad.map(k => `${k}="${raw[k]}"`).join("、")}。`);
      }

      // ---- 詞表 ----
      const origin = new Map<string, string>();
      for (const s of clean(args.seeds)) origin.set(s, "自訂");
      const usage = newUsage();
      const redundant: string[] = [];
      if (args.terms?.length) {
        for (const s of clean(args.terms)) if (!origin.has(s)) origin.set(s, "指定");
      } else {
        if (!hasGroqKey()) return reply(NO_KEY_MESSAGE + `\n\n（不想用 AI 的話，可以直接用 terms 參數指定要查的詞。）`);
        const ai = await suggestTerms(args.topic, args.maxTerms ?? 8, usage);
        // 查詢是名稱子字串比對：「室內裝修工程」能找到的「室內裝修」一定也找得到，查了是白花請求。
        // 只略過 AI 詞；使用者自己給的詞一律照查
        const shortestFirst = [...new Set(ai)].sort((a, b) => a.length - b.length);
        for (const s of shortestFirst) {
          if (origin.has(s)) continue;
          if ([...origin.keys()].some(k => s.includes(k))) { redundant.push(s); continue; }
          origin.set(s, "AI");
        }
        if (!ai.length && !origin.size) return reply(`AI 沒有產生可用的詞，請改用 terms 參數直接指定。`);
      }
      const termList = [...origin.keys()];

      // ---- 逐詞查詢 ----
      type Hit = { key: string; row: any; terms: string[] };
      const merged = new Map<string, Hit>();
      const stats: { term: string; hits: number; siteTotal: number | null; note: string }[] = [];
      let requests = 0;
      let stopped = false;
      for (const term of termList) {
        if (stopped) { stats.push({ term, hits: 0, siteTotal: null, note: "未查（前面查詢失敗或被擋）" }); continue; }
        let rows: { key: string; row: any }[] = [];
        let note = "";
        let siteTotal: number | null = null;
        if (awardBase) {
          const r = await queryAwardsByLocations({ from: awardBase.from, to: awardBase.to, category: args.category, orgName: args.orgName, tenderName: term, status: "決標" }, awardBase.locations, { maxRows: args.maxRowsPerTerm ?? 500 });
          requests += r.requests;
          rows = r.rows.map(x => ({ key: awardDedupKey(x), row: x }));
          siteTotal = r.siteTotal;
          if (r.truncated) note = `已截斷（官網 ${fmt(r.siteTotal)} 筆）`;
          if (r.hasError) { note = [note, "部分代碼查詢失敗"].filter(Boolean).join("；"); if (r.perLocation.some(p => p.skipped)) stopped = true; }
        } else {
          const t = await fetchAndFilterTenders(term, tenderFilter!, args.orgName);
          requests += 1;
          rows = t.results.map(x => ({ key: extractPk(x.link) ?? `${x.orgName}||${x.caseId}`, row: x }));
          if (t.hasMore) note = "官網超過 500 筆，已截斷";
        }
        for (const { key, row } of rows) {
          const h = merged.get(key);
          if (h) { if (!h.terms.includes(term)) h.terms.push(term); } else merged.set(key, { key, row, terms: [term] });
        }
        stats.push({ term, hits: rows.length, siteTotal, note });
      }

      const all = [...merged.values()];
      const uniqueOnly = (term: string) => all.filter(h => h.terms.length === 1 && h.terms[0] === term).length;
      const seedTerms = termList.filter(t => origin.get(t) === "自訂");
      const bySeeds = seedTerms.length ? all.filter(h => h.terms.some(t => seedTerms.includes(t))).length : 0;

      let out = `### 同義詞擴充查詢「${cell(args.topic)}」：合併 ${fmt(all.length)} 筆\n\n`;
      out += `> 來源：${awardBase ? `決標案｜決標公告日 ${formatROCNumber(awardBase.from)}~${formatROCNumber(awardBase.to)}｜分類 ${args.category ?? "不限"}｜${awardBase.scope}` : "等標期內招標案"}${args.orgName ? `｜機關含「${cell(args.orgName)}」` : ""}\n`;
      out += `> 詞表 ${termList.length} 個（AI ${termList.filter(t => origin.get(t) === "AI").length}／自訂 ${seedTerms.length}／指定 ${termList.filter(t => origin.get(t) === "指定").length}）｜清單查詢約 ${fmt(requests)} 次${usage.calls ? `｜Groq ${usage.calls} 次` : ""}\n\n`;
      if (seedTerms.length) out += `**只用自訂關鍵字會找到 ${fmt(bySeeds)} 筆；加上其他詞後多出 ${fmt(all.length - bySeeds)} 筆。**\n\n`;
      if (redundant.length) out += `> 略過 ${redundant.length} 個 AI 詞（包含了清單裡較短的詞，查了也不會多找到）：${redundant.map(cell).join("、")}\n\n`;

      out += `| 詞 | 來源 | 命中 | 只靠這個詞才找到 | 備註 |\n| :--- | :--- | ---: | ---: | :--- |\n`;
      for (const s of stats) {
        const broad = s.hits >= 300 ? "命中很多，可能太寬" : "";
        out += `| ${cell(s.term)} | ${origin.get(s.term)} | ${fmt(s.hits)} | ${fmt(uniqueOnly(s.term))} | ${[s.note, broad].filter(Boolean).join("；")} |\n`;
      }

      const preview = args.previewRows ?? 40;
      if (all.length) {
        const sorted = awardBase
          ? all.sort((a, b) => String(b.row.awardNoticeDate).localeCompare(String(a.row.awardNoticeDate)))
          : all.sort((a, b) => String(a.row.deadline).localeCompare(String(b.row.deadline)));
        out += `\n#### 合併結果（前 ${Math.min(preview, sorted.length)} 筆）\n\n`;
        if (awardBase) {
          out += `| 決標公告日 | 機關 | 案號 | 標案名稱 | 決標金額 | 命中的詞 | 連結 |\n| :--- | :--- | :--- | :--- | ---: | :--- | :--- |\n`;
          for (const h of sorted.slice(0, preview)) {
            const x: AwardRow = h.row;
            out += `| ${x.awardNoticeDate} | ${cell(x.orgName)} | ${cell(x.caseNo)} | ${cell(x.tenderName)} | ${x.amount == null ? "未公開" : fmt(x.amount)} | ${cell(h.terms.join("、"))} | ${x.url ? `[公告](${x.url})` : "-"} |\n`;
          }
        } else {
          out += `| 機關 | 案號 | 標案名稱 | 預算金額 | 公告日 | 截止投標 | 命中的詞 | 連結 |\n| :--- | :--- | :--- | ---: | :--- | :--- | :--- | :--- |\n`;
          for (const h of sorted.slice(0, preview)) {
            const x = h.row;
            out += `| ${cell(x.orgName)} | ${cell(x.caseId)} | ${cell(x.title)} | ${x.budget} | ${x.publishDate} | ${x.deadline} | ${cell(h.terms.join("、"))} | ${x.viewLink ? `[查看](${x.viewLink})` : "-"} |\n`;
          }
        }
        if (sorted.length > preview) out += `\n> 另有 ${fmt(sorted.length - preview)} 筆未列出，見匯出檔。\n`;

        try {
          if (awardBase) {
            const { csvPath, jsonPath } = await exportAwards(sorted.map(h => h.row), { tool: "expand_keywords", topic: args.topic, terms: stats.map(s => ({ ...s, origin: origin.get(s.term), uniqueOnly: uniqueOnly(s.term) })), matchedTerms: Object.fromEntries(sorted.map(h => [h.key, h.terms])) });
            out += `\n**匯出（JSON 可直接給 rank_by_topic 的 exportFile）：**\n- CSV：${csvPath}\n- JSON：${jsonPath}\n`;
          } else {
            await mkdirAsync(RANK_EXPORT_DIR, { recursive: true });
            const base = pathJoin(RANK_EXPORT_DIR, `expand_tenders_${Date.now()}`);
            const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
            const head = ["機關", "案號", "標案名稱", "預算金額", "公告日", "截止投標", "命中的詞", "連結"];
            const lines = sorted.map(h => [h.row.orgName, h.row.caseId, h.row.title, h.row.budget, h.row.publishDate, h.row.deadline, h.terms.join("、"), h.row.viewLink].map(esc).join(","));
            await writeFileAsync(`${base}.csv`, String.fromCharCode(0xfeff) + [head.map(esc).join(","), ...lines].join("\r\n"), "utf8");
            // rows 欄位名對齊 search_awards 匯出，讓 rank_by_topic 的 exportFile 也吃得下（日期放公告日）
            const rows = sorted.map(h => ({ pk: extractPk(h.row.link) ?? "", url: h.row.link, orgName: h.row.orgName, caseNo: h.row.caseId, tenderName: h.row.title, amount: /^[\d,]+$/.test(String(h.row.budget)) ? Number(String(h.row.budget).replace(/,/g, "")) : null, awardNoticeDate: h.row.publishDate, deadline: h.row.deadline, matchedTerms: h.terms }));
            await writeFileAsync(`${base}.json`, JSON.stringify({ tool: "expand_keywords", source: "tenders", topic: args.topic, terms: stats, exportedAt: new Date().toISOString(), rowCount: rows.length, rows }, null, 1), "utf8");
            out += `\n**匯出（JSON 可直接給 rank_by_topic 的 exportFile）：**\n- CSV：${base}.csv\n- JSON：${base}.json\n`;
          }
        } catch (e: any) {
          out += `\n**匯出失敗：${e.message}**\n`;
        }
      } else {
        out += `\n（0 筆）\n`;
      }

      if (stopped) out += `\n> **查詢途中有代碼被官網擋下或失敗，後面的詞沒有查，結果不完整。請稍後再試，不要馬上重查。**\n`;
      out += `\n> 詞表中「AI」的詞是模型產生的，每一列資料都來自官網清單查詢；詞太寬會混進不相關的案子，可用「只靠這個詞才找到」判斷，刪掉後用 terms 參數重查。要再篩相關性可把匯出 JSON 交給 rank_by_topic。\n`;
      return reply(out);
    } catch (error: any) {
      return reply(`同義詞擴充查詢失敗: ${error.message}`);
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
