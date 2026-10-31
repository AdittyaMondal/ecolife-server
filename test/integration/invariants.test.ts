import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, pool } from '@database/client.ts';
import {
  dailyFootprints,
  dailyLogs,
  events,
  goals,
  orders,
  products,
  rewardTransactions,
  users,
} from '@database/schema/index.ts';
import { eq, sql } from 'drizzle-orm';

/**
 * These are the constraints PRD-v2 marks [LESSON] — each one corresponds to a
 * defect v1 actually shipped. The point of this file is that they are enforced
 * by Postgres, not by a service remembering to check. If one of these tests
 * fails, a P0 bug class just reopened.
 *
 * Constraint names come off `error.cause`, not the message: Drizzle wraps
 * driver errors as "Failed query: …", so asserting on the message lets an
 * unrelated failure pass the test.
 */
const constraintOf = (err: unknown) =>
  (err as { cause?: { constraint?: string } })?.cause?.constraint;

const TIMEOUT = 30_000; // Neon cold start; Bun's 5s default flakes.

let userId: number;
let productId: number;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      name: 'Invariant Probe',
      email: `probe-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-a-real-hash',
    })
    .returning();
  userId = u!.id;

  const [p] = await db
    .insert(products)
    .values({
      slug: `probe-${crypto.randomUUID()}`,
      name: 'Probe product',
      category: 'plants',
      pricePaise: 100_00,
      stock: 1,
    })
    .returning();
  productId = p!.id;
}, TIMEOUT);

afterAll(async () => {
  // Order matters: orders reference users with onDelete 'restrict', because an
  // order is a financial record that must not vanish with its user. So the
  // orders go first. (Learned the hard way — the first run of this file failed
  // teardown with 23001 on orders_user_id_users_id_fk, which is the constraint
  // working.) Everything else cascades from users.
  await db.delete(orders).where(eq(orders.userId, userId)).execute();
  await db.delete(users).where(eq(users.id, userId)).execute();
  await db.delete(products).where(eq(products.id, productId)).execute();
}, TIMEOUT);

describe('reward ledger idempotency', () => {
  it(
    'rejects a second award for the same (user, source, sourceId)',
    async () => {
      const row = {
        userId,
        pointsDelta: 200,
        coinsDelta: 100,
        source: 'event_attend' as const,
        sourceId: 'event_attend:probe',
      };
      await db.insert(rewardTransactions).values(row).execute();

      let err: unknown;
      try {
        await db.insert(rewardTransactions).values(row).execute();
      } catch (e) {
        err = e;
      }
      expect(constraintOf(err)).toBe('reward_idempotency_unq');
    },
    TIMEOUT,
  );

  it(
    'onConflictDoNothing makes a replay a silent no-op — the award() contract',
    async () => {
      const row = {
        userId,
        pointsDelta: 10,
        coinsDelta: 5,
        source: 'daily_log' as const,
        sourceId: 'daily_log:probe',
      };
      const first = await db
        .insert(rewardTransactions)
        .values(row)
        .onConflictDoNothing()
        .returning();
      const second = await db
        .insert(rewardTransactions)
        .values(row)
        .onConflictDoNothing()
        .returning();
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0); // this empty array is what stops double-crediting
    },
    TIMEOUT,
  );
});

describe('one active goal per user', () => {
  it(
    'rejects a second active goal but allows a settled one alongside',
    async () => {
      const base = {
        userId,
        type: 'reduce_percent' as const,
        period: 'month' as const,
        reducePercent: 15,
        baselineKgTotal: 246,
        targetKgTotal: 209.1,
      };
      await db
        .insert(goals)
        .values({ ...base, startDate: '2026-11-01', endDate: '2026-11-30' })
        .execute();

      let err: unknown;
      try {
        await db
          .insert(goals)
          .values({ ...base, startDate: '2026-12-01', endDate: '2026-12-31' })
          .execute();
      } catch (e) {
        err = e;
      }
      expect(constraintOf(err)).toBe('one_active_goal_per_user');

      // A settled goal must not occupy the slot — goals are never deleted.
      await db
        .insert(goals)
        .values({ ...base, startDate: '2026-09-01', endDate: '2026-09-30', status: 'achieved' })
        .execute();
    },
    TIMEOUT,
  );
});

describe('the 20% coin discount cap', () => {
  it(
    'rejects a discount above 20% of subtotal, in SQL',
    async () => {
      let err: unknown;
      try {
        await db
          .insert(orders)
          .values({
            orderNumber: `ECO-PROBE-${crypto.randomUUID().slice(0, 8)}`,
            userId,
            subtotalPaise: 100_00,
            discountPaise: 80_00, // 80% off — a pricing bug, not a user action
            totalPaise: 20_00,
            coinsSpent: 8000,
            idempotencyKey: crypto.randomUUID(),
          })
          .execute();
      } catch (e) {
        err = e;
      }
      expect(constraintOf(err)).toBe('orders_discount_within_cap');
    },
    TIMEOUT,
  );

  it(
    'accepts exactly 20%',
    async () => {
      const [o] = await db
        .insert(orders)
        .values({
          orderNumber: `ECO-PROBE-${crypto.randomUUID().slice(0, 8)}`,
          userId,
          subtotalPaise: 100_00,
          discountPaise: 20_00,
          totalPaise: 80_00,
          coinsSpent: 2000,
          idempotencyKey: crypto.randomUUID(),
        })
        .returning();
      expect(o?.discountPaise).toBe(2000);
    },
    TIMEOUT,
  );
});

describe('offline replay safety', () => {
  it(
    'rejects a duplicate clientLogId for the same user',
    async () => {
      const clientLogId = crypto.randomUUID();
      await db
        .insert(dailyLogs)
        .values({ userId, logDate: '2026-10-01', clientLogId, answeredCount: 5 })
        .execute();

      let err: unknown;
      try {
        // Same client id, DIFFERENT date — a queue replaying must still be caught.
        await db
          .insert(dailyLogs)
          .values({ userId, logDate: '2026-10-02', clientLogId, answeredCount: 5 })
          .execute();
      } catch (e) {
        err = e;
      }
      expect(constraintOf(err)).toBe('daily_log_client_unq');
    },
    TIMEOUT,
  );

  it(
    'rejects two footprints for the same user and date',
    async () => {
      const row = {
        userId,
        logDate: '2026-10-05',
        baselineTotalKg: 8.2,
        totalKg: 6.05,
        sources: { transport: 'logged' as const },
        factorVersion: 1,
      };
      await db.insert(dailyFootprints).values(row).execute();

      let err: unknown;
      try {
        await db.insert(dailyFootprints).values(row).execute();
      } catch (e) {
        err = e;
      }
      expect(constraintOf(err)).toBe('footprint_user_date_unq');
    },
    TIMEOUT,
  );
});

describe('stock cannot go negative', () => {
  it(
    'rejects overselling rather than allowing it',
    async () => {
      let err: unknown;
      try {
        await db
          .update(products)
          .set({ stock: sql`${products.stock} - 5` }) // only 1 in stock
          .where(eq(products.id, productId))
          .execute();
      } catch (e) {
        err = e;
      }
      expect(constraintOf(err)).toBe('products_stock_non_negative');
    },
    TIMEOUT,
  );
});

describe('wallet cannot go negative', () => {
  it(
    'rejects a spend larger than the balance',
    async () => {
      let err: unknown;
      try {
        await db
          .update(users)
          .set({ coinsBalance: sql`${users.coinsBalance} - 500` })
          .where(eq(users.id, userId))
          .execute();
      } catch (e) {
        err = e;
      }
      expect(constraintOf(err)).toBe('users_coins_non_negative');
    },
    TIMEOUT,
  );
});

describe('email identity', () => {
  it(
    'treats a case-variant email as the same account, not a second one',
    async () => {
      const addr = `Case-${crypto.randomUUID()}@Example.Test`;
      await db
        .insert(users)
        .values({ name: 'Mixed Case', email: addr, passwordHash: 'x' })
        .execute();

      let err: unknown;
      try {
        await db
          .insert(users)
          .values({ name: 'Lower Case', email: addr.toLowerCase(), passwordHash: 'x' })
          .execute();
      } catch (e) {
        err = e;
      }
      // A plain unique(email) would have allowed this, giving one person two
      // accounts and a login lookup that misses the row that exists.
      expect(constraintOf(err)).toBe('users_email_lower_unq');

      await db.delete(users).where(sql`lower(${users.email}) = ${addr.toLowerCase()}`).execute();
    },
    TIMEOUT,
  );
});

describe('event capacity', () => {
  it(
    'refuses to register past capacity, and refuses more check-ins than registrations',
    async () => {
      const [e] = await db
        .insert(events)
        .values({
          slug: `probe-${crypto.randomUUID()}`,
          title: 'Capacity probe',
          description: 'Exists only to prove the constraints fire.',
          type: 'cleanup_drive',
          hostId: userId,
          startAt: new Date('2026-12-01T01:30:00Z'),
          endAt: new Date('2026-12-01T04:00:00Z'),
          venueName: 'Nowhere',
          capacity: 2,
          registeredCount: 2,
        })
        .returning();
      const eventId = e!.id;

      let overCapacity: unknown;
      try {
        await db
          .update(events)
          .set({ registeredCount: sql`${events.registeredCount} + 1` })
          .where(eq(events.id, eventId))
          .execute();
      } catch (err) {
        overCapacity = err;
      }
      expect(constraintOf(overCapacity)).toBe('events_registrations_within_capacity');

      let phantom: unknown;
      try {
        // More people checked in than ever registered — the shape a colluding
        // host's phantom attendees would take.
        await db.update(events).set({ checkedInCount: 5 }).where(eq(events.id, eventId)).execute();
      } catch (err) {
        phantom = err;
      }
      expect(constraintOf(phantom)).toBe('events_checkins_within_capacity');

      await db.delete(events).where(eq(events.id, eventId)).execute();
    },
    TIMEOUT,
  );
});
