import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { db } from '@database/client.ts';
import { treeRarities, trees } from '@database/schema/index.ts';
import { eq, sql } from 'drizzle-orm';
import { app } from '../../src/app.ts';

/** The tree catalogue (PRD-v2 §4.5). Part 1: rarities and the catalogue. */

const TIMEOUT = 30_000;

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...freshIpHeaders(),
      ...(init.headers ?? {}),
    },
  });

type Envelope = {
  status: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary response JSON
  data: any;
  // biome-ignore lint/suspicious/noExplicitAny: details differ per error code
  error: { code: string; message: string; details: any };
};
const json = async (r: Response) => (await r.json()) as unknown as Envelope;

/** Constraint names live on `error.cause`, never in the message (CLAUDE.md §6). */
const constraintOf = (err: unknown) =>
  (err as { cause?: { constraint?: string } })?.cause?.constraint;

/**
 * This file owns the `test-` slug namespace in `trees` and `tree_rarities`,
 * and sweeps it both before and after. Before, because a previous run killed
 * mid-flight leaves rows that collide on the unique rank below; after, because
 * nothing cascades a catalogue row.
 */
async function sweep() {
  await db.execute(sql`delete from trees where slug like 'test-%'`);
  await db.execute(sql`delete from tree_rarities where slug like 'test-%'`);
}

let commonRarityId = 0;
let retiredSlug = '';

