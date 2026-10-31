import { closeDatabase, db } from '@database/client.ts';
import { events, orders, rewardTransactions, users } from '@database/schema/index.ts';
import { inArray, like, sql } from 'drizzle-orm';
import { seedEvents } from './events.seed.ts';
import { seedProducts } from './products.seed.ts';
import { seedRegions } from './regions.seed.ts';
import type { Tx } from './support.ts';
import { insertAll } from './support.ts';
import { seedUsers } from './users.seed.ts';

/**
 * `pnpm seed` — the development world (SRV-05).
 *
 * Idempotent: it owns the `@ecolife.app` email namespace, the city list and the
 * six event slugs below, deletes exactly those, and rebuilds them. Two runs
 * leave identical row counts. It does not touch anything it did not create.
 *
 * All of it runs in ONE transaction, so a seed that fails halfway leaves the
 * database as it was rather than a half-world that then has to be diagnosed.
 */

/** The namespace this seed owns and is therefore allowed to delete. */
const SEED_EMAIL_PATTERN = '%@ecolife.app';

const SEED_EVENT_SLUGS = [
  'terrace-composting-workshop',
  'versova-beach-cleanup',
  'cubbon-park-plant-drive',
  'powai-lake-cleanup',
  'ewaste-collection-drive',
  'balcony-garden-starter',
];

const COUNTED_TABLES = [
  'users',
  'lifestyle_profiles',
  'daily_logs',
  'daily_footprints',
  'goals',
  'reward_transactions',
  'regions',
  'cities',
  'products',
  'events',
  'event_hosts',
  'event_passes',
  'orders',
  'order_items',
  'cart_items',
  'addresses',
  'sessions',
  'email_tokens',
  'notifications',
  'push_tokens',
  'audit_logs',
];

/**
 * Generated per run and never written anywhere.
 *
 * A fixed password would have to live in this file to be logged, and a
 * credential in a tracked file is a credential in the git history. The cost is
 * that reseeding changes the password — read it off the output.
 */
