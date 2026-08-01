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
const flashPlan = validateFlashPlan(input.flashPlan);

const kinds = new Set(["system", "vbmeta", "apk", "recovery"]);
const privateComponents = new Set(["android_system", "verified_boot", "recovery", "aurora_store", "fdroid", "retroarch", "diagnostics", "diagnostics_test", "stock_restore"]);
const ids = new Set();
const objectKeys = new Set();
const installerComponents = new Set(["android_system", "verified_boot", "diagnostics", "diagnostics_test", "aurora_store", "retroarch"]);
const seenInstallerComponents = new Set();
const artifacts = [];
for (const source of input.artifacts) {
  if (!source || typeof source !== "object") throw new Error("Each artifact must be an object");
  if (typeof source.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(source.id)) throw new Error("Invalid artifact id");
  if (ids.has(source.id)) throw new Error(`Duplicate artifact id: ${source.id}`);
  if (!kinds.has(source.kind)) throw new Error(`Invalid artifact kind: ${source.kind}`);
  ids.add(source.id);
  if (source.delivery === "private") {
    if (!privateComponents.has(source.component)) throw new Error(`Invalid private component for ${source.id}`);
    if (installerComponents.has(source.component) && seenInstallerComponents.has(source.component)) {
      throw new Error(`Duplicate installer artifact component: ${source.component}`);
    }
    if (installerComponents.has(source.component)) seenInstallerComponents.add(source.component);
    if (typeof source.objectKey !== "string" || source.objectKey.startsWith("/") || source.objectKey.includes("..")) throw new Error(`Unsafe object key: ${source.objectKey}`);
    if (objectKeys.has(source.objectKey)) throw new Error(`Duplicate object key: ${source.objectKey}`);
    const { path, stat } = requireRegularFile(source.path, source.id);
    objectKeys.add(source.objectKey);
    artifacts.push({
      id: source.id, kind: source.kind, delivery: "private", component: source.component,
      objectKey: source.objectKey, size: stat.size, sha256: await sha256File(path),
      ...(source.signerSha256 ? { signerSha256: requireSha256(source.signerSha256, `${source.id}.signerSha256`) } : {}),
      ...(source.packageName ? { packageName: requirePackageName(source.packageName, `${source.id}.packageName`) } : {}),
      ...(source.versionName ? { versionName: requireVersionName(source.versionName, `${source.id}.versionName`) } : {})
    });
    if (source.kind === "apk" && (!source.signerSha256 || !source.packageName || (source.component !== "diagnostics_test" && !source.versionName))) {
      throw new Error(`APK ${source.id} requires signerSha256, packageName, and${source.component === "diagnostics_test" ? "" : " versionName"}`);
    }
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

validateInstallerArtifactsAndCapacity(flashPlan, artifacts);

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
  signingKeyId: input.signingKeyId,
  flashPlan,
  ...releaseEvidence(input, artifacts)
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

function requirePackageName(value, field) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.]{2,150}$/.test(value)) throw new Error(`${field} must be an Android package name`);
  return value;
}

function requireVersionName(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 120) throw new Error(`${field} must be a non-empty version name`);
  return value.trim();
}

function requiresReleaseEvidence(artifacts) {
  return artifacts.some((artifact) => artifact.delivery === "private" && artifact.component === "android_system");
}

function releaseEvidence(input, artifacts) {
  if (!requiresReleaseEvidence(artifacts)) return {};
  const publicPath = input.publicEvidencePath;
  const betaPath = input.betaEvidencePath;
  if (publicPath && betaPath) throw new Error("Specify either publicEvidencePath or betaEvidencePath, not both");
  if (publicPath) return { publicEvidence: validatePublicEvidence(publicPath, artifacts) };
  if (betaPath) return { betaEvidence: validateBetaEvidence(betaPath, artifacts) };
  throw new Error("Private Android-system releases require publicEvidencePath or betaEvidencePath");
}

