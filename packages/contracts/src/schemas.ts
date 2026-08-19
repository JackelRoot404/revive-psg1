import { z } from "zod";

export const solanaAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const deviceIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const publicKeySchema = solanaAddressSchema;
export const signatureSchema = z.string().min(64).max(256);
export const uuidSchema = z.string().uuid();
export const betaInviteTokenSchema = z.string().regex(/^rpb_[A-Za-z0-9_-]{32,128}$/);
export const recoveryCredentialSchema = z.string().regex(/^rpr_[A-Za-z0-9_-]{32,128}$/);
export const installationResumeCredentialSchema = z.string().regex(/^rpi_[A-Za-z0-9_-]{32,128}$/);
export const installerModeSchema = z.enum(["scan_only", "private_beta", "public"]);

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
  immutableSerialVerified: z.literal(true),
  fastbootUsbDescriptorVerified: z.boolean(),
  usbStable: z.literal(true),
  recoveryCapable: z.literal(true),
  hostBytesAvailable: z.number().int().nonnegative(),
  systemPartitionBytes: z.number().int().positive(),
  superPartitionBytes: z.number().int().positive()
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

export const betaActivateSchema = z.object({
  sessionId: uuidSchema,
  betaInviteToken: betaInviteTokenSchema
});

// Public activation is deliberately device-session-bound. There is no
// invitation, coupon, wallet, or other transferable credential in this flow.
export const publicActivateSchema = z.object({
  sessionId: uuidSchema
});

// Resume is deliberately a separate, device-session-bound capability. The
// server permits it only after the same device has crossed the irreversible
// boundary with an exact signed release binding; it cannot create a new
// entitlement or turn an arbitrary modified device into an installer target.
export const publicResumeSchema = z.object({
  sessionId: uuidSchema
});

// A persistent same-origin browser journal may use this only after a prior
// destructive boundary. It has no scan/session entitlement and cannot mint a
// new installation; it merely restores the exact stored release after the
// browser reselects the Fastboot protocol-serial device.
export const fastbootResumeSchema = z.object({
  deviceId: deviceIdSchema,
  resumeCredential: installationResumeCredentialSchema
});

export const betaResumeSchema = z.object({
  sessionId: uuidSchema
});

export const installationStartSchema = z.object({
  termsVersion: z.string().trim().min(1).max(80),
  irreversibleRiskAcknowledged: z.literal(true),
  confirmation: z.literal("ERASE PSG1"),
  profileId: z.string().trim().min(1).max(120),
  // These are derived from the exact release document the browser verified.
  // They close the gap between artifact download and the destructive boundary
  // if a release is replaced while the owner is reading the warning.
  releaseId: uuidSchema,
  releaseVersion: z.string().trim().min(1).max(64),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactHashes: z.record(
    z.string().trim().min(1).max(100),
    z.string().regex(/^[a-f0-9]{64}$/)
  )
});

export const installationJournalStageSchema = z.enum([
  "start",
  "awaiting_bootloader_unlock",
  "awaiting_unlocked_android",
  "awaiting_vbmeta_bootloader",
  "awaiting_system_android",
  "awaiting_fastbootd_system",
  "awaiting_postflash_android",
  "awaiting_first_cold_boot",
  "awaiting_second_cold_boot",
  "complete"
]);

export const installationJournalOperationSchema = z.enum([
  "begin",
  "unlock",
  "reboot_for_vbmeta",
  "flash_vbmeta",
  "reboot_after_vbmeta",
  "reboot_for_fastbootd",
  "resize_system",
  "flash_system",
  "wipe_userdata",
  "reboot_after_system",
  "install_diagnostics",
  "install_diagnostics_test",
  "install_aurora_store",
  "install_retroarch",
  "reboot_after_apps",
  "first_cold_boot",
  "diagnostics"
]);

export const installationOperationStateSchema = z.enum(["intent", "sent", "verified", "unknown"]);

