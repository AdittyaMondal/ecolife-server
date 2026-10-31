import { DomainError } from '@common/errors/domain-error.ts';
import { env } from '@config/env.ts';
import type { db } from '@database/client.ts';
import { rewardTransactions, users } from '@database/schema/index.ts';
import { and, eq, sql } from 'drizzle-orm';

/**
 * The points and coins ledger (PRD-v2 §4.2). One function, every grant.
 *
 * Two currencies on purpose: points only ever increase and drive rank, coins
 * are spent. v1 used one integer for both, so buying something dropped your
 * leaderboard position.
 *
 * `[LESSON]` Every grant is keyed `(user_id, source, source_id)` and inserted
 * with ON CONFLICT DO NOTHING against `reward_idempotency_unq`. A replayed
 * request — an offline queue draining twice, a double-tapped button, a retried
 * scan — grants nothing the second time, and that is enforced by the database
 * rather than by remembering to check. v1's `markAsCompleted()` could be
 * POSTed repeatedly for unbounded points.
 */

/** Anything that can run a query: the pool, or a transaction handle. */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RewardSource =
  | 'onboarding'
  | 'daily_log'
  | 'streak'
  | 'reduction'
  | 'goal'
  | 'event_attend'
  | 'event_host'
  | 'order'
  | 'order_refund'
  | 'admin';

export type AwardInput = {
  userId: number;
  pointsDelta: number;
  coinsDelta: number;
  source: RewardSource;
  /** Stable natural key: 'goal:7', 'event_attend:77'. Never random. */
  sourceId: string;
  note?: string | null;
};

export type AwardResult = {
  /** False when this exact grant had already been made. Not an error. */
  awarded: boolean;
  pointsTotal: number;
  coinsBalance: number;
};

/** PRD-v2 §4.2. The only place these numbers appear. */
export const REWARDS = {
  onboarding: { points: 100, coins: 50 },
  dailyLog: { points: 10, coins: 5 },
  streak7: { points: 50, coins: 25 },
  streak30: { points: 250, coins: 100 },
  eventAttend: { points: 200, coins: 100 },
  eventHost: { points: 300, coins: 150 },
  goal: { week: 100, month: 250, quarter: 500 },
} as const;

/** Minimum distinct check-ins before an event host earns anything (PRD-v2 §4.4). */
export const EVENT_HOST_MIN_ATTENDEES = 5;

/**
 * Points for beating your own baseline: `round(min(pct, 50) / 2)`, so 1–25.
 *
 * Capped because the bonus is the main farming target — an implausibly low
 * day is otherwise worth more the more you understate it. The caller is also
 * required to check that all five questions were answered (PRD-v2 §4.4);
 * this function only does the arithmetic.
 */
export function reductionPoints(reductionPct: number): number {
  if (reductionPct <= 0) return 0;
  return Math.round(Math.min(reductionPct, 50) / 2);
}

/** Coins are always half the points, rounded down. */
export const coinsFor = (points: number): number => Math.floor(points / 2);

/**
 * Records a grant and moves the user's balances in the same statement pair.
 *
 * `users.points_total` / `coins_balance` are a denormalised cache of this
 * ledger. They are written here and nowhere else, so `SUM(points_delta)` and
 * `points_total` reconcile — the seed asserts exactly that.
 *
 * Pass a transaction whenever the grant must stand or fall with other writes
 * (an order's stock decrement, a pass's check-in). Without one it runs on the
 * pool, which is right for a standalone grant.
 */
