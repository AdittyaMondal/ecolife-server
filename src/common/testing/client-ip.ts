import { env } from '@config/env.ts';

/**
 * Gives each test request its own client IP, so the suite is not rate limited
 * against itself.
 *
 * The problem this solves: every request in `bun test` arrives from loopback,
 * so all of them share one `ip:127.0.0.1` bucket. `/auth/register` allows 10
 * per 15 minutes per IP and a full run registers around twenty accounts, so
 * the run exceeds a production limit purely by being a test suite. It only
 * ever passed because `auth.test.ts` happens to `delete from rate_limits`
 * partway through — which made the result depend on file execution order, and
 * is exactly the kind of flake that gets rerun until green rather than read.
 *
 * Rather than weaken the limiter for tests, this asserts a distinct IP per
 * caller through the same `INTERNAL_PROXY_TOKEN` mechanism ecolife-web uses
 * in production (CLAUDE.md §4.1.1). The limiter stays fully armed, every
 * test gets its own bucket, and the assertion path itself gets exercised on
 * every run instead of only in one unit test.
 *
 * Without INTERNAL_PROXY_TOKEN set this returns nothing and the old shared
 * bucket applies — so a contributor who has not set it sees the flake rather
 * than a silent change in what is being tested.
 */

/** TEST-NET-3 (203.0.113.0/24) — reserved for documentation, never routable. */
function documentationIp(): string {
  return `203.0.113.${1 + Math.floor(Math.random() * 254)}`;
}

/**
 * Headers asserting a fresh client IP. Spread into a test request's headers.
 *
 * Call it per request, or once per test when several requests should share a
 * bucket — a rate-limit test needs the SAME ip across its attempts.
 */
export function freshIpHeaders(ip: string = documentationIp()): Record<string, string> {
  if (!env.INTERNAL_PROXY_TOKEN) return {};
  return { 'x-ecolife-internal': env.INTERNAL_PROXY_TOKEN, 'x-ecolife-client-ip': ip };
}
