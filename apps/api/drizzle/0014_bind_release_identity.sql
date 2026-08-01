ALTER TABLE "licenses" ADD COLUMN "installation_release_id" uuid;
--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "installation_manifest_sha256" varchar(64);
