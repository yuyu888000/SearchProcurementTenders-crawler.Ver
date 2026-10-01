// 鏡像掃日煙霧測試：先單獨驗 fetchDayIndex，再跑一次真的補廠商工作的第 0 步。
// 用 115/09/22 工程類決標 164 件（官方清單匯出檔）當基準，期望鏡像一個請求解掉 ~92%。
import { fetchDayIndex, mirrorCaseKey } from './build/services/mirror-client.js';
import { createJob, runJob, loadJob, jobSummary } from './build/services/resolve-service.js';
import { readFile, readdir } from 'node:fs/promises';

const DATE = 1150922;

// 匯出檔會被之後的查詢蓋過去，所以挑「含指定案號」的那一份，測試才不會隨機換資料集
async function pickExport(marker) {
  const files = (await readdir('.cache/exports')).filter(f => f.startsWith('awards_') && f.endsWith('.json')).sort().reverse();
  for (const f of files) {
    const rows = JSON.parse(await readFile(`.cache/exports/${f}`, 'utf8')).rows ?? [];
    if (rows.some(r => r.caseNo === marker)) return { file: f, rows };
  }
  throw new Error(`.cache/exports 裡找不到含案號 ${marker} 的匯出檔；請先跑 search_awards`);
}


console.log('=== 1. fetchDayIndex ===');
const day = await fetchDayIndex(DATE);
console.log(`公告 ${day.records} 筆｜有得標廠商 ${day.index.size} 筆｜請求 ${day.requests} 次${day.error ? `｜錯誤 ${day.error}` : ''}`);
if (day.error) { console.error('取不到鏡像資料，後面不用測了'); process.exit(1); }
if (day.records < 500) { console.error(`當天公告只有 ${day.records} 筆，太少，可能被限速`); process.exit(1); }

const sample = day.index.get(mirrorCaseKey('桃園市中壢區中原國民小學', 'CU-11506'));
console.log('抽驗 CU-11506：', JSON.stringify(sample));
if (sample?.winners?.[0] !== '煌利營造工程有限公司') { console.error('抽驗案的得標廠商不對'); process.exit(1); }
if (sample.losers[0] !== '展佑土木包工業' || sample.bidderCount !== 2) { console.error('未得標廠商／投標家數解析不對'); process.exit(1); }

console.log('\n=== 2. 端到端：建工作 → 跑第 0 步 ===');
const { file, rows } = await pickExport('CU-11506');
console.log(`官方清單 ${rows.length} 件（${file}）`);

const job = await createJob({
  label: '_smoke_mirror',
  range: { from: DATE, to: DATE, category: '工程' },
  rows,
  directory: 'off',
});
job.state = 'running';
const { writeFile } = await import('node:fs/promises');
await writeFile(`.cache/resolve-jobs/${job.id}.json`, JSON.stringify(job, null, 1), 'utf8');

// 只跑約 6 秒：夠做完唯一那天的鏡像掃描，之後就會因為到時間而暫停，不會去打官方端點
await runJob(job.id, { maxMinutes: 0.1 });

const after = await loadJob(job.id);
console.log(jobSummary(after));
const byMirror = after.stats.solvedByMirror ?? 0;
const pct = Math.round((byMirror / after.stats.total) * 100);
console.log(`\n鏡像解出 ${byMirror}/${after.stats.total}（${pct}%）｜鏡像請求 ${after.mirror.requests} 次`);

const withBidders = after.cases.filter(c => c.source === '鏡像' && c.bidderCount).length;
console.log(`其中帶投標家數的 ${withBidders} 件、帶落標廠商的 ${after.cases.filter(c => c.source === '鏡像' && c.losers?.length).length} 件`);
console.log('抽三件：');
for (const c of after.cases.filter(c => c.source === '鏡像').slice(0, 3)) {
  console.log(`  ${c.caseNo} ${c.orgName} → ${c.winner}（統編 ${c.winnerId ?? '-'}，投標 ${c.bidderCount ?? '-'} 家）`);
}

if (pct < 85) { console.error(`\nFAIL：鏡像命中率 ${pct}% 低於預期的 85%`); process.exit(1); }
if (after.mirror.requests < 1) { console.error(`\nFAIL：一次鏡像請求都沒打`); process.exit(1); }
// 日索引有 10 分鐘快取，同一天被重掃時 requests 會是 0，所以只能斷言「不超過天數」而非「至少天數」
if (after.mirror.requests > after.mirror.done.length) { console.error(`\nFAIL：掃 ${after.mirror.done.length} 天卻打了 ${after.mirror.requests} 次，日索引快取沒生效`); process.exit(1); }
if (after.vendorQueue.length > after.stats.total) { console.error(`\nFAIL：反查佇列 ${after.vendorQueue.length} 家超過案件數 ${after.stats.total}，鏡像把整天的廠商都塞進來了`); process.exit(1); }
// 內頁額度是真正稀缺的資源，這個一定要是 0；清單端點沒有驗證碼限制，
// 而且日索引快取讓掃日變快後，測試視窗內可能已經接著跑進反查，所以只放寬到「沒失控」
if (after.stats.detailFetches !== 0) { console.error(`\nFAIL：不該開官方內頁，實際 ${after.stats.detailFetches} 次`); process.exit(1); }
if (after.stats.lookups > 3) { console.error(`\nFAIL：清單端點打了 ${after.stats.lookups} 次，超出預期`); process.exit(1); }
console.log('\nPASS');
