/**
 * Pure command-handler layer for the Telegram bot wedge.
 *
 * Every handler is a function of `(command, ctx)` → `Reply[]`. Side effects
 * happen through the injected `BotRepo`, which the grammy adapter wires to a
 * real Drizzle-backed implementation. Tests use `InMemoryBotRepo`.
 *
 * Why pure: the wedge commands all mutate user state (subscriptions, fee,
 * kill switch). Property: every state mutation MUST produce an audit-log
 * write through the same repo, in one transaction conceptually. Keeping
 * handlers pure means we can test the audit invariant exhaustively.
 */
import {
  findCuratedWhaleBySlug,
  signTradeShare,
  TPSL_MAX_BPS,
  TPSL_MIN_BPS,
  whaleSlug,
  type CuratedWhale,
  type TpSl,
} from '@whalepod/sdk';
import { renderPnl, summarizePnl, type MarkPriceFn, type PnlFill } from './pnl.js';
import { renderHlPnl, type HlPnlProvider } from './hlPnlSnapshot.js';
import type { WhaleProbe } from './hlWhaleProbe.js';
import { computeLeaderboard, renderLeaderboard, type LeaderboardEntry } from './referral.js';
import type { NotifyPrefs } from './notify.js';
import type { Command } from './router.js';

export interface BotUser {
  readonly id: string;
  readonly tgUserId: bigint;
  readonly tgUsername: string | null;
  readonly mainWallet: string;
  readonly agentAddress: string;
  readonly approvedMaxFeeTenthsBp: number;
  readonly currentFeeTenthsBp: number;
  readonly killSwitch: boolean;
}

export interface Whale {
  readonly id: string;
  readonly address: string;
  readonly alias: string | null;
}

export interface Subscription {
  readonly id: string;
  readonly userId: string;
  readonly whaleId: string;
  readonly maxSizeUsd: string;
  readonly paused: boolean;
  readonly tpBps: number | null;
  readonly slBps: number | null;
}

