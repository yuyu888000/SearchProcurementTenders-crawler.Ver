// rank_by_topic 驗收。[4] 會實際呼叫 Groq（需 GROQ_API_KEY，約 3~6 次呼叫）；不碰採購網。
// 對照組是 2026-09-17 實測 2,031 筆勞務決標時人工裁定過的公開標案名稱。
import { spawn, execFileSync } from 'node:child_process';
import {
  keywordHits, groupOf, compareRank, createRankJob, loadRankJob, runRankJob, setRankState, rankCounts,
} from './build/services/topic-rank.js';

let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

async function rpc(env, calls) {
  const srv = spawn(process.execPath, ['build/index.js'], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const replies = [];
  let buf = '';
  srv.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) try { replies.push(JSON.parse(line)); } catch { }
    }
  });
  const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } } });
  const wait = async id => { for (let t = 0; t < 100 && !replies.some(r => r.id === id); t++) await new Promise(r => setTimeout(r, 100)); };
  await wait(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  let id = 2;
  const out = [];
  for (const c of calls) { send({ jsonrpc: '2.0', id, ...c }); await wait(id); out.push(replies.find(r => r.id === id)); id++; }
  srv.kill();
  return out;
}

console.log('\n[1] 工具註冊');
{
  const [list] = await rpc(process.env, [{ method: 'tools/list', params: {} }]);
  const tools = list?.result?.tools ?? [];
  const t = tools.find(x => x.name === 'rank_by_topic');
  check(Boolean(t), 'rank_by_topic 已註冊', `${tools.length} 支`);
  check(t && ['action', 'rankId', 'topic', 'keywords', 'source', 'exportFile'].every(p => p in (t.inputSchema?.properties ?? {})), '必要參數齊全');
  check(new Set(tools.map(x => x.name)).size === tools.length, '工具名稱不重複');
}

console.log('\n[2] 分組規則（純邏輯）');
check(keywordHits('某某工程委託監造設計案', ['監造', '規劃']).join() === '監造', '關鍵字部分比對');
check(groupOf({ score: 0, keywordHits: ['監造'] }) === 'A', '命中關鍵字＝A，AI 0 分也不移出');
check(groupOf({ score: 2, keywordHits: [] }) === 'B' && groupOf({ score: 3, keywordHits: [] }) === 'B', '無關鍵字、2~3 分＝B');
check(groupOf({ score: 1, keywordHits: [] }) === 'C' && groupOf({ score: -1, keywordHits: [] }) === 'C', '低分或未評分＝C（不刪除）');
{
  const rows = [
    { group: 'C', score: 1, amount: 9e9 }, { group: 'B', score: 2, amount: 1 }, { group: 'A', score: 0, amount: 1 },
    { group: 'B', score: 3, amount: 1 }, { group: 'A', score: 3, amount: 5 },
  ].sort(compareRank);
  check(rows.map(r => r.group + r.score).join(',') === 'A3,A0,B3,B2,C1', '排序 A→B→C、組內分數高先', rows.map(r => r.group + r.score).join(','));
}

