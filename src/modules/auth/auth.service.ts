import { verifyGoogleAccessToken } from '@common/auth/google.ts';
import { equaliseTiming, hashPassword, verifyPassword } from '@common/auth/password.ts';
import {
  type Platform,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  startSession,
} from '@common/auth/session.ts';
import { hashToken, issueAccessToken, mintRefreshToken } from '@common/auth/tokens.ts';
import { DomainError } from '@common/errors/domain-error.ts';
import { award, REWARDS } from '@common/rewards/rewards.ts';
import { env } from '@config/env.ts';
import { db } from '@database/client.ts';
import { users } from '@database/schema/index.ts';
import * as orgRepo from '@modules/organizations/organizations.repository.ts';
import * as profileRepo from '@modules/profile/profile.repository.ts';
import * as repo from './auth.repository.ts';

/**
 * Auth business rules (PRD-v2 §6.1). Framework-free: no Hono types in here, so
 * every branch below is directly unit-testable.
 */

type Meta = { ip?: string; userAgent?: string; platform: Platform };

async function sessionPayload(userId: number, meta: Meta) {
  const user = await repo.findUserById(userId);
  if (!user) throw new DomainError('AUTH_001', 'Account not found.', 401);
  const membership = await repo.findMembership(userId);

  const { token, expiresIn } = await issueAccessToken({
    sub: String(user.id),
    role: user.role,
    org: membership?.orgId,
    orgRole: membership?.role,
  });
  const { refreshToken } = await startSession(user.id, meta.platform, meta);

  return { user, membership, accessToken: token, expiresIn, refreshToken };
}

export function publicUser(
  user: Awaited<ReturnType<typeof repo.findUserById>>,
  membership: Awaited<ReturnType<typeof repo.findMembership>>,
  /**
   * Required, with no default.
   *
   * It used to default to `{ completedSteps: 0 }`, and login and register
   * both took that default — so every sign-in reported zero completed steps
   * however far through onboarding the user actually was. The web client
   * routes a partially-onboarded user to `/step/{completedSteps + 1}`, so
   * resuming on another device sent them back to question one, which is the
   * one thing the server-persisted wizard exists to prevent. A default that
   * is silently wrong is worse than an argument the compiler demands.
   */
  state: { completedSteps: number; unreadNotifications: number },
) {
  if (!user) throw new DomainError('AUTH_001', 'Account not found.', 401);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatarUrl: user.avatarUrl,
    city: user.city,
    timezone: user.timezone,
    emailVerified: user.emailVerifiedAt !== null,
    onboardingComplete: user.onboardedAt !== null,
    completedSteps: state.completedSteps,
    unreadNotifications: state.unreadNotifications,
    wallet: { pointsTotal: user.pointsTotal, coinsBalance: user.coinsBalance },
    /**
     * Null for an ordinary user. The client routes to Corporate / Community /
     * Seller Portal off `organization.type`, and must treat anything other
     * than status 'approved' as read-only.
     */
    organization: membership
      ? {
          id: membership.orgId,
          slug: membership.slug,
          code: membership.code,
          name: membership.name,
          type: membership.type,
          status: membership.status,
          role: membership.role,
        }
      : null,
  };
}

