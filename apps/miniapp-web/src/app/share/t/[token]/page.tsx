/**
 * Trade-share landing page. Hit from the "Share this trade" button the
 * bot emits after /close, when the bot doesn't have the short-link store
 * wired up (legacy path). Prefer `/s/[id]` in production.
 */
import type { Metadata } from 'next';
import { verifyTradeShare } from '@whalepod/sdk';
import { TradeShareView } from '@/components/TradeShareView';
import { buildMetadata, siteBase } from '@/lib/tradeShare';

interface Props {
  readonly params: { readonly token: string };
}

function decode(token: string): ReturnType<typeof verifyTradeShare> {
  const secret = process.env['SHARE_TOKEN_SECRET'] ?? '';
  if (!secret) return null;
  return verifyTradeShare(token, secret);
}

export function generateMetadata({ params }: Props): Metadata {
  const base = siteBase();
  const ogImageUrl = `${base}/api/og/share/trade?t=${encodeURIComponent(params.token)}`;
  return buildMetadata({ ogImageUrl, payload: decode(params.token) });
}

export default function TradeSharePage({ params }: Props): JSX.Element {
  const payload = decode(params.token);
  const base = siteBase();
  const cardUrl = `${base}/api/og/share/trade?t=${encodeURIComponent(params.token)}`;
  return <TradeShareView payload={payload} cardUrl={cardUrl} />;
}
