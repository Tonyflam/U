/**
 * In-process implementation of `BotRepo` for tests + local dev.
 *
 * Maintains the same invariants the Drizzle impl will (unique whale per
 * (user, whale), audit log append-only, kill switch is a single boolean).
 */
import type { BotRepo, BotUser, Subscription, Whale } from './handlers.js';
import type { NotifyPrefs } from './notify.js';
import type { PnlFill } from './pnl.js';
import type { LeaderboardEntry } from './referral.js';

export interface AuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

let nextId = 1;
function uid(prefix: string): string {
  const n = nextId++;
  return `${prefix}-${n.toString().padStart(4, '0')}`;
}

export class InMemoryBotRepo implements BotRepo {
  readonly users = new Map<string, BotUser>();
  readonly usersByTg = new Map<bigint, string>();
  readonly whales = new Map<string, Whale>();
  readonly whalesByAddress = new Map<string, string>();
  readonly subscriptions: Subscription[] = [];
  readonly audit: AuditEntry[] = [];
  readonly referralCodes = new Map<string, string>();
  readonly attribution = new Map<string, string>(); // referredUserId → code
  readonly fillsByUser = new Map<string, PnlFill[]>();
  readonly leaderboard: LeaderboardEntry[] = [];
  readonly notifyPrefs = new Map<string, NotifyPrefs>();

