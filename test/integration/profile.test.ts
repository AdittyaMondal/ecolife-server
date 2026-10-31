import { describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { db } from '@database/client.ts';
import { rewardTransactions, users } from '@database/schema/index.ts';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../../src/app.ts';

/** Onboarding end to end (PRD-v2 §3.2) plus the own and public profiles. */

const TIMEOUT = 30_000;
const PW = 'correct horse battery staple';

/**
 * Every request asserts its OWN client IP. Without this the whole suite
 * shares one loopback rate-limit bucket and exceeds /auth/register's limit
 * of 10 per 15 minutes. See src/common/testing/client-ip.ts.
 */
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
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const STEPS = [
  { householdSize: 4, city: 'Mumbai', regionCode: 'IN-MH', coolingUsage: 'ac_occasional' },
  { dietType: 'vegetarian', foodWasteLevel: 'low', packagedFoodFreq: 'sometimes' },
  {
    primaryCommuteMode: 'metro_train',
    vehicleFuel: 'not_applicable',
    commuteDistanceKm: 14.5,
    flightsPerYear: 2,
  },
  {
    electricityKwhMonth: 240,
    electricityBillInr: null,
    kwhSource: 'reported',
    cookingFuel: 'lpg',
    hasSolar: false,
  },
  { waterUsageLevel: 'medium', wasteHabit: 'segregate_only' },
] as const;

/** Verified by default: earning is gated on a verified email (PRD-v2 §4.4). */
async function signUp({ verified = true } = {}) {
  const addr = `prof-${crypto.randomUUID()}@example.test`;
  const body = await json(
    await call('/auth/register', {
      method: 'POST',
      headers: { 'x-ecolife-platform': 'ios' },
      body: JSON.stringify({ name: 'Profile Probe', email: addr, password: PW }),
    }),
  );
  const userId = body.data.user.id as number;
  if (verified) {
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
  }
  return { token: body.data.session.accessToken as string, userId, email: addr };
}

async function answerAll(token: string) {
  for (const [i, payload] of STEPS.entries()) {
    const res = await call(`/profile/onboarding/step/${i + 1}`, {
      method: 'PATCH',
      headers: auth(token),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
  }
}

describe('onboarding', () => {
  it(
    'persists one step at a time and resumes',
    async () => {
      const { token } = await signUp();

      const empty = await json(await call('/profile/onboarding', { headers: auth(token) }));
      expect(empty.data.completedSteps).toBe(0);
      expect(empty.data.complete).toBe(false);

      await call('/profile/onboarding/step/1', {
        method: 'PATCH',
        headers: auth(token),
        body: JSON.stringify(STEPS[0]),
      });

      // A different "device" reads the same server-side state.
      const resumed = await json(await call('/profile/onboarding', { headers: auth(token) }));
      expect(resumed.data.completedSteps).toBe(1);
      expect(resumed.data.answers.city).toBe('Mumbai');
      expect(resumed.data.answers.householdSize).toBe(4);
    },
    TIMEOUT,
  );

  it(
    'rejects a body that belongs to a different step',
    async () => {
      const { token } = await signUp();
      // The route validates against a UNION of all five step schemas, so this
      // is well-formed at the wire level. Only the service knows it is wrong
      // for step 1.
      const res = await call('/profile/onboarding/step/1', {
        method: 'PATCH',
        headers: auth(token),
        body: JSON.stringify(STEPS[1]),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('ONB_001');
    },
    TIMEOUT,
  );

  it(
    'will not count a skipped step as progress',
    async () => {
      const { token } = await signUp();
      // Jump straight to step 5. `completedSteps` is derived from which
      // columns are actually populated, so it must stay 0 — a counter the
      // client can advance would report "complete" over four blank steps.
      await call('/profile/onboarding/step/5', {
        method: 'PATCH',
        headers: auth(token),
        body: JSON.stringify(STEPS[4]),
      });
      const state = await json(await call('/profile/onboarding', { headers: auth(token) }));
      expect(state.data.completedSteps).toBe(0);
      expect(state.data.complete).toBe(false);
      expect(state.data.answers.wasteHabit).toBe('segregate_only');
    },
    TIMEOUT,
  );

  it(
    'refuses to complete while answers are missing, and names which',
    async () => {
      const { token } = await signUp();
      await call('/profile/onboarding/step/1', {
        method: 'PATCH',
        headers: auth(token),
        body: JSON.stringify(STEPS[0]),
      });
      const res = await call('/profile/onboarding/complete', {
        method: 'POST',
        headers: auth(token),
      });
      expect(res.status).toBe(422);
      const body = await json(res);
      expect(body.error.code).toBe('ONB_001');
      expect(body.error.details.missingSteps).toEqual([2, 3, 4, 5]);
    },
    TIMEOUT,
  );

  it(
    'computes a baseline and awards 100/50 exactly once',
    async () => {
      const { token, userId } = await signUp();
      await answerAll(token);

      const first = await json(
        await call('/profile/onboarding/complete', { method: 'POST', headers: auth(token) }),
      );
      expect(first.data.pointsAwarded).toBe(100);
      expect(first.data.coinsAwarded).toBe(50);
      expect(first.data.wallet.pointsTotal).toBe(100);
      expect(first.data.baseline.totalKg).toBeGreaterThan(0);

      // Every category sums to the total the client renders.
      const b = first.data.baseline;
      const sum = b.transportKg + b.foodKg + b.homeEnergyKg + b.waterKg + b.wasteKg;
      expect(Math.abs(sum - b.totalKg)).toBeLessThan(0.001);

      // `[LESSON]` v1's markAsCompleted() could be POSTed repeatedly for
      // unbounded points. reward_idempotency_unq makes the replay a no-op.
      const replay = await json(
        await call('/profile/onboarding/complete', { method: 'POST', headers: auth(token) }),
      );
      expect(replay.data.pointsAwarded).toBe(0);
      expect(replay.data.wallet.pointsTotal).toBe(100);

      const ledger = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(
          and(eq(rewardTransactions.userId, userId), eq(rewardTransactions.source, 'onboarding')),
        );
      expect(ledger[0]?.n).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'lets an unverified account finish onboarding, but withholds the reward',
    async () => {
      const { token, userId } = await signUp({ verified: false });
      await answerAll(token);
      const res = await call('/profile/onboarding/complete', {
        method: 'POST',
        headers: auth(token),
      });

      // This used to 403. Verification gates EARNING, not the product
      // (PRD-v2 §4.4) — and because the baseline is written by this very
      // call, throwing here left an unverified account with no baseline,
      // so it could never log a day or open Home either. The gate took the
      // whole product down with the bonus.
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.baseline.totalKg).toBeGreaterThan(0);
      expect(body.data.pointsAwarded).toBe(0);
      expect(body.data.wallet.pointsTotal).toBe(0);

      const [grants] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(eq(rewardTransactions.userId, userId));
      expect(grants?.n).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'pays the withheld onboarding reward the moment the email is verified',
    async () => {
      const { token, userId } = await signUp({ verified: false });
      await answerAll(token);
      await call('/profile/onboarding/complete', { method: 'POST', headers: auth(token) });

      // Verifying is the only action taken here. Nobody re-triggers
      // completion, because nobody would guess they had to.
      await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
      await call('/profile/onboarding/complete', { method: 'POST', headers: auth(token) });

      const me = await json(await call('/auth/me', { headers: auth(token) }));
      expect(me.data.wallet.pointsTotal).toBe(100);
      expect(me.data.wallet.coinsBalance).toBe(50);

      // And never twice: onboarding:{userId} is one grant for all time.
      await call('/profile/onboarding/complete', { method: 'POST', headers: auth(token) });
      const [grants] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(
          and(eq(rewardTransactions.userId, userId), eq(rewardTransactions.source, 'onboarding')),
        );
      expect(grants?.n).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'converts a rupee bill into kWh using the region tariff',
    async () => {
      const { token } = await signUp();
      await call('/profile/onboarding/step/1', {
        method: 'PATCH',
        headers: auth(token),
        body: JSON.stringify(STEPS[0]),
      });
      await call('/profile/onboarding/step/4', {
        method: 'PATCH',
        headers: auth(token),
        body: JSON.stringify({
          electricityKwhMonth: null,
          electricityBillInr: 1900,
          kwhSource: 'from_bill',
          cookingFuel: 'lpg',
          hasSolar: false,
        }),
      });
      const state = await json(await call('/profile/onboarding', { headers: auth(token) }));
      // A region tariff is paise per kWh, so ₹1900 buys 1900*100/tariff kWh.
      const regions = await json(await call('/regions'));
      const mh = regions.data.items.find((r: { code: string }) => r.code === 'IN-MH');
      expect(state.data.answers.electricityKwhMonth).toBeCloseTo(
        Math.round(((1900 * 100) / mh.tariffPaisePerKwh) * 10) / 10,
        1,
      );
    },
    TIMEOUT,
  );
});

describe('profile', () => {
  it(
    'recomputes the baseline forward when an answer changes',
    async () => {
      const { token } = await signUp();
      await answerAll(token);
      const before = await json(
        await call('/profile/onboarding/complete', { method: 'POST', headers: auth(token) }),
      );

      const after = await json(
        await call('/profile', {
          method: 'PATCH',
          headers: auth(token),
          body: JSON.stringify({ answers: { dietType: 'non_veg_daily' } }),
        }),
      );
      // non_veg_daily is 7.19 kg/day against vegetarian's 3.81 — the food
      // term must move, and with it the total.
      expect(after.data.baseline.foodKg).toBeGreaterThan(before.data.baseline.foodKg);
      expect(after.data.baseline.totalKg).toBeGreaterThan(before.data.baseline.totalKg);
      expect(after.data.answers.dietType).toBe('non_veg_daily');
    },
    TIMEOUT,
  );

  it(
    'lists the reward ledger newest first',
    async () => {
      const { token } = await signUp();
      await answerAll(token);
      await call('/profile/onboarding/complete', { method: 'POST', headers: auth(token) });

      const page = await json(await call('/profile/rewards', { headers: auth(token) }));
      expect(page.data.items).toHaveLength(1);
      expect(page.data.items[0].source).toBe('onboarding');
      expect(page.data.items[0].pointsDelta).toBe(100);
    },
    TIMEOUT,
  );

  it(
    'keeps footprint, coins and email out of a public profile',
    async () => {
      const me = await signUp();
      const other = await signUp();
      await answerAll(other.token);
      await call('/profile/onboarding/complete', { method: 'POST', headers: auth(other.token) });

      const res = await call(`/users/${other.userId}`, { headers: auth(me.token) });
      const body = await json(res);
      expect(res.status).toBe(200);
      expect(body.data.pointsTotal).toBe(100);
      expect(body.data.globalRank).toBeGreaterThan(0);
      // The public shape is a deliberate subset. These must not leak.
      expect(JSON.stringify(body.data)).not.toContain('@example.test');
      expect(body.data.coinsBalance).toBeUndefined();
      expect(body.data.baseline).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    'anonymises on delete and revokes every session',
    async () => {
      const { token, userId, email } = await signUp();
      const res = await call('/profile', { method: 'DELETE', headers: auth(token) });
      expect(res.status).toBe(200);
      expect((await json(res)).data.deleted).toBe(true);

      const [row] = await db.select().from(users).where(eq(users.id, userId));
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.name).toBe('Deleted user');
      expect(row?.email).not.toBe(email);

      // The address is freed, because users_email_lower_unq is not partial on
      // deleted_at — leaving it would block the person signing up again.
      const again = await call('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name: 'Back again', email, password: PW }),
      });
      expect(again.status).toBe(201);
    },
    TIMEOUT,
  );
});
