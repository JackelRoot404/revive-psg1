#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { sign } from "node:crypto";
import canonicalize from "canonicalize";

const [inputPath] = process.argv.slice(2);
if (!inputPath || !process.env.REVIVE_OFFLINE_SIGNING_KEY_PEM) {
  console.error("Usage: REVIVE_OFFLINE_SIGNING_KEY_PEM='...' node tools/sign-document.mjs <document.json>");
  process.exit(2);
}
const document = JSON.parse(readFileSync(inputPath, "utf8"));
const canonical = canonicalize(document);
if (!canonical) throw new Error("Document cannot be canonicalized");
const privateKey = process.env.REVIVE_OFFLINE_SIGNING_KEY_PEM.replaceAll("\\n", "\n");
process.stdout.write(JSON.stringify({ document, signature: sign(null, Buffer.from(canonical), privateKey).toString("base64") }, null, 2) + "\n");
