import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config";
import * as schema from "./schema";

export function createDatabase(config: Config) {
  const ca = config.databaseCaPem ?? (config.databaseCaPath ? readFileSync(config.databaseCaPath, "utf8") : undefined);
  const ssl = ca ? { ca, rejectUnauthorized: true } : false;
  const client = postgres(config.databaseUrl, {
    max: 10,
    ssl,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10
  });
  return { db: drizzle(client, { schema }), client };
}

export type Database = ReturnType<typeof createDatabase>["db"];
