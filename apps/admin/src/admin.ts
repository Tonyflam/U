/**
 * Operator-only admin handlers.
 *
 * Mirrors the bot wedge pattern: pure `(command, ctx) → Reply` with all
 * side effects behind an injected `AdminRepo`. The grammy/HTTP adapter that
 * wires this in U16 is responsible for:
 *  1. Loading the operator allow-list from config (a small bigint set of
 *     Telegram user IDs).
 *  2. Passing `actorTgId` into `handleAdminCommand`. This module performs
 *     the authorization check itself — defense in depth: even if the
 *     transport layer forgets to gate the route, the handler still refuses.
 *  3. Persisting audit entries; every admin mutation appends one.
 *
 * Authorization model: an operator is identified by tg user id, NOT by
 * role-in-DB, so a compromised DB row cannot grant operator powers. The
 * allow-list is derived from environment / KMS-loaded config at startup.
 */
import { Address, type Address as AddressType } from '@whalepod/schema';
import type { z } from 'zod';

type AddressValue = z.infer<typeof Address>;

// ---------------------------------------------------------------------------
// Command parsing (text input from operator TG channel)
// ---------------------------------------------------------------------------

export type AdminCommand =
  | { readonly kind: 'whales' }
  | { readonly kind: 'add_whale'; readonly address: string; readonly alias: string | null }
  | { readonly kind: 'remove_whale'; readonly address: string }
  | { readonly kind: 'pause_user'; readonly userId: string }
  | { readonly kind: 'resume_user'; readonly userId: string }
  | { readonly kind: 'revoke_user'; readonly userId: string }
  | { readonly kind: 'unrevoke_user'; readonly userId: string }
  | { readonly kind: 'global_kill' }
  | { readonly kind: 'global_unkill' }
  | { readonly kind: 'stats' }
  | { readonly kind: 'help' }
  | { readonly kind: 'unknown'; readonly raw: string };

const COMMAND_RE = /^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+(.*))?$/u;

export function parseAdminCommand(text: string): AdminCommand | null {
  const trimmed = text.trim();
  const m = COMMAND_RE.exec(trimmed);
  if (!m) return null;
  const name = (m[1] ?? '').toLowerCase();
  const args = (m[2] ?? '').trim();
  switch (name) {
    case 'whales':
      return { kind: 'whales' };
    case 'add_whale': {
      const parts = args.split(/\s+/u).filter(Boolean);
      if (parts.length < 1) return { kind: 'unknown', raw: trimmed };
      const address = parts[0] ?? '';
      const alias = parts.length >= 2 ? parts.slice(1).join(' ') : null;
      return { kind: 'add_whale', address, alias };
    }
    case 'remove_whale':
      if (!args) return { kind: 'unknown', raw: trimmed };
      return { kind: 'remove_whale', address: args };
    case 'pause_user':
      if (!args) return { kind: 'unknown', raw: trimmed };
      return { kind: 'pause_user', userId: args };
    case 'resume_user':
      if (!args) return { kind: 'unknown', raw: trimmed };
      return { kind: 'resume_user', userId: args };
    case 'revoke_user':
      if (!args) return { kind: 'unknown', raw: trimmed };
      return { kind: 'revoke_user', userId: args };
    case 'unrevoke_user':
      if (!args) return { kind: 'unknown', raw: trimmed };
      return { kind: 'unrevoke_user', userId: args };
    case 'global_kill':
      return { kind: 'global_kill' };
    case 'global_unkill':
      return { kind: 'global_unkill' };
    case 'stats':
      return { kind: 'stats' };
    case 'help':
      return { kind: 'help' };
    default:
      return { kind: 'unknown', raw: trimmed };
  }
}

// ---------------------------------------------------------------------------
// Handler layer
// ---------------------------------------------------------------------------

export interface AdminWhale {
  readonly address: AddressValue;
  readonly alias: string | null;
  readonly subscriberCount: number;
}

export interface AdminUser {
  readonly id: string;
  readonly tgUserId: bigint;
  readonly paused: boolean;
  readonly revoked: boolean;
}

export interface AdminStats {
  readonly userCount: number;
  readonly activeSubscriptionCount: number;
  readonly curatedWhaleCount: number;
  readonly globalKill: boolean;
  readonly fills24h: number;
  readonly builderFeesUsd24h: number;
}

