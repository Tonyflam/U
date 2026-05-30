/**
 * @whalepod/bot — Telegram bot logic.
 *
 * Composition root (grammy webhook server) lives outside this barrel and is
 * spun up by the platform entry point during U8/U16. This file exports the
 * pure, testable building blocks.
 */
export {
  verifyInitData,
  signInitDataForTest,
  type InitDataUser,
  type ParsedInitData,
  type VerifyInitDataParams,
  type VerifyInitDataResult,
  type VerifyInitDataFailure,
} from './initData.js';
export { parseCommand, type Command } from './router.js';
export {
  handleCommand,
  type BotRepo,
  type BotUser,
  type HandlerCtx,
  type Reply,
  type Subscription,
  type Whale,
} from './handlers.js';
export { InMemoryBotRepo, type AuditEntry } from './inMemoryBotRepo.js';
export { DrizzleBotRepo } from './drizzleBotRepo.js';
export { MirrorFillEvent, renderFillNotification, type NotifyPrefs } from './notify.js';
export {
  PnlFill,
  renderPnl,
  summarizePnl,
  type MarkPriceFn,
  type PnlRenderPrefs,
  type PnlSummary,
  type WhaleSummary,
} from './pnl.js';
export {
  attributeReferral,
  computeLeaderboard,
  parseReferralStartParam,
  renderLeaderboard,
  type AttributeReferralInput,
  type AttributionOutcome,
  type ComputeLeaderboardOptions,
  type LeaderboardEntry,
  type LeaderboardResult,
  type ParsedReferral,
  type RenderLeaderboardOptions,
  type ReferrerLookupFn,
  type ReferrerRecord,
} from './referral.js';
export {
  DrizzleOnboardRepo,
  InMemoryProvisionalStore,
  getUserByTgId,
  type DrizzleOnboardRepoDeps,
  type ProvisionalStore,
} from './onboardRepo.js';
export {
  RedisProvisionalStore,
  type RedisProvisionalStoreOptions,
} from './redisProvisionalStore.js';
export { createBot, type BotDeps } from './bot.js';
