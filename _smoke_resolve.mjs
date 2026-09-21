// resolve_award_vendors 驗收：
//   反查（免費）優先、內頁（受限）補殘、額度與封鎖要等待而不是硬打、狀態落檔可續跑。
// 全程替換 axios，不連網、不消耗內頁額度。
import axios from 'axios';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

const realGet = axios.get;
const calls = { list: 0, detail: 0, gcis: 0, arch: 0 };
// 名錄情境用（[7] 才放資料）
const DIR_COMPANIES = [];
const DIR_ARCH = [];

// ---- 假資料：3 件案子，A/B 同一家廠商（反查一次可解兩件），C 另一家 ----
const CASES = [
  { pk: 'NzEyMDAwMDAx', caseNo: 'A-001', org: '甲機關', name: '案子一', amount: 5000000, vendor: '天龍工程顧問有限公司', vendorId: '11111111' },
  { pk: 'NzEyMDAwMDAy', caseNo: 'B-002', org: '乙機關', name: '案子二', amount: 3000000, vendor: '天龍工程顧問有限公司', vendorId: '11111111' },
  { pk: 'NzEyMDAwMDAz', caseNo: 'C-003', org: '丙機關', name: '案子三', amount: 1000000, vendor: '地虎建築師事務所', vendorId: '22222222' },
];
// 複數決標情境用（[6] 才放進來，不影響前面的計數）
const EXTRA = [];
const ALL = () => [...CASES, ...EXTRA];
const row = c => `<tr><td>1</td><td>${c.org}</td><td>${c.caseNo} <script>var hw = Geps3.CNS.pageCode2Img("${c.name}")</script></td><td>公開招標</td><td>勞務類</td><td>115/08/01</td><td>${c.amount}</td><td>001</td><td></td><td><a href="/prkms/urlSelector/common/atm?pk=${c.pk}">檢視</a></td></tr>`;
const listPage = rows => `<html><body>共有<span class="red"> ${rows.length} </span>筆<table>
<tr><th>項次</th><th>機關名稱</th><th>標案案號</th><th>招標方式</th><th>標的分類</th><th>公告日期</th><th>決標金額</th><th>決標公告</th><th>無法決標</th><th>功能選項</th></tr>
${rows.map(row).join('')}</table><a href="?d-1234-p=1">1</a></body></html>`;
const detailPage = c => `<html><body><table>
<tr><td>機關名稱</td><td>${c.org}</td></tr><tr><td>標案案號</td><td>${c.caseNo}</td></tr><tr><td>標案名稱</td><td>${c.name}</td></tr>
<tr><td>預算金額</td><td>${c.amount} 元</td></tr><tr><td>投標廠商家數</td><td>2</td></tr>
<tr><td>投標廠商1</td><td></td></tr><tr><td>廠商代碼</td><td>${c.vendorId}</td></tr><tr><td>廠商名稱</td><td>${c.vendor}</td></tr><tr><td>是否得標</td><td>是</td></tr><tr><td>決標金額</td><td>${c.amount} 元</td></tr>
<tr><td>投標廠商2</td><td></td></tr><tr><td>廠商代碼</td><td>99999999</td></tr><tr><td>廠商名稱</td><td>陪標企業有限公司</td></tr><tr><td>是否得標</td><td>否</td></tr>
<tr><td>決標公告序號</td><td>001</td></tr><tr><td>底價金額</td><td>${c.amount} 元</td></tr><tr><td>總決標金額</td><td>${c.amount} 元</td></tr><tr><td>決標日期</td><td>115/07/30</td></tr>
</table></body></html>`;
const ok = html => ({ status: 200, data: Buffer.from(html, 'utf8'), headers: {} });

