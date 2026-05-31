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
  // Adaptive precision: small prices (alt-coins) keep more decimals.
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

  if (!payload) {
    return renderNeutral(url, fonts);
  }

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
  const inviteUrl = `t.me/whalepod_bot?start=ref_${payload.code}`;

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

        {/* Top-left status pill */}
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
          Trade Closed
        </div>

        {/* Top-right: coin + side chip pair */}
        <div
          style={{
            position: 'absolute',
            top: 56,
            right: 64,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '10px 18px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.10)',
              color: '#f1f5f9',
              fontSize: 24,
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
              padding: '10px 18px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${sideColor === '#5eead4' ? 'rgba(94,234,212,0.40)' : 'rgba(251,113,133,0.40)'}`,
              color: sideColor,
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: 2,
            }}
          >
            {sideLabel}
          </div>
        </div>

        {/* Body: PnL headline */}
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
            Realized PnL
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 24,
              marginTop: 4,
              color: accent,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <div
              style={{
                display: 'flex',
                fontWeight: 900,
                fontSize: 168,
                lineHeight: 1.0,
                letterSpacing: -4,
              }}
            >
              {fmtSignedUsd(pnlUsd)}
            </div>
            <div
              style={{
                display: 'flex',
                fontWeight: 700,
                fontSize: 64,
                lineHeight: 1.0,
                letterSpacing: -1,
                opacity: 0.85,
              }}
            >
              {fmtSignedPct(pnlPct)}
            </div>
          </div>

          {/* Trade detail strip */}
          <div
            style={{
              display: 'flex',
              gap: 48,
              marginTop: 36,
              paddingTop: 24,
              borderTop: '1px solid rgba(148,163,184,0.12)',
            }}
          >
            <Stat label="Size" value={payload.sz} suffix={payload.coin} />
            <Stat label="Entry" value={`$${fmtPx(entryPx)}`} />
            <Stat label="Exit" value={`$${fmtPx(exitPx)}`} />
            <Stat
              label="Mirrored"
              value={payload.whaleAlias ?? 'whale'}
              mono={payload.whaleAlias === null}
            />
          </div>
        </div>

        {/* Bottom-right: invite */}
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
            Copy this trader
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
  suffix,
  mono,
}: {
  label: string;
  value: string;
  suffix?: string;
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
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          fontSize: 34,
          fontWeight: 700,
          color: '#f1f5f9',
          letterSpacing: -0.4,
          fontVariantNumeric: mono ? 'normal' : 'tabular-nums',
        }}
      >
        <span>{value}</span>
        {suffix ? (
          <span style={{ fontSize: 20, color: '#64748b', fontWeight: 600 }}>{suffix}</span>
        ) : null}
      </div>
    </div>
  );
}

function renderNeutral(url: URL, fonts: Awaited<ReturnType<typeof loadOgFonts>>): ImageResponse {
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
            left: 64,
            top: 200,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
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
            Mirror top traders from Telegram
          </div>
          <div
            style={{
              display: 'flex',
              fontWeight: 900,
              fontSize: 116,
              lineHeight: 1.0,
              letterSpacing: -3,
              color: '#5eead4',
            }}
          >
            Copy whales{'\n'}on autopilot
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
