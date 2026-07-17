CREATE TYPE "public"."session_channel" AS ENUM('desktop', 'web');--> statement-breakpoint
CREATE TYPE "public"."wallet_challenge_purpose" AS ENUM('checkout', 'web_installer');--> statement-breakpoint
ALTER TYPE "public"."host_os" ADD VALUE 'web';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "channel" "session_channel" DEFAULT 'desktop' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_challenges" ADD COLUMN "purpose" "wallet_challenge_purpose" DEFAULT 'checkout' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_challenges" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "wallet_challenges" ADD COLUMN "license_id" uuid;