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
  BUILDER_FEE_PERP_CAP_TENTHS_BP,
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
  readonly paused: boolean;
  readonly tpBps: number | null;
  readonly slBps: number | null;
}

export interface BotRepo {
  getUserByTgId(tgUserId: bigint): Promise<BotUser | null>;
  getWhaleByAddress(address: string): Promise<Whale | null>;
  upsertWhaleByAddress(address: string): Promise<Whale>;
  listSubscriptions(userId: string): Promise<readonly Subscription[]>;
  subscribe(userId: string, whaleId: string): Promise<Subscription>;
  unsubscribe(userId: string, whaleId: string): Promise<boolean>;
  setAllSubscriptionsPaused(userId: string, paused: boolean): Promise<number>;
  setSubscriptionTpSl(
    userId: string,
    whaleId: string,
    patch: { readonly tpBps?: number | null; readonly slBps?: number | null },
  ): Promise<Subscription | null>;
  setKillSwitch(userId: string, killSwitch: boolean): Promise<void>;
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

const ONBOARD_PROMPT = 'You need to onboard first. Tap the button to open the WhalePod app.';

function onboardReply(miniAppUrl: string): Reply {
  return {
    text: ONBOARD_PROMPT,
    buttons: [[{ label: 'Open WhalePod', url: miniAppUrl }]],
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
      return handleFollow(command.target, ctx);
    case 'unfollow':
      return handleUnfollow(command.target, ctx);
    case 'pause':
      return handleSetPaused(true, ctx);
    case 'resume':
      return handleSetPaused(false, ctx);
    case 'kill':
      return handleKill(true, ctx);
    case 'unkill':
      return handleKill(false, ctx);
    case 'fee':
      return handleFee(command.tenthsBp, ctx);
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
    case 'notify':
      return handleNotify(command.action, ctx);
    case 'unknown':
      return [{ text: `Unknown command: ${command.raw}\nTry /help` }];
  }
}

async function handleShare(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx.miniAppUrl)];
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
    return [onboardReply(ctx.miniAppUrl)];
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
      '/wallet — show connected wallet and current fee',
      '/follow <0x… or alias> — mirror a whale',
      '/unfollow <0x… or alias> — stop mirroring',
      '/pause — pause all subscriptions',
      '/resume — resume all subscriptions',
      '/fee <0–100> — set current builder fee (tenths of a bp; cap 100)',
      '/tp <0x…> <bps|off> — set take-profit offset for a whale (1–9999 bps)',
      '/sl <0x…> <bps|off> — set stop-loss offset for a whale (1–9999 bps)',
      '/kill — emergency stop (no mirrors will be sent)',
      '/unkill — clear emergency stop',
      '/share — get your invite link',
      '/pnl — show realized + unrealized PnL across your mirrors',
      '/leaderboard — top traders by realized PnL',
      '/notify on|off — enable or mute mirror-fill push notifications',
      '/notify compact|full — switch between one-line and detailed format',
    ].join('\n'),
  };
}

async function handleWallet(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx.miniAppUrl)];
  const lines = [
    `Wallet: ${fmtAddr(user.mainWallet)}`,
    `Agent: ${fmtAddr(user.agentAddress)}`,
    `Current fee: ${fmtFeeBps(user.currentFeeTenthsBp)} (approved up to ${fmtFeeBps(user.approvedMaxFeeTenthsBp)})`,
    `Kill switch: ${user.killSwitch ? 'ON' : 'off'}`,
  ];
  return [{ text: lines.join('\n') }];
}

async function handlePnl(ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx.miniAppUrl)];
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

async function handleNotify(
  action: 'show' | 'on' | 'off' | 'compact' | 'full',
  ctx: HandlerCtx,
): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx.miniAppUrl)];
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

async function handleFollow(target: string, ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx.miniAppUrl)];
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
    return [{ text: `Already following ${fmtAddr(whale.address)}.` }];
  }
  const sub = await ctx.repo.subscribe(user.id, whale.id);
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: 'subscribe',
    target: `whale:${whale.address}`,
    after: { subscriptionId: sub.id },
  });
  return [{ text: `Now mirroring ${fmtAddr(whale.address)}.` }];
}

async function handleUnfollow(target: string, ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx.miniAppUrl)];
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
  if (!user) return [onboardReply(ctx.miniAppUrl)];
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
  if (!user) return [onboardReply(ctx.miniAppUrl)];
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

async function handleFee(tenthsBp: number, ctx: HandlerCtx): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx.miniAppUrl)];
  if (tenthsBp > BUILDER_FEE_PERP_CAP_TENTHS_BP) {
    return [
      {
        text: `Fee ${String(tenthsBp)} exceeds protocol cap ${String(BUILDER_FEE_PERP_CAP_TENTHS_BP)}. Refused.`,
      },
    ];
  }
  if (tenthsBp > user.approvedMaxFeeTenthsBp) {
    return [
      {
        text: `Fee ${String(tenthsBp)} exceeds your on-chain approval (${String(user.approvedMaxFeeTenthsBp)}). Re-approve in the WhalePod app to raise it.`,
        buttons: [[{ label: 'Open WhalePod', url: ctx.miniAppUrl }]],
      },
    ];
  }
  if (tenthsBp === user.currentFeeTenthsBp) {
    return [{ text: `Fee already at ${fmtFeeBps(tenthsBp)}.` }];
  }
  await ctx.repo.setCurrentFee(user.id, tenthsBp);
  await ctx.repo.appendAudit({
    actor: `tg:${ctx.tgUser.id.toString()}`,
    action: 'set_fee',
    target: `user:${user.id}`,
    before: { currentFeeTenthsBp: user.currentFeeTenthsBp },
    after: { currentFeeTenthsBp: tenthsBp },
  });
  return [{ text: `Fee set to ${fmtFeeBps(tenthsBp)}.` }];
}

async function handleSetTpSl(
  kind: TpSl,
  target: string,
  offsetBps: number | null,
  ctx: HandlerCtx,
): Promise<Reply[]> {
  const user = await ctx.repo.getUserByTgId(ctx.tgUser.id);
  if (!user) return [onboardReply(ctx.miniAppUrl)];
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
