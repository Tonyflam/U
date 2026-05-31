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
  TPSL_MAX_BPS,
  TPSL_MIN_BPS,
  type TpSl,
} from '@whalepod/sdk';
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
  const url = `https://t.me/${ctx.botUsername}?start=ref_${code}`;
  return [
    {
      text: ['Invite friends to mirror whales on WhalePod.', '', `Your link: ${url}`].join('\n'),
      buttons: [
        [
          {
            label: 'Share on Telegram',
            url: `https://t.me/share/url?url=${encodeURIComponent(url)}`,
          },
        ],
      ],
    },
  ];
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
      text: `Welcome back. Wallet ${fmtAddr(user.mainWallet)} connected. Use /help to see commands.`,
    },
  ];
}

function helpReply(): Reply {
  return {
    text: [
      'WhalePod commands:',
      '/wallet — show connected wallet',
      '/follow <0x…> [usd] — mirror a whale (optional per-trade size cap, default $100)',
      '/unfollow <0x…> — stop mirroring',
      '/setcap <0x…> <usd> — change per-trade size cap for a whale',
      '/mirrors — list your active mirrors',
      '/pause — pause all subscriptions',
      '/resume — resume all subscriptions',
      '/tp <0x…> <bps|off> — set take-profit offset for a whale (1–9999 bps)',
      '/sl <0x…> <bps|off> — set stop-loss offset for a whale (1–9999 bps)',
      '/kill — emergency stop (no mirrors will be sent)',
      '/unkill — clear emergency stop',
      '/disconnect — disconnect wallet & revoke agent (you can re-onboard after)',
      '/share — get your invite link',
      '/pnl — show realized + unrealized PnL across your mirrors',
      '/leaderboard — top traders by realized PnL',
      '/whales — browse curated whales to mirror',
      '/notify on|off — enable or mute mirror-fill push notifications',
      '/notify compact|full — switch between one-line and detailed format',
    ].join('\n'),
  };
}

async function handleWallet(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  const lines = [
    `Wallet: ${fmtAddr(user.mainWallet)}`,
    `Agent: ${fmtAddr(user.agentAddress)}`,
    `Builder fee: ${fmtFeeBps(user.currentFeeTenthsBp)}`,
    `Kill switch: ${user.killSwitch ? 'ON' : 'off'}`,
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
          '🐋 No featured whales yet.',
          '',
          'You can still mirror any Hyperliquid address directly:',
          '`/follow 0x…`',
        ].join('\n'),
      },
    ];
  }
  const lines = ['🐋 Featured whales — tap a command to mirror:', ''];
  whales.forEach((w, i) => {
    const label = w.alias && w.alias.length > 0 ? w.alias : fmtAddr(w.address);
    lines.push(`${(i + 1).toString()}. ${label}`);
    lines.push(`   /follow ${w.address}`);
  });
  lines.push('');
  lines.push('Use /unfollow <address> to stop mirroring. /leaderboard ranks live performers.');
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
        text: `\`${target}\` is not a 0x address. Alias resolution lands later — paste the whale's 0x… address for now.`,
      },
    ];
  }
  const address = target.toLowerCase();
  const whale = await ctx.repo.upsertWhaleByAddress(address);
  const existing = await ctx.repo.listSubscriptions(user.id);
  if (existing.some((s) => s.whaleId === whale.id)) {
    return [{ text: `Already following ${fmtAddr(whale.address)}. Use /setcap ${whale.address} <usd> to change size.` }];
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
        `✅ Mirroring ${fmtAddr(whale.address)}.`,
        `Max size per trade: $${cap.toFixed(2)}`,
        '',
        `Change later with /setcap ${whale.address} <usd>.`,
        'See all active mirrors with /mirrors.',
      ].join('\n'),
    },
  ];
}

async function handleSetCap(
  target: string,
  maxSizeUsd: number,
  ctx: HandlerCtx,
): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  if (!ADDRESS_RE.test(target)) {
    return [{ text: `\`${target}\` is not a 0x address.` }];
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
  return [{ text: `Size cap for ${fmtAddr(whale.address)} set to $${maxSizeUsd.toFixed(2)}.` }];
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
  const lines = [`🔁 Active mirrors (${subs.length.toString()}):`, ''];
  for (const s of subs) {
    const whale = await ctx.repo.getWhaleById(s.whaleId);
    const addr = whale?.address ?? s.whaleId;
    const alias = whale?.alias ? ` (${whale.alias})` : '';
    const cap = Number(s.maxSizeUsd);
    const status = s.paused || user.killSwitch ? '⏸ paused' : '▶ active';
    const tp = s.tpBps !== null ? `TP ${s.tpBps.toString()}bps` : 'TP off';
    const sl = s.slBps !== null ? `SL ${s.slBps.toString()}bps` : 'SL off';
    lines.push(`• ${fmtAddr(addr)}${alias} — $${cap.toFixed(2)} — ${status}`);
    lines.push(`   ${tp} | ${sl}`);
  }
  lines.push('');
  lines.push('Commands: /setcap <addr> <usd> | /tp <addr> <bps|off> | /sl <addr> <bps|off> | /unfollow <addr>');
  return [{ text: lines.join('\n') }];
}

async function handleUnfollow(target: string, ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx)];
  if (!ADDRESS_RE.test(target)) {
    return [{ text: `\`${target}\` is not a 0x address.` }];
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
  return [{ text: `Stopped mirroring ${fmtAddr(whale.address)}.` }];
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
    { text: paused ? `Paused ${String(n)} subscriptions.` : `Resumed ${String(n)} subscriptions.` },
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
        ? 'Kill switch ON. No further mirrors will be sent until /unkill.'
        : 'Kill switch cleared. Mirrors will resume on next whale fill.',
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
    return [{ text: `\`${target}\` is not a 0x address.` }];
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
