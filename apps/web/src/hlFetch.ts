/**
 * Hyperliquid public `/info` adapter for build-time whale-stats hydration.
 *
 * Wraps the SDK's `HttpHlTransport` (which centralizes timeouts, abort
 * handling, and the typed fetch dependency injection) so the web build
 * can ask each curated whale for live positions + PnL windows without
 * re-implementing transport semantics.
 *
 * Used by the /whales page generator. Two endpoints are surfaced:
 *
 *   - {@link fetchClearinghouseState}: live positions + account equity.
 *   - {@link fetchUserFills}: recent fills, summed into realized PnL +
 *     fee totals across configurable windows.
 *
 * Individual whale failures must NOT fail the build — callers swallow
 * errors and render a "data stale" placeholder.
 */
import { HttpHlTransport } from '@whalepod/sdk';

export interface HlOpenPosition {
  readonly coin: string;
  readonly side: 'long' | 'short';
  readonly sizeUsd: number;
  readonly entryPx: number;
  readonly unrealizedPnlUsd: number;
}

export interface HlClearinghouse {
  readonly equityUsd: number;
  readonly positions: readonly HlOpenPosition[];
}

export interface HlPnlWindows {
  /** Sum of `closedPnl` across all fills returned by HL (~last 2000). */
  readonly allTimeUsd: number;
  /** Sum of `closedPnl` over the last 30 days. */
  readonly thirtyDayUsd: number;
  /** Sum of `closedPnl` over the last 7 days. */
  readonly sevenDayUsd: number;
  /** Total fees paid across HL-returned fills. */
  readonly feesUsd: number;
  /** Count of fills returned by HL — proxy for activity. */
  readonly fillCount: number;
  /** Unix ms of newest fill, or null if none. */
  readonly lastFillTs: number | null;
}

const HL_BASE_URL = 'https://api.hyperliquid.xyz';
const REQUEST_TIMEOUT_MS = 8_000;
const DAY_MS = 86_400_000;

interface RawAssetPosition {
  readonly position?: {
    readonly coin?: string;
    readonly szi?: string | number;
    readonly entryPx?: string | number;
    readonly unrealizedPnl?: string | number;
    readonly positionValue?: string | number;
  };
}

interface RawClearinghouseState {
  readonly assetPositions?: readonly RawAssetPosition[];
  readonly marginSummary?: {
    readonly accountValue?: string | number;
  };
}

interface RawUserFill {
  readonly closedPnl?: string | number;
  readonly fee?: string | number;
  readonly time?: number;
}

export interface HlFetchOptions {
  /** SDK transport override; tests inject a stub. */
  readonly transport?: Pick<HttpHlTransport, 'info'>;
}

function defaultTransport(): HttpHlTransport {
  return new HttpHlTransport({ baseUrl: HL_BASE_URL, timeoutMs: REQUEST_TIMEOUT_MS });
}

export async function fetchClearinghouseState(
  address: string,
  opts: HlFetchOptions = {},
): Promise<HlClearinghouse> {
  const t = opts.transport ?? defaultTransport();
  const raw = await t.info<RawClearinghouseState>({ type: 'clearinghouseState', user: address });
  const equityUsd = num(raw.marginSummary?.accountValue);
  const positions: HlOpenPosition[] = [];
  for (const ap of raw.assetPositions ?? []) {
    const p = ap.position;
    if (!p?.coin) continue;
    const szi = num(p.szi);
    if (szi === 0) continue;
    const entryPx = num(p.entryPx);
    const sizeUsd = num(p.positionValue) || Math.abs(szi) * entryPx;
    positions.push({
      coin: p.coin.toUpperCase(),
      side: szi > 0 ? 'long' : 'short',
      sizeUsd,
      entryPx,
      unrealizedPnlUsd: num(p.unrealizedPnl),
    });
  }
  positions.sort((a, b) => b.sizeUsd - a.sizeUsd);
  return { equityUsd, positions };
}

export async function fetchUserFills(
  address: string,
  opts: HlFetchOptions & { readonly now?: () => number } = {},
): Promise<HlPnlWindows> {
  const t = opts.transport ?? defaultTransport();
  const fills = await t.info<readonly RawUserFill[]>({ type: 'userFills', user: address });
  return summarizeFills(fills, opts.now ?? Date.now);
}

export function summarizeFills(
  fills: readonly RawUserFill[],
  now: () => number = Date.now,
): HlPnlWindows {
  const cutoff30 = now() - 30 * DAY_MS;
  const cutoff7 = now() - 7 * DAY_MS;
  let allTime = 0;
  let thirty = 0;
  let seven = 0;
  let fees = 0;
  let lastTs: number | null = null;
  for (const f of fills) {
    const pnl = num(f.closedPnl);
    const fee = num(f.fee);
    allTime += pnl;
    fees += fee;
    if (typeof f.time === 'number') {
      if (lastTs === null || f.time > lastTs) lastTs = f.time;
      if (f.time >= cutoff30) thirty += pnl;
      if (f.time >= cutoff7) seven += pnl;
    }
  }
  return {
    allTimeUsd: allTime,
    thirtyDayUsd: thirty,
    sevenDayUsd: seven,
    feesUsd: fees,
    fillCount: fills.length,
    lastFillTs: lastTs,
  };
}

function num(v: string | number | undefined): number {
  if (v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
