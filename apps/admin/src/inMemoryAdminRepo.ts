/**
 * In-memory `AdminRepo` for tests + local dev.
 */
import type { z } from 'zod';
import type { Address } from '@whalepod/schema';
import type { AdminRepo, AdminStats, AdminUser, AdminWhale } from './admin.js';

type AddressValue = z.infer<typeof Address>;

export interface AdminAuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export class InMemoryAdminRepo implements AdminRepo {
  readonly whales = new Map<AddressValue, AdminWhale>();
  readonly users = new Map<string, AdminUser>();
  readonly audit: AdminAuditEntry[] = [];
  private globalKill = false;
  stats: AdminStats = {
    userCount: 0,
    activeSubscriptionCount: 0,
    curatedWhaleCount: 0,
    globalKill: false,
    fills24h: 0,
    builderFeesUsd24h: 0,
  };

  seedUser(user: AdminUser): void {
    this.users.set(user.id, user);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listCuratedWhales(): Promise<readonly AdminWhale[]> {
    return [...this.whales.values()];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async upsertCuratedWhale(address: AddressValue, alias: string | null): Promise<AdminWhale> {
    const existing = this.whales.get(address);
    const next: AdminWhale = {
      address,
      alias,
      subscriberCount: existing?.subscriberCount ?? 0,
    };
    this.whales.set(address, next);
    return next;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async removeCuratedWhale(address: AddressValue): Promise<boolean> {
    return this.whales.delete(address);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getUserById(userId: string): Promise<AdminUser | null> {
    return this.users.get(userId) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setUserPaused(userId: string, paused: boolean): Promise<boolean> {
    const u = this.users.get(userId);
    if (!u) return false;
    this.users.set(userId, { ...u, paused });
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setUserRevoked(userId: string, revoked: boolean): Promise<boolean> {
    const u = this.users.get(userId);
    if (!u) return false;
    this.users.set(userId, { ...u, revoked });
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getGlobalKill(): Promise<boolean> {
    return this.globalKill;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setGlobalKill(killSwitch: boolean): Promise<void> {
    this.globalKill = killSwitch;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async appendAudit(entry: AdminAuditEntry): Promise<void> {
    this.audit.push(entry);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getStats(): Promise<AdminStats> {
    return { ...this.stats, globalKill: this.globalKill };
  }
}
