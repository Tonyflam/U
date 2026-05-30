/**
 * Hyperliquid testnet smoke harness.
 *
 * Read-only probe that exercises the public `info` endpoint via our SDK
 * transport. Verifies:
 *   1. transport reaches the configured base URL
 *   2. `meta` returns a non-empty universe of perp assets
 *   3. `allMids` returns a price map covering at least one common coin
 *   4. `MarkPriceCache` can be hydrated against the live response
 *
 * Does NOT submit orders, sign anything, or touch funds. Safe to run
 * from any environment with network egress to api.hyperliquid-testnet.xyz.
 *
 * CLI entry point lives in `smokeCli.ts` so this module is import-safe
 * for unit tests.
 */
import { HttpHlTransport, hlBaseUrl } from '@whalepod/sdk';
import { MarkPriceCache } from './markPriceCache.js';

interface MetaResponse {
  readonly universe: readonly { readonly name: string }[];
}

type AllMidsResponse = Record<string, string>;

const PROBE_COINS = ['BTC', 'ETH', 'SOL'] as const;

export function pickBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['HL_API_URL'];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const net = env['HL_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet';
  return hlBaseUrl(net);
}

export async function probeMeta(transport: HttpHlTransport): Promise<number> {
  const meta = await transport.info<MetaResponse>({ type: 'meta' });
  if (!Array.isArray(meta.universe) || meta.universe.length === 0) {
    throw new Error('meta.universe is empty');
  }
  return meta.universe.length;
}

export async function probeAllMids(transport: HttpHlTransport): Promise<number> {
  const mids = await transport.info<AllMidsResponse>({ type: 'allMids' });
  const keys = Object.keys(mids);
  if (keys.length === 0) throw new Error('allMids returned no entries');
  const upper = new Set(keys.map((k) => k.toUpperCase()));
  const covered = PROBE_COINS.filter((c) => upper.has(c));
  if (covered.length === 0) {
    throw new Error(`allMids missing all probe coins (${PROBE_COINS.join(',')})`);
  }
  return keys.length;
}

export async function probeMarkPriceCache(transport: HttpHlTransport): Promise<void> {
  const cache = new MarkPriceCache({ transport, refreshMs: 60_000 });
  await cache.refresh();
  const lookup = cache.get();
  const hit = PROBE_COINS.find((c) => lookup(c) !== null);
  if (hit === undefined) {
    throw new Error('MarkPriceCache hydrated but no probe coin resolved');
  }
  const px = lookup(hit);
  if (px === null || Number(px) <= 0) {
    throw new Error(`MarkPriceCache returned non-positive price for ${hit}`);
  }
}

export interface SmokeIo {
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
}

const DEFAULT_IO: SmokeIo = {
  out: (m) => process.stdout.write(m),
  err: (m) => process.stderr.write(m),
};

export async function runSmoke(
  io: SmokeIo = DEFAULT_IO,
  transportOverride?: HttpHlTransport,
): Promise<void> {
  const baseUrl = pickBaseUrl();
  const transport = transportOverride ?? new HttpHlTransport({ baseUrl });
  io.out(`[smoke] base=${baseUrl}\n`);

  const universeSize = await probeMeta(transport);
  io.out(`[smoke] meta ok (universe=${String(universeSize)})\n`);

  const midsSize = await probeAllMids(transport);
  io.out(`[smoke] allMids ok (entries=${String(midsSize)})\n`);

  await probeMarkPriceCache(transport);
  io.out('[smoke] markPriceCache ok\n');

  io.out('[smoke] PASS\n');
}
