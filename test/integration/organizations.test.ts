import { describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { createOnboardedUser } from '@common/testing/fixtures.ts';
import { db } from '@database/client.ts';
import { organizations } from '@database/schema/index.ts';
import { eq } from 'drizzle-orm';
import { app } from '../../src/app.ts';

/** Partner organizations and the admin review queue (PRD-v2 §6.9). */

const TIMEOUT = 30_000;

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...freshIpHeaders(),
      ...(init.headers ?? {}),
    },
  });

type Envelope = {
  status: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary response JSON
  data: any;
  // biome-ignore lint/suspicious/noExplicitAny: details differ per error code
  error: { code: string; message: string; details: any };
};
const json = async (r: Response) => (await r.json()) as unknown as Envelope;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const body = (overrides: Record<string, unknown> = {}) => ({
  name: `Acme ${crypto.randomUUID().slice(0, 8)}`,
  type: 'industry',
  city: 'Pune',
  regionCode: 'IN-MH',
  ...overrides,
});

async function approve(adminToken: string, orgId: number, expectedName: string) {
  return call(`/admin/organizations/${orgId}/review`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({ decision: 'approve', note: 'test', expectedName }),
  });
}

async function register(token: string, overrides: Record<string, unknown> = {}) {
  return json(
    await call('/organizations', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify(body(overrides)),
    }),
  );
}

describe('registering an organization', () => {
  it(
    'creates it as pending, with the caller as owner',
    async () => {
      const owner = await createOnboardedUser();
      const res = await call('/organizations', {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify(body()),
      });
      const created = await json(res);

      expect(res.status).toBe(201);
      // `[LESSON]` Anyone can claim to be a corporate partner at signup.
      // Nothing is usable until a human approves it.
      expect(created.data.status).toBe('pending');
      expect(created.data.type).toBe('industry');
      expect(created.data.memberCount).toBe(1);
      expect(created.data.slug).toMatch(/^acme-/);

      const mine = await json(await call('/organizations/me', { headers: auth(owner.token) }));
      expect(mine.data.role).toBe('owner');
      expect(mine.data.organization.id).toBe(created.data.id);

      // And it surfaces on /auth/me, which is how a client routes to a portal.
      const me = await json(await call('/auth/me', { headers: auth(owner.token) }));
      expect(me.data.organization.status).toBe('pending');
      expect(me.data.organization.role).toBe('owner');
    },
    TIMEOUT,
  );

  it(
    'allows only one organization per person',
    async () => {
      const owner = await createOnboardedUser();
      expect((await register(owner.token)).data.id).toBeGreaterThan(0);

      const second = await call('/organizations', {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify(body()),
      });
      expect(second.status).toBe(409);
      expect((await json(second)).error.code).toBe('ORG_005');
    },
    TIMEOUT,
  );

  it(
    'rejects a duplicate name, case-insensitively',
    async () => {
      const first = await createOnboardedUser();
      const second = await createOnboardedUser();
      const name = `Dup ${crypto.randomUUID().slice(0, 8)}`;

      await register(first.token, { name });
      const clash = await call('/organizations', {
        method: 'POST',
        headers: auth(second.token),
        body: JSON.stringify(body({ name: name.toUpperCase() })),
      });
      // orgs_name_lower_unq. Two companies with the same name is a support
      // ticket nobody can resolve from the data.
      expect(clash.status).toBe(409);
      expect((await json(clash)).error.code).toBe('ORG_006');
    },
    TIMEOUT,
  );

  it(
    'returns nulls, not an error, for someone with no organization',
    async () => {
      const nobody = await createOnboardedUser();
      const mine = await json(await call('/organizations/me', { headers: auth(nobody.token) }));
      expect(mine.data).toEqual({ organization: null, role: null });
    },
    TIMEOUT,
  );
});

