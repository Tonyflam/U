/**
 * Dynamic OG image for /share/[code]. Renders a 1200x630 referral card
 * with the inviter's live mirror PnL — futuristic, tabular, Inter Display.
 *
 * Lookup: /api/og/share?code=<referralCode>
 *
 * The referral code resolves to a user; we read their realized PnL from
 * the bot's `fills` ledger (same source `/pnl` uses) and the top whale
 * they mirror. Falls back to a neutral "Mirror Hyperliquid whales" card
 * if the code is unknown or the user has no fills yet.
 */
import { ImageResponse } from 'next/og';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { createDb, schema } from '@whalepod/schema';
import { loadOgFonts } from '../_fonts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
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

  type Pos = { netSz: number };
  const byWhale = new Map<
    string,
    { alias: string | null; realized: number; positions: Map<string, Pos> }
  >();
  for (const f of fills) {
    const sz = Number(f.sz);
    if (!Number.isFinite(sz)) continue;
    const entry = byWhale.get(f.wallet) ?? { alias: f.alias, realized: 0, positions: new Map() };
    if (entry.alias === null && f.alias) entry.alias = f.alias;
    const signed = f.side === 'B' ? sz : -sz;
    const pos = entry.positions.get(f.coin) ?? { netSz: 0 };
    pos.netSz += signed;
    entry.positions.set(f.coin, pos);
    entry.realized += f.realizedPnlUsd ? Number(f.realizedPnlUsd) : 0;
    byWhale.set(f.wallet, entry);
  }

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
    topWhaleAlias: topWhale?.alias ?? null,
    mirrorsActive: activeMirrors,
    hasFills: fills.length > 0,
  };
}

function fmtSignedUsd(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${formatted}`;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = (url.searchParams.get('code') ?? '').toLowerCase().slice(0, 32);

  let card: CardData | null = null;
  if (/^[a-z0-9_-]{3,32}$/u.test(code)) {
    try {
      card = await loadCard(code);
    } catch {
      card = null;
    }
  }

  const fonts = await loadOgFonts();

  const positive = card !== null && card.totalUsd > 0;
  const negative = card !== null && card.totalUsd < 0;
  const accent = positive ? '#5eead4' : negative ? '#fb7185' : '#94a3b8';
  const accentSoft = positive
    ? 'rgba(94,234,212,0.10)'
    : negative
      ? 'rgba(251,113,133,0.10)'
      : 'rgba(148,163,184,0.10)';
  const accentBorder = positive
    ? 'rgba(94,234,212,0.30)'
    : negative
      ? 'rgba(251,113,133,0.30)'
      : 'rgba(148,163,184,0.30)';

  const hasFills = card?.hasFills ?? false;
  const headline = hasFills && card ? fmtSignedUsd(card.totalUsd) : 'Copy whales\non autopilot';
  const handle = /^[a-z0-9_-]{3,32}$/u.test(code) ? code : null;
  const inviteUrl = handle ? `t.me/whalepod_bot?start=ref_${handle}` : 't.me/whalepod_bot';

  return new ImageResponse(
    (
      <div
        style={{
          width: W,
          height: H,
          display: 'flex',
          position: 'relative',
          fontFamily: 'Inter',
          color: '#f8fafc',
          background: '#05070d',
        }}
      >
        <img
          src={`${url.protocol}//${url.host}/pnl-share-card.png`}
          alt=""
          width={W}
          height={H}
          style={{ position: 'absolute', inset: 0, width: W, height: H }}
        />

        <div
          style={{
            position: 'absolute',
            top: 120,
            left: -120,
            width: 720,
            height: 420,
            background: accent,
            opacity: 0.1,
            filter: 'blur(120px)',
            borderRadius: 9999,
          }}
        />

        <div
          style={{
            position: 'absolute',
            top: 56,
            left: 64,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 18px 10px 14px',
            borderRadius: 999,
            background: accentSoft,
            border: `1px solid ${accentBorder}`,
            color: accent,
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: 1.6,
            textTransform: 'uppercase',
          }}
        >
          <span style={{ width: 10, height: 10, borderRadius: 999, background: accent }} />
          {hasFills ? 'Live Mirror PnL' : 'WhalePod'}
        </div>

        <div
          style={{
            position: 'absolute',
            top: 56,
            right: 64,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 18px',
            borderRadius: 999,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#cbd5e1',
            fontSize: 20,
            fontWeight: 500,
            letterSpacing: 0.6,
          }}
        >
          Hyperliquid · Telegram
        </div>

        <div
          style={{
            position: 'absolute',
            left: 64,
            top: 158,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxWidth: 1072,
          }}
        >
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: 4,
              color: '#64748b',
              textTransform: 'uppercase',
            }}
          >
            {hasFills ? 'Realized PnL · mirroring whales' : 'Mirror top traders from Telegram'}
          </div>

          <div
            style={{
              display: 'flex',
              fontWeight: 900,
              color: accent,
              fontSize: hasFills ? 192 : 116,
              lineHeight: 1.0,
              letterSpacing: -4,
              marginTop: 4,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'pre-line',
            }}
          >
            {headline}
          </div>

          {hasFills && card ? (
            <div style={{ display: 'flex', gap: 56, marginTop: 28 }}>
              <Stat label="Active mirrors" value={String(card.mirrorsActive)} />
              <Stat
                label="Top whale"
                value={card.topWhaleAlias ?? '—'}
                mono={card.topWhaleAlias === null}
              />
              <Stat label="Venue" value="Hyperliquid" />
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                fontSize: 32,
                fontWeight: 500,
                color: '#cbd5e1',
                marginTop: 28,
                letterSpacing: -0.2,
                maxWidth: 900,
                lineHeight: 1.25,
              }}
            >
              Auto-copy the best Hyperliquid traders straight from Telegram. Non-custodial,
              agent-key signed.
            </div>
          )}
        </div>

        <div
          style={{
            position: 'absolute',
            right: 64,
            bottom: 56,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 2,
          }}
        >
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: 3,
              color: '#64748b',
              textTransform: 'uppercase',
            }}
          >
            Join with my link
          </div>
          <div
            style={{
              fontSize: 30,
              fontWeight: 700,
              color: '#f8fafc',
              letterSpacing: -0.2,
            }}
          >
            {inviteUrl}
          </div>
        </div>
      </div>
    ),
    {
      width: W,
      height: H,
      fonts: fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })),
    },
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: 2.4,
          color: '#64748b',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 36,
          fontWeight: 700,
          color: '#f1f5f9',
          letterSpacing: -0.4,
          fontVariantNumeric: mono ? 'normal' : 'tabular-nums',
        }}
      >
        {value}
      </div>
    </div>
  );
}
