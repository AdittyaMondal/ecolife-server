import { describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { createOnboardedUser, readUser } from '@common/testing/fixtures.ts';
import { db } from '@database/client.ts';
import { events, products, rewardTransactions, users } from '@database/schema/index.ts';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../../src/app.ts';

/** Marketplace (PRD-v2 §6.5) and events with QR check-in (§6.6). */

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
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** A product this test owns, so stock changes cannot disturb the seed. */
async function makeProduct(price: number, stock: number) {
  const [row] = await db
    .insert(products)
    .values({
      slug: `test-${crypto.randomUUID()}`,
      name: 'Test Product',
      description: 'For tests.',
      category: 'household',
      pricePaise: price,
      stock,
    })
    .returning();
  if (!row) throw new Error('product insert returned nothing');
  return row;
}

async function makeAddress(token: string) {
  const res = await json(
    await call('/addresses', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        name: 'Tester',
        phone: '+919876543210',
        line1: '1 Test Road',
        line2: null,
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411001',
        isDefault: true,
      }),
    }),
  );
  return res.data.id as number;
}

async function giveCoins(userId: number, coins: number) {
  await db
    .update(users)
    .set({ coinsBalance: sql`${users.coinsBalance} + ${coins}` })
    .where(eq(users.id, userId));
}

describe('marketplace pricing', () => {
  it(
    'caps the discount at 20% of subtotal however many coins are offered',
    async () => {
      const { token, userId } = await createOnboardedUser();
      const product = await makeProduct(100_000, 50);
      await giveCoins(userId, 1_000_000);

      await call('/marketplace/cart/items', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ productId: product.id, quantity: 1 }),
      });

      const q = (
        await json(
          await call('/marketplace/cart/preview', {
            method: 'POST',
            headers: auth(token),
            body: JSON.stringify({ offeredCoins: 999_999 }),
          }),
        )
      ).data;

      // 20% of 100000 paise = 20000 paise = 2000 coins at 10 coins/rupee.
      expect(q.subtotalPaise).toBe(100_000);
      expect(q.maxDiscountPaise).toBe(20_000);
      expect(q.discountPaise).toBe(20_000);
      expect(q.coinsSpent).toBe(2_000);
      expect(q.totalPaise).toBe(80_000);
      expect(q.capReached).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'clamps to the wallet when that bites before the cap',
    async () => {
      const { token, userId } = await createOnboardedUser();
      const product = await makeProduct(100_000, 50);
      await giveCoins(userId, 150);

      await call('/marketplace/cart/items', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ productId: product.id, quantity: 1 }),
      });
      const q = (
        await json(
          await call('/marketplace/cart/preview', {
            method: 'POST',
            headers: auth(token),
            body: JSON.stringify({ offeredCoins: 999_999 }),
          }),
        )
      ).data;

      expect(q.coinsSpent).toBe(150);
      expect(q.discountPaise).toBe(1_500);
      expect(q.capReached).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'refuses to add more than the stock',
    async () => {
      const { token } = await createOnboardedUser();
      const product = await makeProduct(1_000, 2);
      const res = await call('/marketplace/cart/items', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ productId: product.id, quantity: 5 }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('SHOP_001');
    },
    TIMEOUT,
  );
});

