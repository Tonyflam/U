CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"before_json" jsonb,
	"after_json" jsonb,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hl_fill_id" text NOT NULL,
	"wallet" text NOT NULL,
	"coin" text NOT NULL,
	"side" text NOT NULL,
	"px" numeric(38, 8) NOT NULL,
	"sz" numeric(38, 8) NOT NULL,
	"notional_usd" numeric(18, 2) NOT NULL,
	"is_mirror" boolean NOT NULL,
	"mirror_of_id" uuid,
	"user_id" uuid,
	"builder_fee_tenths_bp" integer,
	"builder_fee_usd" numeric(18, 6),
	"ts" timestamp with time zone NOT NULL,
	CONSTRAINT "fills_hl_fill_id_unique" UNIQUE("hl_fill_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kill_switches_global" (
	"id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"reason" text,
	"set_by" text,
	"set_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referrals" (
	"code" text PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referrals_attribution" (
	"referred_user_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"whale_id" uuid NOT NULL,
	"max_size_usd" numeric(18, 2) NOT NULL,
	"max_leverage" integer NOT NULL,
	"allowed_coins" text[],
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tg_user_id" bigint NOT NULL,
	"tg_username" text,
	"main_wallet" text NOT NULL,
	"agent_address" text NOT NULL,
	"agent_key_ct" "bytea" NOT NULL,
	"agent_key_iv" "bytea" NOT NULL,
	"agent_key_tag" "bytea" NOT NULL,
	"agent_dek_ct" "bytea" NOT NULL,
	"approved_max_fee_tenths_bp" integer NOT NULL,
	"current_fee_tenths_bp" integer DEFAULT 30 NOT NULL,
	"equity_floor_usd" numeric(18, 2) DEFAULT '0' NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"geofence_country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "users_tg_user_id_unique" UNIQUE("tg_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"alias" text,
	"is_featured" boolean DEFAULT false NOT NULL,
	"added_by" uuid,
	"last_fill_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whales_address_unique" UNIQUE("address")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fills" ADD CONSTRAINT "fills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fills" ADD CONSTRAINT "fills_mirror_of_self_fk" FOREIGN KEY ("mirror_of_id") REFERENCES "public"."fills"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referrals" ADD CONSTRAINT "referrals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referrals_attribution" ADD CONSTRAINT "referrals_attribution_referred_user_id_users_id_fk" FOREIGN KEY ("referred_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referrals_attribution" ADD CONSTRAINT "referrals_attribution_code_referrals_code_fk" FOREIGN KEY ("code") REFERENCES "public"."referrals"("code") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_whale_id_whales_id_fk" FOREIGN KEY ("whale_id") REFERENCES "public"."whales"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "whales" ADD CONSTRAINT "whales_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_ts_idx" ON "audit_log" USING btree ("actor","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fills_wallet_ts_idx" ON "fills" USING btree ("wallet","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fills_user_ts_idx" ON "fills" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fills_mirror_of_idx" ON "fills" USING btree ("mirror_of_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_user_whale_unique" ON "subscriptions" USING btree ("user_id","whale_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_whale_paused_idx" ON "subscriptions" USING btree ("whale_id","paused");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_tg_user_idx" ON "users" USING btree ("tg_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_main_wallet_idx" ON "users" USING btree ("main_wallet");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whales_address_idx" ON "whales" USING btree ("address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whales_featured_last_fill_idx" ON "whales" USING btree ("is_featured","last_fill_at");