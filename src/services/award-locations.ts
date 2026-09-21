import { ExecLocationOption } from '../types/award.js';

/**
 * 決標查詢「履約地點」execLocation 下拉選單全部選項（不含「不限」＝空字串）。
 * 2026-09-14 抓自 https://web.pcc.gov.tw/prkms/tender/common/agent/indexTenderAgent ，順序與官網相同。
 * 原住民地區是獨立代碼、舊制縣（臺中縣等）也仍是獨立代碼，只查縣市主代碼會漏案。
 */
export const EXEC_LOCATIONS: ReadonlyArray<readonly [string, string]> = [
  ["EXECUTE_LOCATION_1", "基隆市(非原住民地區)"],
  ["EXECUTE_LOCATION_2", "臺北市(非原住民地區)"],
  ["EXECUTE_LOCATION_20000200", "新北市(非原住民地區)"],
  ["EXECUTE_LOCATION_20000201", "新北市烏來區(原住民地區)"],
  ["EXECUTE_LOCATION_50003000", "桃園市(非原住民地區)"],
  ["EXECUTE_LOCATION_50003001", "桃園市復興區(原住民地區)"],
  ["EXECUTE_LOCATION_7", "新竹市(非原住民地區)"],
  ["EXECUTE_LOCATION_8", "新竹縣(非原住民地區)"],
  ["EXECUTE_LOCATION_9", "新竹縣關西鎮(原住民地區)"],
  ["EXECUTE_LOCATION_10", "新竹縣五峰鄉(原住民地區)"],
  ["EXECUTE_LOCATION_11", "新竹縣尖石鄉(原住民地區)"],
  ["EXECUTE_LOCATION_12", "苗栗縣(非原住民地區)"],
  ["EXECUTE_LOCATION_13", "苗栗縣南庄鄉(原住民地區)"],
  ["EXECUTE_LOCATION_14", "苗栗縣泰安鄉(原住民地區)"],
  ["EXECUTE_LOCATION_15", "苗栗縣獅潭鄉(原住民地區)"],
  ["EXECUTE_LOCATION_16", "臺中市(非原住民地區)"],
  ["EXECUTE_LOCATION_20000202", "臺中市和平區(原住民地區)"],
  ["EXECUTE_LOCATION_19", "南投縣(非原住民地區)"],
  ["EXECUTE_LOCATION_20", "南投縣信義鄉(原住民地區)"],
  ["EXECUTE_LOCATION_21", "南投縣仁愛鄉(原住民地區)"],
  ["EXECUTE_LOCATION_22", "南投縣魚池鄉(原住民地區)"],
  ["EXECUTE_LOCATION_23", "彰化縣(非原住民地區)"],
  ["EXECUTE_LOCATION_24", "雲林縣(非原住民地區)"],
  ["EXECUTE_LOCATION_25", "嘉義市(非原住民地區)"],
  ["EXECUTE_LOCATION_26", "嘉義縣(非原住民地區)"],
  ["EXECUTE_LOCATION_27", "嘉義縣阿里山鄉(原住民地區)"],
  ["EXECUTE_LOCATION_28", "臺南市(非原住民地區)"],
  ["EXECUTE_LOCATION_30", "高雄市(非原住民地區)"],
  ["EXECUTE_LOCATION_20000203", "高雄市那瑪夏區(原住民地區)"],
  ["EXECUTE_LOCATION_20000204", "高雄市茂林區(原住民地區)"],
  ["EXECUTE_LOCATION_20000205", "高雄市桃源區(原住民地區)"],
  ["EXECUTE_LOCATION_35", "屏東縣(非原住民地區)"],
  ["EXECUTE_LOCATION_36", "屏東縣三地門鄉(原住民地區)"],
  ["EXECUTE_LOCATION_37", "屏東縣牡丹鄉(原住民地區)"],
  ["EXECUTE_LOCATION_38", "屏東縣來義鄉(原住民地區)"],
  ["EXECUTE_LOCATION_39", "屏東縣春日鄉(原住民地區)"],
  ["EXECUTE_LOCATION_40", "屏東縣泰武鄉(原住民地區)"],
  ["EXECUTE_LOCATION_41", "屏東縣獅子鄉(原住民地區)"],
  ["EXECUTE_LOCATION_20000206", "屏東縣滿州鄉(原住民地區)"],
  ["EXECUTE_LOCATION_43", "屏東縣瑪家鄉(原住民地區)"],
  ["EXECUTE_LOCATION_44", "屏東縣霧台鄉(原住民地區)"],
  ["EXECUTE_LOCATION_45", "宜蘭縣(非原住民地區)"],
  ["EXECUTE_LOCATION_46", "宜蘭縣大同鄉(原住民地區)"],
  ["EXECUTE_LOCATION_47", "宜蘭縣南澳鄉(原住民地區)"],
  ["EXECUTE_LOCATION_48", "花蓮縣(原住民地區)"],
  ["EXECUTE_LOCATION_20000008", "臺東縣綠島鄉(非原住民地區)"],
  ["EXECUTE_LOCATION_50", "臺東縣大武鄉(原住民地區)"],
  ["EXECUTE_LOCATION_51", "臺東縣太麻里鄉(原住民地區)"],
  ["EXECUTE_LOCATION_52", "臺東縣台東市(原住民地區)"],
  ["EXECUTE_LOCATION_53", "臺東縣成功鎮(原住民地區)"],
  ["EXECUTE_LOCATION_54", "臺東縣池上鄉(原住民地區)"],
  ["EXECUTE_LOCATION_55", "臺東縣卑南鄉(原住民地區)"],
  ["EXECUTE_LOCATION_56", "臺東縣延平鄉(原住民地區)"],
  ["EXECUTE_LOCATION_57", "臺東縣東河鄉(原住民地區)"],
  ["EXECUTE_LOCATION_58", "臺東縣金峰鄉(原住民地區)"],
  ["EXECUTE_LOCATION_59", "臺東縣長濱鄉(原住民地區)"],
  ["EXECUTE_LOCATION_60", "臺東縣海端鄉(原住民地區)"],
  ["EXECUTE_LOCATION_61", "臺東縣鹿野鄉(原住民地區)"],
  ["EXECUTE_LOCATION_62", "臺東縣達仁鄉(原住民地區)"],
  ["EXECUTE_LOCATION_63", "臺東縣關山鎮(原住民地區)"],
  ["EXECUTE_LOCATION_64", "臺東縣蘭嶼鄉(原住民地區)"],
  ["EXECUTE_LOCATION_20000006", "金門縣(非原住民地區)"],
  ["EXECUTE_LOCATION_65", "澎湖縣(非原住民地區)"],
  ["EXECUTE_LOCATION_66", "連江縣(非原住民地區)"],
  ["EXECUTE_LOCATION_20000007", "其他"],
  ["EXECUTE_LOCATION_42", "屏東縣滿洲鄉(原住民地區)"],
  ["EXECUTE_LOCATION_3", "臺北縣(非原住民地區)"],
  ["EXECUTE_LOCATION_4", "臺北縣烏來鄉(原住民地區)"],
  ["EXECUTE_LOCATION_17", "臺中縣(非原住民地區)"],
  ["EXECUTE_LOCATION_18", "臺中縣和平鄉(原住民地區)"],
  ["EXECUTE_LOCATION_29", "臺南縣(非原住民地區)"],
  ["EXECUTE_LOCATION_31", "高雄縣(非原住民地區)"],
  ["EXECUTE_LOCATION_33", "高雄縣茂林鄉(原住民地區)"],
  ["EXECUTE_LOCATION_34", "高雄縣桃源鄉(原住民地區)"],
  ["EXECUTE_LOCATION_20000004", "高雄縣那瑪夏鄉(原住民區)"],
  ["EXECUTE_LOCATION_5", "桃園縣(非原住民地區)"],
  ["EXECUTE_LOCATION_6", "桃園縣復興鄉(原住民地區)"],
];

