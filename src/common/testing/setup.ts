import { afterAll } from 'bun:test';
import { env } from '@config/env.ts';
import { closeDatabase, db } from '@database/client.ts';
import { users } from '@database/schema/index.ts';
import { like, or, sql } from 'drizzle-orm';

/**
 * Preloaded by bunfig.toml for every `bun test` run.
 *
 * Three jobs: refuse to run somewhere dangerous unless told otherwise, sweep
 * up the accounts the suite created, and close the pool exactly once.
 */

const PROTECTED_BRANCHES = new Set(['production', 'main', 'master']);

/**
 * The suite shares a database with the app, by explicit choice.
 *
 * That is workable precisely because of the sweep below — without it, one
 * full run leaves ~200 accounts behind, which is exactly what happened when
 * `neon init` silently repointed `.env` at production mid-session. The guard
 * stays so that a teammate cloning this repo has to opt in on purpose rather
 * than discover the behaviour afterwards.
 */
const branch = process.env.NEON_BRANCH;
if (
  branch &&
  PROTECTED_BRANCHES.has(branch) &&
  !env.TEST_DATABASE_URL &&
  process.env.ALLOW_TESTS_ON_PROTECTED_BRANCH !== '1'
) {
  throw new Error(
    `Refusing to run tests: NEON_BRANCH is "${branch}".\n` +
      'The suite registers users, writes logs and deletes accounts.\n' +
      'Set TEST_DATABASE_URL to a dev branch, or export ' +
      'ALLOW_TESTS_ON_PROTECTED_BRANCH=1 if you genuinely mean it.',
  );
}

/**
 * Email namespaces the suite owns, and is therefore allowed to delete.
 *
 * Same discipline as the seed's `@ecolife.app`: name the namespace, delete
 * only inside it, touch nothing else. `@ecolife.invalid` is where
 * `DELETE /profile` anonymises an address to, so deletion tests land there.
 *
 * Every test helper that registers an account MUST use one of these domains,
 * or its rows survive the run.
 */
const TEST_EMAIL_PATTERNS = ['%@example.test', '%@example.com', '%@ecolife.invalid'];

/**
 * The pg Pool is a module singleton shared by every test file in the process,
 * so teardown belongs here exactly once. A per-file afterAll would close the
 * pool while a sibling file is still querying it.
 */
afterAll(async () => {
  try {
    const owned = sql`select id from ${users} where ${or(
      ...TEST_EMAIL_PATTERNS.map((p) => like(users.email, p)),
    )}`;

    // Settlements and ledger records reference orders with RESTRICT,
    // so they must be cleared before deleting orders.
    await db.execute(
      sql`delete from settlement_ledger where order_id in (select id from orders where user_id in (${owned}))`,
    );
    await db.execute(
      sql`delete from order_settlements where order_id in (select id from orders where user_id in (${owned}))`,
    );
    await db.execute(sql`delete from seller_payouts where id > 0`);
    await db.execute(sql`delete from orders where user_id in (${owned})`);

    // Products this suite created. They are RESTRICT-referenced by
    // order_items, so they can only go after the orders above.
    await db.execute(sql`delete from products where slug like 'test-%'`);

    // Everything else cascades from users: logs, footprints, rewards,
    // sessions, passes, addresses, goals.
    const deleted = await db
      .delete(users)
      .where(or(...TEST_EMAIL_PATTERNS.map((p) => like(users.email, p))))
      .returning({ id: users.id });

    if (deleted.length > 0) {
      console.log(`[test cleanup] removed ${deleted.length} test account(s)`);
    }

    // Rate-limit rows are keyed by email and IP, not by user id, so nothing
    // cascades them. Left alone they would lock out the next run's attempts
    // on a repeated address.
    await db.execute(sql`delete from rate_limits where subject like '%@example.test%'`);

    // Events hosted by a test user cascade, but one created and then left
    // by a since-deleted host would not. Scoped to the title this suite uses.
    await db.execute(sql`delete from events where title like 'Test Drive %'`);

    // Catalogue rows a test created. Trees before rarities: `trees.rarity_id`
    // is RESTRICT. Both go AFTER the `delete users` above, because `user_trees`
    // cascades from the account and RESTRICT-references the tree.
    await db.execute(sql`delete from trees where slug like 'test-%'`);
    await db.execute(sql`delete from tree_rarities where slug like 'test-%'`);
  } catch (error) {
    // Never fail a green suite on cleanup. Say so loudly instead — silent
    // cleanup failure is how the debris built up unnoticed the first time.
    console.error('[test cleanup] FAILED — test rows may remain:', error);
  } finally {
    await closeDatabase();
  }
});
