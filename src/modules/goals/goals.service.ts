import { MIN_PLAUSIBLE_KG } from '@common/carbon/factors.ts';
import { DomainError } from '@common/errors/domain-error.ts';
import { award, coinsFor, type Executor, REWARDS } from '@common/rewards/rewards.ts';
import { addDays, daysBetween, localDate } from '@common/time.ts';
import { db } from '@database/client.ts';
import * as profileRepo from '@modules/profile/profile.repository.ts';
import * as repo from './goals.repository.ts';

/**
 * Reduction goals (PRD-v2 §6.4).
 *
 * `[LESSON]` The target is FROZEN at creation from a baseline snapshot. v1
 * derived a percentage goal's target from the same running total it then
 * compared against — `actual <= actual x (1 - p/100)` — which is false for
 * every p > 0, so percentage goals were mathematically unachievable.
 * Computing the target once, up front, is the whole fix, and it is why
 * `baselineKgTotal` is a column rather than a join.
 */

/** Days in each period. A month is 30 and a quarter 90 — fixed, not calendar. */
const PERIOD_DAYS = { week: 7, month: 30, quarter: 90 } as const;

export type Period = keyof typeof PERIOD_DAYS;
export type GoalType = 'reduce_percent' | 'absolute_cap';

export type GoalBody = {
  type: GoalType;
  period: Period;
  reducePercent?: number;
  capKgPerDay?: number;
  startDate: string;
};

type GoalRow = repo.GoalRow;

async function context(userId: number) {
  const [user, profile] = await Promise.all([
    profileRepo.findUser(userId),
    profileRepo.findProfile(userId),
  ]);
  if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);
  if (!profile || profile.baselineTotalKg === null) {
    throw new DomainError('ONB_003', 'Finish onboarding before setting a goal.', 403);
  }
  return { user, profile, baselineKgPerDay: profile.baselineTotalKg };
}

/**
 * Freezes the window and the two totals a goal is judged against.
 *
 * Throws rather than clamping when the target is implausible: a goal below
 * MIN_PLAUSIBLE_KG per day cannot be met by any real person, and silently
 * raising it to something achievable would be deciding on the user's behalf
 * what they meant.
 */
function freeze(body: GoalBody, baselineKgPerDay: number) {
  const days = PERIOD_DAYS[body.period];
  const endDate = addDays(body.startDate, days);
  const baselineKgTotal = baselineKgPerDay * days;

  let targetKgPerDay: number;
  if (body.type === 'reduce_percent') {
    if (body.reducePercent === undefined) {
      throw new DomainError('GOAL_003', 'reducePercent is required for a percentage goal.', 422);
    }
    targetKgPerDay = baselineKgPerDay * (1 - body.reducePercent / 100);
  } else {
    if (body.capKgPerDay === undefined) {
      throw new DomainError('GOAL_003', 'capKgPerDay is required for a daily-cap goal.', 422);
    }
    targetKgPerDay = body.capKgPerDay;
  }

  if (targetKgPerDay < MIN_PLAUSIBLE_KG) {
    throw new DomainError(
      'GOAL_002',
      `A target below ${MIN_PLAUSIBLE_KG} kg a day is not achievable.`,
      422,
      { targetKgPerDay: round2(targetKgPerDay), minimumKgPerDay: MIN_PLAUSIBLE_KG },
    );
  }

  return {
    endDate,
    baselineKgTotal: round2(baselineKgTotal),
    targetKgTotal: round2(targetKgPerDay * days),
  };
}

/**
 * Actual emissions over a goal window, with unlogged elapsed days charged at
 * baseline.
 *
 * A missing day is NOT zero. Summing only logged days would mean the surest
 * way to hit any reduction goal is to stop logging — and the goal would read
 * as a triumph. Elapsed-but-unlogged days are therefore charged at the
 * frozen baseline rate, so silence costs exactly what an average day costs.
 */
