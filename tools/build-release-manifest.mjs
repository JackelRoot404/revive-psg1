#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const [configPath] = process.argv.slice(2);
if (!configPath) {
  console.error("Usage: node tools/build-release-manifest.mjs <release-input.json>");
  process.exit(2);
}

const input = JSON.parse(readFileSync(configPath, "utf8"));
const requiredStrings = ["version", "minimumInstallerVersion", "releaseNotes", "signingKeyId"];
for (const key of requiredStrings) {
  if (typeof input[key] !== "string" || input[key].trim() === "") throw new Error(`Missing ${key}`);
}
if (!Array.isArray(input.profileIds) || input.profileIds.length === 0) throw new Error("profileIds must not be empty");
if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) throw new Error("artifacts must not be empty");

const kinds = new Set(["system", "vbmeta", "apk", "recovery"]);
const privateComponents = new Set(["android_system", "verified_boot", "recovery", "aurora_store", "fdroid", "retroarch", "diagnostics", "stock_restore"]);
const ids = new Set();
const objectKeys = new Set();
const artifacts = [];
for (const source of input.artifacts) {
  if (!source || typeof source !== "object") throw new Error("Each artifact must be an object");
  if (typeof source.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(source.id)) throw new Error("Invalid artifact id");
  if (ids.has(source.id)) throw new Error(`Duplicate artifact id: ${source.id}`);
  if (!kinds.has(source.kind)) throw new Error(`Invalid artifact kind: ${source.kind}`);
  ids.add(source.id);
  if (source.delivery === "private") {
    if (!privateComponents.has(source.component)) throw new Error(`Invalid private component for ${source.id}`);
    if (typeof source.objectKey !== "string" || source.objectKey.startsWith("/") || source.objectKey.includes("..")) throw new Error(`Unsafe object key: ${source.objectKey}`);
    if (objectKeys.has(source.objectKey)) throw new Error(`Duplicate object key: ${source.objectKey}`);
    const { path, stat } = requireRegularFile(source.path, source.id);
    objectKeys.add(source.objectKey);
    artifacts.push({
      id: source.id, kind: source.kind, delivery: "private", component: source.component,
      objectKey: source.objectKey, size: stat.size, sha256: await sha256File(path),
      ...(source.signerSha256 ? { signerSha256: requireSha256(source.signerSha256, `${source.id}.signerSha256`) } : {})
    });
  } else if (source.delivery === "customer_supplied") {
    if (source.kind !== "system" || source.component !== "google_mobile_services") throw new Error(`Customer artifact ${source.id} must be the approved Play-enabled system image`);
    if ("objectKey" in source) throw new Error(`Customer artifact ${source.id} must not have an object key`);
    const extracted = requireRegularFile(source.path, `${source.id} extracted image`);
    const archive = requireRegularFile(source.archivePath, `${source.id} source archive`);
    const metadata = source.source;
    if (!metadata || typeof metadata !== "object") throw new Error(`Missing signed source instructions for ${source.id}`);
    if (typeof metadata.label !== "string" || metadata.label.trim() === "") throw new Error(`Missing source label for ${source.id}`);
    if (typeof metadata.instructionsUrl !== "string" || new URL(metadata.instructionsUrl).protocol !== "https:") throw new Error(`Instructions URL must use HTTPS for ${source.id}`);
    if (!Array.isArray(metadata.archiveFilenamePatterns) || metadata.archiveFilenamePatterns.length < 1 || metadata.archiveFilenamePatterns.length > 10) throw new Error(`Invalid archive filename patterns for ${source.id}`);
    if (typeof metadata.extractedPath !== "string" || metadata.extractedPath.startsWith("/") || metadata.extractedPath.split("/").includes("..")) throw new Error(`Unsafe extracted path for ${source.id}`);
    artifacts.push({
      id: source.id, kind: "system", delivery: "customer_supplied", component: "google_mobile_services",
      size: extracted.stat.size, sha256: await sha256File(extracted.path),
      source: {
        label: metadata.label, instructionsUrl: metadata.instructionsUrl,
        archiveFilenamePatterns: metadata.archiveFilenamePatterns,
        archiveSize: archive.stat.size, archiveSha256: await sha256File(archive.path),
        extractedPath: metadata.extractedPath
      }
    });
  } else {
    throw new Error(`Artifact ${source.id} must declare delivery as private or customer_supplied`);
  }
}

const releaseId = input.releaseId ?? randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(releaseId)) throw new Error("releaseId must be a UUID");
const publishedAt = input.publishedAt ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("publishedAt must be an ISO date-time");

const manifest = {
  releaseId,
  channel: "stable",
  version: input.version,
  minimumInstallerVersion: input.minimumInstallerVersion,
  profileIds: [...new Set(input.profileIds)].sort(),
  artifacts: artifacts.sort((a, b) => a.id.localeCompare(b.id)),
  releaseNotes: input.releaseNotes,
  publishedAt,
  signingKeyId: input.signingKeyId
};

process.stderr.write(`Built unsigned manifest ${manifest.version} with ${artifacts.length} artifact(s) from ${basename(configPath)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function requireRegularFile(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing path for ${label}`);
  const path = resolve(value);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artifact must be a regular non-symlink file: ${path}`);
  if (stat.size <= 0) throw new Error(`Artifact is empty: ${path}`);
  return { path, stat };
}

function requireSha256(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be lowercase SHA-256`);
  return value;
}