/** 「其他」桶：機關把跨區、境外、多地點案填在這裡，四縣市機關的案子也可能落在此 */
export const OTHER_LOCATION_CODE = 'EXECUTE_LOCATION_20000007';

// 舊制縣併入直轄市後，官網仍保留舊代碼（可能還有舊案），查新名時要一起帶上
const LEGACY_COUNTY: Record<string, string> = {
  '臺北縣': '新北市',
  '桃園縣': '桃園市',
  '臺中縣': '臺中市',
  '臺南縣': '臺南市',
  '高雄縣': '高雄市',
};

export function normalizeCountyName(s: string): string {
  return s.replace(/\s+/g, '').replace(/台/g, '臺');
}

function countyOfLabel(label: string): string | null {
  if (label === '其他') return null;
  const head = normalizeCountyName(label).slice(0, 3);
  return LEGACY_COUNTY[head] ?? head;
}

/** 履約地點代碼 → 縣市（不限與「其他」回 null） */
export function countyOfLocation(code: string): string | null {
  return code ? countyOfLabel(locationLabel(code)) : null;
}

/** 從機關名稱推縣市（「臺中市政府水利局」→臺中市、「台中港」→臺中市）；中央機關推不出來回 null */
export function countyFromOrgName(orgName: string): string | null {
  const org = normalizeCountyName(orgName);
  const names = [...COUNTY_CODES.keys()];
  return names.find(n => org.startsWith(n)) ?? names.find(n => org.startsWith(n.slice(0, 2))) ?? null;
}

