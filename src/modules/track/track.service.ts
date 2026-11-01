import {
  computeDailyFootprint,
  type DailyAnswers,
  type DailyFootprint,
  reductionPct,
  type StoredBaseline,
} from '@common/carbon/calculate.ts';
import { DomainError } from '@common/errors/domain-error.ts';
import {
  award,
  canEarn,
  coinsFor,
  type Executor,
  REWARDS,
  reductionPoints,
} from '@common/rewards/rewards.ts';
import { addDays, daysBetween, localDate, localHour, zonedIso } from '@common/time.ts';
import { db } from '@database/client.ts';
import { sendPredefinedNotification } from '@modules/notifications/fcm.service.ts';
import * as profileRepo from '@modules/profile/profile.repository.ts';
import * as reference from '@modules/reference/reference.repository.ts';
import * as repo from './track.repository.ts';

/**
 * The daily log — the core loop (PRD-v2 §3.4, §3.5).
 *
 * One transaction per submit: compute the five categories, upsert the
 * footprint, update the streak, award. Idempotent on `(user, clientLogId)`,
 * so the mobile offline queue can replay without granting twice.
 */

/** A log stays editable until 02:00 the following day, in the user's zone. */
const EDIT_CUTOFF_HOUR = 2;

type UserRow = NonNullable<Awaited<ReturnType<typeof profileRepo.findUser>>>;
type ProfileRow = NonNullable<Awaited<ReturnType<typeof profileRepo.findProfile>>>;

async function loadContext(userId: number) {
  const [user, profile] = await Promise.all([
    profileRepo.findUser(userId),
    profileRepo.findProfile(userId),
  ]);
  if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);
  // Without a baseline there is nothing to compare a day against, and the
  // reduction bonus would divide by zero.
  if (!profile || profile.baselineTotalKg === null) {
    throw new DomainError('ONB_003', 'Finish onboarding before logging a day.', 403);
  }
  const region = profile.regionCode ? await reference.findRegion(profile.regionCode) : null;
  return { user, profile, region };
}

function storedBaseline(profile: ProfileRow): StoredBaseline {
  return {
    baselineTransportKg: profile.baselineTransportKg ?? 0,
    baselineFoodKg: profile.baselineFoodKg ?? 0,
    baselineHomeEnergyKg: profile.baselineHomeEnergyKg ?? 0,
    baselineWaterKg: profile.baselineWaterKg ?? 0,
    baselineWasteKg: profile.baselineWasteKg ?? 0,
    baselineTotalKg: profile.baselineTotalKg ?? 0,
    baselineFlightKg: profile.baselineFlightKg ?? 0,
    baselineCookKg: profile.baselineCookKg ?? 0,
    baselineGridBaseKg: profile.baselineGridBaseKg ?? 0,
  };
}

/** `none_of_these` is a real answer meaning "no actions", not an action. */
function realWasteActions(actions: readonly string[]): string[] {
  return actions.filter((a) => a !== 'none_of_these');
}

function toDailyAnswers(body: TrackAnswers): DailyAnswers {
  const answers: DailyAnswers = {};
  if (body.trips !== undefined) answers.trips = body.trips;
  if (body.vegMeals !== undefined) answers.vegMeals = body.vegMeals;
  if (body.nonVegMeals !== undefined) answers.nonVegMeals = body.nonVegMeals;
  if (body.veganMeals !== undefined) answers.veganMeals = body.veganMeals;
  if (body.acHoursBucket !== undefined) answers.acHoursBucket = body.acHoursBucket;
  if (body.bathChoice !== undefined) answers.bathChoice = body.bathChoice;
  if (body.wasteActions !== undefined) answers.wasteActions = realWasteActions(body.wasteActions);
  return answers;
}

export type TrackAnswers = {
  trips?: { mode: string; km: number }[];
  vegMeals?: number;
  nonVegMeals?: number;
  veganMeals?: number;
  acHoursBucket?: '0' | '1_3' | '4_8' | '8_plus';
  bathChoice?: 'bucket' | 'short_shower' | 'long_shower';
  wasteActions?: string[];
};

