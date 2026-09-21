// 內頁 priority（rankId）驗收。不開任何內頁、不呼叫 Groq：
// 排序邏輯用單元測試；get_tender_detail 只用本機快取裡已有的案子，並檢查實際連線 0 筆。
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detailQueue, createJob, setJobPriority, jobSummary } from './build/services/resolve-service.js';
import { createRankJob, saveRankJob, loadRankJob } from './build/services/topic-rank.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};
const cleanup = [];

async function session(fn) {
  const srv = spawn(process.execPath, ['build/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = []; let buf = '';
  srv.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) try { replies.push(JSON.parse(l)); } catch { } } });
  const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
  const wait = async id => { for (let t = 0; t < 300 && !replies.some(r => r.id === id); t++) await new Promise(r => setTimeout(r, 100)); return replies.find(r => r.id === id); };
  let id = 1;
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } } });
  await wait(1); send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const api = {
    list: async () => { const my = ++id; send({ jsonrpc: '2.0', id: my, method: 'tools/list', params: {} }); return (await wait(my))?.result?.tools ?? []; },
    call: async (name, args) => { const my = ++id; send({ jsonrpc: '2.0', id: my, method: 'tools/call', params: { name, arguments: args } }); return (await wait(my))?.result?.content?.[0]?.text ?? ''; },
  };
  try { return await fn(api); } finally { srv.kill(); }
}

/** 建一個已完成的排名（不呼叫 Groq，直接寫分數），回傳 rankId */
async function fakeRank(source, entries) {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = await createRankJob({
    topic: `smoke ${stamp}`, keywords: [], source, conditions: 'smoke',
    items: entries.map(([pk], i) => ({ pk, url: '', orgName: 'o', caseNo: `c${i}`, tenderName: `n${i}`, amount: null, date: '' })),
  });
  for (const it of job.items) {
    const [, group, score] = entries.find(e => e[0] === it.pk);
    it.group = group; it.score = score;
  }
  job.state = 'done';
  await saveRankJob(job);
  cleanup.push(join(ROOT, '.cache', 'rankings', `${job.id}.json`));
  return job.id;
}

console.log('\n[1] detailQueue 排序（純邏輯）');
{
  const cases = [
    { pk: 'c1', amount: 900, status: 'unknown' },   // C
    { pk: 'b2', amount: 100, status: 'unknown' },   // B 2 分
    { pk: 'x', amount: 5000, status: 'unknown' },   // 不在排名
    { pk: 'a0', amount: 1, status: 'unknown' },     // A 0 分
    { pk: 'b3', amount: 50, status: 'unknown' },    // B 3 分
    { pk: 'a3', amount: 1, status: 'unknown' },     // A 3 分
    { pk: 'done', amount: 99999, status: 'resolved' },
  ];
  const ranks = { c1: { group: 'C', score: 1 }, b2: { group: 'B', score: 2 }, a0: { group: 'A', score: 0 }, b3: { group: 'B', score: 3 }, a3: { group: 'A', score: 3 } };
  const noRank = detailQueue({ cases });
  check(noRank.pending.map(c => c.pk).join() === 'x,c1,b2,b3,a0,a3' || noRank.pending.map(c => c.pk).join() === 'x,c1,b2,b3,a3,a0', '沒有排名時照金額大到小（與舊行為相同）', noRank.pending.map(c => c.pk).join());
  const q = detailQueue({ cases, priority: { rankId: 'r', topic: 't', skipGroupC: false, ranks } });
  check(q.pending.map(c => c.pk).join() === 'a3,a0,b3,b2,x,c1', 'A→B→不在排名→C，組內分數高先', q.pending.map(c => c.pk).join());
  check(!q.pending.some(c => c.pk === 'done'), '已解出的不進佇列');
  const s = detailQueue({ cases, priority: { rankId: 'r', topic: 't', skipGroupC: true, ranks } });
  check(s.pending.map(c => c.pk).join() === 'a3,a0,b3,b2,x' && s.skipped === 1, 'skipGroupC：C 組不進佇列、不在排名的照抓', `${s.pending.map(c => c.pk).join()}｜略過 ${s.skipped}`);
}

