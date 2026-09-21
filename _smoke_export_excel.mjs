// export_awards_excel 驗收：寫出的 xlsx 用 exceljs 讀回來逐項核對，全程不連網。
import ExcelJS from 'exceljs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

const xl = await import('./build/services/award-excel.js');
const svc = await import('./build/services/resolve-service.js');
const tmp = mkdtempSync(join(tmpdir(), 'excel-smoke-'));

const row = (o) => ({ pk: o.pk, linkType: 'atm', url: `https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=${o.pk}`, orgName: o.org, caseNo: o.caseNo,
  isCorrection: !!o.corr, tenderName: o.name, tenderWay: '公開招標', category: '勞務類', awardNoticeDate: o.date, amount: o.amount,
  awardSeq: '001', nonAwardSeq: '', isNonAward: false, execLocation: o.loc ?? '' });

const ROWS = [
  row({ pk: 'UEsx', org: '臺中市政府水利局', caseNo: '0012345', name: '甲案', date: '115/07/13', amount: 1_200_000, loc: 'EXECUTE_LOCATION_16' }),
  row({ pk: 'UEsy', org: '臺中市政府建設局', caseNo: 'B-2', name: '乙案', date: '115/07/10', amount: 30_000_000, loc: 'EXECUTE_LOCATION_16', corr: true }),
  row({ pk: 'UEsz', org: '南投縣政府', caseNo: 'C-3', name: '丙案', date: '115/07/09', amount: null, loc: 'EXECUTE_LOCATION_20000007' }),
  row({ pk: 'UEs0', org: '國防部', caseNo: 'D-4', name: '丁案', date: '115/07/08', amount: 60_000_000, loc: '' }),
];

const readBook = async p => { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(p); return wb; };
const sheetRows = ws => { const out = []; ws.eachRow((r, i) => { if (i > 1) out.push(r); }); return out; };
const colIndex = (ws, header) => ws.getRow(1).values.indexOf(header);

console.log('\n[1] 清單查詢結果（沒有廠商欄）');
{
  const res = await xl.writeAwardsWorkbook(xl.rowsToExportCases(ROWS), { title: '測試', conditions: [['決標公告日', '115/07/01 ~ 115/07/31']], hasVendor: false }, { outputDir: tmp, fileName: '測試報表' });
  check(existsSync(res.path) && res.path.endsWith('測試報表.xlsx'), '檔案寫在指定資料夾、用指定檔名', res.path);
  const wb = await readBook(res.path);
  const names = wb.worksheets.map(w => w.name);
  check(JSON.stringify(names) === JSON.stringify(['說明', '明細', '縣市統計', '機關排行', '金額級距']), '工作表齊全且沒有廠商排行', names.join(','));

  const d = wb.getWorksheet('明細');
  const dr = sheetRows(d);
  check(dr.length === 4, '明細 4 列', String(dr.length));
  const amtCol = colIndex(d, '決標金額'), noCol = colIndex(d, '案號'), urlCol = colIndex(d, '連結'), ctyCol = colIndex(d, '縣市');
  const first = dr.find(r => r.getCell(noCol).value === '0012345');
  check(Boolean(first), '案號保留前導零（存成文字）');
  check(typeof first?.getCell(amtCol).value === 'number' && first.getCell(amtCol).numFmt === '#,##0', '決標金額是數值且有千分位格式', `${typeof first?.getCell(amtCol).value} ${first?.getCell(amtCol).numFmt}`);
  check(String(first?.getCell(urlCol).value?.hyperlink ?? '').includes('pk=UEsx'), '連結欄是可點的超連結');
  const cty = Object.fromEntries(dr.map(r => [r.getCell(noCol).value, r.getCell(ctyCol).value]));
  check(cty['C-3'] === '南投縣' && cty['D-4'] === '（未能判斷）', '「其他」桶用機關名推縣市、中央機關標未能判斷', `C-3=${cty['C-3']} D-4=${cty['D-4']}`);
  check(colIndex(d, '得標廠商') === -1, '沒有廠商資料時不出現得標廠商欄');

  const c = wb.getWorksheet('縣市統計');
  const tc = sheetRows(c).find(r => r.getCell(1).value === '臺中市');
  check(tc?.getCell(2).value === 2 && tc?.getCell(3).value === 31_200_000, '縣市統計：臺中市 2 件 31,200,000', `${tc?.getCell(2).value} / ${tc?.getCell(3).value}`);

  const bands = Object.fromEntries(sheetRows(wb.getWorksheet('金額級距')).map(r => [r.getCell(1).value, r.getCell(2).value]));
  check(bands['未公開／空白'] === 1 && bands['未達 150 萬'] === 1 && bands['1,000 萬～未達 5,000 萬'] === 1 && bands['5,000 萬以上'] === 1,
    '金額級距分對', JSON.stringify(bands));
  check(res.totalAmount === 91_200_000, '回傳的金額合計正確（空白不計）', String(res.totalAmount));

  const before = statSync(res.path);
  const res2 = await xl.writeAwardsWorkbook(xl.rowsToExportCases(ROWS), { title: '測試', conditions: [], hasVendor: false }, { outputDir: tmp, fileName: '測試報表.xlsx' });
  const after = statSync(res.path);
  check(res2.path !== res.path && existsSync(res2.path), '同名檔已存在時另取新檔名', res2.path);
  check(after.mtimeMs === before.mtimeMs && after.size === before.size, '原本的檔案沒有被覆蓋');

  let err1 = '', err2 = '';
  try { await xl.writeAwardsWorkbook([], { title: '', conditions: [], hasVendor: false }, { outputDir: join(tmp, '不存在的資料夾') }); } catch (e) { err1 = e.message; }
  try { await xl.writeAwardsWorkbook([], { title: '', conditions: [], hasVendor: false }, { outputDir: 'relative\\dir' }); } catch (e) { err2 = e.message; }
  check(err1.includes('不存在') && !existsSync(join(tmp, '不存在的資料夾')), '輸出資料夾不存在時報錯、不自動建立', err1);
  check(err2.includes('絕對路徑'), '相對路徑被拒絕', err2);
}

