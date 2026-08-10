#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { verify } from "node:crypto";
import postgres from "postgres";
import canonicalize from "canonicalize";

const [inputPath] = process.argv.slice(2);
if (!inputPath || !process.env.DATABASE_URL || !process.env.RELEASE_PUBLIC_KEY_PEM) {
  console.error("Usage: DATABASE_URL='postgresql://…' RELEASE_PUBLIC_KEY_PEM='…' node tools/insert-release-manifest.mjs <signed-release.json>");
  process.exit(2);
}

const envelope = JSON.parse(readFileSync(inputPath, "utf8"));
const document = envelope.document;
const signature = envelope.signature;
if (!document?.releaseId || !document?.version || document.channel !== "stable" || !Array.isArray(document.profileIds)
  || document.profileIds.length === 0 || !document.flashPlan || !signature) {
  throw new Error("Signed release envelope must contain a stable releaseId, version, profileIds, flashPlan, and signature");
}
if (new Set(document.profileIds).size !== document.profileIds.length || document.profileIds.some((id) => typeof id !== "string" || !id)) {
  throw new Error("Release profileIds must be unique non-empty strings");
}
if (!Number.isFinite(Date.parse(document.publishedAt ?? ""))) throw new Error("Release publishedAt must be an ISO date-time");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(document.releaseId)) {
  throw new Error("Release releaseId must be a UUID");
}
const canonical = canonicalize(document);
if (!canonical || !verify(null, Buffer.from(canonical), process.env.RELEASE_PUBLIC_KEY_PEM, Buffer.from(signature, "base64"))) {
  throw new Error("Release manifest signature does not verify with RELEASE_PUBLIC_KEY_PEM");
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
let alreadyPresent = false;
try {
  await sql.begin(async (tx) => {
    // A version label is part of the immutable resume binding. Never permit
    // an operator to overwrite an existing version with a new signed
    // document: publish a new version instead. An exact re-run is harmless.
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${document.channel}:${document.version}`}, 0))`;
    const existing = await tx`
      select id, signed_manifest, signature
      from releases
      where version = ${document.version} and channel = ${document.channel}
      limit 1
    `;
    if (existing.length) {
      const current = existing[0];
      const sameDocument = canonicalize(current.signed_manifest) === canonicalize(document);
      if (current.id !== document.releaseId || current.signature !== signature || !sameDocument) {
        throw new Error(`Release ${document.channel}/${document.version} already exists and is immutable; publish a new version instead`);
      }
      alreadyPresent = true;
      return;
    }
    // A new release replaces only releases that serve at least one of the
    // same profiles. Disjoint profile releases remain active and are selected
    // server-side by their signed manifest profileIds.
    await tx`
      update releases
      set active = false,
          resume_available = true
      where channel = ${document.channel}
        and active = true
        and signed_manifest -> 'profileIds' ?| ${tx.array(document.profileIds)}
    `;
    await tx`
      insert into releases (id, version, channel, signed_manifest, signature, active, resume_available, published_at)
      values (
        ${document.releaseId},
        ${document.version},
        ${document.channel},
        ${tx.json(document)},
        ${signature},
        true,
        true,
        ${new Date(document.publishedAt)}
      )
    `;
  });
  console.log(alreadyPresent
    ? `Verified existing immutable ${document.channel} release ${document.version}`
    : `Inserted active immutable ${document.channel} release ${document.version} for ${document.profileIds.join(", ")}`);
} finally {
  await sql.end({ timeout: 5 });
}
