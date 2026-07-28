import { randomUUID } from "node:crypto";
import { BETA_INVITE_PREFIX } from "@revive-psg1/contracts";
import { loadConfig } from "../config";
import { randomNonce, sha256 } from "../security";
import { createDatabase } from "./client";
import { betaInvites } from "./schema";

const expiresAt = new Date(process.env.BETA_INVITE_EXPIRES_AT ?? Date.now() + 14 * 24 * 60 * 60_000);
if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new Error("BETA_INVITE_EXPIRES_AT must be a future ISO timestamp");

const token = `${BETA_INVITE_PREFIX}${randomNonce()}`;
const { db, client } = createDatabase(loadConfig());
try {
  await db.transaction(async (tx) => {
    await tx.insert(betaInvites).values({
      id: randomUUID(), tokenDigest: sha256(token),
      label: process.env.BETA_INVITE_LABEL?.slice(0, 120), expiresAt
    });
  });
  process.stdout.write("Unbound Discord beta invite created\n");
  process.stdout.write(`Expires: ${expiresAt.toISOString()}\n`);
  process.stdout.write(`Invite (shown once): ${token}\n`);
} finally {
  await client.end();
}