// The server journal intentionally does not receive the raw Fastboot serial.
// The authenticated device id is already a one-way identity binding, while
// the browser retains the raw serial locally to perform its USB recheck.
export const installationJournalEntrySchema = z.object({
  profileId: z.string().trim().min(1).max(120),
  releaseVersion: z.string().trim().min(1).max(64),
  artifactHashes: z.record(
    z.string().trim().min(1).max(100),
    z.string().regex(/^[a-f0-9]{64}$/)
  ),
  stage: installationJournalStageSchema,
  operation: installationJournalOperationSchema,
  operationState: installationOperationStateSchema,
  // Most checkpoints are a single command (0/1). Sparse system images are
  // explicitly journaled one exact Fastboot `flash:system` transfer at a
  // time, so an interruption can restart only the idempotent signed segment.
  operationIndex: z.number().int().min(0).max(100_000),
  operationCount: z.number().int().min(1).max(100_000)
}).superRefine((entry, context) => {
  if (entry.operationIndex >= entry.operationCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["operationIndex"], message: "operationIndex must be less than operationCount" });
  }
  if (entry.operation !== "flash_system" && (entry.operationIndex !== 0 || entry.operationCount !== 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["operationIndex"], message: "only flash_system may use multiple operation segments" });
  }
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
  component: z.enum(["android_system", "verified_boot", "recovery", "aurora_store", "fdroid", "retroarch", "diagnostics", "diagnostics_test", "stock_restore"]),
  objectKey: z.string().min(1),
  signerSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  packageName: z.string().regex(/^[a-z][a-z0-9_.]{2,150}$/).optional(),
  versionName: z.string().trim().min(1).max(120).optional()
}).superRefine((artifact, context) => {
  const requiredKinds: Partial<Record<typeof artifact.component, "system" | "vbmeta" | "apk">> = {
    android_system: "system",
    verified_boot: "vbmeta",
    diagnostics: "apk",
    diagnostics_test: "apk",
    aurora_store: "apk",
    retroarch: "apk"
  };
  const expectedKind = requiredKinds[artifact.component];
  if (expectedKind && artifact.kind !== expectedKind) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: `${artifact.component} must be a ${expectedKind} artifact` });
  }
  if (artifact.objectKey.startsWith("/") || artifact.objectKey.split("/").includes("..")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["objectKey"], message: "Private artifact object keys must remain inside their release prefix" });
  }
  if (artifact.kind !== "apk") return;
  if (!artifact.signerSha256) context.addIssue({ code: z.ZodIssueCode.custom, path: ["signerSha256"], message: "APK signer digest is required" });
  if (!artifact.packageName) context.addIssue({ code: z.ZodIssueCode.custom, path: ["packageName"], message: "APK package name is required" });
  if (artifact.component !== "diagnostics_test" && !artifact.versionName) context.addIssue({ code: z.ZodIssueCode.custom, path: ["versionName"], message: "APK version name is required" });
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
  // This value is part of the signed profile rather than database metadata so
  // selection remains deterministic wherever a profile is consumed.
  priority: z.number().int().min(0).max(1_000_000),
  product: z.literal("PSG1"),
  modelPatterns: z.array(z.string()).min(1),
  boardPatterns: z.array(z.string()).min(1),
  hardwarePatterns: z.array(z.string()).min(1),
  soc: z.literal("RK3588S"),
  androidApiLevels: z.array(z.number().int()),
  vendorApiLevels: z.array(z.number().int()),
  firmwarePatterns: z.array(z.string()).min(1),
  // Known keys:
  // - stockSystem: observed mounted /system on a stock unit
  // - system: replacement image / post-resize logical system
  // - super: physical super partition
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

const fullStockPsg1ValidationSchema = z.object({
  status: z.literal("passed"),
  validatedAt: z.string().datetime(),
  stockUnitCount: z.number().int().min(1),
  chromeWindows: z.literal(true),
  edgeWindows: z.literal(true),
  chromeMacos: z.literal(true),
  edgeMacos: z.literal(true),
  controls: z.literal(true),
  wifi: z.literal(true),
  audio: z.literal(true),
  storage: z.literal(true),
  auroraStore: z.literal(true),
  retroArch: z.literal(true),
  diagnostics: z.literal(true),
  twoColdBoots: z.literal(true)
}).strict();

