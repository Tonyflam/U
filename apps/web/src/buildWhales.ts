/**
 * Build entry: hydrates each curated whale with live Hyperliquid data
 * and emits `public/whales/index.html` + `public/api/whales.json`.
 *
 * Failure semantics:
 *   - Individual whale HL failures are swallowed and rendered with a
 *     "data stale" badge and em-dash stats.
 *   - Total HL outage still produces a valid page (all whales stale).
 *   - The build itself NEVER throws, so a Vercel deploy is never gated
 *     by Hyperliquid availability.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWhalesHtml, buildWhalesJson, type WhaleSnapshot } from './whales.js';
import { CURATED_WHALES, type CuratedWhale } from './whalesData.js';
import {
  fetchClearinghouseState,
  fetchLeaderboardCandidates,
  fetchUserFills,
  type WhaleCandidate,
} from './hlFetch.js';

/**
 * Whales whose 30d realized PnL is at or below this threshold are
 * filtered OUT of the rendered page. They stay in the curated list so
 * they auto-rejoin next build if they recover.
 */
const MIN_30D_PNL_USD = 0;

export async function buildWhalesSite(opts: {
  readonly outDir: string;
  readonly botUrl: string;
  readonly now?: () => number;
  readonly log?: (msg: string) => void;
}): Promise<void> {
  const log =
    opts.log ??
    ((m: string) => {
      console.log(m);
    });
  const generatedAt = (opts.now ?? Date.now)();

  log(`whales: hydrating ${String(CURATED_WHALES.length)} curated addresses from HL`);
  const all = await hydrateAll(CURATED_WHALES, generatedAt, log);
  const live = all.filter((s) => !s.stale).length;

  // Auto-curate: drop whales whose 30d realized PnL is at or below the
  // threshold. We refuse to advertise losers on a "whales worth mirroring"
  // page — they auto-rejoin the next build if they recover.
  const snapshots = all.filter((s) => {
    if (s.stale) return true;
    if (s.thirtyDayUsd === null) return true;
    if (s.thirtyDayUsd <= MIN_30D_PNL_USD) {
      log(`whales: hiding ${s.meta.alias} — 30d $${s.thirtyDayUsd.toFixed(0)} below threshold`);
      return false;
    }
    return true;
  });
  log(
    `whales: ${String(live)}/${String(all.length)} fetched live, ${String(snapshots.length)} rendered after filter`,
  );

  const html = buildWhalesHtml({ botUrl: opts.botUrl, snapshots, generatedAt });
  const json = buildWhalesJson({ botUrl: opts.botUrl, snapshots, generatedAt });

  const whalesDir = join(opts.outDir, 'whales');
  const apiDir = join(opts.outDir, 'api');
  mkdirSync(whalesDir, { recursive: true });
  mkdirSync(apiDir, { recursive: true });

  const htmlPath = join(whalesDir, 'index.html');
  const jsonPath = join(apiDir, 'whales.json');
  writeFileSync(htmlPath, html, 'utf8');
  writeFileSync(jsonPath, JSON.stringify(json), 'utf8');
  log(`whales: wrote ${htmlPath} (${String(html.length)} bytes)`);
  log(`whales: wrote ${jsonPath} (${String(JSON.stringify(json).length)} bytes)`);

  await logCandidateReport(log);
}

/**
 * Pulls the public HL leaderboard and logs the top 5 candidates NOT
 * already in our curated list. Manual review only — we never
 * auto-promote, to keep the curation moat. Failure is non-fatal:
 * the build proceeds even if the leaderboard endpoint is down.
 */
async function logCandidateReport(log: (msg: string) => void): Promise<void> {
  try {
    log('whales: pulling HL leaderboard for promotion candidates…');
    const candidates = await fetchLeaderboardCandidates({
      excludeAddresses: CURATED_WHALES.map((w) => w.address),
    });
    if (candidates.length === 0) {
      log(
        'whales: no candidates passed the filter — bar may be too high or HL leaderboard is empty',
      );
      return;
    }
    log('');
    log('━━━ CANDIDATE REPORT (top non-curated by 30d realized PnL) ━━━');
    candidates.forEach((c, i) => {
      log(formatCandidateLine(i + 1, c));
    });
    log(
      '━━━ vet via https://hypurrscan.io/address/<addr>, then add to packages/sdk/src/curatedWhales.ts ━━━',
    );
    log('');
  } catch (err) {
    log(`whales: candidate report skipped — ${String((err as Error).message)}`);
  }
}

function formatCandidateLine(rank: number, c: WhaleCandidate): string {
  const name = c.displayName !== null && c.displayName.length > 0 ? ` "${c.displayName}"` : '';
  const pnl = `$${(c.thirtyDayPnlUsd / 1000).toFixed(0)}K`;
  const eq = `$${(c.equityUsd / 1000).toFixed(0)}K`;
  const roi = `${c.thirtyDayRoiPct.toFixed(1)}%`;
  const vol = `$${(c.thirtyDayVolumeUsd / 1_000_000).toFixed(1)}M`;
  const week = `$${(c.sevenDayPnlUsd / 1000).toFixed(0)}K`;
  return `  ${String(rank)}. ${c.address}${name}  30d=${pnl}  7d=${week}  eq=${eq}  roi=${roi}  vol=${vol}`;
}

async function hydrateAll(
  whales: readonly CuratedWhale[],
  generatedAt: number,
  log: (msg: string) => void,
): Promise<readonly WhaleSnapshot[]> {
  // 8 whales — plenty small for a single Promise.all without worker pooling.
  // HL `/info` shrugs off ~16 simultaneous requests; sub-second total.
  return Promise.all(whales.map((w) => hydrateOne(w, generatedAt, log)));
}

async function hydrateOne(
  meta: CuratedWhale,
  generatedAt: number,
  log: (msg: string) => void,
): Promise<WhaleSnapshot> {
  try {
    const [state, fills] = await Promise.all([
      fetchClearinghouseState(meta.address),
      fetchUserFills(meta.address),
    ]);
    return {
      meta,
      equityUsd: state.equityUsd,
      positions: state.positions,
      allTimeUsd: fills.allTimeUsd,
      thirtyDayUsd: fills.thirtyDayUsd,
      sevenDayUsd: fills.sevenDayUsd,
      fillCount: fills.fillCount,
      fetchedAt: generatedAt,
      stale: false,
    };
  } catch (err) {
    log(`whales: ${meta.alias} HL fetch failed — ${String((err as Error).message)}`);
    return {
      meta,
      equityUsd: null,
      positions: [],
      allTimeUsd: null,
      thirtyDayUsd: null,
      sevenDayUsd: null,
      fillCount: null,
      fetchedAt: generatedAt,
      stale: true,
    };
  }
}

// ─── direct-invocation entry (used by `npm run build -w @whalepod/web`) ────
const isCliEntry = (): boolean => {
  // Defensive: only run as CLI when this module IS the process entry point.
  // Importing from a test should never trigger the I/O.
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === new URL(`file://${argv1}`).href;
  } catch {
    return false;
  }
};

if (isCliEntry()) {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'public');
  const botUrl = process.env['BOT_URL'] ?? 'https://t.me/whalepod_bot';
  buildWhalesSite({ outDir, botUrl }).catch((err: unknown) => {
    // Never fail the deploy because of HL. Log + exit 0 with a placeholder.
    console.error('whales build failed:', err);
    process.exit(0);
  });
}