  seedUser(partial: Partial<BotUser> & { tgUserId: bigint; mainWallet: string }): BotUser {
    const id = partial.id ?? uid('u');
    const user: BotUser = {
      id,
      tgUserId: partial.tgUserId,
      tgUsername: partial.tgUsername ?? null,
      mainWallet: partial.mainWallet,
      agentAddress: partial.agentAddress ?? '0xaaaa222233334444555566667777888899990000',
      approvedMaxFeeTenthsBp: partial.approvedMaxFeeTenthsBp ?? 50,
      currentFeeTenthsBp: partial.currentFeeTenthsBp ?? 30,
      killSwitch: partial.killSwitch ?? false,
    };
    this.users.set(id, user);
    this.usersByTg.set(user.tgUserId, id);
    return user;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getUserByTgId(tgUserId: bigint): Promise<BotUser | null> {
    const id = this.usersByTg.get(tgUserId);
    return id ? (this.users.get(id) ?? null) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getWhaleByAddress(address: string): Promise<Whale | null> {
    const id = this.whalesByAddress.get(address.toLowerCase());
    return id ? (this.whales.get(id) ?? null) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async upsertWhaleByAddress(address: string): Promise<Whale> {
    const key = address.toLowerCase();
    const existing = this.whalesByAddress.get(key);
    if (existing) {
      const found = this.whales.get(existing);
      if (found) return found;
    }
    const id = uid('w');
    const whale: Whale = { id, address: key, alias: null };
    this.whales.set(id, whale);
    this.whalesByAddress.set(key, id);
    return whale;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listSubscriptions(userId: string): Promise<readonly Subscription[]> {
    return this.subscriptions.filter((s) => s.userId === userId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribe(userId: string, whaleId: string): Promise<Subscription> {
    const existing = this.subscriptions.find((s) => s.userId === userId && s.whaleId === whaleId);
    if (existing) return existing;
    const sub: Subscription = {
      id: uid('s'),
      userId,
      whaleId,
      paused: false,
      tpBps: null,
      slBps: null,
    };
    this.subscriptions.push(sub);
    return sub;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async unsubscribe(userId: string, whaleId: string): Promise<boolean> {
    const idx = this.subscriptions.findIndex((s) => s.userId === userId && s.whaleId === whaleId);
    if (idx < 0) return false;
    this.subscriptions.splice(idx, 1);
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setAllSubscriptionsPaused(userId: string, paused: boolean): Promise<number> {
    let count = 0;
    for (let i = 0; i < this.subscriptions.length; i++) {
      const s = this.subscriptions[i];
      if (s && s.userId === userId && s.paused !== paused) {
        this.subscriptions[i] = { ...s, paused };
        count += 1;
      }
    }
    return count;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setSubscriptionTpSl(
    userId: string,
    whaleId: string,
    patch: { readonly tpBps?: number | null; readonly slBps?: number | null },
  ): Promise<Subscription | null> {
    for (let i = 0; i < this.subscriptions.length; i++) {
      const s = this.subscriptions[i];
      if (s && s.userId === userId && s.whaleId === whaleId) {
        const next: Subscription = {
          ...s,
          tpBps: patch.tpBps === undefined ? s.tpBps : patch.tpBps,
          slBps: patch.slBps === undefined ? s.slBps : patch.slBps,
        };
        this.subscriptions[i] = next;
        return next;
      }
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setKillSwitch(userId: string, killSwitch: boolean): Promise<void> {
    const u = this.users.get(userId);
    if (!u) throw new Error(`unknown user ${userId}`);
    this.users.set(userId, { ...u, killSwitch });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async revokeUser(userId: string): Promise<void> {
    const u = this.users.get(userId);
    if (!u) throw new Error(`unknown user ${userId}`);
    this.users.delete(userId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setCurrentFee(userId: string, tenthsBp: number): Promise<void> {
    const u = this.users.get(userId);
    if (!u) throw new Error(`unknown user ${userId}`);
    this.users.set(userId, { ...u, currentFeeTenthsBp: tenthsBp });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getNotifyPrefs(userId: string): Promise<NotifyPrefs> {
    return { ...(this.notifyPrefs.get(userId) ?? {}) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setNotifyPrefs(userId: string, patch: NotifyPrefs): Promise<NotifyPrefs> {
    const next: NotifyPrefs = { ...(this.notifyPrefs.get(userId) ?? {}), ...patch };
    this.notifyPrefs.set(userId, next);
    return { ...next };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(entry);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getOrMintReferralCode(userId: string): Promise<string> {
    const existing = this.referralCodes.get(userId);
    if (existing) return existing;
    // Deterministic enough for tests: short slug from the userId hash.
    let h = 5381;
    for (let i = 0; i < userId.length; i++) h = ((h << 5) + h + userId.charCodeAt(i)) | 0;
    const code = `r${(h >>> 0).toString(36)}`.slice(0, 10);
    this.referralCodes.set(userId, code);
    return code;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findReferrerByCode(code: string): Promise<{ readonly userId: string } | null> {
    const c = code.toLowerCase();
    for (const [userId, ownerCode] of this.referralCodes.entries()) {
      if (ownerCode === c) return { userId };
    }
    return null;
  }

  async recordReferralAttribution(
    referredUserId: string,
    code: string,
  ): Promise<{
    readonly kind: 'attributed' | 'already_attributed';
    readonly referrerUserId: string;
  }> {
    const c = code.toLowerCase();
    const referrer = await this.findReferrerByCode(c);
    if (!referrer) throw new Error(`unknown referral code ${c}`);
    const existing = this.attribution.get(referredUserId);
    if (existing !== undefined) {
      const owner = await this.findReferrerByCode(existing);
      return { kind: 'already_attributed', referrerUserId: owner?.userId ?? referrer.userId };
    }
    this.attribution.set(referredUserId, c);
    return { kind: 'attributed', referrerUserId: referrer.userId };
  }

  seedFill(userId: string, fill: PnlFill): void {
    const list = this.fillsByUser.get(userId) ?? [];
    list.push(fill);
    this.fillsByUser.set(userId, list);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listFillsForUser(userId: string, limit: number): Promise<readonly PnlFill[]> {
    const list = this.fillsByUser.get(userId) ?? [];
    return [...list].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  seedLeaderboard(entries: readonly LeaderboardEntry[]): void {
    this.leaderboard.length = 0;
    this.leaderboard.push(...entries);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listLeaderboard(limit: number): Promise<readonly LeaderboardEntry[]> {
    return this.leaderboard.slice(0, limit);
  }
}
