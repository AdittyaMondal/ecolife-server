import { DomainError } from '@common/errors/domain-error.ts';
import { decodeIdCursor, type Page, toPage } from '@common/pagination.ts';
import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import type { z } from '@hono/zod-openapi';
import * as repo from './organizations.repository.ts';
import type {
  createOrgQuestionBodySchema,
  submitOrgOnboardingAnswersBodySchema,
  updateOrgQuestionBodySchema,
} from './organizations.schema.ts';

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
function serialise(org: OrgRow, forAdmin: boolean, forOwnOwner = false) {
  return {
    id: org.id,
    slug: org.slug,
    code: org.code,
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
    address: org.address ?? null,
    memberCount: Number(org.memberCount ?? 0),
    reviewNote: forAdmin ? org.reviewNote : null,
    /**
     * Same reasoning as `reviewNote` above, and it was missed here.
     *
     * This is the free-form blob the organization submitted at registration —
     * GST/CIN, licence numbers, a named contact. It needs THREE states, not
     * two, which is why `forOwnOwner` exists: an admin reviewing the queue and
     * the organization's own owner both have business reading it; nobody else
     * does. `joinByCode` and `members` serialise with both flags false, and an
     * org code is handed to every employee by design — so while this line was
     * ungated, joining with a six-digit code returned the registration file.
     */
    verificationDetails:
      forAdmin || forOwnOwner
        ? ((org.verificationDetails as Record<string, unknown>) ?? null)
        : null,
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

/** Generates a cryptographically random 6-digit organization code (100000..999999). */
async function uniqueOrgCode(tx: Executor = db): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    const val = array[0]!;
    const candidate = String((val % 900000) + 100000);
    if (!(await repo.codeTaken(candidate, tx))) return candidate;
  }
  throw new DomainError('GEN_500', 'Could not allocate a 6-digit organization code.', 500);
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
  address?: string;
  verificationDetails?: Record<string, unknown>;
};

