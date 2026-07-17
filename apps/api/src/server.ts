import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDatabase } from "./db/client";

const config = loadConfig();
const { db, client } = createDatabase(config);
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  await client.end();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: "0.0.0.0", port: config.port });
