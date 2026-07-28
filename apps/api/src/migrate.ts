import { sql } from "drizzle-orm";
import { loadConfig } from "./config";
import { createDatabase } from "./db/client";

// DigitalOcean's managed database role may alter application tables but cannot
// issue CREATE SCHEMA (even with IF NOT EXISTS). Drizzle's PostgreSQL migrator
// always creates its bookkeeping schema, so run this beta-only delta directly
// and idempotently instead. The pre-beta baseline is applied separately during
// initial provisioning; fail closed if that baseline is absent.
const { db, client } = createDatabase(loadConfig());
try {
  const [baseline] = await db.execute<{ exists: boolean }>(sql`
    SELECT to_regclass('public.beta_invites') IS NOT NULL AS "exists"
  `);
  if (!baseline?.exists) throw new Error("Database baseline is missing the beta_invites table");

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
  process.stdout.write("Beta database migrations complete\n");
} finally {
  await client.end({ timeout: 5 });
}
