import { verify } from "node:crypto";
import canonicalize from "canonicalize";
import type { CompatibilityProfile, CompatibilitySnapshot, WebCompatibilitySnapshot } from "@revive-psg1/contracts";

export type ProfileSelection =
  | { status: "matched"; profile: CompatibilityProfile }
  | { status: "not_recognized" }
  | { status: "ambiguous"; priority: number; profileIds: string[] };

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

/**
 * Select only a unique highest-priority signed profile. Database row order is
 * not a security boundary: a tie is deliberately rejected rather than being
 * resolved by an implementation detail such as insertion order or profile ID.
 */
export function selectHighestPriorityProfile(candidates: CompatibilityProfile[]): ProfileSelection {
  if (!candidates.length) return { status: "not_recognized" };
  const priority = Math.max(...candidates.map((profile) => profile.priority));
  const highest = candidates.filter((profile) => profile.priority === priority);
  if (highest.length !== 1) {
    return {
      status: "ambiguous",
      priority,
      profileIds: highest.map((profile) => profile.id).sort((left, right) => left.localeCompare(right))
    };
  }
  return { status: "matched", profile: highest[0]! };
}

export const selectProfileByPriority = selectHighestPriorityProfile;

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
  return snapshot.systemBuildType === "user"
    && firmwareMatches(profile, snapshot.systemBuildFingerprint, snapshot.systemBuildIncremental);
}

export function webPreflightMatches(profile: CompatibilityProfile, snapshot: WebCompatibilitySnapshot): boolean {
  return webPreflightBlockers(profile, snapshot).length === 0;
}

export function webPreflightBlockers(profile: CompatibilityProfile, snapshot: WebCompatibilitySnapshot): string[] {
  const replacementSystem = profile.partitionConstraints.system;
  const stockSystem = profile.partitionConstraints.stockSystem;
  const superPartition = profile.partitionConstraints.super;
  const blockers: string[] = [];
  if (!snapshot.serialVerified || !snapshot.immutableSerialVerified) blockers.push("SERIAL_VERIFICATION_REQUIRED");
  // USB descriptor serials are manufacturer-variable advisory metadata. The
  // immutable CPU ↔ Fastboot protocol serial cross-check is represented by
  // serialVerified/immutableSerialVerified; do not reject a valid PSG1 solely
  // because the USB descriptor omits a serial.
  if (!snapshot.usbStable) blockers.push("USB_STABILITY_REQUIRED");
  if (!snapshot.recoveryCapable) blockers.push("RECOVERY_CAPABILITY_REQUIRED");
  if (!replacementSystem || !superPartition) {
    blockers.push("PROFILE_PARTITION_CONSTRAINTS_MISSING");
    return blockers;
  }
  // `stockSystem` is the observed mounted /system layout. `system` is the
  // replacement image / post-resize bound. A V11-class stock image is under
  // 2 GiB; do not apply the replacement floor to the live mount.
  const currentLayout = stockSystem ?? replacementSystem;
  const currentBlocker = stockSystem ? "STOCK_SYSTEM_OUT_OF_RANGE" : "SYSTEM_PARTITION_OUT_OF_RANGE";
  if (snapshot.systemPartitionBytes < currentLayout.minSize || snapshot.systemPartitionBytes > currentLayout.maxSize) {
    blockers.push(currentBlocker);
  }
  if (snapshot.superPartitionBytes < superPartition.minSize || snapshot.superPartitionBytes > superPartition.maxSize) {
    blockers.push("SUPER_PARTITION_OUT_OF_RANGE");
  }
  const hostNeed = replacementSystem.minSize;
  if (snapshot.hostBytesAvailable < hostNeed) blockers.push("HOST_STORAGE_INSUFFICIENT");
  if (snapshot.batteryPercent < 50 && !snapshot.charging) blockers.push("BATTERY_OR_CHARGING_REQUIRED");
  return blockers;
}
