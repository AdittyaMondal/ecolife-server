import { env } from '@config/env.ts';
import { sign, verify } from 'hono/jwt';

/**
 * Access and refresh tokens (PRD-v2 §6.1).
 *
 * Access: a short JWT, verified without touching the database so every
 * authenticated request stays one round trip.
 * Refresh: opaque random bytes, STORED HASHED, rotated on every use. A JWT
 * would be the wrong choice here — it cannot be revoked, and a refresh token
 * has to be.
 */

/** `hono/jwt` in v4 requires the algorithm explicitly; omitting it throws. */
const ALG = 'HS256' as const;

export type AccessClaims = {
  sub: string;
  role: 'user' | 'admin';
  /** Organization id and role, when the user belongs to one. */
  org?: number;
  orgRole?: 'owner' | 'member';
  exp: number;
  iat: number;
};

function secret(): string {
  if (!env.JWT_SECRET) {
    // Refusing beats signing with a default: a predictable secret is the same
    // as no authentication at all.
    throw new Error('JWT_SECRET is not set; refusing to issue tokens.');
  }
  return env.JWT_SECRET;
}

export async function issueAccessToken(
  claims: Omit<AccessClaims, 'exp' | 'iat'>,
): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = env.ACCESS_TOKEN_TTL_SECONDS;
  const token = await sign({ ...claims, iat: now, exp: now + expiresIn }, secret(), ALG);
  return { token, expiresIn };
}

/** Returns null for anything invalid — expired, tampered, wrong secret. */
export async function readAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    return (await verify(token, secret(), ALG)) as AccessClaims;
  } catch {
    return null;
  }
}

/**
 * A refresh token is 32 random bytes. Only its SHA-256 lands in the database,
 * so a leaked dump cannot be replayed as a live session.
 */
export function mintRefreshToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Buffer.from(digest).toString('hex');
}

/** Groups a rotation chain, so reuse of an old token can revoke the whole family. */
export function newFamilyId(): string {
  return crypto.randomUUID();
}
