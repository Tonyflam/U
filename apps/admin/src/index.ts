/**
 * @whalepod/admin — operator-only admin surface.
 *
 * Pure handlers + in-memory repo. The grammy/HTTP composition root lands
 * in U16. Audit invariants are tested in admin.test.ts.
 */
export {
  handleAdminCommand,
  parseAdminCommand,
  type AdminCommand,
  type AdminCtx,
  type AdminReply,
  type AdminRepo,
  type AdminUser,
  type AdminWhale,
} from './admin.js';
export { InMemoryAdminRepo, type AdminAuditEntry } from './inMemoryAdminRepo.js';
export { DrizzleAdminRepo } from './drizzleAdminRepo.js';
