/**
 * Short share-link landing page. The URL the user sees in Telegram /
 * Twitter is `/s/<id>`. We resolve the id to a HMAC-signed token in
 * Redis and render the same view as `/share/t/[token]`.
 *
 * The OG image URL itself goes through `/api/og/s/[id]` so the og:image
 * the unfurler fetches is also short.
 */
import type { Metadata } from 'next';
import { verifyTradeShare, type TradeSharePayload } from '@whalepod/sdk';
import { TradeShareView } from '@/components/TradeShareView';
import { buildMetadata, siteBase } from '@/lib/tradeShare';
import { resolveShortLink } from '@/lib/shortLinks';

interface Props {
  readonly params: { readonly id: string };
}

async function decodeFromId(id: string): Promise<TradeSharePayload | null> {
  const token = await resolveShortLink(id);
  if (!token) return null;
  const secret = process.env['SHARE_TOKEN_SECRET'] ?? '';
  if (!secret) return null;
  return verifyTradeShare(token, secret);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const base = siteBase();
  const ogImageUrl = `${base}/api/og/s/${encodeURIComponent(params.id)}`;
  const payload = await decodeFromId(params.id);
  return buildMetadata({ ogImageUrl, payload });
}

export default async function ShortSharePage({ params }: Props): Promise<JSX.Element> {
  const payload = await decodeFromId(params.id);
  const base = siteBase();
  const cardUrl = `${base}/api/og/s/${encodeURIComponent(params.id)}`;
  return <TradeShareView payload={payload} cardUrl={cardUrl} />;
}