export async function register(
  input: {
    name: string;
    email: string;
    password: string;
    phone?: string;
    timezone: string;
    organizationCode?: string;
  },
  meta: Meta,
) {
  if (await repo.findUserByEmail(input.email)) {
    // The address is already discoverable through this endpoint whatever we
    // do, so a clear error beats a confusing one. Login stays ambiguous.
    throw new DomainError('AUTH_005', 'That email is already registered.', 409);
  }

  let orgToJoin: Awaited<ReturnType<typeof orgRepo.findByCode>> = null;
  if (input.organizationCode) {
    const cleanCode = input.organizationCode.trim();
    if (cleanCode.length !== 6 || !/^\d{6}$/.test(cleanCode)) {
      throw new DomainError('ORG_007', 'Organization code must be exactly 6 digits.', 400);
    }
    orgToJoin = await orgRepo.findByCode(cleanCode);
    if (!orgToJoin) {
      throw new DomainError('ORG_007', 'No organization found with that code.', 404);
    }
    if (orgToJoin.status !== 'approved') {
      throw new DomainError(
        'ORG_002',
        `This organization is ${orgToJoin.status}. Only approved organizations can accept members.`,
        403,
        { status: orgToJoin.status },
      );
    }
  }

  const passwordHash = await hashPassword(input.password);

  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        name: input.name,
        email: input.email.toLowerCase(),
        passwordHash,
        phone: input.phone,
        timezone: input.timezone,
        emailVerifiedAt: autoVerifyEnabled() ? new Date() : undefined,
      })
      .returning();

    if (!user) throw new DomainError('INTERNAL_001', 'Could not create the account.', 500);

    if (orgToJoin) {
      await orgRepo.insertMember(tx, {
        organizationId: orgToJoin.id,
        userId: user.id,
        role: 'member',
      });
    }

    return user;
  });

  const verification = await issueEmailToken(created.id, 'verify');
  const payload = await sessionPayload(created.id, meta);
  return { ...payload, verificationToken: verification };
}

export async function login(email: string, password: string, meta: Meta) {
  const user = await repo.findUserByEmail(email);

  if (!user) {
    // Burn comparable time so "unknown email" and "wrong password" are not
    // distinguishable by latency, which would be a free enumeration oracle.
    await equaliseTiming();
    throw new DomainError('AUTH_001', 'Invalid email or password.', 401);
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new DomainError('AUTH_001', 'Invalid email or password.', 401);
  }

  return sessionPayload(user.id, meta);
}

/**
 * Sign in with Google (PRD-v2 §6.1).
 *
 * The token is verified with Google BEFORE any email is trusted — see
 * `@common/auth/google.ts` for why the audience check is the thing that makes
 * this safe rather than an account-takeover endpoint.
 *
 * Matching is by lowercased email against a non-deleted user, which is what
 * `findUserByEmail` already does. There is no `google_id` column and this does
 * not add one: the verified email is the join key, and Google having verified
 * it is exactly the assertion the local verify-email flow produces.
 */
export async function googleSignIn(accessToken: string, timezone: string, meta: Meta) {
  const identity = await verifyGoogleAccessToken(accessToken);

  const existing = await repo.findUserByEmail(identity.email);
  if (existing) {
    /**
     * Google has verified this address, so an account that signed up locally
     * and never clicked the link is verified now. Rewards are gated on
     * `emailVerifiedAt` (§4.4), so without this a Google sign-in would leave
     * the user unable to earn with no way to understand why.
     */
    if (!existing.emailVerifiedAt) await repo.markEmailVerified(existing.id);
    return sessionPayload(existing.id, meta);
  }

  /**
   * `password_hash` is NOT NULL and this user has no password.
   *
   * A random argon2id hash of a value nobody holds: the column is satisfied,
   * and `verifyPassword` can never succeed against it, so /auth/login stays
   * closed for this account until they set one through the existing reset
   * flow. Storing a constant, an empty string, or a predictable placeholder
   * would make one guessable password open every Google-created account.
   */
  const unusablePassword = await hashPassword(crypto.randomUUID() + crypto.randomUUID());

  /**
   * Two first-time sign-ins for the same address can race.
   *
   * A double-tapped Google button is two requests that both miss the lookup
   * above and both insert. `users_email_lower_unq` makes the loser fail rather
   * than creating a duplicate account — which is the constraint doing its job
   * — but a 500 for double-tapping is not an acceptable answer. The loser
   * re-reads and signs in to the row the winner created.
   */
  try {
    const created = await repo.createUser({
      name: displayName(identity.name, identity.email),
      email: identity.email,
      passwordHash: unusablePassword,
      timezone,
      // Google verified it; re-verifying through our own email flow would ask
      // the user to prove something already proven.
      emailVerifiedAt: new Date(),
      avatarUrl: identity.avatarUrl,
    });
    return sessionPayload(created.id, meta);
  } catch (error) {
    // Constraint names live on `error.cause`, never in the message (CLAUDE.md §6).
    const constraint = (error as { cause?: { constraint?: string } }).cause?.constraint;
    if (constraint !== 'users_email_lower_unq') throw error;

    const winner = await repo.findUserByEmail(identity.email);
    if (!winner) throw error;
    return sessionPayload(winner.id, meta);
  }
}

