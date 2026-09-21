// vendor_profile 驗收：替換 axios 模擬清單端點（依得標／投標廠商與日期區間篩），內頁快取用暫存檔，全程不連網。
import axios from 'axios';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

const SELF = { id: '12345678', name: '玄武工程顧問有限公司' };
const QL = { id: '87654321', name: '青龍工程顧問有限公司' };
const BH = { id: '11223344', name: '白虎工程顧問有限公司' };

// W2 與 W2c 是同一則決標公告（同機關、案號、序號），後者是更正公告、日期落在另一個查詢區段
const CASES = [
  { pk: 'VzE=', org: '臺中市政府水利局', caseNo: 'W1', name: '水利甲案', date: '115/01/10', amount: 5_000_000, seq: '001', winners: [SELF], bidders: [SELF, QL] },
  { pk: 'VzI=', org: '臺中市政府水利局', caseNo: 'W2', name: '水利乙案', date: '115/08/20', amount: 3_000_000, seq: '001', winners: [SELF], bidders: [SELF] },
  { pk: 'VzJj', org: '臺中市政府水利局', caseNo: 'W2', name: '水利乙案', date: '115/06/30', amount: 3_000_000, seq: '001', winners: [SELF], bidders: [SELF] },
  { pk: 'VzM=', org: '彰化縣政府', caseNo: 'W3', name: '彰化案', date: '115/03/05', amount: null, seq: '001', winners: [SELF], bidders: [SELF] },
  { pk: 'TDE=', org: '南投縣政府', caseNo: 'L1', name: '南投案', date: '115/02/01', amount: 8_000_000, seq: '001', winners: [QL], bidders: [SELF, QL] },
  { pk: 'TDI=', org: '國防部', caseNo: 'L2', name: '國防案', date: '115/09/01', amount: 2_000_000, seq: '001', winners: [BH], bidders: [SELF, BH, QL] },
];

const rocOf = w => { const [y, m, d] = w.split('/').map(Number); return (y - 1911) * 10000 + m * 100 + d; };
const rocOfCase = s => { const [y, m, d] = s.split('/').map(Number); return y * 10000 + m * 100 + d; };
const tr = c => `<tr><td>1</td><td>${c.org}</td><td>${c.caseNo} <script>var hw = Geps3.CNS.pageCode2Img("${c.name}")</script></td><td>公開招標</td><td>勞務類</td><td>${c.date}</td><td>${c.amount ?? ''}</td><td>${c.seq}</td><td></td><td><a href="/prkms/urlSelector/common/atm?pk=${c.pk}">檢視</a></td></tr>`;
const page = rows => `<html><body>共有<span class="red"> ${rows.length} </span>筆<table>
<tr><th>項次</th><th>機關名稱</th><th>標案案號</th><th>招標方式</th><th>標的分類</th><th>公告日期</th><th>決標金額</th><th>決標公告</th><th>無法決標</th><th>功能選項</th></tr>
${rows.map(tr).join('')}</table></body></html>`;

const realGet = axios.get;
let listCalls = 0;
axios.get = async (url, cfg) => {
  if (!url.includes('readTenderAgent')) return realGet(url, cfg);
  listCalls++;
  const u = new URL(url);
  const p = k => u.searchParams.get(k) || '';
  const from = rocOf(p('awardAnnounceStartDate')), to = rocOf(p('awardAnnounceEndDate'));
  let rows = CASES.filter(c => { const d = rocOfCase(c.date); return d >= from && d <= to; });
  if (p('gottenVendorId')) rows = rows.filter(c => c.winners.some(v => v.id === p('gottenVendorId')));
  else if (p('gottenVendorName')) rows = rows.filter(c => c.winners.some(v => v.name.includes(p('gottenVendorName'))));
  else if (p('submitVendorId')) rows = rows.filter(c => c.bidders.some(v => v.id === p('submitVendorId')));
  else if (p('submitVendorName')) rows = rows.filter(c => c.bidders.some(v => v.name.includes(p('submitVendorName'))));
  return { status: 200, data: Buffer.from(page(rows), 'utf8'), headers: {} };
};

const tmp = mkdtempSync(join(tmpdir(), 'profile-smoke-'));
const cacheFile = join(tmp, 'award-details.json');
const bidder = (v, won, no) => ({ no, vendorId: v.id, name: v.name, won: won ? '是' : '否', orgType: '', trade: '', address: '', phone: '', sme: '', amount: null, period: '' });
const entry = c => ({ kind: 'award', pk: c.pk, url: '', pairs: [], savedAt: '', record: { pageType: 'award', orgName: c.org, caseNo: c.caseNo, bidders: c.bidders.map((v, i) => bidder(v, c.winners.includes(v), i + 1)) } });
writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(['VzE=', 'TDE=', 'TDI='].map(pk => [`award:${pk}`, entry(CASES.find(c => c.pk === pk))]))));

const vp = await import('./build/services/vendor-profile.js');

console.log('\n[1] 期間切段');
{
  const segs = vp.splitRange(1150101, 1150930);
  check(segs.length === 2 && segs[0].from === 1150101 && segs[1].to === 1150930, '272 天切成 2 段', JSON.stringify(segs));
  const d1 = new Date(Date.UTC(2026, 0, 1)), d2end = new Date(Date.UTC(2026, 0, 1 + 186));
  const expectEnd = (d2end.getUTCFullYear() - 1911) * 10000 + (d2end.getUTCMonth() + 1) * 100 + d2end.getUTCDate();
  const next = new Date(d2end.getTime() + 86400000);
  const expectNext = (next.getUTCFullYear() - 1911) * 10000 + (next.getUTCMonth() + 1) * 100 + next.getUTCDate();
  check(segs[0].to === expectEnd && segs[1].from === expectNext, '第一段剛好 186 天、下一段從隔天接著、不重疊不漏日', `${segs[0].to} → ${segs[1].from}`);
  check(vp.splitRange(1150101, 1150101).length === 1, '單日區間 1 段');
}