const betaEvidenceSchema = z.object({
  source: z.object({
    releaseUrl: z.string().url().refine((value) => new URL(value).protocol === "https:"),
    tag: z.string().trim().min(1).max(160),
    upstreamAssetName: z.string().trim().min(1).max(240),
    upstreamArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expandedSystemSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  licenseReview: z.object({
    status: z.literal("approved"),
    license: z.string().trim().min(1).max(160),
    reviewer: z.string().trim().min(1).max(120),
    reviewedAt: z.string().datetime(),
    evidenceUrl: z.string().url().refine((value) => new URL(value).protocol === "https:")
  }).strict(),
  noGmsInspection: z.object({
    tool: z.string().trim().min(1).max(160),
    inspectedAt: z.string().datetime(),
    checkedPaths: z.array(z.string().trim().min(1).max(500)).min(3).max(50),
    // This is a GMS check, not a blanket ban on a package whose namespace
    // happens to begin with com.google. Any such non-GMS package is recorded
    // separately and must be reviewed before publication.
    detectedGmsPackages: z.array(z.string()).max(0),
    reviewedNonGmsGooglePackages: z.array(z.string().trim().min(1).max(240)).max(20),
    reportSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  // A release is normally published only after this complete validation set.
  // The deliberately narrow alternative exists for one Discord-supervised
  // stock-device pilot, never for a general beta cohort.
  stockPsg1Validation: z.discriminatedUnion("status", [
    fullStockPsg1ValidationSchema,
    z.object({
      status: z.literal("pilot_pending"),
      plannedAt: z.string().datetime(),
      maxEnrollments: z.literal(1),
      discordSupervisionRequired: z.literal(true),
      acknowledgement: z.literal("No stock PSG1 is available to the operator; this single destructive enrollment is the hardware-validation pilot."),
      chromeWindows: z.literal(false),
      edgeWindows: z.literal(false),
      chromeMacos: z.literal(false),
      edgeMacos: z.literal(false),
      controls: z.literal(false), wifi: z.literal(false), audio: z.literal(false), storage: z.literal(false),
      auroraStore: z.literal(false), retroArch: z.literal(false), diagnostics: z.literal(false), twoColdBoots: z.literal(false)
    }).strict()
  ]),
  artifactSha256: z.record(z.string().min(1).max(100), z.string().regex(/^[a-f0-9]{64}$/))
}).strict();

// The browser installer supports exactly one reviewed PSG1 flashing sequence.
// Every action-affecting value is signed and allowlisted; callers must reject
// a manifest that adds or substitutes a generic Fastboot command.
export const psg1FlashPlanSchema = z.object({
  version: z.literal(1),
  target: z.literal("PSG1"),
  requiredInstallationState: z.literal("stock_locked"),
  unlockCommand: z.literal("fastboot oem at-unlock-vboot"),
  vbmetaPartition: z.literal("vbmeta"),
  systemPartition: z.literal("system"),
  systemMode: z.literal("fastbootd"),
  // Replacement-image / post-resize capacity, not the live mounted /system
  // size. Stock V11-class images are under 2 GiB and are resized in Fastbootd.
  minimumSystemBytes: z.number().int().min(2_000_000_000).max(4_294_967_296),
  minimumSuperPartitionBytes: z.number().int().min(50_000_000_000).max(60_000_000_000),
  resizeLogicalSystem: z.literal(true),
  wipeUserData: z.literal(true),
  postFlashApkComponents: z.tuple([
    z.literal("diagnostics"),
    z.literal("diagnostics_test"),
    z.literal("aurora_store"),
    z.literal("retroarch")
  ]),
  requiredColdBoots: z.literal(2),
  diagnosticsCommand: z.tuple([
    z.literal("am"),
    z.literal("instrument"),
    z.literal("-w"),
    z.literal("com.revivepsg1.diagnostics.test/androidx.test.runner.AndroidJUnitRunner")
  ])
}).strict();

// Public release evidence is intentionally separate from the private-beta
// pilot record. A public activation may rely only on this complete reviewed
// evidence set, never on a pilot-pending beta validation.
export const publicEvidenceSchema = z.object({
  source: z.object({
    releaseUrl: z.string().url().refine((value) => new URL(value).protocol === "https:"),
    tag: z.string().trim().min(1).max(160),
    upstreamAssetName: z.string().trim().min(1).max(240),
    upstreamArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expandedSystemSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  licenseReview: z.object({
    status: z.literal("approved"),
    license: z.string().trim().min(1).max(160),
    reviewer: z.string().trim().min(1).max(120),
    reviewedAt: z.string().datetime(),
    evidenceUrl: z.string().url().refine((value) => new URL(value).protocol === "https:")
  }).strict(),
  noGmsInspection: z.object({
    tool: z.string().trim().min(1).max(160),
    inspectedAt: z.string().datetime(),
    checkedPaths: z.array(z.string().trim().min(1).max(500)).min(3).max(50),
    detectedGmsPackages: z.array(z.string()).max(0),
    reviewedNonGmsGooglePackages: z.array(z.string().trim().min(1).max(240)).max(20),
    reportSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  // The evidence must describe the exact bytes that the signed manifest will
  // serve. Runtime policy cross-checks these records against every manifest
  // artifact, so a provenance report cannot silently refer to a different
  // image or a differently-sized vbmeta file.
  artifactMetadata: z.record(z.string().trim().min(1).max(100), z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive()
  }).strict()).superRefine((metadata, context) => {
    if (Object.keys(metadata).length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Artifact metadata must not be empty" });
    }
  }),
  avb: z.object({
    vbmetaArtifactId: z.string().trim().min(1).max(100),
    algorithm: z.string().regex(/^SHA(?:256|512)_RSA(?:2048|4096|8192)$/u),
    publicKeySha256: z.string().regex(/^[a-f0-9]{64}$/),
    descriptorsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rollbackIndex: z.number().int().nonnegative()
  }).strict(),
  windowsFastbootDriver: z.object({
    packageUrl: z.string().url().refine((value) => new URL(value).protocol === "https:"),
    installerSha256: z.string().regex(/^[a-f0-9]{64}$/),
    catalogSha256: z.string().regex(/^[a-f0-9]{64}$/),
    authenticodeSigner: z.string().trim().min(1).max(240),
    // A fastboot driver must bind an exact PSG1 interface, never a generic
    // Rockchip vendor id or Android ADB interface.
    hardwareIds: z.array(z.string().regex(/^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}&MI_[0-9A-F]{2}$/u)).min(1).max(8),
    interfaceGuid: z.string().uuid(),
    testedWindowsVersions: z.array(z.enum(["windows_10", "windows_11"])).length(2).superRefine((versions, context) => {
      if (new Set(versions).size !== 2) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Both Windows 10 and Windows 11 must be tested" });
      }
    })
  }).strict(),
  // Public self-service requires complete validation on stock hardware in
  // every supported desktop browser. Unlike private beta, there is no pilot
  // exception or cohort-code path for an unvalidated release.
  stockPsg1Validation: fullStockPsg1ValidationSchema,
  artifactSha256: z.record(z.string().min(1).max(100), z.string().regex(/^[a-f0-9]{64}$/)),
  review: z.object({
    status: z.literal("approved"),
    reviewer: z.string().trim().min(1).max(120),
    reviewedAt: z.string().datetime(),
    riskAcknowledgement: z.literal("I approve public self-service PSG1 installation only for stock-locked devices using this signed flash plan.")
  }).strict()
}).strict();

export const releaseManifestSchema = z.object({
  releaseId: uuidSchema,
  channel: z.literal("stable"),
  version: z.string().min(1),
  minimumInstallerVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
  profileIds: z.array(z.string()).min(1),
  artifacts: z.array(firmwareArtifactSchema).min(1),
  releaseNotes: z.string().max(8_000),
  publishedAt: z.string().datetime(),
  signingKeyId: z.string().min(1),
  flashPlan: psg1FlashPlanSchema,
  betaEvidence: betaEvidenceSchema.optional(),
  publicEvidence: publicEvidenceSchema.optional(),
  signature: z.string().min(64)
}).superRefine((manifest, context) => {
  const ids = new Set<string>();
  const installerComponents = new Set([
    "android_system", "verified_boot", "diagnostics", "diagnostics_test", "aurora_store", "retroarch"
  ]);
  const components = new Set<string>();
  const browserRoleKinds: Record<string, "system" | "vbmeta" | "apk"> = {
    android_system: "system",
    verified_boot: "vbmeta",
    diagnostics: "apk",
    diagnostics_test: "apk",
    aurora_store: "apk",
    retroarch: "apk"
  };
  let hasPrivateBrowserSystem = false;
  for (const artifact of manifest.artifacts) {
    if (ids.has(artifact.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts"], message: `Duplicate artifact id: ${artifact.id}` });
    }
    ids.add(artifact.id);
    if (artifact.delivery === "private" && installerComponents.has(artifact.component)) {
      if (artifact.component === "android_system") hasPrivateBrowserSystem = true;
      const expectedKind = browserRoleKinds[artifact.component];
      if (expectedKind && artifact.kind !== expectedKind) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts"], message: `${artifact.component} must be a ${expectedKind} artifact` });
      }
      if (components.has(artifact.component)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts"], message: `Duplicate installer artifact component: ${artifact.component}` });
      }
      components.add(artifact.component);
    }
  }
  if (hasPrivateBrowserSystem) {
    for (const component of installerComponents) {
      if (!components.has(component)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts"], message: `Private PSG1 browser releases require ${component}` });
      }
    }
  }
});

export const webSessionDecisionSchema = z.object({
  profile: z.enum(["matched", "not_recognized"]),
  deviceState: installationStateSchema,
  preflight: z.enum(["passed", "blocked"]),
  blockers: z.array(z.string().min(1).max(120)).max(20),
  installerMode: installerModeSchema,
  canInstall: z.boolean()
});

export type SessionCreateInput = z.infer<typeof sessionCreateSchema>;
export type CompatibilitySnapshot = z.infer<typeof compatibilitySnapshotSchema>;
export type WebCompatibilitySnapshot = z.infer<typeof webCompatibilitySnapshotSchema>;
export type CompatibilityProfile = z.infer<typeof compatibilityProfileSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type Psg1FlashPlan = z.infer<typeof psg1FlashPlanSchema>;
export type WebSessionDecision = z.infer<typeof webSessionDecisionSchema>;
export type InstallationJournalEntry = z.infer<typeof installationJournalEntrySchema>;
