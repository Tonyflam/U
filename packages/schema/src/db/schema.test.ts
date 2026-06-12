import { describe, expect, it } from 'vitest';
import {
  auditLog,
  fills,
  killSwitchesGlobal,
  referrals,
  referralsAttribution,
  subscriptions,
  users,
  watches,
  whales,
} from './schema.js';

describe('Drizzle schema', () => {
  it('declares all seven tables from phase-2 §4.1', () => {
    const tables = {
      users,
      whales,
      subscriptions,
      fills,
      referrals,
      referrals_attribution: referralsAttribution,
      audit_log: auditLog,
      kill_switches_global: killSwitchesGlobal,
    };
    expect(Object.keys(tables)).toHaveLength(8);
    for (const [name, t] of Object.entries(tables)) {
      expect(t, `${name} should be a Drizzle table`).toBeDefined();
    }
  });

  it('users table has required security columns', () => {
    const cols = Object.keys(users);
    for (const must of [
      'tgUserId',
      'mainWallet',
      'agentAddress',
      'agentKeyCt',
      'agentKeyIv',
      'agentKeyTag',
      'agentDekCt',
      'approvedMaxFeeTenthsBp',
      'killSwitch',
    ]) {
      expect(cols).toContain(must);
    }
  });

  it('fills table has builder fee accounting columns', () => {
    const cols = Object.keys(fills);
    expect(cols).toContain('builderFeeTenthsBp');
    expect(cols).toContain('builderFeeUsd');
    expect(cols).toContain('realizedPnlUsd');
    expect(cols).toContain('isMirror');
    expect(cols).toContain('mirrorOfId');
  });

  it('subscriptions has the user_id/whale_id pair', () => {
    const cols = Object.keys(subscriptions);
    expect(cols).toContain('userId');
    expect(cols).toContain('whaleId');
    expect(cols).toContain('maxSizeUsd');
    expect(cols).toContain('maxLeverage');
  });

  it('subscriptions has nullable TP/SL offset columns', () => {
    const cols = Object.keys(subscriptions);
    expect(cols).toContain('tpBps');
    expect(cols).toContain('slBps');
  });

  it('watches keys on tg_user_id (no users FK — zero-trust watchers)', () => {
    const cols = Object.keys(watches);
    expect(cols).toContain('tgUserId');
    expect(cols).toContain('whaleId');
    expect(cols).not.toContain('userId');
  });
});
