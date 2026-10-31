import type { CategorySources } from '@common/carbon/calculate.ts';
import { DomainError } from '@common/errors/domain-error.ts';
import { addDays, localDate } from '@common/time.ts';
import * as goals from '@modules/goals/goals.service.ts';
import * as leaderboard from '@modules/leaderboard/leaderboard.service.ts';
import * as profileRepo from '@modules/profile/profile.repository.ts';
import * as repo from './home.repository.ts';

/**
 * The whole Home screen in one response (PRD-v2 §6.2).
 *
 * Deliberately one request and, below, a single `Promise.all` — v1's
 * dashboard fired six separate SUM() queries plus a day-by-day loop on every
 * page load. Everything here is a read; nothing on this path writes, except
 * the lazy goal settlement that `goals.activeSummary` may perform.
 */

const CATEGORIES = ['transport', 'food', 'home_energy', 'water', 'waste'] as const;

/**
 * The wire contract declares all five source keys, so a stored row that
 * predates a category — or a partial write — must still produce a complete
 * object. Anything absent reads as `inferred`, which is the truthful answer:
 * if we cannot show that it was logged, it was not.
 */
function completeSources(stored: Record<string, string> | null | undefined): CategorySources {
  const read = (key: string): 'logged' | 'inferred' =>
    stored?.[key] === 'logged' ? 'logged' : 'inferred';
  return {
    transport: read('transport'),
    food: read('food'),
    home_energy: read('home_energy'),
    water: read('water'),
    waste: read('waste'),
  };
}

const ALL_INFERRED: CategorySources = completeSources(null);

const ZERO_BREAKDOWN = {
  transportKg: 0,
  foodKg: 0,
  homeEnergyKg: 0,
  waterKg: 0,
  wasteKg: 0,
  totalKg: 0,
};

export async function home(userId: number) {
  const [user, profile] = await Promise.all([
    profileRepo.findUser(userId),
    profileRepo.findProfile(userId),
  ]);
  if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);
  if (!profile || profile.baselineTotalKg === null) {
    // Without a baseline there is no "today vs baseline", which is the whole
    // screen. The client routes to the wizard on this code.
    throw new DomainError('ONB_003', 'Finish onboarding to see your home screen.', 403);
  }

  const today = localDate(user.timezone);
  const baselineTotalKg = profile.baselineTotalKg;

  const [thisWeek, lastWeek, avg30, goal, peek, next] = await Promise.all([
    repo.footprintsBetween(userId, addDays(today, -6), today),
    repo.footprintsBetween(userId, addDays(today, -13), addDays(today, -7)),
    repo.averageBreakdown(userId, addDays(today, -29), today),
    goals.activeSummary(userId, user.timezone),
    leaderboard.peek(userId),
    repo.nextEvent(userId),
  ]);

  return {
    // First word only: the screen greets, it does not address formally.
    greetingName: user.name.trim().split(/\s+/)[0] ?? user.name,
    wallet: { pointsTotal: user.pointsTotal, coinsBalance: user.coinsBalance },
    today: todayCard(thisWeek, today, baselineTotalKg),
    streak: { current: user.currentStreak, longest: user.longestStreak },
    week: weekCard(thisWeek, lastWeek, today),
    breakdown30d: avg30 ? round(avg30) : ZERO_BREAKDOWN,
    activeGoal: goal
      ? {
          id: goal.id,
          label: goalLabel(goal),
          progressPct: goal.progressPct,
          daysLeft: goal.daysLeft,
          onTrack: goal.onTrack,
        }
      : null,
    leaderboard: {
      top: peek.topThree.map((r) => ({
        id: r.id,
        name: r.name,
        avatarUrl: r.avatarUrl,
        city: r.city,
        pointsTotal: r.pointsTotal,
        rank: r.rank,
      })),
      me: { rank: peek.myRank, pointsTotal: user.pointsTotal },
    },
    nextEvent: next
      ? {
          id: next.id,
          slug: next.slug,
          title: next.title,
          startAt: next.startAt.toISOString(),
          venueName: next.venueName,
          // A host has no pass of their own unless they also registered.
          passReady: next.passId !== null,
        }
      : null,
  };
}

type FootprintRow = Awaited<ReturnType<typeof repo.footprintsBetween>>[number];

/**
 * Today's card.
 *
 * `logged` is false when there is no row at all, which is what drives the
 * "Log today" call to action. A row with every category inferred still
 * counts as logged — the user did submit something — but `inferredCount`
 * says how much of it was filled in from the baseline, because a number
 * built from four inferences should not be shown with the confidence of a
 * fully answered day.
 */
function todayCard(week: FootprintRow[], today: string, baselineTotalKg: number) {
  const row = week.find((r) => r.logDate === today);

  if (!row) {
    return {
      date: today,
      logged: false,
      breakdown: ZERO_BREAKDOWN,
      baselineTotalKg: round2(baselineTotalKg),
      deltaKg: 0,
      percentOfBaseline: 0,
      sources: ALL_INFERRED,
      inferredCount: CATEGORIES.length,
    };
  }

  const sources = completeSources(row.sources);
  return {
    date: today,
    logged: row.dailyLogId !== null,
    breakdown: round(row),
    baselineTotalKg: round2(row.baselineTotalKg),
    deltaKg: round2(row.totalKg - row.baselineTotalKg),
    percentOfBaseline:
      row.baselineTotalKg > 0 ? round2((row.totalKg / row.baselineTotalKg) * 100) : 0,
    sources,
    inferredCount: CATEGORIES.filter((c) => sources[c] !== 'logged').length,
  };
}

/**
 * The seven-day sparkline and the week-on-week change.
 *
 * The sparkline has one point per calendar day, including days with no row,
 * so the chart's x-axis is time rather than "days that happen to have data".
 * A gap plotted as a zero would read as a perfect day.
 *
 * The averages, by contrast, divide by days that HAVE data: averaging a
 * missing day as zero would make not logging look like an improvement.
 */
function weekCard(thisWeek: FootprintRow[], lastWeek: FootprintRow[], today: string) {
  const byDate = new Map(thisWeek.map((r) => [r.logDate, r.totalKg]));
  const sparkline = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i - 6);
    return { date, totalKg: round2(byDate.get(date) ?? 0) };
  });

  const avg = (rows: FootprintRow[]) =>
    rows.length === 0 ? 0 : rows.reduce((n, r) => n + r.totalKg, 0) / rows.length;

  const current = avg(thisWeek);
  const previous = avg(lastWeek);

  return {
    sparkline,
    avgKgPerDay: round2(current),
    // No previous week to compare against is 0% change, not an infinite
    // improvement from nothing.
    changeVsLastWeekPct: previous > 0 ? round2(((current - previous) / previous) * 100) : 0,
  };
}

function goalLabel(goal: { type: string; period: string; targetKgTotal: number }) {
  const period = goal.period === 'quarter' ? 'this quarter' : `this ${goal.period}`;
  return goal.type === 'reduce_percent'
    ? `Reduction goal ${period}`
    : `Stay under ${round2(goal.targetKgTotal)} kg ${period}`;
}

function round(b: {
  transportKg: number;
  foodKg: number;
  homeEnergyKg: number;
  waterKg: number;
  wasteKg: number;
  totalKg: number;
}) {
  return {
    transportKg: round2(b.transportKg),
    foodKg: round2(b.foodKg),
    homeEnergyKg: round2(b.homeEnergyKg),
    waterKg: round2(b.waterKg),
    wasteKg: round2(b.wasteKg),
    totalKg: round2(b.totalKg),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