console.log('\n[2] 統編側寫（含投標）');
{
  const p = await vp.buildVendorProfile({ vendor: SELF.id, from: 1150101, to: 1150930, includeBids: true, maxRowsPerSegment: 500 }, { cacheFile });
  check(p.byId === true && p.segments.length === 2, '統編模式、查 2 段', `${p.byId} ${p.segments.length}`);
  check(p.won.length === 3, '得標 3 件（跨段的更正公告去重）', String(p.won.length));
  check(p.lost.length === 2, '投標未得標 2 件', String(p.lost.length));
  check(p.wonAmount === 8_000_000 && p.wonAmountUnknown === 1, '得標金額 8,000,000，另 1 件未公開', `${p.wonAmount} / ${p.wonAmountUnknown}`);
  // 用 pk 比對：mock 的 HTML 結構比官網簡化，案號欄會混進 script 文字
  check(p.largest?.pk === 'VzE=', '最大案是 W1', p.largest?.pk);
  check(Math.abs((p.winRate ?? 0) - 0.6) < 1e-9, '得標率 3/5 = 60%', String(p.winRate));
  check(p.orgs[0]?.key === '臺中市政府水利局' && p.orgs[0]?.won === 2 && p.orgs[0]?.wonAmount === 8_000_000, '往來機關第一名：臺中市政府水利局 2 件 8,000,000', JSON.stringify(p.orgs[0]));
  const cty = Object.fromEntries(p.counties.map(c => [c.key, c]));
  check(cty['臺中市']?.won === 2 && cty['南投縣']?.lost === 1 && cty['（未能判斷）']?.lost === 1, '縣市由機關名推斷（國防部歸未能判斷）', Object.keys(cty).join(','));
  check(p.months.map(m => m.key).join(',') === '115/01,115/02,115/03,115/08,115/09', '月份趨勢依時間排序', p.months.map(m => m.key).join(','));
  check(p.requests === 4 && listCalls === 4, '2 段 × 得標＋投標 = 4 次清單請求', `${p.requests} / ${listCalls}`);

  check(p.detailCoverage.cached === 3 && p.detailCoverage.total === 5, '內頁快取涵蓋 3/5', JSON.stringify(p.detailCoverage));
  check(p.competitorInsufficient === true, '快取不足 5 件時標記資料不足');
  const ql = p.competitors.find(c => c.vendorId === QL.id), bh = p.competitors.find(c => c.vendorId === BH.id);
  check(p.competitors[0]?.vendorId === QL.id && ql?.meetings === 3 && ql?.theyWon === 1 && ql?.weWon === 1, '青龍同場 3 次、對手得標 1、本廠商得標 1', JSON.stringify(ql));
  check(bh?.meetings === 1 && bh?.theyWon === 1 && bh?.weWon === 0, '白虎同場 1 次且對手得標', JSON.stringify(bh));
  check(!p.competitors.some(c => c.vendorId === SELF.id), '對手清單不含自己');
}

console.log('\n[3] 名稱部分比對、不查投標');
{
  const c0 = listCalls;
  const p = await vp.buildVendorProfile({ vendor: '玄武工程', from: 1150101, to: 1150930, includeBids: false, maxRowsPerSegment: 500 }, { cacheFile });
  check(p.byId === false && p.won.length === 3, '名稱模式也找到 3 件得標', `${p.byId} ${p.won.length}`);
  check(p.lost.length === 0 && p.winRate === null, '不查投標時沒有未得標與得標率', `${p.lost.length} ${p.winRate}`);
  check(listCalls - c0 === 2, '只發 2 次請求（每段 1 次）', String(listCalls - c0));
  check(p.detailCoverage.cached === 1 && p.competitors.some(c => c.vendorId === QL.id), '內頁名單用「名稱包含查詢字」認出本人', JSON.stringify(p.detailCoverage));
}

console.log('\n[4] MCP 註冊與參數檢查（不連網）');
{
  axios.get = realGet;
  const srv = spawn(process.execPath, ['build/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = []; let buf = '';
  srv.stdout.on('data', d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) try { replies.push(JSON.parse(l)); } catch { } } });
  const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (id, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = replies.find(x => x.id === id); if (r) return r; await new Promise(r => setTimeout(r, 100)); } return null; };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } } });
  await waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = (await waitFor(2))?.result?.tools ?? [];
  check(tools.some(t => t.name === 'vendor_profile'), 'vendor_profile 已註冊', tools.map(t => t.name).join(', '));
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vendor_profile', arguments: { vendor: SELF.id, from: '115/13/01' } } });
  const bad = (await waitFor(3))?.result?.content?.[0]?.text ?? '';
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vendor_profile', arguments: { vendor: SELF.id, from: '115/09/01', to: '115/01/01' } } });
  const rev = (await waitFor(4))?.result?.content?.[0]?.text ?? '';
  srv.kill();
  check(bad.includes('無法解析'), '錯誤日期回說明、不發查詢', bad.slice(0, 40));
  check(rev.includes('請對調'), '起迄顛倒回說明', rev.slice(0, 40));
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} 項 FAIL`}（通過 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
