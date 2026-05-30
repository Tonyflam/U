/**
 * HL perp asset-index resolver.
 *
 * HL identifies each perp by its position in the `meta.universe` array.
 * We fetch it once at startup, build a `coin → index` map, and refresh
 * on a timer (universe expands when HL lists new perps). A miss returns
 * `undefined` which the mirror engine treats as `asset_unknown`.
 */
import type { HttpHlTransport } from '@whalepod/sdk';
import type { AssetIndexResolver } from './mirrorEngine.js';

interface UniverseEntry {
  readonly name: string;
}
interface HlMeta {
  readonly universe: readonly UniverseEntry[];
}

export class HlAssetIndex implements AssetIndexResolver {
  private map: ReadonlyMap<string, number> = new Map();
  private lastRefreshMs = 0;

  constructor(
    private readonly transport: Pick<HttpHlTransport, 'info'>,
    private readonly options: { readonly refreshMs?: number; readonly now?: () => number } = {},
  ) {}

  async refresh(): Promise<void> {
    const meta = await this.transport.info<HlMeta>({ type: 'meta' });
    const next = new Map<string, number>();
    meta.universe.forEach((entry, idx) => {
      next.set(entry.name.toUpperCase(), idx);
    });
    this.map = next;
    this.lastRefreshMs = (this.options.now ?? Date.now)();
  }

  /**
   * Synchronous resolve as required by `AssetIndexResolver`. Returns
   * `undefined` until `refresh()` has been called at least once.
   */
  resolve(coin: string): number | undefined {
    return this.map.get(coin.toUpperCase());
  }

  /** Read for diagnostics/tests. */
  size(): number {
    return this.map.size;
  }

  /** When the cache was last populated (ms epoch); 0 if never. */
  lastRefresh(): number {
    return this.lastRefreshMs;
  }
}
