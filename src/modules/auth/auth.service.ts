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
import { env } from '@config/env.ts';
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
  state: { completedSteps: number; unreadNotifications: number } = {
    completedSteps: 0,
    unreadNotifications: 0,
  },
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
          name: membership.name,
          type: membership.type,
          status: membership.status,
          role: membership.role,
        }
      : null,
  };
}

export async function register(
  input: { name: string; email: string; password: string; phone?: string; timezone: string },
  meta: Meta,
) {
  if (await repo.findUserByEmail(input.email)) {
    // The address is already discoverable through this endpoint whatever we
    // do, so a clear error beats a confusing one. Login stays ambiguous.
    throw new DomainError('AUTH_005', 'That email is already registered.', 409);
  }

  const created = await repo.createUser({
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    phone: input.phone,
    timezone: input.timezone,
  });
  if (!created) throw new DomainError('INTERNAL_001', 'Could not create the account.', 500);

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

export async function refresh(presented: string, meta: Meta) {
  const result = await rotateSession(presented, meta);
  if (!result.ok) {
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

export async function me(userId: number) {
  const user = await repo.findUserById(userId);
  if (!user) throw new DomainError('AUTH_001', 'Account not found.', 401);
  const [membership, state] = await Promise.all([
    repo.findMembership(userId),
    repo.findProfileState(userId),
  ]);
  return publicUser(user, membership, state);
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
}

export async function resendVerification(userId: number) {
  const user = await repo.findUserById(userId);
  if (!user) throw new DomainError('AUTH_001', 'Account not found.', 401);
  if (user.emailVerifiedAt) throw new DomainError('AUTH_008', 'Already verified.', 409);
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

/** Dev-only: no SMTP is wired, so the link is logged instead of sent. */
export function deliverEmailToken(purpose: string, email: string, token: string) {
  if (env.NODE_ENV === 'production') return;
  console.log(`[email:${purpose}] ${email} -> token=${token}`);
}
