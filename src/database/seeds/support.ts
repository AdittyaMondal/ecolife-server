import type { db } from '@database/client.ts';
import type { rewardTransactions } from '@database/schema/index.ts';

/** The transaction handle every seeder writes through, so a failed seed leaves no half-world. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RewardRow = typeof rewardTransactions.$inferInsert;

/**
 * Seeded PRNG (mulberry32).
 *
 * `Math.random()` would give a different world on every run, which makes the
 * reconciliation summary impossible to diff and "it only happens with this
 * data" impossible to reproduce. One fixed seed, one world.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in [lo, hi). */
export const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);

/** Uniform integer in [lo, hi], inclusive. */
export const intBetween = (r: () => number, lo: number, hi: number) =>
  Math.floor(between(r, lo, hi + 1));

export const pick = <T>(r: () => number, items: readonly T[]): T => {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error('pick() from an empty list');
  return item;
};

/**
 * Every seeded user is `Asia/Kolkata`, and every "today" in this product is the
 * user's local date rather than the server's (PRD-v2 §7.3). Seeding in UTC
 * would put a whole day's logs on the wrong date for anyone in IST.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const istNow = () => new Date(Date.now() + IST_OFFSET_MS);

/** `YYYY-MM-DD` in IST, `daysAgo` days back. The format the `date` columns take. */
export function istDate(daysAgo: number): string {
  const d = new Date(istNow().getTime() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** A timestamptz `hour` o'clock IST, `daysAgo` days back. */
export function istMoment(daysAgo: number, hour: number): Date {
  const day = istDate(daysAgo);
  return new Date(`${day}T${String(hour).padStart(2, '0')}:00:00+05:30`);
}

export const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

/**
 * Inserts in batches.
 *
 * A single multi-row insert of 1400 footprints exceeds node-postgres' 65535
 * bound-parameter ceiling, and the failure arrives as a protocol error rather
 * than anything that names the real cause.
 */
export async function insertAll<T>(
  rows: readonly T[],
  insert: (batch: T[]) => Promise<unknown>,
  size = 400,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
  }
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