export async function create(userId: number, body: CreateBody) {
  // `one_org_per_user` is the real guarantee; this is the readable error.
  if (await repo.findMembership(userId)) {
    throw new DomainError('ORG_005', 'You already belong to an organization.', 409);
  }

  const slug = await uniqueSlug(body.name);

  const id = await db
    .transaction(async (tx) => {
      const code = await uniqueOrgCode(tx);
      // The creator becomes the owner in the same transaction. An
      // organization with no owner cannot be administered by anyone.
      const orgId = await repo.insertOrganization(tx, {
        slug,
        code,
        name: body.name,
        type: body.type,
        description: body.description ?? null,
        websiteUrl: body.websiteUrl ?? null,
        contactEmail: body.contactEmail ?? null,
        contactPhone: body.contactPhone ?? null,
        city: body.city ?? null,
        regionCode: body.regionCode ?? null,
        verificationDetails: body.verificationDetails ?? null,
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
  // The caller IS the owner of what they just created.
  return serialise(created, false, true);
}

export async function mine(userId: number) {
  const row = await repo.findMembership(userId);
  if (!row) return { organization: null, role: null };
  return { organization: serialise(row, false, row.role === 'owner'), role: row.role };
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
  await assertOwner(userId, organizationId);

  const patch: Record<string, unknown> = {};
  for (const key of [
    'name',
    'description',
    'websiteUrl',
    'contactEmail',
    'contactPhone',
    'city',
    'regionCode',
    'address',
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
   * phone number or a description are not, so those do not disturb it.
   *
   * The decision is made IN THE UPDATE, not from `existing`. Reading the
   * status here and acting on it later is a race an owner can win: read
   * `pending`, let an admin approve in the same instant, then land the
   * rename on a row that is now `approved`.
   *
   * Deliberately NOT patchable at all: `type` and `status`. A seller must
   * not re-badge itself as an NGO, and nobody approves themselves.
   */
  if (Object.keys(patch).length > 0) {
    await repo
      .updateOrganizationChecked(organizationId, patch, {
        name: body.name,
        logoUrl: body.logoUrl,
        websiteUrl: body.websiteUrl,
      })
      .catch((error: unknown) => {
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
  // assertOwner above, so the caller owns this organization.
  return serialise(fresh, false, true);
}

export async function members(
  userId: number,
  organizationId: number,
  filters: {
    search?: string;
    role?: 'owner' | 'member';
    onboardingStatus?: 'completed' | 'pending';
  } = {},
) {
  const org = await repo.findById(organizationId);
  if (!org) throw new DomainError('ORG_007', 'Organization not found.', 404);
  const callerRole = await repo.findMemberRole(organizationId, userId);
  if (callerRole === null) {
    throw new DomainError('ORG_001', 'You do not belong to that organization.', 403);
  }

  const rows = await repo.listMembers(organizationId, filters);
  const isOwner = callerRole === 'owner';

  return {
    organization: serialise(org, false),
    items: rows.map((r) => {
      // Respect privacy: If caller is the member themselves, or if caller is an owner and member shares footprint
      const canViewFootprint = r.id === userId || (isOwner && r.shareFootprint);

      return {
        user: { id: r.id, name: r.name, avatarUrl: r.avatarUrl, city: r.city },
        email: isOwner ? r.email : undefined,
        role: r.role,
        joinedAt: r.joinedAt.toISOString(),
        shareFootprint: r.shareFootprint,
        onboardingStatus: r.onboardedAt ? ('completed' as const) : ('pending' as const),
        pointsTotal: r.pointsTotal ?? 0,
        currentStreak: r.currentStreak ?? 0,
        baselineTotalKg:
          canViewFootprint && r.baselineTotalKg != null ? Number(r.baselineTotalKg) : null,
        last30DaysTotalKg:
          canViewFootprint && r.last30DaysTotalKg != null
            ? Number(Number(r.last30DaysTotalKg).toFixed(1))
            : null,
        avgDailyKg:
          canViewFootprint && r.avgDailyKg != null ? Number(Number(r.avgDailyKg).toFixed(2)) : null,
        reductionPct:
          canViewFootprint && r.reductionPct != null
            ? Number(Number(r.reductionPct).toFixed(1))
            : null,
        lastActiveAt:
          canViewFootprint && r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : null,
      };
    }),
  };
}

export async function updateMembershipPreferences(userId: number, shareFootprint: boolean) {
  const membership = await repo.findMembership(userId);
  if (!membership) {
    throw new DomainError('ORG_001', 'You do not belong to an organization.', 403);
  }

  const updated = await repo.updateMembershipPreferences(userId, shareFootprint);
  if (!updated) {
    throw new DomainError('ORG_001', 'Could not update membership preferences.', 400);
  }

  return {
    updated: true as const,
    shareFootprint: updated.shareFootprint,
  };
}

export async function analytics(userId: number, organizationId: number) {
  const org = await repo.findById(organizationId);
  if (!org) throw new DomainError('ORG_007', 'Organization not found.', 404);

  const callerRole = await repo.findMemberRole(organizationId, userId);
  if (callerRole === null) {
    throw new DomainError('ORG_001', 'You do not belong to that organization.', 403);
  }
  if (callerRole !== 'owner') {
    throw new DomainError(
      'AUTH_002',
      'Only organization admins can view cumulative analytics.',
      403,
    );
  }

  const data = await repo.getOrganizationAnalytics(organizationId);
  const totalKg = Number(data.emissions.totalKg.toFixed(1));
  const transportKg = Number(data.emissions.transportKg.toFixed(1));
  const foodKg = Number(data.emissions.foodKg.toFixed(1));
  const homeEnergyKg = Number(data.emissions.homeEnergyKg.toFixed(1));
  const waterKg = Number(data.emissions.waterKg.toFixed(1));
  const wasteKg = Number(data.emissions.wasteKg.toFixed(1));

  const totalMembers = Math.max(1, data.memberStats.totalMembers);
  const activeLoggers = data.emissions.activeLoggers;

  const totalEmissionsForPct = totalKg > 0 ? totalKg : 1;
  const transportPct = Number(((transportKg / totalEmissionsForPct) * 100).toFixed(1));
  const foodPct = Number(((foodKg / totalEmissionsForPct) * 100).toFixed(1));
  const homeEnergyPct = Number(((homeEnergyKg / totalEmissionsForPct) * 100).toFixed(1));
  const waterPct = Number(((waterKg / totalEmissionsForPct) * 100).toFixed(1));
  const wastePct = Number(((wasteKg / totalEmissionsForPct) * 100).toFixed(1));

  const avgPerEmployeeKg = Number((totalKg / totalMembers).toFixed(1));
  const annualProjectedTonnes = Number(
    ((data.memberStats.baselineTotalKg * 365) / 1000).toFixed(1),
  );
  const dailyPerCapitaKg = Number((data.memberStats.baselineTotalKg / totalMembers).toFixed(1));
  const urbanBenchmarkDailyKg = 7.2;
  const reductionVsUrbanPct =
    dailyPerCapitaKg > 0 && dailyPerCapitaKg < urbanBenchmarkDailyKg
      ? Number(
          (((urbanBenchmarkDailyKg - dailyPerCapitaKg) / urbanBenchmarkDailyKg) * 100).toFixed(1),
        )
      : 0;

  return {
    organizationId,
    totalFootprintKg: totalKg,
    annualProjectedTonnes,
    totalMembers,
    activeLoggers,
    avgPerEmployeeKg,
    dailyPerCapitaKg,
    urbanBenchmarkDailyKg,
    reductionVsUrbanPct,
    categories: {
      transportKg,
      foodKg,
      homeEnergyKg,
      waterKg,
      wasteKg,
      transportPct,
      foodPct,
      homeEnergyPct,
      waterPct,
      wastePct,
    },
    monthlyTrend: data.monthlyTrend.map((m) => ({
      month: m.month,
      totalKg: Number(m.totalKg.toFixed(1)),
      avgPerEmployeeKg: Number(m.avgPerEmployeeKg.toFixed(1)),
      activeLoggers: m.activeLoggers,
    })),
  };
}

export async function joinByCode(userId: number, code: string) {
  if (await repo.findMembership(userId)) {
    throw new DomainError('ORG_005', 'You already belong to an organization.', 409);
  }

  const org = await repo.findByCode(code);
  if (!org) {
    throw new DomainError('ORG_007', 'No organization found with that code.', 404);
  }

  if (org.status !== 'approved') {
    throw new DomainError(
      'ORG_002',
      `This organization is ${org.status}. Only approved organizations can accept members.`,
      403,
    );
  }

  try {
    await repo.insertMember(db, {
      organizationId: org.id,
      userId,
      role: 'member',
    });
  } catch (error) {
    if ((error as { cause?: { constraint?: string } }).cause?.constraint === 'one_org_per_user') {
      throw new DomainError('ORG_005', 'You already belong to an organization.', 409);
    }
    throw error;
  }

  return {
    joined: true as const,
    organization: serialise(org, false),
    role: 'member' as const,
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
  body: {
    decision: keyof typeof DECISION_STATUS;
    note?: string;
    expected: { name: string; logoUrl: string | null; websiteUrl: string | null };
  },
) {
  const org = await repo.findById(organizationId);
  if (!org) throw new DomainError('ORG_007', 'Organization not found.', 404);

  // A refusal a human will have to defend later should be explained now,
  // while they still remember why.
  if ((body.decision === 'reject' || body.decision === 'suspend') && !body.note?.trim()) {
    throw new DomainError('ORG_010', 'A rejection or suspension needs a note.', 422);
  }

  /**
   * Decide only if it is still the organization the admin was looking at.
   *
   * The comparison is part of the UPDATE rather than a check before it:
   * an admin reads the queue, thinks, then clicks, and an owner can edit
   * in that gap. Renaming an APPROVED organization already sends it back
   * for review; this closes the other direction, where a PENDING one is
   * changed between being read and being approved.
   */
  const applied = await repo.reviewIfUnchanged(
    organizationId,
    {
      status: DECISION_STATUS[body.decision],
      reviewedBy: adminId,
      reviewedAt: new Date(),
      reviewNote: body.note?.trim() ?? null,
    },
    body.expected,
  );

  if (!applied) {
    throw new DomainError('ORG_012', 'This organization changed — review it again.', 409, {
      expected: body.expected,
      actual: { name: org.name, logoUrl: org.logoUrl, websiteUrl: org.websiteUrl },
    });
  }

  const fresh = await repo.findById(organizationId);
  if (!fresh) throw new DomainError('ORG_007', 'Organization not found.', 404);
  return serialise(fresh, true);
}

export async function regenerateCode(userId: number) {
  const membership = await repo.findMembership(userId);
  if (!membership) {
    throw new DomainError('ORG_001', 'You do not belong to an organization.', 403);
  }
  if (membership.role !== 'owner') {
    throw new DomainError('ORG_004', 'Only an organization owner can regenerate the code.', 403);
  }

  const newCode = await uniqueOrgCode();
  const updated = await repo.updateCode(membership.id, newCode);
  if (!updated) {
    throw new DomainError('ORG_007', 'Organization not found.', 404);
  }

  return {
    code: newCode,
    // Owner-only route (ORG_004 above).
    organization: serialise(updated, false, true),
  };
}

export async function lookupByCode(code: string) {
  const cleanCode = code.trim();
  const org = await repo.findByCode(cleanCode);
  if (!org) {
    throw new DomainError('ORG_007', 'No organization found with that code.', 404);
  }
  if (org.status !== 'approved') {
    throw new DomainError(
      'ORG_002',
      `This organization is ${org.status}. Only approved organizations can accept members.`,
      403,
      { status: org.status },
    );
  }
  return {
    valid: true as const,
    name: org.name,
    type: org.type,
    slug: org.slug,
    code: org.code,
  };
}

// --- Part 4: Custom Onboarding Questions -----------------------------------

function serialiseQuestion(q: repo.QuestionRow) {
  return {
    id: q.id,
    organizationId: q.organizationId,
    prompt: q.prompt,
    description: q.description ?? null,
    type: q.type as 'text' | 'single_choice' | 'multiple_choice' | 'number' | 'yes_no',
    options: q.options ?? null,
    required: q.required,
    sortOrder: q.sortOrder,
    version: q.version,
    active: q.active,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

function serialiseAnswer(a: repo.AnswerRow) {
  return {
    id: a.id,
    questionId: a.questionId,
    questionPrompt: a.questionPrompt,
    questionType: a.questionType,
    questionVersion: a.questionVersion,
    answer: a.answer,
    answeredAt: a.createdAt.toISOString(),
  };
}

function validateAnswerValue(question: repo.QuestionRow, val: unknown) {
  const isMissing =
    val === null || val === undefined || val === '' || (Array.isArray(val) && val.length === 0);

  if (isMissing) {
    if (question.required) {
      throw new DomainError('ORG_016', `Question "${question.prompt}" is required.`, 400);
    }
    return;
  }

  switch (question.type) {
    case 'text':
      if (typeof val !== 'string') {
        throw new DomainError('ORG_017', `Answer for "${question.prompt}" must be a string.`, 400);
      }
      break;
    case 'number':
      if (typeof val !== 'number' && (typeof val !== 'string' || Number.isNaN(Number(val)))) {
        throw new DomainError('ORG_017', `Answer for "${question.prompt}" must be a number.`, 400);
      }
      break;
    case 'yes_no':
      if (typeof val !== 'boolean') {
        throw new DomainError(
          'ORG_017',
          `Answer for "${question.prompt}" must be true or false.`,
          400,
        );
      }
      break;
    case 'single_choice':
      if (typeof val !== 'string') {
        throw new DomainError(
          'ORG_017',
          `Answer for "${question.prompt}" must be a selected option.`,
          400,
        );
      }
      if (question.options && question.options.length > 0 && !question.options.includes(val)) {
        throw new DomainError(
          'ORG_017',
          `"${val}" is not an option for "${question.prompt}".`,
          400,
        );
      }
      break;
    case 'multiple_choice':
      if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
        throw new DomainError(
          'ORG_017',
          `Answer for "${question.prompt}" must be an array of selected options.`,
          400,
        );
      }
      if (question.options && question.options.length > 0) {
        for (const opt of val) {
          if (!question.options.includes(opt)) {
            throw new DomainError(
              'ORG_017',
              `"${opt}" is not a valid option for "${question.prompt}".`,
              400,
            );
          }
        }
      }
      break;
  }
}

export async function listQuestions(userId: number, organizationId: number) {
  const org = await repo.findById(organizationId);
  if (!org) throw new DomainError('ORG_007', 'Organization not found.', 404);
  const role = await repo.findMemberRole(organizationId, userId);
  if (role === null) {
    throw new DomainError('ORG_001', 'You do not belong to that organization.', 403);
  }

  const rows = await repo.listQuestions(organizationId);
  return rows.map(serialiseQuestion);
}

export async function createQuestion(
  userId: number,
  organizationId: number,
  body: z.infer<typeof createOrgQuestionBodySchema>,
) {
  await assertOwner(userId, organizationId);

  if (
    (body.type === 'single_choice' || body.type === 'multiple_choice') &&
    (!body.options || body.options.length < 2)
  ) {
    throw new DomainError(
      'ORG_014',
      'Single choice and multiple choice questions require at least 2 options.',
      400,
    );
  }

  const created = await repo.createQuestion(organizationId, {
    prompt: body.prompt,
    description: body.description ?? null,
    type: body.type,
    options: body.options ?? null,
    required: body.required ?? false,
  });

  return serialiseQuestion(created);
}

export async function updateQuestion(
  userId: number,
  organizationId: number,
  questionId: number,
  body: z.infer<typeof updateOrgQuestionBodySchema>,
) {
  await assertOwner(userId, organizationId);

  const existing = await repo.findQuestionById(questionId);
  if (!existing || existing.organizationId !== organizationId) {
    throw new DomainError('ORG_015', 'Question not found.', 404);
  }

  const effectiveType = body.type ?? existing.type;
  const effectiveOptions = body.options !== undefined ? body.options : existing.options;

  if (
    (effectiveType === 'single_choice' || effectiveType === 'multiple_choice') &&
    (!effectiveOptions || effectiveOptions.length < 2)
  ) {
    throw new DomainError(
      'ORG_014',
      'Single choice and multiple choice questions require at least 2 options.',
      400,
    );
  }

  const updated = await repo.updateQuestion(questionId, body);
  if (!updated) {
    throw new DomainError('ORG_015', 'Question not found.', 404);
  }

  return serialiseQuestion(updated);
}

export async function reorderQuestions(
  userId: number,
  organizationId: number,
  questionIds: number[],
) {
  await assertOwner(userId, organizationId);
  await repo.reorderQuestions(organizationId, questionIds);
  return { ok: true as const };
}

export async function deleteQuestion(userId: number, organizationId: number, questionId: number) {
  await assertOwner(userId, organizationId);

  const existing = await repo.findQuestionById(questionId);
  if (!existing || existing.organizationId !== organizationId) {
    throw new DomainError('ORG_015', 'Question not found.', 404);
  }

  await repo.deleteQuestion(questionId);
  return { ok: true as const };
}

export async function getOnboardingQuestionsAndAnswers(userId: number) {
  const membership = await repo.findMembership(userId);
  if (!membership) {
    throw new DomainError('ORG_001', 'You do not belong to an organization.', 404);
  }

  const questions = await repo.listQuestions(membership.id);
  const answers = await repo.listAnswersForUser(membership.id, userId);

  const answeredQuestionIds = new Set(
    answers
      .filter((a) => a.answer !== null && a.answer !== undefined && a.answer !== '')
      .map((a) => a.questionId),
  );
  const requiredQuestions = questions.filter((q) => q.required);
  const isCompleted = requiredQuestions.every((q) => answeredQuestionIds.has(q.id));

  return {
    organization: serialise(membership, false),
    questions: questions.map(serialiseQuestion),
    answers: answers.map(serialiseAnswer),
    isCompleted,
  };
}

export async function submitOnboardingAnswers(
  userId: number,
  body: z.infer<typeof submitOrgOnboardingAnswersBodySchema>,
) {
  const membership = await repo.findMembership(userId);
  if (!membership) {
    throw new DomainError('ORG_001', 'You do not belong to an organization.', 404);
  }

  const questions = await repo.listQuestions(membership.id);
  const questionMap = new Map(questions.map((q) => [q.id, q]));

  const existingAnswers = await repo.listAnswersForUser(membership.id, userId);
  const existingAnswerMap = new Map(existingAnswers.map((a) => [a.questionId, a]));

  const toUpsert: Array<{
    questionId: number;
    questionPrompt: string;
    questionType: string;
    questionVersion: number;
    answer: unknown;
  }> = [];

  for (const item of body.answers) {
    const q = questionMap.get(item.questionId);
    if (!q) {
      throw new DomainError(
        'ORG_015',
        `Question #${item.questionId} not found in this organization.`,
        400,
      );
    }
    validateAnswerValue(q, item.answer);

    toUpsert.push({
      questionId: q.id,
      questionPrompt: q.prompt,
      questionType: q.type,
      questionVersion: q.version,
      answer: item.answer,
    });
  }

  // Check required questions
  const submittedIds = new Set(
    body.answers
      .filter((a) => a.answer !== null && a.answer !== undefined && a.answer !== '')
      .map((a) => a.questionId),
  );
  const existingCompletedIds = new Set(
    existingAnswers
      .filter((a) => a.answer !== null && a.answer !== undefined && a.answer !== '')
      .map((a) => a.questionId),
  );

  for (const q of questions) {
    if (q.required && !submittedIds.has(q.id) && !existingCompletedIds.has(q.id)) {
      throw new DomainError('ORG_016', `Question "${q.prompt}" is required.`, 400);
    }
  }

  if (toUpsert.length > 0) {
    await repo.upsertAnswers(membership.id, userId, toUpsert);
  }

  return { ok: true as const, count: toUpsert.length };
}

export async function getMemberAnswers(
  callerId: number,
  organizationId: number,
  targetUserId: number,
) {
  await assertOwner(callerId, organizationId);

  const targetRole = await repo.findMemberRole(organizationId, targetUserId);
  if (targetRole === null) {
    throw new DomainError('ORG_001', 'The user does not belong to this organization.', 404);
  }

  const answers = await repo.listAnswersForUser(organizationId, targetUserId);
  return {
    userId: targetUserId,
    organizationId,
    answers: answers.map(serialiseAnswer),
  };
}
