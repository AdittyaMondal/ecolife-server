import type { Executor } from '@common/rewards/rewards.ts';
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
  | { ok: false; reason: 'unknown' | 'expired' | 'reused' | 'raced' };

/**
 * How long after a token is rotated a second presentation of it is treated as
 * a benign race rather than theft.
 *
 * `[LESSON]` Without this, two tabs of the web app logged the user out of every
 * device. The browser holds ONE refresh cookie but each tab is an independent
 * JS context, so a page load in a second tab fires its own refresh; one wins,
 * the other was "reused", and the family burned. Reproduced: one 200, one 401,
 * and zero live sessions left — a hard logout for a user who did nothing.
 *
 * Ten seconds separates the two cases well. A racing browser presents the old
 * token within milliseconds of the winner; an attacker replaying a stolen token
 * is working from a copy taken earlier and is essentially never inside this
 * window. Outside it, the family still burns — that control is intact.
 *
 * This is refresh-token rotation with a reuse interval, the same shape Auth0
 * and IdentityServer use.
 *
 * It applies to `platform === 'web'` ONLY. The race is a property of browsers:
 * one cookie, many tabs, each its own JS context. A mobile client keeps its
 * token in expo-secure-store with a single app instance and no tabs, so a
 * duplicate there has no benign explanation and still burns the family. The
 * window is granted where the bug exists and nowhere else.
 */
const RACE_GRACE_MS = 10_000;

/** Only browsers share one refresh token between concurrent contexts. */
function mayRace(platform: string): boolean {
  return platform === 'web';
}

/**
 * A race the grace window forgave.
 *
 * Logged because this is the one case the window cannot tell apart from an
 * attacker replaying a stolen token within ten seconds of the victim. A
 * trickle is two tabs; a spike on one user is worth a look.
 */
function logRace(where: string, row: { userId: number; familyId: string; platform: string }): void {
  console.warn(
    JSON.stringify({
      event: 'refresh_raced',
      at: where,
      userId: row.userId,
      familyId: row.familyId,
      platform: row.platform,
    }),
  );
}

export async function rotateSession(
  presented: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<RotateResult> {
  const hash = await hashToken(presented);
  const [row] = await db.select().from(sessions).where(eq(sessions.refreshTokenHash, hash));

  if (!row) return { ok: false, reason: 'unknown' };

  /**
   * Reuse is checked BEFORE expiry, deliberately.
   *
   * The other order lets a stolen token that has since expired return
   * 'expired' and slip past family revocation — so an attacker replaying an
   * old token gets a quiet no-op instead of burning the session family and
   * alerting the real user. A revoked token presented again is reuse whether
   * or not it has also aged out.
   */
  if (row.revokedAt) {
    // Inside the grace window, on a platform that can actually race, this is
    // the same browser racing itself rather than a replay. Refuse this ONE
    // call and leave the family alone; the caller retries and picks up the
    // cookie the winner just set.
    if (mayRace(row.platform) && Date.now() - row.revokedAt.getTime() <= RACE_GRACE_MS) {
      logRace('revoked-read', row);
      return { ok: false, reason: 'raced' };
    }
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)))
      .execute();
    return { ok: false, reason: 'reused' };
  }

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
    /**
     * Lost the atomic claim: another request claimed the row between our read
     * and our write. That is microseconds, so it is a race rather than a stale
     * replay — a token spent earlier would have had `revoked_at` set in the
     * SELECT above and been handled there.
     *
     * Still gated on the platform, exactly like the revoked-read branch. A
     * mobile client has no second context to race against, so a lost claim
     * there means two parties holding one token. Forgetting this guard here
     * was a real bug: whichever of the two paths a loser happened to take
     * decided whether the family burned, so the same five concurrent mobile
     * rotations gave different answers depending on timing.
     */
    if (!mayRace(row.platform)) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)))
        .execute();
      return { ok: false, reason: 'reused' };
    }
    logRace('lost-claim', row);
    return { ok: false, reason: 'raced' };
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
export async function revokeAllSessions(userId: number, tx: Executor = db): Promise<void> {
  await tx
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
