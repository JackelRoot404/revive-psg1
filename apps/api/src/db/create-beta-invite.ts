import { randomUUID } from "node:crypto";
import { BETA_INVITE_PREFIX, deviceIdSchema } from "@revive-psg1/contracts";
import { eq, sql } from "drizzle-orm";
import { loadConfig } from "../config";
import { randomNonce, sha256 } from "../security";
import { createDatabase } from "./client";
import { betaInvites } from "./schema";

const deviceId = deviceIdSchema.parse(process.env.BETA_DEVICE_ID);
const expiresAt = new Date(process.env.BETA_INVITE_EXPIRES_AT ?? Date.now() + 14 * 24 * 60 * 60_000);
if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new Error("BETA_INVITE_EXPIRES_AT must be a future ISO timestamp");

const token = `${BETA_INVITE_PREFIX}${randomNonce()}`;
const { db, client } = createDatabase(loadConfig());
try {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${deviceId}, 0))`);
    const [existing] = await tx.select().from(betaInvites).where(eq(betaInvites.deviceId, deviceId)).limit(1);
    if (existing?.redeemedAt) throw new Error("This device already redeemed its beta invite");
    if (existing) {
      await tx.update(betaInvites).set({
        tokenDigest: sha256(token), enabled: true, expiresAt,
        label: process.env.BETA_INVITE_LABEL?.slice(0, 120)
      }).where(eq(betaInvites.id, existing.id));
    } else {
      await tx.insert(betaInvites).values({
        id: randomUUID(), tokenDigest: sha256(token), deviceId,
        label: process.env.BETA_INVITE_LABEL?.slice(0, 120), expiresAt
      });
    }
  });
  process.stdout.write(`Beta invite created for device ${deviceId.slice(0, 12)}…\n`);
  process.stdout.write(`Expires: ${expiresAt.toISOString()}\n`);
  process.stdout.write(`Invite (shown once): ${token}\n`);
} finally {
  await client.end();
}
