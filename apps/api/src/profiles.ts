import { verify } from "node:crypto";
import canonicalize from "canonicalize";
import type { CompatibilityProfile, CompatibilitySnapshot, WebCompatibilitySnapshot } from "@revive-psg1/contracts";

function matches(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, "i").test(value));
}

export function verifySignedDocument(document: unknown, signature: string, publicKeyPem: string | undefined): boolean {
  if (!publicKeyPem) return false;
  const canonical = canonicalize(document);
  if (!canonical) return false;
  try {
    return verify(null, Buffer.from(canonical), publicKeyPem, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function profileMatches(profile: CompatibilityProfile, snapshot: CompatibilitySnapshot): boolean {
  return hardwareMatches(profile, snapshot)
    && firmwareMatches(profile, snapshot.buildFingerprint, snapshot.buildIncremental);
}

function hardwareMatches(profile: CompatibilityProfile, snapshot: CompatibilitySnapshot): boolean {
  return profile.product === snapshot.product
    && matches(snapshot.model, profile.modelPatterns)
    && matches(snapshot.board, profile.boardPatterns)
    && matches(snapshot.hardware, profile.hardwarePatterns)
    && profile.androidApiLevels.includes(snapshot.androidApiLevel)
    && profile.vendorApiLevels.includes(snapshot.vendorApiLevel);
}

function firmwareMatches(profile: CompatibilityProfile, fingerprint: string, incremental: string): boolean {
  return profile.firmwarePatterns.some((pattern) => {
    const expression = new RegExp(pattern, "i");
    return expression.test(fingerprint) || expression.test(incremental);
  });
}

export function webProfileMatches(profile: CompatibilityProfile, snapshot: WebCompatibilitySnapshot): boolean {
  if (!hardwareMatches(profile, snapshot) || snapshot.installationState === "development_fixture") return false;
  if (snapshot.installationState === "already_modified") {
    return snapshot.bootloaderUnlocked
      && Boolean(snapshot.lineageVersion.trim())
      && firmwareMatches(profile, snapshot.vendorBuildFingerprint, snapshot.buildIncremental);
  }
  return firmwareMatches(profile, snapshot.systemBuildFingerprint, snapshot.systemBuildIncremental);
}

export function webPreflightMatches(profile: CompatibilityProfile, snapshot: WebCompatibilitySnapshot): boolean {
  const system = profile.partitionConstraints.system;
  return snapshot.serialVerified
    && snapshot.immutableSerialVerified
    && snapshot.usbStable
    && snapshot.recoveryCapable
    && Boolean(system)
    && snapshot.systemPartitionBytes >= system!.minSize
    && snapshot.systemPartitionBytes <= system!.maxSize
    && snapshot.hostBytesAvailable >= snapshot.systemPartitionBytes
    && (snapshot.batteryPercent >= 50 || snapshot.charging);
}