/**
 * `GET /track/today` — the existing log if any, plus the prefill.
 *
 * `askCooling` is false when the profile says no cooling is used: asking a
 * question whose answer is structurally zero wastes one of the five taps the
 * whole screen is budgeted at.
 */
export async function today(userId: number) {
  const { user, profile } = await loadContext(userId);
  const date = localDate(user.timezone);
  const existing = await repo.findLogByDate(userId, date);

  return {
    date,
    existingLog: existing
      ? {
          id: existing.id,
          answers: answersOfLog(existing),
          editableUntil: zonedIso(addDays(existing.logDate, 1), EDIT_CUTOFF_HOUR, user.timezone),
        }
      : null,
    askCooling: profile.coolingUsage !== null && profile.coolingUsage !== 'none',
    defaults: defaultsFor(profile),
  };
}

function answersOfLog(log: repo.LogRow): TrackAnswers {
  const answers: TrackAnswers = {};
  if (log.trips !== null) answers.trips = log.trips;
  if (log.vegMeals !== null) answers.vegMeals = log.vegMeals;
  if (log.nonVegMeals !== null) answers.nonVegMeals = log.nonVegMeals;
  if (log.veganMeals !== null) answers.veganMeals = log.veganMeals;
  if (log.acHoursBucket !== null) answers.acHoursBucket = log.acHoursBucket;
  if (log.bathChoice !== null) answers.bathChoice = log.bathChoice;
  if (log.wasteActions !== null) answers.wasteActions = log.wasteActions;
  return answers;
}

/**
 * The one-tap "Same as usual" prefill, derived from the onboarding answers.
 *
 * Only questions the profile can actually answer are prefilled. A diet is a
 * habit, so meals are offered; a bath choice is not something onboarding
 * asked about at daily resolution, so it is left for the user.
 */
function defaultsFor(profile: ProfileRow): TrackAnswers {
  const defaults: TrackAnswers = {};

  if (profile.primaryCommuteMode && profile.primaryCommuteMode !== 'work_from_home') {
    // One way at onboarding; a normal day is out and back.
    defaults.trips = [
      { mode: profile.primaryCommuteMode, km: profile.commuteDistanceKm ?? 0 },
      { mode: profile.primaryCommuteMode, km: profile.commuteDistanceKm ?? 0 },
    ];
  } else if (profile.primaryCommuteMode === 'work_from_home') {
    defaults.trips = [];
  }

  switch (profile.dietType) {
    case 'vegan':
      defaults.veganMeals = 3;
      break;
    case 'vegetarian':
    case 'eggetarian':
      defaults.vegMeals = 3;
      break;
    case 'non_veg_weekly':
      defaults.vegMeals = 2;
      defaults.nonVegMeals = 1;
      break;
    case 'non_veg_daily':
      defaults.nonVegMeals = 3;
      break;
    default:
      break;
  }

  switch (profile.coolingUsage) {
    case 'ac_daily':
      defaults.acHoursBucket = '4_8';
      break;
    case 'ac_occasional':
      defaults.acHoursBucket = '1_3';
      break;
    case 'none':
    case 'fan_only':
      defaults.acHoursBucket = '0';
      break;
    default:
      break;
  }

  switch (profile.wasteHabit) {
    case 'segregate_and_compost':
      defaults.wasteActions = ['segregated', 'composted'];
      break;
    case 'segregate_only':
      defaults.wasteActions = ['segregated'];
      break;
    case 'none':
      defaults.wasteActions = [];
      break;
    default:
      break;
  }

  return defaults;
}

/**
 * The date window: today or yesterday, in the user's own timezone.
 *
 * Yesterday is allowed because people log at night and because an offline
 * queue drains late. Anything older would let a user backfill a month of
 * invented low days straight into the reduction bonus.
 */
