/**
 * Curated whale directory.
 *
 * Each address has been verified against the Hyperliquid leaderboard
 * (30d realized PnL) and HypurrScan (account-value history). Entries here
 * appear on the public /whales directory AND in the bot's /whales command.
 *
 * To add a whale: append an entry, redeploy. The build script fetches
 * fresh positions + recent-PnL data from Hyperliquid at deploy time, and
 * the client refreshes live data every 30s.
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
    address: '0x632b0a6bb6b6184b97f61a6c773077cab99d1838',
    alias: 'Spot-Specialist',
    specialty: 'Spot',
    tagline: 'Spot/perp hybrid. Near-zero drawdown across cycles.',
  },
  {
    address: '0x99b1098d9d50aa076f78bd26ab22e6abd3710729',
    alias: 'BNB-Sharp',
    specialty: 'BNB',
    tagline: 'BNB-focused. Multi-cycle survivor on tight risk.',
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
    address: '0x54dbc1fbf6b1cd59807db61109b1d9eb91fd1a04',
    alias: 'Patient-145',
    specialty: 'Multi',
    tagline: 'Long-term holder. Few but conviction-sized trades.',
  },
  {
    address: '0x5e8e18557c0df89fb79a41941c03768da69100af',
    alias: 'Steady-44',
    specialty: 'Diversified',
    tagline: 'Diversified directional. Steady monthly compounder.',
  },
  {
    address: '0x6dc903ab5fe0d286cbef6c5042dd2684b7fd78d7',
    alias: 'Trend-166',
    specialty: 'Multi',
    tagline: 'Trend-follower across BTC/ETH/HYPE.',
  },
];