export interface BotRepo {
  getUserByTgId(tgUserId: bigint): Promise<BotUser | null>;
  getWhaleByAddress(address: string): Promise<Whale | null>;
  getWhaleById(whaleId: string): Promise<Whale | null>;
  upsertWhaleByAddress(address: string): Promise<Whale>;
  listSubscriptions(userId: string): Promise<readonly Subscription[]>;
  /** Featured whales (curated). Ordered by most recent fill first. */
  listFeaturedWhales(limit: number): Promise<readonly Whale[]>;
  /**
   * Whales this Telegram user is watching (free alerts, no wallet). Keyed
   * by tg user id directly — watchers usually have no `users` row.
   */
  listWatchedWhales(tgUserId: bigint): Promise<readonly Whale[]>;
  /** Idempotent watch insert. `created` is false when already watching. */
  addWatch(tgUserId: bigint, whaleId: string): Promise<{ readonly created: boolean }>;
  /** Returns true when a watch row was actually removed. */
  removeWatch(tgUserId: bigint, whaleId: string): Promise<boolean>;
  subscribe(userId: string, whaleId: string, maxSizeUsd?: string): Promise<Subscription>;
  unsubscribe(userId: string, whaleId: string): Promise<boolean>;
  setAllSubscriptionsPaused(userId: string, paused: boolean): Promise<number>;
  setSubscriptionMaxSize(
    userId: string,
    whaleId: string,
    maxSizeUsd: string,
  ): Promise<Subscription | null>;
  setSubscriptionMaxLeverage(
    userId: string,
    whaleId: string,
    maxLeverage: number,
  ): Promise<{ readonly before: number; readonly after: number } | null>;
  setSubscriptionTpSl(
    userId: string,
    whaleId: string,
    patch: { readonly tpBps?: number | null; readonly slBps?: number | null },
  ): Promise<Subscription | null>;
  setKillSwitch(userId: string, killSwitch: boolean): Promise<void>;
  /**
   * Soft-deletes the user: sets revoked_at, flips kill_switch on. After this,
   * `getUserByTgId` returns null until they re-onboard.
   */
  revokeUser(userId: string): Promise<void>;
  setCurrentFee(userId: string, tenthsBp: number): Promise<void>;
  /** Persisted per-user notification preferences. Missing fields fall back to renderer defaults. */
  getNotifyPrefs(userId: string): Promise<NotifyPrefs>;
  setNotifyPrefs(userId: string, patch: NotifyPrefs): Promise<NotifyPrefs>;
  /**
   * Returns the user's referral invite code, minting one on first call.
   * The code is the bare slug (no `ref_` prefix) — handlers prepend the
   * `ref_` namespace for the Telegram /start payload.
   */
  getOrMintReferralCode(userId: string): Promise<string>;
  /**
   * Resolves a referral code to the owning user, or null if unknown.
   * Codes are stored lowercase — callers should lowercase first.
   */
  findReferrerByCode(code: string): Promise<{ readonly userId: string } | null>;
  /**
   * Idempotent insert into `referrals_attribution`. Returns the resolved
   * outcome — `attributed` on insert, `already_attributed` when a row
   * already existed (first-write wins).
   */
  recordReferralAttribution(
    referredUserId: string,
    code: string,
  ): Promise<{
    readonly kind: 'attributed' | 'already_attributed';
    readonly referrerUserId: string;
  }>;
  /**
   * Recent mirrored fills for a user, newest first, capped by `limit`.
   * Returned in `PnlFill` shape so the renderer can consume directly.
   */
  listFillsForUser(userId: string, limit: number): Promise<readonly PnlFill[]>;
  /**
   * Recent realized-PnL aggregates per user, used by /leaderboard. Each
   * entry already carries a display handle (truncated @username or short
   * address) so the renderer is pure.
   */
  listLeaderboard(limit: number): Promise<readonly LeaderboardEntry[]>;
  appendAudit(entry: {
    actor: string;
    action: string;
    target: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void>;
}

export interface HandlerCtx {
  readonly tgUser: { readonly id: bigint; readonly username: string | null };
  readonly repo: BotRepo;
  readonly miniAppUrl: string;
  /** Telegram bot @username (no leading `@`). Used to build /start deep links. */
  readonly botUsername: string;
  /**
   * Mark price resolver for /pnl unrealized math. Returning null for a coin
   * collapses its unrealized contribution to zero — the renderer still
   * shows the open size and realized PnL.
   */
  readonly markPrice?: MarkPriceFn;
  /**
   * HL-truth PnL provider. When present, /pnl reads positions and
   * realized PnL straight from Hyperliquid instead of the local fill
   * ledger, which can drift if HL fills at a different price than the
   * IOC limit we sent.
   */
  readonly hlPnl?: HlPnlProvider;
  /**
   * Optional /close + /closeall executor. When omitted, those commands
   * reply with a "feature unavailable" message rather than crashing.
   */
  readonly closer?: PositionCloseFn;
  /**
   * HMAC secret used to mint trade-share tokens after /close. When omitted,
   * the bot still sends close replies but skips the "Share this trade" button.
   */
  readonly shareTokenSecret?: string;
  /**
   * Optional sink to block further mirror orders on a coin right after
   * the user manually closes it, so the next whale exit fill doesn't
   * reopen an opposite-direction position. Block auto-expires.
   */
  readonly mirrorBlocks?: MirrorBlockSink;
  /**
   * Optional short-link store. When present, /close share buttons use
   * `${miniAppUrl}/s/<id>` instead of `${miniAppUrl}/share/t/<token>` so
   * the URL stays compact.
   */
  readonly shortLinks?: ShortLinkStore;
  /**
   * Optional whale-existence probe. When present, /follow refuses to
   * subscribe to a 0x address that has zero fills on Hyperliquid (typo,
   * dead wallet, random hex). Fails open on HL transport errors so an
   * outage doesn't block onboarding.
   */
  readonly whaleProbe?: WhaleProbe;
  /**
   * Optional admin DM hook. When present, `/start` taps from non-admin
   * users trigger a one-line ping so the operator sees acquisition in
   * real time without polling the audit log. Failures are swallowed by
   * the closure itself; handlers do not need to wrap it in try/catch.
   */
  readonly adminAlert?: (text: string) => Promise<void>;
  /**
   * Admin Telegram user IDs whose own /start taps should NOT trigger
   * `adminAlert` (otherwise operators spam themselves during testing).
   */
  readonly adminTgUserIds?: readonly bigint[];
}

/** Records that a (user, coin, side) tuple should not be mirrored for a TTL window. */
export interface MirrorBlockSink {
  block(userId: string, coin: string, side: 'B' | 'S'): Promise<void>;
}

/** Maps a long share token to a short, opaque id stored centrally. */
export interface ShortLinkStore {
  put(token: string): Promise<string>;
}

/**
 * Executes a reduce-only close. `coin === null` means /closeall.
 * Resolves with a human-readable result line per coin, ready to render.
 */
export type PositionCloseFn = (input: {
  readonly user: BotUser;
  readonly coin: string | null;
}) => Promise<CloseExecOutcome>;

export type CloseExecOutcome =
  | { readonly kind: 'no_positions' }
  | { readonly kind: 'coin_not_open'; readonly coin: string }
  | { readonly kind: 'closed'; readonly results: readonly CloseExecResult[] };

export type CloseExecResult =
  | {
      readonly coin: string;
      readonly kind: 'submitted';
      readonly sz: string;
      readonly isBuy: boolean;
      readonly trade?: CloseTradeSummary;
    }
  | { readonly coin: string; readonly kind: 'no_mark' }
  | { readonly coin: string; readonly kind: 'exchange_error'; readonly message: string }
  | { readonly coin: string; readonly kind: 'transport_error'; readonly message: string }
  | { readonly coin: string; readonly kind: 'asset_unknown' };

/**
 * Per-coin trade summary surfaced by the closer so handlers can mint a
 * "Share this trade" card. Mirrors the SDK's share-token payload shape.
 */
export interface CloseTradeSummary {
  readonly side: 'long' | 'short';
  readonly sz: string;
  readonly entryPx: string;
  readonly exitPx: string;
  readonly pnlUsd: string;
  readonly pnlPct: string;
  readonly whaleAlias: string | null;
}

export interface Reply {
  readonly text: string;
  readonly buttons?: readonly (readonly { readonly label: string; readonly url: string }[])[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

const ONBOARD_PROMPT = [
  '🐋 Welcome to WhalePod.',
  '',
  'Copy-trade the top Hyperliquid whales — auto-mirrored into your own account.',
  '',
  '✅ Non-custodial — you keep your keys (agent wallet only, no withdraw)',
  '✅ 5 bps fee via HL builder codes (no monthly, no profit share)',
  '✅ Hard size cap + SL/TP on every mirrored trade',
  '✅ Verified-profitable whales seeded — check /whales',
  '',
  'Not ready to connect a wallet? /watch a whale instead — free fill alerts,',
  'no wallet needed.',
  '',
  '60 seconds to set up. Tap below 👇',
].join('\n');

function onboardReply(ctx: HandlerCtx, intentWhale?: CuratedWhale): Reply {
  const base = ctx.miniAppUrl.replace(/\/+$/u, '');
  // Carry the whale slug into the mini-app URL so the post-onboard
  // redirect (handled in the web flow) can deep-link the user back to
  // the bot with `/follow <address>` already filled in. The bot itself
  // doesn't read this query param — it's purely for the web onboarder.
  const url = intentWhale
    ? `${base}/onboard?tg=${ctx.tgUser.id.toString()}&whale=${whaleSlug(intentWhale.alias)}`
    : `${base}/onboard?tg=${ctx.tgUser.id.toString()}`;
  if (intentWhale) {
    const text = [
      `🐋 You came from ${intentWhale.alias} on whalepod.trade.`,
      '',
      intentWhale.tagline,
      `Address: ${intentWhale.address}`,
      '',
      `Connect your wallet (60s, non-custodial agent — no withdraw access),`,
      `then tap /follow ${intentWhale.address} to start mirroring with a $100`,
      `default per-trade size cap.`,
      '',
      `✅ 5 bps fee · hard size cap + SL/TP · you keep your keys.`,
    ].join('\n');
    return {
      text,
      buttons: [[{ label: `🔗 Connect & mirror ${intentWhale.alias}`, url }]],
    };
  }
  return {
    text: ONBOARD_PROMPT,
    buttons: [[{ label: '🔗 Connect wallet & start', url }]],
  };
}

function fmtAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtFeeBps(tenthsBp: number): string {
  return `${(tenthsBp / 10).toFixed(1)} bps`;
}

/**
 * Extracts the acquisition channel from a /start deep-link payload.
 *
 * Channel-tagged links use the `src_` namespace (e.g. `src_x`,
 * `src_discord_wins`). Whale-card deep links use the `src_whale_<slug>`
 * sub-namespace and resolve to the channel `whale_<slug>` so the audit
 * log retains the specific whale. Referral links (`ref_<code>`) are
 * attributed to `referral`. Anything else — including a bare /start —
 * is `direct`.
 */
function parseStartChannel(startParam: string | null): string {
  if (startParam === null) return 'direct';
  const trimmed = startParam.trim();
  if (trimmed.startsWith('src_whale_')) {
    const slug = trimmed.slice('src_whale_'.length).toLowerCase();
    return /^[a-z0-9]{1,32}$/u.test(slug) ? `whale_${slug}` : 'direct';
  }
  if (trimmed.startsWith('src_')) {
    const raw = trimmed.slice('src_'.length).toLowerCase();
    return /^[a-z0-9_-]{1,32}$/u.test(raw) ? raw : 'direct';
  }
  if (trimmed.startsWith('ref_')) return 'referral';
  return 'direct';
}

/**
 * Resolves a `src_whale_<slug>` deep-link payload to a curated whale.
 * Returns `null` for any other start parameter, or for whale slugs that
 * don't match a current curated entry (whale was retired, etc).
 */
function parseWhaleIntent(startParam: string | null): CuratedWhale | null {
  if (startParam === null) return null;
  const trimmed = startParam.trim();
  if (!trimmed.startsWith('src_whale_')) return null;
  const slug = trimmed.slice('src_whale_'.length);
  return findCuratedWhaleBySlug(slug);
}

export async function handleCommand(command: Command, ctx: HandlerCtx): Promise<Reply[]> {
  switch (command.kind) {
    case 'start':
      return handleStart(command.startParam, ctx);
    case 'help':
      return [helpReply()];
    case 'wallet':
      return handleWallet(ctx);
    case 'follow':
      return handleFollow(command.target, command.maxSizeUsd, ctx);
    case 'unfollow':
      return handleUnfollow(command.target, ctx);
    case 'setcap':
      return handleSetCap(command.target, command.maxSizeUsd, ctx);
    case 'setlev':
      return handleSetLev(command.target, command.maxLeverage, ctx);
    case 'mirrors':
      return handleMirrors(ctx);
    case 'pause':
      return handleSetPaused(true, ctx);
    case 'resume':
      return handleSetPaused(false, ctx);
    case 'kill':
      return handleKill(true, ctx);
    case 'unkill':
      return handleKill(false, ctx);
    case 'disconnect':
      return handleDisconnect(ctx);
    case 'tp':
      return handleSetTpSl('tp', command.target, command.offsetBps, ctx);
    case 'sl':
      return handleSetTpSl('sl', command.target, command.offsetBps, ctx);
    case 'share':
      return handleShare(ctx);
    case 'close':
      return handleClose(command.coin, ctx);
    case 'closeall':
      return handleClose(null, ctx);
    case 'pnl':
      return handlePnl(ctx);
    case 'leaderboard':
      return handleLeaderboard(ctx);
    case 'whales':
      return handleWhales(ctx);
    case 'watch':
      return handleWatch(command.target, ctx);
    case 'unwatch':
      return handleUnwatch(command.target, ctx);
    case 'notify':
      return handleNotify(command.action, ctx);
    case 'unknown':
      return [{ text: `Unknown command: ${command.raw}\nTry /help` }];
  }
}

async function handleShare(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  const code = await ctx.repo.getOrMintReferralCode(user.id);
  const inviteUrl = `https://t.me/${ctx.botUsername}?start=ref_${code}`;
  // Share via the miniapp page so Telegram/Twitter unfurl the dynamic
  // PnL card from /api/og/share. Recipients who tap through land on the
  // bot via the Launch button.
  const base = ctx.miniAppUrl.replace(/\/+$/u, '');
  const shareUrl = `${base}/share/${code}`;
  const pitch = 'Mirror top Hyperliquid whales on autopilot with WhalePod.';
  return [
    {
      text: [
        '📨 Invite friends to WhalePod',
        '',
        'Your invite link:',
        inviteUrl,
        '',
        'How referrals work:',
        '  1. Share the link (tap the button below).',
        '  2. When a friend opens it and finishes /start, they are linked to you.',
        '  3. You get credit on the /leaderboard for every friend that mirrors a whale.',
      ].join('\n'),
      buttons: [
        [
          {
            label: 'Share on Telegram',
            url: `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(pitch)}`,
          },
        ],
      ],
    },
  ];
}

async function handleClose(coin: string | null, ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  if (!ctx.closer)
    return [{ text: 'Closing positions is temporarily unavailable. Try again shortly.' }];

  const outcome = await ctx.closer({ user, coin });
  if (outcome.kind === 'no_positions') {
    return [{ text: 'You have no open positions to close.' }];
  }
  if (outcome.kind === 'coin_not_open') {
    return [{ text: `You have no open ${outcome.coin} position.` }];
  }

  // Suppress the whale's incoming exit fill on each closed coin so it
  // doesn't reopen an opposite-direction position. The block is
  // directional (only the side matching our close action is blocked)
  // and short-lived, so a fresh whale entry later isn't swallowed.
  if (ctx.mirrorBlocks) {
    for (const r of outcome.results) {
      if (r.kind === 'submitted') {
        try {
          // r.isBuy is the side of OUR close order. The whale's exit fill
          // arrives on that same side, which is exactly what we want to
          // suppress. A fill in the opposite side is a fresh entry and is
          // allowed through (and clears the block).
          await ctx.mirrorBlocks.block(user.id, r.coin, r.isBuy ? 'B' : 'S');
        } catch {
          // Non-fatal — block is a defense-in-depth layer.
        }
      }
    }
  }

  const lines = ['Close requests submitted:', ''];
  const buttons: { readonly label: string; readonly url: string }[][] = [];

  // We only mint share buttons if we have the HMAC secret AND at least one
  // submitted result came with a trade summary. Referral code is fetched
  // lazily — minted on first call, then reused.
  let codePromise: Promise<string> | null = null;
  const getCode = (): Promise<string> => {
    codePromise ??= ctx.repo.getOrMintReferralCode(user.id);
    return codePromise;
  };
  const base = ctx.miniAppUrl.replace(/\/+$/u, '');
  const now = Date.now();

  for (const r of outcome.results) {
    if (r.kind === 'submitted') {
      const side = r.isBuy ? 'buy' : 'sell';
      if (r.trade) {
        const pnl = Number(r.trade.pnlUsd);
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `−$${Math.abs(pnl).toFixed(2)}`;
        const pct = Number(r.trade.pnlPct);
        const pctStr = pct >= 0 ? `+${pct.toFixed(2)}%` : `−${Math.abs(pct).toFixed(2)}%`;
        // Close summary uses our local ledger (intent.limitPx + mark at
        // close time), not HL's actual fill price. The numbers below are
        // estimates — always reconcile against your Hyperliquid account.
        lines.push(
          `  ✅ ${r.coin} ${r.trade.side.toUpperCase()}: closed ${r.trade.sz} ≈ $${r.trade.exitPx} (est. ${pnlStr}, ${pctStr})`,
        );
      } else {
        lines.push(`  ✅ ${r.coin}: ${side} ${r.sz} (reduce-only IOC)`);
      }
    } else if (r.kind === 'no_mark') {
      lines.push(`  ❌ ${r.coin}: no mark price available, try again in a moment`);
    } else if (r.kind === 'asset_unknown') {
      lines.push(`  ❌ ${r.coin}: asset not on Hyperliquid`);
    } else {
      lines.push(`  ❌ ${r.coin}: ${r.message}`);
    }
  }
  lines.push('', 'Use /pnl to confirm the position closed.');

  // Mint share buttons in order. We do this after the loop so the rendered
  // text comes first and stays readable even if code-mint fails.
  if (ctx.shareTokenSecret) {
    for (const r of outcome.results) {
      if (r.kind !== 'submitted' || !r.trade) continue;
      try {
        const code = await getCode();
        const token = signTradeShare(
          {
            code,
            coin: r.coin,
            side: r.trade.side,
            sz: r.trade.sz,
            entryPx: r.trade.entryPx,
            exitPx: r.trade.exitPx,
            pnlUsd: r.trade.pnlUsd,
            pnlPct: r.trade.pnlPct,
            whaleAlias: r.trade.whaleAlias,
            ts: now,
          },
          ctx.shareTokenSecret,
        );
        const longUrl = `${base}/share/t/${encodeURIComponent(token)}`;
        let tradeUrl = longUrl;
        if (ctx.shortLinks) {
          try {
            const id = await ctx.shortLinks.put(token);
            tradeUrl = `${base}/s/${id}`;
          } catch {
            // Fall back to the long URL if the short-link store is down.
          }
        }
        const pnl = Number(r.trade.pnlUsd);
        const emoji = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪';
        const pitch = `Closed ${r.trade.side} ${r.coin} on WhalePod.`;
        // Row 1: coin label header (text button that opens landing page with
        // its own share sheet). Row 2: explicit TG + X buttons side by side.
        const xText = `${emoji} Closed ${r.trade.side.toUpperCase()} ${r.coin} on @whalepod_bot`;
        buttons.push([
          {
            label: `${emoji} ${r.coin} — share on Telegram`,
            url: `https://t.me/share/url?url=${encodeURIComponent(tradeUrl)}&text=${encodeURIComponent(pitch)}`,
          },
          {
            label: `𝕏 ${r.coin}`,
            url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(xText)}&url=${encodeURIComponent(tradeUrl)}`,
          },
        ]);
      } catch {
        // Skip share button on this coin if token mint fails — don't block
        // the close confirmation.
      }
    }
  }

  return [{ text: lines.join('\n'), ...(buttons.length > 0 ? { buttons } : {}) }];
}

async function handleStart(startParam: string | null, ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  const whaleIntent = parseWhaleIntent(startParam);

  // Top-of-funnel tracking: log EVERY /start tap with its channel source so we
  // can count visitors per acquisition channel and measure tap→onboard
  // conversion. `src_<channel>` deep-link payloads tag where the user came from
  // (e.g. src_x, src_discord_wins). Whale-card taps land as `whale_<slug>` so
  // we can measure conversion per whale. Falls back to 'direct' when absent.
  const channel = parseStartChannel(startParam);
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: 'bot_start',
    target: `tg:${ctx.tgUser.id.toString()}`,
    after: {
      channel,
      startParam,
      returning: user !== null,
      whaleAddress: whaleIntent?.address ?? null,
      whaleAlias: whaleIntent?.alias ?? null,
    },
  });

  if (ctx.adminAlert) {
    const isAdminSelfTap = (ctx.adminTgUserIds ?? []).some((id) => id === ctx.tgUser.id);
    if (!isAdminSelfTap) {
      const handle =
        ctx.tgUser.username !== null ? `@${ctx.tgUser.username}` : `tg:${ctx.tgUser.id.toString()}`;
      const status = user !== null ? 'returning' : 'NEW';
      await ctx.adminAlert(`🐋 /start • ${handle} • ${status} • ${channel}`);
    }
  }

  if (!user) {
    // Stash the referral attempt as a no-op audit entry so we can correlate
    // post-onboarding. Actual attribution happens when the user exists.
    if (startParam?.startsWith('ref_') === true) {
      await ctx.repo.appendAudit({
        actor: `tg:${ctx.tgUser.id.toString()}`,
        action: 'referral_pending',
        target: `tg:${ctx.tgUser.id.toString()}`,
        after: { startParam },
      });
    }
    return [onboardReply(ctx, whaleIntent ?? undefined)];
  }

  if (startParam?.startsWith('ref_') === true) {
    const code = startParam.slice('ref_'.length).toLowerCase();
    if (/^[a-z0-9_-]{3,32}$/u.test(code)) {
      const referrer = await ctx.repo.findReferrerByCode(code);
      if (referrer && referrer.userId !== user.id) {
        const result = await ctx.repo.recordReferralAttribution(user.id, code);
        if (result.kind === 'attributed') {
          await ctx.repo.appendAudit({
            actor: `tg:${ctx.tgUser.id.toString()}`,
            action: 'referral_attributed',
            target: `user:${user.id}`,
            after: { code, referrerUserId: result.referrerUserId },
          });
        }
      }
    }
  }

  if (whaleIntent) {
    const subs = await ctx.repo.listSubscriptions(user.id);
    const whale = await ctx.repo.getWhaleByAddress(whaleIntent.address);
    const alreadyFollowing = whale !== null && subs.some((s) => s.whaleId === whale.id);
    if (alreadyFollowing) {
      return [
        {
          text: [
            `🐋 You're already mirroring ${whaleIntent.alias} (${whaleIntent.address}).`,
            '',
            `Use /mirrors to manage all your active mirrors, or /setcap`,
            `${whaleIntent.address} <usd> to change the per-trade size cap.`,
          ].join('\n'),
        },
      ];
    }
    return [
      {
        text: [
          `🐋 You came from ${whaleIntent.alias} on whalepod.trade.`,
          '',
          whaleIntent.tagline,
          '',
          `Tap to start mirroring (default $100 cap per trade):`,
          `/follow ${whaleIntent.address} 100`,
          '',
          `Change the 100 to whatever per-trade size you want. /mirrors lists`,
          `everyone you're already following.`,
        ].join('\n'),
      },
    ];
  }

  return [
    {
      text: [
        `👋 Welcome back!`,
        ``,
        `Wallet: ${user.mainWallet}`,
        `Builder fee: ${fmtFeeBps(user.currentFeeTenthsBp)}`,
        ``,
        `Tap /whales to browse traders, /mirrors to see what you're copying, or /help for everything.`,
      ].join('\n'),
    },
  ];
}

function helpReply(): Reply {
  return {
    text: [
      '🐋 WhalePod — what each command does',
      '',
      'Mirror trades from top Hyperliquid traders, automatically.',
      '',
      '▸ Find & follow whales',
      '/whales — browse traders you can copy',
      '/watch 0xabc... — FREE fill alerts for any whale (no wallet needed)',
      '/unwatch 0xabc... — stop those alerts',
      '/follow 0xabc... 50 — start copying a trader, risk at most $50 per trade',
      '/mirrors — list everyone you are copying',
      '',
      '▸ Tune a whale you follow',
      '/setcap 0xabc... 100 — change the per-trade size cap',
      '/setlev 0xabc... 5 — cap leverage (1–50) on copied trades from this whale',
      '/tp 0xabc... 200 — take-profit at +200 bps on next entry (/tp 0xabc... off to clear)',
      '/sl 0xabc... 100 — stop-loss at -100 bps on next entry (/sl 0xabc... off to clear)',
      '/unfollow 0xabc... — stop copying that trader',
      '',
      '▸ Your account',
      '/wallet — show wallet, agent, and fee',
      '/pause — temporarily stop ALL copying',
      '/resume — start copying again',
      '/kill — emergency stop (active until /unkill)',
      '/unkill — clear the emergency stop',
      '/disconnect — remove wallet and revoke the agent',
      '',
      '▸ Close open positions',
      '/close ETH — close your open ETH position (reduce-only IOC)',
      '/closeall — close every open position you have',
      '',
      '▸ Track performance',
      '/pnl — profit & loss across your mirrors',
      '/leaderboard — top WhalePod users this week',
      '',
      '▸ Alerts & invites',
      '/notify on — turn fill alerts on (off to silence)',
      '/notify compact — short alerts (or "full" for detailed)',
      '/share — your personal invite link',
    ].join('\n'),
  };
}

async function handleWallet(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  const subs = await ctx.repo.listSubscriptions(user.id);
  const active = subs.filter((s) => !s.paused).length;
  const lines = [
    `👛 Your WhalePod account`,
    ``,
    `Wallet:  ${user.mainWallet}`,
    `Agent:   ${user.agentAddress}  (signs trades on your behalf)`,
    `Builder fee: ${fmtFeeBps(user.currentFeeTenthsBp)}  (charged by Hyperliquid per fill)`,
    `Kill switch: ${user.killSwitch ? '🛑 ON — mirrors paused' : '✅ off'}`,
    `Mirrors: ${active.toString()} active / ${subs.length.toString()} total`,
    ``,
    `Use /mirrors to manage them, /disconnect to revoke this wallet.`,
  ];
  return [{ text: lines.join('\n') }];
}

async function handlePnl(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  if (ctx.hlPnl !== undefined) {
    const snap = await ctx.hlPnl.forUser(user.mainWallet as `0x${string}`);
    return [renderHlPnl(snap)];
  }
  const fills: readonly PnlFill[] = await ctx.repo.listFillsForUser(user.id, 500);
  const markPrice: MarkPriceFn = ctx.markPrice ?? ((): null => null);
  const summary = summarizePnl(fills, markPrice);
  return [renderPnl(summary)];
}

async function handleLeaderboard(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  const entries = await ctx.repo.listLeaderboard(50);
  // Hide anyone in the red. A "top traders" board should never headline a
  // losing trader, and at low user counts that would otherwise be a
  // first-impression killer — often just the founder, underwater.
  const result = computeLeaderboard(entries, { topN: 10, losersHidden: true });
  if (result.entries.length === 0) {
    // Nobody has booked a green closed trade yet. Don't show an empty or red
    // board — route the visitor to the whales they can copy to become the
    // first name up here.
    return [await renderCopyToRank(ctx)];
  }
  const reply = renderLeaderboard(result, user ? { viewerUserId: user.id } : {});
  return [reply];
}

/**
 * Leaderboard fallback shown until at least one WhalePod user has a winning
 * closed trade. Instead of "No ranked traders yet" (empty) or a red founder
 * row, it frames the empty board as an opportunity and points at the curated
 * whales + the live web directory — the exact next action a new visitor wants.
 */
async function renderCopyToRank(ctx: HandlerCtx): Promise<Reply> {
  const whales = await ctx.repo.listFeaturedWhales(3);
  const lines = [
    '🏆 Top traders',
    '',
    'No winning trade has closed yet — this board is wide open. Copy a curated Hyperliquid whale and your realized PnL shows up right here.',
    '',
  ];
  if (whales.length > 0) {
    lines.push('Start with one of these:', '');
    whales.forEach((w) => {
      const label = w.alias && w.alias.length > 0 ? w.alias : 'Whale';
      lines.push(`🐳 ${label}`);
      lines.push(`   /follow ${w.address}`);
    });
    lines.push('');
  }
  lines.push('→ /whales — browse every curated whale');
  lines.push('→ Live positions & PnL: https://www.whalepod.trade/whales');
  return { text: lines.join('\n') };
}

async function handleWhales(ctx: HandlerCtx): Promise<Reply[]> {
  const whales = await ctx.repo.listFeaturedWhales(10);
  if (whales.length === 0) {
    return [
      {
        text: [
          '🐋 No featured whales right now.',
          '',
          'You can still mirror any Hyperliquid address directly. Just send:',
          '/follow 0x… 50    (50 = max $50 per trade)',
        ].join('\n'),
      },
    ];
  }
  const lines = [
    '🐋 Featured whales',
    '',
    'These are public Hyperliquid addresses we picked from the HL leaderboard. Tap a /follow line to mirror that trader. You can add a per-trade size cap, e.g. /follow 0x… 25 to risk at most $25 per copied trade. Default cap is $100.',
    '',
    'Tap the hypurrscan link under each whale to verify their live HL trading history before you follow.',
    '',
  ];
  whales.forEach((w, i) => {
    const label = w.alias && w.alias.length > 0 ? w.alias : 'Whale';
    lines.push(`${(i + 1).toString()}. ${label}`);
    lines.push(`   ${w.address}`);
    lines.push(`   🔎 https://hypurrscan.io/address/${w.address}`);
    lines.push(`   /follow ${w.address}`);
    lines.push('');
  });
  lines.push(
    'After following, use /mirrors to see your list, /setcap to change the size, /unfollow to stop.',
  );
  lines.push('');
  lines.push('Not ready to connect a wallet? /watch 0x… — free fill alerts, no wallet needed.');
  return [{ text: lines.join('\n') }];
}

/**
 * Resolves a /watch | /unwatch target to a whale address. Accepts a raw 0x
 * address or a curated whale name in any casing ("HYPE-Maxi", "hypemaxi").
 * Returns null when the target matches neither.
 */
function resolveWhaleTarget(
  target: string,
): { readonly address: string; readonly alias: string | null } | null {
  if (ADDRESS_RE.test(target)) return { address: target.toLowerCase(), alias: null };
  const curated = findCuratedWhaleBySlug(whaleSlug(target));
  if (curated) return { address: curated.address.toLowerCase(), alias: curated.alias };
  return null;
}

async function handleWatch(target: string | null, ctx: HandlerCtx): Promise<Reply[]> {
  if (target === null) return [await watchMenuReply(ctx)];

  const resolved = resolveWhaleTarget(target);
  if (!resolved) {
    return [
      {
        text: [
          `${target} doesn't look like a whale I know.`,
          '',
          'Send a 0x… Hyperliquid address, or a featured whale name from /whales.',
          'Example: /watch 0xc6758a… or /watch HYPE-Maxi',
        ].join('\n'),
      },
    ];
  }

  // Raw addresses get the same liveness probe as /follow so a typo doesn't
  // become a silent watch that never alerts. Curated names skip it — they
  // are pre-verified. Probe failures fail open (HL outage ≠ blocked funnel).
  if (resolved.alias === null && ctx.whaleProbe) {
    const probe = await ctx.whaleProbe.forWhale(resolved.address as `0x${string}`);
    if (!probe.isReal) {
      return [
        {
          text: [
            `⚠️ ${resolved.address} has no trading history on Hyperliquid.`,
            '',
            'This usually means a typo or an empty wallet. Double-check the',
            'address and try again.',
          ].join('\n'),
        },
      ];
    }
  }

  const whale = await ctx.repo.upsertWhaleByAddress(resolved.address);
  const label = whale.alias ?? resolved.alias ?? fmtAddr(whale.address);
  const { created } = await ctx.repo.addWatch(ctx.tgUser.id, whale.id);
  if (!created) {
    return [
      {
        text: `You're already watching ${label} — you'll get a ping on every fill. /unwatch ${whale.address} to stop.`,
      },
    ];
  }

  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: 'watch',
    target: `whale:${whale.id}`,
    after: { whaleAddress: whale.address, alias: label },
  });

  if (ctx.adminAlert) {
    const isAdminSelf = (ctx.adminTgUserIds ?? []).some((id) => id === ctx.tgUser.id);
    if (!isAdminSelf) {
      const handle =
        ctx.tgUser.username !== null ? `@${ctx.tgUser.username}` : `tg:${ctx.tgUser.id.toString()}`;
      await ctx.adminAlert(`👀 New watcher • ${handle} • ${label}`);
    }
  }

  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  const lines = [
    `👀 Watching ${label}.`,
    '',
    `You'll get a Telegram ping every time this whale trades on Hyperliquid — side, size and price. Free, no wallet needed.`,
    '',
    user
      ? `Want the trades copied into your account automatically? /follow ${whale.address} 50 mirrors this whale with a $50 per-trade cap.`
      : `Want the trades copied into your own account automatically? Connect a wallet (60s, non-custodial — no withdraw access) and WhalePod mirrors this whale with a hard per-trade size cap.`,
    '',
    `/unwatch ${whale.address} — stop alerts`,
  ];
  if (!user) {
    const base = ctx.miniAppUrl.replace(/\/+$/u, '');
    const url = resolved.alias
      ? `${base}/onboard?tg=${ctx.tgUser.id.toString()}&whale=${whaleSlug(resolved.alias)}`
      : `${base}/onboard?tg=${ctx.tgUser.id.toString()}`;
    return [
      {
        text: lines.join('\n'),
        buttons: [[{ label: `⚡ Mirror ${label} automatically`, url }]],
      },
    ];
  }
  return [{ text: lines.join('\n') }];
}

/** Bare /watch — pick-a-whale menu plus the caller's current watches. */
async function watchMenuReply(ctx: HandlerCtx): Promise<Reply> {
  const [featured, watched] = await Promise.all([
    ctx.repo.listFeaturedWhales(5),
    ctx.repo.listWatchedWhales(ctx.tgUser.id),
  ]);
  const lines = [
    '👀 Whale watch — free fill alerts in Telegram',
    '',
    'Pick a whale and get a ping every time they trade. No wallet, no sign-up.',
    '',
  ];
  if (featured.length > 0) {
    featured.forEach((w) => {
      const label = w.alias && w.alias.length > 0 ? w.alias : fmtAddr(w.address);
      lines.push(`🐳 ${label}`);
      lines.push(`   /watch ${w.address}`);
    });
    lines.push('');
  }
  lines.push('Or watch any Hyperliquid address: /watch 0x…');
  if (watched.length > 0) {
    lines.push('', 'Already watching:');
    watched.forEach((w) => {
      const label = w.alias && w.alias.length > 0 ? w.alias : fmtAddr(w.address);
      lines.push(`  • ${label} — /unwatch ${w.address}`);
    });
  }
  return { text: lines.join('\n') };
}

async function handleUnwatch(target: string | null, ctx: HandlerCtx): Promise<Reply[]> {
  const watched = await ctx.repo.listWatchedWhales(ctx.tgUser.id);
  if (watched.length === 0) {
    return [{ text: "You're not watching any whales. /watch to start getting free fill alerts." }];
  }

  let whale: Whale | undefined;
  if (target === null) {
    if (watched.length === 1) {
      whale = watched[0];
    } else {
      const lines = ['You watch more than one whale — which one?', ''];
      watched.forEach((w) => {
        const label = w.alias && w.alias.length > 0 ? w.alias : fmtAddr(w.address);
        lines.push(`  • ${label} — /unwatch ${w.address}`);
      });
      return [{ text: lines.join('\n') }];
    }
  } else {
    const resolved = resolveWhaleTarget(target);
    if (!resolved) {
      return [{ text: `${target} doesn't match a watched whale. Bare /unwatch lists them.` }];
    }
    whale = watched.find((w) => w.address === resolved.address);
    if (!whale) {
      return [{ text: `You're not watching ${resolved.alias ?? resolved.address}.` }];
    }
  }
  if (!whale) return [{ text: 'Nothing to unwatch.' }];

  await ctx.repo.removeWatch(ctx.tgUser.id, whale.id);
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: 'unwatch',
    target: `whale:${whale.id}`,
    before: { whaleAddress: whale.address },
  });
  const label = whale.alias && whale.alias.length > 0 ? whale.alias : fmtAddr(whale.address);
  return [{ text: `Stopped watching ${label}. /watch to re-add any time.` }];
}

