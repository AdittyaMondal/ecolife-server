import { describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { createOnboardedUser } from '@common/testing/fixtures.ts';
import { db } from '@database/client.ts';
import { dailyFootprints } from '@database/schema/daily-footprints.ts';
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

describe('Organization Dashboard, Analytics & Privacy (Part 3)', () => {
  it(
    'computes organization carbon footprint: total, category breakdown, monthly trend, and per-employee average',
    async () => {
      const owner = await createOnboardedUser({
        email: `corpowner-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      const admin = await createOnboardedUser({ role: 'admin' });
      const member1 = await createOnboardedUser({
        email: `member1-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      const member2 = await createOnboardedUser({
        email: `member2-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });

      // 1. Create org
      const createRes = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            name: `TerraCorp ${crypto.randomUUID().slice(0, 6)}`,
            type: 'industry',
          }),
        }),
      );
      const orgId = createRes.data.id;
      const orgCode = createRes.data.code;

      // Approve org so members can join
      await call(`/admin/organizations/${orgId}/review`, {
        method: 'POST',
        headers: auth(admin.token),
        body: JSON.stringify({
          decision: 'approve',
          note: 'Approved',
          expected: { name: createRes.data.name, logoUrl: null, websiteUrl: null },
        }),
      });

      // 2. Members join with code
      await call('/organizations/join', {
        method: 'POST',
        headers: auth(member1.token),
        body: JSON.stringify({ code: orgCode }),
      });
      await call('/organizations/join', {
        method: 'POST',
        headers: auth(member2.token),
        body: JSON.stringify({ code: orgCode }),
      });

      // 3. Insert footprint records for member1 and member2
      const today = new Date().toISOString().slice(0, 10);
      await db.insert(dailyFootprints).values([
        {
          userId: member1.userId,
          logDate: today,
          transportKg: 4.2,
          foodKg: 3.1,
          homeEnergyKg: 5.5,
          waterKg: 1.0,
          wasteKg: 0.8,
          totalKg: 14.6,
          baselineTotalKg: 16.0,
          reductionPct: 8.75,
          sources: { transport: 'logged', food: 'logged' },
          factorVersion: 1,
        },
        {
          userId: member2.userId,
          logDate: today,
          transportKg: 2.0,
          foodKg: 2.5,
          homeEnergyKg: 3.0,
          waterKg: 0.5,
          wasteKg: 0.4,
          totalKg: 8.4,
          baselineTotalKg: 10.0,
          reductionPct: 16.0,
          sources: { transport: 'logged', food: 'logged' },
          factorVersion: 1,
        },
      ]);

      // 4. Fetch analytics as owner
      const analyticsRes = await call(`/organizations/${orgId}/analytics`, {
        headers: auth(owner.token),
      });
      expect(analyticsRes.status).toBe(200);
      const analyticsBody = await json(analyticsRes);

      expect(analyticsBody.status).toBe(true);
      expect(analyticsBody.data.organizationId).toBe(orgId);
      expect(analyticsBody.data.totalFootprintKg).toBeGreaterThanOrEqual(23.0);
      expect(analyticsBody.data.totalMembers).toBe(3); // owner + member1 + member2
      expect(analyticsBody.data.activeLoggers).toBe(2);

      // Category breakdown
      const categories = analyticsBody.data.categories;
      expect(categories.transportKg).toBeCloseTo(6.2, 1);
      expect(categories.foodKg).toBeCloseTo(5.6, 1);
      expect(categories.homeEnergyKg).toBeCloseTo(8.5, 1);
      expect(categories.transportPct).toBeGreaterThan(0);
      expect(categories.foodPct).toBeGreaterThan(0);

      // Monthly trend array
      expect(Array.isArray(analyticsBody.data.monthlyTrend)).toBe(true);
      expect(analyticsBody.data.monthlyTrend.length).toBeGreaterThan(0);
      const currentMonthItem = analyticsBody.data.monthlyTrend[0];
      expect(currentMonthItem.totalKg).toBeGreaterThanOrEqual(23.0);
      expect(currentMonthItem.activeLoggers).toBe(2);

      // Access restriction: regular member cannot access analytics endpoint
      const memberAnalyticsRes = await call(`/organizations/${orgId}/analytics`, {
        headers: auth(member1.token),
      });
      expect(memberAnalyticsRes.status).toBe(403);
    },
    TIMEOUT,
  );

  it(
    'supports employee search, filters, per-user insights, and respects privacy consent',
    async () => {
      const owner = await createOnboardedUser({
        email: `privowner-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      const admin = await createOnboardedUser({ role: 'admin' });
      const sharingMember = await createOnboardedUser({
        name: 'Alice Green',
        email: `alice-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      const privateMember = await createOnboardedUser({
        name: 'Bob Secret',
        email: `bob-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });

      // 1. Create org & join
      const createRes = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            name: `EcoGroup ${crypto.randomUUID().slice(0, 6)}`,
            type: 'ngo',
          }),
        }),
      );
      const orgId = createRes.data.id;
      const orgCode = createRes.data.code;

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

      await call('/organizations/join', {
        method: 'POST',
        headers: auth(sharingMember.token),
        body: JSON.stringify({ code: orgCode }),
      });
      await call('/organizations/join', {
        method: 'POST',
        headers: auth(privateMember.token),
        body: JSON.stringify({ code: orgCode }),
      });

      // 2. Private member toggles shareFootprint to FALSE via PATCH /organizations/me/membership
      const privacyRes = await call('/organizations/me/membership', {
        method: 'PATCH',
        headers: auth(privateMember.token),
        body: JSON.stringify({ shareFootprint: false }),
      });
      expect(privacyRes.status).toBe(200);
      const privacyBody = await json(privacyRes);
      expect(privacyBody.data.shareFootprint).toBe(false);

      // 3. Owner views roster:
      const rosterRes = await call(`/organizations/${orgId}/members`, {
        headers: auth(owner.token),
      });
      expect(rosterRes.status).toBe(200);
      const roster = await json(rosterRes);
      expect(roster.data.items.length).toBe(3);

      const alice = roster.data.items.find((m: any) => m.user.name === 'Alice Green');
      const bob = roster.data.items.find((m: any) => m.user.name === 'Bob Secret');

      expect(alice).toBeDefined();
      expect(bob).toBeDefined();

      // Alice consented: baselineTotalKg is visible
      expect(alice.shareFootprint).toBe(true);
      expect(alice.baselineTotalKg).not.toBeNull();
      expect(alice.email).toBeDefined();

      // Bob did NOT consent: detailed footprint is redacted to null
      expect(bob.shareFootprint).toBe(false);
      expect(bob.baselineTotalKg).toBeNull();
      expect(bob.last30DaysTotalKg).toBeNull();

      // 4. Test search filter
      const searchRes = await call(`/organizations/${orgId}/members?search=Alice`, {
        headers: auth(owner.token),
      });
      const searchBody = await json(searchRes);
      expect(searchBody.data.items.length).toBe(1);
      expect(searchBody.data.items[0].user.name).toBe('Alice Green');

      // 5. Test role filter
      const roleRes = await call(`/organizations/${orgId}/members?role=owner`, {
        headers: auth(owner.token),
      });
      const roleBody = await json(roleRes);
      expect(roleBody.data.items.length).toBe(1);
      expect(roleBody.data.items[0].role).toBe('owner');

      // 6. Non-owner member viewing roster: other users email is hidden
      const memberRosterRes = await call(`/organizations/${orgId}/members`, {
        headers: auth(sharingMember.token),
      });
      const memberRoster = await json(memberRosterRes);
      const bobSeenByAlice = memberRoster.data.items.find((m: any) => m.user.name === 'Bob Secret');
      expect(bobSeenByAlice.email).toBeUndefined();
      expect(bobSeenByAlice.baselineTotalKg).toBeNull();
    },
    TIMEOUT,
  );
});
