import { DomainError } from '@common/errors/domain-error.ts';

/**
 * Keyset pagination (PRD-v2 §8).
 *
 * OFFSET is deliberately not used: it re-scans every skipped row, and on a
 * feed that gains rows while the reader pages through it, page 2 silently
 * repeats or drops items. A cursor anchors on the last row actually seen, so
 * neither happens.
 *
 * The cursor is base64 so that it reads as opaque. It is NOT a secret and is
 * NOT tamper-proof — never derive authorisation from one. Every caller
 * combines it with a `user_id` predicate, so the worst a forged cursor can do
 * is page the forger's own rows from an odd place.
 */

export function encodeCursor(value: number | string): string {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

/** Decodes a positive-integer cursor, or throws 400. Absent is not an error. */
export function decodeIdCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new DomainError('GEN_400', 'Invalid cursor.', 400);
  }
  return id;
}

/** Decodes an opaque string cursor (a date, a composite key), or throws 400. */
export function decodeStringCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!raw) throw new DomainError('GEN_400', 'Invalid cursor.', 400);
  return raw;
}

export type Page<T> = { items: T[]; pageInfo: { nextCursor: string | null; hasMore: boolean } };

/**
 * Turns `limit + 1` rows into a page.
 *
 * Always query one more row than the client asked for: that extra row is how
 * `hasMore` is known without a second COUNT query, and dropping it is what
 * keeps the page the size the client requested.
 */
export function toPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => number | string,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    pageInfo: {
      nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
      hasMore,
    },
  };
}
