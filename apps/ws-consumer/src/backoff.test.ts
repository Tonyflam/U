import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { backoffMs } from './backoff.js';

describe('backoffMs', () => {
  it('attempt 0 falls in [0, baseMs)', () => {
    for (let i = 0; i < 50; i += 1) {
      const v = backoffMs(0, { baseMs: 100, maxMs: 10_000 });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(100);
    }
  });

  it('window grows exponentially up to the cap', () => {
    // With rng=1-ε we get nearly the full window.
    const high = (): number => 0.999;
    expect(backoffMs(0, { baseMs: 100, maxMs: 1_000_000, rng: high })).toBeGreaterThanOrEqual(99);
    expect(backoffMs(3, { baseMs: 100, maxMs: 1_000_000, rng: high })).toBeGreaterThanOrEqual(799);
  });

  it('respects maxMs ceiling on large attempt numbers', () => {
    const v = backoffMs(40, { baseMs: 100, maxMs: 30_000, rng: () => 0.999 });
    expect(v).toBeLessThanOrEqual(30_000);
  });

  it('coerces negative attempts to 0', () => {
    const v = backoffMs(-5, { baseMs: 100, maxMs: 10_000, rng: () => 0.5 });
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(100);
  });

  it('property: result is always within [0, maxMs]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 10_000, max: 1_000_000 }),
        (attempt, base, max) => {
          const v = backoffMs(attempt, { baseMs: base, maxMs: max });
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(max);
        },
      ),
      { numRuns: 300 },
    );
  });
});