// 情境：清單端點依 gottenVendorName／gottenVendorId 回對應案件；內頁回該案明細
function install({ detailLimitAfter = 99 } = {}) {
  axios.get = async (url, cfg) => {
    if (url.includes('readTenderAgent')) {
      calls.list++;
      const u = new URL(url);
      const name = u.searchParams.get('gottenVendorName') || '';
      const id = u.searchParams.get('gottenVendorId') || '';
      let rows = [];
      if (name) rows = ALL().filter(c => (c.vendors ?? [c.vendor]).some(v => v.includes(name)));
      else if (id) rows = ALL().filter(c => c.vendorId === id);
      else rows = CASES;
      return ok(listPage(rows));
    }
    if (url.includes('QueryAtmAwardDetail')) {
      calls.detail++;
      if (calls.detail > detailLimitAfter) return ok('<html>撲克牌 驗證碼 A區 B區 重新整理</html>');
      const pk = decodeURIComponent(new URL(url).searchParams.get('pkAtmMain') || '');
      const c = CASES.find(x => x.pk === pk);
      return c ? ok(detailPage(c)) : ok('<html>查無資料</html>');
    }
    if (url.includes('data.gcis.nat.gov.tw')) {
      calls.gcis++;
      const u = new URL(url);
      const kw = (u.searchParams.get('$filter') || '').match(/like (.+?) and/)?.[1] ?? '';
      const data = u.searchParams.get('$skip') === '0' ? DIR_COMPANIES.filter(c => c.Company_Name.includes(kw)) : [];
      return { status: 200, data, headers: {} };
    }
    if (url.includes('quality.data.gov.tw')) {
      calls.arch++;
      return { status: 200, data: DIR_ARCH, headers: {} };
    }
    return realGet(url, cfg);
  };
}

const svc = await import('./build/services/resolve-service.js');
const det = await import('./build/services/award-detail-crawler.js');

// 每個情境用獨立的暫存快取與額度檔，不碰專案 .cache
const tmp = mkdtempSync(join(tmpdir(), 'resolve-smoke-'));
process.env.AWARD_DETAIL_CACHE_FILE = join(tmp, 'award-details.json');

console.log('\n[1] 工具註冊');
{
  const srv = spawn(process.execPath, ['build/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = []; let buf = '';
  srv.stdout.on('data', d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) try { replies.push(JSON.parse(l)); } catch { } } });
  const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } } });
  await new Promise(r => setTimeout(r, 800));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await new Promise(r => setTimeout(r, 1200));
  srv.kill();
  const tools = (replies.find(r => r.id === 2)?.result?.tools ?? []);
  const t = tools.find(x => x.name === 'resolve_award_vendors');
  check(Boolean(t), 'resolve_award_vendors 已註冊', tools.map(x => x.name).join(', '));
  const actions = t?.inputSchema?.properties?.action?.enum ?? [];
  check(['start', 'status', 'stop', 'result', 'list'].every(a => actions.includes(a)), '五個動作齊全', actions.join(','));
}

console.log('\n[2] 反查優先：一次查詢解掉同一家的兩件，內頁只用在剩下那件');
install();
const rows = CASES.map(c => ({ pk: c.pk, linkType: 'atm', url: `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${c.pk}`, orgName: c.org, caseNo: c.caseNo, isCorrection: false, tenderName: c.name, tenderWay: '', category: '勞務類', awardNoticeDate: '115/08/01', amount: c.amount, awardSeq: '001', nonAwardSeq: '', isNonAward: false, execLocation: '' }));
let job = await svc.createJob({ label: '測試', range: { from: 1150711, to: 1150911, category: '勞務' }, rows, seedVendors: ['天龍工程顧問有限公司'] });
check(job.cases.length === 3 && job.stats.total === 3, '建立工作：3 件案子', job.id);
await svc.setJobState(job.id, 'running');
await svc.runJob(job.id, { maxMinutes: 1 });
job = await svc.loadJob(job.id);
check(job.state === 'done', '工作跑到完成', job.message);
check(job.stats.resolved === 3, '3 件全部解出', `${job.stats.resolved}/3`);
check(job.stats.solvedByLookup === 2, '反查解掉 2 件（同一家廠商）', String(job.stats.solvedByLookup));
check(job.stats.solvedByDetail === 1, '內頁只解 1 件', String(job.stats.solvedByDetail));
check(calls.detail === 1, `內頁只連線 1 次`, String(calls.detail));
const byCase = Object.fromEntries(job.cases.map(c => [c.caseNo, c]));
check(byCase['A-001'].winner === '天龍工程顧問有限公司' && byCase['A-001'].source === '反查', 'A-001 由反查解出');
check(byCase['C-003'].winner === '地虎建築師事務所' && byCase['C-003'].source === '內頁完整', 'C-003 由內頁解出');
check((byCase['C-003'].losers ?? []).includes('陪標企業有限公司'), '內頁來源另有落標廠商', (byCase['C-003'].losers ?? []).join(','));
check(!byCase['A-001'].losers, '反查來源沒有落標資料（誠實留空）');

console.log('\n[3] 內頁抓到的新廠商名會回頭反查');
check(job.triedVendors.includes('地虎建築師事務所') || job.vendorQueue.includes('地虎建築師事務所'),
  '內頁得到的廠商名有進反查佇列', `tried=${job.triedVendors.length} queue=${job.vendorQueue.length}`);