beforeAll(async () => {
  await sweep();

  const [common] = await db
    .select({ id: treeRarities.id })
    .from(treeRarities)
    .where(eq(treeRarities.slug, 'common'));
  if (!common) throw new Error('run `pnpm seed` first — the catalogue is empty');
  commonRarityId = common.id;

  // A retired catalogue entry, to prove `isActive` hides rather than deletes.
  retiredSlug = `test-retired-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(trees).values({
    slug: retiredSlug,
    name: 'Retired Test Tree',
    description: 'Disabled on purpose.',
    rarityId: commonRarityId,
    imageUrl:
      'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=800&q=80',
    co2OffsetKgPerYear: 1,
    isActive: false,
  });
}, TIMEOUT);

afterAll(sweep, TIMEOUT);

describe('GET /trees/rarities', () => {
  it(
    'returns every active tier, rarest last, with a positive weight',
    async () => {
      const res = await call('/trees/rarities');
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe(true);

      const items = body.data.items as { slug: string; rank: number; dropWeight: number }[];
      expect(items.length).toBeGreaterThanOrEqual(5);
      expect(items.map((r) => r.slug)).toEqual(['common', 'uncommon', 'rare', 'epic', 'legendary']);

      // Ascending rank is load-bearing: the pity rule reads "rank >= min" as
      // "this drop was good", so a reversed order silently inverts it.
      const ranks = items.map((r) => r.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(items.every((r) => r.dropWeight > 0)).toBe(true);

      // Published odds: commoner tiers must be likelier than rarer ones.
      const weights = items.map((r) => r.dropWeight);
      expect(weights).toEqual([...weights].sort((a, b) => b - a));
    },
    TIMEOUT,
  );

  it(
    'is public — no bearer token',
    async () => {
      const res = await call('/trees/rarities');
      expect(res.status).toBe(200);
    },
    TIMEOUT,
  );
});

describe('GET /trees', () => {
  it(
    'lists the catalogue with its rarity nested, newest first',
    async () => {
      const body = await json(await call('/trees?limit=100'));
      expect(body.status).toBe(true);

      const items = body.data.items as {
        id: number;
        slug: string;
        rarity: { slug: string; rank: number };
        co2OffsetKgPerYear: number;
        isActive: boolean;
      }[];
      expect(items.length).toBeGreaterThanOrEqual(20);

      const ids = items.map((t) => t.id);
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
      expect(items.every((t) => typeof t.rarity.slug === 'string')).toBe(true);
      expect(items.every((t) => t.co2OffsetKgPerYear >= 0)).toBe(true);

      // All five tiers are represented, which is the seed's actual promise.
      const tiers = new Set(items.map((t) => t.rarity.slug));
      for (const tier of ['common', 'uncommon', 'rare', 'epic', 'legendary']) {
        expect(tiers.has(tier)).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    'excludes a retired tree',
    async () => {
      const body = await json(await call('/trees?limit=100'));
      const slugs = (body.data.items as { slug: string }[]).map((t) => t.slug);
      expect(slugs).not.toContain(retiredSlug);
    },
    TIMEOUT,
  );

  it(
    'filters by rarity slug',
    async () => {
      const body = await json(await call('/trees?rarity=legendary&limit=100'));
      const items = body.data.items as { rarity: { slug: string } }[];
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((t) => t.rarity.slug === 'legendary')).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'answers an unknown rarity slug with an empty page, not a 404',
    async () => {
      const res = await call('/trees?rarity=does-not-exist');
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.items).toEqual([]);
      expect(body.data.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    },
    TIMEOUT,
  );

  it(
    'pages with an opaque cursor and never repeats a row',
    async () => {
      const first = await json(await call('/trees?limit=3'));
      expect(first.data.items).toHaveLength(3);
      expect(first.data.pageInfo.hasMore).toBe(true);
      expect(typeof first.data.pageInfo.nextCursor).toBe('string');

      const second = await json(
        await call(`/trees?limit=3&cursor=${encodeURIComponent(first.data.pageInfo.nextCursor)}`),
      );
      const firstIds = (first.data.items as { id: number }[]).map((t) => t.id);
      const secondIds = (second.data.items as { id: number }[]).map((t) => t.id);
      expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
      expect(Math.max(...secondIds)).toBeLessThan(Math.min(...firstIds));
    },
    TIMEOUT,
  );

  it(
    'rejects a malformed cursor and an out-of-range limit',
    async () => {
      const bad = await json(await call('/trees?cursor=not-base64-at-all'));
      expect(bad.error.code).toBe('GEN_400');

      const res = await call('/trees?limit=9999');
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('GEN_400');
    },
    TIMEOUT,
  );
});

describe('GET /trees/{slug}', () => {
  it(
    'returns one entry with its rarity',
    async () => {
      const res = await call('/trees/neem');
      expect(res.status).toBe(200);
      const tree = (await json(res)).data;
      expect(tree.slug).toBe('neem');
      expect(tree.rarity.slug).toBe('common');
      expect(tree.imageUrl).toStartWith('https://');
      // Growth stages are optional; neem is one of the two that has them.
      expect(Array.isArray(tree.growthStages)).toBe(true);
      expect(tree.growthStages.length).toBeGreaterThan(1);
    },
    TIMEOUT,
  );

  it(
    'returns null growthStages for a tree without progression',
    async () => {
      const tree = (await json(await call('/trees/guava'))).data;
      expect(tree.growthStages).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'answers GAME_001 for an unknown slug and for a retired tree',
    async () => {
      const missing = await call('/trees/no-such-tree');
      expect(missing.status).toBe(404);
      expect((await json(missing)).error.code).toBe('GAME_001');

      // Retired, not deleted — the row exists, the catalogue just hides it.
      const retired = await call(`/trees/${retiredSlug}`);
      expect(retired.status).toBe(404);
      expect((await json(retired)).error.code).toBe('GAME_001');

      const [row] = await db
        .select({ id: trees.id })
        .from(trees)
        .where(eq(trees.slug, retiredSlug));
      expect(row).toBeDefined();
    },
    TIMEOUT,
  );
});

describe('catalogue invariants are in the database', () => {
  it(
    'tree_rarity_rank_unq refuses a second tier at the same rank',
    async () => {
      let err: unknown;
      try {
        await db
          .insert(treeRarities)
          .values({ slug: 'test-dupe-rank', name: 'Dupe', rank: 1, dropWeight: 5 })
          .execute();
      } catch (error) {
        err = error;
      }
      expect(constraintOf(err)).toBe('tree_rarity_rank_unq');
    },
    TIMEOUT,
  );

  it(
    'tree_rarity_weight_positive refuses a zero drop weight',
    async () => {
      let err: unknown;
      try {
        await db
          .insert(treeRarities)
          .values({ slug: 'test-zero-weight', name: 'Zero', rank: 900, dropWeight: 0 })
          .execute();
      } catch (error) {
        err = error;
      }
      expect(constraintOf(err)).toBe('tree_rarity_weight_positive');
    },
    TIMEOUT,
  );

  it(
    'tree_rarity_rank_positive refuses rank zero',
    async () => {
      let err: unknown;
      try {
        await db
          .insert(treeRarities)
          .values({ slug: 'test-zero-rank', name: 'Zero', rank: 0, dropWeight: 5 })
          .execute();
      } catch (error) {
        err = error;
      }
      expect(constraintOf(err)).toBe('tree_rarity_rank_positive');
    },
    TIMEOUT,
  );

  it(
    'trees_co2_non_negative refuses a negative offset',
    async () => {
      let err: unknown;
      try {
        await db
          .insert(trees)
          .values({
            slug: 'test-negative-co2',
            name: 'Negative',
            description: 'Should not insert.',
            rarityId: commonRarityId,
            imageUrl: 'https://example.com/x.jpg',
            co2OffsetKgPerYear: -1,
          })
          .execute();
      } catch (error) {
        err = error;
      }
      expect(constraintOf(err)).toBe('trees_co2_non_negative');
    },
    TIMEOUT,
  );

  it(
    'a rarity cannot be deleted while a tree references it',
    async () => {
      // RESTRICT, not CASCADE: disabling is the retirement path, and a delete
      // that silently emptied part of the catalogue is the bug this prevents.
      let err: unknown;
      try {
        await db.delete(treeRarities).where(eq(treeRarities.id, commonRarityId)).execute();
      } catch (error) {
        err = error;
      }
      expect(constraintOf(err)).toBe('trees_rarity_id_tree_rarities_id_fk');
    },
    TIMEOUT,
  );
});

describe('the seed is idempotent', () => {
  it(
    'leaves exactly one row per catalogue slug',
    async () => {
      const dupes = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from (
          select slug from trees where slug not like 'test-%' group by slug having count(*) > 1
        ) d
      `);
      expect(dupes.rows[0]?.n ?? 0).toBe(0);

      const orphans = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from trees t
          left join tree_rarities r on r.id = t.rarity_id
         where r.id is null
      `);
      expect(orphans.rows[0]?.n ?? 0).toBe(0);
    },
    TIMEOUT,
  );
});
