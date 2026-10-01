// get_award_detail 鏡像快路徑煙霧測試。
// 驗三件事：(1) 走鏡像時完全不動用官方內頁額度；(2) 欄位與官方清單對得起來；
// (3) CU-11506 這案的細節與先前人工核對過的官方內頁欄位一字不差。
import { readFile, readdir, rm } from 'node:fs/promises';
import { fetchAwardDetails } from './build/services/award-detail-crawler.js';
import { rememberAwardDates } from './build/services/award-pk-index.js';


// 匯出檔會被之後的查詢蓋過去，所以挑「含指定案號」的那一份，測試才不會隨機換資料集
async function pickExport(marker) {
  const files = (await readdir('.cache/exports')).filter(f => f.startsWith('awards_') && f.endsWith('.json')).sort().reverse();
  for (const f of files) {
    const rows = JSON.parse(await readFile(`.cache/exports/${f}`, 'utf8')).rows ?? [];
    if (rows.some(r => r.caseNo === marker)) return { file: f, rows };
  }
  throw new Error(`.cache/exports 裡找不到含案號 ${marker} 的匯出檔；請先跑 search_awards`);
}

const CACHE = process.env.TEMP + '/_smoke_award_mirror_cache.json';
await rm(CACHE, { force: true });

const { file, rows } = await pickExport('CU-11506');
console.log(`官方清單 ${rows.length} 件（${file}）`);

// 模擬 search_awards 跑過：把 pk → 決標公告日 記進索引
rememberAwardDates(rows);
await new Promise(r => setTimeout(r, 300));

const byCase = new Map(rows.map(r => [r.caseNo, r]));
const pick = ['CU-11506', '11557001F18', '1154250524'].map(c => byCase.get(c)).filter(Boolean);
console.log(`抽測 ${pick.length} 件：${pick.map(r => r.caseNo).join('、')}`);

const batch = await fetchAwardDetails(pick.map(r => r.url), { cacheFile: CACHE });

console.log(`\n實抓 ${batch.results.filter(r => r.ok).length} 筆｜鏡像 ${batch.fromMirror} 筆｜官方內頁連線 ${batch.fetched} 次｜鏡像請求 ${batch.mirrorRequests} 次`);

let bad = 0;
for (const [i, r] of batch.results.entries()) {
  const src = pick[i];
  if (!r.ok) { console.error(`  FAIL ${src.caseNo}：${r.message}`); bad++; continue; }
  const rec = r.record;
  const checks = [
    ['機關', rec.orgName, src.orgName],
    ['案號', rec.caseNo, src.caseNo],
    ['標案名稱', rec.tenderName, src.tenderName],
    ['決標公告日', rec.awardNoticeDate, src.awardNoticeDate],
    ['總決標金額', rec.totalAward, src.amount],
  ];
  const diff = checks.filter(([, a, b]) => String(a) !== String(b));
  console.log(`  ${r.fromMirror ? '[鏡像]' : '[官方]'} ${rec.caseNo} ${rec.orgName} → ${rec.winners.map(w => w.name).join(' / ')}（投標 ${rec.bidderCount} 家、決標 ${rec.totalAward}、底價 ${rec.floorPrice}、減標率 ${rec.discountRate}%）`);
  if (diff.length) { console.error(`     與官方清單不符：${diff.map(([k, a, b]) => `${k} 鏡像=${a} 官方=${b}`).join('；')}`); bad++; }
}

// CU-11506：先前已人工核對過官方欄位
const cu = batch.results.find(r => r.ok && r.record.caseNo === 'CU-11506')?.record;
const expect = {
  winner: '煌利營造工程有限公司', winnerId: '29128370', bidderCount: 2,
  budget: 3436364, floorPrice: 3430000, totalAward: 3360000,
  awardDate: '115/08/31', loser: '展佑土木包工業',
};
if (!cu) { console.error('\nFAIL：CU-11506 沒取到'); bad++; }
else {
  const got = {
    winner: cu.winners[0]?.name, winnerId: cu.winners[0]?.vendorId, bidderCount: cu.bidderCount,
    budget: cu.budget, floorPrice: cu.floorPrice, totalAward: cu.totalAward,
    awardDate: cu.awardDate, loser: cu.losers[0]?.name,
  };
  const wrong = Object.keys(expect).filter(k => String(got[k]) !== String(expect[k]));
  console.log(`\nCU-11506 逐欄核對：${wrong.length ? 'FAIL ' + wrong.map(k => `${k} 期望=${expect[k]} 實際=${got[k]}`).join('；') : '全數相符'}`);
  if (wrong.length) bad++;
  // 減標率＝(1−3360000/3436364)×100＝2.22
  if (cu.discountRate !== 2.22) { console.error(`FAIL：減標率應為 2.22，實際 ${cu.discountRate}`); bad++; }
  if (!cu.pairs && !batch.results.find(r => r.record === cu)?.pairs?.length) { console.error('FAIL：沒帶全部欄位 pairs'); bad++; }
}

if (batch.fetched !== 0) { console.error(`\nFAIL：走鏡像不該連官方內頁，實際 ${batch.fetched} 次`); bad++; }
if (batch.fromMirror !== pick.length) { console.error(`\nFAIL：${pick.length} 件應全部走鏡像，實際 ${batch.fromMirror} 件`); bad++; }

await rm(CACHE, { force: true });
console.log(bad ? `\nFAIL（${bad} 項）` : '\nPASS');
process.exit(bad ? 1 : 0);
