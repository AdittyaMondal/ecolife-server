import { describe, expect, it } from 'bun:test';
import { award } from '@common/rewards/rewards.ts';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { createOnboardedUser } from '@common/testing/fixtures.ts';
import { localDate } from '@common/time.ts';
import { db } from '@database/client.ts';
import {
  dailyFootprints,
  goals,
  lifestyleProfiles,
  rewardTransactions,
  users,
} from '@database/schema/index.ts';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../../src/app.ts';

/** Goals (PRD-v2 §6.4), the leaderboard (§6.7) and the Home aggregate (§6.2). */

const TIMEOUT = 30_000;
const TZ = 'Asia/Kolkata';

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
 * The subject of these tests is goals, ranking and aggregation — not the
 * onboarding wizard, which profile.test.ts already drives through HTTP. The
 * fixture inserts an onboarded user in one round trip instead of eight.
 */
const onboarded = () => createOnboardedUser();

describe('goals', () => {
  it(
    'freezes the target from a baseline snapshot, not from the running total',
    async () => {
      const { token, baselinePerDay } = await onboarded();
      const body = await json(
        await call('/goals', {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify({
            type: 'reduce_percent',
            period: 'month',
            reducePercent: 15,
            startDate: localDate(TZ),
          }),
        }),
      );

      // `[LESSON]` v1 compared actual against `actual x (1 - p/100)`, which is
      // false for every p > 0 — percentage goals could never be achieved. The
      // target must come from the baseline, computed once.
      expect(body.data.baselineKgTotal).toBeCloseTo(baselinePerDay * 30, 1);
      expect(body.data.targetKgTotal).toBeCloseTo(baselinePerDay * 0.85 * 30, 1);
      expect(body.data.targetKgTotal).toBeLessThan(body.data.baselineKgTotal);
      expect(body.data.status).toBe('active');
    },
    TIMEOUT,
  );

  it(
    'allows only one active goal',
    async () => {
      const { token } = await onboarded();
      const make = () =>
        call('/goals', {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify({
            type: 'reduce_percent',
            period: 'week',
            reducePercent: 10,
            startDate: localDate(TZ),
          }),
        });

      expect((await make()).status).toBe(201);
      const second = await make();
      expect(second.status).toBe(409);
      expect((await json(second)).error.code).toBe('GOAL_001');
    },
    TIMEOUT,
  );

  it(
    'refuses a target nobody could meet',
    async () => {
      const { token } = await onboarded();
      const res = await call('/goals', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          type: 'absolute_cap',
          period: 'week',
          capKgPerDay: 0.5,
          startDate: localDate(TZ),
        }),
      });
      // Below MIN_PLAUSIBLE_KG. Raising it silently would be deciding for the
      // user what they meant.
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('GOAL_002');
    },
    TIMEOUT,
  );

  it(
    'requires the matching field for the goal type',
    async () => {
      const { token } = await onboarded();
      const res = await call('/goals', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ type: 'absolute_cap', period: 'week', startDate: localDate(TZ) }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('GOAL_003');
    },
    TIMEOUT,
  );

  it(
    'charges unlogged elapsed days at baseline, so silence is not a win',
    async () => {
      const { token, userId } = await onboarded();
      const created = await json(
        await call('/goals', {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify({
            type: 'reduce_percent',
            period: 'week',
            reducePercent: 20,
            startDate: localDate(TZ),
          }),
        }),
      );

      // Backdate the window so six days have elapsed with nothing logged,
      // while the goal is still running. The API refuses a past startDate
      // (GOAL_005), which is why this is set up through the database.
      const start = new Date();
      start.setUTCDate(start.getUTCDate() - 6);
      const end = new Date();
      end.setUTCDate(end.getUTCDate() + 1);
      await db
        .update(goals)
        .set({
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
        })
        .where(eq(goals.id, created.data.id));

      const progress = await json(
        await call(`/goals/${created.data.id}/progress`, { headers: auth(token) }),
      );
      // Seven elapsed days at baseline, none logged. If missing days counted
      // as zero this would read 0 and the goal would look perfect.
      expect(progress.data.actualKgTotal).toBeGreaterThan(0);
      expect(progress.data.daysElapsed).toBeGreaterThanOrEqual(6);
      expect(progress.data.onTrack).toBe(false);

      // Nothing was awarded: the goal has not ended.
      const [grants] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(and(eq(rewardTransactions.userId, userId), eq(rewardTransactions.source, 'goal')));
      expect(grants?.n).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'refuses a goal whose window has already ended',
    async () => {
      const { token } = await onboarded();
      // `[LESSON]` This is the farm: a goal that starts in the past has
      // already finished, the next read settles it, and because the award is
      // keyed on goal:{id} every new goal is a new payout. Create, read,
      // collect, repeat — unbounded points.
      const res = await call('/goals', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          type: 'reduce_percent',
          period: 'week',
          reducePercent: 10,
          startDate: '2020-01-01',
        }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('GOAL_005');
    },
    TIMEOUT,
  );

  it(
    'refuses a cap at or above the baseline',
    async () => {
      const { token, baselinePerDay } = await onboarded();
      // The other half of the same farm. Unlogged days are charged at
      // baseline, so a cap above baseline is met by doing nothing — and
      // rejecting it is what makes "achieved" require real logged days.
      const res = await call('/goals', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          type: 'absolute_cap',
          period: 'week',
          capKgPerDay: Math.ceil(baselinePerDay) + 10,
          startDate: localDate(TZ),
        }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('GOAL_006');
    },
    TIMEOUT,
  );

  it(
    'settles an expired goal lazily, pays once, and only for real logged days',
    async () => {
      const { token, userId, baselinePerDay } = await onboarded();
      const created = await json(
        await call('/goals', {
          method: 'POST',
          headers: auth(token),
          // A real goal: below baseline, starting today.
          body: JSON.stringify({
            type: 'absolute_cap',
            period: 'week',
            capKgPerDay: Math.max(2, Math.floor(baselinePerDay) - 1),
            startDate: localDate(TZ),
          }),
        }),
      );
      expect(created.data.targetKgTotal).toBeLessThan(created.data.baselineKgTotal);

      // Move the window into the past, with footprints that genuinely came
      // in under the cap. Backdating is only possible from a test, which is
      // precisely what GOAL_005 now enforces over the API.
      await db
        .update(goals)
        .set({ startDate: '2026-02-01', endDate: '2026-02-08' })
        .where(eq(goals.id, created.data.id));
      await db.insert(dailyFootprints).values(
        Array.from({ length: 7 }, (_, i) => ({
          userId,
          logDate: `2026-02-0${i + 1}`,
          totalKg: 1.8,
          baselineTotalKg: baselinePerDay,
          sources: { transport: 'logged' as const },
          factorVersion: 1,
        })),
      );

      const first = await json(await call('/goals', { headers: auth(token) }));
      expect(first.data.active).toBeNull();
      expect(first.data.past[0].status).toBe('achieved');

      // Reading the list again must not pay a second time.
      await call('/goals', { headers: auth(token) });
      const [grants] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(and(eq(rewardTransactions.userId, userId), eq(rewardTransactions.source, 'goal')));
      expect(grants?.n).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'settles as missed when the window passed with nothing logged',
    async () => {
      const { token, userId, baselinePerDay } = await onboarded();
      const created = await json(
        await call('/goals', {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify({
            type: 'absolute_cap',
            period: 'week',
            capKgPerDay: Math.max(2, Math.floor(baselinePerDay) - 1),
            startDate: localDate(TZ),
          }),
        }),
      );
      await db
        .update(goals)
        .set({ startDate: '2026-03-01', endDate: '2026-03-08' })
        .where(eq(goals.id, created.data.id));

      const list = await json(await call('/goals', { headers: auth(token) }));
      // Seven unlogged days at baseline exceed any below-baseline target, so
      // doing nothing can never be an achievement.
      expect(list.data.past[0].status).toBe('missed');
      const [grants] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(and(eq(rewardTransactions.userId, userId), eq(rewardTransactions.source, 'goal')));
      expect(grants?.n).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "settles an unverified user's goal without paying it",
    async () => {
      const { token, userId, baselinePerDay } = await createOnboardedUser({
        emailVerifiedAt: null,
      });
      const created = await json(
        await call('/goals', {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify({
            type: 'absolute_cap',
            period: 'week',
            capKgPerDay: Math.max(2, Math.floor(baselinePerDay) - 1),
            startDate: localDate(TZ),
          }),
        }),
      );
      await db
        .update(goals)
        .set({ startDate: '2026-04-01', endDate: '2026-04-08' })
        .where(eq(goals.id, created.data.id));
      await db.insert(dailyFootprints).values(
        Array.from({ length: 7 }, (_, i) => ({
          userId,
          logDate: `2026-04-0${i + 1}`,
          totalKg: 1.8,
          baselineTotalKg: baselinePerDay,
          sources: { transport: 'logged' as const },
          factorVersion: 1,
        })),
      );

      const list = await json(await call('/goals', { headers: auth(token) }));
      // The goal still settles — the user did the work and deserves the
      // record. The grant is what verification withholds, and award()
      // enforces that centrally rather than relying on this caller.
      expect(list.data.past[0].status).toBe('achieved');

      const [grants] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(and(eq(rewardTransactions.userId, userId), eq(rewardTransactions.source, 'goal')));
      expect(grants?.n).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "will not touch another user's goal",
    async () => {
      const victim = await onboarded();
      const attacker = await onboarded();
      const created = await json(
        await call('/goals', {
          method: 'POST',
          headers: auth(victim.token),
          body: JSON.stringify({
            type: 'reduce_percent',
            period: 'week',
            reducePercent: 10,
            startDate: localDate(TZ),
          }),
        }),
      );

      const res = await call(`/goals/${created.data.id}`, {
        method: 'DELETE',
        headers: auth(attacker.token),
      });
      expect(res.status).toBe(404);
    },
    TIMEOUT,
  );
});

describe('leaderboard', () => {
  it(
    'ranks deterministically and marks the caller',
    async () => {
      const { token, userId } = await onboarded();
      const body = await json(await call('/leaderboard?limit=5', { headers: auth(token) }));

      const ranks = body.data.items.map((r: { rank: number }) => r.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      // A tie must not shuffle between requests, so the same page twice is
      // the same page. v1 ranked by array index, which is not a rank.
      const again = await json(await call('/leaderboard?limit=5', { headers: auth(token) }));
      expect(again.data.items.map((r: { id: number }) => r.id)).toEqual(
        body.data.items.map((r: { id: number }) => r.id),
      );

      const me = await json(await call('/leaderboard/me', { headers: auth(token) }));
      expect(me.data.totalRanked).toBeGreaterThan(0);
      expect(me.data.percentile).toBeGreaterThanOrEqual(0);
      expect(me.data.percentile).toBeLessThanOrEqual(100);
      expect(me.data.rank).toBeGreaterThan(0);

      // isMe is set for exactly the caller, and nobody else.
      const mine = body.data.items.filter((r: { isMe: boolean }) => r.isMe);
      expect(mine.every((r: { id: number }) => r.id === userId)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'pages without repeating or skipping a row',
    async () => {
      const { token } = await onboarded();
      const first = await json(await call('/leaderboard?limit=3', { headers: auth(token) }));
      expect(first.data.items).toHaveLength(3);
      expect(first.data.pageInfo.hasMore).toBe(true);

      const second = await json(
        await call(`/leaderboard?limit=3&cursor=${first.data.pageInfo.nextCursor}`, {
          headers: auth(token),
        }),
      );
      const firstIds = new Set(first.data.items.map((r: { id: number }) => r.id));
      for (const row of second.data.items) expect(firstIds.has(row.id)).toBe(false);
      expect(second.data.items[0].rank).toBe(first.data.items[2].rank + 1);
    },
    TIMEOUT,
  );

  it(
    'ranks a windowed board by points earned in the window',
    async () => {
      const { token, userId } = await onboarded();

      // Two grants for the same user: one inside the week, one long before
      // it. A weekly board must count only the first.
      await award(db, {
        userId,
        pointsDelta: 40,
        coinsDelta: 0,
        source: 'admin',
        sourceId: `test-recent:${userId}`,
        note: 'inside the window',
      });
      await db.insert(rewardTransactions).values({
        userId,
        pointsDelta: 900,
        coinsDelta: 0,
        source: 'admin',
        sourceId: `test-old:${userId}`,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      // The cache is moved in step, exactly as award() would have.
      // users.points_total is a denormalisation of this ledger, and a fixture
      // that broke that agreement would be testing an impossible state.
      await db
        .update(users)
        .set({ pointsTotal: sql`${users.pointsTotal} + 900` })
        .where(eq(users.id, userId));

      const week = await json(
        await call('/leaderboard?period=week&limit=100', { headers: auth(token) }),
      );
      const me = week.data.items.find((r: { isMe: boolean }) => r.isMe);
      expect(me).toBeDefined();
      // 40, not 940: the old grant is outside the window, and this is the
      // whole difference between a windowed board and a filtered one.
      expect(me.pointsTotal).toBe(40);

      // All-time still counts both.
      const all = await json(
        await call('/leaderboard?period=all&limit=100', { headers: auth(token) }),
      );
      const meAll = all.data.items.find((r: { isMe: boolean }) => r.isMe);
      expect(meAll.pointsTotal).toBe(940);
    },
    TIMEOUT,
  );
});

describe('home', () => {
  it(
    'refuses before onboarding, then returns the whole screen in one payload',
    async () => {
      const fresh = await createOnboardedUser({ onboardedAt: null });
      await db
        .update(lifestyleProfiles)
        .set({ baselineTotalKg: null, completedSteps: 0 })
        .where(eq(lifestyleProfiles.userId, fresh.userId));
      const bare = await call('/home', { headers: auth(fresh.token) });
      expect(bare.status).toBe(403);
      expect((await json(bare)).error.code).toBe('ONB_003');

      const { token } = await onboarded();
      const res = await call('/home', { headers: auth(token) });
      const h = (await json(res)).data;
      expect(res.status).toBe(200);

      expect(h.greetingName).toBe('Fixture');
      expect(h.wallet.pointsTotal).toBe(0);
      // Seven points, one per calendar day, even with nothing logged — a gap
      // plotted as a missing point would make the chart's x-axis lie.
      expect(h.week.sparkline).toHaveLength(7);
      expect(h.today.logged).toBe(false);
      expect(h.today.inferredCount).toBe(5);
      expect(h.activeGoal).toBeNull();
      expect(h.leaderboard.top.length).toBeGreaterThan(0);
      expect(h.leaderboard.me.pointsTotal).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "reflects today's log and the active goal",
    async () => {
      const { token } = await onboarded();
      await call('/track/logs', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          clientLogId: crypto.randomUUID(),
          logDate: localDate(TZ),
          answers: {
            trips: [{ mode: 'cycle', km: 3 }],
            vegMeals: 3,
            nonVegMeals: 0,
            veganMeals: 0,
            acHoursBucket: '0',
            bathChoice: 'bucket',
            wasteActions: ['segregated', 'composted'],
          },
        }),
      });
      await call('/goals', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          type: 'reduce_percent',
          period: 'month',
          reducePercent: 10,
          startDate: localDate(TZ),
        }),
      });

      const h = (await json(await call('/home', { headers: auth(token) }))).data;
      expect(h.today.logged).toBe(true);
      expect(h.today.inferredCount).toBe(0);
      expect(h.today.deltaKg).toBeLessThan(0);
      expect(h.today.percentOfBaseline).toBeLessThan(100);
      expect(h.streak.current).toBe(1);
      expect(h.activeGoal).not.toBeNull();
      expect(h.activeGoal.daysLeft).toBeGreaterThan(0);
      expect(h.breakdown30d.totalKg).toBeGreaterThan(0);
      // Last sparkline point is today, and it carries the logged figure.
      expect(h.week.sparkline[6].date).toBe(localDate(TZ));
      expect(h.week.sparkline[6].totalKg).toBeCloseTo(h.today.breakdown.totalKg, 2);
    },
    TIMEOUT,
  );
});
