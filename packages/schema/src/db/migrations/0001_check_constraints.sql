-- Hand-written companion migration: CHECK constraints.
-- drizzle-kit 0.24.x does not yet emit Drizzle `check()` clauses into SQL.
-- Source of truth: docs/phase-2.md §4.1 and packages/schema/src/db/schema.ts.

ALTER TABLE "users"
  ADD CONSTRAINT "users_approved_max_fee_nonneg"
  CHECK ("approved_max_fee_tenths_bp" >= 0 AND "approved_max_fee_tenths_bp" <= 100);
--> statement-breakpoint

ALTER TABLE "users"
  ADD CONSTRAINT "users_current_fee_nonneg"
  CHECK ("current_fee_tenths_bp" >= 0 AND "current_fee_tenths_bp" <= "approved_max_fee_tenths_bp");
--> statement-breakpoint

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_leverage_range"
  CHECK ("max_leverage" BETWEEN 1 AND 50);
--> statement-breakpoint

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_max_size_positive"
  CHECK ("max_size_usd" > 0);
--> statement-breakpoint

ALTER TABLE "fills"
  ADD CONSTRAINT "fills_side_check"
  CHECK ("side" IN ('B','S'));
--> statement-breakpoint

ALTER TABLE "kill_switches_global"
  ADD CONSTRAINT "kill_switches_global_singleton"
  CHECK ("id" = 1);