console.log('\n[2] 補廠商工作結果（有廠商欄、複數決標）');
{
  const job = {
    id: 'job_test', label: '測試工作', range: { from: 1150701, to: 1150731, category: '勞務' }, state: 'done', message: '完成',
    cases: [
      { pk: 'P1', url: 'https://x/?pk=P1', caseNo: 'A-1', orgName: '臺中市政府水利局', tenderName: '一', amount: 10_000_000, awardNoticeDate: '115/07/10', status: 'resolved', winner: '青龍工程顧問有限公司 / 白虎工程顧問有限公司', winnerId: '11111111 / 22222222', source: '反查' },
      { pk: 'P2', url: 'https://x/?pk=P2', caseNo: 'A-2', orgName: '彰化縣政府', tenderName: '二', amount: 4_000_000, awardNoticeDate: '115/07/09', status: 'resolved', winner: '青龍工程顧問有限公司', winnerId: '', source: '名錄反查' },
      { pk: 'P3', url: 'https://x/?pk=P3', caseNo: 'A-3', orgName: '雲林縣政府', tenderName: '三', amount: 2_000_000, awardNoticeDate: '115/07/08', status: 'unknown' },
    ],
  };
  const res = await xl.writeAwardsWorkbook(xl.jobToExportCases(job), { title: '測試', conditions: [], hasVendor: true }, { outputDir: tmp, fileName: '工作' });
  const wb = await readBook(res.path);
  check(wb.worksheets.map(w => w.name).includes('廠商排行'), '有廠商資料時出現廠商排行');
  const vr = Object.fromEntries(sheetRows(wb.getWorksheet('廠商排行')).map(r => [r.getCell(2).value, { id: r.getCell(3).value, count: r.getCell(4).value, multi: r.getCell(5).value, amount: r.getCell(6).value }]));
  check(vr['青龍工程顧問有限公司']?.count === 2 && vr['青龍工程顧問有限公司']?.multi === 1 && vr['青龍工程顧問有限公司']?.amount === 14_000_000,
    '複數決標拆開計：青龍 2 件（其中 1 件複數決標）14,000,000', JSON.stringify(vr['青龍工程顧問有限公司']));
  check(vr['白虎工程顧問有限公司']?.count === 1 && vr['白虎工程顧問有限公司']?.id === '22222222', '白虎 1 件、統編依順序配對', JSON.stringify(vr['白虎工程顧問有限公司']));
  check(vr['青龍工程顧問有限公司']?.id === '11111111', '青龍統編從名稱統編數量一致的那件取得', String(vr['青龍工程顧問有限公司']?.id));
  const d = wb.getWorksheet('明細');
  const srcCol = colIndex(d, '資料來源'), noCol = colIndex(d, '案號'), cntCol = colIndex(d, '得標家數');
  const byNo = Object.fromEntries(sheetRows(d).map(r => [r.getCell(noCol).value, r]));
  check(byNo['A-3']?.getCell(srcCol).value === '未解出', '未解出的案子標「未解出」', String(byNo['A-3']?.getCell(srcCol).value));
  check(byNo['A-1']?.getCell(cntCol).value === 2, '得標家數欄 = 2', String(byNo['A-1']?.getCell(cntCol).value));
  check(res.vendorCoverage?.resolved === 2 && res.vendorCoverage?.total === 3, '廠商涵蓋 2/3', JSON.stringify(res.vendorCoverage));
  const infoText = sheetRows(wb.getWorksheet('說明')).map(r => `${r.getCell(1).value}:${r.getCell(2).value}`).join('\n');
  check(infoText.includes('得標廠商涵蓋:2 / 3 件') && infoText.includes('複數決標'), '說明頁寫出涵蓋率與複數決標計法');
}

console.log('\n[3] 走 MCP 呼叫工具');
{
  const job = await svc.createJob({ label: '測試-匯出', range: { from: 1150701, to: 1150731, category: '勞務' }, rows: ROWS.slice(0, 2), seedVendors: [] });
  const srv = spawn(process.execPath, ['build/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = []; let buf = '';
  srv.stdout.on('data', d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) try { replies.push(JSON.parse(l)); } catch { } } });
  const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (id, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = replies.find(x => x.id === id); if (r) return r; await new Promise(r => setTimeout(r, 100)); } return null; };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } } });
  await waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const list = await waitFor(2);
  const tools = list?.result?.tools ?? [];
  check(tools.some(t => t.name === 'export_awards_excel'), 'export_awards_excel 已註冊', tools.map(t => t.name).join(', '));

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'export_awards_excel', arguments: {} } });
  const empty = (await waitFor(3))?.result?.content?.[0]?.text ?? '';
  check(empty.includes('需要 jobId') , '沒給條件時說明要 jobId 或 from', empty.slice(0, 40));

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'export_awards_excel', arguments: { jobId: job.id, outputDir: tmp, fileName: 'mcp匯出' } } });
  const text = (await waitFor(4))?.result?.content?.[0]?.text ?? '';
  srv.kill();
  check(text.includes('已匯出 Excel') && existsSync(join(tmp, 'mcp匯出.xlsx')), '用 jobId 匯出成功、檔案存在', text.split('\n')[2] ?? text.slice(0, 80));
  check(text.includes('工作尚未完成'), '工作未完成時有提醒');
  rmSync(join('.cache', 'resolve-jobs', `${job.id}.json`), { force: true });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} 項 FAIL`}（通過 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
