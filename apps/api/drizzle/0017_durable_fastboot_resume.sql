ALTER TABLE "licenses" ADD COLUMN "installation_resume_credential_digest" varchar(64);
--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "installation_resume_credential_expires_at" timestamp with time zone;
