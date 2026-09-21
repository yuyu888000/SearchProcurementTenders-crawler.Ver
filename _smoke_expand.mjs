// expand_keywords 驗收。會打採購網清單端點（無驗證碼限制，約 15~25 次）；[3] 另需 GROQ_API_KEY（1 次呼叫）。
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const registryHasKey = process.platform === 'win32' && (() => {
  try { return /GROQ_API_KEY/.test(execFileSync('reg', ['query', String.raw`HKCU\Environment`, '/v', 'GROQ_API_KEY'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return false; }
})();
let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

async function session(env, fn) {
  const srv = spawn(process.execPath, ['build/index.js'], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const replies = []; let buf = '';
  srv.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) try { replies.push(JSON.parse(l)); } catch { } } });
  const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
  const wait = async id => { for (let t = 0; t < 3000 && !replies.some(r => r.id === id); t++) await new Promise(r => setTimeout(r, 100)); return replies.find(r => r.id === id); };
  let id = 1;
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } } });
  await wait(1); send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const api = {
    list: async () => { const my = ++id; send({ jsonrpc: '2.0', id: my, method: 'tools/list', params: {} }); return (await wait(my))?.result?.tools ?? []; },
    call: async (name, args) => { const my = ++id; send({ jsonrpc: '2.0', id: my, method: 'tools/call', params: { name, arguments: args } }); return (await wait(my))?.result?.content?.[0]?.text ?? ''; },
  };
  try { return await fn(api); } finally { srv.kill(); }
}

/** 解析詞表：| 詞 | 來源 | 命中 | 只靠這個詞 | 備註 | */
const termRows = text => [...text.matchAll(/^\| ([^|]+?) \| (AI|自訂|指定) \| ([\d,]+) \| ([\d,]+) \|/gm)]
  .map(m => ({ term: m[1], origin: m[2], hits: +m[3].replace(/,/g, ''), unique: +m[4].replace(/,/g, '') }));
const mergedCount = text => +(text.match(/合併 ([\d,]+) 筆/)?.[1] ?? '-1').replace(/,/g, '');
const jsonPath = text => text.match(/- JSON：(.+\.json)/)?.[1]?.trim();

console.log('\n[1] 工具註冊');
await session(process.env, async ({ list }) => {
  const tools = await list();
  const t = tools.find(x => x.name === 'expand_keywords');
  check(Boolean(t), 'expand_keywords 已註冊', `${tools.length} 支`);
  check(t && ['topic', 'source', 'seeds', 'terms', 'maxTerms', 'from', 'counties'].every(p => p in (t.inputSchema?.properties ?? {})), '必要參數齊全');
});

console.log('\n[2] 沒有金鑰：要 AI 時回說明；直接指定 terms 則照查（不需金鑰）');
{
  const env = { ...process.env }; delete env.GROQ_API_KEY;
  await session(env, async ({ call }) => {
    // Windows 使用者環境變數有金鑰時伺服器會從登錄檔讀到，模擬不出沒有金鑰（也避免真的去叫 AI）
    if (registryHasKey) {
      console.log('  SKIP  使用者環境變數已設 GROQ_API_KEY，無法模擬沒有金鑰');
    } else {
      const noTerms = await call('expand_keywords', { topic: '室內裝修工程', source: 'tenders' });
      check(noTerms.includes('GROQ_API_KEY') && noTerms.includes('terms'), '缺金鑰時說明可改用 terms', noTerms.slice(0, 30));
    }
    const bad = await call('expand_keywords', { topic: '工程技術服務', source: 'awards', from: '115/13/40', terms: ['監造'] });
    check(bad.includes('需要可解析的 from'), '日期錯誤在查詢前就擋下');
    const r = await call('expand_keywords', { topic: '室內裝修工程', source: 'tenders', terms: ['室內裝修', '裝潢'] });
    const rows = termRows(r);
    check(rows.length === 2 && rows.every(x => x.origin === '指定'), '兩個指定詞都有列出', rows.map(x => `${x.term}:${x.hits}`).join(' '));
    const n = mergedCount(r);
    check(n >= Math.max(...rows.map(x => x.hits)) && n <= rows.reduce((s, x) => s + x.hits, 0), '合併筆數介於「最大單詞」與「加總」之間（有去重）', `合併 ${n}`);
    check(rows.reduce((s, x) => s + x.unique, 0) <= n, '只靠單一詞的筆數加總 ≤ 合併筆數');
    const jp = jsonPath(r);
    if (n > 0) {
      const j = JSON.parse(await readFile(jp, 'utf8'));
      check(j.rowCount === n && j.rows.every(x => 'pk' in x && 'tenderName' in x && 'awardNoticeDate' in x), '匯出 JSON 筆數一致、欄位對齊 rank_by_topic exportFile');
    }
  });
}

console.log('\n[3] 招標＋AI 產生詞（需要 GROQ_API_KEY）');
if (!process.env.GROQ_API_KEY && !registryHasKey) {
  check(false, '需要 GROQ_API_KEY（環境變數或 Windows 使用者環境變數）才能跑這段');
} else {
  await session(process.env, async ({ call }) => {
    const r = await call('expand_keywords', { topic: '室內裝修工程', source: 'tenders', seeds: ['室內裝修'], maxTerms: 5 });
    const rows = termRows(r);
    const ai = rows.filter(x => x.origin === 'AI');
    check(rows.some(x => x.origin === '自訂' && x.term === '室內裝修'), '自訂詞一定有查');
    check(ai.length >= 1 && ai.length <= 5, 'AI 詞數在 1~maxTerms', ai.map(x => x.term).join('、'));
    check(ai.every(x => !x.term.includes('室內裝修')), '查詢的 AI 詞不含自訂詞（包含自訂詞的已略過，不白查）',
      (r.match(/略過 \d+ 個 AI 詞[^\n]*/)?.[0]) ?? '無略過');
    const seedOnly = +(r.match(/只用自訂關鍵字會找到 ([\d,]+) 筆/)?.[1] ?? '-1').replace(/,/g, '');
    check(seedOnly >= 0 && mergedCount(r) >= seedOnly, '合併結果 ≥ 只用自訂詞（擴充不會少掉原本的）', `自訂 ${seedOnly}／合併 ${mergedCount(r)}`);
  });
}

console.log('\n[4] 決標來源（指定詞、不用 AI；南投縣 4 個代碼 × 2 詞）');
await session(process.env, async ({ call }) => {
  const r = await call('expand_keywords', { topic: '工程技術服務', source: 'awards', from: '115/09/01', to: '115/09/11', category: '勞務', counties: ['南投縣'], terms: ['監造', '委託技術服務'] });
  const rows = termRows(r);
  check(rows.length === 2, '兩個詞都有查', rows.map(x => `${x.term}:${x.hits}`).join(' '));
  const n = mergedCount(r);
  check(n >= Math.max(0, ...rows.map(x => x.hits)) && n <= rows.reduce((s, x) => s + x.hits, 0), '合併筆數在合理範圍（去重）', `合併 ${n}`);
  if (n > 0) {
    const j = JSON.parse(await readFile(jsonPath(r), 'utf8'));
    check(j.rowCount === n && j.rows.every(x => /監造|委託技術服務/.test(x.tenderName)), '每一列的標案名稱真的含其中一個詞（資料來自官網）');
  }
});

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} 項 FAIL`}（通過 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
