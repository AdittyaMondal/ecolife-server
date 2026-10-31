/**
 * Every "today" in this product is the USER'S local date, never the server's
 * (PRD-v2 §3.4). `users.timezone` exists for exactly this.
 *
 * A server in UTC would roll a user in Asia/Kolkata over to tomorrow at
 * 05:30 their time, silently breaking a streak they were about to extend.
 *
 * Built on `Intl`, not on offset arithmetic: an offset is wrong twice a year
 * wherever daylight saving applies, and the IANA database already knows.
 */

/** `YYYY-MM-DD` in the given zone. `en-CA` is the locale that formats that way. */
export function localDate(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Hour of day, 0–23, in the given zone. */
export function localHour(timezone: string, at: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  }).format(at);
  return Number(hour);
}

/**
 * Calendar arithmetic on a `YYYY-MM-DD` string.
 *
 * Anchored at midday UTC so that adding a day cannot be undone by a DST
 * shift of an hour either way — the result is read back as a date, never as
 * an instant.
 */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`, positive when `b` is later. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** True when the zone is one `Intl` recognises — a bad one throws at format time. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
