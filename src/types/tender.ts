export interface Tender {
  /** 標案案號 */
  id: string;
  /** 標案名稱 */
  name: string;
  /** 機關名稱 */
  orgName: string;
  /** 剩餘天數 (截止 - 現在) */
  remainingDays?: string;
  /** 等標期 (截止 - 公告) */
  tenderPeriod?: string;
  /** 招標方式 */
  tenderWay: string;
  /** 招標類型 */
  tenderType: string;
  /** 公告日期 */
  publishDate: string;
  /** 截止投標日期 */
  endDate: string;
  /** 預算金額 */
  budget?: number;
  /** 標案連結 */
  link: string;
  /** 檢視連結 (通常同 link) */
  viewLink?: string;
  /** 來源 (API 或 Web) */
  source?: 'api' | 'web';
}

export interface SearchParams {
  tenderName: string;
  /** 機關名稱，官網欄位 orgName，部分比對（「空軍」可命中「國防部空軍司令部」） */
  orgName?: string;
  tenderType?: string;
  tenderWay?: string;
  /** 單頁筆數，政府採購網最大可接受 100 */
  pageSize?: number;
  /** 最多抓幾頁（避免關鍵字太廣時無限翻頁） */
  maxPages?: number;
}

/** 單一標案內頁的解析結果 */
export interface TenderDetail {
  /** 傳入的原始識別字串（連結或 pk） */
  input: string;
  /** 解析出的 pkPmsMain */
  pk: string;
  /** 內頁網址 */
  url: string;
  /** 是否成功取得內容（false 代表被驗證碼擋或版型不符） */
  ok: boolean;
  /** 失敗原因：captcha=流量控制驗證碼、parse=版型不符、error=連線錯誤、award=決標類公告連結（請改用 get_award_detail） */
  reason?: 'captcha' | 'parse' | 'error' | 'award';
  /** 錯誤訊息（reason=error 時） */
  message?: string;
  /** 欄位表（label -> value） */
  fields: Record<string, string>;
  /** 這筆是否來自本地快取 */
  cached: boolean;
}

/** 日期區間過濾條件，皆為民國 yyyMMdd 整數（例：1150701） */
export interface DateFilter {
  /** 公告日期起 */
  publishFrom?: number | null;
  /** 公告日期迄 */
  publishTo?: number | null;
  /** 截止投標日起 */
  deadlineFrom?: number | null;
  /** 截止投標日迄 */
  deadlineTo?: number | null;
}

/** 全文檢索可查的公報種類（官網 tenderStatusType 欄位值） */
export type TenderStatusType = '招標' | '決標' | '公開閱覽及公開徵求' | '政府採購預告';

/** 全文檢索（電子公報）的一筆公報紀錄，含已截止的歷史案 */
export interface ArchiveTender {
  /** 去重用的鍵（優先用內頁連結） */
  key: string;
  /** 種類（已修正）：招標公告 / 決標公告 / 無法決標公告 / 更正公告… */
  kind: string;
  /** 官網「種類」欄原文——它把無法決標也寫成「決標公告」，僅供對照 */
  siteKind: string;
  /** 是否為無法決標公告（依連結 nonAtm 或「(無法決標)」後綴判定） */
  isNonAward: boolean;
  /** 機關名稱 */
  orgName: string;
  /** 標案案號 */
  caseId: string;
  /** 標案名稱（藏在 pageCode2Img 的 JS 裡，已抽出） */
  name: string;
  /** 招標公告日期 */
  publishDate: string;
  /** 決標或無法決標公告日期 */
  awardDate: string;
  /** 截止投標日期 */
  endDate: string;
  /** 這筆是從哪個民國年度的公報查到的 */
  year: number;
  /** 標案內頁連結（tpam?pk=…，可直接餵 get_tender_detail） */
  link: string;
}

export interface ArchiveSearchParams {
  /** 全文查詢字串，支援 AND/OR/NOT 布林語法 */
  querySentence: string;
  /** 民國年，官網一次只吃一年 */
  year: number;
  statusTypes: TenderStatusType[];
  /** true（預設）只比對機關名＋標案名；false 會比對公告全文，命中量暴增 */
  matchNameOnly?: boolean;
}

/** 標的分類三大類，對應官網 radProctrgCate 與 proctrgCode1/2/3 欄位 */
export type ProctrgCateName = '工程類' | '財物類' | '勞務類';

/** 一筆標的分類代碼（來自 /ccs/queryCPCsByType） */
export interface CpcCategory {
  /** 分類代碼，例：8672 */
  code: string;
  /** 送查詢用的內部 pk，例：50003003。⚠️ 官網送出的是這個，不是 code */
  pk: string;
  /** 分類名稱，例：工程服務 */
  label: string;
  cate: ProctrgCateName;
}

/** 標的分類查詢的一筆結果 */
export interface ProctrgTender {
  /** 去重用的鍵（優先用內頁連結） */
  key: string;
  orgName: string;
  caseId: string;
  /** 標案名稱（藏在 pageCode2Img 的 JS 裡，已抽出） */
  name: string;
  /** 招標方式 */
  tenderWay: string;
  /** 公告日期（民國） */
  publishDate: string;
  /** 決標金額字串，招標公告模式下為空 */
  awardAmount: string;
  /** 標案內頁連結（可直接餵 get_tender_detail） */
  link: string;
  /** 這筆是哪個標的分類查到的 */
  matchedCode: string;
  matchedLabel: string;
}

export interface ProctrgSearchParams {
  /** 分類內部 pk */
  pk: string;
  cate: ProctrgCateName;
  /** 招標 or 決標 */
  kind: '招標' | '決標';
  /** 標案狀態，僅決標模式有意義 */
  tenderStatus?: string;
  tenderWay?: string;
  /** 公告日期起迄，民國 yyyMMdd 整數 */
  publishFrom: number;
  publishTo: number;
  /** 最多翻幾頁 */
  maxPages?: number;
}
