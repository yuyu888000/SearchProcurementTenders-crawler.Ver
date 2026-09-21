// 直接跑起 MCP server，用 JSON-RPC 問它有哪些工具——確認新工具真的註冊上去
import { spawn } from 'node:child_process';

const srv = spawn(process.execPath, ['build/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const replies = [];
srv.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) try { replies.push(JSON.parse(line)); } catch {}
  }
});

const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
await new Promise(r => setTimeout(r, 800));
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
await new Promise(r => setTimeout(r, 1200));
srv.kill();

const list = replies.find(r => r.id === 2);
const tools = list?.result?.tools ?? [];
console.log('註冊的工具：');
for (const t of tools) {
  console.log(`  - ${t.name}  參數: ${Object.keys(t.inputSchema?.properties ?? {}).join(', ')}`);
}
const expected = ['search_tenders', 'get_tender_detail', 'search_tender_archive', 'search_awards', 'get_award_detail', 'find_awards_by_vendor', 'resolve_award_vendors'];
const missing = expected.filter(n => !tools.some(t => t.name === n));
for (const n of expected) console.log(missing.includes(n) ? `FAIL  找不到 ${n}` : `PASS  ${n} 已註冊`);
process.exit(missing.length === 0 ? 0 : 1);
