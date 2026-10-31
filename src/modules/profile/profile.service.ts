import { revokeAllSessions } from '@common/auth/session.ts';
import { type BaselineProfile, computeDailyBaseline } from '@common/carbon/calculate.ts';
import { DomainError } from '@common/errors/domain-error.ts';
import { decodeIdCursor, type Page, toPage } from '@common/pagination.ts';
import { award, canEarn, REWARDS, type RewardSource } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import type { z } from '@hono/zod-openapi';
import * as reference from '@modules/reference/reference.repository.ts';
import * as repo from './profile.repository.ts';
import {
  step1Schema,
  step2Schema,
  step3Schema,
  step4Schema,
  step5Schema,
} from './profile.schema.ts';

/**
 * Onboarding (PRD-v2 §3.2) and the own/public profile.
 *
 * Each of the five steps is its own request so a dropped connection never
 * loses the whole form, and the wizard resumes on any device because the
 * answers live on the server rather than in a DOM form.
 */

const STEP_SCHEMAS = [step1Schema, step2Schema, step3Schema, step4Schema, step5Schema] as const;

/** Which profile columns belong to which step — the completeness check. */
const STEP_FIELDS = [
  ['householdSize', 'city', 'regionCode', 'coolingUsage'],
  ['dietType', 'foodWasteLevel', 'packagedFoodFreq'],
  ['primaryCommuteMode', 'vehicleFuel', 'commuteDistanceKm', 'flightsPerYear'],
  ['kwhSource', 'cookingFuel', 'hasSolar'],
  ['waterUsageLevel', 'wasteHabit'],
] as const satisfies readonly (readonly string[])[];

type ProfileRow = NonNullable<Awaited<ReturnType<typeof repo.findProfile>>>;

/**
 * Steps answered, derived from the stored columns rather than from a counter.
 *
 * A counter can be incremented by a client that jumps to step 5, and then
 * `complete` would be true over four unanswered steps. The columns cannot
 * lie, so `completed_steps` is kept as a cache of this and never as the
 * source of truth.
 */
function answeredSteps(profile: ProfileRow): number {
  let n = 0;
  for (const fields of STEP_FIELDS) {
    const done = fields.every((f) => profile[f as keyof ProfileRow] !== null);
    if (!done) break;
    n += 1;
  }
  return n;
}

/** Which steps are answered regardless of order, for the completion error. */
function missingSteps(profile: ProfileRow): number[] {
  return STEP_FIELDS.flatMap((fields, i) =>
    fields.every((f) => profile[f as keyof ProfileRow] !== null) ? [] : [i + 1],
  );
}

function answersOf(profile: ProfileRow) {
  return {
    householdSize: profile.householdSize ?? undefined,
    city: profile.city ?? undefined,
    regionCode: profile.regionCode ?? undefined,
    coolingUsage: profile.coolingUsage ?? undefined,
    dietType: profile.dietType ?? undefined,
    foodWasteLevel: profile.foodWasteLevel ?? undefined,
    packagedFoodFreq: profile.packagedFoodFreq ?? undefined,
    primaryCommuteMode: profile.primaryCommuteMode ?? undefined,
    vehicleFuel: profile.vehicleFuel ?? undefined,
    commuteDistanceKm: profile.commuteDistanceKm ?? undefined,
    flightsPerYear: profile.flightsPerYear ?? undefined,
    electricityKwhMonth: profile.electricityKwhMonth,
    electricityBillInr: profile.electricityBillInr ?? undefined,
    kwhSource: profile.kwhSource ?? undefined,
    cookingFuel: profile.cookingFuel ?? undefined,
    hasSolar: profile.hasSolar ?? undefined,
    waterUsageLevel: profile.waterUsageLevel ?? undefined,
    wasteHabit: profile.wasteHabit ?? undefined,
  };
}

function stateOf(profile: ProfileRow) {
  const completedSteps = answeredSteps(profile);
  return {
    completedSteps,
    complete: completedSteps === 5,
    answers: answersOf(profile),
  };
}

export async function onboardingState(userId: number) {
  return stateOf(await repo.ensureProfile(userId));
}

/**
 * Persists one step.
 *
 * The route validates the body against a UNION of the five step schemas, which
 * accepts a step-3 body posted to step 1. So the step in the path is
 * re-validated here against its own schema — the union is a wire-level check,
 * not a semantic one.
 */