async function handleNotify(
  action: 'show' | 'on' | 'off' | 'compact' | 'full',
  ctx: HandlerCtx,
): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  const before = await ctx.repo.getNotifyPrefs(user.id);
  if (action === 'show') {
    return [{ text: describeNotifyPrefs(before) }];
  }
  const patch: NotifyPrefs =
    action === 'on'
      ? { muted: false }
      : action === 'off'
        ? { muted: true }
        : action === 'compact'
          ? { compact: true }
          : { compact: false };
  const after = await ctx.repo.setNotifyPrefs(user.id, patch);
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: `notify_${action}`,
    target: `user:${user.id}`,
    before,
    after,
  });
  return [{ text: describeNotifyPrefs(after) }];
}

function describeNotifyPrefs(p: NotifyPrefs): string {
  const muted = p.muted === true;
  const compact = p.compact === true;
  const lines = [
    `Notifications: ${muted ? 'OFF (muted)' : 'ON'}`,
    `Format: ${compact ? 'compact' : 'full'}`,
    '',
    muted
      ? 'You won\u2019t get a Telegram message when a mirror trade fills. Turn back on with /notify on.'
      : compact
        ? 'One-line alerts on every fill. Switch to detailed with /notify full.'
        : 'Detailed alerts with size, price, fee. Switch to short with /notify compact.',
  ];
  return lines.join('\n');
}

