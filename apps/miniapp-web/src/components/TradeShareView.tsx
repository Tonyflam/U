/**
 * Shared visual for the trade-share landing page. Renders the OG card
 * preview, headline, and a single "Click here" CTA into the bot. Used
 * by both `/share/t/[token]` and `/s/[id]`.
 */
import type { TradeSharePayload } from '@whalepod/sdk';
import { botLinkFor } from '@/lib/tradeShare';

export function TradeShareView({
  payload,
  cardUrl,
}: {
  payload: TradeSharePayload | null;
  cardUrl: string;
}): JSX.Element {
  const botLink = botLinkFor(payload);
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
        background: '#05070d',
        color: '#f8fafc',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Inter, sans-serif',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- og preview */}
      <img
        src={cardUrl}
        alt="WhalePod trade card"
        style={{ width: '100%', maxWidth: 720, borderRadius: 16, border: '1px solid #1f242d' }}
      />
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: -0.5 }}>
        {payload
          ? `${payload.coin} ${payload.side.toUpperCase()} closed`
          : 'Copy whales on Hyperliquid'}
      </h1>
      <p style={{ margin: 0, maxWidth: 520, color: '#94a3b8', lineHeight: 1.5 }}>
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
        Click here to copy this trader
      </a>
    </main>
  );
}
