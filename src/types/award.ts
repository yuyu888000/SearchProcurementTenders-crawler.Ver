/** 決標查詢（readTenderAgent）用的型別 */

export type AwardCategory = '工程' | '財物' | '勞務';
export type AwardStatus = '決標' | '無法決標' | '撤銷';

export interface AwardQuery {
  /** 決標公告日起，民國 yyyMMdd 整數（例：1150711） */
  from: number;
  /** 決標公告日迄，民國 yyyMMdd 整數 */
  to: number;
  /** 不給＝不限 */
  category?: AwardCategory;
  /** 履約地點代碼（單選）；空字串或不給＝不限 */
  execLocation?: string;
  orgName?: string;
  tenderName?: string;
  /** 預設 決標 */
  status?: AwardStatus;
  gottenVendorName?: string;
  gottenVendorId?: string;
  submitVendorName?: string;
  submitVendorId?: string;
}

/** 清單頁的一列 */
export interface AwardRow {
  /** 「檢視」連結上的 pk（決標是 pkAtmMain，不可餵給招標內頁） */
  pk: string;
  /** 連結型態：atm＝決標公告、nonAtm＝無法決標公告 */
  linkType: string;
  url: string;
  orgName: string;
  /** 已去掉「(更正公告)」字樣 */
  caseNo: string;
  isCorrection: boolean;
  tenderName: string;
  tenderWay: string;
  category: string;
  /** 決標公告日，民國字串原樣；更正公告列是更正日 */
  awardNoticeDate: string;
  /** 未公開或空白為 null */
  amount: number | null;
  awardSeq: string;
  nonAwardSeq: string;
  isNonAward: boolean;
  /** 查到這列時用的履約地點代碼（'' = 不限） */
  execLocation: string;
}

export interface AwardQueryResult {
  /** 官網「共有 N 筆」 */
  siteTotal: number;
  rows: AwardRow[];
  /** 因 maxRows 上限而沒抓完 */
  truncated: boolean;
  /** 本次實際連線次數 */
  requests: number;
  /** 非截斷造成的失敗（連線、版型不符、驗證碼）；有值代表 rows 可能不完整 */
  error?: string;
  /** 遇到驗證碼或 WAF 封鎖，呼叫端應停止後續查詢 */
  blocked?: boolean;
}

export interface ExecLocationOption {
  code: string;
  label: string;
}

export interface LocationStat extends ExecLocationOption {
  siteTotal: number | null;
  fetched: number;
  truncated: boolean;
  error?: string;
  /** 前面已被封鎖，這個代碼沒查 */
  skipped?: boolean;
}

export interface MultiLocationResult {
  perLocation: LocationStat[];
  /** 合併去重後的列，依決標公告日新到舊 */
  rows: AwardRow[];
  /** 各代碼官網總數加總（有代碼查失敗時為下限） */
  siteTotal: number;
  /** 有代碼拿不到官網總數時為 true，siteTotal 只是下限 */
  siteTotalIsLowerBound: boolean;
  /** 去重前實抓列數 */
  fetchedTotal: number;
  duplicates: number;
  truncated: boolean;
  requests: number;
  hasError: boolean;
}

// ---------- 決標公告內頁（get_award_detail） ----------

/** award＝決標公告（QueryAtmAwardDetail）、nonAward＝無法決標公告（QueryAtmNonAwardDetail） */
export type AwardDetailKind = 'award' | 'nonAward';

export interface AwardDetailInput {
  input: string;
  kind: AwardDetailKind;
  pk: string;
  url: string;
  /** 純 pk 沒有路徑可判斷，預設當決標公告 */
  assumedKind: boolean;
}

export interface AwardBidder {
  /** 投標廠商N 的 N */
  no: number;
  /** 廠商代碼（統編）；自然人會被遮蔽如 F1275*****，原樣保留 */
  vendorId: string;
  name: string;
  /** 是否得標，原文（是／否） */
  won: string;
  orgType: string;
  trade: string;
  address: string;
  phone: string;
  /** 是否為中小企業，原文 */
  sme: string;
  /** 該廠商決標金額；未公開為 null */
  amount: number | null;
  period: string;
}

export interface AwardDetailRecord {
  pageType: 'award';
  orgName: string;
  caseNo: string;
  tenderName: string;
  category: string;
  tenderWay: string;
  awardWay: string;
  budget: number | null;
  /** 底價金額，未公開為 null */
  floorPrice: number | null;
  totalAward: number | null;
  awardDate: string;
  awardNoticeDate: string;
  /** 履約地點（含地區） */
  execArea: string;
  period: string;
  bidderCount: number | null;
  jointBid: string;
  bidders: AwardBidder[];
  winners: AwardBidder[];
  losers: AwardBidder[];
  /** 減標率％＝(1−總決標金額/預算金額)×100，小數 2 位；缺任一金額為 null */
  discountRate: number | null;
}

export interface NonAwardDetailRecord {
  pageType: 'nonAward';
  orgName: string;
  caseNo: string;
  tenderName: string;
  category: string;
  reason: string;
  /** 原招標公告之刊登採購公報日期 */
  originalBulletinDate: string;
  nonAwardNoticeDate: string;
  /** 是否沿用本案號及原招標方式續行招標 */
  continueSameCase: string;
}

export type AwardDetailFailure = 'blocked' | 'parse' | 'error' | 'invalid' | 'tender' | 'limit' | 'cooldown';

export interface AwardDetailResult {
  input: string;
  kind?: AwardDetailKind;
  pk: string;
  url: string;
  assumedKind: boolean;
  ok: boolean;
  cached: boolean;
  record?: AwardDetailRecord | NonAwardDetailRecord;
  /** 內頁全部 td/td 配對（label, value），保留重複 label 與順序 */
  pairs?: [string, string][];
  failure?: AwardDetailFailure;
  message?: string;
  /** 快取命中時的原始抓取時間（ISO） */
  savedAt?: string;
  /** 同一呼叫中重複輸入同一案時，指向第一次出現的 results 索引 */
  duplicateOf?: number;
}

export interface AwardDetailBatch {
  results: AwardDetailResult[];
  /** 本次實際連線抓內頁的次數 */
  fetched: number;
  cachedCount: number;
  blocked: boolean;
  /** 前一次呼叫才被擋、仍在冷卻期，本次沒有連線 */
  cooldown: boolean;
  /** 因單次上限或 10 分鐘滾動額度而沒抓的未快取案數（不重複案件） */
  overLimit: number;
  /** 同一呼叫中重複輸入、已合併的筆數 */
  duplicates: number;
}