console.log('\n[2] 工作檔掛排名後 jobSummary 顯示順序資訊');
{
  const job = await createJob({ label: 'smoke-priority', range: { from: 1150901, to: 1150911 }, directory: 'off',
    rows: ['p1', 'p2', 'p3'].map(pk => ({ pk: pk + Date.now(), url: '', orgName: 'o', caseNo: pk, tenderName: 'n', amount: 1, awardNoticeDate: '115/09/01' })) });
  cleanup.push(join(ROOT, '.cache', 'resolve-jobs', `${job.id}.json`));
  const ranks = { [job.cases[0].pk]: { group: 'A', score: 3 }, [job.cases[1].pk]: { group: 'C', score: 0 } };
  const j2 = await setJobPriority(job.id, { rankId: 'rank_0000000000', topic: 'smoke', skipGroupC: true, ranks });
  const sum = jobSummary(j2);
  check(/內頁順序：依排名/.test(sum) && /A 1／B 0／C 1／不在排名 1/.test(sum) && /C 組不開內頁/.test(sum), 'summary 列出各組待解數與 skipGroupC', sum.split('\n').find(l => l.includes('內頁順序')));
}

console.log('\n[3] 參數與防呆（都在發出請求前擋下）');
await session(async ({ list, call }) => {
  const tools = await list();
  const res = tools.find(t => t.name === 'resolve_award_vendors')?.inputSchema?.properties ?? {};
  const det = tools.find(t => t.name === 'get_tender_detail')?.inputSchema?.properties ?? {};
  check('rankId' in res && 'skipGroupC' in res, 'resolve_award_vendors 有 rankId／skipGroupC');
  check('rankId' in det, 'get_tender_detail 有 rankId');

  let t = await call('resolve_award_vendors', { action: 'start', from: '115/09/01', skipGroupC: true });
  check(t.includes('skipGroupC 要搭配 rankId'), 'skipGroupC 沒給 rankId 被擋');
  t = await call('resolve_award_vendors', { action: 'start', from: '115/09/01', rankId: 'rank_ffffffffff' });
  check(t.includes('找不到排名'), '不存在的 rankId 被擋');

  const tenderRank = await fakeRank('tenders', [['T1', 'A', 3]]);
  t = await call('resolve_award_vendors', { action: 'start', from: '115/09/01', rankId: tenderRank });
  check(t.includes('不能用在補得標廠商'), '招標排名不能掛到補廠商（pk 不同編號空間）');

  const pausedId = await fakeRank('awards', [['W1', 'A', 3]]);
  const paused = await loadRankJob(pausedId); paused.state = 'running'; await saveRankJob(paused);
  t = await call('resolve_award_vendors', { action: 'start', from: '115/09/01', rankId: pausedId });
  check(t.includes('還沒完成'), '未完成的排名不能掛');

  const awardRank = await fakeRank('awards', [['W2', 'A', 3]]);
  t = await call('get_tender_detail', { cases: ['V1'], rankId: awardRank });
  check(t.includes('不能用在 get_tender_detail'), '決標排名不能用在 get_tender_detail');
});

console.log('\n[4] get_tender_detail 依排名排序（只用本機快取，實際連線必須 0 筆）');
{
  let cached = [];
  try { cached = Object.keys(JSON.parse(await readFile(join(ROOT, '.cache', 'tender-details.json'), 'utf8'))); } catch { }
  if (cached.length < 3) {
    console.log('  SKIP  本機內頁快取不足 3 筆，略過（不為了測試去開內頁）');
  } else {
    const [p1, p2, p3] = cached;
    const rankId = await fakeRank('export', [[p1, 'C', 0], [p2, 'A', 3], [p3, 'B', 2]]);
    await session(async ({ call }) => {
      const t = await call('get_tender_detail', { cases: [p1, p3, p2], rankId });
      const pos = pk => t.indexOf(`pkPmsMain=${encodeURIComponent(pk)}`);
      check(pos(p2) >= 0 && pos(p2) < pos(p3) && pos(p3) < pos(p1), '輸出順序 A→B→C', `${pos(p2)} < ${pos(p3)} < ${pos(p1)}`);
      check(/本次實際連線抓取 0 筆/.test(t), '實際連線 0 筆（全走快取）');
      check(/A 1／B 1／C 1/.test(t), '排序說明列出各組筆數');
    });
  }
}

for (const f of cleanup) await unlink(f).catch(() => undefined);
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} 項 FAIL`}（通過 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
