ALTER TABLE "installation_journal_entries" ADD COLUMN "operation_index" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "installation_journal_entries" ADD COLUMN "operation_count" integer DEFAULT 1 NOT NULL;
