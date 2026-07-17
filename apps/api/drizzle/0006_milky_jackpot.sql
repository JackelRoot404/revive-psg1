CREATE TABLE "beta_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"label" varchar(120),
	"enabled" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" RENAME COLUMN "promo_code_hash" TO "beta_invite_token_digest";--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "recovery_credential_digest" varchar(64);--> statement-breakpoint
ALTER TABLE "beta_invites" ADD CONSTRAINT "beta_invites_redeemed_order_id_orders_id_fk" FOREIGN KEY ("redeemed_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "beta_invites_token_uq" ON "beta_invites" USING btree ("token_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "beta_invites_device_uq" ON "beta_invites" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "beta_invites_order_uq" ON "beta_invites" USING btree ("redeemed_order_id");