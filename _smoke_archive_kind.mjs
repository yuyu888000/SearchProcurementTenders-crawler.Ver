// search_tender_archive 的兩個修正：
//   (1) 官網「種類」欄把無法決標公告也寫成「決標公告」——改依連結型態（atm／nonAtm）與
//       「(無法決標)」後綴判定；
//   (2) 原本只輸出一個「公告日」，那其實是招標公告日，決標側日期沒輸出。
// 用電子公報端點實查（不受內頁流量控制），另加離線解析驗證，不依賴當日資料內容。
import { BulletionCrawlerService } from './build/services/bulletion-crawler.js';

let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

const svc = new BulletionCrawlerService();

// ---------- 1. 離線：種類判定規則 ----------
console.log('\n[1] 離線解析：種類依連結型態修正');
const row = (kindCell, awardCell, hrefPath) => `<table>
<tr><th>項次</th><th>種類</th><th>機關名稱</th><th>標案案號</th><th>招標公告日期</th><th>決標或無法決標公告</th><th>截止投標日期</th><th>公開閱覽</th><th>預告</th></tr>
<tr><td>1</td><td>${kindCell}</td><td>某機關</td><td>A1 <script>var hw = Geps3.CNS.pageCode2Img("測試案")</script></td><td>115/08/01</td><td>${awardCell}</td><td></td><td></td><td></td><td><a href="${hrefPath}">檢視</a></td></tr>
</table>`;
const parse = (html) => svc.constructor.prototype.parseRows
  ? svc['parseRows'](html, 115)
  : [];
const cases = [
  ['決標公告', '115/09/11', '/prkms/urlSelector/common/atm?pk=NzEy', '決標公告', false],
  ['決標公告', '115/09/11 (無法決標)', '/prkms/urlSelector/common/nonAtm?pk=NzEy', '無法決標公告', true],
  ['決標公告', '115/09/11', '/prkms/urlSelector/common/nonAtm?pk=NzEy', '無法決標公告', true],
  ['決標公告', '115/09/11 (無法決標)', '/prkms/urlSelector/common/atm?pk=NzEy', '無法決標公告', true],
  ['招標公告', '', '/prkms/urlSelector/common/tpam?pk=NzEy', '招標公告', false],
];
for (const [kindCell, awardCell, href, wantKind, wantNon] of cases) {
  const [r] = parse(row(kindCell, awardCell, href));
  check(r && r.kind === wantKind && r.isNonAward === wantNon,
    `官網種類「${kindCell}」＋${href.includes('nonAtm') ? 'nonAtm' : href.includes('/atm?') ? 'atm' : 'tpam'}${awardCell.includes('無法決標') ? '＋(無法決標)後綴' : ''} → ${wantKind}`,
    r ? `kind=${r.kind} isNonAward=${r.isNonAward} siteKind=${r.siteKind}` : '沒有解析出資料列');
}
const [keep] = parse(row('決標公告', '115/09/11', '/prkms/urlSelector/common/atm?pk=NzEy'));
check(keep && keep.siteKind === '決標公告', '保留官網原始種類供對照（siteKind）', keep?.siteKind);
check(keep && keep.publishDate === '115/08/01' && keep.awardDate === '115/09/11',
  '招標公告日與決標公告日各自成欄', `publishDate=${keep?.publishDate} awardDate=${keep?.awardDate}`);

// ---------- 2. 即時：真實公報資料 ----------
console.log('\n[2] 即時查詢電子公報（決標種類，1 次請求）');
try {
  const { tenders, total } = await svc.search({ querySentence: '臺中', statusTypes: ['決標'], year: 115, matchNameOnly: true });
  check(tenders.length > 0, `取得資料列`, `${tenders.length} 筆／官網共 ${total} 筆`);
  const nonAward = tenders.filter(t => t.isNonAward);
  const award = tenders.filter(t => !t.isNonAward && t.kind === '決標公告');
  check(tenders.every(t => t.kind === '決標公告' || t.kind === '無法決標公告'),
    '決標查詢回傳的列都被歸為決標或無法決標', `決標 ${award.length}／無法決標 ${nonAward.length}`);
  check(nonAward.every(t => /nonAtm/i.test(t.link) || /無法決標/.test(t.awardDate)),
    '標為無法決標者，連結是 nonAtm 或日期欄帶 (無法決標) 後綴');
  check(award.every(t => !/nonAtm/i.test(t.link)), '標為決標者的連結不是 nonAtm');
  const mislabeled = tenders.filter(t => t.siteKind === '決標公告' && t.isNonAward).length;
  console.log(`        （官網把 ${mislabeled} 筆無法決標公告寫成「決標公告」，本工具已修正）`);
  check(tenders.every(t => t.awardDate), '決標側日期欄有值');
} catch (e) {
  check(false, '即時查詢', e.message);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} 項 FAIL`}（通過 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