describe('placing an order', () => {
  it(
    'debits coins, decrements stock, clears the cart, and never moves points',
    async () => {
      const { token, userId } = await createOnboardedUser();
      const product = await makeProduct(50_000, 10);
      await giveCoins(userId, 500);
      const addressId = await makeAddress(token);

      await call('/marketplace/cart/items', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ productId: product.id, quantity: 2 }),
      });

      const before = await readUser(userId);
      const order = (
        await json(
          await call('/marketplace/orders', {
            method: 'POST',
            headers: auth(token),
            body: JSON.stringify({
              offeredCoins: 500,
              addressId,
              idempotencyKey: crypto.randomUUID(),
            }),
          }),
        )
      ).data;

      expect(order.subtotalPaise).toBe(100_000);
      expect(order.coinsSpent).toBe(500);
      expect(order.discountPaise).toBe(5_000);
      expect(order.totalPaise).toBe(95_000);
      // Snapshots, so a later rename cannot rewrite what was bought.
      expect(order.items[0].productName).toBe('Test Product');
      expect(order.items[0].unitPaise).toBe(50_000);

      const after = await readUser(userId);
      expect(after?.coinsBalance).toBe((before?.coinsBalance ?? 0) - 500);
      // Spending must NEVER cost rank — the whole reason points and coins
      // are separate columns. v1 used one integer and buying something
      // dropped you down the leaderboard.
      expect(after?.pointsTotal).toBe(before?.pointsTotal ?? 0);

      const [stock] = await db
        .select({ stock: products.stock })
        .from(products)
        .where(eq(products.id, product.id));
      expect(stock?.stock).toBe(8);

      const cart = (await json(await call('/marketplace/cart', { headers: auth(token) }))).data;
      expect(cart.items).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    'returns the original order when the same key is replayed',
    async () => {
      const { token, userId } = await createOnboardedUser();
      const product = await makeProduct(10_000, 10);
      await giveCoins(userId, 100);
      const addressId = await makeAddress(token);
      await call('/marketplace/cart/items', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ productId: product.id, quantity: 1 }),
      });

      const key = crypto.randomUUID();
      const body = JSON.stringify({ offeredCoins: 100, addressId, idempotencyKey: key });
      const first = (
        await json(
          await call('/marketplace/orders', { method: 'POST', headers: auth(token), body }),
        )
      ).data;
      const second = (
        await json(
          await call('/marketplace/orders', { method: 'POST', headers: auth(token), body }),
        )
      ).data;

      expect(second.id).toBe(first.id);
      expect(second.orderNumber).toBe(first.orderNumber);

      const after = await readUser(userId);
      // Charged once, not twice.
      expect(after?.coinsBalance).toBe(0);
      const [stock] = await db
        .select({ stock: products.stock })
        .from(products)
        .where(eq(products.id, product.id));
      expect(stock?.stock).toBe(9);
    },
    TIMEOUT,
  );

  it(
    'refuses to spend coins the user does not have',
    async () => {
      const { token, userId } = await createOnboardedUser();
      const product = await makeProduct(100_000, 5);
      await giveCoins(userId, 10);
      const addressId = await makeAddress(token);
      await call('/marketplace/cart/items', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ productId: product.id, quantity: 1 }),
      });

      const res = await call('/marketplace/orders', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          offeredCoins: 5_000,
          addressId,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      // The cart quote clamps, but an order must not silently charge a
      // different total than the one the user confirmed.
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('SHOP_003');
    },
    TIMEOUT,
  );

  it(
    "will not deliver to someone else's address",
    async () => {
      const victim = await createOnboardedUser();
      const attacker = await createOnboardedUser();
      const addressId = await makeAddress(victim.token);
      const product = await makeProduct(1_000, 5);
      await call('/marketplace/cart/items', {
        method: 'POST',
        headers: auth(attacker.token),
        body: JSON.stringify({ productId: product.id, quantity: 1 }),
      });

      const res = await call('/marketplace/orders', {
        method: 'POST',
        headers: auth(attacker.token),
        body: JSON.stringify({ offeredCoins: 0, addressId, idempotencyKey: crypto.randomUUID() }),
      });
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe('SHOP_007');
    },
    TIMEOUT,
  );
});

// --- events ----------------------------------------------------------------

function eventBody(overrides: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  return {
    title: `Test Drive ${crypto.randomUUID().slice(0, 8)}`,
    description: 'A test event, long enough to pass validation.',
    type: 'cleanup_drive',
    visibility: 'public',
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    venueName: 'Test Beach',
    capacity: 100,
    publish: true,
    ...overrides,
  };
}

async function hostAnEvent(token: string, overrides: Record<string, unknown> = {}) {
  const res = await json(
    await call('/events', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify(eventBody(overrides)),
    }),
  );
  return res.data;
}

