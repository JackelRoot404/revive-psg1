ALTER TABLE "compatibility_reports" ADD COLUMN "report_token_digest" varchar(64);--> statement-breakpoint
UPDATE "compatibility_reports" SET "report_token_digest" = repeat('0', 64) WHERE "report_token_digest" IS NULL;--> statement-breakpoint
ALTER TABLE "compatibility_reports" ALTER COLUMN "report_token_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "compatibility_reports" ADD COLUMN "status" varchar(24) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "compatibility_reports" ADD COLUMN "matched_profile_id" varchar(120);--> statement-breakpoint
ALTER TABLE "compatibility_reports" ADD COLUMN "reviewed_at" timestamp with time zone;