async function handleFollow(
  target: string,
  maxSizeUsd: number | null,
  ctx: HandlerCtx,
): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  if (!ADDRESS_RE.test(target)) {
    return [
      {
        text: `${target} is not a 0x address. Alias resolution lands later — paste the whale's 0x… address for now.`,
      },
    ];
  }
  const address = target.toLowerCase();

  if (ctx.whaleProbe) {
    const probe = await ctx.whaleProbe.forWhale(address as `0x${string}`);
    if (!probe.isReal) {
      return [
        {
          text: [
            `⚠️ ${address} has no trading history on Hyperliquid.`,
            '',
            'This usually means a typo or an empty wallet. Double-check',
            'the address and try again. If you’re sure it’s right and the',
            'wallet just started trading today, wait an hour and retry.',
          ].join('\n'),
        },
      ];
    }
  }

  const whale = await ctx.repo.upsertWhaleByAddress(address);
  const existing = await ctx.repo.listSubscriptions(user.id);
  if (existing.some((s) => s.whaleId === whale.id)) {
    return [
      {
        text: `You're already mirroring ${whale.address}. Use /setcap ${whale.address} <usd> to change the size, or /unfollow ${whale.address} to stop.`,
      },
    ];
  }
  const capStr = maxSizeUsd !== null ? maxSizeUsd.toFixed(2) : undefined;
  const sub = await ctx.repo.subscribe(user.id, whale.id, capStr);
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: 'subscribe',
    target: `whale:${whale.address}`,
    after: { subscriptionId: sub.id, maxSizeUsd: sub.maxSizeUsd },
  });
  const cap = Number(sub.maxSizeUsd);
  if (ctx.adminAlert) {
    const isAdminSelfTap = (ctx.adminTgUserIds ?? []).some((id) => id === ctx.tgUser.id);
    if (!isAdminSelfTap) {
      const handle =
        ctx.tgUser.username !== null ? `@${ctx.tgUser.username}` : `tg:${ctx.tgUser.id.toString()}`;
      await ctx.adminAlert(
        `🟢 New mirror • ${handle} • ${fmtAddr(whale.address)} • cap $${cap.toFixed(2)}`,
      );
    }
  }
  return [
    {
      text: [
        "✅ You're now mirroring this whale:",
        whale.address,
        ``,
        `Per-trade size cap: $${cap.toFixed(2)}`,
        `(WhalePod copies every whale fill — both entries and exits — sized so your notional risk on each trade stays at or below this cap.)`,
        ``,
        `• Change the cap:   /setcap ${whale.address} <usd>`,
        `• Stop mirroring:   /unfollow ${whale.address}`,
        `• See everything:   /mirrors`,
      ].join('\n'),
    },
  ];
}