function validateBetaEvidence(path, artifacts) {
  if (typeof path !== "string" || path.trim() === "") throw new Error("Private Android-system releases require betaEvidencePath");
  const evidence = JSON.parse(readFileSync(resolve(path), "utf8"));
  const source = evidence?.source;
  const license = evidence?.licenseReview;
  const inspection = evidence?.noGmsInspection;
  const validation = evidence?.stockPsg1Validation;
  if (!source || !/^https:\/\//.test(source.releaseUrl ?? "") || !source.tag || !source.upstreamAssetName
    || !isSha(source.upstreamArchiveSha256) || !isSha(source.expandedSystemSha256)) throw new Error("beta evidence source provenance is incomplete");
  if (!license || license.status !== "approved" || !license.license || !license.reviewer || !validDate(license.reviewedAt) || !/^https:\/\//.test(license.evidenceUrl ?? "")) {
    throw new Error("beta evidence requires an approved, attributable license review");
  }
  if (!inspection || !inspection.tool || !validDate(inspection.inspectedAt) || !Array.isArray(inspection.checkedPaths) || inspection.checkedPaths.length < 3
    || !Array.isArray(inspection.detectedGmsPackages) || inspection.detectedGmsPackages.length !== 0
    || !Array.isArray(inspection.reviewedNonGmsGooglePackages) || !isSha(inspection.reportSha256)) {
    throw new Error("beta evidence requires a passed no-GMS inspection report");
  }
  const checks = ["chromeWindows", "edgeWindows", "chromeMacos", "edgeMacos", "controls", "wifi", "audio", "storage", "auroraStore", "retroArch", "diagnostics", "twoColdBoots"];
  const fullyValidated = validation?.status === "passed" && validDate(validation.validatedAt)
    && Number.isInteger(validation.stockUnitCount) && validation.stockUnitCount >= 1 && checks.every((key) => validation[key] === true);
  const hardwarePilot = validation?.status === "pilot_pending"
    && validDate(validation.plannedAt)
    && validation.maxEnrollments === 1
    && validation.discordSupervisionRequired === true
    && validation.acknowledgement === "No stock PSG1 is available to the operator; this single destructive enrollment is the hardware-validation pilot."
    && checks.every((key) => validation[key] === false);
  if (!fullyValidated && !hardwarePilot) {
    throw new Error("beta evidence requires complete stock-PSG1 validation or the explicit one-device hardware-pilot evidence");
  }
  if (!evidence.artifactSha256 || typeof evidence.artifactSha256 !== "object") throw new Error("beta evidence is missing artifact hashes");
  for (const artifact of artifacts) {
    if (evidence.artifactSha256[artifact.id] !== artifact.sha256) throw new Error(`beta evidence does not match artifact ${artifact.id}`);
  }
  return evidence;
}

function validatePublicEvidence(path, artifacts) {
  const evidence = JSON.parse(readFileSync(resolve(path), "utf8"));
  validateCommonEvidence(evidence, artifacts, "public release");
  const driver = evidence?.windowsFastbootDriver;
  if (!driver || !/^https:\/\//.test(driver.packageUrl ?? "") || !isSha(driver.installerSha256) || !isSha(driver.catalogSha256)
    || typeof driver.authenticodeSigner !== "string" || !driver.authenticodeSigner.trim()
    || !Array.isArray(driver.hardwareIds) || driver.hardwareIds.length < 1 || driver.hardwareIds.some((id) => !/^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}&MI_[0-9A-F]{2}$/.test(id))
    || typeof driver.interfaceGuid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(driver.interfaceGuid)
    || !Array.isArray(driver.testedWindowsVersions) || !["windows_10", "windows_11"].every((version) => driver.testedWindowsVersions.includes(version))) {
    throw new Error("public release evidence requires a signed exact PSG1 Windows Fastboot driver package");
  }
  const validation = evidence?.stockPsg1Validation;
  const checks = ["chromeWindows", "edgeWindows", "chromeMacos", "edgeMacos", "controls", "wifi", "audio", "storage", "auroraStore", "retroArch", "diagnostics", "twoColdBoots"];
  if (validation?.status !== "passed" || !validDate(validation.validatedAt)
    || !Number.isInteger(validation.stockUnitCount) || validation.stockUnitCount < 1
    || !checks.every((key) => validation[key] === true)) {
    throw new Error("public release evidence requires completed stock-PSG1 browser and hardware validation");
  }
  const review = evidence?.review;
  if (!review || review.status !== "approved" || !review.reviewer || !validDate(review.reviewedAt)
    || review.riskAcknowledgement !== "I approve public self-service PSG1 installation only for stock-locked devices using this signed flash plan.") {
    throw new Error("public release evidence requires an attributable approved risk review");
  }
  return evidence;
}

