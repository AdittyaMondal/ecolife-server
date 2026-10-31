import { readAccessToken } from '@common/auth/tokens.ts';
import { DomainError } from '@common/errors/domain-error.ts';
import { db } from '@database/client.ts';
import { eventHosts, organizationMembers, organizations } from '@database/schema/index.ts';
import { and, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';

/**
 * Guards (PRD-v2 §6.1, §6.9, §6.6.4).
 *
 * Three questions, deliberately separate:
 *   requireUser       are you signed in?            → 401
 *   requireAdmin      are you staff?                → 403   users.role
 *   requireOrgRole    what are you in YOUR org?     → 403   organization_members
 *   requireEventHost  may you scan THIS event?      → 403   event_hosts
 *
 * The last two are membership, not identity, which is why neither is a value
 * on `users.role`. Hosting one event or belonging to one company grants
 * nothing anywhere else.
 */

export type AuthUser = {
  id: number;
  role: 'user' | 'admin';
  orgId?: number;
  orgRole?: 'owner' | 'member';
};

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

/** 401 on anything other than a valid, unexpired access token. */
export const requireUser: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new DomainError('AUTH_002', 'Not authenticated.', 401);

  const claims = await readAccessToken(token);
  if (!claims) throw new DomainError('AUTH_002', 'Session expired. Please sign in again.', 401);

  c.set('user', {
    id: Number(claims.sub),
    role: claims.role,
    orgId: claims.org,
    orgRole: claims.orgRole,
  });
  await next();
};

/** Staff only. Must run after requireUser. */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const user = c.get('user');
  if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);
  if (user.role !== 'admin') throw new DomainError('AUTH_006', 'Not authorised.', 403);
  await next();
};

/**
 * Belongs to an APPROVED organization, optionally as owner.
 *
 * The approval check is the point: anyone can sign up claiming to be a
 * corporate partner, and a pending organization's portal stays read-only
 * until a human approves it. Read live rather than from the token, so a
 * suspension takes effect immediately instead of when the access token
 * happens to expire.
 */
export function requireOrgRole(
  opts: { type?: 'industry' | 'ngo' | 'seller'; owner?: boolean } = {},
): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);

    const [row] = await db
      .select({
        orgId: organizations.id,
        type: organizations.type,
        status: organizations.status,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, user.id));

    if (!row) throw new DomainError('ORG_001', 'You do not belong to an organization.', 403);
    if (row.status !== 'approved')
      throw new DomainError('ORG_002', `Your organization is ${row.status}.`, 403, {
        status: row.status,
      });
    if (opts.type && row.type !== opts.type)
      throw new DomainError('ORG_003', 'Wrong organization type for this action.', 403);
    if (opts.owner && row.role !== 'owner')
      throw new DomainError('ORG_004', 'Only an organization owner can do that.', 403);

    await next();
  };
}

/** Host or co-host of the event in the path. */
export const requireEventHost: MiddlewareHandler = async (c, next) => {
  const user = c.get('user');
  if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);
  const eventId = Number(c.req.param('id'));
  if (!Number.isInteger(eventId)) throw new DomainError('GEN_400', 'Invalid event id.', 400);

  const [row] = await db
    .select({ role: eventHosts.role })
    .from(eventHosts)
    .where(and(eq(eventHosts.eventId, eventId), eq(eventHosts.userId, user.id)));

  if (!row) throw new DomainError('EVENT_001', 'Only a host can do that.', 403);
  await next();
};
