CREATE TABLE "browser_pairing_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"message" text NOT NULL,
	"nonce" varchar(96) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_slot" bigint;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_block_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "browser_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_pairing_challenges" ADD CONSTRAINT "browser_pairing_challenges_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_pairing_challenges_nonce_uq" ON "browser_pairing_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "browser_pairing_challenges_session_idx" ON "browser_pairing_challenges" USING btree ("session_id");--> statement-breakpoint
WITH ranked AS (
	SELECT "id", row_number() OVER (PARTITION BY "device_id" ORDER BY "created_at" DESC, "id" DESC) AS position
	FROM "orders"
	WHERE "status" IN ('awaiting_payment', 'awaiting_promo')
)
UPDATE "orders" SET "status" = 'expired'
WHERE "id" IN (SELECT "id" FROM ranked WHERE position > 1);--> statement-breakpoint
CREATE UNIQUE INDEX "orders_open_device_uq" ON "orders" USING btree ("device_id") WHERE "orders"."status" in ('awaiting_payment', 'awaiting_promo');--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_license_uq" ON "refunds" USING btree ("license_id");
