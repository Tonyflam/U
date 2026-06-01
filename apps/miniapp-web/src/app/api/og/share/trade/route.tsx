/**
 * Dynamic OG image for /share/t/[token]. Renders a 1200x630 card
 * summarizing a single closed trade (coin, side, entry → exit, PnL, the
 * whale it mirrored). Payload is HMAC-signed by the bot; verification
 * failures fall back to the neutral WhalePod card.
 *
 * Lookup: /api/og/share/trade?t=<token>
 */
import { ImageResponse } from 'next/og';
import { verifyTradeShare, type TradeSharePayload } from '@whalepod/sdk';
import { loadOgFonts } from '../../_fonts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 300;

const W = 1200;
const H = 630;

const BG = '#05070d';
const FG = '#f8fafc';
const MUTED = '#64748b';
const SUBTLE = 'rgba(148,163,184,0.12)';

function fmtSignedUsd(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${formatted}`;
}

function fmtPx(n: number): string {
  const digits = n >= 1000 ? 2 : n >= 10 ? 3 : n >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtSignedPct(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get('t') ?? '';
  const secret = process.env['SHARE_TOKEN_SECRET'] ?? '';
  const payload: TradeSharePayload | null =
    token && secret ? verifyTradeShare(token, secret) : null;

  const fonts = await loadOgFonts();

  if (!payload) return renderNeutral(fonts);

  const pnlUsd = Number(payload.pnlUsd);
  const pnlPct = Number(payload.pnlPct);
  const entryPx = Number(payload.entryPx);
  const exitPx = Number(payload.exitPx);

  const positive = pnlUsd > 0;
  const negative = pnlUsd < 0;
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

  const sideLabel = payload.side === 'long' ? 'LONG' : 'SHORT';
  const sideColor = payload.side === 'long' ? '#5eead4' : '#fb7185';
  const sideBorder = payload.side === 'long' ? 'rgba(94,234,212,0.40)' : 'rgba(251,113,133,0.40)';

  return new ImageResponse(
    (
      <div
        style={{
          width: W,
          height: H,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          fontFamily: 'Inter',
          color: FG,
          background: BG,
          padding: '56px 72px',
        }}
      >
        {/* Accent glow behind body */}
        <div
          style={{
            position: 'absolute',
            top: 140,
            left: -160,
            width: 760,
            height: 380,
            background: accent,
            opacity: 0.09,
            filter: 'blur(140px)',
            borderRadius: 9999,
            display: 'flex',
          }}
        />

        {/* Top row: status pill + coin/side chips */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 16px 8px 12px',
              borderRadius: 999,
              background: accentSoft,
              border: `1px solid ${accentBorder}`,
              color: accent,
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: 1.6,
              textTransform: 'uppercase',
            }}
          >
            <span
              style={{
                display: 'flex',
                width: 8,
                height: 8,
                borderRadius: 999,
                background: accent,
              }}
            />
            Trade Closed
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 16px',
                borderRadius: 999,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.10)',
                color: '#e2e8f0',
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: 1.2,
              }}
            >
              {payload.coin}-PERP
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 16px',
                borderRadius: 999,
                background: 'rgba(255,255,255,0.02)',
                border: `1px solid ${sideBorder}`,
                color: sideColor,
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: 2,
              }}
            >
              {sideLabel}
            </div>
          </div>
        </div>

        {/* Body: PnL section */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginTop: 64,
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: 4,
              color: MUTED,
              textTransform: 'uppercase',
            }}
          >
            Realized PnL
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 20,
              marginTop: 14,
              color: accent,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <div
              style={{
                display: 'flex',
                fontWeight: 900,
                fontSize: 124,
                lineHeight: 1.0,
                letterSpacing: -3,
              }}
            >
              {fmtSignedUsd(pnlUsd)}
            </div>
            <div
              style={{
                display: 'flex',
                fontWeight: 700,
                fontSize: 48,
                lineHeight: 1.0,
                letterSpacing: -0.5,
                opacity: 0.85,
              }}
            >
              {fmtSignedPct(pnlPct)}
            </div>
          </div>
        </div>

        {/* Stat strip — sits just below the PnL so the trade facts are
            front-and-center, not buried at the bottom of the card. */}
        <div
          style={{
            display: 'flex',
            gap: 56,
            marginTop: 44,
            paddingTop: 28,
            borderTop: `1px solid ${SUBTLE}`,
          }}
        >
          <Stat label="Size" value={payload.sz} suffix={payload.coin} />
          <Stat label="Entry → Exit" value={`$${fmtPx(entryPx)} → $${fmtPx(exitPx)}`} />
          <Stat
            label="Mirrored"
            value={payload.whaleAlias ?? 'whale'}
            mono={payload.whaleAlias === null}
          />
        </div>

        {/* Bottom CTA pill — keeps the long referral URL out of the card. */}
        <div
          style={{
            position: 'absolute',
            right: 72,
            bottom: 56,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 26px',
            borderRadius: 999,
            background: accentSoft,
            border: `1px solid ${accentBorder}`,
            color: accent,
            fontSize: 24,
            fontWeight: 800,
            letterSpacing: 0.3,
          }}
        >
          Click here to copy this trader →
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
  suffix,
  mono,
}: {
  label: string;
  value: string;
  suffix?: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 2.4,
          color: MUTED,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          fontSize: 28,
          fontWeight: 700,
          color: '#e2e8f0',
          letterSpacing: -0.3,
          fontVariantNumeric: mono ? 'normal' : 'tabular-nums',
        }}
      >
        <span style={{ display: 'flex' }}>{value}</span>
        {suffix ? (
          <span style={{ display: 'flex', fontSize: 18, color: MUTED, fontWeight: 600 }}>
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function renderNeutral(fonts: Awaited<ReturnType<typeof loadOgFonts>>): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: W,
          height: H,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '56px 72px',
          fontFamily: 'Inter',
          color: FG,
          background: BG,
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: 4,
            color: MUTED,
            textTransform: 'uppercase',
          }}
        >
          Mirror top traders from Telegram
        </div>
        <div
          style={{
            display: 'flex',
            fontWeight: 900,
            fontSize: 108,
            lineHeight: 1.05,
            letterSpacing: -3,
            color: '#5eead4',
            marginTop: 12,
          }}
        >
          Copy whales on autopilot
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