console.log('\n[3] 沒有金鑰時 start 回明確說明、不建立工作');
// Windows 使用者環境變數有金鑰時，伺服器會從登錄檔讀到，模擬不出「沒有金鑰」
const registryHasKey = process.platform === 'win32' && (() => {
  try { return /GROQ_API_KEY/.test(execFileSync('reg', ['query', String.raw`HKCU\Environment`, '/v', 'GROQ_API_KEY'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return false; }
})();
if (registryHasKey) console.log('  SKIP  使用者環境變數已設 GROQ_API_KEY（伺服器會從登錄檔讀到），無法模擬沒有金鑰');
else {
  const env = { ...process.env }; delete env.GROQ_API_KEY;
  const [r] = await rpc(env, [{ method: 'tools/call', params: { name: 'rank_by_topic', arguments: { action: 'start', topic: 'x', source: 'awards', from: '115/09/01' } } }]);
  const text = r?.result?.content?.[0]?.text ?? '';
  check(text.includes('GROQ_API_KEY') && !text.includes('已啟動'), '回傳缺金鑰說明', text.slice(0, 40));
}

const TOPIC = '工程技術服務（為營建工程提供的規劃、設計、監造、專案管理、測量、地質調查、結構安全鑑定、工程檢測等技術性服務）';
// expect: true＝人工裁定是、false＝不是
const CASES = [
  ['臺中市政府運動局', '臺中市政府運動局場館零星修繕工程委託監造設計案', true],       // 40 筆批次曾被打 0 分
  ['臺中市立文華高級中等學校', '115學年度仁愛樓屋頂防水隔熱修繕工程委託技術服務', true], // 同上
  ['交通部公路局中區養護工程分局', '115~118年度中分局信義段轄區地錨邊坡定期檢測、補充調查及補強設計服務工作', true],
  ['台灣電力股份有限公司大甲溪發電廠', '115-116年度達見吊橋及青山鋼便橋定期檢測工作', true],
  ['經濟部水利署水利規劃分署', '淡水河水系五股疏左堤防加高影響水工模型試驗計畫', true],
  ['臺中市政府勞工局', '115年度臺中市政府勞工局辦公廳舍裝修委託設計服務案', true],
  ['臺灣港務股份有限公司', '『臺中港老舊防波堤、海堤及護岸整建工程』委託規劃設計監造技術服務', true],
  ['農業部農田水利署', '115年度西螺分處西螺站各級渠道疏濬工作第二次開口契約', false],
  ['台灣自來水股份有限公司第四區管理處', '115-116年度沙鹿所(沙鹿、梧棲含港區)用戶新改裝工作單價採購', false],
  ['雲林縣崙背鄉公所', '115年度崙背鄉路燈裝設及維護開口契約', false],
  ['南投縣集集鎮公所', '「集集鎮115年度濁水溪盃及鎮長盃桌球邀請賽暨水資源宣導活動」委託專業服務採購案', false],
  ['台灣電力股份有限公司', '離岸風力發電廠運維中心辦公室暨倉庫統包工程營造險自115年7月13日展延保險期間至115年12月31日', false],
  ['臺中市政府', '115年度資訊設備維護案', false],
];

console.log('\n[4] 實際呼叫 Groq：13 筆已知答案（批次 12＋單筆複查）');
if (!process.env.GROQ_API_KEY && !registryHasKey) {
  check(false, '需要 GROQ_API_KEY（環境變數或 Windows 使用者環境變數）才能跑這段');
} else {
  const stamp = Date.now().toString(36);   // 避免撞到舊工作與分數快取
  const items = CASES.map(([org, name], i) => ({ pk: `SMOKE${stamp}${i}`, url: '', orgName: org, caseNo: `S${i}`, tenderName: `${name}（smoke ${stamp}）`, amount: 1000 - i, date: '115/09/17' }));
  const job = await createRankJob({ topic: TOPIC, keywords: ['委託規劃設計監造'], source: 'export', conditions: 'smoke', items });
  await setRankState(job.id, 'running');
  const t0 = Date.now();
  await runRankJob(job.id, { maxMinutes: 10 });
  const done = await loadRankJob(job.id);
  check(done.state === 'done', '工作完成', `${done.message}｜${Math.round((Date.now() - t0) / 1000)} 秒｜${done.usage.calls} 次呼叫`);
  check(done.items.every(i => i.score >= 0), '全部有分數');
  const byName = n => done.items.find(i => i.tenderName.startsWith(n));
  const kw = byName('『臺中港老舊防波堤');
  check(kw.group === 'A', '命中必納關鍵字的進 A 組');
  let right = 0, wrongList = [];
  for (const [, name, want] of CASES) {
    const it = byName(name);
    const got = it.group !== 'C';
    if (got === want) right++; else wrongList.push(`${name.slice(0, 18)}…=${it.score}`);
  }
  check(right >= 11, `13 筆至少 11 筆分對（實測基準約 85%）`, `${right}/13${wrongList.length ? '；錯：' + wrongList.join('、') : ''}`);
  const missed = ['臺中市政府運動局場館零星修繕工程委託監造設計案', '115學年度仁愛樓屋頂防水隔熱修繕工程委託技術服務'].map(byName);
  check(missed.every(i => i.score >= 2), '先前 40 筆批次漏掉的兩筆，這次 ≥2 分', missed.map(i => `${i.score}${i.rechecked ? '(複查)' : ''}`).join('、'));
  check(Array.isArray(done.recheckTerms) && done.recheckTerms.length > 0, 'AI 產生了複查用主題詞', (done.recheckTerms ?? []).join('、'));
  const c = rankCounts(done);
  console.log(`        分組 A=${c.A} B=${c.B} C=${c.C}｜token in ${done.usage.promptTokens} out ${done.usage.completionTokens}`);

  console.log('\n[5] 暫停中的工作：runRankJob 不動它');
  const items2 = items.map(i => ({ ...i, pk: i.pk + 'P', tenderName: i.tenderName + 'P' }));
  const j2 = await createRankJob({ topic: TOPIC, keywords: [], source: 'export', conditions: 'smoke-paused', items: items2 });
  await runRankJob(j2.id);  // state 仍是 paused
  const j2b = await loadRankJob(j2.id);
  check(j2b.state === 'paused' && j2b.usage.calls === 0, '沒有發出任何 Groq 呼叫', `${j2b.state}／${j2b.usage.calls} 次`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} 項 FAIL`}（通過 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
