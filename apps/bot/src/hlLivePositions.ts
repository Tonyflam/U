/**
 * Live HL position fetcher. Queries `clearinghouseState` and returns each
 * non-zero perp position for the user's main wallet. Used by the /close and
 * /closeall commands so we close based on what HL actually says is open, not
 * on the bot's reconstructed view (which can drift if a fill was missed).
 */
import type { Address } from '@whalepod/schema';
import type { HttpHlTransport } from '@whalepod/sdk';

export interface LivePosition {
  readonly coin: string;
  /** Signed size — positive = long, negative = short. */
  readonly szi: number;
  readonly entryPx: number;
  readonly unrealizedPnlUsd: number;
}

export interface LivePositionsLookup {
  forUser(mainWallet: Address): Promise<readonly LivePosition[]>;
}

interface RawAssetPosition {
  readonly position?: {
    readonly coin?: string;
    readonly szi?: string | number;
    readonly entryPx?: string | number;
    readonly unrealizedPnl?: string | number;
  };
}
interface RawClearinghouseState {
  readonly assetPositions?: readonly RawAssetPosition[];
}

export class HlLivePositions implements LivePositionsLookup {
  constructor(private readonly transport: Pick<HttpHlTransport, 'info'>) {}

  async forUser(mainWallet: Address): Promise<readonly LivePosition[]> {
    const raw = await this.transport.info<RawClearinghouseState>({
      type: 'clearinghouseState',
      user: mainWallet,
    });
    const out: LivePosition[] = [];
    for (const ap of raw.assetPositions ?? []) {
      const p = ap.position;
      if (!p?.coin) continue;
      const szi = num(p.szi);
      if (!Number.isFinite(szi) || szi === 0) continue;
      out.push({
        coin: p.coin.toUpperCase(),
        szi,
        entryPx: num(p.entryPx),
        unrealizedPnlUsd: num(p.unrealizedPnl),
      });
    }
    return out;
  }
}

function num(v: string | number | undefined): number {
  if (v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
