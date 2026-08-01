ALTER TABLE "installation_journal_entries" ADD COLUMN "sequence" integer;
--> statement-breakpoint
WITH ordered AS (
  SELECT "id", row_number() OVER (PARTITION BY "license_id" ORDER BY "created_at", "id")::integer AS "sequence"
  FROM "installation_journal_entries"
)
UPDATE "installation_journal_entries" AS entries
SET "sequence" = ordered."sequence"
FROM ordered
WHERE entries."id" = ordered."id" AND entries."sequence" IS NULL;
--> statement-breakpoint
ALTER TABLE "installation_journal_entries" ALTER COLUMN "sequence" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "installation_journal_entries_license_sequence_uq" ON "installation_journal_entries" USING btree ("license_id", "sequence");