/** Google's name, trimmed to the column's intent, else the local-part of the email. */
function displayName(fromGoogle: string | null, email: string): string {
  const name = fromGoogle?.trim().slice(0, 80);
  if (name) return name;
  // `a@b.com` -> `a`. Always non-empty: the address was parsed by Google.
  return email.split('@')[0]?.slice(0, 80) || 'EcoLife user';
}

export async function refresh(presented: string, meta: Meta) {
  const result = await rotateSession(presented, meta);
  if (!result.ok) {
    /**
     * `raced` is NOT a sign-out. Another context refreshed the same cookie
     * moments ago — two browser tabs, or one under React StrictMode — and the
     * session is perfectly alive. 409 rather than 401 so a client cannot
     * mistake it for "your session ended": the caller should retry, by which
     * point the winner's cookie is in place.
     */
    if (result.reason === 'raced') {
      throw new DomainError('AUTH_009', 'Another request refreshed this session. Try again.', 409, {
        reason: result.reason,
      });
    }
    const message =
      result.reason === 'reused'
        ? 'That session was already used elsewhere. Everyone has been signed out.'
        : 'Session expired. Please sign in again.';
    throw new DomainError('AUTH_003', message, 401, { reason: result.reason });
  }

  const user = await repo.findUserById(result.userId);
  if (!user) throw new DomainError('AUTH_001', 'Account not found.', 401);
  const membership = await repo.findMembership(user.id);

  const { token, expiresIn } = await issueAccessToken({
    sub: String(user.id),
    role: user.role,
    org: membership?.orgId,
    orgRole: membership?.role,
  });
  return { accessToken: token, expiresIn, refreshToken: result.refreshToken };
}

export async function logout(presented: string | null) {
  if (presented) await revokeSession(presented);
}

/** Onboarding progress and the unread badge, for any response carrying a user. */
export function profileState(userId: number) {
  return repo.findProfileState(userId);
}

export async function me(userId: number) {
  const user = await repo.findUserById(userId);
  if (!user) throw new DomainError('AUTH_001', 'Account not found.', 401);
  const [membership, state] = await Promise.all([
    repo.findMembership(userId),
    repo.findProfileState(userId),
  ]);
  return publicUser(user, membership, state);
}

/**
 * Whether new accounts skip verification entirely.
 *
 * Fail CLOSED, on BOTH conditions: neither a stray env var nor a mis-set
 * NODE_ENV alone can turn self-verification on. `register` used to test
 * `NODE_ENV === 'development'` by itself, which is the same fail-open shape
 * that was removed from `resendVerification` — and this project really did
 * run a deployed server with NODE_ENV=development, where it would have
 * verified every account that signed up.
 */
function autoVerifyEnabled(): boolean {
  return env.NODE_ENV !== 'production' && env.DEV_AUTO_VERIFY;
}

/** Mints a single-use token, stores only its hash, returns the plaintext once. */
async function issueEmailToken(userId: number, purpose: 'verify' | 'reset') {
  const token = mintRefreshToken();
  const hours = purpose === 'verify' ? 48 : 1;
  await repo.storeEmailToken({
    tokenHash: await hashToken(token),
    userId,
    purpose,
    expiresAt: new Date(Date.now() + hours * 3600_000),
  });
  return token;
}

export async function verifyEmail(token: string) {
  const row = await repo.consumeEmailToken(await hashToken(token), 'verify');
  if (!row) throw new DomainError('AUTH_007', 'That link is invalid or has expired.', 422);
  await repo.markEmailVerified(row.userId);
  await grantWithheldOnboardingReward(row.userId);
}

