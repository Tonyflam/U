-- 0003: realized P&L on fills (USD, 6dp).
-- Populated by the order router when a closing fill resolves a position; left
-- NULL for opening fills or when realized P&L is unknown. /pnl renders this
-- as the realized component and adds unrealized = (mark - entry) * sz.

ALTER TABLE "fills"
  ADD COLUMN "realized_pnl_usd" numeric(18, 6);
