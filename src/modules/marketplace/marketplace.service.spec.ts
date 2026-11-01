import { describe, expect, it } from 'bun:test';
import { deriveOrderStatus, ORDER_TRANSITIONS, quote } from './marketplace.service.ts';

/**
 * The three pieces of marketplace arithmetic that are worth pinning without a
 * database: the status transition table, the order-status derivation, and the
 * per-line coin ceiling.
 *
 * Expected values are written as arithmetic over the inputs, never read back
 * from the function under test.
 */

type P = Parameters<typeof quote>[0][number]['product'];

/** A product with everything permissive, so each test varies one thing. */
const product = (over: Partial<P> = {}): P =>
  ({
    id: 1,
    slug: 'p',
    name: 'P',
    description: null,
    category: 'household',
    pricePaise: 10_000,
    imageUrl: null,
    stock: 50,
    co2SavedKg: 1,
    discountType: 'none',
    discountValue: 0,
    allowCoinRedemption: true,
    maxCoinRedemptionPercent: 20,
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: the spec only needs the priced fields
  }) as any;

describe('ORDER_TRANSITIONS', () => {
  it('makes delivered and cancelled terminal', () => {
    expect(ORDER_TRANSITIONS.delivered).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });

  it('refuses the moves that were previously accepted', () => {
    // A seller could walk a delivered item back to placed, and resurrect a
    // cancelled one. Both are the bug this table exists to close.
    expect(ORDER_TRANSITIONS.delivered).not.toContain('placed');
    expect(ORDER_TRANSITIONS.cancelled).not.toContain('shipped');
    expect(ORDER_TRANSITIONS.shipped).not.toContain('cancelled');
  });

  it('allows exactly the forward path, with cancellation before shipping', () => {
    expect(ORDER_TRANSITIONS.placed).toEqual(['confirmed', 'cancelled']);
    expect(ORDER_TRANSITIONS.confirmed).toEqual(['shipped', 'cancelled']);
    expect(ORDER_TRANSITIONS.shipped).toEqual(['delivered']);
  });
});

describe('deriveOrderStatus', () => {
  it('is the least advanced LIVE item, not the one the caller just set', () => {
    // The multi-seller bug: seller A ships, and the buyer's order used to flip
    // to shipped while seller B had not even confirmed.
    expect(deriveOrderStatus(['shipped', 'placed'])).toBe('placed');
    expect(deriveOrderStatus(['delivered', 'confirmed'])).toBe('confirmed');
    expect(deriveOrderStatus(['delivered', 'delivered'])).toBe('delivered');
  });

  it('ignores cancelled lines while any line is still live', () => {
    expect(deriveOrderStatus(['cancelled', 'shipped'])).toBe('shipped');
    expect(deriveOrderStatus(['cancelled', 'cancelled', 'placed'])).toBe('placed');
  });

  it('is cancelled only when every line is', () => {
    expect(deriveOrderStatus(['cancelled'])).toBe('cancelled');
    expect(deriveOrderStatus(['cancelled', 'cancelled'])).toBe('cancelled');
  });

  it('handles a single-seller order unchanged', () => {
    for (const s of ['placed', 'confirmed', 'shipped', 'delivered'] as const) {
      expect(deriveOrderStatus([s])).toBe(s);
    }
  });
});

describe('quote — the per-line coin ceiling', () => {
  const WALLET = 1_000_000;

  it('caps at the global 20% when every line allows the full amount', () => {
    const q = quote([{ product: product(), quantity: 1 }], WALLET, WALLET);
    // 10000 paise subtotal, 20% of it.
    expect(q.subtotalPaise).toBe(10_000);
    expect(q.maxDiscountPaise).toBe(2_000);
  });

  it('allows nothing from a line that opted out of coin redemption', () => {
    const q = quote(
      [{ product: product({ allowCoinRedemption: false }), quantity: 1 }],
      WALLET,
      WALLET,
    );
    expect(q.maxDiscountPaise).toBe(0);
    expect(q.discountPaise).toBe(0);
    expect(q.totalPaise).toBe(q.subtotalPaise);
  });

  it("respects a line's own lower percentage", () => {
    const q = quote(
      [{ product: product({ maxCoinRedemptionPercent: 5 }), quantity: 1 }],
      WALLET,
      WALLET,
    );
    // 5% of 10000, not the global 20%.
    expect(q.maxDiscountPaise).toBe(500);
  });

  it('sums each line allowance, so one opt-out does not sink the basket', () => {
    const q = quote(
      [
        { product: product({ id: 1 }), quantity: 1 },
        { product: product({ id: 2, allowCoinRedemption: false }), quantity: 1 },
      ],
      WALLET,
      WALLET,
    );
    // Subtotal 20000. Global cap 4000. Line allowance: 2000 + 0.
    expect(q.subtotalPaise).toBe(20_000);
    expect(q.maxDiscountPaise).toBe(2_000);
  });

  it('never exceeds the global cap even if a line asks for more', () => {
    const q = quote(
      [{ product: product({ maxCoinRedemptionPercent: 100 }), quantity: 1 }],
      WALLET,
      WALLET,
    );
    // The database CHECK orders_discount_within_cap is floor(subtotal * 0.20);
    // the quote must not be able to produce a value that violates it.
    expect(q.maxDiscountPaise).toBe(2_000);
  });

  it('is still clamped by the wallet', () => {
    const q = quote([{ product: product(), quantity: 1 }], 5, 1_000);
    expect(q.coinsSpent).toBe(5);
  });
});
