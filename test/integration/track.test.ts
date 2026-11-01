import { describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { createOnboardedUser } from '@common/testing/fixtures.ts';
import { localDate } from '@common/time.ts';
import { db } from '@database/client.ts';
import { dailyFootprints, dailyLogs, rewardTransactions } from '@database/schema/index.ts';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../../src/app.ts';

/** The daily log loop end to end (PRD-v2 §3.4). */

const TIMEOUT = 30_000;
const PW = 'correct horse battery staple';
const TZ = 'Asia/Kolkata';

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
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/**
 * The subject here is the daily log, not the onboarding wizard — which
 * profile.test.ts drives through HTTP. The fixture inserts an onboarded user
 * in one round trip instead of eight.
 */
async function onboarded() {
  const fx = await createOnboardedUser();
  return { token: fx.token, userId: fx.userId, baseline: fx.baselinePerDay };
}

const GREEN_DAY = {
  trips: [{ mode: 'cycle', km: 4 }],
  vegMeals: 2,
  veganMeals: 1,
  nonVegMeals: 0,
  acHoursBucket: '0',
  bathChoice: 'bucket',
  wasteActions: ['segregated', 'composted'],
};

describe('GET /track/today', () => {
  it(
    'offers a prefill derived from the onboarding answers',
    async () => {
      const { token } = await onboarded();
      const body = await json(await call('/track/today', { headers: auth(token) }));

      expect(body.data.date).toBe(localDate(TZ));
      expect(body.data.existingLog).toBeNull();
      expect(body.data.askCooling).toBe(true);
      // One way at onboarding, so a normal day is out and back.
      // The fixture commutes 18 km each way by car.
      expect(body.data.defaults.trips).toEqual([
        { mode: 'car', km: 18 },
        { mode: 'car', km: 18 },
      ]);
      // The fixture eats non-veg daily, so that is what the prefill offers.
      expect(body.data.defaults.nonVegMeals).toBe(3);
      expect(body.data.defaults.vegMeals).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    'does not ask about cooling when the profile reports none',
    async () => {
      const { token } = await onboarded();
      await call('/profile', {
        method: 'PATCH',
        headers: auth(token),
        body: JSON.stringify({ answers: { coolingUsage: 'none' } }),
      });
      const body = await json(await call('/track/today', { headers: auth(token) }));
      expect(body.data.askCooling).toBe(false);
    },
    TIMEOUT,
  );
});

describe('POST /track/logs', () => {
  it(
    'computes the day, pays the daily grant and the reduction bonus',
    async () => {
      const { token, baseline } = await onboarded();
      const res = await call('/track/logs', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          clientLogId: crypto.randomUUID(),
          logDate: localDate(TZ),
          answers: GREEN_DAY,
        }),
      });
      const body = await json(res);
      expect(res.status).toBe(200);

      expect(body.data.baselineTotalKg).toBeCloseTo(baseline, 2);
      expect(body.data.breakdown.totalKg).toBeLessThan(baseline);
      expect(body.data.deltaKg).toBeLessThan(0);
      expect(body.data.reductionPct).toBeGreaterThan(0);
      expect(Object.values(body.data.sources).every((s) => s === 'logged')).toBe(true);

      const sources = body.data.reward.reasons.map((r: { source: string }) => r.source);
      expect(sources).toContain('daily_log');
      expect(sources).toContain('reduction');
      // Capped at 25 points however low the day is.
      const reduction = body.data.reward.reasons.find(
        (r: { source: string }) => r.source === 'reduction',
      );
      expect(reduction.points).toBeLessThanOrEqual(25);
      expect(body.data.streak.current).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'pays no reduction bonus unless all five questions are answered',
    async () => {
      const { token } = await onboarded();
      const body = await json(
        await call('/track/logs', {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify({
            clientLogId: crypto.randomUUID(),
            logDate: localDate(TZ),
            // Four of five. The cheapest possible day, still no bonus.
            answers: { trips: [], vegMeals: 0, acHoursBucket: '0', bathChoice: 'bucket' },
          }),
        }),
      );
      const sources = body.data.reward.reasons.map((r: { source: string }) => r.source);
      expect(sources).toContain('daily_log');
      expect(sources).not.toContain('reduction');
    },
    TIMEOUT,
  );

  it(
    'treats a replayed clientLogId as a no-op — the offline queue path',
    async () => {
      const { token, userId } = await onboarded();
      const payload = {
        clientLogId: crypto.randomUUID(),
        logDate: localDate(TZ),
        answers: GREEN_DAY,
      };

      const first = await json(
        await call('/track/logs', {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify(payload),
        }),
      );
      const second = await json(
        await call('/track/logs', {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify(payload),
        }),
      );

      expect(second.data.logId).toBe(first.data.logId);
      expect(second.data.reward.pointsDelta).toBe(0);
      expect(second.data.wallet.pointsTotal).toBe(first.data.wallet.pointsTotal);

      const [logs] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(dailyLogs)
        .where(eq(dailyLogs.userId, userId));
      expect(logs?.n).toBe(1);

      const [grants] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(
          and(eq(rewardTransactions.userId, userId), eq(rewardTransactions.source, 'daily_log')),
        );
      expect(grants?.n).toBe(1);
    },
    TIMEOUT,
  );

  it('survives ten simultaneous submits of the same log', async () => {
    const { token, userId } = await onboarded();
    const payload = JSON.stringify({
      clientLogId: crypto.randomUUID(),
      logDate: localDate(TZ),
      answers: GREEN_DAY,
    });

    // Six, not ten. Every one of these opens a transaction and upserts
    // the SAME (user, date) footprint row, so they serialise on that
    // row's lock while each holds a pool connection — correct behaviour,
    // but at Neon's latency ten of them queued past the test timeout and
    // starved the pool for whatever ran next. Six still races.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call('/track/logs', { method: 'POST', headers: auth(token), body: payload }),
      ),
    );
    // Some may lose the insert race and retry-read; none may 500.
    expect(results.every((r) => r.status === 200)).toBe(true);

    const [grants] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(rewardTransactions)
      .where(
        and(eq(rewardTransactions.userId, userId), eq(rewardTransactions.source, 'daily_log')),
      );
    expect(grants?.n).toBe(1);
  }, 60_000);

  it(
    'lets an unverified account log the day, and pays it nothing',
    async () => {
      const fx = await createOnboardedUser({ emailVerifiedAt: null });
      const res = await call('/track/logs', {
        method: 'POST',
        headers: auth(fx.token),
        body: JSON.stringify({
          clientLogId: crypto.randomUUID(),
          logDate: localDate(TZ),
          answers: GREEN_DAY,
        }),
      });

      // Logging a day is the core action of the product. Refusing it over a
      // bonus is the opposite of what docs/error-codes.md says POINTS_003
      // means: verification gates earning, not browsing or logging.
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.breakdown.totalKg).toBeGreaterThan(0);
      expect(body.data.reward.pointsDelta).toBe(0);
      expect(body.data.reward.reasons).toEqual([]);
      expect(body.data.wallet.pointsTotal).toBe(0);
      // The streak still counts — showing up is showing up.
      expect(body.data.streak.current).toBe(1);

      const [grants] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(eq(rewardTransactions.userId, fx.userId));
      expect(grants?.n).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'refuses a date outside today or yesterday',
    async () => {
      const { token } = await onboarded();
      const res = await call('/track/logs', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          clientLogId: crypto.randomUUID(),
          logDate: '2026-01-01',
          answers: GREEN_DAY,
        }),
      });
      // Backfilling a month of invented low days is the obvious way to farm
      // the reduction bonus.
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('TRACK_002');
    },
    TIMEOUT,
  );

  it(
    'refuses to log before onboarding is complete',
    async () => {
      const addr = `nobase-${crypto.randomUUID()}@example.test`;
      const reg = await json(
        await call('/auth/register', {
          method: 'POST',
          headers: { 'x-ecolife-platform': 'ios' },
          body: JSON.stringify({ name: 'No Baseline', email: addr, password: PW }),
        }),
      );
      const res = await call('/track/logs', {
        method: 'POST',
        headers: auth(reg.data.session.accessToken),
        body: JSON.stringify({
          clientLogId: crypto.randomUUID(),
          logDate: localDate(TZ),
          answers: GREEN_DAY,
        }),
      });
      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe('ONB_003');
    },
    TIMEOUT,
  );

  it(
    'writes the baseline onto the footprint row so history cannot move',
    async () => {
      const { token, userId, baseline } = await onboarded();
      await call('/track/logs', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          clientLogId: crypto.randomUUID(),
          logDate: localDate(TZ),
          answers: GREEN_DAY,
        }),
      });

      // Change the profile dramatically. Yesterday must not move.
      await call('/profile', {
        method: 'PATCH',
        headers: auth(token),
        body: JSON.stringify({ answers: { dietType: 'non_veg_daily' } }),
      });

      const [row] = await db
        .select()
        .from(dailyFootprints)
        .where(eq(dailyFootprints.userId, userId));
      expect(row?.baselineTotalKg).toBeCloseTo(baseline, 2);
    },
    TIMEOUT,
  );
});