console.log('\n[4] 續跑：已解出的不重查');
const before = { ...calls };
await svc.setJobState(job.id, 'running');
await svc.runJob(job.id, { maxMinutes: 1 });
job = await svc.loadJob(job.id);
check(calls.detail === before.detail, '沒有重抓任何內頁', `${before.detail} → ${calls.detail}`);
check(job.stats.resolved === 3 && job.state === 'done', '狀態維持完成');

console.log('\n[5] 暫停會停下來');
{
  const j2 = await svc.createJob({ label: '測試2', range: { from: 1150711, to: 1150911, category: '勞務' }, rows: rows.slice(0, 1), seedVendors: [] });
  await svc.setJobState(j2.id, 'paused');
  const c0 = calls.detail;
  await svc.runJob(j2.id, { maxMinutes: 1 });
  check(calls.detail === c0, '暫停中的工作不會發出任何請求');
  const after = await svc.loadJob(j2.id);
  check(after.state === 'paused' && after.stats.resolved === 0, '狀態仍是暫停、未解');
}

console.log('\n[6] 工作狀態有落檔，另一個行程讀得到');
{
  const p = join(process.cwd(), '.cache', 'resolve-jobs', `${job.id}.json`);
  check(existsSync(p), '狀態檔存在專案 .cache/resolve-jobs/', p.split('.cache')[1]);
  const disk = JSON.parse(readFileSync(p, 'utf8'));
  check(disk.stats.resolved === 3 && disk.cases.length === 3, '檔案內容與記憶體一致');
  const jobs = await svc.listJobs();
  check(jobs.some(j => j.id === job.id), 'listJobs 列得到');
}

console.log('\n[6]複數決標：每家得標廠商都要記下，部分比對誤中的短名要丟掉');
{
  EXTRA.push(
    { pk: 'NzEyMDAwMDA0', caseNo: 'D-004', org: '丁機關', name: '案子四', amount: 2000000, vendor: '玄武工程顧問有限公司', vendors: ['玄武工程顧問有限公司', '朱雀技術顧問有限公司'], vendorId: '33333333' },
    { pk: 'NzEyMDAwMDA1', caseNo: 'E-005', org: '戊機關', name: '案子五', amount: 1500000, vendor: '新大有工程顧問有限公司', vendorId: '44444444' },
  );
  const rows6 = EXTRA.map(c => ({ pk: c.pk, linkType: 'atm', url: `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${c.pk}`, orgName: c.org, caseNo: c.caseNo, isCorrection: false, tenderName: c.name, tenderWay: '', category: '勞務類', awardNoticeDate: '115/08/01', amount: c.amount, awardSeq: '001', nonAwardSeq: '', isNonAward: false, execLocation: '' }));
  const d0 = calls.detail;
  const input6 = { label: '測試-複數決標', range: { from: 1150711, to: 1150911, category: '勞務' }, rows: rows6,
    seedVendors: ['玄武工程顧問有限公司', '大有工程顧問有限公司', '朱雀技術顧問有限公司', '新大有工程顧問有限公司'] };
  let j6 = await svc.createJob(input6);
  // 同一批案子的 jobId 固定，上次跑留下的狀態檔會被沿用，先清掉再建
  rmSync(join('.cache', 'resolve-jobs', `${j6.id}.json`), { force: true });
  j6 = await svc.createJob(input6);
  await svc.setJobState(j6.id, 'running');
  await svc.runJob(j6.id, { maxMinutes: 1 });
  j6 = await svc.loadJob(j6.id);
  const by6 = Object.fromEntries(j6.cases.map(c => [c.caseNo, c]));
  check(by6['D-004'].winner === '玄武工程顧問有限公司 / 朱雀技術顧問有限公司', 'D-004 兩家得標都記下（不是只留第一家）', by6['D-004'].winner);
  check(by6['E-005'].winner === '新大有工程顧問有限公司', 'E-005 部分比對誤中的「大有」被長名取代', by6['E-005'].winner);
  check(j6.stats.solvedByLookup === 2, '解出件數不因重複命中而灌水', String(j6.stats.solvedByLookup));
  check(calls.detail === d0, '全由反查解出，沒開內頁', `${d0} → ${calls.detail}`);
}

