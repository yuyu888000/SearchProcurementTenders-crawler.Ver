// find_awards_by_vendor 驗收：用先前逐案開內頁得到的已知答案當對照組。
// 清單端點沒有驗證碼流量控制，但仍節流；本檔只打清單端點，不碰內頁。
import { spawn } from 'node:child_process';
import { queryAwardsByVendor, isVendorId } from './build/services/award-service.js';

let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

// 已知答案（來自 165 案逐案內頁抓取的結果）
const GT = {
  vendor: '劦盛工程顧問有限公司',
  id: '22220892',
  cases: ['1152B40017', '1152B40016', '1150505003B-1', '1150505009B'],
};
const RANGE = { from: 1150711, to: 1150911, category: '勞務' };

console.log('\n[1] 工具註冊');
{
  const srv = spawn(process.execPath, ['build/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  await new Promise(r => setTimeout(r, 800));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await new Promise(r => setTimeout(r, 1200));
  srv.kill();
  const tools = replies.find(r => r.id === 2)?.result?.tools ?? [];
  const t = tools.find(x => x.name === 'find_awards_by_vendor');
  check(Boolean(t), 'find_awards_by_vendor 已註冊', tools.map(x => x.name).join(', '));
  check(t && ['vendors', 'from', 'includeBids'].every(p => p in (t.inputSchema?.properties ?? {})), '必要參數齊全',
    Object.keys(t?.inputSchema?.properties ?? {}).join(', '));
  // 不寫死總數（總數由 _smoke_mcp.mjs 檢查），只確認名稱不重複
  check(new Set(tools.map(x => x.name)).size === tools.length, '工具名稱不重複', String(tools.length) + ' 支');
}

console.log('\n[2] 統編判定');
check(isVendorId('22220892') && !isVendorId('劦盛工程顧問有限公司') && !isVendorId('F1275*****') && !isVendorId('1234567'),
  '8 碼數字才當統編');

console.log('\n[3] 統編反查 vs 已知答案（1 次請求）');
const byId = await queryAwardsByVendor(RANGE, GT.id, { maxRows: 200, includeBids: false });
check(!byId.error, '查詢無錯誤', byId.error || '');
check(byId.byId === true, '走統編欄位');
const gotCases = byId.won.map(r => r.caseNo);
const missing = GT.cases.filter(c => !gotCases.includes(c));
check(missing.length === 0, `4 件已知得標案全部命中`, `缺 ${missing.join(',') || '無'}；實得 ${gotCases.length} 件`);
check(byId.won.length === byId.siteTotalWon, '實抓數＝官網件數', `${byId.won.length} / ${byId.siteTotalWon}`);
check(byId.won.every(r => r.url && r.pk), '每列都有公告連結與 pk');

console.log('\n[4] 名稱反查應得到同一組案子（1 次請求）');
const byName = await queryAwardsByVendor(RANGE, GT.vendor, { maxRows: 200, includeBids: false });
const a = new Set(gotCases), b = new Set(byName.won.map(r => r.caseNo));
check(a.size === b.size && [...a].every(x => b.has(x)), '名稱與統編反查結果一致',
  `統編 ${a.size} 件／名稱 ${b.size} 件`);

console.log('\n[5] 投標未得標（includeBids，2 次請求）');
const both = await queryAwardsByVendor(RANGE, GT.id, { maxRows: 200, includeBids: true });
check(both.siteTotalBid !== null && both.siteTotalBid >= both.siteTotalWon,
  '投標件數 ≥ 得標件數（投標集合含得標）', `投標 ${both.siteTotalBid}／得標 ${both.siteTotalWon}`);
check(both.lost.every(r => !gotCases.includes(r.caseNo)), '落標清單不含已得標的案子',
  `落標 ${both.lost.length} 件：${both.lost.map(r => r.caseNo).join(',') || '無'}`);
check(both.won.length + both.lost.length === (both.siteTotalBid ?? 0), '得標＋落標＝投標總數',
  `${both.won.length}+${both.lost.length} vs ${both.siteTotalBid}`);

console.log('\n[6] 查無資料的廠商不會報錯（1 次請求）');
const none = await queryAwardsByVendor(RANGE, '這家公司名稱一定不存在拾參', { maxRows: 50, includeBids: false });
check(!none.error && none.won.length === 0 && none.siteTotalWon === 0, '回 0 件、不報錯',
  `${none.won.length} 件／官網 ${none.siteTotalWon}`);

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} 項 FAIL`}（通過 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