export interface AdminRepo {
  listCuratedWhales(): Promise<readonly AdminWhale[]>;
  upsertCuratedWhale(address: AddressValue, alias: string | null): Promise<AdminWhale>;
  removeCuratedWhale(address: AddressValue): Promise<boolean>;
  getUserById(userId: string): Promise<AdminUser | null>;
  setUserPaused(userId: string, paused: boolean): Promise<boolean>;
  setUserRevoked(userId: string, revoked: boolean): Promise<boolean>;
  getGlobalKill(): Promise<boolean>;
  setGlobalKill(killSwitch: boolean): Promise<void>;
  getStats(): Promise<AdminStats>;
  appendAudit(entry: {
    actor: string;
    action: string;
    target: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void>;
}

export interface AdminReply {
  readonly text: string;
}

export interface AdminCtx {
  readonly actorTgId: bigint;
  /** Allow-list of operator tg ids. Treated as read-only. */
  readonly operators: ReadonlySet<bigint>;
  readonly repo: AdminRepo;
}

const NOT_AUTHORIZED: AdminReply = {
  text: 'Not authorized.',
};

function ensureOperator(ctx: AdminCtx): boolean {
  return ctx.operators.has(ctx.actorTgId);
}

function fmtAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function parseAddress(input: string): AddressValue | null {
  const r = Address.safeParse(input);
  return r.success ? r.data : null;
}

export async function handleAdminCommand(
  command: AdminCommand,
  ctx: AdminCtx,
): Promise<AdminReply[]> {
  // Authorization first — every command requires operator status. The only
  // commands we'd ever serve to non-operators are inert ones (e.g. help),
  // and even then we refuse to leak the command surface.
  if (!ensureOperator(ctx)) {
    return [NOT_AUTHORIZED];
  }

  switch (command.kind) {
    case 'help':
      return [helpReply()];
    case 'whales':
      return handleWhales(ctx);
    case 'add_whale':
      return handleAddWhale(command.address, command.alias, ctx);
    case 'remove_whale':
      return handleRemoveWhale(command.address, ctx);
    case 'pause_user':
      return handlePauseUser(command.userId, true, ctx);
    case 'resume_user':
      return handlePauseUser(command.userId, false, ctx);
    case 'revoke_user':
      return handleRevokeUser(command.userId, true, ctx);
    case 'unrevoke_user':
      return handleRevokeUser(command.userId, false, ctx);
    case 'global_kill':
      return handleGlobalKill(true, ctx);
    case 'global_unkill':
      return handleGlobalKill(false, ctx);
    case 'stats':
      return handleStats(ctx);
    case 'unknown':
      return [{ text: `Unknown command: ${command.raw}\nTry /help` }];
  }
}

function helpReply(): AdminReply {
  return {
    text: [
      'WhalePod admin commands:',
      '/whales — list curated whales',
      '/add_whale <0x…> [alias…] — add or update a curated whale',
      '/remove_whale <0x…> — remove a curated whale',
      '/pause_user <userId> — pause all mirroring for a user',
      '/resume_user <userId> — resume a paused user',
      '/revoke_user <userId> — hard revoke (stamps revoked_at; bot will not sign)',
      '/unrevoke_user <userId> — clear a hard revoke',
      '/global_kill — stop mirroring system-wide',
      '/global_unkill — clear global kill',
      '/stats — system health snapshot (users, subs, fills 24h, fees 24h)',
    ].join('\n'),
  };
}

async function handleWhales(ctx: AdminCtx): Promise<AdminReply[]> {
  const list = await ctx.repo.listCuratedWhales();
  if (list.length === 0) {
    return [{ text: 'No curated whales.' }];
  }
  const lines = ['Curated whales:'];
  for (const w of list) {
    const label = w.alias ?? fmtAddr(w.address);
    lines.push(`• ${label} (${fmtAddr(w.address)}) — ${String(w.subscriberCount)} subs`);
  }
  return [{ text: lines.join('\n') }];
}

async function handleAddWhale(
  rawAddress: string,
  alias: string | null,
  ctx: AdminCtx,
): Promise<AdminReply[]> {
  const address = parseAddress(rawAddress);
  if (address === null) return [{ text: `\`${rawAddress}\` is not a 0x address.` }];
  if (alias !== null && alias.length > 64) {
    return [{ text: 'Alias must be 64 characters or fewer.' }];
  }
  const whale = await ctx.repo.upsertCuratedWhale(address, alias);
  await ctx.repo.appendAudit({
    actor: `op:${ctx.actorTgId.toString()}`,
    action: 'admin_add_whale',
    target: `whale:${address}`,
    after: { alias },
  });
  const label = whale.alias ?? fmtAddr(whale.address);
  return [{ text: `Curated whale upserted: ${label}.` }];
}

async function handleRemoveWhale(rawAddress: string, ctx: AdminCtx): Promise<AdminReply[]> {
  const address = parseAddress(rawAddress);
  if (address === null) return [{ text: `\`${rawAddress}\` is not a 0x address.` }];
  const removed = await ctx.repo.removeCuratedWhale(address);
  if (!removed) return [{ text: `No curated whale at ${fmtAddr(address)}.` }];
  await ctx.repo.appendAudit({
    actor: `op:${ctx.actorTgId.toString()}`,
    action: 'admin_remove_whale',
    target: `whale:${address}`,
  });
  return [{ text: `Curated whale removed: ${fmtAddr(address)}.` }];
}

async function handlePauseUser(
  userId: string,
  paused: boolean,
  ctx: AdminCtx,
): Promise<AdminReply[]> {
  const user = await ctx.repo.getUserById(userId);
  if (!user) return [{ text: `No user with id \`${userId}\`.` }];
  if (user.paused === paused) {
    return [{ text: `User ${userId} already ${paused ? 'paused' : 'active'}.` }];
  }
  await ctx.repo.setUserPaused(userId, paused);
  await ctx.repo.appendAudit({
    actor: `op:${ctx.actorTgId.toString()}`,
    action: paused ? 'admin_pause_user' : 'admin_resume_user',
    target: `user:${userId}`,
    before: { paused: user.paused },
    after: { paused },
  });
  return [{ text: paused ? `User ${userId} paused.` : `User ${userId} resumed.` }];
}

async function handleRevokeUser(
  userId: string,
  revoked: boolean,
  ctx: AdminCtx,
): Promise<AdminReply[]> {
  const user = await ctx.repo.getUserById(userId);
  if (!user) return [{ text: `No user with id \`${userId}\`.` }];
  if (user.revoked === revoked) {
    return [{ text: `User ${userId} already ${revoked ? 'revoked' : 'active'}.` }];
  }
  await ctx.repo.setUserRevoked(userId, revoked);
  await ctx.repo.appendAudit({
    actor: `op:${ctx.actorTgId.toString()}`,
    action: revoked ? 'admin_revoke_user' : 'admin_unrevoke_user',
    target: `user:${userId}`,
    before: { revoked: user.revoked },
    after: { revoked },
  });
  return [
    {
      text: revoked
        ? `User ${userId} REVOKED. Bot will refuse to sign new orders.`
        : `User ${userId} unrevoked.`,
    },
  ];
}

async function handleGlobalKill(killSwitch: boolean, ctx: AdminCtx): Promise<AdminReply[]> {
  const current = await ctx.repo.getGlobalKill();
  if (current === killSwitch) {
    return [{ text: `Global kill already ${killSwitch ? 'ON' : 'off'}.` }];
  }
  await ctx.repo.setGlobalKill(killSwitch);
  await ctx.repo.appendAudit({
    actor: `op:${ctx.actorTgId.toString()}`,
    action: killSwitch ? 'admin_global_kill_on' : 'admin_global_kill_off',
    target: 'system',
    before: { killSwitch: current },
    after: { killSwitch },
  });
  return [
    {
      text: killSwitch
        ? 'GLOBAL KILL ENGAGED. No mirrors will be sent system-wide.'
        : 'Global kill cleared. Mirroring will resume on next fill.',
    },
  ];
}

// Re-export the Address type alias used in tests too, for convenience.
export type { AddressType };

async function handleStats(ctx: AdminCtx): Promise<AdminReply[]> {
  const s = await ctx.repo.getStats();
  const lines = [
    'System stats',
    `Users: ${String(s.userCount)}`,
    `Active subs: ${String(s.activeSubscriptionCount)}`,
    `Curated whales: ${String(s.curatedWhaleCount)}`,
    `Fills (24h): ${String(s.fills24h)}`,
    `Builder fees (24h): $${s.builderFeesUsd24h.toFixed(2)}`,
    `Global kill: ${s.globalKill ? 'ON' : 'off'}`,
  ];
  return [{ text: lines.join('\n') }];
}
