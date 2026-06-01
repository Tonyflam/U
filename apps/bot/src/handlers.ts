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
import { TPSL_MAX_BPS, TPSL_MIN_BPS, signTradeShare, type TpSl } from '@whalepod/sdk';
import { renderPnl, summarizePnl, type MarkPriceFn, type PnlFill } from './pnl.js';
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
  subscribe(userId: string, whaleId: string, maxSizeUsd?: string): Promise<Subscription>;
  unsubscribe(userId: string, whaleId: string): Promise<boolean>;
  setAllSubscriptionsPaused(userId: string, paused: boolean): Promise<number>;
  setSubscriptionMaxSize(
    userId: string,
    whaleId: string,
    maxSizeUsd: string,
  ): Promise<Subscription | null>;
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
}

/** Records that a (user, coin) pair should not be mirrored for a TTL window. */
export interface MirrorBlockSink {
  block(userId: string, coin: string): Promise<void>;
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

const ONBOARD_PROMPT =
  "Let's get you onboarded. Tap the button below to connect your Hyperliquid wallet.\n\nWhalePod is non-custodial: you keep your funds, we only mirror trades through an agent key you approve.";

function onboardReply(ctx: HandlerCtx): Reply {
  const base = ctx.miniAppUrl.replace(/\/+$/u, '');
  const url = `${base}/onboard?tg=${ctx.tgUser.id.toString()}`;
  return {
    text: ONBOARD_PROMPT,
    buttons: [[{ label: '🚀 Open WhalePod', url }]],
  };
}

function fmtAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtFeeBps(tenthsBp: number): string {
  return `${(tenthsBp / 10).toFixed(1)} bps`;
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
        'Share card (unfurls your live PnL):',
        shareUrl,
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

  // Suppress future mirror orders on each successfully-closed coin so the
  // whale's eventual exit fill doesn't open an opposite-direction position.
  // TTL is owned by the sink (~24h by default).
  if (ctx.mirrorBlocks) {
    for (const r of outcome.results) {
      if (r.kind === 'submitted') {
        try {
          await ctx.mirrorBlocks.block(user.id, r.coin);
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
        lines.push(
          `  ✅ ${r.coin} ${r.trade.side.toUpperCase()}: closed ${r.trade.sz} @ $${r.trade.exitPx} (${pnlStr}, ${pctStr})`,
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
    return [onboardReply(ctx)];
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
      '/follow 0xabc... 50 — start copying a trader, risk at most $50 per trade',
      '/mirrors — list everyone you are copying',
      '',
      '▸ Tune a whale you follow',
      '/setcap 0xabc... 100 — change the per-trade size cap',
      '/tp 0xabc... 200 — auto take-profit at +2% (200 bps). Use "off" to disable.',
      '/sl 0xabc... 100 — auto stop-loss at -1% (100 bps). Use "off" to disable.',
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
  const fills: readonly PnlFill[] = await ctx.repo.listFillsForUser(user.id, 500);
  const markPrice: MarkPriceFn = ctx.markPrice ?? ((): null => null);
  const summary = summarizePnl(fills, markPrice);
  return [renderPnl(summary)];
}

async function handleLeaderboard(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  const entries = await ctx.repo.listLeaderboard(50);
  const result = computeLeaderboard(entries, { topN: 10 });
  const reply = renderLeaderboard(result, user ? { viewerUserId: user.id } : {});
  return [reply];
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
    'Tap a /follow line to mirror that trader. You can add a per-trade size cap, e.g. /follow 0x… 25 to risk at most $25 per copied trade. Default cap is $100.',
    '',
  ];
  whales.forEach((w, i) => {
    const label = w.alias && w.alias.length > 0 ? w.alias : 'Whale';
    lines.push(`${(i + 1).toString()}. ${label}`);
    lines.push(`   ${w.address}`);
    lines.push(`   /follow ${w.address}`);
    lines.push('');
  });
  lines.push(
    'After following, use /mirrors to see your list, /setcap to change the size, /unfollow to stop.',
  );
  return [{ text: lines.join('\n') }];
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
  return [
    {
      text: [
        "✅ You're now mirroring this whale:",
        whale.address,
        ``,
        `Per-trade size cap: $${cap.toFixed(2)}`,
        `(Every time the whale opens a trade, WhalePod copies it on your wallet, sized so your notional risk on that trade stays at or below this cap.)`,
        ``,
        `• Change the cap:   /setcap ${whale.address} <usd>`,
        `• Set take-profit:  /tp ${whale.address} <bps>`,
        `• Set stop-loss:    /sl ${whale.address} <bps>`,
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
    const tp = s.tpBps !== null ? `TP +${(s.tpBps / 100).toFixed(2)}%` : 'TP off';
    const sl = s.slBps !== null ? `SL -${(s.slBps / 100).toFixed(2)}%` : 'SL off';
    lines.push(`${(i + 1).toString()}. ${alias}`);
    lines.push(`   ${addr}`);
    lines.push(`   Cap: $${cap.toFixed(2)} per trade   •   ${status}`);
    lines.push(`   ${tp}  |  ${sl}`);
    lines.push('');
  }
  lines.push('Quick commands (copy the address above):');
  lines.push('  /setcap <addr> <usd>   change per-trade size cap');
  lines.push('  /tp <addr> <bps|off>   set take-profit  (100 bps = 1%)');
  lines.push('  /sl <addr> <bps|off>   set stop-loss');
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
  // Belt-and-braces: router already enforces [1, 10000] or null.
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
  return [
    {
      text:
        offsetBps === null
          ? `${kind.toUpperCase()} cleared for ${fmtAddr(address)}.`
          : `${kind.toUpperCase()} set to ${String(offsetBps)} bps for ${fmtAddr(address)}.`,
    },
  ];
}