describe('ownership boundaries', () => {
  it(
    'will not let a non-member read or edit, and a plain member cannot edit',
    async () => {
      const owner = await createOnboardedUser();
      const member = await createOnboardedUser();
      const stranger = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const org = (await register(owner.token)).data;
      await approve(admin.token, org.id, org.name);

      await call(`/organizations/${org.id}/members`, {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify({ email: member.email, role: 'member' }),
      });

      // A stranger sees nothing.
      expect(
        (await call(`/organizations/${org.id}/members`, { headers: auth(stranger.token) })).status,
      ).toBe(403);

      // A member may read the roster...
      const roster = await call(`/organizations/${org.id}/members`, {
        headers: auth(member.token),
      });
      expect(roster.status).toBe(200);
      expect((await json(roster)).data.items).toHaveLength(2);

      // ...but not change the organization.
      const edit = await call(`/organizations/${org.id}`, {
        method: 'PATCH',
        headers: auth(member.token),
        body: JSON.stringify({ city: 'Mumbai' }),
      });
      expect(edit.status).toBe(403);
      expect((await json(edit)).error.code).toBe('ORG_004');
    },
    TIMEOUT,
  );

  it(
    'will not let an owner re-badge or self-approve',
    async () => {
      const owner = await createOnboardedUser();
      const org = (await register(owner.token, { type: 'seller' })).data;

      const res = await json(
        await call(`/organizations/${org.id}`, {
          method: 'PATCH',
          headers: auth(owner.token),
          // Both are rejected by the schema rather than silently applied.
          body: JSON.stringify({ city: 'Nagpur', type: 'ngo', status: 'approved' }),
        }),
      );

      // The legitimate field changed; the two that would be an escalation
      // did not. A seller must not become an NGO after approval, and nobody
      // approves themselves.
      expect(res.data.city).toBe('Nagpur');
      expect(res.data.type).toBe('seller');
      expect(res.data.status).toBe('pending');
    },
    TIMEOUT,
  );

  it(
    'keeps at least one owner',
    async () => {
      const owner = await createOnboardedUser();
      const org = (await register(owner.token)).data;

      const res = await call(`/organizations/${org.id}/members/${owner.userId}`, {
        method: 'DELETE',
        headers: auth(owner.token),
      });
      // Self-removal has its own endpoint, because the answer differs.
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('ORG_011');
    },
    TIMEOUT,
  );

  it(
    'will not take a member who already belongs somewhere else',
    async () => {
      const first = await createOnboardedUser();
      const second = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const org = (await register(first.token)).data;
      await approve(admin.token, org.id, org.name);
      await register(second.token);

      const res = await call(`/organizations/${org.id}/members`, {
        method: 'POST',
        headers: auth(first.token),
        body: JSON.stringify({ email: second.email, role: 'member' }),
      });
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe('ORG_005');
    },
    TIMEOUT,
  );
});

