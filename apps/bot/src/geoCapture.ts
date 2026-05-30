/**
 * Geo capture for the risk engine's `geo.countryFor` lookup.
 *
 * Cloudflare stamps `cf-ipcountry` on every request that reaches the edge.
 * We extract a normalized ISO-3166-1 alpha-2 country, resolve the internal
 * user id from the Telegram update body (or supplied tg id for miniapp
 * routes), and write to `RedisGeoCache`. The write is fire-and-forget at
 * the Fastify edge — never block the webhook on the cache.
 *
 * Cloudflare uses `XX` for "could not determine" and `T1` for Tor exit
 * nodes; both are dropped so the risk engine sees them as "unknown geo".
 */

const ISO2 = /^[A-Z]{2}$/u;

export function extractCountry(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const up = raw.trim().toUpperCase();
  if (up === 'XX' || up === 'T1') return undefined;
  return ISO2.test(up) ? up : undefined;
}

interface UpdateFrom {
  readonly from?: { readonly id?: unknown };
}
interface TelegramUpdate {
  readonly message?: UpdateFrom;
  readonly edited_message?: UpdateFrom;
  readonly channel_post?: UpdateFrom;
  readonly callback_query?: UpdateFrom;
  readonly inline_query?: UpdateFrom;
  readonly chosen_inline_result?: UpdateFrom;
  readonly chat_member?: UpdateFrom;
  readonly my_chat_member?: UpdateFrom;
  readonly pre_checkout_query?: UpdateFrom;
  readonly shipping_query?: UpdateFrom;
}

export function extractTgUserId(update: unknown): bigint | undefined {
  if (update === null || typeof update !== 'object') return undefined;
  const u = update as TelegramUpdate;
  const candidates: readonly (UpdateFrom | undefined)[] = [
    u.message,
    u.edited_message,
    u.callback_query,
    u.inline_query,
    u.chosen_inline_result,
    u.channel_post,
    u.chat_member,
    u.my_chat_member,
    u.pre_checkout_query,
    u.shipping_query,
  ];
  for (const c of candidates) {
    const id = c?.from?.id;
    if (typeof id === 'number' && Number.isFinite(id)) return BigInt(id);
    if (typeof id === 'bigint') return id;
  }
  return undefined;
}

export interface GeoUserLookup {
  getUserByTgId(tgUserId: bigint): Promise<{ readonly id: string } | null>;
}

export interface GeoSink {
  set(userId: string, country: string): Promise<void>;
}

export interface GeoCaptureDeps {
  readonly repo: GeoUserLookup;
  readonly geoCache: GeoSink;
}

export async function captureGeo(
  deps: GeoCaptureDeps,
  input: { readonly tgUserId: bigint; readonly country: string },
): Promise<boolean> {
  const user = await deps.repo.getUserByTgId(input.tgUserId);
  if (!user) return false;
  await deps.geoCache.set(user.id, input.country);
  return true;
}