async function handleSetCap(target: string, maxSizeUsd: number, ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  if (!ADDRESS_RE.test(target)) {
    return [{ text: `${target} is not a 0x address.` }];
  }
  const address = target.toLowerCase();
  const whale = await ctx.repo.getWhaleByAddress(address);
  if (!whale) return [{ text: `Not subscribed to ${fmtAddr(address)}. Use /follow first.` }];
  const subs = await ctx.repo.listSubscriptions(user.id);
  const sub = subs.find((s) => s.whaleId === whale.id);
  if (!sub) return [{ text: `Not subscribed to ${fmtAddr(address)}. Use /follow first.` }];
  const before = sub.maxSizeUsd;
  const capStr = maxSizeUsd.toFixed(2);
  const updated = await ctx.repo.setSubscriptionMaxSize(user.id, whale.id, capStr);
  if (!updated) return [{ text: 'Failed to update size cap.' }];
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: 'set_max_size',
    target: `subscription:${sub.id}`,
    before: { maxSizeUsd: before },
    after: { maxSizeUsd: capStr },
  });
  return [
    { text: `✅ Size cap for whale ${whale.address} set to $${maxSizeUsd.toFixed(2)} per trade.` },
  ];
}

async function handleSetLev(
  target: string,
  maxLeverage: number,
  ctx: HandlerCtx,
): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  if (!ADDRESS_RE.test(target)) {
    return [{ text: `${target} is not a 0x address.` }];
  }
  const address = target.toLowerCase();
  const whale = await ctx.repo.getWhaleByAddress(address);
  if (!whale) return [{ text: `Not subscribed to ${fmtAddr(address)}. Use /follow first.` }];
  const subs = await ctx.repo.listSubscriptions(user.id);
  const sub = subs.find((s) => s.whaleId === whale.id);
  if (!sub) return [{ text: `Not subscribed to ${fmtAddr(address)}. Use /follow first.` }];
  const result = await ctx.repo.setSubscriptionMaxLeverage(user.id, whale.id, maxLeverage);
  if (!result) return [{ text: 'Failed to update leverage.' }];
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: 'set_max_leverage',
    target: `subscription:${sub.id}`,
    before: { maxLeverage: result.before },
    after: { maxLeverage: result.after },
  });
  return [
    {
      text: [
        `✅ Max leverage for whale ${whale.address} set to ${maxLeverage.toString()}×.`,
        '',
        'WhalePod will send Hyperliquid `updateLeverage` for this asset',
        'right before your next copied trade, so the order opens with',
        `at most ${maxLeverage.toString()}× margin — even if the whale uses more.`,
      ].join('\n'),
    },
  ];
}

