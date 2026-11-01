import { describe, expect, test } from 'bun:test';
import { zonedIso } from './time.ts';

/**
 * The offset designator is the point of `zonedIso`, so the cases that matter
 * are the ones where the offset is not what a naive reading would give: a
 * half-hour zone, a quarter-hour zone, and the same zone on both sides of a
 * daylight-saving transition.
 */
describe('zonedIso', () => {
  test.each([
    ['Asia/Kolkata', '2026-11-02', '2026-11-02T02:00:00+05:30'],
    ['UTC', '2026-11-02', '2026-11-02T02:00:00Z'],
    ['Europe/London', '2026-07-02', '2026-07-02T02:00:00+01:00'],
    ['Europe/London', '2026-01-02', '2026-01-02T02:00:00Z'],
    ['America/New_York', '2026-07-02', '2026-07-02T02:00:00-04:00'],
    ['America/New_York', '2026-01-02', '2026-01-02T02:00:00-05:00'],
    ['Pacific/Chatham', '2026-11-02', '2026-11-02T02:00:00+13:45'],
  ])('%s %s', (timezone, date, expected) => {
    expect(zonedIso(date, 2, timezone)).toBe(expected);
  });

  test('the result parses back to the same instant the zone means', () => {
    // 02:00 in Kolkata is 20:30 UTC the previous day. A bare local string
    // would parse as 02:00 UTC and be 5h30m wrong — this is the regression.
    expect(Date.parse(zonedIso('2026-11-02', 2, 'Asia/Kolkata'))).toBe(
      Date.parse('2026-11-01T20:30:00Z'),
    );
  });
});
