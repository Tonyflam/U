/**
 * Pure command router for the Telegram bot.
 *
 * Grammy hands us a message text; this module decides what to do without
 * touching network or DB. The bot framework adapter (in `bot.ts`) calls
 * `parseCommand(text)` then dispatches.
 */
export type Command =
  | { readonly kind: 'start'; readonly startParam: string | null }
  | { readonly kind: 'help' }
  | { readonly kind: 'wallet' }
  | { readonly kind: 'follow'; readonly target: string; readonly maxSizeUsd: number | null }
  | { readonly kind: 'unfollow'; readonly target: string }
  | { readonly kind: 'setcap'; readonly target: string; readonly maxSizeUsd: number }
  | { readonly kind: 'setlev'; readonly target: string; readonly maxLeverage: number }
  | { readonly kind: 'mirrors' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'kill' }
  | { readonly kind: 'unkill' }
  | { readonly kind: 'disconnect' }
  | { readonly kind: 'tp'; readonly target: string; readonly offsetBps: number | null }
  | { readonly kind: 'sl'; readonly target: string; readonly offsetBps: number | null }
  | { readonly kind: 'share' }
  | { readonly kind: 'close'; readonly coin: string }
  | { readonly kind: 'closeall' }
  | { readonly kind: 'pnl' }
  | { readonly kind: 'leaderboard' }
  | { readonly kind: 'whales' }
  | { readonly kind: 'watch'; readonly target: string | null }
  | { readonly kind: 'unwatch'; readonly target: string | null }
  | { readonly kind: 'notify'; readonly action: 'show' | 'on' | 'off' | 'compact' | 'full' }
  | { readonly kind: 'unknown'; readonly raw: string };

const COMMAND_RE = /^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+(.*))?$/u;

export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  const m = COMMAND_RE.exec(trimmed);
  if (!m) return null;
  const name = (m[1] ?? '').toLowerCase();
  const args = (m[2] ?? '').trim();
  switch (name) {
    case 'start':
      return { kind: 'start', startParam: args.length > 0 ? args : null };
    case 'help':
      return { kind: 'help' };
    case 'wallet':
      return { kind: 'wallet' };
    case 'follow': {
      if (!args) return { kind: 'unknown', raw: trimmed };
      const parts = args.split(/\s+/u).filter(Boolean);
      const target = parts[0] ?? '';
      if (parts.length === 1) return { kind: 'follow', target, maxSizeUsd: null };
      if (parts.length !== 2) return { kind: 'unknown', raw: trimmed };
      const n = Number(parts[1]);
      if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return { kind: 'unknown', raw: trimmed };
      return { kind: 'follow', target, maxSizeUsd: n };
    }
    case 'unfollow':
      if (!args) return { kind: 'unknown', raw: trimmed };
      return { kind: 'unfollow', target: args };
    case 'setcap':
    case 'cap': {
      const parts = args.split(/\s+/u).filter(Boolean);
      if (parts.length !== 2) return { kind: 'unknown', raw: trimmed };
      const target = parts[0] ?? '';
      const n = Number(parts[1]);
      if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return { kind: 'unknown', raw: trimmed };
      return { kind: 'setcap', target, maxSizeUsd: n };
    }
    case 'setlev':
    case 'lev':
    case 'leverage': {
      const parts = args.split(/\s+/u).filter(Boolean);
      if (parts.length !== 2) return { kind: 'unknown', raw: trimmed };
      const target = parts[0] ?? '';
      const n = Number(parts[1]);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 50) {
        return { kind: 'unknown', raw: trimmed };
      }
      return { kind: 'setlev', target, maxLeverage: n };
    }
    case 'mirrors':
    case 'subs':
      return { kind: 'mirrors' };
    case 'pause':
      return { kind: 'pause' };
    case 'resume':
      return { kind: 'resume' };
    case 'kill':
      return { kind: 'kill' };
    case 'unkill':
      return { kind: 'unkill' };
    case 'disconnect':
    case 'logout':
      return { kind: 'disconnect' };
    case 'share':
      return { kind: 'share' };
    case 'close': {
      if (!args) return { kind: 'unknown', raw: trimmed };
      const parts = args.split(/\s+/u).filter(Boolean);
      if (parts.length !== 1) return { kind: 'unknown', raw: trimmed };
      const coin = (parts[0] ?? '').toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/u.test(coin)) return { kind: 'unknown', raw: trimmed };
      return { kind: 'close', coin };
    }
    case 'closeall':
      return { kind: 'closeall' };
    case 'pnl':
      return { kind: 'pnl' };
    case 'leaderboard':
    case 'lb':
      return { kind: 'leaderboard' };
    case 'whales':
    case 'browse':
      return { kind: 'whales' };
    case 'watch': {
      // Free, no-wallet whale fill alerts. Bare /watch shows the picker.
      // Target may be a 0x address or a curated whale name — the handler
      // resolves it, so the router stays permissive on shape.
      const parts = args.split(/\s+/u).filter(Boolean);
      if (parts.length > 1) return { kind: 'unknown', raw: trimmed };
      return { kind: 'watch', target: parts[0] ?? null };
    }
    case 'unwatch': {
      const parts = args.split(/\s+/u).filter(Boolean);
      if (parts.length > 1) return { kind: 'unknown', raw: trimmed };
      return { kind: 'unwatch', target: parts[0] ?? null };
    }
    case 'notify': {
      if (!args) return { kind: 'notify', action: 'show' };
      const sub = args.toLowerCase();
      if (sub === 'on') return { kind: 'notify', action: 'on' };
      if (sub === 'off' || sub === 'mute') return { kind: 'notify', action: 'off' };
      if (sub === 'compact') return { kind: 'notify', action: 'compact' };
      if (sub === 'full' || sub === 'verbose') return { kind: 'notify', action: 'full' };
      return { kind: 'unknown', raw: trimmed };
    }
    case 'fee': {
      // /fee is no longer user-controllable. The builder fee is fixed at the
      // protocol default and is the WhalePod take rate.
      return { kind: 'unknown', raw: trimmed };
    }
    case 'tp':
    case 'sl': {
      const parts = args.split(/\s+/u).filter(Boolean);
      if (parts.length !== 2) return { kind: 'unknown', raw: trimmed };
      const target = parts[0] ?? '';
      const raw = parts[1] ?? '';
      if (raw.toLowerCase() === 'off') {
        return { kind: name, target, offsetBps: null };
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 9_999) {
        return { kind: 'unknown', raw: trimmed };
      }
      return { kind: name, target, offsetBps: n };
    }
    default:
      return { kind: 'unknown', raw: trimmed };
  }
}
