// 公開閱覽查詢（search_public_review）驗收：日期語意、翻頁完整性、縣市推定
import { TpReadCrawlerService } from './build/services/tpread-crawler.js';
import { countyInOrgName, countyFromOrgName } from './build/services/award-locations.js';
import { toROCNumber } from './build/utils/date.js';
import axios from 'axios';

let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };

// 1. 機關名稱推縣市
check('「臺中市政府水利局」→臺中市', countyInOrgName('臺中市政府水利局') === '臺中市');
check('「台灣電力股份有限公司台中區營業處」→臺中市（開頭比對做不到）',
      countyInOrgName('台灣電力股份有限公司台中區營業處') === '臺中市' && countyFromOrgName('台灣電力股份有限公司台中區營業處') === null);
check('「衛生福利部南投啟智教養院」→南投縣', countyInOrgName('衛生福利部南投啟智教養院') === '南投縣');
check('「交通部鐵道局」判不出縣市', countyInOrgName('交通部鐵道局') === null);

// 2. 抓取：近三週全國
const from = toROCNumber('115/09/01'), to = toROCNumber('115/09/21');
const r = await new TpReadCrawlerService().search({ reviewFrom: from, reviewTo: to, maxPages: 10 });
console.log(`\n  115/09/01~115/09/21 全國：官網總數=${r.total}  抓取=${r.tenders.length}  截斷=${r.truncated}`);
check('有抓到資料', r.tenders.length > 0, `${r.tenders.length} 筆`);
check('抓取數 == 官網總數（翻頁完整）', r.tenders.length === r.total, `${r.tenders.length} vs ${r.total}`);
check('沒有截斷', r.truncated === false);
const s0 = r.tenders[0];
check('第一筆欄位齊全', !!(s0?.orgName && s0?.caseId && s0?.name && s0?.period && s0?.link && s0?.noticeTimes),
      s0 ? `${s0.orgName} / ${s0.caseId} / ${s0.name.slice(0, 20)} / ${s0.period}` : 'no rows');
check('期間解析成民國整數', r.tenders.every(t => t.reviewFrom && t.reviewTo && t.reviewTo >= t.reviewFrom),
      `第一筆 ${s0?.reviewFrom}~${s0?.reviewTo}`);
check('每一筆的公開閱覽期間都與查詢區間有交集', r.tenders.every(t => t.reviewFrom <= to && t.reviewTo >= from));
check('連結是公開閱覽公告內頁（不是標案內頁）', r.tenders.every(t => !t.link || /tpRead/i.test(t.link)));

// 2b. 採購性質由官網篩：三類互斥且合計等於不限
const byCate = {};
for (const c of ['工程類', '財物類', '勞務類']) {
  byCate[c] = await new TpReadCrawlerService().search({ reviewFrom: from, reviewTo: to, cate: c, maxPages: 10 });
  console.log(`  ${c}：官網總數=${byCate[c].total}  抓取=${byCate[c].tenders.length}`);
}
const sum = ['工程類', '財物類', '勞務類'].reduce((n, c) => n + byCate[c].tenders.length, 0);
check('三類合計 == 不限（官網端真的有篩，不重不漏）', sum === r.tenders.length, `${sum} vs ${r.tenders.length}`);
check('工程類筆數少於不限', byCate['工程類'].tenders.length < r.tenders.length,
      `工程 ${byCate['工程類'].tenders.length} / 不限 ${r.tenders.length}`);
const allKeys = new Set(r.tenders.map(t => t.key));
check('工程類結果是不限結果的子集', byCate['工程類'].tenders.every(t => allKeys.has(t.key)));
const eKeys = new Set(byCate['工程類'].tenders.map(t => t.key));
check('工程類與勞務類互斥', byCate['勞務類'].tenders.every(t => !eKeys.has(t.key)));

// 3. 日期語意是「期間有交集」，不是「起日落在區間」
const day = toROCNumber('115/09/19');
const one = await new TpReadCrawlerService().search({ reviewFrom: day, reviewTo: day, maxPages: 2 });
const spanning = one.tenders.filter(t => t.reviewFrom < day && t.reviewTo > day);
check('單日查詢會撈到「起日更早、迄日更晚」的案（＝期間交集）', spanning.length > 0,
      spanning[0] ? `${spanning[0].orgName} ${spanning[0].period}` : `${one.tenders.length} 筆中 0 筆跨日`);

// 4. 縣市篩選
const want = ['臺中市', '彰化縣', '南投縣'];
const hits = r.tenders.map(t => ({ ...t, county: countyInOrgName(t.orgName) })).filter(t => want.includes(t.county));
const unknown = r.tenders.filter(t => !countyInOrgName(t.orgName)).length;
console.log(`  中彰投：${hits.length} 筆；全國判不出縣市 ${unknown} 筆 / ${r.tenders.length}`);
check('縣市篩選結果非空且都在指定縣市內', hits.length > 0 && hits.every(h => want.includes(h.county)));

// 5. 回歸：日期送民國會被官網靜默當成 0 筆（所以 crawler 一定要送西元）
const roc = await axios.get('https://web.pcc.gov.tw/prkms/tpRead/common/readTpRead?' + new URLSearchParams({
  pageSize: '100', firstSearch: 'false', orgId: '', orgName: '', tenderId: '', tenderName: '',
  radProctrgCate: '', fkPmsProcurementRange: '', queryStartDate: '115/09/01', queryEndDate: '115/09/21',
}), { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'text', timeout: 60000 });
const rocTotal = String(roc.data).match(/共有(?:<[^>]*>|\s)*([\d,]+)(?:<[^>]*>|\s)*筆資料/)?.[1];
check('送民國年官網回 0 筆（證明必須送西元）', rocTotal === '0', `民國=${rocTotal} 西元=${r.total}`);

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