function assertLoggableDate(user: UserRow, logDate: string) {
  const todayLocal = localDate(user.timezone);
  const offset = daysBetween(logDate, todayLocal);
  if (offset !== 0 && offset !== 1) {
    throw new DomainError('TRACK_002', 'You can only log today or yesterday.', 422, {
      logDate,
      today: todayLocal,
    });
  }

  // A second bound, in UTC, that the user cannot move.
  //
  // `timezone` is self-declared, and real zones span UTC-12 to UTC+14 — 26
  // hours. Flipping it between submits therefore reaches one calendar date
  // beyond what the local window alone allows, which is a free extra day of
  // reduction bonus for anyone who notices. No real zone can put a user more
  // than one day either side of the UTC date, so this costs nobody honest
  // anything.
  const utcOffset = Math.abs(daysBetween(logDate, new Date().toISOString().slice(0, 10)));
  if (utcOffset > 1) {
    throw new DomainError('TRACK_002', 'You can only log today or yesterday.', 422, { logDate });
  }
}

export type SubmitBody = { clientLogId: string; logDate: string; answers: TrackAnswers };

export async function submit(userId: number, body: SubmitBody) {
  const { user, profile, region } = await loadContext(userId);
  assertLoggableDate(user, body.logDate);
  /**
   * Verification gates the REWARD, not the log (PRD-v2 §4.4, and
   * docs/error-codes.md says so in as many words). This used to throw,
   * which stopped an unverified user from recording their day at all —
   * the core action of the product, refused over a bonus.
   */
  const earns = await canEarn(db, userId);

  const answers = toDailyAnswers(body.answers);
  const baseline = storedBaseline(profile);
  const computed = computeDailyFootprint(answers, baseline, profile, region);

  return db.transaction(async (tx) => {
    const { row: log, created } = await insertLogOrConflict(tx, {
      userId,
      logDate: body.logDate,
      clientLogId: body.clientLogId,
      trips: answers.trips ?? null,
      vegMeals: answers.vegMeals ?? null,
      nonVegMeals: answers.nonVegMeals ?? null,
      veganMeals: answers.veganMeals ?? null,
      acHoursBucket: answers.acHoursBucket ?? null,
      bathChoice: answers.bathChoice ?? null,
      wasteActions: answers.wasteActions ?? null,
      answeredCount: computed.answeredCount,
    });

    if (!created) {
      // A replayed submit. Recomputing and re-upserting would be harmless,
      // but re-reading is honest: the client gets exactly what the first
      // submit produced, and the reward calls below are all idempotent
      // anyway. `[LESSON]` this is the offline-queue path.
      return replayResult(userId, log, baseline, profile, region);
    }

    const footprint = await repo.upsertFootprint(tx, {
      userId,
      logDate: body.logDate,
      dailyLogId: log.id,
      transportKg: computed.transportKg,
      foodKg: computed.foodKg,
      homeEnergyKg: computed.homeEnergyKg,
      waterKg: computed.waterKg,
      wasteKg: computed.wasteKg,
      totalKg: computed.totalKg,
      baselineTotalKg: baseline.baselineTotalKg,
      reductionPct: reductionPct(computed.totalKg, baseline.baselineTotalKg),
      sources: computed.sources,
      clamped: computed.clamped,
      factorVersion: computed.factorVersion,
    });

    const streak = await updateStreak(tx, userId, user, body.logDate);
    const reward = earns
      ? await grantForLog(tx, userId, log.id, computed, footprint.reductionPct, streak)
      : {
          grant: { pointsDelta: 0, coinsDelta: 0, reasons: [] },
          wallet: { pointsTotal: user.pointsTotal, coinsBalance: user.coinsBalance },
        };

    // Predefined FCM notification dispatch on coin reward
    if (reward.grant.coinsDelta > 0) {
      sendPredefinedNotification(userId, 'COINS_EARNED', {
        coins: String(reward.grant.coinsDelta),
      }).catch((err) => console.error('[FCM] Coins earned push failed:', err));
    }

    return {
      logId: log.id,
      breakdown: breakdownOf(computed),
      baselineTotalKg: baseline.baselineTotalKg,
      deltaKg: round2(computed.totalKg - baseline.baselineTotalKg),
      reductionPct: footprint.reductionPct,
      sources: computed.sources,
      clamped: computed.clamped,
      reward: reward.grant,
      wallet: reward.wallet,
      streak,
    };
  });
}

