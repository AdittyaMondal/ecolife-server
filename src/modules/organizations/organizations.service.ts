import { DomainError } from '@common/errors/domain-error.ts';
import { decodeIdCursor, type Page, toPage } from '@common/pagination.ts';
import { db } from '@database/client.ts';
import * as repo from './organizations.repository.ts';

/**
 * Partner organizations (PRD-v2 §6.9 role model).
 *
 * `[LESSON]` An organization starts `pending` and is useless until an admin
 * approves it. Anyone can claim to be a corporate partner at signup; nobody
 * gets a portal that can list products or host official drives until a human
 * says so. Neither `type` nor `status` is editable by the owner — a seller
 * could otherwise re-badge itself as an NGO after approval, or approve
 * itself outright.
 */

type OrgRow = NonNullable<Awaited<ReturnType<typeof repo.findById>>>;

/**
 * An organization as the CALLER may see it.
 *
 * `reviewNote` is an admin's working note — "GST certificate looks forged" —
 * and is stripped for everyone else. A rejection reason is a thing to
 * communicate deliberately, not to leak through a list endpoint.
 */
function serialise(org: OrgRow, forAdmin: boolean) {
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    type: org.type,
    status: org.status,
    description: org.description,
    logoUrl: org.logoUrl,
    websiteUrl: org.websiteUrl,
    contactEmail: org.contactEmail,
    contactPhone: org.contactPhone,
    city: org.city,
    regionCode: org.regionCode,
    memberCount: Number(org.memberCount ?? 0),
    reviewNote: forAdmin ? org.reviewNote : null,
    reviewedAt: org.reviewedAt?.toISOString() ?? null,
    createdAt: org.createdAt.toISOString(),
  };
}