async function handleMirrors(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  const subs = await ctx.repo.listSubscriptions(user.id);
  if (subs.length === 0) {
    return [
      {
        text: [
          'No active mirrors yet.',
          '',
          'Browse curated whales with /whales, then /follow <0x…> to start.',
        ].join('\n'),
      },
    ];
  }
  const lines = [
    `🔁 Active mirrors (${subs.length.toString()})`,
    ``,
    `Each line shows: whale address — per-trade size cap — status.`,
    `The cap is the max USD notional WhalePod will copy on a single trade.`,
    ``,
  ];
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    if (!s) continue;
    const whale = await ctx.repo.getWhaleById(s.whaleId);
    const addr = whale?.address ?? s.whaleId;
    const alias = whale?.alias && whale.alias.length > 0 ? whale.alias : 'Whale';
    const cap = Number(s.maxSizeUsd);
    const status = s.paused || user.killSwitch ? '⏸ paused' : '▶ active';
    lines.push(`${(i + 1).toString()}. ${alias}`);
    lines.push(`   ${addr}`);
    lines.push(`   Cap: $${cap.toFixed(2)} per trade   •   ${status}`);
    lines.push('');
  }
  lines.push('Quick commands (copy the address above):');
  lines.push('  /setcap <addr> <usd>   change per-trade size cap');
  lines.push('  /unfollow <addr>       stop mirroring this whale');
  lines.push('  /pause  /resume        toggle ALL mirrors');
  return [{ text: lines.join('\n') }];
}