/**
 * Edits a log until 02:00 the next day.
 *
 * The footprint is recomputed, but the reduction bonus is NOT re-granted: it
 * is computed once, on first submit (PRD-v2 §4.4). `reduction:{logId}` makes
 * that true even if this code forgot, because the ledger key is the same one.
 */
export async function edit(userId: number, logId: number, answersBody: TrackAnswers) {
  const { user, profile, region } = await loadContext(userId);
  const log = await repo.findLogById(userId, logId);
  if (!log) throw new DomainError('GEN_404', 'Log not found.', 404);

  const todayLocal = localDate(user.timezone);
  const dayAfter = addDays(log.logDate, 1);
  const open =
    todayLocal === log.logDate ||
    (todayLocal === dayAfter && localHour(user.timezone) < EDIT_CUTOFF_HOUR);
  if (!open) {
    throw new DomainError('TRACK_003', 'This log can no longer be edited.', 403, {
      editableUntil: zonedIso(dayAfter, EDIT_CUTOFF_HOUR, user.timezone),
    });
  }

  const answers = toDailyAnswers(answersBody);
  const baseline = storedBaseline(profile);
  const computed = computeDailyFootprint(answers, baseline, profile, region);

  return db.transaction(async (tx) => {
    await repo.updateLog(tx, log.id, {
      trips: answers.trips ?? null,
      vegMeals: answers.vegMeals ?? null,
      nonVegMeals: answers.nonVegMeals ?? null,
      veganMeals: answers.veganMeals ?? null,
      acHoursBucket: answers.acHoursBucket ?? null,
      bathChoice: answers.bathChoice ?? null,
      wasteActions: answers.wasteActions ?? null,
      answeredCount: computed.answeredCount,
    });

    const footprint = await repo.upsertFootprint(tx, {
      userId,
      logDate: log.logDate,
      dailyLogId: log.id,
      transportKg: computed.transportKg,
      foodKg: computed.foodKg,
      homeEnergyKg: computed.homeEnergyKg,
      waterKg: computed.waterKg,
      wasteKg: computed.wasteKg,
      totalKg: computed.totalKg,
      baselineTotalKg: baseline.baselineTotalKg,
      reductionPct: reductionPct(computed.totalKg, baseline.baselineTotalKg),
      sources: computed.sources,
      clamped: computed.clamped,
      factorVersion: computed.factorVersion,
    });

    const [fresh] = await Promise.all([profileRepo.findUser(userId)]);
    const streak = { current: fresh?.currentStreak ?? 0, longest: fresh?.longestStreak ?? 0 };

    return {
      logId: log.id,
      breakdown: breakdownOf(computed),
      baselineTotalKg: baseline.baselineTotalKg,
      deltaKg: round2(computed.totalKg - baseline.baselineTotalKg),
      reductionPct: footprint.reductionPct,
      sources: computed.sources,
      clamped: computed.clamped,
      // No new grant on an edit. An edit that improves the day does not pay
      // again, which is what stops "log badly, then edit down" farming.
      reward: { pointsDelta: 0, coinsDelta: 0, reasons: [] },
      wallet: { pointsTotal: fresh?.pointsTotal ?? 0, coinsBalance: fresh?.coinsBalance ?? 0 },
      streak,
    };
  });
}

/**
 * `daily_log_client_unq` makes a REPLAY idempotent — same clientLogId, same
 * row back. `daily_log_user_date_unq` is a different event: a *new*
 * clientLogId claiming a date that already has a log, which is what a second
 * device or a reinstall that lost its queue sends.
 *
 * Unmapped, that constraint surfaced as an unhandled driver error and the
 * filter turned it into a generic INTERNAL_001 500 — so the client was told
 * the server broke when in fact its request was answerable. TRACK_001 has
 * been in docs/error-codes.md as a 409 all along with nothing throwing it.
 */
