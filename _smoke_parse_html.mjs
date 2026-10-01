// parse_award_html 的服務層煙霧測試：用 53 個真的人工存檔跑一遍。
// 驗：(1) 全數解析並入快取；(2) 入了快取之後 get_award_detail 完全不連線就能回同一批案子；
// (3) 壞檔（驗證碼頁、沒有 pkAtmMain）會被擋下而不是靜默寫進快取。
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { ingestAwardHtmlFiles, fetchAwardDetails, awardDetailUrl } from './build/services/award-detail-crawler.js';

const DIR = process.argv[2];
if (!DIR) {
  console.error('用法：node _smoke_parse_html.mjs <存放人工另存決標公告 HTML 的資料夾>');
  process.exit(2);
}
const CACHE = process.env.TEMP + '/_smoke_parse_html_cache.json';
await rm(CACHE, { force: true });

const names = (await readdir(DIR)).filter(f => /\.html?$/i.test(f));
const files = [];
for (const f of names) files.push({ path: `${DIR}/${f}`, html: (await readFile(`${DIR}/${f}`)).toString('utf8') });
console.log(`存檔 ${files.length} 個`);

const { results, added, updated } = await ingestAwardHtmlFiles(files, { cacheFile: CACHE });
const ok = results.filter(r => r.ok);
console.log(`解析成功 ${ok.length}｜新增快取 ${added}｜更新 ${updated}｜失敗 ${results.length - ok.length}`);
for (const r of results.filter(r => !r.ok)) console.log(`  失敗 ${r.file}: ${r.message}`);

let bad = 0;
if (ok.length !== files.length) { console.error(`FAIL：${files.length} 檔應全部解析成功`); bad++; }
if (added !== files.length) { console.error(`FAIL：應新增 ${files.length} 筆快取，實際 ${added}`); bad++; }

// 抽樣檢查欄位完整
const sample = ok.slice(0, 3).map(r => r.record);
for (const rec of sample) {
  console.log(`  ${rec.caseNo} ${rec.orgName} → ${rec.winners.map(w => w.name).join('/')}（投標 ${rec.bidderCount} 家、決標 ${rec.totalAward}）`);
  if (!rec.bidderCount || !rec.winners.length) { console.error('FAIL：欄位不完整'); bad++; }
}

// 入快取後 get_award_detail 應完全不連線
const urls = ok.map(r => awardDetailUrl(r.kind, r.pk)).slice(0, 20);
const batch = await fetchAwardDetails(urls, { cacheFile: CACHE, mirror: false });
console.log(`\n快取回讀 ${urls.length} 案：命中快取 ${batch.cachedCount}｜官方連線 ${batch.fetched} 次｜鏡像 ${batch.mirrorRequests} 次`);
if (batch.cachedCount !== urls.length) { console.error(`FAIL：應全部命中快取`); bad++; }
if (batch.fetched !== 0 || batch.mirrorRequests !== 0) { console.error('FAIL：不該有任何連線'); bad++; }

// 壞檔要擋下來
const junk = process.env.TEMP + '/_smoke_junk.html';
await writeFile(junk, '<html><body>請點選撲克牌驗證碼 圖形驗證</body></html>', 'utf8');
const j = await ingestAwardHtmlFiles([{ path: junk, html: (await readFile(junk)).toString('utf8') }], { cacheFile: CACHE });
console.log(`\n壞檔測試：ok=${j.results[0].ok}｜訊息「${j.results[0].message}」`);
if (j.results[0].ok) { console.error('FAIL：驗證碼頁不該被當成資料寫進快取'); bad++; }
if (j.added !== 0) { console.error('FAIL：壞檔不該增加快取'); bad++; }

await rm(CACHE, { force: true });
await rm(junk, { force: true });
console.log(bad ? `\nFAIL（${bad} 項）` : '\nPASS');
process.exit(bad ? 1 : 0);
