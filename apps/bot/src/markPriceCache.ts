/**
 * Live mark-price cache fed by Hyperliquid `info { type: 'allMids' }`.
 *
 * Refreshes on a fixed cadence; lookups are O(1) against an in-memory map.
 * Coin names are uppercased on insert so callers do not need to match HL's
 * case exactly (e.g. `eth` and `ETH` both resolve).
 *
 * Returns null when a coin is unknown, matching `MarkPriceFn`'s contract —
 * the /pnl renderer collapses unrealized to zero in that case rather than
 * showing a stale or guessed value.
 */
import type { HttpHlTransport } from '@whalepod/sdk';
import type { MarkPriceFn } from './pnl.js';

type AllMidsResponse = Record<string, string>;

export interface MarkPriceCacheOptions {
  readonly transport: HttpHlTransport;
  /** Refresh cadence in ms. */
  readonly refreshMs: number;
}

export class MarkPriceCache {
  private prices = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly opts: MarkPriceCacheOptions) {}

  async refresh(): Promise<void> {
    const res = await this.opts.transport.info<AllMidsResponse>({ type: 'allMids' });
    const next = new Map<string, string>();
    for (const [k, v] of Object.entries(res)) {
      if (typeof v === 'string' && v.length > 0) next.set(k.toUpperCase(), v);
    }
    this.prices = next;
  }

  /** Returns a stable `MarkPriceFn` bound to the cache's current state. */
  get(): MarkPriceFn {
    return (coin) => this.prices.get(coin.toUpperCase()) ?? null;
  }

  /** Start the background refresh loop. Safe to call once. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {
        /* swallow — next tick will retry */
      });
    }, this.opts.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
