// get_award_detail 驗收腳本：工具註冊、輸入正規化、離線解析＋答案比對、快取與流量控制（mock axios，不連網）、git diff 衛生
// 用法：node _smoke_award_detail.mjs          （完全不連網）
//       node _smoke_award_detail.mjs --live   （另外即時抓 1 筆決標＋1 筆無法決標內頁，寫入正式快取；清單端點 1~2 次、內頁 ≤2 次）
// 離線素材不進 repo：
//   AWARD_FIXTURES=<素材資料夾本身，或其上一層>（*detail*.html 是決標公告內頁共 9 份、ground_truth.json 是已知答案），沒設就 SKIP
//   AWARD_ANSWERS=<vendors_cache.json>（以 pk 為鍵的已解析答案），沒設就 SKIP 答案比對
//   AWARD_LIVE_DUMP=<資料夾>（--live 時把內頁原始 HTML 存下來除錯用，可不設）
// 任一檢查失敗 exit code 1
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import axios from 'axios';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LIVE = process.argv.includes('--live');
const FIXTURES = process.env.AWARD_FIXTURES || '';
const ANSWERS = process.env.AWARD_ANSWERS || '';

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

const svc = await import(pathToFileURL(join(ROOT, 'build', 'services', 'award-detail-crawler.js')).href);
const b64 = s => Buffer.from(s).toString('base64');
const DETAIL_RE = /detail.*\.html$/;
// J：AWARD_FIXTURES 可指向素材資料夾本身，或其上一層（底下有 fixtures/）
const fxDir = !FIXTURES ? ''
  : existsSync(FIXTURES) && readdirSync(FIXTURES).some(f => DETAIL_RE.test(f)) ? FIXTURES
  : join(FIXTURES, 'fixtures');
// D：滾動額度跨呼叫共用，各段測試開頭清空（舊 build 沒有這些函式時為 no-op）
// M：額度／冷卻起點還會寫進快取資料夾的 award-rate.json，清記憶體時要連檔案一起清
const clearRateFiles = () => {
  if (!tmpRoot) return;
  const dirs = [tmpRoot, ...readdirSync(tmpRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(tmpRoot, e.name))];
  for (const d of dirs) { try { rmSync(join(d, 'award-rate.json'), { force: true }); } catch { } }
};
const resetWindow = () => { svc.resetAwardDetailWindow?.(); clearRateFiles(); };
const resetCooldown = () => { svc.resetAwardBlockCooldown?.(); clearRateFiles(); };
const ATM = p => `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${p}`;
const NON_ATM = p => `https://web.pcc.gov.tw/prkms/urlSelector/common/nonAtm?pk=${p}`;
const hhmmTaipei = t => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));

// ---------- MCP client（CWD 故意設成 System32，驗證快取路徑不依賴工作目錄） ----------
const sys32 = 'C:\\Windows\\System32';
function startServer() {
  const srv = spawn(process.execPath, [join(ROOT, 'build', 'index.js')], { stdio: ['pipe', 'pipe', 'pipe'], cwd: existsSync(sys32) ? sys32 : ROOT });
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
  const init = async () => {
    const r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-award-detail', version: '0' } });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return r;
  };
  const call = async (args, timeoutMs = 20000) => {
    const r = await rpc('tools/call', { name: 'get_award_detail', arguments: args }, timeoutMs);
    return { text: r.result?.content?.map(c => c.text).join('\n') ?? '', isError: Boolean(r.result?.isError || r.error), raw: r };
  };
  return { srv, rpc, init, call };
}

// ---------- mock axios ----------
const realGet = axios.get;
const td = (k, v) => `<tr><td class="tbg_4">${k}</td><td class="tbg_4R">${v}</td></tr>`;
const awardHtml = (caseNo) => `<html><body><table>
${td('機關名稱', '測試機關')}${td('標案案號', caseNo)}${td('標案名稱', `測試案 ${caseNo}`)}${td('決標方式', '最低標')}
${td('預算金額', '1,000,000元 壹佰萬元')}${td('履約地點（含地區）', '臺中市－西屯區')}${td('投標廠商家數', '2')}
${td('投標廠商1', '')}${td('廠商代碼', '12345678')}${td('廠商名稱', '甲工程顧問有限公司')}${td('是否得標', '是')}${td('是否為中小企業', '是')}${td('決標金額', '900,000元')}
${td('投標廠商2', '')}${td('廠商代碼', 'A1234*****')}${td('廠商名稱', '乙建築師事務所')}${td('是否得標', '否')}
${td('簽約廠商家數', '0')}${td('決標日期', '115/08/01')}${td('決標公告日期', '115/08/10')}${td('總決標金額', '900,000元')}
</table></body></html>`;
const nonAwardHtml = `<html><body><table>
${td('機關名稱', '測試機關')}${td('標案案號', 'N-001')}${td('標案名稱', '流標測試案')}${td('標的分類', '&lt;勞務類&gt; 8671 建築服務')}
${td('無法決標的理由', '無廠商投標')}${td('原招標公告之刊登採購公報日期', '115/08/01')}${td('無法決標公告日期', '115/08/12')}${td('是否沿用本案號及原招標方式續行招標', '是')}
</table></body></html>`;
const captchaHtml = '<html><body><h3>請點選撲克牌</h3><div>A區</div><div>B區</div><input name="captcha">請輸入圖形驗證碼</body></html>';
const wafHtml = '<html><body>Web Page Blocked! Attack ID 20000021</body></html>';

let calls = [];
let inFlight = 0;
let maxInFlight = 0;
let routes = new Map(); // pk -> { status, html }
let hooks = new Map(); // pk -> 收到請求時要做的事（模擬另一個 MCP 行程同時在寫檔）
function installMock() {
  axios.get = async (url) => {
    const t = Date.now();
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ url, t });
    try {
      await new Promise(r => setTimeout(r, 50));
      const pk = decodeURIComponent((String(url).match(/pkAtmMain=([^&]+)/) || [])[1] || '');
      const route = routes.get(pk) ?? { status: 200, html: '<html>unexpected</html>' };
      hooks.get(pk)?.();
      return { status: route.status, data: Buffer.from(route.html, 'utf8'), headers: {} };
    } finally {
      inFlight--;
    }
  };
}
const resetCalls = () => { calls = []; maxInFlight = 0; };

let tmpRoot = '';
let server = null;

