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
      const org = (await register(owner.token)).data;

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
      // Removing the last owner leaves an organization nobody can administer
      // and nobody can leave — unrecoverable without a DBA.
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('ORG_009');
    },
    TIMEOUT,
  );

  it(
    'will not take a member who already belongs somewhere else',
    async () => {
      const first = await createOnboardedUser();
      const second = await createOnboardedUser();
      const org = (await register(first.token)).data;
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
        body: JSON.stringify({ decision: 'approve' }),
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
          body: JSON.stringify({ decision: 'approve', note: 'GST certificate checked.' }),
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
        body: JSON.stringify({ decision: 'reject' }),
      });
      // A decision a human has to defend later should be explained now.
      expect(bare.status).toBe(422);
      expect((await json(bare)).error.code).toBe('ORG_010');

      const withNote = await json(
        await call(`/admin/organizations/${org.id}/review`, {
          method: 'POST',
          headers: auth(admin.token),
          body: JSON.stringify({ decision: 'reject', note: 'Could not verify the company.' }),
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
        body: JSON.stringify({ decision: 'suspend', note: 'Suspected forged documents.' }),
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
        body: JSON.stringify({ decision: 'suspend', note: 'Temporary hold.' }),
      });
      const back = await json(
        await call(`/admin/organizations/${org.id}/review`, {
          method: 'POST',
          headers: auth(admin.token),
          body: JSON.stringify({ decision: 'reinstate' }),
        }),
      );
      expect(back.data.status).toBe('approved');
    },
    TIMEOUT,
  );
});