/**
 * Pays the onboarding reward that verification was holding back.
 *
 * Someone who answers the fifteen questions before clicking the link gets
 * their baseline immediately but not the 100 points, so without this they
 * would have to somehow re-trigger completion to collect — a step nobody
 * would guess at. Keyed `onboarding:{userId}`, so this is a no-op for a
 * user who was already verified when they finished, and for a user who
 * verifies twice.
 *
 * Failure here must not fail the verification itself: the account IS
 * verified by this point, and the same key means the grant can be made
 * again later without double-paying.
 */
async function grantWithheldOnboardingReward(userId: number) {
  try {
    const profile = await profileRepo.findProfile(userId);
    if (!profile || profile.baselineTotalKg === null) return;
    await award(db, {
      userId,
      pointsDelta: REWARDS.onboarding.points,
      coinsDelta: REWARDS.onboarding.coins,
      source: 'onboarding',
      sourceId: `onboarding:${userId}`,
      note: 'Completed onboarding',
    });
  } catch (error) {
    console.error(`[auth] could not grant onboarding reward to user ${userId}`, error);
  }
}

export async function resendVerification(userId: number) {
  const user = await repo.findUserById(userId);
  if (!user) throw new DomainError('AUTH_001', 'Account not found.', 401);
  if (user.emailVerifiedAt) throw new DomainError('AUTH_008', 'Already verified.', 409);
  if (autoVerifyEnabled()) {
    await repo.markEmailVerified(user.id);
    await grantWithheldOnboardingReward(user.id);
    // Nothing to deliver: the account is already verified.
    return null;
  }
  return issueEmailToken(user.id, 'verify');
}

/**
 * Always succeeds from the caller's point of view.
 *
 * Returning 404 for an unknown address would turn this endpoint into an
 * account-existence oracle that needs no password at all.
 */
export async function forgotPassword(email: string) {
  const user = await repo.findUserByEmail(email);
  return user ? issueEmailToken(user.id, 'reset') : null;
}

export async function resetPassword(token: string, password: string) {
  const row = await repo.consumeEmailToken(await hashToken(token), 'reset');
  if (!row) throw new DomainError('AUTH_007', 'That link is invalid or has expired.', 422);
  await repo.setPassword(row.userId, await hashPassword(password));
  // Whoever had the old password is signed out everywhere — the whole point
  // of a reset when the account may already be compromised.
  await revokeAllSessions(row.userId);
}

/**
 * The two links a verification or reset mail has to contain.
 *
 * `web` is what a desktop recipient clicks; `mobile` is the deep link the app
 * registers so the same mail works on a phone. Both carry the token as a
 * query parameter named `token`, which is what
 * `ecolife-web/src/app/(auth)/verify-email` and `/reset` already read.
 */
export function emailLinks(purpose: 'verify' | 'reset', token: string) {
  const path = purpose === 'verify' ? 'verify-email' : 'reset';
  const origin = env.APP_ORIGIN[0] ?? '';
  const query = `token=${encodeURIComponent(token)}`;
  return {
    web: origin ? `${origin.replace(/\/+$/, '')}/${path}?${query}` : null,
    mobile: `${env.MOBILE_SCHEME}://${path}?${query}`,
  };
}

/**
 * NO MAIL IS SENT. There is no SMTP client in this repo and `SMTP_URL` is
 * declared but unread, so outside production this logs the links and in
 * production it does nothing at all.
 *
 * That is a real hole, not a stylistic one: PRD-v2 §4.4 gates every reward on
 * a verified address, so a production account that never receives the mail
 * can never earn — the leaderboard and the coin discount are dead for it.
 * Until a provider is chosen, a non-production deployment should set
 * DEV_AUTO_VERIFY=true so clients can be developed against a live server.
 */
export function deliverEmailToken(purpose: 'verify' | 'reset', email: string, token: string) {
  if (env.NODE_ENV === 'production') return;
  const links = emailLinks(purpose, token);
  console.log(
    `[email:${purpose}] ${email}\n  web    ${links.web ?? '(APP_ORIGIN unset)'}\n  mobile ${links.mobile}`,
  );
}