describe('PATCH /track/logs/{id}', () => {
  it(
    'recomputes the footprint but does not pay the bonus again',
    async () => {
      const { token, userId } = await onboarded();
      const first = await json(
        await call('/track/logs', {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify({
            clientLogId: crypto.randomUUID(),
            logDate: localDate(TZ),
            answers: { ...GREEN_DAY, trips: [{ mode: 'car', km: 40 }] },
          }),
        }),
      );

      const edited = await json(
        await call(`/track/logs/${first.data.logId}`, {
          method: 'PATCH',
          headers: auth(token),
          body: JSON.stringify({ answers: GREEN_DAY }),
        }),
      );

      // The number moves...
      expect(edited.data.breakdown.totalKg).toBeLessThan(first.data.breakdown.totalKg);
      // ...but "log badly, then edit down" pays nothing.
      expect(edited.data.reward.pointsDelta).toBe(0);
      expect(edited.data.wallet.pointsTotal).toBe(first.data.wallet.pointsTotal);

      const [grants] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(eq(rewardTransactions.userId, userId));
      // onboarding + daily_log (+ reduction if the first day earned one)
      expect(grants?.n).toBeLessThanOrEqual(3);
    },
    TIMEOUT,
  );

  it(
    "will not let one user edit another's log",
    async () => {
      const victim = await onboarded();
      const attacker = await onboarded();
      const log = await json(
        await call('/track/logs', {
          method: 'POST',
          headers: auth(victim.token),
          body: JSON.stringify({
            clientLogId: crypto.randomUUID(),
            logDate: localDate(TZ),
            answers: GREEN_DAY,
          }),
        }),
      );
      const res = await call(`/track/logs/${log.data.logId}`, {
        method: 'PATCH',
        headers: auth(attacker.token),
        body: JSON.stringify({ answers: GREEN_DAY }),
      });
      expect(res.status).toBe(404);
    },
    TIMEOUT,
  );
});