/** `Acme Ltd` -> `acme-ltd`, with a random suffix only if that is taken. */
async function uniqueSlug(name: string) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'org';
  if (!(await repo.slugTaken(base))) return base;
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${crypto.randomUUID().slice(0, 6)}`;
    if (!(await repo.slugTaken(candidate))) return candidate;
  }
  throw new DomainError('GEN_500', 'Could not allocate a URL for this organization.', 500);
}

export type CreateBody = {
  name: string;
  type: 'industry' | 'ngo' | 'seller';
  description?: string;
  websiteUrl?: string;
  contactEmail?: string;
  contactPhone?: string;
  city?: string;
  regionCode?: string;
};

export async function create(userId: number, body: CreateBody) {
  // `one_org_per_user` is the real guarantee; this is the readable error.
  if (await repo.findMembership(userId)) {
    throw new DomainError('ORG_005', 'You already belong to an organization.', 409);
  }

  const slug = await uniqueSlug(body.name);

  const id = await db
    .transaction(async (tx) => {
      // The creator becomes the owner in the same transaction. An
      // organization with no owner cannot be administered by anyone.
      const orgId = await repo.insertOrganization(tx, {
        slug,
        name: body.name,
        type: body.type,
        description: body.description ?? null,
        websiteUrl: body.websiteUrl ?? null,
        contactEmail: body.contactEmail ?? null,
        contactPhone: body.contactPhone ?? null,
        city: body.city ?? null,
        regionCode: body.regionCode ?? null,
      });
      await repo.insertMember(tx, { organizationId: orgId, userId, role: 'owner' });
      return orgId;
    })
    .catch((error: unknown) => {
      // orgs_name_lower_unq. Two companies with the same name is a support
      // ticket nobody can resolve from the data.
      const constraint = (error as { cause?: { constraint?: string } }).cause?.constraint;
      if (constraint === 'orgs_name_lower_unq') {
        throw new DomainError('ORG_006', 'An organization with that name already exists.', 409);
      }
      if (constraint === 'one_org_per_user') {
        throw new DomainError('ORG_005', 'You already belong to an organization.', 409);
      }
      throw error;
    });

  const created = await repo.findById(id);
  if (!created) throw new DomainError('ORG_007', 'Organization not found.', 404);
  return serialise(created, false);
}

export async function mine(userId: number) {
  const row = await repo.findMembership(userId);
  if (!row) return { organization: null, role: null };
  return { organization: serialise(row, false), role: row.role };
}

/** Owner of THIS organization, or 403. Membership, not identity. */
async function assertOwner(userId: number, organizationId: number) {
  const org = await repo.findById(organizationId);
  if (!org) throw new DomainError('ORG_007', 'Organization not found.', 404);
  const role = await repo.findMemberRole(organizationId, userId);
  if (role === null)
    throw new DomainError('ORG_001', 'You do not belong to that organization.', 403);
  if (role !== 'owner')
    throw new DomainError('ORG_004', 'Only an organization owner can do that.', 403);
  return org;
}

export type UpdateBody = Partial<Omit<CreateBody, 'type'>> & { logoUrl?: string | null };

export async function update(userId: number, organizationId: number, body: UpdateBody) {
  const existing = await assertOwner(userId, organizationId);

  const patch: Record<string, unknown> = {};
  for (const key of [
    'name',
    'description',
    'websiteUrl',
    'contactEmail',
    'contactPhone',
    'city',
    'regionCode',
    'logoUrl',
  ] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  /**
   * Changing WHO YOU APPEAR TO BE re-opens the review.
   *
   * An approval attaches to an identity. "Acme Ltd" passing review and then
   * renaming itself to something official-looking, with a matching logo and
   * website, keeps the badge while becoming a different organization
   * entirely. Name, logo and website are the fields that impersonate; a
   * phone number or a description are not, so those do not disturb an
   * approval.
   */
  const identityChanged = (['name', 'logoUrl', 'websiteUrl'] as const).some(
    (k) => patch[k] !== undefined && patch[k] !== existing[k],
  );
  if (identityChanged && existing.status === 'approved') {
    patch.status = 'pending';
    patch.reviewedAt = null;
    patch.reviewNote = null;
  }

  // Deliberately NOT patchable: `type` and `status`. A seller must not
  // re-badge itself as an NGO after approval, and nobody approves themselves.
  if (Object.keys(patch).length > 0) {
    await repo.updateOrganization(organizationId, patch).catch((error: unknown) => {
      if (
        (error as { cause?: { constraint?: string } }).cause?.constraint === 'orgs_name_lower_unq'
      ) {
        throw new DomainError('ORG_006', 'An organization with that name already exists.', 409);
      }
      throw error;
    });
  }

  const fresh = await repo.findById(organizationId);
  if (!fresh) throw new DomainError('ORG_007', 'Organization not found.', 404);
  return serialise(fresh, false);
}

export async function members(userId: number, organizationId: number) {
  const org = await repo.findById(organizationId);
  if (!org) throw new DomainError('ORG_007', 'Organization not found.', 404);
  // Any member may see the roster; only an owner may change it.
  if ((await repo.findMemberRole(organizationId, userId)) === null) {
    throw new DomainError('ORG_001', 'You do not belong to that organization.', 403);
  }

  const rows = await repo.listMembers(organizationId);
  return {
    organization: serialise(org, false),
    items: rows.map((r) => ({
      user: { id: r.id, name: r.name, avatarUrl: r.avatarUrl, city: r.city },
      role: r.role,
      joinedAt: r.joinedAt.toISOString(),
    })),
  };
}

export async function addMember(
  userId: number,
  organizationId: number,
  body: { email: string; role: 'owner' | 'member' },
) {
  const org = await assertOwner(userId, organizationId);

  /**
   * Only an APPROVED organization may add members.
   *
   * This endpoint tells its caller whether an email address has an account,
   * which is an enumeration oracle. Gating it on approval means an attacker
   * must first get a human to approve an organization before they can probe
   * anything — a real barrier, and one that costs a legitimate owner only
   * the wait they are already in.
   */
  if (org.status !== 'approved') {
    throw new DomainError('ORG_002', `Your organization is ${org.status}.`, 403, {
      status: org.status,
    });
  }

  const invitee = await repo.findUserByEmail(body.email);
  // Same 404 whether the address has no account or the lookup failed: this
  // endpoint must not become a way to test whether an email is registered.
  if (!invitee) throw new DomainError('ORG_008', 'No account with that email address.', 404);

  try {
    await repo.insertMember(db, {
      organizationId,
      userId: invitee.id,
      role: body.role,
    });
  } catch (error) {
    if ((error as { cause?: { constraint?: string } }).cause?.constraint === 'one_org_per_user') {
      throw new DomainError('ORG_005', 'That person already belongs to an organization.', 409);
    }
    throw error;
  }

  return members(userId, organizationId);
}

export async function removeMember(userId: number, organizationId: number, memberId: number) {
  await assertOwner(userId, organizationId);
  // Self-removal has its own endpoint, because its answer is different: a
  // person who just left cannot read the roster they are no longer on.
  if (memberId === userId) {
    throw new DomainError('ORG_011', 'Use DELETE /organizations/me/membership to leave.', 422);
  }
  await detach(organizationId, memberId);
  return members(userId, organizationId);
}

/**
 * Self-service exit.
 *
 * Without this, someone added by an owner without being asked has no way
 * out — and because `one_org_per_user` is unique, being enrolled also
 * permanently blocks them from creating their own. A membership nobody
 * consented to and nobody can leave is a trap, not a feature.
 */
export async function leave(userId: number) {
  const membership = await repo.findMembership(userId);
  if (!membership) throw new DomainError('ORG_001', 'You do not belong to an organization.', 403);
  await detach(membership.id, userId);
  return { left: true as const };
}

/** The shared removal, with the last-owner invariant held under a lock. */
async function detach(organizationId: number, memberId: number) {
  await db.transaction(async (tx) => {
    const role = await repo.findMemberRole(organizationId, memberId, tx);
    if (role === null) throw new DomainError('ORG_008', 'That person is not a member.', 404);

    // Counted under a row lock, inside the same transaction as the delete.
    // Two owners leaving at the same moment would otherwise both see two
    // owners, both pass, and leave the organization with none — nobody can
    // administer it and nobody can be added.
    if (role === 'owner' && (await repo.lockOwnerCount(tx, organizationId)) <= 1) {
      throw new DomainError('ORG_009', 'An organization must keep at least one owner.', 422);
    }
    await repo.removeMemberIn(tx, organizationId, memberId);
  });
}

// --- admin -----------------------------------------------------------------

export async function adminList(query: {
  status?: string;
  type?: string;
  cursor?: string;
  limit: number;
}): Promise<Page<ReturnType<typeof serialise>>> {
  const rows = await repo.listOrganizations({
    status: query.status,
    type: query.type,
    afterId: decodeIdCursor(query.cursor),
    limit: query.limit,
  });
  const page = toPage(rows, query.limit, (r) => r.id);
  return { items: page.items.map((r) => serialise(r, true)), pageInfo: page.pageInfo };
}

const DECISION_STATUS = {
  approve: 'approved',
  reject: 'rejected',
  suspend: 'suspended',
  reinstate: 'approved',
} as const;

export async function review(
  adminId: number,
  organizationId: number,
  body: { decision: keyof typeof DECISION_STATUS; note?: string },
) {
  const org = await repo.findById(organizationId);
  if (!org) throw new DomainError('ORG_007', 'Organization not found.', 404);

  // A refusal a human will have to defend later should be explained now,
  // while they still remember why.
  if ((body.decision === 'reject' || body.decision === 'suspend') && !body.note?.trim()) {
    throw new DomainError('ORG_010', 'A rejection or suspension needs a note.', 422);
  }

  await repo.updateOrganization(organizationId, {
    status: DECISION_STATUS[body.decision],
    reviewedBy: adminId,
    reviewedAt: new Date(),
    reviewNote: body.note?.trim() ?? null,
  });

  const fresh = await repo.findById(organizationId);
  if (!fresh) throw new DomainError('ORG_007', 'Organization not found.', 404);
  return serialise(fresh, true);
}
