import { DomainError } from '@common/errors/domain-error.ts';
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

/** The socket address. Deliberately ignores every proxy header. */
export function clientIp(c: Context): string {
  const info = c.env as { requestIP?: (r: Request) => { address?: string } | null } | undefined;
  return info?.requestIP?.(c.req.raw)?.address ?? 'unknown';
}

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

/** Per-IP limiter, for routes with no authenticated user yet. */
export function rateLimitByIp(bucket: Bucket): MiddlewareHandler {
  return async (c, next) => {
    await consume(`ip:${clientIp(c)}`, bucket);
    await next();
  };
}

/**
 * A second bucket keyed on the submitted identifier.
 *
 * Per-IP alone does not stop a distributed attempt on one account, and
 * per-identifier alone does not stop one host spraying many accounts. Login
 * needs both.
 */
export async function consumeForIdentifier(identifier: string, bucket: Bucket): Promise<void> {
  await consume(`id:${identifier.toLowerCase()}`, bucket);
}
