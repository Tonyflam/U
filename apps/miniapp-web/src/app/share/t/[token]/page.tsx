/**
 * Trade-share landing page. Hit from the "Share this trade" button the
 * bot emits after /close. The HMAC-signed token in the URL contains the
 * coin, side, entry, exit, PnL and referral code. Telegram/Twitter unfurl
 * the dynamic trade card from /api/og/share/trade?t=<token>.
 *
 * Click-through opens the bot via the inviter's referral link.
 */
import type { Metadata } from 'next';
import { verifyTradeShare } from '@whalepod/sdk';

interface Props {
  readonly params: { readonly token: string };
}

const BOT_HANDLE = process.env['NEXT_PUBLIC_TELEGRAM_BOT_USERNAME'] ?? 'whalepod_bot';

function siteBase(): string {
  return process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://app.whalepod.trade';
}

function decode(token: string): ReturnType<typeof verifyTradeShare> {
  const secret = process.env['SHARE_TOKEN_SECRET'] ?? '';
  if (!secret) return null;
  return verifyTradeShare(token, secret);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const base = siteBase();
  const ogUrl = `${base}/api/og/share/trade?t=${encodeURIComponent(params.token)}`;
  const payload = decode(params.token);
  const title = payload
    ? `${payload.side === 'long' ? 'Long' : 'Short'} ${payload.coin} closed · ${payload.pnlUsd.startsWith('-') ? '' : '+'}$${payload.pnlUsd.replace(/^-/u, '')} on WhalePod`
    : 'WhalePod — copy-trade Hyperliquid in Telegram';
  const description = payload
    ? `Mirrored ${payload.whaleAlias ?? 'a top whale'} on Hyperliquid. Copy trades non-custodially from Telegram.`
    : 'Mirror top Hyperliquid traders, non-custodial, straight from Telegram.';
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      images: [{ url: ogUrl, width: 1200, height: 630, alt: 'WhalePod trade card' }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogUrl],
    },
  };
}

export default function TradeSharePage({ params }: Props): JSX.Element {
  const payload = decode(params.token);
  const base = siteBase();
  const cardUrl = `${base}/api/og/share/trade?t=${encodeURIComponent(params.token)}`;
  const botLink = payload
    ? `https://t.me/${BOT_HANDLE}?start=ref_${payload.code}`
    : `https://t.me/${BOT_HANDLE}`;

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 20px',
        gap: 24,
        textAlign: 'center',
      }}
    >
      <img
        src={cardUrl}
        alt="WhalePod trade card"
        style={{ width: '100%', maxWidth: 720, borderRadius: 16, border: '1px solid #1f242d' }}
      />
      <h1 style={{ margin: 0, fontSize: 28 }}>
        {payload
          ? `${payload.coin} ${payload.side.toUpperCase()} closed`
          : 'Copy whales on Hyperliquid'}
      </h1>
      <p style={{ margin: 0, maxWidth: 520, color: '#94a3b8' }}>
        Mirror top traders from Telegram. Non-custodial — your keys, your funds.
      </p>
      <a
        href={botLink}
        style={{
          padding: '14px 28px',
          background: '#5eead4',
          color: '#05070d',
          fontWeight: 700,
          borderRadius: 999,
          textDecoration: 'none',
          fontSize: 18,
        }}
      >
        Copy this trader
      </a>
    </main>
  );
}
