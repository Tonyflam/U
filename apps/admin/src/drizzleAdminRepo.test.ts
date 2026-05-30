import { describe, expect, it } from 'vitest';
import { DrizzleAdminRepo } from './drizzleAdminRepo.js';
import type { AdminRepo } from './admin.js';

/**
 * Smoke-level tests. Real query behavior is covered by the Postgres
 * integration suite (lands in a follow-up unit). Here we only verify:
 *   1. The class implements the full `AdminRepo` interface.
 *   2. Every method on the concrete class is callable.
 */
describe('DrizzleAdminRepo', () => {
  it('satisfies the AdminRepo interface', () => {
    const ctor: new (db: never) => AdminRepo = DrizzleAdminRepo;
    expect(typeof ctor).toBe('function');
  });

  it('exposes every method the handler layer calls', () => {
    const proto = DrizzleAdminRepo.prototype as unknown as Record<string, unknown>;
    for (const m of [
      'listCuratedWhales',
      'upsertCuratedWhale',
      'removeCuratedWhale',
      'getUserById',
      'setUserPaused',
      'setUserRevoked',
      'getGlobalKill',
      'setGlobalKill',
      'appendAudit',
    ]) {
      expect(typeof proto[m], `DrizzleAdminRepo.${m}`).toBe('function');
    }
  });
});
