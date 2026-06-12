import { describe, expect, it } from 'vitest';
import type { WatchFillEvent } from '@whalepod/ws-consumer';
import { renderWatchAlert } from './watchNotify.js';

const BOT = 'WhalePodBot';

const base: WatchFillEvent = {
  fillHash: '0xfill1',
  whaleAddress: '0xc6758a779bccee1ef0190dbe8292fdf44076795d',
  whaleAlias: 'HYPE-Maxi',
  coin: 'HYPE',
  side: 'B',
  px: '44.21',
  sz: '1200',
  whaleTs: 1_700_000_000_000,
};

describe('renderWatchAlert', () => {
  it('renders a buy alert with alias, notional and follow CTA', () => {
    const reply = renderWatchAlert(base, { botUsername: BOT });
    expect(reply.text).toContain('🟢 HYPE-Maxi just BOUGHT 1200 HYPE @ 44.21');
    expect(reply.text).toContain('$53,052');
    expect(reply.text).toContain(`/follow ${base.whaleAddress} 50`);
    expect(reply.text).toContain(`/unwatch ${base.whaleAddress}`);
  });

  it('deep-links curated whales into the whale-intent /start funnel', () => {
    const reply = renderWatchAlert(base, { botUsername: BOT });
    const btn = reply.buttons?.[0]?.[0];
    expect(btn?.label).toBe('⚡ Mirror HYPE-Maxi');
    expect(btn?.url).toBe(`https://t.me/${BOT}?start=src_whale_hypemaxi`);
  });

  it('falls back to a short address + generic watch channel for unknown whales', () => {
    const reply = renderWatchAlert(
      { ...base, whaleAddress: '0x9999000000000000000000000000000000000abc', whaleAlias: null },
      { botUsername: BOT },
    );
    expect(reply.text).toContain('0x9999…0abc just BOUGHT');
    expect(reply.buttons?.[0]?.[0]?.url).toBe(`https://t.me/${BOT}?start=src_watch`);
  });

  it('renders sells red with SOLD', () => {
    const reply = renderWatchAlert({ ...base, side: 'S' }, { botUsername: BOT });
    expect(reply.text).toContain('🔴 HYPE-Maxi just SOLD');
  });

  it('omits the notional line when price is not numeric', () => {
    const reply = renderWatchAlert({ ...base, px: '44.21', sz: '0' }, { botUsername: BOT });
    expect(reply.text).not.toContain('notional');
  });
});