export async function saveStep(userId: number, step: number, body: unknown) {
  const profile = await repo.ensureProfile(userId);
  if (profile.completedSteps >= 5 && answeredSteps(profile) === 5) {
    // Editing after completion goes through PATCH /profile, which recomputes
    // the baseline forward. The wizard route would skip that.
    throw new DomainError(
      'ONB_002',
      'Onboarding is already complete. Edit your profile instead.',
      409,
    );
  }

  const schema = STEP_SCHEMAS[step - 1];
  if (!schema) throw new DomainError('ONB_001', 'Unknown onboarding step.', 422, { step });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new DomainError('ONB_001', `Payload does not match step ${step}.`, 422, {
      step,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const patch = await stepPatch(step, parsed.data, profile);
  const updated = await repo.updateProfile(userId, patch);
  if (!updated) throw new DomainError('ONB_001', 'Could not save this step.', 422);

  // Keep the cached counter honest with the columns it summarises.
  const completedSteps = answeredSteps(updated);
  if (completedSteps !== updated.completedSteps) {
    const synced = await repo.updateProfile(userId, { completedSteps });
    if (synced) return stateOf(synced);
  }
  return stateOf(updated);
}

/**
 * Step 1 also lands on `users` (city and region drive the leaderboard scope
 * and the grid factor), and step 4 resolves a monthly bill into kWh.
 */
async function stepPatch(
  step: number,
  data: unknown,
  profile: ProfileRow,
): Promise<repo.ProfilePatch> {
  if (step === 1) {
    const d = data as z.infer<typeof step1Schema>;
    return {
      householdSize: d.householdSize,
      city: d.city,
      regionCode: d.regionCode,
      coolingUsage: d.coolingUsage,
    };
  }
  if (step === 2) {
    const d = data as z.infer<typeof step2Schema>;
    return {
      dietType: d.dietType,
      foodWasteLevel: d.foodWasteLevel,
      packagedFoodFreq: d.packagedFoodFreq,
    };
  }
  if (step === 3) {
    const d = data as z.infer<typeof step3Schema>;
    return {
      primaryCommuteMode: d.primaryCommuteMode,
      vehicleFuel: d.vehicleFuel,
      commuteDistanceKm: d.commuteDistanceKm,
      flightsPerYear: d.flightsPerYear,
    };
  }
  if (step === 4) {
    const d = data as z.infer<typeof step4Schema>;
    return {
      electricityKwhMonth: await resolveKwh(d, profile.regionCode),
      electricityBillInr: d.electricityBillInr ?? null,
      kwhSource: d.kwhSource,
      cookingFuel: d.cookingFuel,
      hasSolar: d.hasSolar,
    };
  }
  const d = data as z.infer<typeof step5Schema>;
  return { waterUsageLevel: d.waterUsageLevel, wasteHabit: d.wasteHabit };
}

/**
 * `from_bill` divides the rupee bill by the region's seeded tariff.
 *
 * Done here rather than in the carbon engine because it needs the `regions`
 * table, and the engine is deliberately I/O-free. A bill with no resolvable
 * region falls through to null, which makes `resolveKwhMonth` use Appendix A's
 * estimator — the honest answer, and `kwh_source` already says it is derived.
 */
async function resolveKwh(
  d: z.infer<typeof step4Schema>,
  regionCode: string | null,
): Promise<number | null> {
  if (d.kwhSource !== 'from_bill' || !d.electricityBillInr) return d.electricityKwhMonth;

  // Step 1 writes the region, so by step 4 it is normally present. If the
  // user jumped straight here it is not, and rather than guess a tariff we
  // return null — `resolveKwhMonth` then uses Appendix A's estimator, and
  // `kwh_source` already tells the UI the figure is derived.
  const region = regionCode ? await reference.findRegion(regionCode) : null;
  if (!region) return null;

  // Bill is whole rupees, tariff is paise per kWh.
  const kwh = (d.electricityBillInr * 100) / region.tariffPaisePerKwh;
  return Number.isFinite(kwh) && kwh > 0 ? Math.round(kwh * 10) / 10 : null;
}

/**
 * Validates all 15 answers, computes the baseline, awards the completion
 * reward. Idempotent: calling it twice returns the same wallet and awards
 * nothing the second time.
 */
export async function completeOnboarding(userId: number) {
  const profile = await repo.ensureProfile(userId);
  const missing = missingSteps(profile);
  if (missing.length > 0) {
    throw new DomainError('ONB_001', 'Some onboarding steps are still unanswered.', 422, {
      missingSteps: missing,
    });
  }

  const region = profile.regionCode ? await reference.findRegion(profile.regionCode) : null;
  const baseline = computeDailyBaseline(toBaselineProfile(profile), region);

  /**
   * Verification gates the REWARD, not the baseline (PRD-v2 §4.4).
   *
   * This used to throw, which meant an unverified account could never
   * finish onboarding, never get a baseline, and therefore never log a day
   * or open Home — the gate took the entire product with it. The baseline
   * is something the user is entitled to see the moment they answer the
   * fifteen questions; only the 100 points wait for verification, and
   * `verifyEmail` grants them the moment it arrives.
   */
  const earns = await canEarn(db, userId);

  const result = await db.transaction(async (tx) => {
    await repo.updateProfile(
      userId,
      {
        baselineTransportKg: baseline.baselineTransportKg,
        baselineFoodKg: baseline.baselineFoodKg,
        baselineHomeEnergyKg: baseline.baselineHomeEnergyKg,
        baselineWaterKg: baseline.baselineWaterKg,
        baselineWasteKg: baseline.baselineWasteKg,
        baselineTotalKg: baseline.baselineTotalKg,
        baselineFlightKg: baseline.baselineFlightKg,
        baselineCookKg: baseline.baselineCookKg,
        baselineGridBaseKg: baseline.baselineGridBaseKg,
        electricityKwhMonth: baseline.kwhMonth,
        kwhSource: baseline.kwhSource,
        completedSteps: 5,
        factorVersion: baseline.factorVersion,
      },
      tx,
    );

    await repo.updateUser(
      userId,
      {
        city: profile.city,
        regionCode: profile.regionCode,
        onboardedAt: new Date(),
      },
      tx,
    );

    if (!earns) {
      const user = await repo.findUser(userId);
      return {
        awarded: false,
        pointsTotal: user?.pointsTotal ?? 0,
        coinsBalance: user?.coinsBalance ?? 0,
      };
    }

    // `onboarding:{userId}` — one grant per user, for all time.
    return award(tx, {
      userId,
      pointsDelta: REWARDS.onboarding.points,
      coinsDelta: REWARDS.onboarding.coins,
      source: 'onboarding',
      sourceId: `onboarding:${userId}`,
      note: 'Completed onboarding',
    });
  });

  return {
    baseline: toBreakdown(baseline),
    wallet: { pointsTotal: result.pointsTotal, coinsBalance: result.coinsBalance },
    pointsAwarded: result.awarded ? REWARDS.onboarding.points : 0,
    coinsAwarded: result.awarded ? REWARDS.onboarding.coins : 0,
  };
}

export function toBaselineProfile(profile: ProfileRow): BaselineProfile {
  return {
    householdSize: profile.householdSize,
    coolingUsage: profile.coolingUsage,
    dietType: profile.dietType,
    foodWasteLevel: profile.foodWasteLevel,
    packagedFoodFreq: profile.packagedFoodFreq,
    primaryCommuteMode: profile.primaryCommuteMode,
    vehicleFuel: profile.vehicleFuel,
    commuteDistanceKm: profile.commuteDistanceKm,
    flightsPerYear: profile.flightsPerYear,
    electricityKwhMonth: profile.electricityKwhMonth,
    kwhSource: profile.kwhSource,
    cookingFuel: profile.cookingFuel,
    hasSolar: profile.hasSolar,
    waterUsageLevel: profile.waterUsageLevel,
    wasteHabit: profile.wasteHabit,
  };
}

function toBreakdown(b: {
  baselineTransportKg: number;
  baselineFoodKg: number;
  baselineHomeEnergyKg: number;
  baselineWaterKg: number;
  baselineWasteKg: number;
  baselineTotalKg: number;
}) {
  return {
    transportKg: b.baselineTransportKg,
    foodKg: b.baselineFoodKg,
    homeEnergyKg: b.baselineHomeEnergyKg,
    waterKg: b.baselineWaterKg,
    wasteKg: b.baselineWasteKg,
    totalKg: b.baselineTotalKg,
  };
}

/** The stored baseline, or zeros when onboarding has not been completed. */
function storedBaseline(profile: ProfileRow) {
  return {
    transportKg: profile.baselineTransportKg ?? 0,
    foodKg: profile.baselineFoodKg ?? 0,
    homeEnergyKg: profile.baselineHomeEnergyKg ?? 0,
    waterKg: profile.baselineWaterKg ?? 0,
    wasteKg: profile.baselineWasteKg ?? 0,
    totalKg: profile.baselineTotalKg ?? 0,
  };
}

export async function ownProfile(userId: number) {
  const [user, profile] = await Promise.all([repo.findUser(userId), repo.ensureProfile(userId)]);
  if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);

  return {
    user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl, city: user.city },
    timezone: user.timezone,
    wallet: { pointsTotal: user.pointsTotal, coinsBalance: user.coinsBalance },
    baseline: storedBaseline(profile),
    answers: answersOf(profile),
    memberSince: user.createdAt.toISOString(),
  };
}

