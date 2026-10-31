import { describe, expect, it } from 'bun:test';
import { FACTOR_VERSION } from './factors.ts';
import { METHODOLOGY, METHODOLOGY_FACTORS } from './methodology.ts';

/**
 * The published table is derived from `factors.ts`, so these assert the
 * derivation rather than the numbers — the numbers have their own spec.
 */
describe('published methodology', () => {
  it('gives every factor a unique key', () => {
    const keys = METHODOLOGY_FACTORS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves no factor without a unit, basis and source', () => {
    // The page exists so that "where does 0.71 come from?" has an answer in
    // the product. A factor with an empty source is that question unanswered.
    const incomplete = METHODOLOGY_FACTORS.filter(
      (f) => !f.unit.trim() || !f.basis.trim() || !f.source.trim(),
    );
    expect(incomplete.map((f) => f.key)).toEqual([]);
  });

  it('publishes every transport mode the daily log can send', () => {
    // ride_sharing is the live example of a mode that exists in jsonb trips
    // but not in the commute_mode enum. If it is calculable it is publishable.
    const keys = new Set(METHODOLOGY_FACTORS.map((f) => f.key));
    for (const mode of ['transport.ride_sharing', 'transport.cab', 'transport.car_electric']) {
      expect(keys.has(mode)).toBe(true);
    }
  });

  it('reports the factor version the engine actually used', () => {
    expect(METHODOLOGY.factorVersion).toBe(FACTOR_VERSION);
    expect(METHODOLOGY.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries the whole table, not a sample', () => {
    // A guard against a group being dropped from the spread by accident: the
    // five categories together are well over forty entries.
    expect(METHODOLOGY_FACTORS.length).toBeGreaterThan(40);
    for (const prefix of ['transport.', 'food.', 'home_energy.', 'water.', 'waste.']) {
      expect(METHODOLOGY_FACTORS.some((f) => f.key.startsWith(prefix))).toBe(true);
    }
  });
});
