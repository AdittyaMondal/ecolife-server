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

/**
 * A local wall time in a zone, as an ISO instant WITH its offset.
 *
 * `2026-11-02T02:00:00` is not a time. A client parses a bare local string in
 * its OWN zone, so a cutoff the server means in Asia/Kolkata lands five and a
 * half hours out for a phone set to UTC — the user is told the edit window is
 * open when it has closed, or the reverse. The designator is the whole point.
 *
 * The offset is read AT the instant rather than assumed, because it is not a
 * property of the zone: Asia/Kolkata is always +05:30, but Europe/London is
 * +00:00 or +01:00 depending on the date.
 */
export function zonedIso(date: string, hour: number, timezone: string): string {
  const wall = `${date}T${String(hour).padStart(2, '0')}:00:00`;
  const asUtc = Date.parse(`${wall}Z`);
  // Two passes. The first guess reads the offset at the wall time interpreted
  // as UTC, which near a DST boundary can sit on the wrong side of the
  // transition; correcting by that offset and re-reading lands on the right
  // one. A third pass cannot change the answer.
  let instant = new Date(asUtc);
  instant = new Date(asUtc - zoneOffsetMinutes(timezone, instant) * 60_000);
  return `${wall}${formatOffset(zoneOffsetMinutes(timezone, instant))}`;
}

/** Minutes east of UTC for `timezone` at `at`. */
function zoneOffsetMinutes(timezone: string, at: Date): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  // 'GMT+05:30', 'GMT-04:00', or a bare 'GMT' at exactly zero.
  const parts = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!parts) return 0;
  return (parts[1] === '-' ? -1 : 1) * (Number(parts[2]) * 60 + Number(parts[3]));
}

function formatOffset(minutes: number): string {
  if (minutes === 0) return 'Z';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
