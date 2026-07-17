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
  return profile.product === snapshot.product
    && matches(snapshot.model, profile.modelPatterns)
    && matches(snapshot.board, profile.boardPatterns)
    && matches(snapshot.hardware, profile.hardwarePatterns)
    && profile.androidApiLevels.includes(snapshot.androidApiLevel)
    && profile.vendorApiLevels.includes(snapshot.vendorApiLevel)
    && profile.firmwarePatterns.some((pattern) => {
      const expression = new RegExp(pattern, "i");
      return expression.test(snapshot.buildFingerprint) || expression.test(snapshot.buildIncremental);
    });
}

export function webPreflightMatches(profile: CompatibilityProfile, snapshot: WebCompatibilitySnapshot): boolean {
  const system = profile.partitionConstraints.system;
  return snapshot.serialVerified
    && snapshot.usbStable
    && snapshot.recoveryCapable
    && Boolean(system)
    && snapshot.systemPartitionBytes >= system!.minSize
    && snapshot.systemPartitionBytes <= system!.maxSize
    && snapshot.hostBytesAvailable >= snapshot.systemPartitionBytes
    && (snapshot.batteryPercent >= 50 || snapshot.charging);
}
