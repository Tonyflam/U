-- 0002: TP/SL offset columns on subscriptions.
-- Source of truth: packages/sdk/src/trigger.ts (TPSL_MIN_BPS=1, TPSL_MAX_BPS=9999).
-- Both columns are nullable: NULL means "no TP" or "no SL" (default).

ALTER TABLE "subscriptions"
  ADD COLUMN "tp_bps" integer;
--> statement-breakpoint

ALTER TABLE "subscriptions"
  ADD COLUMN "sl_bps" integer;
--> statement-breakpoint

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_tp_bps_range"
  CHECK ("tp_bps" IS NULL OR ("tp_bps" BETWEEN 1 AND 9999));
--> statement-breakpoint

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_sl_bps_range"
  CHECK ("sl_bps" IS NULL OR ("sl_bps" BETWEEN 1 AND 9999));
