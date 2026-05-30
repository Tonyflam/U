/**
 * HL `/info` clearinghouseState adapter for the risk engine's
 * `accountEquity.forUser` provider.
 *
 * - Resolves the user's main wallet via injected `UserAddressLookup`.
 * - Calls HL `/info` with {type:'clearinghouseState', user}.
 * - Returns `marginSummary.accountValue` and `withdrawable`.
 * - On any transport error or shape mismatch, returns undefined so the risk
 *   engine fails closed (`equity_unknown`). We never crash the worker for
 *   an upstream blip.
 *
 * Short caching is performed in-process to avoid hammering HL when a user
 * fires many rapid mirror attempts. Cache TTL defaults to 5s.
 */
import type { Address } from '@whalepod/schema';
import type { HttpHlTransport } from '@whalepod/sdk';
import type { AccountEquity } from './riskEngine.js';

export interface UserAddressLookup {
  /** Resolve the user's main wallet (lowercased). */
  mainWalletFor(userId: string): Promise<Address | undefined>;
}

export interface HlInfoEquityOptions {
  readonly transport: Pick<HttpHlTransport, 'info'>;
  readonly addresses: UserAddressLookup;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

interface ClearinghouseState {
  readonly marginSummary?: {
    readonly accountValue?: string | number;
  };
  readonly withdrawable?: string | number;
}

interface CacheEntry {
  readonly equity: AccountEquity;
  readonly expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5_000;

export class HlInfoEquity {
  private readonly transport: Pick<HttpHlTransport, 'info'>;
  private readonly addresses: UserAddressLookup;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: HlInfoEquityOptions) {
    this.transport = options.transport;
    this.addresses = options.addresses;
    this.ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async forUser(userId: string): Promise<AccountEquity | undefined> {
    const now = this.now();
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > now) return cached.equity;

    const addr = await this.addresses.mainWalletFor(userId);
    if (addr === undefined) return undefined;

    let raw: ClearinghouseState;
    try {
      raw = await this.transport.info<ClearinghouseState>({
        type: 'clearinghouseState',
        user: addr,
      });
    } catch {
      return undefined;
    }
    const equityUsd = parseNum(raw.marginSummary?.accountValue);
    const withdrawableUsd = parseNum(raw.withdrawable);
    if (equityUsd === undefined) return undefined;
    const equity: AccountEquity = {
      equityUsd,
      withdrawableUsd: withdrawableUsd ?? 0,
    };
    this.cache.set(userId, { equity, expiresAt: now + this.ttl });
    return equity;
  }
}

function parseNum(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