async function insertLogOrConflict(tx: Executor, values: Parameters<typeof repo.insertLog>[1]) {
  try {
    return await repo.insertLog(tx, values);
  } catch (error) {
    // Assert on the constraint name, not the message: Drizzle wraps driver
    // errors as `Failed query: …`, and matching that text would let an
    // unrelated failure be reported as a duplicate date.
    const constraint = (error as { cause?: { constraint?: string } }).cause?.constraint;
    if (constraint === 'daily_log_user_date_unq') {
      throw new DomainError(
        'TRACK_001',
        'A log already exists for this date. Edit it instead of submitting again.',
        409,
        { logDate: values.logDate },
      );
    }
    throw error;
  }
}

/** Replay path: report what the first submit produced, award nothing new. */
async function replayResult(
  userId: number,
  log: repo.LogRow,
  baseline: StoredBaseline,
  profile: ProfileRow,
  region: { gridKgPerKwh: number } | null,
) {
  const computed = computeDailyFootprint(answersOfLog(log), baseline, profile, region);
  const user = await profileRepo.findUser(userId);
  return {
    logId: log.id,
    breakdown: breakdownOf(computed),
    baselineTotalKg: baseline.baselineTotalKg,
    deltaKg: round2(computed.totalKg - baseline.baselineTotalKg),
    reductionPct: reductionPct(computed.totalKg, baseline.baselineTotalKg),
    sources: computed.sources,
    clamped: computed.clamped,
    reward: { pointsDelta: 0, coinsDelta: 0, reasons: [] },
    wallet: { pointsTotal: user?.pointsTotal ?? 0, coinsBalance: user?.coinsBalance ?? 0 },
    streak: { current: user?.currentStreak ?? 0, longest: user?.longestStreak ?? 0 },
  };
}

/**
 * Recomputes the streak from the logged dates rather than incrementing a
 * counter.
 *
 * An increment is wrong the moment anything arrives out of order — a queued
 * log for yesterday draining after today's, which is normal on mobile.
 * Counting backwards from the latest logged date cannot drift.
 */
async function updateStreak(tx: Executor, userId: number, user: UserRow, logDate: string) {
  const todayLocal = localDate(user.timezone);
  // 60 days is well past the 30-day bonus and bounds the scan.
  const dates = new Set(await repo.loggedDatesSince(userId, addDays(todayLocal, -60), tx));
  dates.add(logDate);

  // A streak is current only if it reaches today or yesterday; otherwise it
  // has already been broken and today's log starts a new one.
  let anchor = todayLocal;
  if (!dates.has(anchor)) anchor = addDays(todayLocal, -1);
  let current = 0;
  if (dates.has(anchor)) {
    let cursor = anchor;
    while (dates.has(cursor)) {
      current += 1;
      cursor = addDays(cursor, -1);
    }
  }

  const longest = Math.max(user.longestStreak, current);
  await repo.setStreak(tx, userId, current, longest);
  return { current, longest };
}

type Reason = { source: string; points: number; coins: number };

