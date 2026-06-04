-- 0006: reconciliation marker on fills.
-- Set by FillReconciler when it has overwritten `px` + `realized_pnl_usd` +
-- `builder_fee_usd` with values pulled from Hyperliquid's `userFills` info
-- endpoint. NULL = the row still holds our locally-estimated values from
-- submitMirror time (which use the IOC limit px and a derived fee figure).
ALTER TABLE "fills" ADD COLUMN "reconciled_at" timestamp with time zone;
CREATE INDEX "fills_reconciled_at_idx" ON "fills" ("reconciled_at");