/** 縣市 → 該縣市全部代碼（依官網順序，舊制代碼在最後） */
const COUNTY_CODES: Map<string, ExecLocationOption[]> = (() => {
  const m = new Map<string, ExecLocationOption[]>();
  for (const [code, label] of EXEC_LOCATIONS) {
    const county = countyOfLabel(label);
    if (!county) continue;
    if (!m.has(county)) m.set(county, []);
    m.get(county)!.push({ code, label });
  }
  return m;
})();

export function listCounties(): string[] {
  return [...COUNTY_CODES.keys()];
}

export function locationLabel(code: string): string {
  if (!code) return '不限（全國）';
  const hit = EXEC_LOCATIONS.find(([c]) => c === code);
  return hit ? hit[1] : code;
}

/**
 * 把使用者給的縣市名展開成履約地點代碼。
 * 台→臺 正規化；可省略縣／市（「南投」→南投縣），但有歧義時（「新竹」「嘉義」）回報候選不自行猜。
 * 舊制縣名（臺中縣）視同併入後的直轄市。
 */
export function resolveCounties(inputs: string[]): {
  groups: { input: string; county: string; locations: ExecLocationOption[] }[];
  invalid: { input: string; candidates: string[] }[];
} {
  const groups: { input: string; county: string; locations: ExecLocationOption[] }[] = [];
  const invalid: { input: string; candidates: string[] }[] = [];
  const all = [...COUNTY_CODES.keys()];
  const legacy = Object.keys(LEGACY_COUNTY);

  for (const raw of inputs) {
    const s = normalizeCountyName(raw);
    if (!s) continue;
    let county: string | undefined;
    if (COUNTY_CODES.has(s)) county = s;
    else if (LEGACY_COUNTY[s]) county = LEGACY_COUNTY[s];
    else if (s.length >= 2) {
      const cands = [...new Set([...all, ...legacy].filter(c => c.startsWith(s)).map(c => LEGACY_COUNTY[c] ?? c))];
      if (cands.length === 1) county = cands[0];
      else { invalid.push({ input: raw, candidates: cands }); continue; }
    } else {
      invalid.push({ input: raw, candidates: [] });
      continue;
    }
    if (groups.some(g => g.county === county)) continue;
    groups.push({ input: raw, county, locations: COUNTY_CODES.get(county)! });
  }
  return { groups, invalid };
}
