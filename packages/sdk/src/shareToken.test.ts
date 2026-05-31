import { describe, it, expect } from 'vitest';
import { signTradeShare, verifyTradeShare, type TradeSharePayload } from './shareToken.js';

const SECRET = 'test-secret-do-not-use-in-prod';

const payload: TradeSharePayload = {
  code: 'abc123',
  coin: 'ETH',
  side: 'long',
  sz: '0.4',
  entryPx: '2000',
  exitPx: '2050',
  pnlUsd: '20.00',
  pnlPct: '2.50',
  whaleAlias: 'big_kahuna',
  ts: 1717000000000,
};

describe('shareToken', () => {
  it('roundtrips a payload', () => {
    const t = signTradeShare(payload, SECRET);
    expect(verifyTradeShare(t, SECRET)).toEqual(payload);
  });

  it('rejects wrong secret', () => {
    const t = signTradeShare(payload, SECRET);
    expect(verifyTradeShare(t, 'wrong')).toBeNull();
  });

  it('rejects tampered json', () => {
    const t = signTradeShare(payload, SECRET);
    // Re-sign a different payload with the SAME secret but swap its
    // body bytes for the original token's signature — verifies that the
    // signature must match the body byte-for-byte.
    const other = signTradeShare({ ...payload, pnlUsd: '9999.99' }, SECRET);
    const otherBody = other.slice(0, other.indexOf('.'));
    const origSig = t.slice(t.indexOf('.') + 1);
    expect(verifyTradeShare(`${otherBody}.${origSig}`, SECRET)).toBeNull();
  });

  it('rejects malformed token', () => {
    expect(verifyTradeShare('not-a-token', SECRET)).toBeNull();
    expect(verifyTradeShare('', SECRET)).toBeNull();
    expect(verifyTradeShare('.x', SECRET)).toBeNull();
  });

  it('handles null whaleAlias', () => {
    const p = { ...payload, whaleAlias: null };
    const t = signTradeShare(p, SECRET);
    expect(verifyTradeShare(t, SECRET)).toEqual(p);
  });
});