async function handleUnfollow(target: string, ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  if (!ADDRESS_RE.test(target)) {
    return [{ text: `${target} is not a 0x address.` }];
  }
  const address = target.toLowerCase();
  const whale = await ctx.repo.getWhaleByAddress(address);
  if (!whale) return [{ text: `Not subscribed to ${fmtAddr(address)}.` }];
  const removed = await ctx.repo.unsubscribe(user.id, whale.id);
  if (!removed) return [{ text: `Not subscribed to ${fmtAddr(address)}.` }];
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: 'unsubscribe',
    target: `whale:${whale.address}`,
  });
  return [
    {
      text: `✅ Stopped mirroring whale ${whale.address}.\n\nAny open positions you copied stay on your account — close them manually on Hyperliquid if you don't want them.`,
    },
  ];
}

async function handleSetPaused(paused: boolean, ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  const n = await ctx.repo.setAllSubscriptionsPaused(user.id, paused);
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: paused ? 'pause_all' : 'resume_all',
    target: `user:${user.id}`,
    after: { count: n },
  });
  return [
    {
      text: paused
        ? `⏸ Paused ${String(n)} mirror${n === 1 ? '' : 's'}. WhalePod won\u2019t copy any new trades until you /resume.`
        : `▶ Resumed ${String(n)} mirror${n === 1 ? '' : 's'}. New whale trades will be copied to your account.`,
    },
  ];
}

