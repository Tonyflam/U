/**
 * Curated whale registry — re-exported from the SDK so the public /whales
 * directory build and the Telegram bot's `/start src_whale_<slug>` deep-link
 * routing share one source of truth.
 *
 * Edit the data in `packages/sdk/src/curatedWhales.ts`.
 */
export {
  CURATED_WHALES,
  findCuratedWhaleBySlug,
  whaleSlug,
  type CuratedWhale,
  type WhaleSpecialty,
} from '@whalepod/sdk';
