ALTER TABLE "licenses" ADD COLUMN "installation_profile_document" jsonb;
--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "installation_profile_signature" text;