export type ProfilePatchBody = {
  name?: string;
  timezone?: string;
  avatarUrl?: string | null;
  answers?: Record<string, unknown>;
};

/**
 * Edits settings and/or lifestyle answers.
 *
 * Recomputes the baseline FORWARD only. Past `daily_footprints` rows carry
 * their own `baseline_total_kg` snapshot, so yesterday's reduction percentage
 * cannot move because the user changed their diet today (PRD-v2 §3.3) — which
 * is also why v2 needs no profile-history table.
 */
export async function patchProfile(userId: number, body: ProfilePatchBody) {
  const existing = await repo.ensureProfile(userId);

  const userPatch: Parameters<typeof repo.updateUser>[1] = {};
  if (body.name !== undefined) userPatch.name = body.name;
  if (body.timezone !== undefined) userPatch.timezone = body.timezone;
  if (body.avatarUrl !== undefined) userPatch.avatarUrl = body.avatarUrl;

  const answers = body.answers ?? {};
  const profilePatch: repo.ProfilePatch = {};
  for (const [key, value] of Object.entries(answers)) {
    if (value === undefined) continue;
    (profilePatch as Record<string, unknown>)[key] = value;
  }

  await db.transaction(async (tx) => {
    if (Object.keys(userPatch).length > 0) await repo.updateUser(userId, userPatch, tx);
    if (Object.keys(profilePatch).length === 0) return;

    const merged = { ...existing, ...profilePatch } as ProfileRow;
    if (merged.city !== undefined) {
      await repo.updateUser(userId, { city: merged.city, regionCode: merged.regionCode }, tx);
    }

    // Only recompute once the 15 answers are all present. Half a profile has
    // no meaningful baseline, and writing one would make `complete` lie.
    if (missingSteps(merged).length === 0) {
      const region = merged.regionCode ? await reference.findRegion(merged.regionCode) : null;
      const b = computeDailyBaseline(toBaselineProfile(merged), region);
      Object.assign(profilePatch, {
        baselineTransportKg: b.baselineTransportKg,
        baselineFoodKg: b.baselineFoodKg,
        baselineHomeEnergyKg: b.baselineHomeEnergyKg,
        baselineWaterKg: b.baselineWaterKg,
        baselineWasteKg: b.baselineWasteKg,
        baselineTotalKg: b.baselineTotalKg,
        baselineFlightKg: b.baselineFlightKg,
        baselineCookKg: b.baselineCookKg,
        baselineGridBaseKg: b.baselineGridBaseKg,
        electricityKwhMonth: b.kwhMonth,
        kwhSource: b.kwhSource,
        factorVersion: b.factorVersion,
      });
    }
    await repo.updateProfile(userId, profilePatch, tx);
  });

  return ownProfile(userId);
}