async function handleKill(killSwitch: boolean, ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  if (user.killSwitch === killSwitch) {
    return [{ text: `Kill switch already ${killSwitch ? 'ON' : 'off'}.` }];
  }
  await ctx.repo.setKillSwitch(user.id, killSwitch);
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: killSwitch ? 'kill_on' : 'kill_off',
    target: `user:${user.id}`,
    before: { killSwitch: user.killSwitch },
    after: { killSwitch },
  });
  return [
    {
      text: killSwitch
        ? '🛑 Kill switch ON.\n\nAll copying is hard-stopped until you send /unkill. Any open positions stay on your Hyperliquid account — close them there if you want to.'
        : '✅ Kill switch cleared.\n\nMirroring will resume on the next whale trade. Use /mirrors to see what\u2019s active.',
    },
  ];
}

async function handleDisconnect(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) {
    return [onboardReply(ctx)];
  }
  await ctx.repo.revokeUser(user.id);
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: 'wallet_disconnect',
    target: `user:${user.id}`,
    before: { mainWallet: user.mainWallet, agentAddress: user.agentAddress },
  });
  const base = ctx.miniAppUrl.replace(/\/+$/u, '');
  const url = `${base}/onboard?tg=${ctx.tgUser.id.toString()}`;
  return [
    {
      text: [
        '🔌 Wallet disconnected.',
        '',
        `Wallet ${fmtAddr(user.mainWallet)} has been removed and the agent key revoked. All mirrors are paused.`,
        '',
        'You can re-connect a wallet anytime — same or different.',
      ].join('\n'),
      buttons: [[{ label: '🚀 Connect a wallet', url }]],
    },
  ];
}

async function handleSetTpSl(
  kind: TpSl,
  target: string,
  offsetBps: number | null,
  ctx: HandlerCtx,
): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  if (!ADDRESS_RE.test(target)) {
    return [{ text: `${target} is not a 0x address.` }];
  }
  if (offsetBps !== null && (offsetBps < TPSL_MIN_BPS || offsetBps > TPSL_MAX_BPS)) {
    return [
      {
        text: `${kind.toUpperCase()} offset must be between ${String(TPSL_MIN_BPS)} and ${String(TPSL_MAX_BPS)} bps.`,
      },
    ];
  }
  const address = target.toLowerCase();
  const whale = await ctx.repo.getWhaleByAddress(address);
  if (!whale) {
    return [{ text: `Not subscribed to ${fmtAddr(address)}. Use /follow first.` }];
  }
  const subs = await ctx.repo.listSubscriptions(user.id);
  const sub = subs.find((s) => s.whaleId === whale.id);
  if (!sub) {
    return [{ text: `Not subscribed to ${fmtAddr(address)}. Use /follow first.` }];
  }
  const currentField = kind === 'tp' ? sub.tpBps : sub.slBps;
  if (currentField === offsetBps) {
    return [
      {
        text:
          offsetBps === null
            ? `${kind.toUpperCase()} already off for ${fmtAddr(address)}.`
            : `${kind.toUpperCase()} already at ${String(offsetBps)} bps for ${fmtAddr(address)}.`,
      },
    ];
  }
  const patch = kind === 'tp' ? { tpBps: offsetBps } : { slBps: offsetBps };
  await ctx.repo.setSubscriptionTpSl(user.id, whale.id, patch);
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: kind === 'tp' ? 'set_tp' : 'set_sl',
    target: `subscription:${sub.id}`,
    before: { [kind === 'tp' ? 'tpBps' : 'slBps']: currentField },
    after: patch,
  });
  const note =
    offsetBps === null
      ? `${kind.toUpperCase()} cleared for ${fmtAddr(address)}.`
      : [
          `${kind.toUpperCase()} set to ${String(offsetBps)} bps for ${fmtAddr(address)}.`,
          '',
          `WhalePod will place a reduce-only ${kind === 'tp' ? 'take-profit' : 'stop-loss'}`,
          'trigger on Hyperliquid right after your NEXT copied entry on this',
          'whale. Existing open positions are not modified — set those on HL',
          'directly if you want triggers on them.',
        ].join('\n');
  return [{ text: note }];
}
