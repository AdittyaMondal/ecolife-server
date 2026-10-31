import { decodeIdCursor, encodeCursor, type Page } from '@common/pagination.ts';
import * as repo from './leaderboard.repository.ts';

/**
 * Points ranking (PRD-v2 §6.7).
 *
 * Points, never coins: spending coins in the marketplace must not move you
 * down the board. That separation is why the two are different columns.
 */

export type LeaderboardRow = repo.RankedRow & { isMe: boolean };

/**
 * The cursor is the last RANK on the page, not a row id.
 *
 * Rank is the ordering key, so resuming from it is exact even when scores
 * change between pages — an id cursor would need the score as well to know
 * where it sat.
 */
export async function board(
  userId: number,
  query: { period: repo.Period; scope: repo.Scope; cursor?: string; limit: number },
): Promise<Page<LeaderboardRow>> {
  const afterRank = decodeIdCursor(query.cursor) ?? 0;
  const city = query.scope === 'city' ? await repo.cityOf(userId) : null;

  // One extra row, to know whether there is a next page without a COUNT.
  const rows = await repo.rankedPage({
    period: query.period,
    scope: query.scope,
    city,
    afterRank,
    limit: query.limit + 1,
  });

  const hasMore = rows.length > query.limit;
  const items = (hasMore ? rows.slice(0, query.limit) : rows).map((r) => ({
    ...r,
    isMe: r.id === userId,
  }));
  const last = items.at(-1);

  return {
    items,
    pageInfo: {
      nextCursor: hasMore && last ? encodeCursor(last.rank) : null,
      hasMore,
    },
  };
}

/**
 * Own standing, without paging to it.
 *
 * `percentile` is "better than this share of everyone", so rank 1 of 100 is
 * 99 and last place is 0. A user with no rank at all — deleted mid-request —
 * gets nulls rather than a confident zero.
 */
export async function myRank(userId: number) {
  const standing = await repo.myStanding(userId);
  if (!standing) return { rank: null, pointsTotal: 0, totalRanked: 0, percentile: 0 };

  const { rank, pointsTotal, totalRanked } = standing;
  const percentile =
    totalRanked > 1 ? Math.round(((totalRanked - rank) / (totalRanked - 1)) * 1000) / 10 : 100;

  return { rank, pointsTotal, totalRanked, percentile };
}

/** Top three plus the rows either side of the caller, for the Home screen. */
export async function peek(userId: number) {
  const [standing, top] = await Promise.all([
    repo.myStanding(userId),
    repo.rankedPage({ period: 'all', scope: 'global', city: null, afterRank: 0, limit: 3 }),
  ]);

  const topThree = top.map((r) => ({ ...r, isMe: r.id === userId }));
  if (!standing) return { myRank: null, topThree, neighbours: [] };

  // Nothing to show either side when the caller is already in the top three.
  const around =
    standing.rank <= 3
      ? []
      : (await repo.neighbours(standing.rank, 1)).map((r) => ({ ...r, isMe: r.id === userId }));

  return { myRank: standing.rank, topThree, neighbours: around };
}