export type RewardEntryView = {
  id: number;
  pointsDelta: number;
  coinsDelta: number;
  source: RewardSource;
  note: string | null;
  createdAt: string;
};

export async function rewards(
  userId: number,
  limit: number,
  cursor: string | undefined,
): Promise<Page<RewardEntryView>> {
  const rows = await repo.listRewards(userId, limit, decodeIdCursor(cursor));
  const page = toPage(rows, limit, (r) => r.id);
  return {
    items: page.items.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    pageInfo: page.pageInfo,
  };
}

export async function publicProfile(userId: number) {
  const row = await repo.findPublicProfile(userId);
  if (!row) throw new DomainError('GEN_404', 'User not found.', 404);
  return {
    user: { id: row.id, name: row.name, avatarUrl: row.avatarUrl, city: row.city },
    pointsTotal: row.pointsTotal,
    globalRank: row.globalRank,
    currentStreak: row.currentStreak,
    eventsAttended: row.eventsAttended,
    memberSince: row.createdAt.toISOString(),
  };
}

export function exportData(userId: number) {
  return repo.exportUser(userId);
}

/**
 * Soft-delete and anonymise (PRD-v2 §6.8).
 *
 * Every refresh token is revoked, so the account cannot be re-entered. The
 * access token already issued keeps working until it expires — at most 15
 * minutes. Closing that window would mean a database read on every
 * authenticated request to check `deleted_at`, which is a real cost on every
 * endpoint to shorten one 15-minute tail on a self-service action the user
 * just performed themselves.
 */
export async function deleteAccount(userId: number) {
  await revokeAllSessions(userId);
  await repo.anonymise(userId);
  // Already deleted is the same answer as just deleted: the caller asked for
  // the account to be gone, and it is.
  return { deleted: true as const };
}
