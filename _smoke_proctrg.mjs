import { resolveCodes } from './build/services/cpc-catalog.js';
import { searchByCategories } from './build/services/proctrg-service.js';
import { ProctrgCrawlerService } from './build/services/proctrg-crawler.js';
import { daysBetweenROC } from './build/utils/date.js';

const WANT = ['52','521','522','867','8671','8672','8673','8674'];
let fail = 0;
const check = (name, ok, extra='') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };

// 1. 代碼解析
const { found, missing, ambiguous } = await resolveCodes(WANT, '勞務類');
check('resolveCodes 全數命中', found.length === 8 && missing.length === 0 && ambiguous.length === 0,
      `found=${found.length} missing=${missing} ambiguous=${ambiguous.length}`);
check('8672 對到 pk=50003003', found.find(f => f.code === '8672')?.pk === '50003003');
check('8673 名稱是綜合工程服務', found.find(f => f.code === '8673')?.label === '綜合工程服務');

// 2. 186 天上限的判斷
check('186 天界線計算', daysBetweenROC(1150701, 1150914) === 75 && ProctrgCrawlerService.MAX_DAY_SPAN === 186,
      `span=${daysBetweenROC(1150701,1150914)}`);

// 3. 單分類完整翻頁：8672 決標公告
const only8672 = found.filter(f => f.code === '8672');
const r = await searchByCategories({
  cats: only8672, kind: '決標', tenderStatus: 'TENDER_STATUS_1',
  publishFrom: 1150701, publishTo: 1150914, maxPages: 30,
});
const st = r.stats[0];
console.log(`\n  8672 決標公告 115/07/01~115/09/14：官網總數=${st.siteTotal}  抓取=${st.fetched}  截斷=${st.truncated}`);
check('官網總數 > 100（證明不是只拿一頁）', st.siteTotal > 100, `siteTotal=${st.siteTotal}`);
check('抓取數 == 官網總數（翻頁完整）', st.fetched === st.siteTotal, `${st.fetched} vs ${st.siteTotal}`);
check('沒有截斷', st.truncated === false);
const s0 = r.results[0];
check('第一筆欄位齊全', !!(s0?.orgName && s0?.caseId && s0?.name && s0?.publishDate && s0?.link),
      s0 ? `${s0.orgName} / ${s0.caseId} / ${s0.name.slice(0,20)}` : 'no rows');

// 4. 篩選器
const filtered = await searchByCategories({
  cats: only8672, kind: '決標', tenderStatus: 'TENDER_STATUS_1',
  publishFrom: 1150701, publishTo: 1150914, maxPages: 30,
  orgNameIncludes: ['臺中','台中','彰化','雲林','南投'],
  excludeTitleKeywords: ['變更設計'],
});
console.log(`  套用縣市+排除後：${filtered.results.length} 筆（機關篩掉 ${filtered.droppedByOrg}、排除字篩掉 ${filtered.droppedByExclude}）`);
check('篩選後筆數變少且非負', filtered.results.length < r.results.length && filtered.results.length >= 0);
check('篩選結果機關都符合', filtered.results.every(x => ['臺中','台中','彰化','雲林','南投'].some(k => x.orgName.includes(k))));
check('篩選結果無變更設計', filtered.results.every(x => !x.name.includes('變更設計')));

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