function validateCommonEvidence(evidence, artifacts, label) {
  const source = evidence?.source;
  const license = evidence?.licenseReview;
  const inspection = evidence?.noGmsInspection;
  if (!source || !/^https:\/\//.test(source.releaseUrl ?? "") || !source.tag || !source.upstreamAssetName
    || !isSha(source.upstreamArchiveSha256) || !isSha(source.expandedSystemSha256)) throw new Error(`${label} evidence source provenance is incomplete`);
  if (!license || license.status !== "approved" || !license.license || !license.reviewer || !validDate(license.reviewedAt) || !/^https:\/\//.test(license.evidenceUrl ?? "")) {
    throw new Error(`${label} evidence requires an approved, attributable license review`);
  }
  if (!inspection || !inspection.tool || !validDate(inspection.inspectedAt) || !Array.isArray(inspection.checkedPaths) || inspection.checkedPaths.length < 3
    || !Array.isArray(inspection.detectedGmsPackages) || inspection.detectedGmsPackages.length !== 0
    || !Array.isArray(inspection.reviewedNonGmsGooglePackages) || !isSha(inspection.reportSha256)) {
    throw new Error(`${label} evidence requires a passed no-GMS inspection report`);
  }
  if (!evidence.artifactSha256 || typeof evidence.artifactSha256 !== "object") throw new Error(`${label} evidence is missing artifact hashes`);
  for (const artifact of artifacts) {
    if (evidence.artifactSha256[artifact.id] !== artifact.sha256) throw new Error(`${label} evidence does not match artifact ${artifact.id}`);
  }
}

function validateFlashPlan(value) {
  const expectedComponents = ["diagnostics", "diagnostics_test", "aurora_store", "retroarch"];
  const expectedDiagnostics = ["am", "instrument", "-w", "com.revivepsg1.diagnostics.test/androidx.test.runner.AndroidJUnitRunner"];
  if (!value || typeof value !== "object" || value.version !== 1 || value.target !== "PSG1"
    || value.requiredInstallationState !== "stock_locked" || value.unlockCommand !== "fastboot oem at-unlock-vboot"
    || value.vbmetaPartition !== "vbmeta" || value.systemPartition !== "system" || value.systemMode !== "fastbootd"
    || !Number.isSafeInteger(value.minimumSystemBytes) || value.minimumSystemBytes < 2_000_000_000 || value.minimumSystemBytes > 4_294_967_296
    || !Number.isSafeInteger(value.minimumSuperPartitionBytes) || value.minimumSuperPartitionBytes < 50_000_000_000 || value.minimumSuperPartitionBytes > 60_000_000_000
    || value.minimumSuperPartitionBytes < value.minimumSystemBytes
    || value.resizeLogicalSystem !== true || value.wipeUserData !== true || value.requiredColdBoots !== 2
    || !sameStrings(value.postFlashApkComponents, expectedComponents) || !sameStrings(value.diagnosticsCommand, expectedDiagnostics)) {
    throw new Error("release input contains an unsupported PSG1 flashPlan");
  }
  return {
    version: 1, target: "PSG1", requiredInstallationState: "stock_locked", unlockCommand: "fastboot oem at-unlock-vboot",
    vbmetaPartition: "vbmeta", systemPartition: "system", systemMode: "fastbootd",
    minimumSystemBytes: value.minimumSystemBytes, minimumSuperPartitionBytes: value.minimumSuperPartitionBytes,
    resizeLogicalSystem: true,
    wipeUserData: true, postFlashApkComponents: expectedComponents, requiredColdBoots: 2, diagnosticsCommand: expectedDiagnostics
  };
}

function validateInstallerArtifactsAndCapacity(flashPlan, artifacts) {
  const required = {
    android_system: "system",
    verified_boot: "vbmeta",
    diagnostics: "apk",
    diagnostics_test: "apk",
    aurora_store: "apk",
    retroarch: "apk"
  };
  const byComponent = new Map(artifacts.filter((artifact) => artifact.delivery === "private" && artifact.component in required)
    .map((artifact) => [artifact.component, artifact]));
  const system = byComponent.get("android_system");
  // The builder is also used for non-browser/customer-supplied manifests. Once
  // a private browser system image appears, however, the entire exact PSG1
  // artifact role set and its signed capacity guard are mandatory.
  if (!system) return;
  for (const [component, kind] of Object.entries(required)) {
    const artifact = byComponent.get(component);
    if (!artifact) throw new Error(`Private PSG1 browser releases require ${component}`);
    if (artifact.kind !== kind) throw new Error(`${component} must be a ${kind} artifact`);
  }
  if (system.size > flashPlan.minimumSystemBytes) {
    throw new Error(`android_system is ${system.size} bytes but flashPlan.minimumSystemBytes is only ${flashPlan.minimumSystemBytes}`);
  }
  if (flashPlan.minimumSystemBytes > flashPlan.minimumSuperPartitionBytes) {
    throw new Error("flashPlan system capacity cannot exceed its super-partition capacity");
  }
}

function sameStrings(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function isSha(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
