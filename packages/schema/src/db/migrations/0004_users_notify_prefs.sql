-- 0004: per-user notification preferences.
-- `notify_muted`  : when TRUE the notify consumer skips delivering mirror-fill
--                   pushes for this user (still acks the stream entry).
-- `notify_compact`: when TRUE the renderer emits a single-line summary instead
--                   of the multi-line default.
-- Both default FALSE so existing users continue to receive the full notification.

ALTER TABLE "users"
  ADD COLUMN "notify_muted" boolean NOT NULL DEFAULT false,
  ADD COLUMN "notify_compact" boolean NOT NULL DEFAULT false;
