import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Address } from '@whalepod/schema';
import { MirrorFillEvent, renderFillNotification, type NotifyPrefs } from './notify.js';

const WHALE = Address.parse('0xabcd000000000000000000000000000000000001');

const base: MirrorFillEvent = MirrorFillEvent.parse({
  idempotencyKey: 'hl-fill-1:sub-1',
  whaleAddress: WHALE,
  coin: 'BTC',
  side: 'B',
  px: '50000',
  sz: '0.1',
  notionalUsd: '5000',
  builderFeeTenthsBp: 50,
  builderFeeUsd: '2.50',
  ts: 1_700_000_000_000,
});

describe('MirrorFillEvent schema', () => {
  it('accepts the canonical shape', () => {
    expect(() => MirrorFillEvent.parse({ ...base })).not.toThrow();
  });

  it('rejects fee > protocol cap', () => {
    expect(() => MirrorFillEvent.parse({ ...base, builderFeeTenthsBp: 101 })).toThrow();
  });

  it('rejects negative size / price strings', () => {
    expect(() => MirrorFillEvent.parse({ ...base, sz: '-1' })).toThrow();
    expect(() => MirrorFillEvent.parse({ ...base, px: '-1' })).toThrow();
  });

  it('accepts signed realized PnL', () => {
    expect(() => MirrorFillEvent.parse({ ...base, realizedPnlUsd: '-12.34' })).not.toThrow();
    expect(() => MirrorFillEvent.parse({ ...base, realizedPnlUsd: '12.34' })).not.toThrow();
  });
});

describe('renderFillNotification — multiline (default)', () => {
  it('shows side/size/coin/price line first', () => {
    const r = renderFillNotification(base);
    const first = r.text.split('\n')[0];
    expect(first).toBe('BUY 0.1 BTC @ 50000');
  });

  it('includes notional, fee, and the whale address by default', () => {
    const r = renderFillNotification(base);
    expect(r.text).toMatch(/Notional: \$5000\.00/);
    expect(r.text).toMatch(/Fee: \$2\.50 \(5\.0 bps\)/);
    expect(r.text).toMatch(/0xabcd…0001/);
  });

  it('prefers whaleAlias when present', () => {
    const r = renderFillNotification({ ...base, whaleAlias: 'TheWhale' });
    expect(r.text).toMatch(/Mirrored from TheWhale/);
    expect(r.text).not.toMatch(/0xabcd/);
  });

  it('renders SELL when side=S', () => {
    const r = renderFillNotification({ ...base, side: 'S' });
    expect(r.text.startsWith('SELL ')).toBe(true);
  });

  it('renders signed PnL with green for positive, red for negative', () => {
    const win = renderFillNotification({ ...base, realizedPnlUsd: '42.10' });
    expect(win.text).toMatch(/Realized PnL: 🟢 \$42\.10/);
    const loss = renderFillNotification({ ...base, realizedPnlUsd: '-12.34' });
    expect(loss.text).toMatch(/Realized PnL: 🔴 -\$12\.34/);
  });

  it('omits PnL line when not present', () => {
    expect(renderFillNotification(base).text).not.toMatch(/PnL/);
  });
});

describe('renderFillNotification — prefs', () => {
  it('showFee=false suppresses fee line', () => {
    const r = renderFillNotification(base, { showFee: false });
    expect(r.text).not.toMatch(/Fee:/);
    expect(r.text).not.toMatch(/bps/);
  });

  it('showPnl=false suppresses PnL even when present', () => {
    const r = renderFillNotification({ ...base, realizedPnlUsd: '42' }, { showPnl: false });
    expect(r.text).not.toMatch(/PnL/);
  });

  it('compact=true returns a single line', () => {
    const r = renderFillNotification(base, { compact: true });
    expect(r.text.split('\n')).toHaveLength(1);
    expect(r.text).toMatch(/Mirrored BUY 0\.1 BTC @ 50000/);
    expect(r.text).toMatch(/fee 5\.0 bps/);
  });

  it('compact respects showFee/showPnl too', () => {
    const r = renderFillNotification(
      { ...base, realizedPnlUsd: '5' },
      { compact: true, showFee: false, showPnl: false },
    );
    expect(r.text).not.toMatch(/fee/);
    expect(r.text).not.toMatch(/🟢|🔴/);
  });
});

describe('renderFillNotification — invariants', () => {
  it('property: showFee=false NEVER emits "bps" or "Fee:"', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'B' | 'S'>('B', 'S'),
        fc.integer({ min: 0, max: 100 }),
        fc.boolean(),
        (side, fee, compact) => {
          const ev: MirrorFillEvent = { ...base, side, builderFeeTenthsBp: fee };
          const prefs: NotifyPrefs = { showFee: false, compact };
          const r = renderFillNotification(ev, prefs);
          expect(r.text).not.toMatch(/bps/);
          expect(r.text.toLowerCase()).not.toMatch(/fee/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: rendered text always names the coin and the side', () => {
    fc.assert(
      fc.property(fc.constantFrom<'B' | 'S'>('B', 'S'), fc.boolean(), (side, compact) => {
        const r = renderFillNotification({ ...base, side }, { compact });
        expect(r.text).toMatch(/BTC/);
        expect(r.text).toMatch(side === 'B' ? /BUY/ : /SELL/);
      }),
      { numRuns: 50 },
    );
  });
});
