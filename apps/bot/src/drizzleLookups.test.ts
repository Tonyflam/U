import { describe, expect, it } from 'vitest';
import { DrizzleAgentKeyLookup, DrizzleUserAddressLookup } from './drizzleLookups.js';
import type { UserAddressLookup } from './hlInfoEquity.js';
import type { AgentKeyLookup } from './kmsAgentSigner.js';

/**
 * Smoke tests mirror `drizzleBotRepo.test.ts` — assignability + method
 * presence. Query-shape verification happens in the integration suite.
 */
describe('DrizzleUserAddressLookup', () => {
  it('satisfies the UserAddressLookup interface', () => {
    const ctor: new (db: never) => UserAddressLookup = DrizzleUserAddressLookup;
    expect(typeof ctor).toBe('function');
  });

  it('exposes mainWalletFor', () => {
    const proto = DrizzleUserAddressLookup.prototype as unknown as Record<string, unknown>;
    expect(typeof proto['mainWalletFor']).toBe('function');
  });
});

describe('DrizzleAgentKeyLookup', () => {
  it('satisfies the AgentKeyLookup interface', () => {
    const ctor: new (db: never) => AgentKeyLookup = DrizzleAgentKeyLookup;
    expect(typeof ctor).toBe('function');
  });

  it('exposes forUser', () => {
    const proto = DrizzleAgentKeyLookup.prototype as unknown as Record<string, unknown>;
    expect(typeof proto['forUser']).toBe('function');
  });
});
