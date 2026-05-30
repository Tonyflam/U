import { describe, expect, it } from 'vitest';
import { DrizzleBotRepo } from './drizzleBotRepo.js';
import type { BotRepo } from './handlers.js';

/**
 * Smoke-level tests for `DrizzleBotRepo`. Real query behavior is covered by
 * the integration suite (U18, requires Postgres). Here we only verify that:
 *   1. The class implements the full `BotRepo` interface (every method is
 *      assignable to its slot).
 *   2. Every method on the concrete class is callable (catches accidental
 *      typos before integration tests run).
 */
describe('DrizzleBotRepo', () => {
  it('satisfies the BotRepo interface', () => {
    // Compile-time check via assignment. If the class drifts from `BotRepo`,
    // typecheck breaks here before any test runs.
    const ctor: new (db: never) => BotRepo = DrizzleBotRepo;
    expect(typeof ctor).toBe('function');
  });

  it('exposes every method the handler layer calls', () => {
    const proto = DrizzleBotRepo.prototype as unknown as Record<string, unknown>;
    for (const m of [
      'getUserByTgId',
      'getWhaleByAddress',
      'upsertWhaleByAddress',
      'listSubscriptions',
      'subscribe',
      'unsubscribe',
      'setAllSubscriptionsPaused',
      'setSubscriptionTpSl',
      'setKillSwitch',
      'setCurrentFee',
      'appendAudit',
    ]) {
      expect(typeof proto[m], `DrizzleBotRepo.${m}`).toBe('function');
    }
  });
});
