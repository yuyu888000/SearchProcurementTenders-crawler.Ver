// search_awards 驗收腳本：工具註冊、錯誤處理、離線解析、即時查詢（南投縣勞務）、小結果集、截斷、匯出檔
// 用法：node _smoke_awards.mjs            （含即時查詢，清單端點約 13 次請求）
//       node _smoke_awards.mjs --offline  （不連網）
// 離線清單頁素材不進 repo：設 AWARD_FIXTURES=<素材根目錄>（底下要有 fixtures/list_page.html、fixtures/list_chk.html、
// award_impl/probe_zero.html、award_impl/probe_revoke.html）才跑 [4] 的解析檢查，沒設就印 SKIP
// 任一檢查失敗 exit code 1
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OFFLINE = process.argv.includes('--offline');
const FIXTURES = process.env.AWARD_FIXTURES || '';

let failed = 0;
let skipped = 0;
const check = (ok, msg, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};
const skip = (msg, why) => {
  console.log(`  SKIP  ${msg}  — ${why}`);
  skipped++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- MCP client（CWD 故意設成 System32，驗證匯出路徑不依賴工作目錄） ----------
const sys32 = 'C:\\Windows\\System32';
const srv = spawn(process.execPath, [join(ROOT, 'build', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: existsSync(sys32) ? sys32 : ROOT,
});
let buf = '';
const pending = new Map();
srv.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { }
  }
});
let nextId = 1;
const rpc = (method, params = {}, timeoutMs = 20000) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout: ${method}`)); } }, timeoutMs);
});
const callTool = async (args, timeoutMs = 20000) => {
  const t0 = Date.now();
  const r = await rpc('tools/call', { name: 'search_awards', arguments: args }, timeoutMs);
  return { text: r.result?.content?.[0]?.text ?? JSON.stringify(r), ms: Date.now() - t0 };
};

let liveRequests = 0;
const countRequests = text => {
  const m = text.match(/本次連線 (\d+) 次/);
  return m ? parseInt(m[1], 10) : 0;
};

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-awards', version: '0' } });
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const instr = init.result.instructions ?? '';

  // ---------- 1. 註冊與描述 ----------
  console.log('\n[1] tools/list 與 server instructions');
  const tools = (await rpc('tools/list')).result.tools;
  const names = tools.map(t => t.name);
  for (const n of ['search_tenders', 'search_tender_archive', 'get_tender_detail', 'search_awards']) {
    check(names.includes(n), `${n} 已註冊`);
  }
  const aw = tools.find(t => t.name === 'search_awards');
  const props = aw?.inputSchema?.properties ?? {};
  const expected = ['from', 'to', 'category', 'counties', 'includeOther', 'orgName', 'tenderName', 'status', 'maxRows', 'previewRows'];
  check(expected.every(k => k in props) && Object.keys(props).length === expected.length, 'search_awards 參數齊全', Object.keys(props).join(', '));
  check(JSON.stringify(aw?.inputSchema?.required ?? []) === '["from"]', 'from 是唯一必填', JSON.stringify(aw?.inputSchema?.required));
  check(JSON.stringify(props.category?.enum) === '["工程","財物","勞務"]', 'category 列舉 工程/財物/勞務');
  check(JSON.stringify(props.status?.enum) === '["決標","無法決標","撤銷"]', 'status 列舉 決標/無法決標/撤銷');
  check(props.maxRows?.maximum === 3000, 'maxRows 上限 3000', String(props.maxRows?.maximum));
  const desc = aw?.description ?? '';
  check(desc.includes('決標公告日 ≠ 決標日') && desc.includes('UNDERCOUNTED'), '描述含限制①決標公告日≠決標日、右端低估');
  check(desc.includes('履約地點 is a coarse field') && desc.includes('NOT necessarily the actual work site'), '描述含限制②履約地點是粗欄位');
  check(desc.includes('「其他」') && desc.includes('EXECUTE_LOCATION_20000007'), '描述含限制③「其他」桶');
  check(desc.includes('更正公告') && desc.includes('CORRECTION date'), '描述含限制④更正公告列顯示更正日');
  check(desc.includes('(5) The 履約地點 filter does NOT work for 無法決標') && desc.includes('REJECTED'), '描述含限制⑤履約地點篩選對無法決標無效、該組合會被拒');
  check(instr.includes('search_awards') && instr.includes('不要用 search_tender_archive 篩決標日期'), 'instructions 新增決標查詢改用 search_awards');
  for (const key of ['兩個工具都要跑', '不可靜默省略', '不要試圖繞過驗證碼']) {
    check(instr.includes(key), `instructions 原有規則仍在：「${key}」`);
  }

  // ---------- 2. 參數錯誤（不連網） ----------
  console.log('\n[2] 日期／縣市錯誤處理');
  for (const [args, label] of [
    [{ from: '115/13/45', to: '2026/09/11' }, '月份 13'],
    [{ from: '2026/02/30', to: '2026/09/11' }, '不存在的 2/30'],
    [{ from: '2026/07/11', to: '九月十一日' }, 'to 非日期'],
    [{ from: 'abc' }, 'from 非日期、to 省略'],
  ]) {
    const r = await callTool(args);
    check(r.text.includes('日期格式無法解析') && !r.text.includes('決標查詢：') && !r.text.includes('本次連線') && r.ms < 3000,
      `無法解析的日期回錯誤訊息且沒有查詢（${label}）`, `${r.ms}ms：${r.text.slice(0, 60)}`);
  }
  {
    const r = await callTool({ from: '2025/01/01', to: '2026/09/11', counties: ['南投縣'] });
    check(r.text.includes('超過官網未登入查詢上限') && !r.text.includes('本次連線'), '區間 > 186 天回錯誤不查詢', r.text.slice(0, 60));
  }
  {
    const r = await callTool({ from: '2026/07/11', to: '2026/09/11', counties: ['新竹'] });
    check(r.text.includes('有歧義') && r.text.includes('新竹市') && r.text.includes('新竹縣') && !r.text.includes('本次連線'), '歧義縣市名要求指明', r.text.slice(0, 60));
  }
  {
    const r = await callTool({ from: '2023/01/01', to: '2023/03/01' });
    check(r.text.includes('112/07/01') && !r.text.includes('本次連線'), '整段早於 112/07/01 回提示不查詢', r.text.slice(0, 60));
  }
  for (const st of ['無法決標', '撤銷']) {
    for (const extra of [{}, { includeOther: true }]) {
      const r = await callTool({ from: '2026/07/11', to: '2026/09/11', category: '勞務', counties: ['臺中市'], status: st, ...extra });
      check(r.text.includes(`status=${st} 不能搭配 counties`) && r.text.includes('3,960') && r.text.includes('orgName')
        && !r.text.includes('決標查詢：') && !r.text.includes('本次連線') && !r.text.includes('完整') && r.ms < 3000,
        `status=${st}＋counties${extra.includeOther ? '＋includeOther' : ''} 拒絕查詢並說明原因與改法`, `${r.ms}ms：${r.text.slice(0, 50)}`);
    }
  }

  // ---------- 3. 原始碼：匯出路徑錨定 ----------
  console.log('\n[3] 原始碼檢查');
  for (const f of ['src/index.ts', 'src/services/award-service.ts', 'src/services/award-locations.ts']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    check(!/process\s*\.\s*cwd/.test(src), `${f} 沒有 process.cwd`);
  }
  const svcSrc = readFileSync(join(ROOT, 'src/services/award-service.ts'), 'utf8');
  check(/EXPORT_DIR = join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', '\.\.', '\.cache', 'exports'\)/.test(svcSrc), '匯出目錄以 import.meta.url 錨定到專案根 .cache/exports');

  // ---------- 4. 離線素材解析 ----------
  console.log('\n[4] 離線素材解析（' + (FIXTURES || '未設 AWARD_FIXTURES，清單頁解析檢查 SKIP') + '）');
  const svc = await import(pathToFileURL(join(ROOT, 'build', 'services', 'award-service.js')).href);
  const loc = await import(pathToFileURL(join(ROOT, 'build', 'services', 'award-locations.js')).href);
  // 沒設 AWARD_FIXTURES → SKIP；有設卻找不到檔 → FAIL（設錯路徑不可被當成通過）
  const fx = (p) => {
    if (!FIXTURES) { skip(`${p} 解析`, '未設 AWARD_FIXTURES'); return null; }
    const f = join(FIXTURES, p);
    const ok = existsSync(f);
    check(ok, `${p} 存在`);
    return ok ? readFileSync(f, 'utf8') : null;
  };
  {
    const h = fx('fixtures/list_page.html');
    if (h) {
      const r = svc.parseAwardListHtml(h);
      check(r.siteTotal === 37 && r.rows.length === 37, '37 筆清單頁全抓', `${r.siteTotal}/${r.rows.length}`);
      check(r.pagerKey === 'd-16396', '翻頁參數動態抓到', r.pagerKey);
      const c = r.rows.find(x => x.caseNo === 'DGES115-04');
      check(c && c.isCorrection && !/更正/.test(c.caseNo) && c.amount === 1436915 && c.tenderName.includes('東光國民小學'), '更正公告：案號去字樣、旗標、金額、標案名稱');
      check(r.rows.every(x => x.pk && x.linkType === 'atm' && x.url.startsWith('https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=')), '每列都有 pk 與 atm 連結');
    }
  }
  {
    const h = fx('fixtures/list_chk.html');
    if (h) {
      const r = svc.parseAwardListHtml(h);
      check(r.siteTotal === 1 && r.rows.length === 1, '只有 1 筆時不誤選查詢表單', `${r.siteTotal}/${r.rows.length}`);
    }
  }
  {
    const h = fx('award_impl/probe_zero.html');
    if (h) { const r = svc.parseAwardListHtml(h); check(r.siteTotal === 0 && r.rows.length === 0, '0 筆頁 siteTotal=0（非 null）'); }
  }
  {
    const h = fx('award_impl/probe_revoke.html');
    if (h) {
      const r = svc.parseAwardListHtml(h);
      const non = r.rows.filter(x => x.isNonAward);
      check(r.rows.length === 15 && non.length === 4 && non.every(x => x.linkType === 'nonAtm' && x.amount === null && x.nonAwardSeq === '001'), '無法決標列：nonAtm 連結、金額 null', `${r.rows.length} 列，無法決標 ${non.length}`);
    }
  }
  {
    const g = loc.resolveCounties(['南投縣']).groups[0];
    check(JSON.stringify(g?.locations.map(l => l.code)) === JSON.stringify(['EXECUTE_LOCATION_19', 'EXECUTE_LOCATION_20', 'EXECUTE_LOCATION_21', 'EXECUTE_LOCATION_22']), '南投縣展開成 19＋20＋21＋22');
    const t = loc.resolveCounties(['台中市']).groups[0];
    check(JSON.stringify(t?.locations.map(l => l.code)) === JSON.stringify(['EXECUTE_LOCATION_16', 'EXECUTE_LOCATION_20000202', 'EXECUTE_LOCATION_17', 'EXECUTE_LOCATION_18']), '台中市（台→臺）展開含和平區與舊制臺中縣');
    check(loc.EXEC_LOCATIONS.length === 77 && loc.EXEC_LOCATIONS.some(([c]) => c === loc.OTHER_LOCATION_CODE), '靜態對照表 77 個代碼含「其他」');
  }

  if (!OFFLINE) {
    const FROM = '2026/07/11', TO = '2026/09/11';

    // ---------- 5. 小結果集（服務層直接查單一代碼） ----------
    console.log('\n[5] 即時：單查南投縣仁愛鄉 EXECUTE_LOCATION_21（結果 < 26 筆）');
    const small = await svc.queryAwards({ from: 1150711, to: 1150911, category: '勞務', execLocation: 'EXECUTE_LOCATION_21' });
    liveRequests += small.requests;
    console.log(`       官網共有 ${small.siteTotal} 筆／實抓 ${small.rows.length} 筆，連線 ${small.requests} 次${small.error ? '，錯誤：' + small.error : ''}`);
    check(!small.error, '查詢無錯誤');
    check(small.siteTotal > 0 && small.siteTotal < 26, '官網筆數介於 1~25（可驗證查詢表單誤選陷阱）', String(small.siteTotal));
    check(small.rows.length === small.siteTotal, '實抓數 = 官網數');
    check(small.rows.every(r => r.execLocation === 'EXECUTE_LOCATION_21' && r.category === '勞務類'), '每列帶代碼且標的分類為勞務類');
    await sleep(1600);

    // ---------- 6. 主查詢（MCP 工具） ----------
    console.log(`\n[6] 即時：search_awards 勞務｜南投縣｜${FROM}~${TO}｜previewRows=20`);
    const main = await callTool({ category: '勞務', counties: ['南投縣'], from: FROM, to: TO, previewRows: 20 }, 240000);
    liveRequests += countRequests(main.text);
    const locLines = [...main.text.matchAll(/^- (.+?)（(EXECUTE_LOCATION_\d+)）：官網共有 ([\d,?]+) 筆／實抓 ([\d,]+) 筆｜(.+)$/gm)]
      .map(m => ({ label: m[1], code: m[2], n: parseInt(m[3].replace(/,/g, ''), 10), m: parseInt(m[4].replace(/,/g, ''), 10), state: m[5] }));
    for (const l of locLines) console.log(`       ${l.code} ${l.label}：官網共有 ${l.n} 筆／實抓 ${l.m} 筆（${l.state}）`);
    check(JSON.stringify(locLines.map(l => l.code)) === JSON.stringify(['EXECUTE_LOCATION_19', 'EXECUTE_LOCATION_20', 'EXECUTE_LOCATION_21', 'EXECUTE_LOCATION_22']), '摘要列出南投縣 4 個代碼');
    check(locLines.length === 4 && locLines.every(l => Number.isFinite(l.n) && l.n === l.m), '每個代碼 官網共有 N == 實抓 M');
    const c21 = locLines.find(l => l.code === 'EXECUTE_LOCATION_21');
    check(c21 && c21.n === small.siteTotal, '工具查到的仁愛鄉筆數與服務層單查一致', `${c21?.n} vs ${small.siteTotal}`);
    const tm = main.text.match(/官網共有 ([\d,]+) 筆；實抓 ([\d,]+) 筆；合併去重後回傳 ([\d,]+) 筆/);
    const siteTotal = tm ? parseInt(tm[1].replace(/,/g, ''), 10) : NaN;
    const returned = tm ? parseInt(tm[3].replace(/,/g, ''), 10) : NaN;
    console.log(`       總數：官網共有 ${siteTotal} 筆，回傳 ${returned} 筆（先前實測約 338）`);
    check(tm && siteTotal === locLines.reduce((s, l) => s + l.n, 0), '總筆數 = 各代碼加總');
    check(returned > 20, '結果多於 previewRows，需要匯出', String(returned));
    check(/決標金額合計：[\d,]+ 元/.test(main.text), '摘要含決標金額合計');
    check(/更正公告：[\d,]+ 筆/.test(main.text), '摘要含更正公告筆數');
    check(!main.text.includes('已截斷'), '預設 maxRows=500 未截斷');
    const tableRows = main.text.split('\n').filter(l => /^\| \d{3}\/\d{2}\/\d{2} \|/.test(l));
    check(tableRows.length === 20, '回傳文字的表格只有 previewRows=20 列', String(tableRows.length));
    check((main.text.match(/\]\(https:\/\/web\.pcc\.gov\.tw\//g) || []).length === 20, '回傳文字只含 20 個案件連結');

    const csvPath = (main.text.match(/^- CSV：(.+)$/m) || [])[1]?.trim();
    const jsonPath = (main.text.match(/^- JSON：(.+)$/m) || [])[1]?.trim();
    const exportDir = resolve(ROOT, '.cache', 'exports') + sep;
    check(csvPath && resolve(csvPath).startsWith(exportDir) && existsSync(csvPath), 'CSV 寫在專案根 .cache/exports/（MCP 的 CWD 是 System32）', csvPath);
    check(jsonPath && resolve(jsonPath).startsWith(exportDir) && existsSync(jsonPath), 'JSON 寫在專案根 .cache/exports/', jsonPath);
    if (csvPath && existsSync(csvPath) && jsonPath && existsSync(jsonPath)) {
      const bytes = readFileSync(csvPath);
      check(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, 'CSV 開頭是 UTF-8 BOM');
      const csv = bytes.toString('utf8').replace(/^\uFEFF/, '');
      const records = parseCsv(csv);
      const header = records.shift();
      check(header && ['決標公告日', '履約地點', '機關名稱', '標案案號', '標案名稱', '決標金額', '是否更正公告', '連結'].every(h => header.includes(h)), 'CSV 中文欄名', header?.join(','));
      check(records.length === returned, 'CSV 資料列數 = 回傳總數', `${records.length} vs ${returned}`);
      const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
      check(Array.isArray(json.rows) && json.rows.length === returned && json.rowCount === returned, 'JSON rows 數 = 回傳總數');
      const iOrg = header.indexOf('機關名稱'), iName = header.indexOf('標案名稱'), iAmt = header.indexOf('決標金額');
      check(records.length > 0 && records[0][iOrg] === json.rows[0].orgName && /[\u4e00-\u9fff]/.test(records[0][iOrg]) && records[0][iName] === json.rows[0].tenderName,
        'CSV 中文內容與 JSON 一致（非亂碼）', `${records[0]?.[iOrg]}｜${records[0]?.[iName]}`);
      const csvSum = records.reduce((s, r) => s + (r[iAmt] ? parseInt(r[iAmt], 10) : 0), 0);
      const textSum = parseInt((main.text.match(/決標金額合計：([\d,]+) 元/) || ['', 'NaN'])[1].replace(/,/g, ''), 10);
      check(csvSum === textSum, '摘要金額合計 = CSV 金額加總', `${textSum} vs ${csvSum}`);
      const csvCorr = records.filter(r => r[header.indexOf('是否更正公告')] === '是').length;
      const textCorr = parseInt((main.text.match(/更正公告：([\d,]+) 筆/) || ['', 'NaN'])[1], 10);
      check(csvCorr === textCorr, '摘要更正公告筆數 = CSV 更正列數', `${textCorr} vs ${csvCorr}`);
      check(json.rows.every(r => !/更正/.test(r.caseNo) && r.pk && ['atm', 'nonAtm'].includes(r.linkType)), 'JSON 每列案號無更正字樣、有 pk 與連結型態');
    }
    await sleep(1600);

    // ---------- 7. 截斷 ----------
    console.log('\n[7] 即時：maxRows=5 截斷');
    const cut = await callTool({ category: '勞務', counties: ['南投縣'], from: FROM, to: TO, maxRows: 5 }, 240000);
    liveRequests += countRequests(cut.text);
    const cutRows = cut.text.split('\n').filter(l => /^\| \d{3}\/\d{2}\/\d{2} \|/.test(l)).length;
    const cm = cut.text.match(/已截斷：官網共有 ([\d,]+) 筆，maxRows=5，實際只回傳 ([\d,]+) 筆/);
    console.log('       ' + (cm ? cm[0] : '(找不到截斷說明)'));
    check(Boolean(cm), '摘要明說已截斷、官網總數與實際回傳數');
    check(cm && parseInt(cm[1].replace(/,/g, ''), 10) === siteTotal && cm[2] === '5', '截斷說明的官網總數與主查詢一致、回傳 5 筆', cm ? `${cm[1]} vs ${siteTotal}` : '');
    check(cutRows === 5, '表格 5 列', String(cutRows));
    check(!cut.text.includes('- CSV：'), '5 筆 ≤ previewRows 不匯出');
    const cutLocs = [...cut.text.matchAll(/（(EXECUTE_LOCATION_\d+)）：官網共有 ([\d,]+) 筆／實抓 ([\d,]+) 筆/g)];
    check(cutLocs.length === 4 && cutLocs.every(m => m[2] !== '?'), '截斷時仍列出每個代碼的官網總數');

    console.log(`\n即時請求合計（清單端點）：${liveRequests} 次；內頁 0 次`);
  }
} catch (e) {
  console.log(`  FAIL  例外：${e.stack || e.message}`);
  failed++;
} finally {
  srv.kill();
}

const skipNote = skipped > 0 ? `（另有 ${skipped} 項 SKIP，未計入通過）` : '';
console.log(failed === 0 ? `\nALL PASS${skipNote}` : `\n${failed} 項 FAIL${skipNote}`);
process.exit(failed === 0 ? 0 : 1);

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\r') { }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