export async function award(tx: Executor, input: AwardInput): Promise<AwardResult> {
  /**
   * Verification gates EARNING, centrally (PRD-v2 §4.4).
   *
   * This check used to live in each caller, and the goal-settlement path
   * forgot it — a comment three lines from here claimed the opposite, which
   * is precisely why it was worth moving. Every earn path now goes through
   * one place, including ones not written yet.
   *
   * Only positive deltas are gated. A SPEND must always work: refusing to
   * debit coins from an unverified wallet would hand out free orders, which
   * is the opposite of the intent. `admin` is exempt so a human correction
   * is never blocked by it.
   *
   * It SKIPS rather than throws, because an earn is almost always attached
   * to something the user is entitled to regardless — a settled goal, a
   * logged day. Throwing would roll that back too.
   */
  const isEarning = input.pointsDelta > 0 || input.coinsDelta > 0;
  if (isEarning && input.source !== 'admin' && !(await canEarn(tx, input.userId))) {
    const [row] = await tx
      .select({ pointsTotal: users.pointsTotal, coinsBalance: users.coinsBalance })
      .from(users)
      .where(eq(users.id, input.userId));
    return {
      awarded: false,
      pointsTotal: row?.pointsTotal ?? 0,
      coinsBalance: row?.coinsBalance ?? 0,
    };
  }

  const inserted = await tx
    .insert(rewardTransactions)
    .values({
      userId: input.userId,
      pointsDelta: input.pointsDelta,
      coinsDelta: input.coinsDelta,
      source: input.source,
      sourceId: input.sourceId,
      note: input.note ?? null,
    })
    .onConflictDoNothing({
      target: [rewardTransactions.userId, rewardTransactions.source, rewardTransactions.sourceId],
    })
    .returning({ id: rewardTransactions.id });

  if (inserted.length === 0) {
    // Already granted. Report the current balances so the caller can still
    // render a wallet, and say `awarded: false` so it does not animate a
    // second celebration for the same thing.
    const [row] = await tx
      .select({ pointsTotal: users.pointsTotal, coinsBalance: users.coinsBalance })
      .from(users)
      .where(eq(users.id, input.userId));
    return {
      awarded: false,
      pointsTotal: row?.pointsTotal ?? 0,
      coinsBalance: row?.coinsBalance ?? 0,
    };
  }

  // The balance guard lives in the WHERE, not in a prior read: two concurrent
  // spends that each pass a read-then-write check would both commit and drive
  // the balance negative. Here the loser simply matches no row.
  const [updated] = await tx
    .update(users)
    .set({
      pointsTotal: sql`${users.pointsTotal} + ${input.pointsDelta}`,
      coinsBalance: sql`${users.coinsBalance} + ${input.coinsDelta}`,
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, input.userId), sql`${users.coinsBalance} + ${input.coinsDelta} >= 0`))
    .returning({ pointsTotal: users.pointsTotal, coinsBalance: users.coinsBalance });

  if (!updated) {
    // The ledger row is already written, so this MUST roll back — which is why
    // a spend has to be called inside a transaction. On the bare pool the
    // throw would leave a ledger row with no matching balance change.
    throw new DomainError('POINTS_001', 'Not enough coins for this.', 422);
  }

  return { awarded: true, pointsTotal: updated.pointsTotal, coinsBalance: updated.coinsBalance };
}

/**
 * Is this user allowed to earn? (PRD-v2 §4.4)
 *
 * An unverified account can read everything and log its day; it just cannot
 * accumulate anything a leaderboard or a marketplace honours. `award` calls
 * this itself on every positive grant, so this is only needed directly when
 * a caller wants to REPORT what it withheld — "pointsAwarded: 0" — rather
 * than merely not grant it.
 */
export async function canEarn(tx: Executor, userId: number): Promise<boolean> {
  if (env.NODE_ENV !== 'production') return true;
  const [row] = await tx
    .select({ verifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId));
  return row?.verifiedAt != null;
}

/**
 * Throws when the caller may not earn.
 *
 * Use this ONLY where earning is the entire point of the request. On a path
 * that also does something the user is entitled to regardless — finishing
 * onboarding, logging a day — call `canEarn` and skip the grant instead.
 * Throwing there takes the whole feature down with the reward, which is
 * exactly how an unverified account ended up unable to get a baseline and
 * therefore unable to use the product at all.
 */
export async function assertCanEarn(tx: Executor, userId: number): Promise<void> {
  if (!(await canEarn(tx, userId))) {
    throw new DomainError('POINTS_003', 'Verify your email address to start earning points.', 403);
  }
}
