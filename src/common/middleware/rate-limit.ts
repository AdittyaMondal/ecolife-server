import { DomainError } from '@common/errors/domain-error.ts';
import { env } from '@config/env.ts';
import { db } from '@database/client.ts';
import { rateLimits } from '@database/schema/index.ts';
import { and, eq, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Fixed-window rate limiting, shared across replicas via Postgres (PRD-v2 §12).
 *
 * The subject is `user:<id>` where we know who is calling and `ip:<addr>`
 * where we do not. The IP comes from the socket, never from a header: see
 * CLAUDE.md §4.1.1 — `x-forwarded-for` is attacker-controlled, and an
 * attacker who can choose their own bucket key is not rate limited at all.
 */
export type Bucket = { name: string; limit: number; windowSeconds: number };

export const BUCKETS = {
  /** Brute force is the threat; the window is long on purpose. */
  authStrict: { name: 'auth-strict', limit: 10, windowSeconds: 900 },
  write: { name: 'write', limit: 60, windowSeconds: 3600 },
  search: { name: 'search', limit: 30, windowSeconds: 60 },
  default: { name: 'default', limit: 300, windowSeconds: 60 },
} as const satisfies Record<string, Bucket>;

/**
 * The client's IP, or null when it genuinely cannot be established.
 *
 * Returning a shared `'unknown'` string, as the first version did, is worse
 * than returning nothing: every anonymous caller lands in ONE bucket, so a
 * single attacker can exhaust it and lock out every other unauthenticated
 * user. A DoS lever dressed as a rate limit.
 *
 * `x-forwarded-for` is attacker-controlled unless we operate the proxy that
 * wrote it, so it is read ONLY when TRUSTED_PROXY_HOPS says how many entries
 * we actually appended — and then from the RIGHT, because the leftmost
 * entries are whatever the client sent (CLAUDE.md §4.1.1).
 */
export function clientIp(c: Context): string | null {
  const hops = env.TRUSTED_PROXY_HOPS;
  if (hops > 0) {
    const chain = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const candidate = chain.length >= hops ? chain[chain.length - hops] : undefined;
    if (candidate && isIpLike(candidate)) return candidate;
  }

  const info = c.env as { requestIP?: (r: Request) => { address?: string } | null } | undefined;
  return info?.requestIP?.(c.req.raw)?.address ?? null;
}

/** Cheap shape check, so a forged header cannot inject an arbitrary bucket key. */
function isIpLike(value: string): boolean {
  return /^[0-9a-fA-F:.]{3,45}$/.test(value);
}

let warnedNoIp = false;

function windowStart(seconds: number): Date {
  const ms = seconds * 1000;
  return new Date(Math.floor(Date.now() / ms) * ms);
}

/**
 * Counts a hit and throws once the bucket is full.
 *
 * The upsert is atomic, so two concurrent requests cannot both read 9 and
 * both write 10.
 */
export async function consume(subject: string, bucket: Bucket): Promise<void> {
  const start = windowStart(bucket.windowSeconds);
  const [row] = await db
    .insert(rateLimits)
    .values({ subject, bucket: bucket.name, windowStart: start, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.subject, rateLimits.bucket, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });

  const count = row?.count ?? 1;
  if (count > bucket.limit) {
    const retryAfter = Math.ceil(
      (start.getTime() + bucket.windowSeconds * 1000 - Date.now()) / 1000,
    );
    throw new DomainError('GEN_429', 'Too many requests. Please wait and try again.', 429, {
      retryAfterSeconds: Math.max(retryAfter, 1),
    });
  }
}

/**
 * Per-IP limiter for routes with no authenticated user yet.
 *
 * With no determinable IP this does NOT fall back to a shared bucket — it
 * skips, loudly and once. On the auth routes the per-identifier bucket still
 * applies, so accounts stay protected; a shared bucket would protect nothing
 * and hand an attacker a lockout primitive.
 */
export function rateLimitByIp(bucket: Bucket): MiddlewareHandler {
  return async (c, next) => {
    await consumeForIp(c, bucket);
    await next();
  };
}

/** Consumes the per-IP bucket when an IP is known; otherwise warns once. */
export async function consumeForIp(c: Context, bucket: Bucket): Promise<void> {
  const ip = clientIp(c);
  if (!ip) {
    if (!warnedNoIp) {
      warnedNoIp = true;
      console.warn(
        'rate-limit: no client IP available — per-IP limiting is INACTIVE. ' +
          'Set TRUSTED_PROXY_HOPS if this server runs behind a proxy.',
      );
    }
    return;
  }
  await consume(`ip:${ip}`, bucket);
}

/**
 * Buckets keyed on the submitted identifier, for one auth channel (`scope`).
 *
 * The first version counted every attempt against `id:<email>` alone, which
 * handed anyone who knew your address a targeted lockout: ten bad guesses
 * from any machine and the real user is blocked for fifteen minutes. Two
 * changes fix that without giving up the protection:
 *
 *   identifier+IP   tight. One attacker fills their own bucket and nobody
 *                   else's, so the victim signing in from elsewhere is fine.
 *   identifier      loose (5x). A genuinely distributed attack on one account
 *                   still gets stopped; the cost of locking that account is
 *                   accepted, because at that point it IS under attack.
 *
 * `scope` keeps the channels apart. Registration attempts sharing login's
 * bucket would be the same cross-channel lockout in a new coat: fill the
 * register bucket for an address and its owner cannot sign in.
 */
function looseBucket(bucket: Bucket): Bucket {
  return { ...bucket, name: `${bucket.name}-id`, limit: bucket.limit * 5 };
}

/** The tight `scope:<id>|<ip>` key, or null when the IP is unknown. */
export function identifierIpSubject(
  scope: string,
  identifier: string,
  ip: string | null,
): string | null {
  return ip ? `${scope}:${identifier.toLowerCase()}|${ip}` : null;
}

/** The loose `scope-id:<id>` key, which needs no IP. */
export function identifierSubject(scope: string, identifier: string): string {
  return `${scope}-id:${identifier.toLowerCase()}`;
}

/** Charges both buckets for one attempt on `scope`. */
export async function consumeIdentifier(
  c: Context,
  scope: string,
  identifier: string,
  bucket: Bucket,
): Promise<void> {
  const tight = identifierIpSubject(scope, identifier, clientIp(c));
  if (tight) await consume(tight, bucket);
  await consume(identifierSubject(scope, identifier), looseBucket(bucket));
}

/** Login, charged ONLY on a failed attempt — a correct password costs nothing. */
export function consumeFailedAttempt(
  c: Context,
  identifier: string,
  bucket: Bucket,
): Promise<void> {
  return consumeIdentifier(c, 'login', identifier, bucket);
}

/**
 * Read-only: is this bucket already full? Does NOT increment.
 *
 * Needed because the identifier buckets are charged only on failure, so
 * nothing would otherwise consult them before the next password check.
 */
export async function isExhausted(subject: string, bucket: Bucket): Promise<boolean> {
  const start = windowStart(bucket.windowSeconds);
  const [row] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(
      and(
        eq(rateLimits.subject, subject),
        eq(rateLimits.bucket, bucket.name),
        eq(rateLimits.windowStart, start),
      ),
    );
  return (row?.count ?? 0) >= bucket.limit;
}

/**
 * Throws 429 once the caller has burned their attempts on this identifier.
 *
 * Prefers the identifier+IP bucket: one attacker is stopped and the real user
 * signing in from their own machine is not.
 *
 * With no determinable IP it falls back to the LOOSE identifier-wide bucket,
 * and that fallback is the whole point. The per-IP limiter also skips without
 * an IP, and the identifier buckets are charged only on failure — so before
 * this fallback existed, a host we could not identify could guess passwords
 * without any limit at all. The fallback does reintroduce a targeted lockout
 * on such a host, which is why it is the 5x bucket and not the tight one, and
 * why TRUSTED_PROXY_HOPS should be set on any deployment behind a proxy.
 */
export async function assertIdentifierNotLockedOut(
  c: Context,
  scope: string,
  identifier: string,
  bucket: Bucket,
): Promise<void> {
  const tight = identifierIpSubject(scope, identifier, clientIp(c));
  const [subject, applicable] = tight
    ? ([tight, bucket] as const)
    : ([identifierSubject(scope, identifier), looseBucket(bucket)] as const);

  if (await isExhausted(subject, applicable)) {
    throw new DomainError('GEN_429', 'Too many attempts. Please wait and try again.', 429, {
      retryAfterSeconds: applicable.windowSeconds,
    });
  }
}

/** Login's pre-check, run before the password is ever verified. */
export function assertNotLockedOut(c: Context, identifier: string, bucket: Bucket): Promise<void> {
  return assertIdentifierNotLockedOut(c, 'login', identifier, bucket);
}