try {
  // ---------- 1. 註冊與描述、MCP 層錯誤輸入 ----------
  console.log('\n[1] tools/list、server instructions、MCP 層錯誤輸入（不連網）');
  server = startServer();
  const init = await server.init();
  const instr = init.result?.instructions ?? '';
  const tools = (await server.rpc('tools/list')).result.tools;
  const names = tools.map(t => t.name);
  for (const n of ['search_tenders', 'get_tender_detail', 'search_tender_archive', 'search_awards', 'get_award_detail']) check(names.includes(n), `${n} 已註冊`);
  // 不寫死總數：之後新增工具不該讓這支誤報（總數由 _smoke_mcp.mjs 檢查）
  check(names.length >= 5 && new Set(names).size === names.length, '工具名稱不重複且不少於本功能所需', names.join(', '));
  const tool = tools.find(t => t.name === 'get_award_detail');
  const props = tool?.inputSchema?.properties ?? {};
  check(JSON.stringify(Object.keys(props)) === '["cases","full"]', '參數為 cases、full', Object.keys(props).join(', '));
  check(JSON.stringify(tool?.inputSchema?.required ?? []) === '["cases"]', 'cases 必填、full 選填');
  check(props.cases?.minItems === 1 && props.cases?.maxItems === 50, 'cases 1~50 筆', `${props.cases?.minItems}~${props.cases?.maxItems}`);
  const desc = tool?.description ?? '';
  check(desc.includes('RATE LIMIT') && desc.includes('re-querying them is free'), '描述①流量控制、已查過免費');
  check(desc.includes('MASKED') && desc.includes('F1275*****'), '描述②統編可能被遮蔽');
  check(desc.includes('決標公告日期 ≠ 決標日期'), '描述③決標公告日≠決標日');
  check(desc.includes('Pass the FULL link') && desc.includes('treated as a 決標公告'), '描述④傳完整連結、純 pk 預設決標公告');
  check(desc.includes('use get_tender_detail for 招標公告'), '描述⑤招標公告用 get_tender_detail');
  check(desc.includes('at most 5 detail-page requests in ANY rolling 10-minute window') && desc.includes('shared across all calls'), 'D：描述說明任意 10 分鐘 5 筆、跨呼叫共用');
  check(desc.includes('first 5 successful cases'), 'E：描述說明 full=true 只列前 5 筆的全部欄位');
  check(/7\. 要查得標廠商／投標家數／落標廠商，用 get_award_detail/.test(instr) && instr.includes('不要把決標公告或無法決標公告的連結餵給 get_tender_detail'), 'instructions 新增第 7 條');
  // U：額度是「請求次數」不是「未快取的案子數」：種類不符、解析失敗、連線錯誤也會佔額度
  const U_PHRASE = '任意 10 分鐘內最多 5 次內頁請求（種類不符、解析失敗、連線錯誤也會佔額度）';
  const instr7 = instr.slice(instr.indexOf('7. 要查得標廠商'));
  check(desc.includes(U_PHRASE) && !/UNCACHED cases/i.test(desc), 'U：工具描述改為「任意 10 分鐘內最多 5 次內頁請求（…也會佔額度）」、不再說 5 筆未快取的案子');
  check(instr7.includes(U_PHRASE) && !instr7.includes('未快取的案子'), 'U：instructions 第 7 條同步改用詞', instr7.split('\n').pop());
  check((props.cases?.description ?? '').includes('次內頁請求') && !(props.cases?.description ?? '').includes('筆未快取'), 'U：cases 參數說明同步改用詞', props.cases?.description);
  for (const key of ['兩個工具都要跑', '不可靜默省略', '不要試圖繞過驗證碼', '一律用 search_awards']) check(instr.includes(key), `instructions 原有規則仍在：「${key}」`);
  {
    const r = await server.call({ cases: ['https://web.pcc.gov.tw/prkms/urlSelector/common/tpam?pk=NzEyOTA0MjQ=', '這不是連結'] });
    check(r.text.includes('get_tender_detail') && r.text.includes('無法辨識') && r.text.includes('未取得 2 筆') && r.text.includes('本次連線內頁 0 次'),
      'MCP：招標連結被拒並提示 get_tender_detail、亂碼回無法辨識、沒有連線', r.text.split('\n').filter(l => l.includes('第 ')).join(' / '));
  }
  {
    const r = await server.call({ cases: Array.from({ length: 51 }, (_, i) => b64(String(80000000 + i))) });
    check(r.isError || /50|too_big|Too big/i.test(r.text), 'MCP：cases 超過 50 筆被參數驗證擋下', r.text.slice(0, 80));
  }
  server.srv.kill();
  server = null;

  // ---------- 2. 輸入正規化 ----------
  console.log('\n[2] 輸入正規化');
  const PK = 'NzEyNjU0MjU=';
  const cases = [
    [`https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${PK}`, 'award', false, 'urlSelector atm?pk='],
    [`https://web.pcc.gov.tw/prkms/urlSelector/common/nonAtm?pk=${encodeURIComponent(PK)}`, 'nonAward', false, 'urlSelector nonAtm?pk=（%3D 編碼）'],
    [`https://web.pcc.gov.tw/tps/atm/AtmAwardWithoutSso/QueryAtmAwardDetail?pkAtmMain=${PK}`, 'award', false, 'QueryAtmAwardDetail?pkAtmMain='],
    [`https://web.pcc.gov.tw/tps/atm/AtmNonAwardWithoutSso/QueryAtmNonAwardDetail?pkAtmMain=${PK}`, 'nonAward', false, 'QueryAtmNonAwardDetail?pkAtmMain='],
    [`  ${PK}  `, 'award', true, '純 pk（前後空白）'],
  ];
  for (const [input, kind, assumed, label] of cases) {
    const n = svc.normalizeAwardInput(input);
    const expectUrl = (kind === 'award'
      ? 'https://web.pcc.gov.tw/tps/atm/AtmAwardWithoutSso/QueryAtmAwardDetail?pkAtmMain='
      : 'https://web.pcc.gov.tw/tps/atm/AtmNonAwardWithoutSso/QueryAtmNonAwardDetail?pkAtmMain=') + encodeURIComponent(PK);
    check(n.ok && n.value.kind === kind && n.value.pk === PK && n.value.assumedKind === assumed && n.value.url === expectUrl,
      `${label} → ${kind}${assumed ? '（預設）' : ''}`, n.ok ? `${n.value.kind} ${n.value.pk} ${n.value.url}` : n.message);
  }
  // B：pk 只收 base64＋% 字元，Markdown 連結、角括號、尾端 ] ) > 不可吃進 pk
  for (const [input, kind, label] of [
    [`[決標公告](${ATM(PK)})`, 'award', 'Markdown 連結 [決標公告](url)'],
    [`[無法決標公告](${NON_ATM(encodeURIComponent(PK))})`, 'nonAward', 'Markdown 連結（%3D 編碼）'],
    [`<${ATM(PK)}>`, 'award', '角括號 <url>'],
    [`(${ATM(PK)})`, 'award', '圓括號包住、尾端 )'],
    [`https://web.pcc.gov.tw/tps/atm/AtmAwardWithoutSso/QueryAtmAwardDetail?pkAtmMain=${PK}]`, 'award', '尾端 ]'],
    [`${NON_ATM(PK)}>`, 'nonAward', '尾端 >'],
    [`| 1 | 測試機關 | A-001 | 測試案 | 115/08/10 | 900,000 | [決標公告](${ATM(PK)}) |`, 'award', 'search_awards 表格整列貼進來'],
  ]) {
    const n = svc.normalizeAwardInput(input);
    check(n.ok && n.value.kind === kind && n.value.pk === PK && n.value.assumedKind === false,
      `B：${label} → ${kind}、pk 正確`, n.ok ? `${n.value.kind} ${n.value.pk}` : n.message);
  }
  // K：連結裡的 pk 後面必須緊接分隔符。`atm?pk=NzEy!ODE3MTM=` 被截成 NzEy（base64 解碼＝712）會抓到別的案子
  for (const [input, label] of [
    [`${ATM('NzEy')}!ODE3MTM=`, 'atm pk 後接 !（會被截成 NzEy＝712）'],
    [`${NON_ATM('NzEy')}*ODE3MTM=`, 'nonAtm pk 後接 *'],
    [`https://web.pcc.gov.tw/tps/atm/AtmAwardWithoutSso/QueryAtmAwardDetail?pkAtmMain=NzEy!ODE3MTM=`, 'pkAtmMain 後接 !'],
    [`https://web.pcc.gov.tw/tps/atm/AtmNonAwardWithoutSso/QueryAtmNonAwardDetail?pkAtmMain=NzEy=ODE3MTM`, 'nonAward pkAtmMain 中間有 ='],
    [ATM(b64('abcd')), '連結裡的 pk 解碼不是純數字（YWJjZA==）'],
  ]) {
    const n = svc.normalizeAwardInput(input);
    check(!n.ok && n.failure === 'invalid', `K：${label} → invalid`,
      n.ok ? `誤判成 pk=${n.value.pk}（解碼＝${Buffer.from(n.value.pk, 'base64').toString('latin1')}）` : n.message);
  }
  // K：既有的合法包裝形式不可被誤擋
  for (const [input, kind, label] of [
    [`決標公告：${ATM(PK)}，請查`, 'award', 'pk 後接全形逗號'],
    [`${ATM(PK)}。`, 'award', 'pk 後接全形句號'],
    [`（${ATM(PK)}）`, 'award', '全形括號包住'],
    ['`' + ATM(PK) + '`', 'award', '反引號包住'],
    [`"${ATM(PK)}"`, 'award', '雙引號包住'],
    [`${ATM(PK)}&foo=1`, 'award', 'pk 後接 &'],
    [`${ATM(PK)}#x`, 'award', 'pk 後接 #'],
    [`${NON_ATM(PK)} 後面還有字`, 'nonAward', 'pk 後接空白'],
  ]) {
    const n = svc.normalizeAwardInput(input);
    check(n.ok && n.value.kind === kind && n.value.pk === PK, `K：${label} 仍正確取出 pk`, n.ok ? `${n.value.kind} ${n.value.pk}` : n.message);
  }
  // T：純 pk 前後包的 ` < > [ ] ( ) 與引號要先剝除再判斷
  for (const [input, label] of [
    ['`' + PK + '`', '反引號包住'],
    [`<${PK}>`, '角括號包住'],
    [`[${PK}]`, '方括號包住'],
    [`(${PK})`, '圓括號包住'],
    [`"${PK}"`, '雙引號包住'],
    [`'${PK}'`, '單引號包住'],
    ['  `' + PK + '`  ', '反引號＋前後空白'],
  ]) {
    const n = svc.normalizeAwardInput(input);
    check(n.ok && n.value.kind === 'award' && n.value.pk === PK && n.value.assumedKind === true,
      `T：純 pk ${label} 仍可辨識`, n.ok ? `${n.value.kind} ${n.value.pk}` : n.message);
  }
  for (const [input, label] of [
    ['https://web.pcc.gov.tw/prkms/urlSelector/common/tpam?pk=NzEyOTA0MjQ=', 'tpam?pk='],
    ['https://web.pcc.gov.tw/tps/QueryTender/query/searchTenderDetail?pkPmsMain=NzEyOTA0MjQ=', 'searchTenderDetail?pkPmsMain='],
  ]) {
    const n = svc.normalizeAwardInput(input);
    check(!n.ok && n.failure === 'tender' && n.message.includes('get_tender_detail'), `招標連結 ${label} 被拒並提示 get_tender_detail`, n.ok ? 'ok?' : n.message);
  }
  for (const input of ['', '這不是連結', 'hello', 'abcd', '/tps/foo', 'https://web.pcc.gov.tw/prkms/tender/common/agent/indexTenderAgent', 'https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=']) {
    const n = svc.normalizeAwardInput(input);
    check(!n.ok && n.failure === 'invalid', `無法辨識的字串回錯誤：${JSON.stringify(input)}`, n.ok ? `誤判成 ${n.value.kind}` : n.message);
  }

  // ---------- 3. 離線素材解析＋答案比對 ----------
  console.log('\n[3] 離線決標內頁素材（' + (FIXTURES || '未設 AWARD_FIXTURES') + '）');
  const parsed = [];
  if (!FIXTURES) {
    skip('決標內頁素材解析', '未設 AWARD_FIXTURES');
  } else {
    const files = existsSync(fxDir) ? readdirSync(fxDir).filter(f => DETAIL_RE.test(f)).sort() : [];
    check(files.length === 9, `J：找到決標內頁素材 ${files.length} 個（應為 9）`, fxDir);
    for (const f of files) {
      const p = svc.parseAwardDetailHtml(readFileSync(join(fxDir, f), 'utf8'));
      const r = p.record;
      const ok = p.type === 'award' && r.bidderCount > 0 && r.winners.length >= 1 && (r.budget != null || r.totalAward != null);
      check(ok, `${f}：決標頁、投標家數、得標廠商、金額`, p.type !== 'award' ? p.type : `${r.orgName}｜${r.caseNo}｜家數 ${r.bidderCount}｜得標 ${r.winners.map(w => `${w.name}/${w.vendorId}`).join('、')}｜預算 ${r.budget}｜總決標 ${r.totalAward}｜減標率 ${r.discountRate}`);
      if (p.type === 'award') {
        parsed.push({ file: f, rec: r });
        const lastFloor = p.pairs.filter(([k]) => k === '底價金額').pop();
        const expectFloor = lastFloor ? Number((lastFloor[1].replace(/,/g, '').match(/(\d+)\s*元/) || [])[1]) : null;
        check(r.floorPrice === expectFloor, `${f}：底價金額取全案層級（最後一格）`, `${r.floorPrice} vs ${expectFloor}`);
      }
    }
  }
  {
    // 合成頁面，不需要素材
    const nd = svc.parseAwardDetailHtml(nonAwardHtml);
    check(nd.type === 'nonAward' && nd.record.reason === '無廠商投標' && nd.record.category === '<勞務類> 8671 建築服務', '無法決標頁（合成）判別與實體字元解碼');
    const nd2 = svc.parseAwardDetailHtml(nonAwardHtml.replace('</table>', `${td('投標廠商家數', '2')}</table>`));
    check(nd2.type === 'nonAward', '無法決標頁即使也列投標廠商家數，仍判為無法決標');
    check(svc.parseAwardDetailHtml(captchaHtml).type === 'blocked' && svc.parseAwardDetailHtml(wafHtml).type === 'blocked', '驗證碼頁與 WAF 頁判為 blocked');
    const odd = svc.parseAwardDetailHtml('<html><body>系統維護中</body></html>');
    check(odd.type === 'parse' && /\d+ 字元/.test(odd.message), '其他頁面判為解析失敗並附回應長度', odd.message);

    // 版型仿 detail_6：品項區每個得標廠商下有品項底價，全案底價在「決標公告序號」之後
    const itemsHtml = (multi, caseFloor) => `<html><body><table>
${td('機關名稱', '測試機關')}${td('標案案號', 'M-001')}${td('標案名稱', '兩品項測試案')}${td('是否複數決標', multi ? '是' : '否')}${td('預算金額', '2,000元')}${td('投標廠商家數', '2')}
${td('投標廠商1', '')}${td('廠商代碼', '11111111')}${td('廠商名稱', '甲公司')}${td('是否得標', '是')}
${td('投標廠商2', '')}${td('廠商代碼', '22222222')}${td('廠商名稱', '乙公司')}${td('是否得標', '是')}
${td('決標品項數', multi ? '2' : '1')}${td('第1品項', '')}${td('品項名稱', '北區')}${td('得標廠商1', '')}${td('得標廠商', '甲公司')}${td('決標金額', '550元')}${td('底價金額', '600元')}
${multi ? `${td('第2品項', '')}${td('品項名稱', '南區')}${td('得標廠商1', '')}${td('得標廠商', '乙公司')}${td('決標金額', '1,000元')}${td('底價金額', '1,100元')}` : ''}
${td('決標公告序號', '001')}${td('決標日期', '115/08/01')}${caseFloor ? td('底價金額', caseFloor) : ''}${td('總決標金額', '1,550元')}
</table></body></html>`;
    const m2 = svc.parseAwardDetailHtml(itemsHtml(true, '1,700元'));
    check(m2.type === 'award' && m2.record.floorPrice === 1700, '複數決標兩品項：底價金額取全案 1700，不取第 1 品項 600', `${m2.record?.floorPrice}`);
    const m3 = svc.parseAwardDetailHtml(itemsHtml(true, ''));
    check(m3.type === 'award' && m3.record.floorPrice === null, '複數決標且全案底價缺：留空，不拿品項底價充數', `${m3.record?.floorPrice}`);
    const s1 = svc.parseAwardDetailHtml(itemsHtml(false, ''));
    check(s1.type === 'award' && s1.record.floorPrice === 600, '單一品項且全案底價缺：退回品項底價（兩者相同）', `${s1.record?.floorPrice}`);

    // G：表格儲存格的 < > | 要跳脫（<勞務類> 會被部分渲染器當 HTML 標籤吃掉）
    const gHtml = awardHtml('G-001')
      .replace(td('廠商名稱', '甲工程顧問有限公司'), td('廠商名稱', '甲&lt;乙&gt;|丙公司'))
      .replace(td('決標方式', '最低標'), `${td('決標方式', '最低標')}${td('標的分類', '&lt;勞務類&gt; 8672 工程服務')}`);
    const g = svc.parseAwardDetailHtml(gHtml);
    const gBatch = r => ({ results: [{ input: 'x', kind: g.type, pk: 'p', url: 'https://example.invalid/', assumedKind: false, ok: true, cached: false, record: r, pairs: g.pairs }], fetched: 1, cachedCount: 0, blocked: false, cooldown: false, overLimit: 0 });
    const gMd = svc.renderAwardDetails(gBatch(g.record));
    const gFull = svc.renderAwardDetails(gBatch(g.record), { full: true });
    check(g.type === 'award' && gMd.includes('| 1 | 甲&lt;乙&gt;\\|丙公司 |') && gMd.includes('甲&lt;乙&gt;\\|丙公司（統編 12345678）') && !/<乙>|<勞務類>/.test(gFull),
      'G：精選表與投標廠商表的 < > | 已跳脫', gMd.split('\n').filter(l => l.includes('丙公司')).join(' / '));
    check(gFull.includes('| 標的分類 | &lt;勞務類&gt; 8672 工程服務 |'), 'G：full=true 全部欄位表的 < > 已跳脫');
    const nd0 = svc.parseAwardDetailHtml(nonAwardHtml);
    const ngBatch = gBatch(nd0.record);
    ngBatch.results[0] = { ...ngBatch.results[0], kind: 'nonAward', pairs: nd0.pairs };
    const ngMd = svc.renderAwardDetails(ngBatch);
    check(ngMd.includes('| 標的分類 | &lt;勞務類&gt; 8671 建築服務 |') && !ngMd.includes('<勞務類>'), 'G：無法決標表的 < > 已跳脫');

    // S：表格儲存格以外——#### 標題、「機關…｜案號…」行、未取得清單的輸入字串，也要跳脫 < > | 與反引號
    const sHtml = `<html><body><table>
${td('機關名稱', '測&lt;試&gt;|`機關')}${td('標案案號', 'S-&lt;001&gt;|`x')}${td('標案名稱', '標案&lt;b&gt;|`名')}${td('投標廠商家數', '1')}
${td('投標廠商1', '')}${td('廠商代碼', '12345678')}${td('廠商名稱', '甲公司')}${td('是否得標', '是')}
</table></body></html>`;
    const s = svc.parseAwardDetailHtml(sHtml);
    const sMd = svc.renderAwardDetails({
      results: [
        { input: 'x', kind: 'award', pk: 'p', url: 'https://example.invalid/', assumedKind: false, ok: true, cached: false, record: s.record, pairs: s.pairs },
        { input: '<b>|`inj`', pk: '', url: '', assumedKind: false, ok: false, cached: false, failure: 'invalid', message: '無法辨識' },
      ],
      fetched: 1, cachedCount: 0, blocked: false, cooldown: false, overLimit: 0, duplicates: 0,
    });
    const sLines = sMd.split('\n');
    const sHead = sLines.find(l => l.startsWith('#### 1.')) ?? '';
    const sOrg = sLines.find(l => l.startsWith('機關 ')) ?? '';
    const sFail = sLines.find(l => l.includes('第 2 筆')) ?? '';
    check(sHead === '#### 1. 標案&lt;b&gt;\\|\\`名', 'S：#### 標題的標案名稱跳脫 < > | 與反引號', sHead);
    check(sOrg.includes('測&lt;試&gt;\\|\\`機關') && sOrg.includes('S-&lt;001&gt;\\|\\`x') && !/<試>|<001>/.test(sOrg), 'S：「機關…｜案號…」行跳脫 < > | 與反引號', sOrg);
    check(sFail.includes('&lt;b&gt;\\|\\`inj\\`') && !/<b>/.test(sFail), 'S：未取得清單顯示的輸入字串跳脫 < > | 與反引號', sFail);
  }

  const norm = xs => xs.map(b => `${b.name}|${b.vendorId}`).sort();
  if (!FIXTURES || !ANSWERS) {
    skip('答案比對 vendors_cache.json', !FIXTURES ? '未設 AWARD_FIXTURES' : '未設 AWARD_ANSWERS');
  } else {
    const answers = Object.values(JSON.parse(readFileSync(ANSWERS, 'utf8')));
    let matched = 0, multi = 0;
    for (const { file, rec } of parsed) {
      const a = answers.find(x => x.caseNo === rec.caseNo && x.org === rec.orgName);
      if (!a) { console.log(`        ${file}：${rec.orgName}｜${rec.caseNo} 不在答案檔（不比對）`); continue; }
      matched++;
      const aw = a.bidders.filter(b => b.won === '是').map(b => ({ name: b.name, vendorId: b.id }));
      const al = a.bidders.filter(b => b.won === '否').map(b => ({ name: b.name, vendorId: b.id }));
      check(JSON.stringify(norm(rec.winners)) === JSON.stringify(norm(aw)), `${file}（pk ${a.pk}）得標廠商名稱＋統編一致`, norm(rec.winners).join('、'));
      check(String(rec.bidderCount) === String(a.bidderCount), `${file} 投標家數一致`, `${rec.bidderCount} vs ${a.bidderCount}`);
      check(JSON.stringify(norm(rec.losers)) === JSON.stringify(norm(al)), `${file} 落標廠商名單一致`, norm(rec.losers).join('、') || '無');
      check(rec.budget === a.budget && rec.totalAward === a.totalAward, `${file} 預算／總決標金額一致`, `${rec.budget}/${rec.totalAward}`);
      if (a.bidders.length > 1) multi++;
    }
    check(matched > 0, `素材中對到答案的案件 ${matched} 件`);
    check(multi > 0, `其中多家投標案 ${multi} 件（驗證落標廠商列出）`);

    const gt = JSON.parse(readFileSync(join(fxDir, 'ground_truth.json'), 'utf8'));
    let gtHits = 0;
    for (const v of gt.vendors) {
      for (const c of v.cases) {
        const hit = parsed.find(p => p.rec.caseNo === c.caseNo && p.rec.orgName === c.org);
        if (!hit) continue;
        gtHits++;
        check(hit.rec.winners.some(w => w.name === v.name && w.vendorId === v.id) && hit.rec.bidderCount === c.bidders,
          `ground_truth：${c.org}｜${c.caseNo} 得標 ${v.name}（${v.id}）、${c.bidders} 家投標`);
      }
    }
    console.log(`        ground_truth 在素材中對到 ${gtHits} 件`);
  }

  // ---------- 4. 快取（mock axios，不連網） ----------
  console.log('\n[4] 快取（mock axios）');
  tmpRoot = mkdtempSync(join(tmpdir(), 'award-detail-smoke-'));
  const cacheFile = join(tmpRoot, 'award-details.json');
  const readCache = () => existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  installMock();
  const pkA = b64('90000001');
  routes.set(pkA, { status: 200, html: awardHtml('A-001') });
  {
    resetWindow();
    resetCalls();
    const r1 = await svc.fetchAwardDetails([`https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${pkA}`], { cacheFile });
    check(calls.length === 1 && r1.fetched === 1 && r1.results[0].ok && !r1.results[0].cached, '第一次：發 1 次請求、本次抓取');
    const c = readCache()[`award:${pkA}`];
    check(c && c.record?.caseNo === 'A-001' && Array.isArray(c.pairs) && c.pairs.length > 10 && !Number.isNaN(Date.parse(c.savedAt)), '快取鍵 award:<pk>，存紀錄＋全部配對＋savedAt');
    const rec = r1.results[0].record;
    check(rec.winners.length === 1 && rec.winners[0].vendorId === '12345678' && rec.losers.length === 1 && rec.losers[0].vendorId === 'A1234*****' && rec.discountRate === 10,
      '衍生欄位：得標／落標（遮蔽統編原樣保留）、減標率 10.00', `${rec.discountRate}`);
    resetCalls();
    const r2 = await svc.fetchAwardDetails([`https://web.pcc.gov.tw/tps/atm/AtmAwardWithoutSso/QueryAtmAwardDetail?pkAtmMain=${pkA}`], { cacheFile });
    check(calls.length === 0 && r2.fetched === 0 && r2.results[0].ok && r2.results[0].cached, '第二次同一 pk：不發請求、標示快取');
    const md = svc.renderAwardDetails(r2);
    check(/（本地快取，\d{4}-\d{2}-\d{2} \d{2}:\d{2} 抓取）/.test(md) && md.includes('本次實抓 0 筆、快取 1 筆、未取得 0 筆') && md.includes('甲工程顧問有限公司（統編 12345678）') && md.includes('| 減標率 | 10.00% |'),
      'Markdown 標示本地快取（含抓取時間）、摘要、得標廠商＋統編、減標率');
    const mdFull = svc.renderAwardDetails(r2, { full: true });
    check(mdFull.includes('全部內頁欄位') && mdFull.includes('| 簽約廠商家數 | 0 |') && !md.includes('全部內頁欄位'), 'full=true 另附全部欄位，預設不附');
  }
  {
    const pkP = b64('90000002');
    routes.set(pkP, { status: 200, html: '<html><body>系統維護中</body></html>' });
    resetWindow();
    resetCalls();
    const r = await svc.fetchAwardDetails([pkP], { cacheFile });
    check(calls.length === 1 && !r.results[0].ok && r.results[0].failure === 'parse' && !readCache()[`award:${pkP}`], '解析失敗：不寫快取');
    resetCalls();
    const again = await svc.fetchAwardDetails([pkP], { cacheFile });
    check(calls.length === 1 && again.results[0].failure === 'parse', '解析失敗的案子再查會重新連線（確實沒快取）');
    const md = svc.renderAwardDetails(r);
    check(md.includes('（純 pk 預設當決標公告）') && md.includes('未寫入快取'), '未取得清單註明純 pk 預設當決標公告、未寫入快取');
  }
  {
    const pkW = b64('90000003');
    routes.set(pkW, { status: 500, html: wafHtml });
    resetCooldown();
    resetWindow();
    resetCalls();
    const r = await svc.fetchAwardDetails([pkW], { cacheFile });
    check(calls.length === 1 && r.blocked && r.results[0].failure === 'blocked' && !readCache()[`award:${pkW}`], 'WAF（HTTP 500 Web Page Blocked）：判為被擋、不寫快取');
    resetCooldown();
  }
  {
    const pkE = b64('90000005');
    const mockGet = axios.get;
    axios.get = async (url) => { calls.push({ url, t: Date.now() }); throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };
    resetWindow();
    resetCalls();
    const r = await svc.fetchAwardDetails([pkE], { cacheFile });
    axios.get = mockGet;
    check(calls.length === 1 && !r.blocked && r.results[0].failure === 'error' && r.results[0].message.includes('ECONNRESET') && !readCache()[`award:${pkE}`],
      '連線錯誤：只打 1 次不重試、回報錯誤、不寫快取', r.results[0].message);
  }
  {
    const pkN = b64('90000004');
    routes.set(pkN, { status: 200, html: nonAwardHtml });
    resetWindow();
    resetCalls();
    const r = await svc.fetchAwardDetails([`https://web.pcc.gov.tw/prkms/urlSelector/common/nonAtm?pk=${pkN}`], { cacheFile });
    const md = svc.renderAwardDetails(r);
    check(calls[0]?.url.includes('/tps/atm/AtmNonAwardWithoutSso/QueryAtmNonAwardDetail?pkAtmMain=') && r.results[0].ok && readCache()[`nonAward:${pkN}`],
      'nonAtm 連結打無法決標內頁端點、快取鍵 nonAward:<pk>');
    check(md.includes('**無法決標公告**') && md.includes('| 無法決標的理由 | 無廠商投標 |') && md.includes('| 無法決標公告日期 | 115/08/12 |'), 'Markdown 顯示無法決標理由與日期');
  }
  {
    // I：快取命中標示抓取時間（savedAt 轉臺北時間 yyyy-MM-dd HH:mm）
    const iFile = join(tmpRoot, 'savedat', 'award-details.json');
    mkdirSync(dirname(iFile), { recursive: true });
    const p = svc.parseAwardDetailHtml(awardHtml('S-001'));
    const pkS = b64('95000001');
    writeFileSync(iFile, JSON.stringify({ [`award:${pkS}`]: { kind: 'award', pk: pkS, url: ATM(pkS), record: p.record, pairs: p.pairs, savedAt: '2026-01-02T03:04:05.000Z' } }));
    resetCalls();
    const r = await svc.fetchAwardDetails([pkS], { cacheFile: iFile });
    const md = svc.renderAwardDetails(r);
    check(calls.length === 0 && r.results[0].cached && md.includes('（本地快取，2026-01-02 11:04 抓取）'), 'I：快取命中標示抓取時間（本地時間 yyyy-MM-dd HH:mm）',
      md.split('\n').find(l => l.includes('本地快取')) ?? '');
  }
  {
    // H：同一呼叫重複輸入同一 kind:pk 只抓一次，摘要以不重複案件計
    resetWindow();
    const pkH = b64('96000001');
    routes.set(pkH, { status: 200, html: awardHtml('H-001') });
    resetCalls();
    const r = await svc.fetchAwardDetails([ATM(pkH), pkH, `https://web.pcc.gov.tw/tps/atm/AtmAwardWithoutSso/QueryAtmAwardDetail?pkAtmMain=${pkH}`, ATM(pkA), pkA], { cacheFile });
    const md = svc.renderAwardDetails(r);
    check(calls.length === 1 && r.fetched === 1 && r.cachedCount === 1 && r.duplicates === 3, 'H：同一案重複 3 次只連線 1 次；快取數以不重複案件計', `calls=${calls.length} cached=${r.cachedCount} duplicates=${r.duplicates}`);
    check(md.includes('本次實抓 1 筆、快取 1 筆、未取得 0 筆') && md.includes('重複輸入 3 筆已合併'), 'H：摘要以不重複案件計並註明重複輸入已合併',
      md.split('\n').filter(l => l.includes('本次實抓') || l.includes('重複')).join(' / '));
    check((md.match(/^#### \d+\. /gm) || []).length === 2 && !r.results[1].cached && r.results[1].duplicateOf === 0, 'H：重複的案子不重複列出、本次才抓到的不算快取');
  }
  {
    // A：連結明示的種類與頁面判別不符、決標頁沒有投標廠商家數 → parse、不寫快取
    resetWindow();
    const [a1, a2, a3] = ['94000001', '94000002', '94000003'].map(b64);
    routes.set(a1, { status: 200, html: awardHtml('K-001') });
    routes.set(a2, { status: 200, html: nonAwardHtml });
    routes.set(a3, { status: 200, html: awardHtml('K-003').replace(td('投標廠商家數', '2'), td('投標廠商家數', '')) });
    resetCalls();
    const r = await svc.fetchAwardDetails([NON_ATM(a1), ATM(a2), ATM(a3)], { cacheFile });
    const c = readCache();
    const [x1, x2, x3] = r.results;
    check(calls.length === 3 && x1.failure === 'parse' && /連結是無法決標公告、頁面像決標公告，未快取/.test(x1.message ?? '') && !c[`nonAward:${a1}`] && !c[`award:${a1}`],
      'A：nonAtm 連結卻拿到決標頁 → parse、訊息寫明、未快取', x1.message ?? (x1.ok ? 'ok' : ''));
    check(x2.failure === 'parse' && /連結是決標公告、頁面像無法決標公告，未快取/.test(x2.message ?? '') && !c[`award:${a2}`],
      'A：atm 連結卻拿到無法決標頁 → parse、未快取', x2.message ?? (x2.ok ? 'ok' : ''));
    check(x3.failure === 'parse' && /投標廠商家數/.test(x3.message ?? '') && !c[`award:${a3}`],
      'A：決標頁解析不到投標廠商家數 → parse、未快取', x3.message ?? (x3.ok ? 'ok' : ''));
    const md = svc.renderAwardDetails(r);
    check(md.includes('連結是無法決標公告、頁面像決標公告') && !md.includes('未快取；未寫入快取'), 'A：Markdown 列出種類不符原因（不重複「未快取」字樣）');
    // 純 pk 沒有明示種類，不做交叉核對
    const a4 = b64('94000004');
    routes.set(a4, { status: 200, html: nonAwardHtml });
    resetCalls();
    const rb = await svc.fetchAwardDetails([a4], { cacheFile });
    check(calls.length === 1 && rb.results[0].ok && rb.results[0].record?.pageType === 'nonAward' && readCache()[`award:${a4}`],
      'A：純 pk（assumedKind）拿到無法決標頁仍視為成功，不做種類交叉核對', rb.results[0].message ?? '');
  }
  {
    // C：不論狀態碼先判別封鎖頁；403／429／5xx 一律當 blocked：中止整批、進冷卻、不寫快取
    let n = 97000001;
    for (const [status, html, label] of [
      [403, '<html><body>Forbidden</body></html>', 'HTTP 403'],
      [429, '<html><body>Too Many Requests</body></html>', 'HTTP 429'],
      [503, '<html><body>Service Unavailable</body></html>', 'HTTP 503（無 WAF 字樣）'],
      [404, captchaHtml, 'HTTP 404＋驗證碼頁'],
    ]) {
      resetCooldown();
      resetWindow();
      const p1 = b64(String(n++));
      const p2 = b64(String(n++));
      routes.set(p1, { status, html });
      routes.set(p2, { status: 200, html: awardHtml(`C-${status}`) });
      resetCalls();
      const r = await svc.fetchAwardDetails([ATM(p1), ATM(p2)], { cacheFile });
      const c = readCache();
      check(calls.length === 1 && r.blocked && r.results.every(x => x.failure === 'blocked') && !c[`award:${p1}`] && !c[`award:${p2}`],
        `C：${label} → blocked、中止整批（只連線 1 次）、不寫快取`, r.results.map(x => x.failure ?? 'ok').join(','));
      resetCalls();
      const again = await svc.fetchAwardDetails([ATM(p2)], { cacheFile });
      check(calls.length === 0 && again.cooldown, `C：${label} 之後進入冷卻、不連線`);
    }
    resetCooldown();
  }
  {
    // F：寫快取前先重讀磁碟合併（另一個 MCP 行程寫的不被覆蓋）；損毀檔先改名備份再寫
    resetWindow();
    const fFile = join(tmpRoot, 'merge', 'award-details.json');
    mkdirSync(dirname(fFile), { recursive: true });
    await svc.fetchAwardDetails(['這不是連結'], { cacheFile: fFile }); // 讓本行程先把（還不存在的）快取載入記憶體
    const pkO = b64('98000001');
    const o = svc.parseAwardDetailHtml(awardHtml('O-001'));
    writeFileSync(fFile, JSON.stringify({ [`award:${pkO}`]: { kind: 'award', pk: pkO, url: ATM(pkO), record: o.record, pairs: o.pairs, savedAt: new Date().toISOString() } }));
    const pkF1 = b64('98000002');
    routes.set(pkF1, { status: 200, html: awardHtml('F-001') });
    resetCalls();
    await svc.fetchAwardDetails([ATM(pkF1)], { cacheFile: fFile });
    const disk = JSON.parse(readFileSync(fFile, 'utf8'));
    check(calls.length === 1 && disk[`award:${pkF1}`] && disk[`award:${pkO}`], 'F：寫入前合併磁碟上另一行程新增的紀錄，不覆蓋', Object.keys(disk).join(', '));
    resetCalls();
    const reuse = await svc.fetchAwardDetails([ATM(pkO)], { cacheFile: fFile });
    check(calls.length === 0 && reuse.results[0].cached, 'F：合併後本行程也能直接用另一行程抓過的快取');

    const cDir = join(tmpRoot, 'corrupt');
    const cFile = join(cDir, 'award-details.json');
    mkdirSync(cDir, { recursive: true });
    const broken = '{"award:broken": {';
    writeFileSync(cFile, broken);
    const pkF2 = b64('98000003');
    routes.set(pkF2, { status: 200, html: awardHtml('F-002') });
    resetWindow();
    resetCalls();
    const rc = await svc.fetchAwardDetails([ATM(pkF2)], { cacheFile: cFile });
    const names = readdirSync(cDir);
    const backups = names.filter(f => f.startsWith('award-details.json.corrupt-'));
    let fresh = null;
    try { fresh = JSON.parse(readFileSync(cFile, 'utf8')); } catch { }
    check(rc.results[0].ok && backups.length === 1 && readFileSync(join(cDir, backups[0]), 'utf8') === broken && fresh?.[`award:${pkF2}`] && !names.some(f => f.endsWith('.tmp')),
      'F：快取檔損毀：先改名備份成 .corrupt-時間戳，再寫新檔（無殘留 .tmp）', names.join(', '));
  }
  // ---------- 4b. 不確定就不快取、跨行程額度、快取格式、訊息與暫存檔（mock axios） ----------
  console.log('\n[4b] 不快取無法確認的解析、跨行程額度、快取格式驗證（mock axios，約 40 秒）');
  const rateFile = join(tmpRoot, 'award-rate.json');
  const readRate = () => { try { return JSON.parse(readFileSync(rateFile, 'utf8')); } catch { return null; } };
  const cacheEntry = (pk, html) => {
    const p = svc.parseAwardDetailHtml(html);
    return { kind: p.type, pk, url: ATM(pk), record: p.record, pairs: p.pairs, savedAt: new Date().toISOString() };
  };
  {
    // L(1)(2)：決標頁 0 家得標廠商、無法決標頁理由空白 → parse、不快取（決標公告必有得標廠商）
    resetWindow();
    const [l1, l2] = ['99000001', '99000002'].map(b64);
    routes.set(l1, { status: 200, html: awardHtml('L-001').replace(td('是否得標', '是'), td('是否得標', '否')) });
    routes.set(l2, { status: 200, html: nonAwardHtml.replace(td('無法決標的理由', '無廠商投標'), td('無法決標的理由', '')) });
    resetCalls();
    const r = await svc.fetchAwardDetails([ATM(l1), NON_ATM(l2)], { cacheFile });
    const c = readCache();
    check(calls.length === 2 && r.results[0].failure === 'parse' && /得標廠商/.test(r.results[0].message ?? '') && !c[`award:${l1}`],
      'L：決標頁解析出 0 家得標廠商 → parse、不快取', r.results[0].message ?? (r.results[0].ok ? 'ok（已快取）' : ''));
    check(r.results[1].failure === 'parse' && /理由/.test(r.results[1].message ?? '') && !c[`nonAward:${l2}`],
      'L：無法決標頁「無法決標的理由」解析為空 → parse、不快取', r.results[1].message ?? (r.results[1].ok ? 'ok（已快取）' : ''));
  }
  {
    // L(3)：頁面同時有「投標廠商家數」與「無法決標的理由」——連結明示種類就依連結解析，純 pk 回 parse（歧義）
    resetWindow();
    const bothHtml = nonAwardHtml.replace('</table>', `${td('投標廠商家數', '2')}${td('投標廠商1', '')}${td('廠商代碼', '12345678')}${td('廠商名稱', '甲公司')}${td('是否得標', '是')}${td('決標金額', '900,000元')}</table>`);
    const [l3, l4, l5] = ['99010001', '99010002', '99010003'].map(b64);
    for (const p of [l3, l4, l5]) routes.set(p, { status: 200, html: bothHtml });
    resetCalls();
    const r = await svc.fetchAwardDetails([l3, NON_ATM(l4), ATM(l5)], { cacheFile });
    const c = readCache();
    check(r.results[0].failure === 'parse' && /純 pk|無法判斷/.test(r.results[0].message ?? '') && !c[`award:${l3}`] && !c[`nonAward:${l3}`],
      'L：兩種欄位並存＋純 pk（種類歧義）→ parse、不快取', r.results[0].message ?? (r.results[0].ok ? 'ok（已快取）' : ''));
    check(r.results[1].ok && r.results[1].record?.pageType === 'nonAward' && Boolean(c[`nonAward:${l4}`]),
      'L：兩種欄位並存＋nonAtm 連結 → 依連結當無法決標公告解析', r.results[1].message ?? r.results[1].record?.pageType);
    check(r.results[2].ok && r.results[2].record?.pageType === 'award' && r.results[2].record?.winners.length === 1 && Boolean(c[`award:${l5}`]),
      'L：兩種欄位並存＋atm 連結 → 依連結當決標公告解析', r.results[2].message ?? r.results[2].record?.pageType);
  }
  {
    // P：快取項格式不符（record 缺、pageType 不對、pairs 不是陣列）要當作沒命中
    const pFile = join(tmpRoot, 'badentry', 'award-details.json');
    mkdirSync(dirname(pFile), { recursive: true });
    const [p1, p2, p3] = ['99300001', '99300002', '99300003'].map(b64);
    const good = cacheEntry(p1, awardHtml('P-OK'));
    writeFileSync(pFile, JSON.stringify({
      [`award:${p1}`]: { ...good, pk: p1, record: null },
      [`award:${p2}`]: { ...good, pk: p2, record: { ...good.record, pageType: 'weird' } },
      [`award:${p3}`]: { ...good, pk: p3, pairs: 'not-an-array' },
    }));
    [p1, p2, p3].forEach((p, i) => routes.set(p, { status: 200, html: awardHtml(`P-00${i + 1}`) }));
    resetWindow();
    resetCalls();
    const r = await svc.fetchAwardDetails([p1, p2, p3], { cacheFile: pFile });
    const md = svc.renderAwardDetails(r);
    const blocks = (md.match(/^#### \d+\. /gm) || []).length;
    check(calls.length === 3 && r.fetched === 3 && r.cachedCount === 0 && r.results.every(x => x.ok && !x.cached) && blocks === 3,
      'P：快取項格式不符當作沒命中（不會 ok+cached 卻在輸出中消失）', `calls=${calls.length} cached=${r.cachedCount} 案件區塊=${blocks}`);
  }
  {
    // N：排隊期間別的行程剛把案子寫進磁碟快取 → 輪到時先重讀磁碟，不連線、不佔額度
    resetWindow();
    const [n1, n2] = ['99200001', '99200002'].map(b64);
    routes.set(n1, { status: 200, html: '<html><body>系統維護中</body></html>' }); // 解析失敗＝不會寫快取、不會順手合併磁碟
    routes.set(n2, { status: 200, html: awardHtml('N-002') });
    hooks.set(n1, () => {
      const cur = readCache();
      cur[`award:${n2}`] = cacheEntry(n2, awardHtml('N-002'));
      writeFileSync(cacheFile, JSON.stringify(cur));
    });
    resetCalls();
    const [na, nb] = await Promise.all([
      svc.fetchAwardDetails([ATM(n1)], { cacheFile }),
      svc.fetchAwardDetails([ATM(n2)], { cacheFile }),
    ]);
    hooks.delete(n1);
    const nmd = svc.renderAwardDetails(nb);
    check(calls.length === 1 && na.results[0].failure === 'parse' && nb.results[0].ok && nb.results[0].cached && nb.fetched === 0 && nmd.includes('本地快取'),
      'N：輪到時重讀磁碟快取，命中就不連線、不佔額度、標示本地快取',
      `calls=${calls.length} ${nb.results[0].ok ? (nb.results[0].cached ? 'cached' : 'fetched') : nb.results[0].failure}`);
  }
  {
    // N：loadCache 遇到非 ENOENT 的暫時性讀取錯誤（EISDIR／EBUSY／EPERM）不可記成空快取
    const eFile = join(tmpRoot, 'unreadable', 'award-details.json');
    mkdirSync(eFile, { recursive: true }); // 用目錄佔住檔名 → readFile 回 EISDIR（不是 ENOENT）
    const pkU = b64('99800001');
    // 第一次用解析失敗的頁面：記憶體不會留下這筆，才驗得出「讀取錯誤有沒有被記成空快取」
    routes.set(pkU, { status: 200, html: '<html><body>系統維護中</body></html>' });
    resetWindow();
    resetCalls();
    const bad = await svc.fetchAwardDetails([ATM(pkU)], { cacheFile: eFile });
    rmSync(eFile, { recursive: true, force: true });
    writeFileSync(eFile, JSON.stringify({ [`award:${pkU}`]: cacheEntry(pkU, awardHtml('E-001')) }));
    resetCalls();
    const again = await svc.fetchAwardDetails([ATM(pkU)], { cacheFile: eFile });
    check(bad.results[0].failure === 'parse' && calls.length === 0 && again.results[0].cached,
      'N：快取讀取錯誤（EISDIR）不記成空快取，檔案恢復後同一路徑仍讀得到', `calls=${calls.length} ${again.results[0].cached ? 'cached' : '又重抓一次'}`);
  }
  {
    // M：滾動額度與冷卻起點寫進 .cache/award-rate.json，Claude Desktop 與 Claude Code 兩個行程共用
    check(typeof svc.AWARD_RATE_FILE === 'string' && svc.AWARD_RATE_FILE === join(ROOT, '.cache', 'award-rate.json'),
      'M：匯出 AWARD_RATE_FILE＝專案根 .cache/award-rate.json（import.meta.url 錨定）', String(svc.AWARD_RATE_FILE));
    const [m1, m2] = ['99400001', '99400002'].map(b64);
    routes.set(m1, { status: 200, html: awardHtml('M-001') });
    routes.set(m2, { status: 200, html: awardHtml('M-002') });

    resetWindow();
    resetCalls();
    await svc.fetchAwardDetails([ATM(m1)], { cacheFile });
    const rate = readRate();
    check(calls.length === 1 && Array.isArray(rate?.stamps) && rate.stamps.length === 1 && !readdirSync(tmpRoot).some(f => f.endsWith('.tmp')),
      'M：發出請求後把時間戳原子寫回 award-rate.json', JSON.stringify(rate));

    resetWindow();
    // 時間戳要各自不同：合併是取聯集，同一毫秒的 5 筆會被當成同一次請求
    writeFileSync(rateFile, JSON.stringify({ stamps: Array.from({ length: 5 }, (_, i) => Date.now() - i * 1000), blockedAt: 0 }));
    resetCalls();
    const r2 = await svc.fetchAwardDetails([ATM(m2)], { cacheFile });
    check(calls.length === 0 && r2.fetched === 0 && r2.results[0].failure === 'limit' && r2.overLimit === 1,
      'M：另一個行程已用掉 5 次額度（檔案）→ 本行程不連線、回 limit', r2.results[0].message ?? (r2.results[0].ok ? 'ok' : ''));

    resetWindow();
    writeFileSync(rateFile, JSON.stringify({ stamps: [], blockedAt: Date.now() }));
    resetCalls();
    const r3 = await svc.fetchAwardDetails([ATM(m2)], { cacheFile });
    check(calls.length === 0 && r3.cooldown && r3.results[0].failure === 'cooldown',
      'M：另一個行程被擋（檔案裡的 blockedAt）→ 本行程也停、不連線', r3.results[0].message ?? (r3.results[0].ok ? 'ok' : ''));
    resetCooldown();

    resetWindow();
    writeFileSync(rateFile, '{ this is not json');
    resetCalls();
    const r4 = await svc.fetchAwardDetails([ATM(m2)], { cacheFile });
    const rateBackups = readdirSync(tmpRoot).filter(f => f.startsWith('award-rate.json.corrupt-'));
    check(calls.length === 1 && r4.results[0].ok && rateBackups.length === 1,
      'M：award-rate.json 損毀 → 改名 .corrupt-時間戳 備份、當空處理、工具不崩潰', readdirSync(tmpRoot).join(', '));
  }
  {
    // O：判定封鎖的當下就設 blockedAt 並寫回檔案，不依賴 await 接續順序
    resetWindow();
    resetCooldown();
    const [o1, o2] = ['99500001', '99500002'].map(b64);
    routes.set(o1, { status: 200, html: captchaHtml });
    routes.set(o2, { status: 200, html: awardHtml('O-002') });
    resetCalls();
    const [oa, ob] = await Promise.all([
      svc.fetchAwardDetails([ATM(o1)], { cacheFile }),
      svc.fetchAwardDetails([ATM(o2)], { cacheFile }),
    ]);
    const rate = readRate();
    check(oa.blocked && typeof rate?.blockedAt === 'number' && rate.blockedAt > 0,
      'O：requestPage 內判定封鎖就把 blockedAt 寫進 award-rate.json', JSON.stringify(rate));
    check(calls.length === 1 && ob.results[0].failure === 'cooldown' && !readCache()[`award:${o2}`],
      'O：同時排隊的另一個呼叫立刻停住、不再連線', `calls=${calls.length} ${ob.results[0].failure ?? 'ok'}`);
    resetCooldown();
  }
  {
    // Q：冷卻訊息用 h23 顯示臺北時間（00:05 不可顯示成 24:05）
    const at0005 = (() => {
      const d = new Date();
      let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 16, 5, 0, 0); // 臺北 UTC+8 → 00:05
      while (t <= Date.now()) t += 86400000;
      return t;
    })();
    check(hhmmTaipei(at0005) === '00:05', 'Q（前置）：取到一個臺北時間 00:05 的時刻', hhmmTaipei(at0005));
    resetWindow();
    resetCooldown();
    svc.setAwardBlockedAt?.(at0005);
    resetCalls();
    const r = await svc.fetchAwardDetails([ATM(b64('99600001'))], { cacheFile });
    check(calls.length === 0 && r.results[0].failure === 'cooldown' && /^00:05 已遇到/.test(r.results[0].message ?? ''),
      'Q：冷卻訊息用 formatTaipei（h23），臺北 00:05 顯示 00:05 而非 24:05', r.results[0].message ?? (r.results[0].ok ? 'ok（沒進冷卻）' : ''));
    resetCooldown();
    const srcQ = readFileSync(join(ROOT, 'src', 'services', 'award-detail-crawler.ts'), 'utf8');
    check(/formatTaipei\(blockedAt/.test(srcQ) && !/hour12/.test(srcQ), 'Q：原始碼不再用 hour12:false 組冷卻時間',
      srcQ.split('\n').filter(l => /hour12|formatTaipei\(blockedAt/.test(l)).join(' / ') || '(都沒有)');
  }
  {
    // R：原子寫入的 rename 失敗（目標唯讀）要 unlink 暫存檔，不能留下 .tmp
    const roDir = join(tmpRoot, 'readonly');
    mkdirSync(roDir, { recursive: true });
    resetWindow();
    const roCache = join(roDir, 'award-details.json');
    const roRate = join(roDir, 'award-rate.json');
    writeFileSync(roCache, '{}');
    writeFileSync(roRate, JSON.stringify({ stamps: [], blockedAt: 0 }));
    chmodSync(roCache, 0o444);
    chmodSync(roRate, 0o444);
    const pkRo = b64('99700001');
    routes.set(pkRo, { status: 200, html: awardHtml('R-001') });
    resetCalls();
    const r = await svc.fetchAwardDetails([ATM(pkRo)], { cacheFile: roCache });
    const leftovers = readdirSync(roDir).filter(f => f.endsWith('.tmp'));
    const roFiles = readdirSync(roDir).join(', ');
    chmodSync(roCache, 0o666);
    chmodSync(roRate, 0o666);
    check(calls.length === 1 && r.results[0].ok && leftovers.length === 0,
      'R：快取／額度檔 rename 失敗要 unlink 暫存檔，工具仍回傳結果', roFiles);
  }

  {
    const svcSrc = readFileSync(join(ROOT, 'src', 'services', 'award-detail-crawler.ts'), 'utf8');
    check(/AWARD_DETAIL_CACHE_FILE = join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', '\.\.', '\.cache', 'award-details\.json'\)/.test(svcSrc), '原始碼：快取路徑以 import.meta.url 錨定');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import(${JSON.stringify(pathToFileURL(join(ROOT, 'build', 'services', 'award-detail-crawler.js')).href)}).then(m => console.log(m.AWARD_DETAIL_CACHE_FILE))`],
      { cwd: existsSync(sys32) ? sys32 : tmpRoot, encoding: 'utf8' }).trim();
    check(out === join(ROOT, '.cache', 'award-details.json'), 'CWD=System32 時快取路徑仍是專案根 .cache/award-details.json', out);
    const tsFiles = [];
    const walk = d => readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') && tsFiles.push(join(d, e.name)));
    walk(join(ROOT, 'src'));
    const offenders = tsFiles.filter(f => readFileSync(f, 'utf8').split('\n').some(l => /process\s*\.\s*cwd\s*\(/.test(l.replace(/\/\/.*$/, ''))));
    check(offenders.length === 0, `src 程式碼（排除註解）沒有 process.cwd()（掃 ${tsFiles.length} 檔）`, offenders.join(', '));
  }

  // ---------- 5. 流量控制：上限、序列、間隔、快取不佔額度 ----------
  console.log('\n[5] 流量控制（mock axios，約 35 秒）');
  {
    check(typeof svc.setAwardDetailClock === 'function' && typeof svc.resetAwardDetailWindow === 'function' && svc.DETAIL_WINDOW_MAX === 5 && svc.DETAIL_WINDOW_MS === 600000,
      'D：匯出 DETAIL_WINDOW_MAX=5、DETAIL_WINDOW_MS=600000 與 test-only 時鐘／重設函式');
    resetWindow();
    const pks = Array.from({ length: 6 }, (_, i) => b64(String(91000001 + i)));
    pks.forEach((p, i) => routes.set(p, { status: 200, html: awardHtml(`L-00${i + 1}`) }));
    resetCalls();
    const inputs = [pkA, ...pks.map(p => `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${p}`)];
    const r = await svc.fetchAwardDetails(inputs, { cacheFile });
    const gaps = calls.slice(1).map((c, i) => c.t - calls[i].t);
    check(calls.length === 5 && r.fetched === 5, '7 筆（1 筆已快取＋6 筆未快取）只連線 5 次', `${calls.length}`);
    check(r.results[0].cached && r.cachedCount === 1 && r.results.slice(1, 6).every(x => x.ok && !x.cached), '快取命中不佔額度：第 1 筆快取、第 2~6 筆本次抓取');
    check(maxInFlight === 1, '序列抓取（同時最多 1 個請求）', `maxInFlight=${maxInFlight}`);
    check(gaps.length === 4 && gaps.every(g => g >= 3000), '請求間隔皆 ≥ 3000ms', gaps.join(', '));
    const last = r.results[6];
    check(!last.ok && last.failure === 'limit' && last.url.includes(encodeURIComponent(pks[5])) && r.overLimit === 1, '第 6 筆未快取列為未取得（limit）並附連結');
    const t0 = calls[0].t;
    const within = m => m && [hhmmTaipei(t0 + 600000), hhmmTaipei(t0 + 660000)].includes(m[1]);
    const lm = /10 分鐘內最多 5 次內頁請求，最早可在 (\d{2}:\d{2}) 再查/.exec(last.message ?? '');
    check(within(lm), 'D／U：超出額度的案子 limit 訊息「10 分鐘內最多 5 次內頁請求，最早可在 HH:mm 再查」（時間＝第 1 次請求＋10 分鐘）', last.message);
    const md = svc.renderAwardDetails(r);
    check(md.includes(U_PHRASE) && md.includes(`](${last.url})`) && md.includes('本次實抓 5 筆、快取 1 筆、未取得 1 筆'), 'U：Markdown 說明改為「任意 10 分鐘內最多 5 次內頁請求（…也會佔額度）」、其餘之後再查，並附連結');

    // D：跨呼叫共用：下一次呼叫（同一 10 分鐘窗內）不連線
    resetCalls();
    const next = await svc.fetchAwardDetails([ATM(pks[5]), pks[5]], { cacheFile });
    const nm = /10 分鐘內最多 5 次內頁請求，最早可在 (\d{2}:\d{2}) 再查/.exec(next.results[0].message ?? '');
    check(calls.length === 0 && next.fetched === 0 && next.results[0].failure === 'limit' && within(nm) && next.overLimit === 1,
      'D：跨呼叫共用額度：緊接著的下一次呼叫不連線、回 limit 並附最早時間', next.results[0].message ?? (next.results[0].ok ? 'ok' : ''));
    const nmd = svc.renderAwardDetails(next);
    check(next.duplicates === 1 && nmd.includes('未取得 1 筆') && nmd.includes('重複輸入 1 筆已合併') && (nmd.match(/^ {2}- 第 \d+ 筆/gm) || []).length === 1,
      'H：未取得的重複輸入也合併，未取得清單只列 1 筆', nmd.split('\n').filter(l => l.includes('未取得') || l.includes('第 ')).join(' / '));

    // 注入時鐘快轉 10 分鐘，不必真的等
    svc.setAwardDetailClock?.(() => Date.now() + 600000 + 5000);
    resetCalls();
    const again = await svc.fetchAwardDetails(inputs, { cacheFile });
    svc.setAwardDetailClock?.(null);
    check(calls.length === 1 && again.fetched === 1 && again.cachedCount === 6 && again.results[6].ok, '時鐘快轉 10 分鐘後再查：前 6 筆走快取，只抓剩下 1 筆', `fetched=${again.fetched} cached=${again.cachedCount}`);

    // E：full=true 只對前 5 筆成功案附全部欄位
    const mdFull = svc.renderAwardDetails(again, { full: true });
    const fullCount = (mdFull.match(/\*\*全部內頁欄位/g) || []).length;
    check(again.results.filter(x => x.ok).length === 7 && fullCount === 5 && mdFull.includes('全部欄位只列前 5 筆'), 'E：full=true 7 筆成功只對前 5 筆附全部欄位，其餘註明', `附全部欄位 ${fullCount} 筆`);

    // D：並行呼叫共用額度（同一條序列通道內再檢查）
    resetWindow();
    const cp = Array.from({ length: 6 }, (_, i) => b64(String(93000001 + i)));
    cp.forEach((p, i) => routes.set(p, { status: 200, html: awardHtml(`P-00${i + 1}`) }));
    resetCalls();
    const [ra, rb] = await Promise.all([
      svc.fetchAwardDetails(cp.slice(0, 3).map(ATM), { cacheFile }),
      svc.fetchAwardDetails(cp.slice(3).map(ATM), { cacheFile }),
    ]);
    const all = [...ra.results, ...rb.results];
    check(calls.length === 5 && maxInFlight === 1 && all.filter(x => x.ok).length === 5 && all.filter(x => x.failure === 'limit').length === 1,
      'D：兩個並行呼叫各 3 筆：合計只連線 5 次、序列、1 筆 limit', `calls=${calls.length} ${all.map(x => x.failure ?? 'ok').join(',')}`);
    check(ra.fetched + rb.fetched === 5 && ra.overLimit + rb.overLimit === 1 && all.filter(x => x.failure === 'limit').every(x => /最早可在 \d{2}:\d{2} 再查/.test(x.message ?? '')),
      'D：被額度擋下的不計入「本次連線內頁」次數、計入 overLimit、附最早時間', `fetched=${ra.fetched}+${rb.fetched} overLimit=${ra.overLimit}+${rb.overLimit}`);
    resetWindow();
  }

  // ---------- 6. 遇到驗證碼立即中止、冷卻期、無重試 ----------
  console.log('\n[6] 驗證碼中止（mock axios）');
  {
    resetCooldown();
    resetWindow();
    const q = Array.from({ length: 4 }, (_, i) => b64(String(92000001 + i)));
    routes.set(q[0], { status: 200, html: awardHtml('Q-001') });
    routes.set(q[1], { status: 200, html: captchaHtml });
    routes.set(q[2], { status: 200, html: awardHtml('Q-003') });
    routes.set(q[3], { status: 200, html: awardHtml('Q-004') });
    resetCalls();
    const r = await svc.fetchAwardDetails(q.map(p => `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${p}`), { cacheFile });
    check(calls.length === 2 && r.fetched === 2 && r.blocked, '第 2 筆遇驗證碼：總共只連線 2 次', `${calls.length}`);
    check(calls.filter(c => c.url.includes(encodeURIComponent(q[1]))).length === 1, '被擋的那筆沒有重試（只打 1 次）');
    check(r.results[0].ok && r.results.slice(1).every(x => !x.ok && x.failure === 'blocked' && x.url), '第 2~4 筆列為未取得（blocked）且附連結');
    const cache = readCache();
    check(cache[`award:${q[0]}`] && !cache[`award:${q[1]}`] && !cache[`award:${q[2]}`], '被擋前抓到的有快取、被擋的與之後的沒有');
    const md = svc.renderAwardDetails(r);
    check(md.includes('不是違規紀錄') && md.includes('不要重複重試') && [q[2], q[3]].every(p => md.includes(encodeURIComponent(p))), 'Markdown 加註流量控制說明並列出剩餘案子的連結');
    resetCalls();
    const cool = await svc.fetchAwardDetails([q[3]], { cacheFile });
    check(calls.length === 0 && cool.cooldown && cool.results[0].failure === 'cooldown', '緊接著再呼叫：冷卻期內不連線');
    check(svc.renderAwardDetails(cool).includes('不要重複重試'), '冷卻期輸出同樣附流量控制說明');
    const hit = await svc.fetchAwardDetails([q[0]], { cacheFile });
    check(hit.results[0].ok && hit.results[0].cached, '冷卻期內快取命中仍可回傳');
    const src = readFileSync(join(ROOT, 'src', 'services', 'award-detail-crawler.ts'), 'utf8');
    check((src.match(/axios\.get\(/g) || []).length === 1 && !/retry|attempt/i.test(src), '原始碼只有 1 處 axios.get、沒有 retry／attempt 字樣');
    resetCooldown();
  }
  axios.get = realGet;

  // ---------- 7. 即時實測（--live） ----------
  if (!LIVE) {
    skip('即時實測決標＋無法決標內頁', '未加 --live');
  } else {
    console.log('\n[7] 即時實測（寫入正式快取；清單端點 1~2 次、內頁 ≤2 次）');
    const awardSvc = await import(pathToFileURL(join(ROOT, 'build', 'services', 'award-service.js')).href);
    const rocDaysAgo = n => {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - n * 86400000)).split('-').map(Number);
      return (p[0] - 1911) * 10000 + p[1] * 100 + p[2];
    };
    let listRequests = 0;
    const gtFile = fxDir ? join(fxDir, 'ground_truth.json') : '';
    const gt = gtFile && existsSync(gtFile) ? JSON.parse(readFileSync(gtFile, 'utf8')).multiBidderCase : null;
    let awardLink;
    if (gt) {
      awardLink = `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${gt.pk}`;
    } else {
      const l = await awardSvc.queryAwards({ from: rocDaysAgo(4), to: rocDaysAgo(3), status: '決標' }, { maxRows: 1 });
      listRequests += l.requests;
      awardLink = l.rows.find(x => x.linkType === 'atm')?.url;
    }
    const nl = await awardSvc.queryAwards({ from: rocDaysAgo(4), to: rocDaysAgo(3), status: '無法決標' }, { maxRows: 1 });
    listRequests += nl.requests;
    const nonAwardLink = nl.rows.find(x => x.linkType === 'nonAtm')?.url;
    check(Boolean(awardLink) && Boolean(nonAwardLink), '取得 1 個決標連結與 1 個無法決標連結', `${awardLink} ｜ ${nonAwardLink}`);

    if (awardLink && nonAwardLink) {
      const dump = process.env.AWARD_LIVE_DUMP;
      if (dump) {
        mkdirSync(dump, { recursive: true });
        axios.interceptors.response.use(res => {
          const m = String(res.config?.url || '').match(/(QueryAtm\w+)\?pkAtmMain=([^&]+)/);
          if (m) writeFileSync(join(dump, `${m[1]}_${decodeURIComponent(m[2]).replace(/[^A-Za-z0-9]/g, '')}.html`), Buffer.from(res.data));
          return res;
        });
      }
      const r = await svc.fetchAwardDetails([awardLink, nonAwardLink]);
      const [a, n] = r.results;
      console.log(`        內頁實際連線 ${r.fetched} 次；決標：${a.ok ? (a.cached ? '快取' : '本次抓取') : a.failure + ' ' + a.message}；無法決標：${n.ok ? (n.cached ? '快取' : '本次抓取') : n.failure + ' ' + n.message}`);
      if (r.blocked || r.cooldown) {
        skip('即時內頁結果', `遇到網站流量控制，未取得：${r.results.filter(x => !x.ok).map(x => x.url).join('、')}`);
      } else {
        check(a.ok && a.record.pageType === 'award' && a.record.winners.length >= 1 && a.record.bidderCount >= 1, '決標頁：判別正確、有得標廠商與投標家數',
          a.ok ? `${a.record.orgName}｜${a.record.caseNo}｜家數 ${a.record.bidderCount}｜得標 ${a.record.winners.map(w => `${w.name}/${w.vendorId}`).join('、')}｜落標 ${a.record.losers.map(w => w.name).join('、')}` : a.message);
        if (gt && a.ok) {
          check(a.record.caseNo === gt.caseNo && a.record.orgName === gt.org && a.record.bidderCount === gt.bidders.length, `決標頁與 ground_truth 同一案、投標家數 ${gt.bidders.length}`);
          const exp = xs => xs.map(b => `${b.name}|${b.id ?? b.vendorId}`).sort().join('、');
          check(exp(a.record.winners) === exp(gt.bidders.filter(b => b.won === '是')), '得標廠商＋統編與 ground_truth 一致', exp(a.record.winners));
          check(exp(a.record.losers) === exp(gt.bidders.filter(b => b.won === '否')), '落標廠商與 ground_truth 一致', exp(a.record.losers));
        }
        check(n.ok && n.record.pageType === 'nonAward' && n.record.reason.length > 0, '無法決標頁：判別正確、有無法決標的理由',
          n.ok ? `${n.record.orgName}｜${n.record.caseNo}｜理由 ${n.record.reason}｜公告日 ${n.record.nonAwardNoticeDate}｜原公告 ${n.record.originalBulletinDate}｜續行 ${n.record.continueSameCase}` : n.message);

        // 新開一個 MCP server（上一個在 [1] 已載入舊快取），同樣兩筆應全走快取、0 次連線
        server = startServer();
        await server.init();
        const t = await server.call({ cases: [awardLink, nonAwardLink] });
        check(t.text.includes('本次實抓 0 筆、快取 2 筆、未取得 0 筆') && t.text.includes('本次連線內頁 0 次') && (t.text.match(/（本地快取，/g) || []).length === 2,
          'MCP 工具重查同兩筆：全走本地快取、0 次連線');
        if (a.ok && n.ok) {
          check(t.text.includes(`${a.record.winners[0].name}（統編 ${a.record.winners[0].vendorId}）`) && t.text.includes(`| 投標家數 | ${a.record.bidderCount}`) && t.text.includes('| 無法決標的理由 |'),
            'MCP 輸出含得標廠商＋統編、投標家數、無法決標的理由');
          console.log(t.text.split('\n').map(l => '        ' + l).join('\n'));
        }
        server.srv.kill();
        server = null;
      }
      console.log(`\n        即時請求合計：清單端點 ${listRequests} 次、內頁 ${r.fetched} 次`);
    }
  }

  // ---------- 8. git diff：既有工具未動、公開 repo 衛生 ----------
  console.log('\n[8] git diff 檢查');
  {
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    // 這段檢查的是「本功能尚未 commit 時的工作區 diff」。commit 之後 index.ts 的 diff 會變成
    // 後續其他變更，再比對就會誤報，所以改抓引入 get_award_detail 的那個 commit 的 diff；
    // 兩者都沒有（例如淺層 clone）就 SKIP，不要假 FAIL。
    const introduced = git('log', '--format=%H', '-1', '-S', '"get_award_detail"', '--', 'src/index.ts').trim();
    const working = git('diff', 'HEAD', '--unified=0', '--', 'src/index.ts');
    // 已 commit 就用那個 commit 的 diff（工作區之後會有別的變更，拿來比會誤報）
    const diff = introduced ? git('show', '--format=', '--unified=0', introduced, '--', 'src/index.ts')
      : working.includes('get_award_detail') ? working
      : '';
    const uncommitted = !introduced;
    if (!diff) {
      skip('src/index.ts diff 檢查', '找不到引入 get_award_detail 的變更');
    } else {
      const removed = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1));
      const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
      // 唯一允許被改的舊行是 instructions 第 6 條結尾（反引號移到新的第 7 條後面）
      const okRemoved = removed.every(l => l.endsWith('`,') && added.includes(l.slice(0, -2)));
      check(removed.length <= 1 && okRemoved, 'src/index.ts 沒有改動既有行（僅 instructions 結尾換行）', removed.join(' / '));
      const addedText = added.join('\n');
      check(/server\.tool\(\s*$/m.test(addedText) && addedText.includes('"get_award_detail"') && (addedText.match(/server\.tool\(/g) || []).length === 1, 'src/index.ts 只新增 1 支工具註冊（get_award_detail）');
    }
    if (uncommitted) {
      const changed = git('status', '--porcelain').split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, ''));
      const allowed = ['src/index.ts', 'src/types/award.ts', 'src/services/award-detail-crawler.ts', '_smoke_mcp.mjs', '_smoke_award_detail.mjs'];
      check(changed.every(f => allowed.includes(f)), '變動檔案只有本功能相關檔', changed.join(', '));
    } else {
      skip('變動檔案只有本功能相關檔', '本功能已 commit，工作區變更屬其他工作');
    }
    const typesDiff = uncommitted
      ? git('diff', 'HEAD', '--unified=0', '--', 'src/types/award.ts')
      : git('show', '--format=', '--unified=0', introduced, '--', 'src/types/award.ts');
    check(!typesDiff.split('\n').some(l => l.startsWith('-') && !l.startsWith('---')), 'src/types/award.ts 只新增、不改既有型別');
    const texts = [git('diff', 'HEAD'), ...['src/services/award-detail-crawler.ts', '_smoke_award_detail.mjs'].map(f => readFileSync(join(ROOT, f), 'utf8'))].join('\n');
    const user = userInfo().username;
    const leaks = [
      [/[A-Za-z]:[\\/]+Users[\\/]/i, '本機使用者路徑'],
      [new RegExp('App' + 'Data', 'i'), '使用者暫存路徑'],
      [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'session UUID'],
      [/[\w.+-]+@(gmail|yahoo|hotmail|outlook)\.com/i, 'email'],
    ].filter(([re]) => re.test(texts)).map(([, label]) => label);
    if (user && user.length >= 3 && new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(texts)) leaks.push('使用者名稱');
    check(leaks.length === 0, 'diff 與新增檔不含本機路徑／使用者名稱／session／email', leaks.join('、'));
  }
} catch (e) {
  console.log(`  FAIL  例外：${e.stack || e.message}`);
  failed++;
} finally {
  axios.get = realGet;
  if (server) server.srv.kill();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
}

const skipNote = skipped > 0 ? `（另有 ${skipped} 項 SKIP，未計入通過）` : '';
console.log(failed === 0 ? `\nALL PASS${skipNote}` : `\n${failed} 項 FAIL${skipNote}`);
process.exit(failed === 0 ? 0 : 1);