function newDevPassword(): string {
  return `dev-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

async function wipeSeedWorld(tx: Tx) {
  // Events first: deleting the host would cascade them anyway, but doing it by
  // slug keeps the delete scoped to events this seed wrote.
  await tx.delete(events).where(inArray(events.slug, SEED_EVENT_SLUGS));

  const seededUsers = await tx
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, SEED_EMAIL_PATTERN));
  const ids = seededUsers.map((u) => u.id);
  if (ids.length === 0) return;

  // `orders.user_id` is ON DELETE RESTRICT, because a real order must not
  // vanish with its user. These are seed-world orders in a namespace this
  // script owns, so they go first — otherwise the second run cannot start.
  await tx.delete(orders).where(inArray(orders.userId, ids));
  // Everything else — profiles, logs, footprints, goals, the ledger, passes,
  // co-host rows, sessions, carts — cascades from users.
  await tx.delete(users).where(inArray(users.id, ids));
}

async function printSummary(seededUserIds: number[]) {
  const counts = await db.execute<{ table_name: string; n: number }>(
    sql.raw(
      COUNTED_TABLES.map((t) => `select '${t}' as table_name, count(*)::int as n from ${t}`).join(
        '\nunion all\n',
      ),
    ),
  );

  console.log('\nRow counts');
  for (const row of counts.rows) {
    console.log(`  ${row.table_name.padEnd(20)} ${String(row.n).padStart(6)}`);
  }

  // Reported twice: over everything, and over the rows this script owns.
  // Only the second is a statement about the seed — the first also sees any
  // abandoned test fixture sitting in the dev branch, which is worth surfacing
  // but is not the seed's to fix.
  const [totals] = (
    await db.execute<{
      ledger: number;
      cached: number;
      seededLedger: number;
      seededCached: number;
    }>(sql`
      select
        (select coalesce(sum(points_delta), 0)::int from reward_transactions) as ledger,
        (select coalesce(sum(points_total), 0)::int from users) as cached,
        (select coalesce(sum(t.points_delta), 0)::int
           from reward_transactions t join users u on u.id = t.user_id
          where u.email like ${SEED_EMAIL_PATTERN}) as "seededLedger",
        (select coalesce(sum(points_total), 0)::int
           from users where email like ${SEED_EMAIL_PATTERN}) as "seededCached"
    `)
  ).rows;
  const line = (label: string, ledger: number, cached: number) =>
    console.log(
      `  ${label.padEnd(12)} ledger ${String(ledger).padStart(8)}` +
        `   cache ${String(cached).padStart(8)}   ${ledger === cached ? '✓' : '✗'}`,
    );

  console.log('\nReconciliation — SUM(points_delta) == SUM(users.points_total)');
  line('seeded users', totals?.seededLedger ?? 0, totals?.seededCached ?? 0);
  line('all users', totals?.ledger ?? 0, totals?.cached ?? 0);

  // Named per user when it does not, because the interesting question is never
  // "is it off" but "whose row is off" — including rows this seed never wrote.
  const drift = await db.execute<{ id: number; email: string; cached: number; ledger: number }>(sql`
    select u.id, u.email, u.points_total::int as cached,
           coalesce(sum(t.points_delta), 0)::int as ledger
      from users u
      left join reward_transactions t on t.user_id = u.id
     group by u.id, u.email, u.points_total
    having u.points_total <> coalesce(sum(t.points_delta), 0)
     order by u.id
  `);

  if (drift.rows.length > 0) {
    console.log('\n  rows where the cache and the ledger disagree:');
    for (const row of drift.rows) {
      const mine = seededUserIds.includes(Number(row.id)) ? 'seeded' : 'NOT SEEDED BY THIS SCRIPT';
      console.log(
        `    user ${String(row.id).padEnd(4)} ${row.email.padEnd(32)} ` +
          `cache ${row.cached} vs ledger ${row.ledger}  (${mine})`,
      );
    }
  }
}

const devPassword = newDevPassword();
const started = Date.now();

const result = await db.transaction(async (tx) => {
  await wipeSeedWorld(tx);

  const regions = await seedRegions(tx);
  const products = await seedProducts(tx);

  // One argon2id hash, shared by all 25 accounts because they share one
  // throwaway password. Hashing it 25 times would cost 25 x ~100 ms to produce
  // 25 different salts for the same secret, which buys a dev seed nothing.
  const passwordHash = await Bun.password.hash(devPassword, { algorithm: 'argon2id' });

  const userResult = await seedUsers(tx, regions, passwordHash);
  const eventResult = await seedEvents(tx, userResult.seeded);

  const ledger = [...userResult.rewards, ...eventResult.rewards];
  await insertAll(ledger, (batch) => tx.insert(rewardTransactions).values(batch));

  // The cache is DERIVED from the ledger in the same transaction that wrote it,
  // which is the only way `SUM(ledger) == users.points_total` can be true by
  // construction rather than by a seeder remembering to add up the same numbers
  // twice. Scoped to the seeded ids: this script does not rewrite rows it does
  // not own, even to make its own summary look tidier.
  await tx.execute(sql`
    update users set
      points_total  = coalesce(l.points, 0),
      coins_balance = coalesce(l.coins, 0),
      updated_at    = now()
    from (
      select user_id, sum(points_delta)::int as points, sum(coins_delta)::int as coins
        from reward_transactions
       group by user_id
    ) l
    where users.id = l.user_id
      and users.email like ${SEED_EMAIL_PATTERN}
  `);

  return {
    regions: regions.size,
    products,
    ...userResult.counts,
    ...eventResult,
    ledgerRows: ledger.length,
    seededIds: userResult.seeded.map((u) => u.id),
  };
});

console.log(`\nSeeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(
  `  ${result.users} users, ${result.profiles} profiles, ${result.logs} daily logs, ` +
    `${result.footprints} footprints`,
);
console.log(
  `  ${result.goals} goals, ${result.ledgerRows} ledger rows, ${result.products} products`,
);
console.log(`  ${result.events} events, ${result.passes} passes, ${result.regions} regions`);

await printSummary(result.seededIds);

console.log('\nDev login');
console.log('  email     dev@ecolife.app  (role: admin)');
console.log(`  password  ${devPassword}`);
console.log('  Every seeded @ecolife.app account shares this password. It is generated per run');
console.log('  and written to no file — rerun `pnpm seed` if you lose it.');

await closeDatabase();
