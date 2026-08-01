ALTER TABLE "licenses" ADD COLUMN "installation_profile_id" varchar(120);
--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "installation_release_version" varchar(64);
--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "installation_artifact_hashes" jsonb;
--> statement-breakpoint
CREATE TABLE "installation_journal_entries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "license_id" uuid NOT NULL,
  "device_id" varchar(64) NOT NULL,
  "profile_id" varchar(120) NOT NULL,
  "release_version" varchar(64) NOT NULL,
  "artifact_hashes" jsonb NOT NULL,
  "stage" varchar(64) NOT NULL,
  "operation" varchar(64) NOT NULL,
  "operation_state" varchar(16) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "installation_journal_entries_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "installation_journal_entries_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "installation_journal_entries_license_time_idx" ON "installation_journal_entries" USING btree ("license_id", "created_at");
--> statement-breakpoint
CREATE INDEX "installation_journal_entries_device_time_idx" ON "installation_journal_entries" USING btree ("device_id", "created_at");
