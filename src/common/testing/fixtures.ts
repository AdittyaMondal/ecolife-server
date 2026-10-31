import { issueAccessToken } from '@common/auth/tokens.ts';
import { computeDailyBaseline } from '@common/carbon/calculate.ts';
import { db } from '@database/client.ts';
import { lifestyleProfiles, users } from '@database/schema/index.ts';
import { eq } from 'drizzle-orm';

/**
 * An onboarded user, inserted directly.
 *
 * Driving onboarding through HTTP costs eight round trips per user, and at
 * Neon's latency a test that needs one spends ten seconds before it starts
 * testing anything. Worse, every goals or home test would then be re-testing
 * the onboarding wizard, so a wizard bug would fail fifty tests and tell you
 * nothing about which.
 *
 * The baseline is computed with the REAL engine rather than hardcoded, so a
 * fixture cannot drift from what `/profile/onboarding/complete` would have
 * produced for the same answers.
 *
 * Only for tests whose subject is something else. The onboarding flow itself
 * is covered through HTTP in profile.test.ts, as it must be.
 */

const ANSWERS = {
  householdSize: 3,
  city: 'Pune',
  regionCode: 'IN-MH',
  coolingUsage: 'ac_occasional',
  dietType: 'non_veg_daily',
  foodWasteLevel: 'medium',
  packagedFoodFreq: 'often',
  primaryCommuteMode: 'car',
  vehicleFuel: 'petrol',
  commuteDistanceKm: 18,
  flightsPerYear: 1,
  electricityKwhMonth: 280,
  kwhSource: 'reported',
  cookingFuel: 'lpg',
  hasSolar: false,
  waterUsageLevel: 'high',
  wasteHabit: 'none',
} as const;

export type Fixture = {
  userId: number;
  token: string;
  email: string;
  baselinePerDay: number;
};

/** `@example.test` so the preload's cleanup owns and removes it. */
export async function createOnboardedUser(
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<Fixture> {
  const email = `fx-${crypto.randomUUID()}@example.test`;

  const [user] = await db
    .insert(users)
    .values({
      name: 'Fixture User',
      email,
      // Never a usable credential: these fixtures are not signed in through
      // /auth/login, they are handed a token directly.
      passwordHash: 'x',
      emailVerifiedAt: new Date(),
      timezone: 'Asia/Kolkata',
      city: ANSWERS.city,
      regionCode: ANSWERS.regionCode,
      onboardedAt: new Date(),
      ...overrides,
    })
    .returning({ id: users.id, role: users.role });
  if (!user) throw new Error('fixture user insert returned nothing');

  const baseline = computeDailyBaseline({ ...ANSWERS, dietType: ANSWERS.dietType }, null);

  await db.insert(lifestyleProfiles).values({
    userId: user.id,
    ...ANSWERS,
    completedSteps: 5,
    baselineTransportKg: baseline.baselineTransportKg,
    baselineFoodKg: baseline.baselineFoodKg,
    baselineHomeEnergyKg: baseline.baselineHomeEnergyKg,
    baselineWaterKg: baseline.baselineWaterKg,
    baselineWasteKg: baseline.baselineWasteKg,
    baselineTotalKg: baseline.baselineTotalKg,
    baselineFlightKg: baseline.baselineFlightKg,
    baselineCookKg: baseline.baselineCookKg,
    baselineGridBaseKg: baseline.baselineGridBaseKg,
    factorVersion: baseline.factorVersion,
  });

  const { token } = await issueAccessToken({ sub: String(user.id), role: user.role });
  return { userId: user.id, token, email, baselinePerDay: baseline.baselineTotalKg };
}

/** Wallet and streak, for asserting what a flow actually credited. */
export async function readUser(userId: number) {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row ?? null;
}