async function actualSoFar(goal: GoalRow, today: string) {
  const windowEnd = today < goal.endDate ? today : goal.endDate;
  // `daysBetween` is exclusive of the start, so a goal starting today has
  // elapsed 1 day once it exists at all.
  const daysElapsed = Math.max(
    0,
    Math.min(totalDays(goal), daysBetween(goal.startDate, windowEnd) + 1),
  );
  if (daysElapsed === 0) return { actualKgTotal: 0, daysElapsed: 0 };

  const { totalKg, days } = await repo.sumFootprints(goal.userId, goal.startDate, windowEnd);
  const baselinePerDay = goal.baselineKgTotal / totalDays(goal);
  const unlogged = Math.max(0, daysElapsed - days);

  return { actualKgTotal: round2(totalKg + unlogged * baselinePerDay), daysElapsed };
}

const totalDays = (goal: GoalRow) => Math.max(1, daysBetween(goal.startDate, goal.endDate));

/**
 * Settles an expired goal and pays out if it was met.
 *
 * Lazy rather than scheduled: the jobs runner does not exist yet, and a goal
 * nobody looks at does not need settling at the stroke of midnight. The
 * `status = 'active'` predicate on the UPDATE makes two concurrent readers
 * safe — only one settles, only one awards.
 */
async function settleIfExpired(goal: GoalRow, today: string) {
  if (goal.status !== 'active' || today <= goal.endDate) return { goal, reward: null };

  const { actualKgTotal } = await actualSoFar(goal, today);
  const achieved = actualKgTotal <= goal.targetKgTotal;

  return db.transaction(async (tx) => {
    const settled = await repo.settleIfActive(
      goal.id,
      { status: achieved ? 'achieved' : 'missed', actualKgTotal },
      tx,
    );
    // Someone else settled it first. Return the row as it now stands and
    // award nothing — their transaction already did.
    if (!settled) {
      const current = await repo.findOwned(goal.userId, goal.id, tx);
      return { goal: current ?? goal, reward: null };
    }
    if (!achieved) return { goal: settled, reward: null };

    const points = REWARDS.goal[goal.period as Period];
    const coins = coinsFor(points);
    // `goal:{id}` — the row is never deleted, so this key is stable forever.
    // v1 deleted the goal on success, which is why its points_awarded flag
    // never did anything.
    const result = await award(tx, {
      userId: goal.userId,
      pointsDelta: points,
      coinsDelta: coins,
      source: 'goal',
      sourceId: `goal:${goal.id}`,
      note: `${goal.period} goal achieved`,
    });

    return {
      goal: settled,
      reward: result.awarded
        ? { pointsDelta: points, coinsDelta: coins, reasons: [{ source: 'goal', points, coins }] }
        : null,
    };
  });
}

export async function list(userId: number) {
  const user = await profileRepo.findUser(userId);
  if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);
  const today = localDate(user.timezone);

  let active = await repo.findActive(userId);
  if (active) {
    const settled = await settleIfExpired(active, today);
    active = settled.goal.status === 'active' ? settled.goal : null;
  }

  const past = await repo.listPast(userId);
  return { active: active ? serialise(active) : null, past: past.map(serialise) };
}

export async function create(userId: number, body: GoalBody) {
  const { baselineKgPerDay } = await context(userId);

  // Checked before the insert so the caller gets GOAL_001 rather than a
  // constraint violation. `one_active_goal_per_user` is still the real
  // guarantee — this is only the better error message.
  if (await repo.findActive(userId)) {
    throw new DomainError('GOAL_001', 'You already have an active goal.', 409);
  }

  const frozen = freeze(body, baselineKgPerDay);
  const row = await repo.insertGoal({
    userId,
    type: body.type,
    period: body.period,
    reducePercent: body.reducePercent ?? null,
    capKgPerDay: body.capKgPerDay ?? null,
    startDate: body.startDate,
    ...frozen,
  });
  return serialise(row);
}

