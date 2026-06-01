/**
 * Shared rendering for trade-share landing pages. Used by:
 *   - /share/t/[token]  (full HMAC token in the URL)
 *   - /s/[id]           (Redis short-id resolved to the same token)
 */
import type { Metadata } from 'next';
import type { TradeSharePayload } from '@whalepod/sdk';

const BOT_HANDLE = process.env['NEXT_PUBLIC_TELEGRAM_BOT_USERNAME'] ?? 'whalepod_bot';

export function siteBase(): string {
  return process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://app.whalepod.trade';
}

export function botLinkFor(payload: TradeSharePayload | null): string {
  return payload
    ? `https://t.me/${BOT_HANDLE}?start=ref_${payload.code}`
    : `https://t.me/${BOT_HANDLE}`;
}

export function buildMetadata(opts: {
  ogImageUrl: string;
  payload: TradeSharePayload | null;
}): Metadata {
  const { ogImageUrl, payload } = opts;
  const title = payload
    ? `${payload.side === 'long' ? 'Long' : 'Short'} ${payload.coin} closed · ${
        payload.pnlUsd.startsWith('-') ? '' : '+'
      }$${payload.pnlUsd.replace(/^-/u, '')} on WhalePod`
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
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: 'WhalePod trade card' }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImageUrl],
    },
  };
}
