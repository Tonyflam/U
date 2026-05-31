/**
 * Share-card landing page. Hit from the /share button in the Telegram bot.
 * The whole point is the `openGraph.images` field below — Telegram, Twitter
 * and Discord all unfurl this page to render the dynamic PnL card from
 * /api/og/share?code=<code>.
 *
 * On click-through (or if a friend opens it in a browser), the page itself
 * just shows a button into the bot with the referral code attached, so the
 * link still serves its primary purpose.
 */
import type { Metadata } from 'next';

interface Props {
  readonly params: { readonly code: string };
}

const BOT_HANDLE = process.env['NEXT_PUBLIC_TELEGRAM_BOT_USERNAME'] ?? 'whalepod_bot';

function siteBase(): string {
  return process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://app.whalepod.trade';
}

function sanitize(code: string): string | null {
  const c = code.toLowerCase();
  return /^[a-z0-9_-]{3,32}$/u.test(c) ? c : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const code = sanitize(params.code);
  const base = siteBase();
  const ogUrl = code ? `${base}/api/og/share?code=${code}` : `${base}/og-card.png`;
  const title = 'WhalePod — copy-trade Hyperliquid in Telegram';
  const description = 'Mirror top Hyperliquid traders, non-custodial, straight from Telegram.';
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      images: [{ url: ogUrl, width: 1200, height: 630, alt: 'WhalePod PnL share card' }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogUrl],
    },
  };
}

export default function SharePage({ params }: Props): JSX.Element {
  const code = sanitize(params.code) ?? '';
  const botLink = code
    ? `https://t.me/${BOT_HANDLE}?start=ref_${code}`
    : `https://t.me/${BOT_HANDLE}`;
  const cardUrl = code ? `${siteBase()}/api/og/share?code=${code}` : `${siteBase()}/og-card.png`;

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
        alt="WhalePod PnL share card"
        style={{ width: '100%', maxWidth: 720, borderRadius: 16, border: '1px solid #1f242d' }}
      />
      <h1 style={{ margin: 0, fontSize: 28 }}>Copy whales on Hyperliquid</h1>
      <p style={{ margin: 0, maxWidth: 520, color: '#94a3b8' }}>
        Mirror top traders from Telegram. Non-custodial — your keys, your funds.
      </p>
      <a
        href={botLink}
        style={{
          padding: '14px 28px',
          background: '#3bd5b5',
          color: '#070910',
          fontWeight: 700,
          borderRadius: 999,
          textDecoration: 'none',
          fontSize: 18,
        }}
      >
        Launch WhalePod
      </a>
    </main>
  );
}