export async function patch(userId: number, id: number, body: Partial<GoalBody>) {
  const { baselineKgPerDay } = await context(userId);
  const existing = await repo.findOwned(userId, id);
  if (existing?.status !== 'active') {
    throw new DomainError('GOAL_004', 'No active goal with that id.', 404);
  }

  const merged: GoalBody = {
    type: body.type ?? (existing.type as GoalType),
    period: body.period ?? (existing.period as Period),
    reducePercent: body.reducePercent ?? existing.reducePercent ?? undefined,
    capKgPerDay: body.capKgPerDay ?? existing.capKgPerDay ?? undefined,
    startDate: body.startDate ?? existing.startDate,
  };
  // A type change must drop the other type's value, or freeze() would read a
  // stale cap left over from a percentage goal.
  if (merged.type === 'reduce_percent') merged.capKgPerDay = undefined;
  else merged.reducePercent = undefined;

  const frozen = freeze(merged, baselineKgPerDay);
  const row = await repo.updateGoal(id, {
    type: merged.type,
    period: merged.period,
    reducePercent: merged.type === 'reduce_percent' ? (merged.reducePercent ?? null) : null,
    capKgPerDay: merged.type === 'absolute_cap' ? (merged.capKgPerDay ?? null) : null,
    startDate: merged.startDate,
    ...frozen,
  });
  if (!row) throw new DomainError('GOAL_004', 'No active goal with that id.', 404);
  return serialise(row);
}

export async function cancel(userId: number, id: number) {
  const existing = await repo.findOwned(userId, id);
  if (existing?.status !== 'active') {
    throw new DomainError('GOAL_004', 'No active goal with that id.', 404);
  }
  const row = await repo.settleIfActive(id, { status: 'cancelled', actualKgTotal: null });
  if (!row) throw new DomainError('GOAL_004', 'No active goal with that id.', 404);
  return serialise(row);
}

export async function progress(userId: number, id: number) {
  const user = await profileRepo.findUser(userId);
  if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);

  const found = await repo.findOwned(userId, id);
  if (!found) throw new DomainError('GOAL_004', 'No goal with that id.', 404);

  const today = localDate(user.timezone);
  const goal = (await settleIfExpired(found, today)).goal;

  const { actualKgTotal, daysElapsed } = await actualSoFar(goal, today);
  const span = totalDays(goal);
  const daysLeft = Math.max(0, span - daysElapsed);

  // Linear projection at the rate achieved so far. Before any day has
  // elapsed there is no rate to project from, so the honest answer is the
  // target itself rather than a divide by zero.
  const projectedKgTotal =
    daysElapsed > 0 ? round2((actualKgTotal / daysElapsed) * span) : goal.targetKgTotal;

  return {
    goal: serialise(goal),
    actualKgTotal,
    targetKgTotal: goal.targetKgTotal,
    progressPct: goal.targetKgTotal > 0 ? round2((actualKgTotal / goal.targetKgTotal) * 100) : 0,
    daysElapsed,
    daysLeft,
    projectedKgTotal,
    onTrack: projectedKgTotal <= goal.targetKgTotal,
  };
}

/** The active goal summary the Home screen shows, or null. */
export async function activeSummary(userId: number, timezone: string) {
  const found = await repo.findActive(userId);
  if (!found) return null;

  const today = localDate(timezone);
  const goal = (await settleIfExpired(found, today)).goal;
  if (goal.status !== 'active') return null;

  const { actualKgTotal, daysElapsed } = await actualSoFar(goal, today);
  const span = totalDays(goal);
  const projected = daysElapsed > 0 ? (actualKgTotal / daysElapsed) * span : goal.targetKgTotal;

  return {
    id: goal.id,
    type: goal.type,
    period: goal.period,
    targetKgTotal: goal.targetKgTotal,
    actualKgTotal,
    progressPct: goal.targetKgTotal > 0 ? round2((actualKgTotal / goal.targetKgTotal) * 100) : 0,
    daysLeft: Math.max(0, span - daysElapsed),
    onTrack: projected <= goal.targetKgTotal,
  };
}

/** Settles an expired goal as a side effect of a daily log. */
export async function settleOnLog(tx: Executor, userId: number, timezone: string) {
  const active = await repo.findActive(userId, tx);
  if (!active) return null;
  return settleIfExpired(active, localDate(timezone));
}

function serialise(goal: GoalRow) {
  return {
    id: goal.id,
    type: goal.type,
    period: goal.period,
    reducePercent: goal.reducePercent,
    capKgPerDay: goal.capKgPerDay,
    startDate: goal.startDate,
    endDate: goal.endDate,
    baselineKgTotal: goal.baselineKgTotal,
    targetKgTotal: goal.targetKgTotal,
    status: goal.status,
    actualKgTotal: goal.actualKgTotal,
    settledAt: goal.settledAt?.toISOString() ?? null,
    createdAt: goal.createdAt.toISOString(),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
