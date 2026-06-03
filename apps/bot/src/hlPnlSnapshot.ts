/**
 * HL-truth /pnl source. Reads positions + realized PnL straight from
 * Hyperliquid (`clearinghouseState` + `userFills`) instead of from the
 * bot's local fill ledger, which can drift if HL fills at a different
 * price than the limit we sent or if a fill record was missed entirely.
 */
import type { Address } from '@whalepod/schema';
import type { HttpHlTransport } from '@whalepod/sdk';

export interface HlOpenPosition {
  readonly coin: string;
  readonly szi: number;
  readonly entryPx: number;
  readonly unrealizedPnlUsd: number;
}

export interface HlPnlSnapshot {
  readonly realizedUsd: number;
  readonly feesUsd: number;
  readonly unrealizedUsd: number;
  readonly positions: readonly HlOpenPosition[];
}

export interface HlPnlProvider {
  forUser(mainWallet: Address): Promise<HlPnlSnapshot>;
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
interface RawUserFill {
  readonly closedPnl?: string | number;
  readonly fee?: string | number;
}

export class HlPnlSource implements HlPnlProvider {
  constructor(private readonly transport: Pick<HttpHlTransport, 'info'>) {}

  async forUser(mainWallet: Address): Promise<HlPnlSnapshot> {
    const [state, fills] = await Promise.all([
      this.transport.info<RawClearinghouseState>({
        type: 'clearinghouseState',
        user: mainWallet,
      }),
      this.transport.info<readonly RawUserFill[]>({
        type: 'userFills',
        user: mainWallet,
      }),
    ]);

    const positions: HlOpenPosition[] = [];
    let unrealizedUsd = 0;
    for (const ap of state.assetPositions ?? []) {
      const p = ap.position;
      if (!p?.coin) continue;
      const szi = num(p.szi);
      if (szi === 0) continue;
      const u = num(p.unrealizedPnl);
      unrealizedUsd += u;
      positions.push({
        coin: p.coin.toUpperCase(),
        szi,
        entryPx: num(p.entryPx),
        unrealizedPnlUsd: u,
      });
    }

    let realizedUsd = 0;
    let feesUsd = 0;
    for (const f of fills) {
      realizedUsd += num(f.closedPnl);
      feesUsd += num(f.fee);
    }

    return { realizedUsd, feesUsd, unrealizedUsd, positions };
  }
}

function num(v: unknown): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function renderHlPnl(snap: HlPnlSnapshot): { text: string } {
  const netRealized = snap.realizedUsd - snap.feesUsd;
  const total = netRealized + snap.unrealizedUsd;
  const lines: string[] = [
    '\ud83d\udcca Your PnL (from Hyperliquid)',
    '',
    `Total: ${emoji(total)} ${fmt(total)}`,
    `  \u2022 Closed trades: ${fmt(netRealized)}`,
    `  \u2022 Open unrealized: ${fmt(snap.unrealizedUsd)}`,
  ];
  if (snap.positions.length > 0) {
    lines.push('', 'Open positions:');
    for (const p of snap.positions) {
      const dir = p.szi > 0 ? 'LONG' : 'SHORT';
      lines.push(
        `  ${p.coin} ${dir} ${Math.abs(p.szi).toString()} @ $${p.entryPx.toString()}  \u2022  ${fmt(p.unrealizedPnlUsd)}`,
      );
    }
  } else {
    lines.push('', 'No open positions.');
  }
  return { text: lines.join('\n') };
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '$?';
  if (n === 0) return '$0.00';
  return `${n > 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}
function emoji(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '\u26aa\ufe0f';
  return n > 0 ? '\ud83d\udfe2' : '\ud83d\udd34';
}
