#!/usr/bin/env node
import { readFileSync } from "node:fs";
import postgres from "postgres";

const [inputPath] = process.argv.slice(2);
if (!inputPath || !process.env.DATABASE_URL) {
  console.error("Usage: DATABASE_URL='postgresql://…' node tools/insert-compatibility-profile.mjs <signed-profile.json>");
  process.exit(2);
}

const envelope = JSON.parse(readFileSync(inputPath, "utf8"));
const document = envelope.document;
const signature = envelope.signature;
if (!document?.id || typeof document.version !== "number" || !signature) {
  throw new Error("Signed envelope must contain document.id, document.version, and signature");
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  await sql.begin(async (tx) => {
    await tx`
      update compatibility_profiles
      set active = false
      where id <> ${document.id}
    `;
    await tx`
      insert into compatibility_profiles (id, version, signed_document, signature, active)
      values (
        ${document.id},
        ${document.version},
        ${tx.json(document)},
        ${signature},
        true
      )
      on conflict (id) do update set
        version = excluded.version,
        signed_document = excluded.signed_document,
        signature = excluded.signature,
        active = true
    `;
  });
  console.log(`Upserted active compatibility profile ${document.id} v${document.version}`);
} finally {
  await sql.end({ timeout: 5 });
}
