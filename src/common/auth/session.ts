import { env } from '@config/env.ts';
import { db } from '@database/client.ts';
import { sessions } from '@database/schema/index.ts';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { hashToken, mintRefreshToken, newFamilyId } from './tokens.ts';

/**
 * Refresh-token sessions with rotation and reuse detection (PRD-v2 §6.1).
 *
 * Every refresh mints a new token and revokes the old one. If a token that has
 * already been rotated comes back, the only explanations are a stolen token or
 * a cloned device — so the entire family is revoked and both the attacker and
 * the real user are logged out. Logging the legitimate user out is the correct
 * outcome: it is the only signal they get that something was wrong.
 */

export type Platform = 'web' | 'ios' | 'android';

const ttlMs = () => env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export async function startSession(
  userId: number,
  platform: Platform,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ refreshToken: string; familyId: string }> {
  const refreshToken = mintRefreshToken();
  const familyId = newFamilyId();
  await db.insert(sessions).values({
    userId,
    refreshTokenHash: await hashToken(refreshToken),
    familyId,
    platform,
    expiresAt: new Date(Date.now() + ttlMs()),
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return { refreshToken, familyId };
}

export type RotateResult =
  | { ok: true; userId: number; refreshToken: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'reused' };

export async function rotateSession(
  presented: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<RotateResult> {
  const hash = await hashToken(presented);
  const [row] = await db.select().from(sessions).where(eq(sessions.refreshTokenHash, hash));

  if (!row) return { ok: false, reason: 'unknown' };

  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };

  /**
   * Claim the token with a CONDITIONAL update, not a read-then-write.
   *
   * The previous version read `revokedAt`, checked it in JS, then revoked. Two
   * concurrent requests carrying the same token both read null, both passed
   * the check, and both rotated — producing two live tokens and silently
   * defeating reuse detection. That race IS the attack: a stolen token used at
   * the same moment as the victim's would go unnoticed, which is precisely
   * what reuse detection exists to catch.
   *
   * `WHERE revoked_at IS NULL` makes the claim atomic. Exactly one caller gets
   * a row back; anyone else is, by definition, presenting an already-rotated
   * token.
   */
  const claimed = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, row.id), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  if (claimed.length === 0) {
    // Lost the race, or the token was already spent. Either way it has been
    // presented twice. Burn the family.
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)))
      .execute();
    return { ok: false, reason: 'reused' };
  }

  const next = mintRefreshToken();
  await db.insert(sessions).values({
    userId: row.userId,
    refreshTokenHash: await hashToken(next),
    familyId: row.familyId,
    platform: row.platform,
    expiresAt: new Date(Date.now() + ttlMs()),
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });

  return { ok: true, userId: row.userId, refreshToken: next };
}

/** Sign out one device. */
export async function revokeSession(presented: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.refreshTokenHash, await hashToken(presented)))
    .execute();
}

/** Sign out everywhere. Used on password reset and on a role change. */
export async function revokeAllSessions(userId: number): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .execute();
}

/** Housekeeping for the nightly job. */
export async function pruneSessions(): Promise<number> {
  const gone = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, new Date()), isNull(sessions.id)))
    .returning({ id: sessions.id });
  return gone.length;
}
