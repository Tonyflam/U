-- 0007: watches — zero-trust whale fill alerts (/watch in the bot).
-- A Telegram user can watch any whale WITHOUT connecting a wallet, so the
-- table keys on tg_user_id directly instead of users.id. Deleting a whale
-- cascades its watches. Unique (tg_user_id, whale_id) makes /watch idempotent.

CREATE TABLE "watches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tg_user_id" bigint NOT NULL,
  "whale_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "watches_whale_id_whales_id_fk" FOREIGN KEY ("whale_id") REFERENCES "whales"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX "watches_tg_whale_unique" ON "watches" ("tg_user_id", "whale_id");
CREATE INDEX "watches_whale_idx" ON "watches" ("whale_id");
CREATE INDEX "watches_tg_user_idx" ON "watches" ("tg_user_id");
