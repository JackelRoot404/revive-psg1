import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "./config";
import { createDatabase } from "./db/client";

// App Platform keeps the database secret attached to the API service. Run the
// same idempotent Drizzle migrations in that service before Fastify starts,
// rather than copying an encrypted secret to a separate deployment job.
const { db, client } = createDatabase(loadConfig());
try {
  await migrate(db, { migrationsFolder: "apps/api/drizzle" });
  process.stdout.write("Database migrations complete\n");
} finally {
  await client.end({ timeout: 5 });
}
