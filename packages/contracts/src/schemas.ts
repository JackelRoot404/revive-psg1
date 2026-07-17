import { z } from "zod";

export const solanaAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const deviceIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const publicKeySchema = solanaAddressSchema;
export const signatureSchema = z.string().min(64).max(256);
export const uuidSchema = z.string().uuid();
export const betaInviteTokenSchema = z.string().regex(/^rpb_[A-Za-z0-9_-]{32,128}$/);
export const recoveryCredentialSchema = z.string().regex(/^rpr_[A-Za-z0-9_-]{32,128}$/);

export const compatibilitySnapshotSchema = z.object({
  product: z.string().max(80),
  model: z.string().max(80),
  board: z.string().max(120),
  hardware: z.string().max(120),
  buildFingerprint: z.string().max(320),
  buildIncremental: z.string().max(120),
  androidApiLevel: z.number().int().min(21).max(100),
  vendorApiLevel: z.number().int().min(1).max(100),
  batteryPercent: z.number().int().min(0).max(100),
  charging: z.boolean()
});

export const installationStateSchema = z.enum([
  "stock_locked",
  "stock_unlocked",
  "already_modified",
  "development_fixture"
]);

export const webCompatibilitySnapshotSchema = compatibilitySnapshotSchema.extend({
  systemBuildFingerprint: z.string().min(1).max(320),
  vendorBuildFingerprint: z.string().min(1).max(320),
  systemBuildIncremental: z.string().min(1).max(120),
  systemBuildType: z.string().min(1).max(40),
  lineageVersion: z.string().max(160),
  bootloaderUnlocked: z.boolean(),
  installationState: installationStateSchema,
  serialVerified: z.literal(true),
  usbStable: z.literal(true),
  recoveryCapable: z.literal(true),
  hostBytesAvailable: z.number().int().nonnegative(),
  systemPartitionBytes: z.number().int().positive()
});

export const sessionCreateSchema = z.object({
  deviceId: deviceIdSchema,
  pairingPublicKey: publicKeySchema,
  pairingProof: signatureSchema,
  appVersion: z.string().min(1).max(32),
  requestNonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  createdAt: z.string().datetime(),
  hostOs: z.enum(["windows", "macos"]),
  compatibility: compatibilitySnapshotSchema
});

export const webSessionCreateSchema = z.object({
  deviceId: deviceIdSchema,
  pairingPublicKey: publicKeySchema,
  pairingProof: signatureSchema,
  appVersion: z.string().min(1).max(32),
  requestNonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  createdAt: z.string().datetime(),
  hostOs: z.literal("web"),
  developmentFixture: z.literal(true).optional(),
  compatibility: webCompatibilitySnapshotSchema
});

export const walletChallengeRequestSchema = z.object({
  sessionId: uuidSchema,
  wallet: solanaAddressSchema
});

export const browserProofVerifySchema = z.object({
  challengeId: uuidSchema,
  signature: signatureSchema
});

export const browserProofChallengeRequestSchema = z.object({
  browserNonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/)
});

export const browserProofStatusSchema = z.object({
  challengeId: uuidSchema,
  browserNonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/)
});

export const walletVerifySchema = z.object({
  challengeId: uuidSchema,
  signature: signatureSchema
});

export const webInstallerChallengeRequestSchema = z.object({
  sessionId: uuidSchema,
  orderId: uuidSchema,
  wallet: solanaAddressSchema
});

export const webInstallerVerifySchema = z.object({
  challengeId: uuidSchema,
  signature: signatureSchema
});

export const orderCreateSchema = z.object({
  sessionId: uuidSchema,
  betaInviteToken: betaInviteTokenSchema.optional()
});

export const earlyAccessActivateSchema = z.object({
  sessionId: uuidSchema
});

export const entitlementRecoverySchema = z.object({
  recoveryCredential: recoveryCredentialSchema
});

export const orderVerifySchema = z.object({
  transactionSignature: signatureSchema.optional()
});

export const refundRequestSchema = z.object({
  reason: z.string().trim().min(10).max(2_000),
  category: z.enum(["customer_request", "suspected_incompatibility"]).default("customer_request")
});

