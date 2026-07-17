ALTER TABLE "browser_pairing_challenges" ADD COLUMN "browser_nonce_hash" varchar(64);--> statement-breakpoint
UPDATE "browser_pairing_challenges" SET "browser_nonce_hash" = repeat('0', 64) WHERE "browser_nonce_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "browser_pairing_challenges" ALTER COLUMN "browser_nonce_hash" SET NOT NULL;
