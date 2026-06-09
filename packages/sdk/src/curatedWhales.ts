/**
 * Curated whale registry — single source of truth shared by the public
 * /whales directory page (build-time hydration) and the Telegram bot
 * (deep-link routing for `src_whale_<slug>` start parameters).
 *
 * Each address has been verified against the Hyperliquid leaderboard
 * (30d realized PnL) and HypurrScan (account-value history). The build
 * script auto-hides any whose 30d realized PnL drops below the configured
 * threshold so we never advertise a current loser.
 *
 * To promote a new whale: append an entry, bump deploy. The build script
 * fetches fresh positions + recent PnL from Hyperliquid at build time.
 */

export type WhaleSpecialty = 'HYPE' | 'BTC' | 'BNB' | 'ETH' | 'Spot' | 'Multi' | 'Diversified';

export interface CuratedWhale {
  readonly address: `0x${string}`;
  readonly alias: string;
  readonly specialty: WhaleSpecialty;
  /** One-line trader thesis surfaced under the alias on the card. */
  readonly tagline: string;
}

export const CURATED_WHALES: readonly CuratedWhale[] = [
  {
    address: '0xc6758a779bccee1ef0190dbe8292fdf44076795d',
    alias: 'HYPE-Maxi',
    specialty: 'HYPE',
    tagline: 'HYPE perp specialist. Concentrated, scales in trends.',
  },
  {
    address: '0x0ddf9bae2af4b874b96d287a5ad42eb47138a902',
    alias: 'ETH-Lead',
    specialty: 'ETH',
    tagline: 'Top of the HL board. ETH-led directional, 3x max leverage.',
  },
  {
    address: '0xd05808946809c180d190608e13f473db30aa8524',
    alias: 'BTC-Pure',
    specialty: 'BTC',
    tagline: 'BTC-only directional. Holds size through volatility.',
  },
  {
    address: '0x5ae7fe9df15590e286152908112b82969f41c8b8',
    alias: 'BTC-Volume-King',
    specialty: 'BTC',
    tagline: 'High-turnover BTC scalper. Consistent monthly.',
  },
  {
    address: '0xf822fa0fd364c573fcdb7009fcf47601bc8be01a',
    alias: 'Macro-Multi',
    specialty: 'Multi',
    tagline: 'Macro book across BTC/ETH/HYPE. Conservative, 3x max.',
  },
  {
    address: '0x54dbc1fbf6b1cd59807db61109b1d9eb91fd1a04',
    alias: 'Patient-145',
    specialty: 'Multi',
    tagline: 'Long-term holder. Few but conviction-sized trades.',
  },
  {
    address: '0xb798aef79972ce8f73d47b9ebbcda6bbb7ec4fbf',
    alias: 'BTC-Anchor',
    specialty: 'BTC',
    tagline: 'BTC conviction at 2x. Ultra-low leverage.',
  },
  {
    address: '0x218a65e21eddeece7a9df38c6bbdd89f692b7da2',
    alias: 'Dual-Major',
    specialty: 'Multi',
    tagline: 'Concentrated major-pair book. Tight 2-leg directional.',
  },
];

/**
 * Stable slug used in `/start` deep-link payloads (`src_whale_<slug>`).
 *
 * Lowercase alphanumerics only — strips dashes, spaces, and any other
 * separator so slugs are safe inside Telegram start parameters and don't
 * conflict with the `src_*` channel grammar.
 *
 *   whaleSlug('HYPE-Maxi')        // 'hypemaxi'
 *   whaleSlug('BTC-Volume-King')  // 'btcvolumeking'
 *   whaleSlug('BTC-Anchor')       // 'btcanchor'
 */
export function whaleSlug(alias: string): string {
  return alias.toLowerCase().replace(/[^a-z0-9]+/gu, '');
}

/**
 * Resolves a `src_whale_<slug>` deep-link to its curated whale.
 * Returns `null` for unknown slugs; callers should fall back to the
 * generic onboard flow.
 */
export function findCuratedWhaleBySlug(slug: string): CuratedWhale | null {
  const norm = slug.toLowerCase();
  return CURATED_WHALES.find((w) => whaleSlug(w.alias) === norm) ?? null;
}
