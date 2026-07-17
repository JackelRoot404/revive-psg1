CREATE TYPE "public"."host_os" AS ENUM('windows', 'macos');--> statement-breakpoint
CREATE TYPE "public"."license_status" AS ENUM('active', 'refund_pending', 'refunded', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."order_kind" AS ENUM('paid', 'promo');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('awaiting_payment', 'awaiting_promo', 'paid', 'promo_redeemed', 'refunded', 'expired');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"actor_hash" varchar(64),
	"subject_id" varchar(120),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compatibility_profiles" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"signed_document" jsonb NOT NULL,
	"signature" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compatibility_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"profile_candidate" jsonb NOT NULL,
	"consent_to_notify" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crash_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"install_id" uuid NOT NULL,
	"app_version" varchar(32) NOT NULL,
	"host_os" "host_os" NOT NULL,
	"architecture" varchar(32) NOT NULL,
	"stage" varchar(64) NOT NULL,
	"error_code" varchar(64) NOT NULL,
	"stack" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"profile_id" varchar(120),
	"serial_verified" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"licensed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"order_id" uuid NOT NULL,
	"receipt_wallet" varchar(44) NOT NULL,
	"status" "license_status" DEFAULT 'active' NOT NULL,
	"token_digest" varchar(64),
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modification_started_at" timestamp with time zone,
	"refunded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"kind" "order_kind" NOT NULL,
	"status" "order_status" NOT NULL,
	"reference" varchar(44) NOT NULL,
	"amount_base_units" bigint NOT NULL,
	"mint" varchar(44) NOT NULL,
	"treasury" varchar(44) NOT NULL,
	"promo_code_hash" varchar(64),
	"transaction_signature" varchar(128),
	"paid_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"code_hash" varchar(64) PRIMARY KEY NOT NULL,
	"label" varchar(64) NOT NULL,
	"max_redemptions" integer NOT NULL,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_redemptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"order_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"license_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"verified_incompatibility" boolean DEFAULT false NOT NULL,
	"status" varchar(24) DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" varchar(64) NOT NULL,
	"channel" varchar(20) DEFAULT 'stable' NOT NULL,
	"signed_manifest" jsonb NOT NULL,
	"signature" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"pairing_public_key" varchar(64) NOT NULL,
	"app_version" varchar(32) NOT NULL,
	"host_os" "host_os" NOT NULL,
	"compatibility" jsonb NOT NULL,
	"profile_id" varchar(120),
	"supported" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"message" text NOT NULL,
	"nonce" varchar(96) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compatibility_reports" ADD CONSTRAINT "compatibility_reports_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_code_hash_promo_codes_code_hash_fk" FOREIGN KEY ("code_hash") REFERENCES "public"."promo_codes"("code_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_challenges" ADD CONSTRAINT "wallet_challenges_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_type_time_idx" ON "audit_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "crash_reports_error_idx" ON "crash_reports" USING btree ("error_code","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "licenses_device_uq" ON "licenses" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "licenses_order_uq" ON "licenses" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_reference_uq" ON "orders" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_transaction_signature_uq" ON "orders" USING btree ("transaction_signature");--> statement-breakpoint
CREATE INDEX "orders_device_idx" ON "orders" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "orders_wallet_idx" ON "orders" USING btree ("wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_redemptions_order_uq" ON "promo_redemptions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_redemptions_device_uq" ON "promo_redemptions" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_version_channel_uq" ON "releases" USING btree ("version","channel");--> statement-breakpoint
CREATE INDEX "sessions_device_idx" ON "sessions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_challenges_nonce_uq" ON "wallet_challenges" USING btree ("nonce");