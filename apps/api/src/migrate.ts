import { sql } from "drizzle-orm";
import { loadConfig } from "./config";
import { createDatabase } from "./db/client";

// DigitalOcean's managed database role may alter application tables but cannot
// issue CREATE SCHEMA (even with IF NOT EXISTS). Drizzle's PostgreSQL migrator
// always creates its bookkeeping schema, so apply the post-baseline deltas
// directly and idempotently instead. The baseline is provisioned separately;
// fail closed if it is absent.
const config = loadConfig();
const migrationConfig = config.migrationDatabaseUrl
  ? { ...config, databaseUrl: config.migrationDatabaseUrl }
  : config;
const { db, client } = createDatabase(migrationConfig);
try {
  const [baseline] = await db.execute<{ exists: boolean }>(sql`
    SELECT to_regclass('public.beta_invites') IS NOT NULL AS "exists"
  `);
  if (!baseline?.exists) throw new Error("Database baseline is missing the beta_invites table");

  const [kindColumn] = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'beta_invites'
        AND column_name = 'kind'
    ) AS "exists"
  `);
  if (!kindColumn?.exists) {

    // 0009_discord_browser_beta.sql
    await db.execute(sql`ALTER TABLE "beta_invites" ALTER COLUMN "device_id" DROP NOT NULL`);
    await db.execute(sql`DROP INDEX IF EXISTS "beta_invites_device_uq"`);
    await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "beta_invites_device_uq"
    ON "beta_invites" USING btree ("device_id")
    WHERE "device_id" IS NOT NULL
  `);

    // 0010_hardware_pilot_invite.sql
    await db.execute(sql`
    ALTER TABLE "beta_invites"
    ADD COLUMN IF NOT EXISTS "kind" varchar(32) DEFAULT 'cohort' NOT NULL
  `);
    await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'beta_invites_kind_check'
          AND conrelid = 'public.beta_invites'::regclass
      ) THEN
        ALTER TABLE "beta_invites"
        ADD CONSTRAINT "beta_invites_kind_check"
        CHECK ("kind" IN ('cohort', 'hardware_pilot'));
      END IF;
    END $$
  `);
    await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "beta_invites_hardware_pilot_once_uq"
    ON "beta_invites" USING btree ("kind")
    WHERE "kind" = 'hardware_pilot'
  `);
  }

  const [journalTable] = await db.execute<{ exists: boolean }>(sql`
    SELECT to_regclass('public.installation_journal_entries') IS NOT NULL AS "exists"
  `);
  if (!journalTable?.exists) {
    // 0011_public_installer_journal.sql. Bind the destructive boundary to one
    // exact signed release, then retain append-only intent/sent/verified
    // records so a kill switch can still permit safe, exact resumption.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "installation_journal_entries" (
        "id" uuid PRIMARY KEY NOT NULL,
        "license_id" uuid NOT NULL REFERENCES "licenses"("id") ON DELETE CASCADE,
        "sequence" integer NOT NULL,
        "device_id" varchar(64) NOT NULL REFERENCES "devices"("id"),
        "profile_id" varchar(120) NOT NULL,
        "release_version" varchar(64) NOT NULL,
        "artifact_hashes" jsonb NOT NULL,
        "stage" varchar(64) NOT NULL,
        "operation" varchar(64) NOT NULL,
        "operation_state" varchar(16) NOT NULL,
        "operation_index" integer DEFAULT 0 NOT NULL,
        "operation_count" integer DEFAULT 1 NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "installation_journal_entries_license_time_idx"
      ON "installation_journal_entries" USING btree ("license_id", "created_at")
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "installation_journal_entries_device_time_idx"
      ON "installation_journal_entries" USING btree ("device_id", "created_at")
    `);
  }
  // Keep all destructive-boundary columns idempotent even if a deployment
  // received an earlier table-only migration. A missing binding field must
  // fail closed at runtime, never silently weaken exact-resume selection.
  await db.execute(sql`ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "installation_profile_id" varchar(120)`);
  await db.execute(sql`ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "installation_profile_document" jsonb`);
  await db.execute(sql`ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "installation_profile_signature" text`);
  await db.execute(sql`ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "installation_release_id" uuid`);
  await db.execute(sql`ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "installation_release_version" varchar(64)`);
  await db.execute(sql`ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "installation_manifest_sha256" varchar(64)`);
  await db.execute(sql`ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "installation_artifact_hashes" jsonb`);
  // 0017_durable_fastboot_resume.sql. A browser-local opaque credential can
  // restore only an existing exact installation binding after a tab crash in
  // Fastboot; it cannot activate a fresh device.
  await db.execute(sql`ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "installation_resume_credential_digest" varchar(64)`);
  await db.execute(sql`ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "installation_resume_credential_expires_at" timestamp with time zone`);
  // 0012_installation_journal_segments.sql. Existing journal rows become the
  // default single-command checkpoint; only exact system sparse transfers use
  // an index greater than zero.
  await db.execute(sql`
    ALTER TABLE "installation_journal_entries"
    ADD COLUMN IF NOT EXISTS "operation_index" integer DEFAULT 0 NOT NULL
  `);
  await db.execute(sql`
    ALTER TABLE "installation_journal_entries"
    ADD COLUMN IF NOT EXISTS "operation_count" integer DEFAULT 1 NOT NULL
  `);
  // 0015_serialize_installation_journal.sql. Legacy append-only rows are
  // backfilled once; all new rows receive a lock-protected monotonic sequence
  // so two tabs cannot validate and append divergent successors.
  await db.execute(sql`ALTER TABLE "installation_journal_entries" ADD COLUMN IF NOT EXISTS "sequence" integer`);
  await db.execute(sql`
    WITH ordered AS (
      SELECT "id", row_number() OVER (PARTITION BY "license_id" ORDER BY "created_at", "id")::integer AS "sequence"
      FROM "installation_journal_entries"
      WHERE "sequence" IS NULL
    )
    UPDATE "installation_journal_entries" AS entries
    SET "sequence" = ordered."sequence"
    FROM ordered
    WHERE entries."id" = ordered."id"
  `);
  await db.execute(sql`ALTER TABLE "installation_journal_entries" ALTER COLUMN "sequence" SET NOT NULL`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "installation_journal_entries_license_sequence_uq"
    ON "installation_journal_entries" USING btree ("license_id", "sequence")
  `);
  // 0013_retain_started_release.sql. Publishing a replacement may close the
  // old release to new starts, but it must not strand a device already bound
  // to that exact signed artifact set.
  await db.execute(sql`
    ALTER TABLE "releases"
    ADD COLUMN IF NOT EXISTS "resume_available" boolean DEFAULT true NOT NULL
  `);
  process.stdout.write(journalTable?.exists
    ? "Application database migrations already complete\n"
    : "Public installer journal migration complete\n");
} finally {
  await client.end({ timeout: 5 });
}
