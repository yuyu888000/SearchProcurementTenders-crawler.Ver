/**
 * 解析民國日期字串 (例如: 112/01/01 10:00) 為 JavaScript Date 物件
 */
export function parseROCDate(dateStr: string): Date | null {
  if (!dateStr || dateStr === "-" || dateStr.trim() === "") return null;
  
  // 匹配 112/01/01 或 112/01/01 10:00
  const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)(?:\s+(\d+):(\d+))?/);
  if (!match) return null;
  
  const year = parseInt(match[1]) + 1911;
  const month = parseInt(match[2]) - 1;
  const day = parseInt(match[3]);
  const hour = match[4] ? parseInt(match[4]) : 0;
  const minute = match[5] ? parseInt(match[5]) : 0;
  
  return new Date(year, month, day, hour, minute);
}

/**
 * 計算剩餘天數
 */
export function getRemainingDays(deadline: Date): string {
  const now = new Date();
  const diff = deadline.getTime() - now.getTime();
  
  if (diff < 0) return "已截止";
  
  const totalHours = diff / (1000 * 60 * 60);
  const days = Math.floor(totalHours / 24);
  
  if (days === 0 && totalHours > 0) return "今日截止";
  
  return `${days} 天`;
}

/**
 * 把使用者輸入的日期正規化成民國 yyyMMdd 整數（例：1150701），無法解析回 null。
 * 接受民國與西元、斜線與連字號、有無分隔皆可：
 *   115/07/01、115-7-1、1150701、2026/07/01、2026-07-01、20260701
 */
export function toROCNumber(input?: string): number | null {
  if (!input) return null;
  const s = input.trim();
  if (!s) return null;

  let y: number, m: number, d: number;
  const sep = s.match(/^(\d{3,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (sep) {
    [y, m, d] = [parseInt(sep[1], 10), parseInt(sep[2], 10), parseInt(sep[3], 10)];
  } else {
    const plain = s.match(/^(\d{3,4})(\d{2})(\d{2})$/);
    if (!plain) return null;
    [y, m, d] = [parseInt(plain[1], 10), parseInt(plain[2], 10), parseInt(plain[3], 10)];
  }

  if (y >= 1911) y -= 1911; // 西元轉民國
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return y * 10000 + m * 100 + d;
}

/**
 * 把爬回來的民國日期字串（115/08/03、115/08/03 17:00）轉成 yyyMMdd 整數供比較
 */
export function rocStringToNumber(dateStr: string): number | null {
  const m = dateStr?.match(/(\d{3,4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10);
}

/**
 * 民國 yyyMMdd 整數轉回顯示字串（1150701 → 115/07/01）
 */
export function formatROCNumber(n: number): string {
  const y = Math.floor(n / 10000);
  const m = Math.floor((n % 10000) / 100);
  const d = n % 100;
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

/**
 * 計算標案公告期間
 */
export function calculateTenderPeriod(startDate: Date, endDate: Date): string {
  const diff = endDate.getTime() - startDate.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  return `${days} 天`;
}

/**
 * 民國 yyyMMdd 整數轉成標的分類查詢要的「西元」字串（1150701 → 2026/07/01）。
 *
 * ⚠️ 標的分類查詢頁畫面上填的是民國（115/07/01），但它的前端驗證是
 *    `if (y1 < 2010) 擋掉`，也就是送出時已被換成西元。直接送民國年會被判為
 *    「99 年以前」，伺服器不報錯、直接回一張空的查詢表單頁（很容易誤判成 0 筆）。
 */
export function rocNumberToADSlash(n: number): string {
  const y = Math.floor(n / 10000) + 1911;
  const m = Math.floor((n % 10000) / 100);
  const d = n % 100;
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

/** 兩個民國 yyyMMdd 整數相差幾天（官網未登入時上限 186 天） */
export function daysBetweenROC(from: number, to: number): number {
  const toDate = (n: number) =>
    new Date(Math.floor(n / 10000) + 1911, Math.floor((n % 10000) / 100) - 1, n % 100);
  return Math.round(Math.abs(toDate(to).getTime() - toDate(from).getTime()) / 86400000);
}
