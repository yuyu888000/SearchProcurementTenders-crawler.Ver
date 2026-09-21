import axios from 'axios';
import { CpcCategory, ProctrgCateName } from '../types/tender.js';

/**
 * 標的分類代碼表。
 *
 * 官網「標的分類查詢」頁的下拉選單不是寫死在 HTML 裡，是前端 Geps3.CpcModel.byType()
 * 打這支 API 撈回來再塞進 <option>，而且 option 的 value 是內部 pk，畫面上看到的
 * 「8672 工程服務」只是顯示文字。所以查詢時要送的是 pk（50003003），不是 8672。
 * 這裡在執行期抓一次同一支 API 並快取，避免把 230 多筆對照表寫死在程式裡。
 */
const API = 'https://web.pcc.gov.tw/ccs/queryCPCsByType';

/** API 的 type 參數 → 官網三大類（勞務類要傳 3S，不是 S） */
const TYPE_PARAM: Record<ProctrgCateName, string> = {
  '工程類': 'E',
  '財物類': 'F',
  '勞務類': '3S',
};

/** 官網 radProctrgCate 的值與對應的代碼欄位名 */
export const CATE_FIELD: Record<ProctrgCateName, { radio: string; param: string }> = {
  '工程類': { radio: 'RAD_PROCTRG_CATE_1', param: 'proctrgCode1' },
  '財物類': { radio: 'RAD_PROCTRG_CATE_2', param: 'proctrgCode2' },
  '勞務類': { radio: 'RAD_PROCTRG_CATE_3', param: 'proctrgCode3' },
};

let cache: CpcCategory[] | null = null;

async function fetchType(cate: ProctrgCateName): Promise<CpcCategory[]> {
  const res = await axios.get(`${API}?type=${TYPE_PARAM[cate]}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Referer': 'https://web.pcc.gov.tw/prkms/tender/common/proctrg/indexTenderProctrg',
      'Accept': 'application/json, text/plain, */*',
    },
    timeout: 20000,
  });
  const rows = Array.isArray(res.data) ? res.data : [];
  return rows
    .filter((r: any) => r && r.value && r.pk)
    .map((r: any) => ({
      code: String(r.value).trim(),
      pk: String(r.pk).trim(),
      label: String(r.label ?? '').trim(),
      cate,
    }));
}

/** 取得（並快取）完整代碼表 */
export async function loadCatalog(): Promise<CpcCategory[]> {
  if (cache) return cache;
  const all = await Promise.all(
    (Object.keys(TYPE_PARAM) as ProctrgCateName[]).map(fetchType)
  );
  cache = all.flat();
  return cache;
}

export interface ResolveResult {
  found: CpcCategory[];
  /** 查無此代碼 */
  missing: string[];
  /** 同一個代碼在多個大類都存在，且呼叫端沒指定 cate */
  ambiguous: { code: string; cates: ProctrgCateName[] }[];
}

/** 把使用者給的代碼（例 8672）解析成可送出的分類項目 */
export async function resolveCodes(codes: string[], cate?: ProctrgCateName): Promise<ResolveResult> {
  const catalog = await loadCatalog();
  const found: CpcCategory[] = [];
  const missing: string[] = [];
  const ambiguous: { code: string; cates: ProctrgCateName[] }[] = [];

  for (const raw of codes) {
    const code = raw.trim();
    const hits = catalog.filter(c => c.code === code && (!cate || c.cate === cate));
    if (hits.length === 0) missing.push(code);
    else if (hits.length > 1) ambiguous.push({ code, cates: hits.map(h => h.cate) });
    else found.push(hits[0]);
  }
  return { found, missing, ambiguous };
}
