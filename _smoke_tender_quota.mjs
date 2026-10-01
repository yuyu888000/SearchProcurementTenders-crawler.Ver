// 驗收 get_tender_detail 的跨呼叫額度與冷卻
import { fetchTenderDetails, resetTenderDetailWindow, getTenderDetailQuota,
         TENDER_WINDOW_MAX, TENDER_WINDOW_MS, TENDER_COOLDOWN_MS } from './build/services/detail-crawler.js';
const ok=[],bad=[];
const t=(n,c)=>c?ok.push(n):bad.push(n);

resetTenderDetailWindow();
let q=getTenderDetailQuota();
t('重設後額度歸零', q.used===0 && q.blockedUntil===0);
t(`常數：5 分鐘 20 次、冷卻 20 分`, q.max===20 && q.windowMs===300000 && TENDER_COOLDOWN_MS===1200000);

// 快取命中不該佔額度：同一個 pk 連查兩次，第二次必為 cached 且額度不變
const PK='NzEyMzQ1MDA=';   // 11505280129 臺中市政府水利局（先前已抓過，必在快取）
const r1=await fetchTenderDetails([PK]);
const used1=getTenderDetailQuota().used;
const r2=await fetchTenderDetails([PK]);
const used2=getTenderDetailQuota().used;
t('快取命中', r2.details[0].cached===true && r2.details[0].ok===true);
t('快取命中不佔額度', used2===used1);
t('取得預算金額欄位', r2.details[0].fields['預算金額']?.length>0);

// 額度用完的行為：塞 20 個未快取的假 pk，前面會因網路/解析失敗但仍佔額度，第 21 個起應被額度擋下
// 改用不發請求的方式驗證分支：決標連結會在發請求前被攔截，不佔額度
const award=await fetchTenderDetails(['https://web.pcc.gov.tw/prkms/urlSelector/common/atm?pk=NzEyMjg4MDI=']);
t('決標連結被攔截且不佔額度', award.details[0].reason==='award' && getTenderDetailQuota().used===used2);

console.log('PASS', ok.length); ok.forEach(x=>console.log('  ✓',x));
if(bad.length){console.log('FAIL', bad.length); bad.forEach(x=>console.log('  ✗',x)); process.exit(1);}

// ---- 額度用完 / 冷卻中：核心分支，必須在不發請求的情況下被擋下 ----
const UNCACHED='TESTTESTTESTTEST0001=';   // 不存在於快取，若沒被擋下就會真的發請求
const ok2=[],bad2=[];
const t2=(n,c)=>c?ok2.push(n):bad2.push(n);

resetTenderDetailWindow(TENDER_WINDOW_MAX);              // 額度塞滿
const full=await fetchTenderDetails([UNCACHED]);
t2('額度滿時被擋下', full.fetched===0 && full.details[0].ok===false);
t2('額度訊息正確', /5 分鐘內最多 20 次/.test(full.details[0].message||''));
t2('訊息含最早可再查時間', /最早可在 \d{2}:\d{2} 再查/.test(full.details[0].message||''));

resetTenderDetailWindow(TENDER_WINDOW_MAX-1);            // 差一個額度 -> 應放行（會真的發 1 次請求）
const edge=await fetchTenderDetails([UNCACHED]);
t2('額度未滿時放行（fetched=1）', edge.fetched===1);

resetTenderDetailWindow(0, TENDER_COOLDOWN_MS);          // 冷卻中
const cool=await fetchTenderDetails([UNCACHED]);
t2('冷卻中被擋下', cool.fetched===0 && cool.details[0].reason==='captcha');
t2('冷卻訊息正確', /冷卻至 \d{2}:\d{2}/.test(cool.details[0].message||''));

resetTenderDetailWindow();
console.log('\nPASS', ok2.length); ok2.forEach(x=>console.log('  ✓',x));
if(bad2.length){console.log('FAIL', bad2.length); bad2.forEach(x=>console.log('  ✗',x)); process.exit(1);}
