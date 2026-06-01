/**
 * Server-side resolver for short share-link ids. Mirrors the bot's
 * `RedisShortLinkStore` write path; reads only. Returns the full HMAC
 * token, which is then verified by `verifyTradeShare` before render.
 *
 * Shared by `/s/[id]/page.tsx` and `/api/og/s/[id]/route.tsx`.
 */
import { Redis } from '@upstash/redis';

const KEY_PREFIX = 'slink:';

let cached: Redis | null = null;
function client(): Redis | null {
  if (cached) return cached;
  const url = process.env['UPSTASH_REDIS_REST_URL'];
  const token = process.env['UPSTASH_REDIS_REST_TOKEN'];
  if (!url || !token) return null;
  cached = new Redis({ url, token });
  return cached;
}

export async function resolveShortLink(id: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]{4,16}$/u.test(id)) return null;
  const redis = client();
  if (!redis) return null;
  try {
    const v = await redis.get<string>(`${KEY_PREFIX}${id}`);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