describe('events', () => {
  it(
    'keeps a draft invisible to everyone but its host, as a 404',
    async () => {
      const host = await createOnboardedUser();
      const stranger = await createOnboardedUser();
      const draft = await hostAnEvent(host.token, { publish: false });
      expect(draft.status).toBe('draft');

      const mine = await call(`/events/${draft.slug}`, { headers: auth(host.token) });
      expect(mine.status).toBe(200);

      const theirs = await call(`/events/${draft.slug}`, { headers: auth(stranger.token) });
      // 404, not 403 — a 403 would confirm the draft exists.
      expect(theirs.status).toBe(404);
      expect((await json(theirs)).error.code).toBe('EVENT_009');
    },
    TIMEOUT,
  );

  it(
    'mints a pass once and returns the same one on re-registration',
    async () => {
      const host = await createOnboardedUser();
      const attendee = await createOnboardedUser();
      const event = await hostAnEvent(host.token);

      const first = (
        await json(
          await call(`/events/${event.id}/register`, {
            method: 'POST',
            headers: auth(attendee.token),
          }),
        )
      ).data;
      expect(first.pass.passCode.length).toBeGreaterThan(10);
      expect(first.pass.qrPayload).toBe(`ecolife://pass/${first.pass.passCode}`);
      expect(first.event.registeredCount).toBe(1);

      const second = (
        await json(
          await call(`/events/${event.id}/register`, {
            method: 'POST',
            headers: auth(attendee.token),
          }),
        )
      ).data;
      expect(second.pass.id).toBe(first.pass.id);
      // The code is only ever held in plaintext once; a hash is all we keep.
      expect(second.pass.passCode).toBe('');

      const [row] = await db.select().from(events).where(eq(events.id, event.id));
      expect(row?.registeredCount).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'refuses to overfill, and frees the seat on cancellation',
    async () => {
      const host = await createOnboardedUser();
      const first = await createOnboardedUser();
      const second = await createOnboardedUser();
      const event = await hostAnEvent(host.token, { capacity: 1 });

      expect(
        (await call(`/events/${event.id}/register`, { method: 'POST', headers: auth(first.token) }))
          .status,
      ).toBe(201);

      const full = await call(`/events/${event.id}/register`, {
        method: 'POST',
        headers: auth(second.token),
      });
      expect(full.status).toBe(422);
      expect((await json(full)).error.code).toBe('EVENT_005');

      await call(`/events/${event.id}/register`, { method: 'DELETE', headers: auth(first.token) });
      expect(
        (
          await call(`/events/${event.id}/register`, {
            method: 'POST',
            headers: auth(second.token),
          })
        ).status,
      ).toBe(201);
    },
    TIMEOUT,
  );

  it(
    'checks a pass in once, pays once, and treats a rescan as success',
    async () => {
      const host = await createOnboardedUser();
      const attendee = await createOnboardedUser();
      const event = await hostAnEvent(host.token, {
        // Already started, so the scan window is open.
        startAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        endAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      const reg = (
        await json(
          await call(`/events/${event.id}/register`, {
            method: 'POST',
            headers: auth(attendee.token),
          }),
        )
      ).data;

      const scan = (
        await json(
          await call(`/events/${event.id}/scan`, {
            method: 'POST',
            headers: auth(host.token),
            body: JSON.stringify({
              passCode: reg.pass.passCode,
              scanClientId: crypto.randomUUID(),
            }),
          }),
        )
      ).data;
      expect(scan.alreadyCheckedIn).toBe(false);
      expect(scan.attendee.id).toBe(attendee.userId);
      expect(scan.attendeeReward.pointsDelta).toBe(200);
      expect(scan.checkedInCount).toBe(1);

      const again = (
        await json(
          await call(`/events/${event.id}/scan`, {
            method: 'POST',
            headers: auth(host.token),
            body: JSON.stringify({
              passCode: reg.pass.passCode,
              scanClientId: crypto.randomUUID(),
            }),
          }),
        )
      ).data;
      // A rescan is a SUCCESS that grants nothing, never an error — a host
      // scanning a queue cannot be made to stop and read a message.
      expect(again.alreadyCheckedIn).toBe(true);
      expect(again.attendeeReward).toBeNull();
      expect(again.checkedInCount).toBe(1);

      const [grants] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rewardTransactions)
        .where(
          and(
            eq(rewardTransactions.userId, attendee.userId),
            eq(rewardTransactions.source, 'event_attend'),
          ),
        );
      expect(grants?.n).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'refuses a scan outside the check-in window',
    async () => {
      const host = await createOnboardedUser();
      const attendee = await createOnboardedUser();
      // Starts in a week: the window opens an hour before that.
      const event = await hostAnEvent(host.token, {
        startAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        endAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000).toISOString(),
      });
      const reg = (
        await json(
          await call(`/events/${event.id}/register`, {
            method: 'POST',
            headers: auth(attendee.token),
          }),
        )
      ).data;

      const res = await call(`/events/${event.id}/scan`, {
        method: 'POST',
        headers: auth(host.token),
        body: JSON.stringify({ passCode: reg.pass.passCode, scanClientId: crypto.randomUUID() }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe('EVENT_003');
    },
    TIMEOUT,
  );

  it(
    'lets only a host scan, and says 403 before revealing anything about the pass',
    async () => {
      const host = await createOnboardedUser();
      const attendee = await createOnboardedUser();
      const stranger = await createOnboardedUser();
      const event = await hostAnEvent(host.token, {
        startAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        endAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      const reg = (
        await json(
          await call(`/events/${event.id}/register`, {
            method: 'POST',
            headers: auth(attendee.token),
          }),
        )
      ).data;

      const res = await call(`/events/${event.id}/scan`, {
        method: 'POST',
        headers: auth(stranger.token),
        body: JSON.stringify({ passCode: reg.pass.passCode, scanClientId: crypto.randomUUID() }),
      });
      // The host check runs FIRST, so a stranger cannot probe which codes
      // are valid by comparing 404s against 403s.
      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe('EVENT_001');

      const participants = await call(`/events/${event.id}/participants`, {
        headers: auth(stranger.token),
      });
      expect(participants.status).toBe(403);
    },
    TIMEOUT,
  );

  it(
    'pays the host once, after five distinct attendees',
    async () => {
      const host = await createOnboardedUser();
      const event = await hostAnEvent(host.token, {
        startAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        endAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      for (let i = 0; i < 5; i++) {
        const attendee = await createOnboardedUser();
        const reg = (
          await json(
            await call(`/events/${event.id}/register`, {
              method: 'POST',
              headers: auth(attendee.token),
            }),
          )
        ).data;
        await call(`/events/${event.id}/scan`, {
          method: 'POST',
          headers: auth(host.token),
          body: JSON.stringify({ passCode: reg.pass.passCode, scanClientId: crypto.randomUUID() }),
        });
      }

      const [grants] = await db
        .select({
          n: sql<number>`count(*)::int`,
          points: sql<number>`coalesce(sum(points_delta),0)::int`,
        })
        .from(rewardTransactions)
        .where(
          and(
            eq(rewardTransactions.userId, host.userId),
            eq(rewardTransactions.source, 'event_host'),
          ),
        );
      expect(grants?.n).toBe(1);
      expect(grants?.points).toBe(300);
    },
    TIMEOUT,
  );
});
