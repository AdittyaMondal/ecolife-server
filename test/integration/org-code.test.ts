import { describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { createOnboardedUser } from '@common/testing/fixtures.ts';
import { app } from '../../src/app.ts';

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
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  data: any;
  error: { code: string; message: string; details: unknown };
};

const json = async (r: Response) => (await r.json()) as unknown as Envelope;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('Organization Code & User Linking (Part 2)', () => {
  it(
    'generates a 6-digit code on creation and supports regeneration by owner',
    async () => {
      const owner = await createOnboardedUser({ email: `orgowner-${crypto.randomUUID().slice(0, 6)}@example.test` });

      // Create an organization
      const createRes = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            name: `Acme Sustainability ${crypto.randomUUID().slice(0, 6)}`,
            type: 'industry',
          }),
        }),
      );

      expect(createRes.status).toBe(true);
      const code1 = createRes.data.code;
      expect(typeof code1).toBe('string');
      expect(code1).toMatch(/^\d{6}$/);

      // Regenerate code
      const regenRes = await json(
        await call('/organizations/me/code/regenerate', {
          method: 'POST',
          headers: auth(owner.token),
        }),
      );

      expect(regenRes.status).toBe(true);
      const code2 = regenRes.data.code;
      expect(typeof code2).toBe('string');
      expect(code2).toMatch(/^\d{6}$/);
      expect(code2).not.toBe(code1);

      // Verify GET /organizations/me reflects the new code
      const meRes = await json(
        await call('/organizations/me', {
          headers: auth(owner.token),
        }),
      );
      expect(meRes.data.organization.code).toBe(code2);
    },
    TIMEOUT,
  );

  it(
    'validates code lookup: rejects missing/pending and accepts approved organizations',
    async () => {
      const owner = await createOnboardedUser({ email: `orgowner2-${crypto.randomUUID().slice(0, 6)}@example.test` });
      const admin = await createOnboardedUser({ role: 'admin' });

      // 1. Missing code lookup
      const missingRes = await call('/organizations/lookup?code=999999');
      expect(missingRes.status).toBe(404);
      const missingBody = await json(missingRes);
      expect(missingBody.error.code).toBe('ORG_007');

      // 2. Pending organization lookup
      const createRes = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            name: `Pending Corp ${crypto.randomUUID().slice(0, 6)}`,
            type: 'industry',
          }),
        }),
      );
      const pendingCode = createRes.data.code;

      const pendingLookup = await call(`/organizations/lookup?code=${pendingCode}`);
      expect(pendingLookup.status).toBe(403);
      const pendingBody = await json(pendingLookup);
      expect(pendingBody.error.code).toBe('ORG_002');

      // 3. Admin approves organization
      const approveRes = await call(`/admin/organizations/${createRes.data.id}/review`, {
        method: 'POST',
        headers: auth(admin.token),
        body: JSON.stringify({
          decision: 'approve',
          note: 'Approved for test',
          expected: {
            name: createRes.data.name,
            logoUrl: null,
            websiteUrl: null,
          },
        }),
      });
      expect(approveRes.status).toBe(200);

      // 4. Approved organization lookup succeeds
      const approvedLookup = await call(`/organizations/lookup?code=${pendingCode}`);
      expect(approvedLookup.status).toBe(200);
      const approvedBody = await json(approvedLookup);
      expect(approvedBody.status).toBe(true);
      expect(approvedBody.data.valid).toBe(true);
      expect(approvedBody.data.name).toBe(createRes.data.name);
      expect(approvedBody.data.code).toBe(pendingCode);
    },
    TIMEOUT,
  );

  it(
    'links user on signup with valid code, rejects invalid/pending codes',
    async () => {
      const owner = await createOnboardedUser({ email: `orgowner3-${crypto.randomUUID().slice(0, 6)}@example.test` });
      const admin = await createOnboardedUser({ role: 'admin' });

      // Create and approve org
      const createRes = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            name: `Linkable Corp ${crypto.randomUUID().slice(0, 6)}`,
            type: 'industry',
          }),
        }),
      );
      const orgId = createRes.data.id;
      const orgCode = createRes.data.code;

      // Fail signup with invalid code
      const badCodeRes = await call('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Jane Doe',
          email: `janedoe-${crypto.randomUUID().slice(0, 6)}@example.test`,
          password: 'Password123!',
          organizationCode: '000000',
        }),
      });
      expect(badCodeRes.status).toBe(404);
      expect((await json(badCodeRes)).error.code).toBe('ORG_007');

      // Fail signup while org is still pending
      const pendingSignupRes = await call('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Jane Doe',
          email: `janedoe-${crypto.randomUUID().slice(0, 6)}@example.test`,
          password: 'Password123!',
          organizationCode: orgCode,
        }),
      });
      expect(pendingSignupRes.status).toBe(403);
      expect((await json(pendingSignupRes)).error.code).toBe('ORG_002');

      // Approve org
      await call(`/admin/organizations/${orgId}/review`, {
        method: 'POST',
        headers: auth(admin.token),
        body: JSON.stringify({
          decision: 'approve',
          note: 'Approved',
          expected: { name: createRes.data.name, logoUrl: null, websiteUrl: null },
        }),
      });

      // Succeed signup with valid approved org code
      const goodEmail = `member-${crypto.randomUUID().slice(0, 6)}@example.test`;
      const signupRes = await call('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Member User',
          email: goodEmail,
          password: 'Password123!',
          organizationCode: orgCode,
        }),
      });
      expect(signupRes.status).toBe(201);
      const signupBody = await json(signupRes);
      expect(signupBody.data.user.organization.id).toBe(orgId);
      expect(signupBody.data.user.organization.code).toBe(orgCode);
      expect(signupBody.data.user.organization.role).toBe('member');

      // Verify GET /auth/me reflects membership
      const meRes = await json(
        await call('/auth/me', {
          headers: auth(signupBody.data.session.accessToken),
        }),
      );
      expect(meRes.data.organization.id).toBe(orgId);
      expect(meRes.data.organization.role).toBe('member');

      // Verify leaving organization via DELETE /organizations/me/membership
      const leaveRes = await call('/organizations/me/membership', {
        method: 'DELETE',
        headers: auth(signupBody.data.session.accessToken),
      });
      expect(leaveRes.status).toBe(200);
      expect((await json(leaveRes)).data.left).toBe(true);

      // Verify GET /auth/me now has organization: null
      const meAfterLeave = await json(
        await call('/auth/me', {
          headers: auth(signupBody.data.session.accessToken),
        }),
      );
      expect(meAfterLeave.data.organization).toBeNull();

      // User joins back via POST /organizations/join with code
      const joinRes = await call('/organizations/join', {
        method: 'POST',
        headers: auth(signupBody.data.session.accessToken),
        body: JSON.stringify({ code: orgCode }),
      });
      expect(joinRes.status).toBe(200);
      const joinBody = await json(joinRes);
      expect(joinBody.data.joined).toBe(true);
      expect(joinBody.data.organization.id).toBe(orgId);
      expect(joinBody.data.role).toBe('member');
    },
    TIMEOUT,
  );
});
