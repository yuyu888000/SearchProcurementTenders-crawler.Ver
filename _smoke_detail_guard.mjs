// get_tender_detail 的決標連結防呆：決標／無法決標公告的 pk 是 pkAtmMain，與招標內頁的
// pkPmsMain 不同編號空間。實測餵臺中港決標公告 pk 會回傳「國家資通安全研究院 VANS 維護案」
// ——不報錯的錯答案。這支驗證那類輸入會被擋下、且完全不連線。
import { detectAwardLink, extractPk, fetchTenderDetails } from './build/services/detail-crawler.js';

let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

console.log('\n[1] 決標類連結一律判別得出');
const AWARD_PK = 'NzEyNzkxMDA=';      // 臺中市立大甲高中決標公告
const NONAWARD_PK = 'NzEyNzgxNDE=';   // 臺中港無法決標（流標）
const awardInputs = [
  [`https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${AWARD_PK}`, 'award'],
  [`https://web.pcc.gov.tw/prkms/urlSelector/common/nonAtm?pk=${NONAWARD_PK}`, 'nonAward'],
  [`https://web.pcc.gov.tw/tps/atm/AtmAwardWithoutSso/QueryAtmAwardDetail?pkAtmMain=${AWARD_PK}`, 'award'],
  [`https://web.pcc.gov.tw/tps/atm/AtmNonAwardWithoutSso/QueryAtmNonAwardDetail?pkAtmMain=${NONAWARD_PK}`, 'nonAward'],
  [`[決標公告](https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${AWARD_PK})`, 'award'],
  [`https://web.pcc.gov.tw/prkms/urlSelector/common/ATM?pk=${AWARD_PK}`, 'award'],
];
for (const [input, want] of awardInputs) {
  const got = detectAwardLink(input);
  check(got === want, `判別為 ${want}`, `${input.slice(0, 62)}… → ${got}`);
}

console.log('\n[2] 招標連結與純 pk 不受影響');
const tenderInputs = [
  `https://web.pcc.gov.tw/tps/tpam/main/tps/tpam/tpam_tender_detail.do?searchMode=common&primaryKey=99`,
  `https://web.pcc.gov.tw/prkms/urlSelector/common/tpam?pk=${AWARD_PK}`,
  `https://web.pcc.gov.tw/tps/QueryTender/query/searchTenderDetail?pkPmsMain=${AWARD_PK}`,
  AWARD_PK,
];
for (const input of tenderInputs) {
  check(detectAwardLink(input) === null, '不誤判為決標連結', input.slice(0, 62));
}
check(extractPk(`https://web.pcc.gov.tw/prkms/urlSelector/common/tpam?pk=${AWARD_PK}`) === AWARD_PK, 'tpam 連結仍取得 pk');
check(extractPk(AWARD_PK) === AWARD_PK, '純 pk 仍可用');

console.log('\n[3] 決標連結送進 fetchTenderDetails：擋下、不連線、訊息指向 get_award_detail');
// 連線一律失敗的代理當保險：真的送出請求就會是 error 而不是 award
process.env.HTTPS_PROXY = process.env.HTTP_PROXY = 'http://127.0.0.1:9';
const t0 = Date.now();
const { details, fetched, blocked } = await fetchTenderDetails([
  `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${AWARD_PK}`,
  `https://web.pcc.gov.tw/prkms/urlSelector/common/nonAtm?pk=${NONAWARD_PK}`,
]);
const elapsed = Date.now() - t0;
check(fetched === 0, '本次連線 0 次', `fetched=${fetched}`);
check(blocked === false, '沒有被標成封鎖');
check(details.length === 2 && details.every(d => !d.ok && d.reason === 'award'), '兩筆都回 reason=award',
  details.map(d => `${d.reason}`).join(','));
check(details.every(d => (d.message || '').includes('get_award_detail')), '訊息指向 get_award_detail',
  (details[0]?.message || '').slice(0, 40) + '…');
check(details.every(d => Object.keys(d.fields || {}).length === 0), '沒有回傳任何欄位（不會給錯案子的內容）');
check(elapsed < 3000, '沒有等待網路逾時（代表真的沒送出請求）', `${elapsed}ms`);

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} 項 FAIL`}（通過 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