/** The daily grant, the reduction bonus, and any streak milestone. */
async function grantForLog(
  tx: Executor,
  userId: number,
  logId: number,
  computed: DailyFootprint,
  pct: number,
  streak: { current: number; longest: number },
) {
  const reasons: Reason[] = [];
  let pointsTotal = 0;
  let coinsBalance = 0;

  const record = async (
    source: Parameters<typeof award>[1]['source'],
    sourceId: string,
    points: number,
    coins: number,
    note: string,
  ) => {
    const result = await award(tx, {
      userId,
      pointsDelta: points,
      coinsDelta: coins,
      source,
      sourceId,
      note,
    });
    pointsTotal = result.pointsTotal;
    coinsBalance = result.coinsBalance;
    if (result.awarded) reasons.push({ source, points, coins });
  };

  await record(
    'daily_log',
    `daily_log:${logId}`,
    REWARDS.dailyLog.points,
    REWARDS.dailyLog.coins,
    'Daily log',
  );

  // `[LESSON]` The reduction bonus is the main farming target, so it carries
  // three independent brakes: all five questions must be answered, the points
  // are capped at 25, and a day clamped to MIN_PLAUSIBLE_KG earns nothing
  // (PRD-v2 §4.4). Understating your day harder stops paying more.
  if (computed.answeredCount === 5 && !computed.clamped) {
    const points = reductionPoints(pct);
    if (points > 0) {
      await record(
        'reduction',
        `reduction:${logId}`,
        points,
        coinsFor(points),
        `${pct.toFixed(1)}% below baseline`,
      );
    }
  }

  // cycleIndex keeps the key unique across repeats: day 7 and day 14 are two
  // different grants, day 7 logged twice is one.
  if (streak.current > 0 && streak.current % 7 === 0) {
    const cycle = streak.current / 7;
    await record(
      'streak',
      `streak:${userId}:7:${cycle}`,
      REWARDS.streak7.points,
      REWARDS.streak7.coins,
      `${streak.current}-day streak`,
    );
  }
  if (streak.current > 0 && streak.current % 30 === 0) {
    const cycle = streak.current / 30;
    await record(
      'streak',
      `streak:${userId}:30:${cycle}`,
      REWARDS.streak30.points,
      REWARDS.streak30.coins,
      `${streak.current}-day streak`,
    );
  }

  return {
    grant: {
      pointsDelta: reasons.reduce((n, r) => n + r.points, 0),
      coinsDelta: reasons.reduce((n, r) => n + r.coins, 0),
      reasons,
    },
    wallet: { pointsTotal, coinsBalance },
  };
}

export type HistoryQuery = { from: string; to: string; granularity: 'day' | 'week' | 'month' };

/**
 * The footprint series.
 *
 * Week and month buckets AVERAGE the days present rather than summing them:
 * a partial week would otherwise look like a dramatic improvement purely
 * because fewer days were logged.
 */
export async function history(userId: number, query: HistoryQuery) {
  if (daysBetween(query.from, query.to) < 0) {
    throw new DomainError('GEN_400', '`from` must not be after `to`.', 400);
  }
  const rows = await repo.listFootprints(userId, query.from, query.to);
  const points = rows.map((r) => ({
    date: r.logDate,
    totalKg: round2(r.totalKg),
    baselineTotalKg: round2(r.baselineTotalKg),
    logged: r.dailyLogId !== null,
  }));

  if (query.granularity === 'day') return { points };

  const buckets = new Map<
    string,
    { total: number; baseline: number; n: number; logged: boolean }
  >();
  for (const p of points) {
    const key = query.granularity === 'month' ? p.date.slice(0, 7) : weekStart(p.date);
    const bucket = buckets.get(key) ?? { total: 0, baseline: 0, n: 0, logged: false };
    bucket.total += p.totalKg;
    bucket.baseline += p.baselineTotalKg;
    bucket.n += 1;
    bucket.logged ||= p.logged;
    buckets.set(key, bucket);
  }

  return {
    points: [...buckets.entries()].map(([key, b]) => ({
      date: query.granularity === 'month' ? `${key}-01` : key,
      totalKg: round2(b.total / b.n),
      baselineTotalKg: round2(b.baseline / b.n),
      logged: b.logged,
    })),
  };
}

/** ISO weeks start on Monday. */
function weekStart(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  return addDays(date, -day);
}

function breakdownOf(c: DailyFootprint) {
  return {
    transportKg: round2(c.transportKg),
    foodKg: round2(c.foodKg),
    homeEnergyKg: round2(c.homeEnergyKg),
    waterKg: round2(c.waterKg),
    wasteKg: round2(c.wasteKg),
    totalKg: round2(c.totalKg),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
