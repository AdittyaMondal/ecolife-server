import { db } from '@database/client.ts';
import { rewardTransactions, users } from '@database/schema/index.ts';
import { and, eq, isNull, sql } from 'drizzle-orm';

/**
 * Every Drizzle query for the leaderboard.
 *
 * Ranking happens in SQL, with a window function. `[LESSON]` v1 loaded every
 * user into memory and ranked by array index, which is both O(n) memory per
 * request and silently wrong once two users tie — array order is not a rank.
 *
 * Every ordering here breaks ties on `users.id ASC`. Without a tiebreak two
 * users on equal points swap places between requests, so paging by cursor
 * would skip one and repeat the other.
 */

export type Period = 'all' | 'month' | 'week';
export type Scope = 'global' | 'city';

export type RankedRow = {
  id: number;
  name: string;
  avatarUrl: string | null;
  city: string | null;
  rank: number;
  pointsTotal: number;
  currentStreak: number;
};

/**
 * One ranked page.
 *
 * `period` changes what is ranked, not merely what is filtered:
 *
 *   all    — the lifetime `users.points_total` cache.
 *   month  — points EARNED in the window, summed from the ledger. A user who
 *   week     earned nothing in the window ranks 0, not by their lifetime
 *            total, which is the whole point of a windowed board.
 *
 * Only positive `points_delta` counts. Points are never deducted in practice,
 * but a future admin correction must not let someone climb a weekly board by
 * having had points taken away.
 */
export async function rankedPage(opts: {
  period: Period;
  scope: Scope;
  city: string | null;
  afterRank: number;
  limit: number;
}): Promise<RankedRow[]> {
  const cityFilter =
    opts.scope === 'city' && opts.city ? sql`and lower(u.city) = lower(${opts.city})` : sql``;

  // A windowed board sums the ledger; the all-time board reads the cache that
  // the ledger maintains. Both end up as one integer per user called `score`.
  const score =
    opts.period === 'all'
      ? sql`u.points_total`
      : sql`coalesce((
            select sum(r.points_delta)::int
              from ${rewardTransactions} r
             where r.user_id = u.id
               and r.points_delta > 0
               and r.created_at >= now() - ${sql.raw(opts.period === 'week' ? "interval '7 days'" : "interval '30 days'")}
          ), 0)`;

  const rows = await db.execute(sql`
    with ranked as (
      select u.id,
             u.name,
             u.avatar_url,
             u.city,
             u.current_streak,
             ${score} as score,
             rank() over (order by ${score} desc, u.id asc) as rank
        from ${users} u
       where u.deleted_at is null
         ${cityFilter}
    )
    select * from ranked
     where rank > ${opts.afterRank}
     order by rank asc
     limit ${opts.limit}
  `);

  return rows.rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    avatarUrl: (r.avatar_url as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    rank: Number(r.rank),
    pointsTotal: Number(r.score),
    currentStreak: Number(r.current_streak),
  }));
}

/**
 * One user's all-time standing.
 *
 * Computed with the same window function and the same tiebreak as the board,
 * so "you are #12" and page 1 of the board cannot disagree.
 */
export async function myStanding(userId: number) {
  const rows = await db.execute(sql`
    with ranked as (
      select u.id,
             u.points_total,
             rank() over (order by u.points_total desc, u.id asc) as rank,
             count(*) over () as total
        from ${users} u
       where u.deleted_at is null
    )
    select rank, points_total, total from ranked where id = ${userId}
  `);

  const row = rows.rows[0];
  if (!row) return null;
  return {
    rank: Number(row.rank),
    pointsTotal: Number(row.points_total),
    totalRanked: Number(row.total),
  };
}

/** The rows immediately above and below a rank, for the Home peek. */
export async function neighbours(rank: number, span: number): Promise<RankedRow[]> {
  const rows = await db.execute(sql`
    with ranked as (
      select u.id, u.name, u.avatar_url, u.city, u.current_streak, u.points_total,
             rank() over (order by u.points_total desc, u.id asc) as rank
        from ${users} u
       where u.deleted_at is null
    )
    select * from ranked
     where rank between ${Math.max(1, rank - span)} and ${rank + span}
     order by rank asc
  `);
  return rows.rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    avatarUrl: (r.avatar_url as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    rank: Number(r.rank),
    pointsTotal: Number(r.points_total),
    currentStreak: Number(r.current_streak),
  }));
}

/** The caller's city, used to scope a city board. */
export async function cityOf(userId: number) {
  const [row] = await db
    .select({ city: users.city })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  return row?.city ?? null;
}
