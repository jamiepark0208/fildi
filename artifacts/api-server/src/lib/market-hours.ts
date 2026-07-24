// Weekday + 9:30-16:00 ET gate, plus full-day NYSE holidays computed
// algorithmically (not a hand-maintained date list — Good Friday and the
// "nth weekday of month" holidays shift every year; computing them avoids
// an annual maintenance chore). Does not account for early-close half days
// (e.g. day after Thanksgiving) — those still gate correctly at the open,
// which is all this feature needs.

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const lastWeekday = last.getUTCDay();
  const offset = (lastWeekday - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - offset));
}

// Meeus/Jones/Butcher Gregorian Easter algorithm.
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Saturday -> observed Friday, Sunday -> observed Monday. */
function observed(d: Date): Date {
  const day = d.getUTCDay();
  if (day === 6) return addDays(d, -1);
  if (day === 0) return addDays(d, 1);
  return d;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function nyseHolidays(year: number): Set<string> {
  const dates = [
    observed(new Date(Date.UTC(year, 0, 1))),        // New Year's Day
    nthWeekdayOfMonth(year, 0, 1, 3),                // MLK Day — 3rd Monday Jan
    nthWeekdayOfMonth(year, 1, 1, 3),                // Presidents Day — 3rd Monday Feb
    addDays(easterSunday(year), -2),                 // Good Friday
    lastWeekdayOfMonth(year, 4, 1),                   // Memorial Day — last Monday May
    observed(new Date(Date.UTC(year, 5, 19))),        // Juneteenth
    observed(new Date(Date.UTC(year, 6, 4))),         // Independence Day
    nthWeekdayOfMonth(year, 8, 1, 1),                 // Labor Day — 1st Monday Sep
    nthWeekdayOfMonth(year, 10, 4, 4),                // Thanksgiving — 4th Thursday Nov
    observed(new Date(Date.UTC(year, 11, 25))),       // Christmas
  ];
  return new Set(dates.map(toDateKey));
}

function isNyseHoliday(now: Date): boolean {
  const dateKey = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const year = Number(dateKey.slice(0, 4));
  return nyseHolidays(year).has(dateKey);
}

function etParts(now: Date): { weekday: number; minutesOfDay: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekdayStr = parts.find(p => p.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find(p => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find(p => p.type === "minute")?.value ?? "0");
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { weekday: WEEKDAYS.indexOf(weekdayStr), minutesOfDay: hour * 60 + minute };
}

const MARKET_OPEN_MIN = 9 * 60 + 30;   // 9:30 ET
const MARKET_CLOSE_MIN = 16 * 60;      // 16:00 ET

export function isMarketOpen(now: Date = new Date()): boolean {
  const { weekday, minutesOfDay } = etParts(now);
  if (weekday < 1 || weekday > 5) return false;
  if (isNyseHoliday(now)) return false;
  return minutesOfDay >= MARKET_OPEN_MIN && minutesOfDay < MARKET_CLOSE_MIN;
}

/** Minutes since 9:30 ET today, or null outside the weekday session window (incl. NYSE holidays). */
export function minutesSinceOpen(now: Date = new Date()): number | null {
  const { weekday, minutesOfDay } = etParts(now);
  if (weekday < 1 || weekday > 5) return null;
  if (isNyseHoliday(now)) return null;
  if (minutesOfDay < MARKET_OPEN_MIN || minutesOfDay >= MARKET_CLOSE_MIN) return null;
  return minutesOfDay - MARKET_OPEN_MIN;
}

/** Today's ET calendar date as YYYY-MM-DD — same convention as candle-aggregator's etDateKey(). */
export function etDateKey(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** UTC instant of 9:30 ET on `now`'s calendar date, or null on a non-trading day. */
export function getMarketOpenUtc(now: Date = new Date()): Date | null {
  const { weekday } = etParts(now);
  if (weekday < 1 || weekday > 5) return null;
  if (isNyseHoliday(now)) return null;
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const offsetMs = now.getTime() - etNow.getTime();
  const openEt = new Date(etNow);
  openEt.setHours(9, 30, 0, 0);
  return new Date(openEt.getTime() + offsetMs);
}
