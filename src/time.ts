import tzLookup from '@photostructure/tz-lookup';

// 時區：日期與時間一律以「拍攝地點的當地時間」表示。
// 時區 ID 以離線資料表查詢（不需網路；夏令時間交給瀏覽器的 Intl 處理），失敗時以經度估算。

export function lookupTimeZone(lat: number, lon: number): string {
  try {
    const tz = tzLookup(lat, lon);
    if (isValidZone(tz)) return tz;
  } catch {
    // 改用估算
  }
  return guessTimeZone(lon);
}

/** 以經度估算的整點時區（Etc/GMT 的正負號與一般相反） */
export function guessTimeZone(lon: number): string {
  const h = Math.round(lon / 15);
  if (h === 0) return 'Etc/GMT';
  return `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`;
}

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function parts(tz: string, d: Date) {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(d)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

/** 該時區在某瞬間相對 UTC 的偏移（分鐘） */
export function tzOffsetMinutes(tz: string, d: Date): number {
  const p = parts(tz, d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** 當地日期＋當日分鐘數 → UTC 瞬間 */
export function zonedToInstant(date: string, minutes: number, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let off = tzOffsetMinutes(tz, new Date(guess));
  // 夏令時間切換附近再修正一次
  off = tzOffsetMinutes(tz, new Date(guess - off * 60000));
  return new Date(guess - off * 60000);
}

/** UTC 瞬間 → 當地日期與分鐘數 */
export function instantToZoned(instant: Date, tz: string): { date: string; minutes: number } {
  const p = parts(tz, instant);
  return {
    date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
    minutes: p.hour * 60 + p.minute,
  };
}

/** 瞬間 → 相對於 date 當地午夜的分鐘數（可能 <0 或 ≥1440） */
export function minutesOnDate(instant: Date, date: string, tz: string): number {
  return Math.round((instant.getTime() - zonedToInstant(date, 0, tz).getTime()) / 60000);
}

export function nowInZone(tz: string): { date: string; minutes: number } {
  return instantToZoned(new Date(), tz);
}

export function offsetLabel(tz: string, instant: Date): string {
  const off = tzOffsetMinutes(tz, instant);
  const sign = off >= 0 ? '+' : '−';
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

export function formatMinutes(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