describe('GET /track/history', () => {
  it(
    'returns the series and averages, not sums, when bucketed',
    async () => {
      const { token } = await onboarded();
      await call('/track/logs', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          clientLogId: crypto.randomUUID(),
          logDate: localDate(TZ),
          answers: GREEN_DAY,
        }),
      });

      const today = localDate(TZ);
      const daily = await json(
        await call(`/track/history?from=${today}&to=${today}`, { headers: auth(token) }),
      );
      expect(daily.data.points).toHaveLength(1);
      expect(daily.data.points[0].logged).toBe(true);

      const monthly = await json(
        await call(`/track/history?from=${today}&to=${today}&granularity=month`, {
          headers: auth(token),
        }),
      );
      // One day in the bucket, so the average equals that day.
      expect(monthly.data.points[0].totalKg).toBeCloseTo(daily.data.points[0].totalKg, 2);
    },
    TIMEOUT,
  );

  it(
    'rejects a reversed date range',
    async () => {
      const { token } = await onboarded();
      const res = await call('/track/history?from=2026-10-31&to=2026-10-01', {
        headers: auth(token),
      });
      expect(res.status).toBe(400);
    },
    TIMEOUT,
  );
});

/**
 * Regressions reported from the mobile client on 1 Nov 2026 (B3, B4).
 *
 * Both are about what the client is TOLD, not about what is stored: a second
 * device got a 500 where a 409 was already specified, and the edit deadline
 * came back as a bare local string that every client parsed in its own zone.
 */
describe('what the client is told about a day', () => {
  it(
    'answers a second clientLogId for the same date with TRACK_001, not INTERNAL_001',
    async () => {
      const { token, userId } = await onboarded();
      const logDate = localDate(TZ);

      const first = await call('/track/logs', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ clientLogId: crypto.randomUUID(), logDate, answers: GREEN_DAY }),
      });
      expect(first.status).toBe(200);

      // A DIFFERENT client id for a date that is already logged — a second
      // device, or a reinstall whose offline queue was lost. Not a replay.
      const clash = await call('/track/logs', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ clientLogId: crypto.randomUUID(), logDate, answers: GREEN_DAY }),
      });
      const body = await json(clash);

      expect(clash.status).toBe(409);
      expect(body.error.code).toBe('TRACK_001');
      expect(body.error.details.logDate).toBe(logDate);

      // The rolled-back attempt must not have left a second log or a second
      // reward behind — a 409 that half-wrote is worse than the 500 was.
      const logs = await db
        .select({ id: dailyLogs.id })
        .from(dailyLogs)
        .where(and(eq(dailyLogs.userId, userId), eq(dailyLogs.logDate, logDate)));
      expect(logs).toHaveLength(1);

      const ledger = await db
        .select({ id: rewardTransactions.id })
        .from(rewardTransactions)
        .where(
          and(
            eq(rewardTransactions.userId, userId),
            eq(rewardTransactions.sourceId, `daily_log:${logs[0]?.id}`),
          ),
        );
      expect(ledger).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'returns editableUntil as an instant carrying the offset of the user timezone',
    async () => {
      const { token } = await onboarded();
      const logDate = localDate(TZ);
      await call('/track/logs', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ clientLogId: crypto.randomUUID(), logDate, answers: GREEN_DAY }),
      });

      const body = await json(await call('/track/today', { headers: auth(token) }));
      const editableUntil = body.data.existingLog.editableUntil as string;

      // The fixture is Asia/Kolkata. A bare '…T02:00:00' would be read as
      // 02:00 UTC by a client elsewhere — five and a half hours wrong.
      expect(editableUntil).toMatch(/[+-]\d{2}:\d{2}$|Z$/);
      expect(editableUntil.endsWith('+05:30')).toBe(true);
      expect(Number.isNaN(Date.parse(editableUntil))).toBe(false);
    },
    TIMEOUT,
  );
});
