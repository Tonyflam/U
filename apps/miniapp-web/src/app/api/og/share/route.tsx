/**
 * Dynamic OG image for /share. Renders a 1200x630 PnL card by compositing
 * the user's live PnL summary onto `/pnl-share-card.png`.
 *
 * Lookup:
 *   /api/og/share?code=<referralCode>
 *
 * The referral code resolves to a user; we read their realized + unrealized
 * PnL from the bot's `fills` ledger (same source `/pnl` uses, with the same
 * dust filter) and the top whale they mirror. Falls back to a neutral
 * "Mirror Hyperliquid whales" card if the code is unknown or the user has
 * no fills yet — so first-time inviters still get a clean preview.
 */
import { ImageResponse } from 'next/og';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { createDb, schema } from '@whalepod/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Telegram + Twitter unfurl caches aggressively; let the CDN hold ~5 min
// so we don't slam Neon on every chat preview.
export const revalidate = 300;

const W = 1200;
const H = 630;

let dbCached: ReturnType<typeof createDb> | undefined;
function getDb(): ReturnType<typeof createDb> {
  if (dbCached) return dbCached;
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL required');
  const ssl = (process.env['DATABASE_SSL'] ?? 'require') as 'require' | 'prefer' | 'disable';
  dbCached = createDb({ url, ssl, max: 1 });
  return dbCached;
}

interface CardData {
  readonly totalUsd: number;
  readonly realizedUsd: number;
  readonly unrealizedUsd: number;
  readonly topWhaleAlias: string | null;
  readonly mirrorsActive: number;
  readonly hasFills: boolean;
}

async function loadCard(code: string): Promise<CardData | null> {
  const { db } = getDb();
  const ref = await db
    .select({ ownerUserId: schema.referrals.ownerUserId })
    .from(schema.referrals)
    .where(eq(schema.referrals.code, code))
    .limit(1);
  const owner = ref[0];
  if (!owner) return null;

  const fills = await db
    .select({
      wallet: schema.fills.wallet,
      coin: schema.fills.coin,
      side: schema.fills.side,
      px: schema.fills.px,
      sz: schema.fills.sz,
      realizedPnlUsd: schema.fills.realizedPnlUsd,
      alias: schema.whales.alias,
    })
    .from(schema.fills)
    .leftJoin(schema.whales, eq(schema.whales.address, schema.fills.wallet))
    .where(
      and(
        eq(schema.fills.userId, owner.ownerUserId),
        eq(schema.fills.isMirror, true),
        isNotNull(schema.fills.builderFeeUsd),
      ),
    )
    .orderBy(desc(schema.fills.ts))
    .limit(500);

  // Group by whale → coin to compute netSz + costBasis, sum realized.
  type Pos = { netSz: number; cost: number };
  const byWhale = new Map<
    string,
    { alias: string | null; realized: number; positions: Map<string, Pos> }
  >();
  for (const f of fills) {
    const sz = Number(f.sz);
    const px = Number(f.px);
    if (!Number.isFinite(sz) || !Number.isFinite(px)) continue;
    const entry = byWhale.get(f.wallet) ?? { alias: f.alias, realized: 0, positions: new Map() };
    if (entry.alias === null && f.alias) entry.alias = f.alias;
    const signed = f.side === 'B' ? sz : -sz;
    const pos = entry.positions.get(f.coin) ?? { netSz: 0, cost: 0 };
    pos.netSz += signed;
    pos.cost += signed * px;
    entry.positions.set(f.coin, pos);
    entry.realized += f.realizedPnlUsd ? Number(f.realizedPnlUsd) : 0;
    byWhale.set(f.wallet, entry);
  }

  // We deliberately skip mark-price fetch on the share path — it would
  // require an extra HL roundtrip per request. Unrealized is approximated
  // as net open cost-basis sign-flipped (i.e. show 0 unrealized rather
  // than a stale-mark number that could mislead).
  let realized = 0;
  let topWhale: { alias: string | null; realized: number } | null = null;
  let activeMirrors = 0;
  for (const [, w] of byWhale) {
    realized += w.realized;
    let stillOpen = false;
    for (const p of w.positions.values()) if (Math.abs(p.netSz) > 1e-8) stillOpen = true;
    if (stillOpen) activeMirrors++;
    if (!topWhale || w.realized > topWhale.realized)
      topWhale = { alias: w.alias, realized: w.realized };
  }

  return {
    totalUsd: realized,
    realizedUsd: realized,
    unrealizedUsd: 0,
    topWhaleAlias: topWhale?.alias ?? null,
    mirrorsActive: activeMirrors,
    hasFills: fills.length > 0,
  };
}

function fmtSignedUsd(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(2)}`;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = (url.searchParams.get('code') ?? '').toLowerCase().slice(0, 32);
  const baseUrl = `${url.protocol}//${url.host}`;
  const bgUrl = `${baseUrl}/pnl-share-card.png`;

  let card: CardData | null = null;
  if (/^[a-z0-9_-]{3,32}$/u.test(code)) {
    try {
      card = await loadCard(code);
    } catch {
      // Swallow: a DB blip should still serve the neutral card.
      card = null;
    }
  }

  const positive = card !== null && card.totalUsd > 0;
  const negative = card !== null && card.totalUsd < 0;
  const accent = positive ? '#3bd5b5' : negative ? '#ef4444' : '#a8b1c2';
  const headline = card?.hasFills ? fmtSignedUsd(card.totalUsd) : 'Copy whales on autopilot';
  const subline = card?.hasFills
    ? `Mirroring ${String(card.mirrorsActive)} whale${card.mirrorsActive === 1 ? '' : 's'} on Hyperliquid`
    : 'Mirror top Hyperliquid traders from Telegram';
  const topLine = card?.topWhaleAlias
    ? `Top whale: ${card.topWhaleAlias}`
    : 'Non-custodial · agent-key signed';

  return new ImageResponse(
    (
      <div
        style={{
          width: W,
          height: H,
          display: 'flex',
          position: 'relative',
          fontFamily: 'Inter, system-ui, sans-serif',
          color: '#fff',
          background: '#070910',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={bgUrl}
          alt=""
          width={W}
          height={H}
          style={{ position: 'absolute', inset: 0, width: W, height: H }}
        />
        <div
          style={{
            position: 'absolute',
            top: 64,
            right: 72,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '10px 18px',
            borderRadius: 999,
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.10)',
            color: '#cbd5e1',
            fontSize: 22,
            letterSpacing: 0.4,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 999, background: accent }} />
          {card?.hasFills ? 'My PnL on WhalePod' : 'WhalePod'}
        </div>

        <div
          style={{
            position: 'absolute',
            left: 72,
            top: 180,
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
            maxWidth: 1000,
          }}
        >
          <div
            style={{
              color: accent,
              fontSize: card?.hasFills ? 168 : 96,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1,
            }}
          >
            {headline}
          </div>
          <div style={{ fontSize: 40, fontWeight: 600, color: '#e5e7eb', letterSpacing: -0.5 }}>
            {subline}
          </div>
          <div style={{ fontSize: 26, color: '#94a3b8', marginTop: 6 }}>{topLine}</div>
        </div>

        <div
          style={{
            position: 'absolute',
            right: 72,
            bottom: 72,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 4,
          }}
        >
          <div style={{ fontSize: 22, color: '#94a3b8' }}>Join with my link</div>
          <div style={{ fontSize: 30, fontWeight: 700, color: '#fff', letterSpacing: -0.3 }}>
            t.me/whalepod_bot
          </div>
        </div>
      </div>
    ),
    { width: W, height: H },
  );
}