export const licenseClaimSchema = z.object({
  sessionId: uuidSchema,
  pairingProof: signatureSchema,
  recoveryCredential: recoveryCredentialSchema
});

export const crashReportSchema = z.object({
  installId: uuidSchema,
  appVersion: z.string().trim().min(1).max(32),
  hostOs: z.enum(["windows", "macos"]),
  architecture: z.string().trim().min(1).max(32),
  stage: z.string().trim().min(1).max(64),
  errorCode: z.string().trim().min(1).max(64),
  stack: z.string().max(16_000).optional()
});

export const compatibilityReportSchema = z.object({
  sessionId: uuidSchema,
  profileCandidate: z.record(
    z.string().min(1).max(80),
    z.union([z.string().max(1_000), z.number().finite(), z.boolean(), z.null()])
  ),
  consentToNotify: z.boolean().default(false)
});

const artifactBaseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["system", "vbmeta", "apk", "recovery"]),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export const privateFirmwareArtifactSchema = artifactBaseSchema.extend({
  delivery: z.literal("private"),
  component: z.enum(["android_system", "verified_boot", "recovery", "aurora_store", "fdroid", "retroarch", "diagnostics", "stock_restore"]),
  objectKey: z.string().min(1),
  signerSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
});

export const customerSuppliedFirmwareArtifactSchema = artifactBaseSchema.extend({
  kind: z.literal("system"),
  delivery: z.literal("customer_supplied"),
  component: z.literal("google_mobile_services"),
  source: z.object({
    label: z.string().trim().min(1).max(160),
    instructionsUrl: z.string().url().refine((value) => new URL(value).protocol === "https:", "Instructions URL must use HTTPS"),
    archiveFilenamePatterns: z.array(z.string().trim().min(1).max(160)).min(1).max(10),
    archiveSize: z.number().int().positive(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    extractedPath: z.string().min(1).max(500).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "Extracted path must remain inside the supplied archive")
  }).strict()
});

export const firmwareArtifactSchema = z.discriminatedUnion("delivery", [
  privateFirmwareArtifactSchema,
  customerSuppliedFirmwareArtifactSchema
]);

export const compatibilityProfileSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  product: z.literal("PSG1"),
  modelPatterns: z.array(z.string()).min(1),
  boardPatterns: z.array(z.string()).min(1),
  hardwarePatterns: z.array(z.string()).min(1),
  soc: z.literal("RK3588S"),
  androidApiLevels: z.array(z.number().int()),
  vendorApiLevels: z.array(z.number().int()),
  firmwarePatterns: z.array(z.string()).min(1),
  partitionConstraints: z.record(z.string(), z.object({
    minSize: z.number().int().nonnegative(),
    maxSize: z.number().int().positive()
  })),
  unlockCommand: z.literal("fastboot oem at-unlock-vboot"),
  requiredArtifacts: z.array(firmwareArtifactSchema),
  expectedCapabilities: z.object({
    controls: z.boolean(),
    wifi: z.boolean(),
    audio: z.boolean(),
    fingerprint: z.boolean()
  }),
  diagnosticsCommand: z.array(z.string().min(1).max(120)).min(2).max(20),
  signature: z.string().min(64)
});

export const releaseManifestSchema = z.object({
  releaseId: uuidSchema,
  channel: z.literal("stable"),
  version: z.string().min(1),
  minimumInstallerVersion: z.string().min(1),
  profileIds: z.array(z.string()).min(1),
  artifacts: z.array(firmwareArtifactSchema).min(1),
  releaseNotes: z.string().max(8_000),
  publishedAt: z.string().datetime(),
  signingKeyId: z.string().min(1),
  signature: z.string().min(64)
});

export type SessionCreateInput = z.infer<typeof sessionCreateSchema>;
export type CompatibilitySnapshot = z.infer<typeof compatibilitySnapshotSchema>;
export type WebCompatibilitySnapshot = z.infer<typeof webCompatibilitySnapshotSchema>;
export type CompatibilityProfile = z.infer<typeof compatibilityProfileSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
