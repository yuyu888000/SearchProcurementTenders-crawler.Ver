// recheck_pending_awards：cached miss 不能擋住重查、同日索引要強制重抓、結果要寫回分類快取
// 會連 g0v 鏡像（不碰官方內頁）。用暫存快取檔，不動 .cache
// 用法：node _smoke_recheck.mjs <決標公告日> <pk> [pk...]   例：node _smoke_recheck.mjs 115/09/29 NzEyOTMzNjA= NzEyOTI5NzE=
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recheckPendingCategories } from './build/services/award-category.js';

const [date, ...pks] = process.argv.slice(2);
if (!date || !pks.length) { console.error('用法：node _smoke_recheck.mjs <決標公告日> <pk> [pk...]'); process.exit(2); }

let bad = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) bad++; };

const catFile = join(tmpdir(), '_smoke_recheck_categories.json');
const detailFile = join(tmpdir(), '_smoke_recheck_details.json');
const staleAt = new Date().toISOString();
const seeded = Object.fromEntries(pks.map(pk => [pk, { status: 'miss', at: staleAt, why: '鏡像當日索引無此公告' }]));
seeded['FAKEOKPK='] = { status: 'ok', raw: '<勞務類>8672工程服務', at: staleAt };
await writeFile(catFile, JSON.stringify(seeded), 'utf8');
await writeFile(detailFile, '{}', 'utf8');

const cases = [...pks.map(pk => ({ pk, date })), { pk: 'FAKEOKPK=', date }, { pk: pks[0], date }];
const r = await recheckPendingCategories({ cases, detailCacheFile: detailFile, categoryCacheFile: catFile });

check(r.total === pks.length + 1, `去重後 ${r.total} 案（應為 ${pks.length + 1}）`);
const fake = r.resolved.find(x => x.pk === 'FAKEOKPK=');
check(fake?.split?.item === '8672 工程服務' && fake?.split?.mid.startsWith('867 '), `快取命中直接回傳且拆欄正確：${fake?.split?.item}`);
check(r.mirrorRequests >= 1, `有 miss 快取仍實際打鏡像：${r.mirrorRequests} 次`);
check(r.resolved.length + r.stillMissing.length + r.pendingMirror.length === r.total, '每案都有歸屬');
check(r.pendingMirror.length === 0, `沒有連線失敗待重試（${r.pendingMirror.length}）`);
check(r.stillMissing.every(m => m.why !== '鏡像當日索引無此公告'), '仍查無的原因已更新為重查結果');

const after = JSON.parse(await readFile(catFile, 'utf8'));
const touched = pks.filter(pk => after[pk] && after[pk].at > staleAt);
check(touched.length === pks.length, `分類快取逐筆寫回：${touched.length}/${pks.length}`);
for (const x of r.resolved.filter(x => x.pk !== 'FAKEOKPK=')) {
  check(after[x.pk]?.status === 'ok' && !!x.split, `${x.pk} → ${x.split?.item}｜${x.orgName}｜${(x.winners ?? []).map(w => w.name).join('、')}｜${x.totalAward}`);
}
for (const m of r.stillMissing) console.log(`INFO  仍查無 ${m.pk}：${m.why}`);

await unlink(catFile).catch(() => {});
await unlink(detailFile).catch(() => {});
console.log(bad ? `FAIL (${bad} 項)` : 'PASS');
process.exit(bad ? 1 : 0);
