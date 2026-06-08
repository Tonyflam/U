import { describe, expect, it } from 'vitest';
import { buildWhalesHtml, buildWhalesJson, type WhaleSnapshot } from './whales.js';
import { CURATED_WHALES } from './whalesData.js';

const GENERATED_AT = 1_717_800_000_000;

function snap(overrides: Partial<WhaleSnapshot> = {}): WhaleSnapshot {
  const meta = CURATED_WHALES[0];
  if (!meta) throw new Error('curated whales seed is empty');
  return {
    meta,
    equityUsd: 2_820_000,
    positions: [
      { coin: 'HYPE', side: 'long', sizeUsd: 1_400_000, entryPx: 28.5, unrealizedPnlUsd: 145_000 },
      { coin: 'BTC', side: 'short', sizeUsd: 900_000, entryPx: 71200, unrealizedPnlUsd: -32_000 },
    ],
    allTimeUsd: 4_370_000,
    thirtyDayUsd: 3_190_000,
    sevenDayUsd: 480_000,
    fillCount: 1432,
    fetchedAt: GENERATED_AT,
    stale: false,
    ...overrides,
  };
}

describe('buildWhalesHtml', () => {
  const baseEnv = {
    botUrl: 'https://t.me/whalepod_bot',
    snapshots: [snap()],
    generatedAt: GENERATED_AT,
  };

  it('embeds canonical URL pointing to /whales/', () => {
    const html = buildWhalesHtml(baseEnv);
    expect(html).toContain('<link rel="canonical" href="https://www.whalepod.trade/whales/">');
  });

  it('renders an article per snapshot with the address as data attribute', () => {
    const html = buildWhalesHtml(baseEnv);
    const meta = CURATED_WHALES[0];
    expect(meta).toBeDefined();
    expect(html).toContain(`data-address="${meta!.address}"`);
    expect(html).toContain(`data-specialty="${meta!.specialty}"`);
  });

  it('truncates the address in the visible header to a short form', () => {
    const html = buildWhalesHtml(baseEnv);
    const meta = CURATED_WHALES[0]!;
    const short = `${meta.address.slice(0, 6)}…${meta.address.slice(-4)}`;
    expect(html).toContain(short);
  });

  it('formats 30d PnL in millions with a leading sign', () => {
    const html = buildWhalesHtml(baseEnv);
    expect(html).toContain('+$3.19M');
    expect(html).toContain('30d realized');
  });

  it('uses the unicode minus glyph for negative position PnL', () => {
    const html = buildWhalesHtml(baseEnv);
    expect(html).toContain('−$32.0K');
  });

  it('appends a src_whale_<slug> tracking param to the Mirror CTA', () => {
    const html = buildWhalesHtml(baseEnv);
    expect(html).toContain('?start=src_whale_hypemaxi');
  });

  it('marks stale whales with a visible "data stale" badge', () => {
    const html = buildWhalesHtml({
      ...baseEnv,
      snapshots: [
        snap({
          equityUsd: null,
          allTimeUsd: null,
          thirtyDayUsd: null,
          positions: [],
          stale: true,
        }),
      ],
    });
    expect(html).toContain('wcard-stale');
    expect(html).not.toContain('display:none">data stale');
  });

  it('renders "Flat right now" when positions are empty', () => {
    const html = buildWhalesHtml({
      ...baseEnv,
      snapshots: [snap({ positions: [] })],
    });
    expect(html).toContain('Flat right now');
  });

  it('caps the position list at 3 rows and adds a "+ N more" line', () => {
    const html = buildWhalesHtml({
      ...baseEnv,
      snapshots: [
        snap({
          positions: [
            { coin: 'A', side: 'long', sizeUsd: 1, entryPx: 1, unrealizedPnlUsd: 1 },
            { coin: 'B', side: 'long', sizeUsd: 1, entryPx: 1, unrealizedPnlUsd: 1 },
            { coin: 'C', side: 'long', sizeUsd: 1, entryPx: 1, unrealizedPnlUsd: 1 },
            { coin: 'D', side: 'long', sizeUsd: 1, entryPx: 1, unrealizedPnlUsd: 1 },
            { coin: 'E', side: 'long', sizeUsd: 1, entryPx: 1, unrealizedPnlUsd: 1 },
          ],
        }),
      ],
    });
    expect(html).toContain('+ 2 more positions');
  });

  it('shows "flat" badge when there are no positions', () => {
    const html = buildWhalesHtml({
      ...baseEnv,
      snapshots: [snap({ positions: [] })],
    });
    expect(html).toContain('>flat<');
  });

  it('embeds the generatedAt timestamp as a body attribute for client-side ticker', () => {
    const html = buildWhalesHtml(baseEnv);
    expect(html).toContain(`data-generated-at="${String(GENERATED_AT)}"`);
  });

  it('renders an empty-state when no snapshots are provided', () => {
    const html = buildWhalesHtml({ ...baseEnv, snapshots: [] });
    expect(html).toContain('No whales yet');
  });

  it('renders one filter pill per unique specialty in addition to "All"', () => {
    const meta1 = CURATED_WHALES[0]!;
    const meta2 = CURATED_WHALES[2]!; // BNB-Sharp — different specialty
    const html = buildWhalesHtml({
      ...baseEnv,
      snapshots: [snap({ meta: meta1 }), snap({ meta: meta2 })],
    });
    expect(html).toContain('data-filter="all"');
    expect(html).toContain(`data-filter="${meta1.specialty}"`);
    expect(html).toContain(`data-filter="${meta2.specialty}"`);
  });

  it('escapes a malicious bot URL', () => {
    const html = buildWhalesHtml({
      ...baseEnv,
      botUrl: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('buildWhalesJson', () => {
  it('exposes the public field names the page JS depends on', () => {
    const j = buildWhalesJson({
      botUrl: 'https://t.me/whalepod_bot',
      snapshots: [snap()],
      generatedAt: GENERATED_AT,
    });
    expect(j.generatedAt).toBe(GENERATED_AT);
    expect(j.whales).toHaveLength(1);
    const w = j.whales[0]!;
    expect(w.address).toBe(CURATED_WHALES[0]!.address);
    expect(w.thirtyDayUsd).toBe(3_190_000);
    expect(w.positions[0]!.coin).toBe('HYPE');
  });

  it('marks stale entries with null stats', () => {
    const j = buildWhalesJson({
      botUrl: 'https://t.me/whalepod_bot',
      snapshots: [
        snap({
          stale: true,
          equityUsd: null,
          allTimeUsd: null,
          thirtyDayUsd: null,
          sevenDayUsd: null,
          fillCount: null,
          positions: [],
        }),
      ],
      generatedAt: GENERATED_AT,
    });
    const w = j.whales[0]!;
    expect(w.stale).toBe(true);
    expect(w.equityUsd).toBeNull();
    expect(w.thirtyDayUsd).toBeNull();
  });
});