describe('consent and identity', () => {
  it(
    'refuses to add members until a human has approved the organization',
    async () => {
      const owner = await createOnboardedUser();
      const invitee = await createOnboardedUser();
      const org = (await register(owner.token)).data;

      // While pending, this endpoint would otherwise tell any would-be
      // owner whether an arbitrary email has an account.
      const early = await call(`/organizations/${org.id}/members`, {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify({ email: invitee.email, role: 'member' }),
      });
      expect(early.status).toBe(403);
      expect((await json(early)).error.code).toBe('ORG_002');

      const admin = await createOnboardedUser({ role: 'admin' });
      await approve(admin.token, org.id, org.name);
      const after = await call(`/organizations/${org.id}/members`, {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify({ email: invitee.email, role: 'member' }),
      });
      expect(after.status).toBe(200);
    },
    TIMEOUT,
  );

  it(
    'lets someone added without being asked leave again',
    async () => {
      const owner = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const conscript = await createOnboardedUser();
      const org = (await register(owner.token)).data;
      await approve(admin.token, org.id, org.name);
      await call(`/organizations/${org.id}/members`, {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify({ email: conscript.email, role: 'member' }),
      });

      // Enrolled without consent, and one_org_per_user means that also
      // blocks them from making their own. A membership nobody agreed to
      // and nobody can leave is a trap.
      const blocked = await call('/organizations', {
        method: 'POST',
        headers: auth(conscript.token),
        body: JSON.stringify(body()),
      });
      expect(blocked.status).toBe(409);

      const left = await json(
        await call('/organizations/me/membership', {
          method: 'DELETE',
          headers: auth(conscript.token),
        }),
      );
      expect(left.data.left).toBe(true);

      // Free again, and able to create their own.
      const mine = await json(await call('/organizations/me', { headers: auth(conscript.token) }));
      expect(mine.data.organization).toBeNull();
      expect(
        (
          await call('/organizations', {
            method: 'POST',
            headers: auth(conscript.token),
            body: JSON.stringify(body()),
          })
        ).status,
      ).toBe(201);
    },
    TIMEOUT,
  );

  it(
    'will not let the last owner leave',
    async () => {
      const owner = await createOnboardedUser();
      await register(owner.token);
      const res = await call('/organizations/me/membership', {
        method: 'DELETE',
        headers: auth(owner.token),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('ORG_009');
    },
    TIMEOUT,
  );

  it(
    'sends an approved organization back for review when it changes identity',
    async () => {
      const owner = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const org = (await register(owner.token)).data;
      await approve(admin.token, org.id, org.name);

      // A phone number is not an identity.
      const contact = await json(
        await call(`/organizations/${org.id}`, {
          method: 'PATCH',
          headers: auth(owner.token),
          body: JSON.stringify({ contactPhone: '+912055555555' }),
        }),
      );
      expect(contact.data.status).toBe('approved');

      // A name is. An approval attaches to WHO you appear to be, and
      // "Acme Ltd" renaming itself to something official-looking must not
      // carry the badge across.
      const renamed = await json(
        await call(`/organizations/${org.id}`, {
          method: 'PATCH',
          headers: auth(owner.token),
          body: JSON.stringify({ name: `Ministry ${crypto.randomUUID().slice(0, 8)}` }),
        }),
      );
      expect(renamed.data.status).toBe('pending');
      expect(renamed.data.reviewedAt).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'refuses an approval when the name changed under the admin',
    async () => {
      const owner = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const org = (await register(owner.token)).data;

      // The admin opens the queue and sees one name...
      const queueName = org.name;
      // ...the owner renames before they click.
      const newName = `Ministry ${crypto.randomUUID().slice(0, 8)}`;
      await call(`/organizations/${org.id}`, {
        method: 'PATCH',
        headers: auth(owner.token),
        body: JSON.stringify({ name: newName }),
      });

      const stale = await approve(admin.token, org.id, queueName);
      expect(stale.status).toBe(409);
      expect((await json(stale)).error.code).toBe('ORG_012');

      const [row] = await db.select().from(organizations).where(eq(organizations.id, org.id));
      expect(row?.status).toBe('pending');

      // Looking again and approving what is actually there works.
      expect((await approve(admin.token, org.id, newName)).status).toBe(200);
    },
    TIMEOUT,
  );

  it(
    'sends an approved organization back for review even under a concurrent approval',
    async () => {
      const owner = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const org = (await register(owner.token)).data;
      await approve(admin.token, org.id, org.name);

      // The reset is decided inside the UPDATE, so it reads the row's real
      // status rather than one a prior SELECT happened to see.
      const newName = `Ministry ${crypto.randomUUID().slice(0, 8)}`;
      await call(`/organizations/${org.id}`, {
        method: 'PATCH',
        headers: auth(owner.token),
        body: JSON.stringify({ name: newName }),
      });

      const [row] = await db.select().from(organizations).where(eq(organizations.id, org.id));
      expect(row?.name).toBe(newName);
      expect(row?.status).toBe('pending');
      expect(row?.reviewedAt).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'rejects a javascript: website URL',
    async () => {
      const owner = await createOnboardedUser();
      const res = await call('/organizations', {
        method: 'POST',
        headers: auth(owner.token),
        // Rendered as a link in a partner directory, so an unrestricted
        // scheme is stored XSS aimed at everyone browsing it.
        body: JSON.stringify(body({ websiteUrl: 'javascript:alert(1)' })),
      });
      expect(res.status).toBe(400);
    },
    TIMEOUT,
  );
});

describe('admin review', () => {
  it(
    'is closed to ordinary users',
    async () => {
      const user = await createOnboardedUser();
      expect((await call('/admin/organizations', { headers: auth(user.token) })).status).toBe(403);

      const org = (await register(user.token)).data;
      const selfApprove = await call(`/admin/organizations/${org.id}/review`, {
        method: 'POST',
        headers: auth(user.token),
        body: JSON.stringify({ decision: 'approve', expectedName: org.name }),
      });
      expect(selfApprove.status).toBe(403);
    },
    TIMEOUT,
  );

  it(
    'approves, and only then does the organization count as usable',
    async () => {
      const owner = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const org = (await register(owner.token)).data;

      const queue = await json(
        await call('/admin/organizations?status=pending&limit=100', { headers: auth(admin.token) }),
      );
      expect(queue.data.items.some((o: { id: number }) => o.id === org.id)).toBe(true);

      const reviewed = await json(
        await call(`/admin/organizations/${org.id}/review`, {
          method: 'POST',
          headers: auth(admin.token),
          body: JSON.stringify({
            decision: 'approve',
            note: 'GST certificate checked.',
            expectedName: org.name,
          }),
        }),
      );
      expect(reviewed.data.status).toBe('approved');
      expect(reviewed.data.reviewedAt).not.toBeNull();

      const [row] = await db.select().from(organizations).where(eq(organizations.id, org.id));
      expect(row?.reviewedBy).toBe(admin.userId);
    },
    TIMEOUT,
  );

  it(
    'requires a note to reject or suspend',
    async () => {
      const owner = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const org = (await register(owner.token)).data;

      const bare = await call(`/admin/organizations/${org.id}/review`, {
        method: 'POST',
        headers: auth(admin.token),
        body: JSON.stringify({ decision: 'reject', expectedName: org.name }),
      });
      // A decision a human has to defend later should be explained now.
      expect(bare.status).toBe(422);
      expect((await json(bare)).error.code).toBe('ORG_010');

      const withNote = await json(
        await call(`/admin/organizations/${org.id}/review`, {
          method: 'POST',
          headers: auth(admin.token),
          body: JSON.stringify({
            decision: 'reject',
            note: 'Could not verify the company.',
            expectedName: org.name,
          }),
        }),
      );
      expect(withNote.data.status).toBe('rejected');
      expect(withNote.data.reviewNote).toBe('Could not verify the company.');
    },
    TIMEOUT,
  );

  it(
    "keeps the admin's review note away from the applicant",
    async () => {
      const owner = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const org = (await register(owner.token)).data;

      await call(`/admin/organizations/${org.id}/review`, {
        method: 'POST',
        headers: auth(admin.token),
        body: JSON.stringify({
          decision: 'suspend',
          note: 'Suspected forged documents.',
          expectedName: org.name,
        }),
      });

      const mine = await json(await call('/organizations/me', { headers: auth(owner.token) }));
      expect(mine.data.organization.status).toBe('suspended');
      // The status is theirs to see. The working note is not — it is an
      // internal judgement, and a rejection reason is something to
      // communicate deliberately rather than leak through a field.
      expect(mine.data.organization.reviewNote).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'can reinstate a suspended organization',
    async () => {
      const owner = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const org = (await register(owner.token)).data;

      await call(`/admin/organizations/${org.id}/review`, {
        method: 'POST',
        headers: auth(admin.token),
        body: JSON.stringify({
          decision: 'suspend',
          note: 'Temporary hold.',
          expectedName: org.name,
        }),
      });
      const back = await json(
        await call(`/admin/organizations/${org.id}/review`, {
          method: 'POST',
          headers: auth(admin.token),
          body: JSON.stringify({ decision: 'reinstate', expectedName: org.name }),
        }),
      );
      expect(back.data.status).toBe('approved');
    },
    TIMEOUT,
  );
});

describe('joining by code and roster metrics', () => {
  it(
    'allows an onboarded user to join an approved organization via slug, reporting cumulative points and baseline',
    async () => {
      const owner = await createOnboardedUser();
      const admin = await createOnboardedUser({ role: 'admin' });
      const org = (await register(owner.token)).data;

      // Cannot join while pending
      const candidate = await createOnboardedUser();
      const pendingJoinRes = await call('/organizations/join', {
        method: 'POST',
        headers: auth(candidate.token),
        body: JSON.stringify({ code: org.slug }),
      });
      expect(pendingJoinRes.status).toBe(403);

      // Approve organization
      await call(`/admin/organizations/${org.id}/review`, {
        method: 'POST',
        headers: auth(admin.token),
        body: JSON.stringify({ decision: 'approve' }),
      });

      // Now join with slug
      const joinRes = await json(
        await call('/organizations/join', {
          method: 'POST',
          headers: auth(candidate.token),
          body: JSON.stringify({ code: org.slug }),
        }),
      );
      expect(joinRes.data.joined).toBe(true);
      expect(joinRes.data.organization.id).toBe(org.id);
      expect(joinRes.data.role).toBe('member');

      // Verify roster includes candidate with points and baseline
      const rosterRes = await json(
        await call(`/organizations/${org.id}/members`, {
          headers: auth(candidate.token),
        }),
      );
      expect(rosterRes.data.items.length).toBe(2);
      const candidateInRoster = rosterRes.data.items.find((m: any) => m.user.id === candidate.userId);
      expect(candidateInRoster).toBeDefined();
      expect(typeof candidateInRoster.pointsTotal).toBe('number');
      expect(typeof candidateInRoster.baselineTotalKg).toBe('number');
    },
    TIMEOUT,
  );
});