console.log('\n[7] 名錄反查：種子沒有的廠商靠名錄解出，只掃在地、帶回統編、名錄有快取');
{
  process.env.VENDOR_DIRECTORY_FILE = join(tmp, 'vendor-directory.json');
  DIR_COMPANIES.push(
    { Company_Name: '白虎工程顧問有限公司', Business_Accounting_NO: '66666666', Company_Location: '高雄市前鎮區測試路1號' },
    { Company_Name: '青龍工程顧問有限公司', Business_Accounting_NO: '55555555', Company_Location: '台中市西屯區測試路2號' },
  );
  DIR_ARCH.push({ 事務所名稱: '麒麟建築師事務所', 事務所所在地: '臺北市信義區' });
  const f = { pk: 'NzEyMDAwMDA2', caseNo: 'F-006', org: '臺中市政府測試局', name: '案子六', amount: 900000, vendor: '青龍工程顧問有限公司', vendorId: '55555555' };
  EXTRA.push(f);
  const rows7 = [{ pk: f.pk, linkType: 'atm', url: `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${f.pk}`, orgName: f.org, caseNo: f.caseNo, isCorrection: false, tenderName: f.name, tenderWay: '', category: '勞務類', awardNoticeDate: '115/08/01', amount: f.amount, awardSeq: '001', nonAwardSeq: '', isNonAward: false, execLocation: '' }];
  const fresh = async input => {
    const j = await svc.createJob(input);
    rmSync(join('.cache', 'resolve-jobs', `${j.id}.json`), { force: true });
    return svc.createJob(input);
  };

  const d0 = calls.detail;
  let j7 = await fresh({ label: '測試-名錄', range: { from: 1150711, to: 1150911, category: '勞務' }, rows: rows7, seedVendors: [], directory: 'local' });
  await svc.setJobState(j7.id, 'running');
  await svc.runJob(j7.id, { maxMinutes: 1 });
  j7 = await svc.loadJob(j7.id);
  const c7 = j7.cases[0];
  check(JSON.stringify(j7.directory?.counties) === '["臺中市"]', '沒給縣市時由機關名稱推得', JSON.stringify(j7.directory?.counties));
  check(j7.directory?.total === 1, '只掃在地：高雄、臺北的廠商不進佇列（地址寫「台中」也認得）', String(j7.directory?.total));
  check(c7.winner === '青龍工程顧問有限公司' && c7.source === '名錄反查', 'F-006 由名錄反查解出', `${c7.winner}（${c7.source}）`);
  check(c7.winnerId === '55555555', '名錄帶來的統編有記下', String(c7.winnerId));
  check(j7.stats.solvedByDirectory === 1 && j7.stats.solvedByLookup === 0, '件數記在名錄反查，不混進種子反查', `${j7.stats.solvedByDirectory}/${j7.stats.solvedByLookup}`);
  check(calls.gcis > 0 && calls.arch === 1 && calls.detail === d0, '名錄有抓、沒開內頁', `gcis=${calls.gcis} arch=${calls.arch} detail=${calls.detail - d0}`);

  const g1 = calls.gcis, a1 = calls.arch;
  let j8 = await fresh({ label: '測試-名錄全掃', range: { from: 1150711, to: 1150910, category: '勞務' }, rows: rows7, seedVendors: [], directory: 'all' });
  await svc.setJobState(j8.id, 'running');
  await svc.runJob(j8.id, { maxMinutes: 1 });
  j8 = await svc.loadJob(j8.id);
  check(j8.directory?.total === 3, 'all 模式：在地之外也排進佇列', String(j8.directory?.total));
  check(j8.directory?.tried === 1 && j8.state === 'done', '案子解完就停，不把剩下的名錄硬掃完', `tried=${j8.directory?.tried} state=${j8.state}`);
  check(calls.gcis === g1 && calls.arch === a1, '第二個工作沿用名錄快取，沒有重抓', `gcis ${g1}→${calls.gcis} arch ${a1}→${calls.arch}`);

  let j9 = await fresh({ label: '測試-不用名錄', range: { from: 1150711, to: 1150909, category: '勞務' }, rows: rows7, seedVendors: [] });
  check(j9.directory?.mode === 'off', 'createJob 沒指定時預設不用名錄（服務層保守預設，工具層才預設 local）', String(j9.directory?.mode));
  rmSync(join('.cache', 'resolve-jobs', `${j9.id}.json`), { force: true });
}

axios.get = realGet;
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} 項 FAIL`}（通過 ${pass}）｜清單端點 ${calls.list} 次、內頁 ${calls.detail} 次（皆為 mock）`);
process.exit(fail === 0 ? 0 : 1);
