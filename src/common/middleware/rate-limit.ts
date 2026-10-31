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
 * Buckets keyed on the submitted identifier, consumed ONLY on a failed
 * attempt.
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
 * Successful logins consume neither, so a user who types their password
 * correctly is never rate limited by someone else's failures.
 */
export async function consumeFailedAttempt(
  c: Context,
  identifier: string,
  bucket: Bucket,
): Promise<void> {
  const id = identifier.toLowerCase();
  const ip = clientIp(c);
  if (ip) await consume(`idip:${id}|${ip}`, bucket);
  await consume(`id:${id}`, { ...bucket, name: `${bucket.name}-id`, limit: bucket.limit * 5 });
}

/**
 * Read-only: is this bucket already full? Does NOT increment.
 *
 * Needed because the identifier buckets are charged only on failure, so
 * nothing would otherwise consult them before the next password check. Where
 * no client IP is available the per-IP limiter skips entirely, and without
 * this an attacker could guess without limit.
 *
 * The hard pre-check uses the identifier+IP bucket only. Checking the loose
 * identifier-wide bucket here would hand back the targeted lockout that
 * splitting them was meant to remove.
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

/** The identifier+IP bucket key, shared by the pre-check and the charge. */
export function identifierIpSubject(identifier: string, ip: string | null): string | null {
  return ip ? `idip:${identifier.toLowerCase()}|${ip}` : null;
}

/** Throws 429 when this attacker has already burned their attempts on this account. */
export async function assertNotLockedOut(
  c: Context,
  identifier: string,
  bucket: Bucket,
): Promise<void> {
  const subject = identifierIpSubject(identifier, clientIp(c));
  if (!subject) return;
  if (await isExhausted(subject, bucket)) {
    throw new DomainError('GEN_429', 'Too many attempts. Please wait and try again.', 429, {
      retryAfterSeconds: bucket.windowSeconds,
    });
  }
}
