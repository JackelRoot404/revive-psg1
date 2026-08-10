import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const hostOsEnum = pgEnum("host_os", ["windows", "macos", "web"]);
export const sessionChannelEnum = pgEnum("session_channel", ["desktop", "web"]);
export const walletChallengePurposeEnum = pgEnum("wallet_challenge_purpose", ["checkout", "web_installer"]);
export const orderKindEnum = pgEnum("order_kind", ["paid", "promo", "early_access"]);
export const orderStatusEnum = pgEnum("order_status", [
  "awaiting_payment",
  "awaiting_promo",
  "paid",
  "promo_redeemed",
  "free_activated",
  "refunded",
  "expired"
]);
export const licenseStatusEnum = pgEnum("license_status", ["active", "refund_pending", "refunded", "revoked"]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  deviceId: varchar("device_id", { length: 64 }).notNull(),
  pairingPublicKey: varchar("pairing_public_key", { length: 64 }).notNull(),
  appVersion: varchar("app_version", { length: 32 }).notNull(),
  requestNonceHash: varchar("request_nonce_hash", { length: 64 }).notNull(),
  hostOs: hostOsEnum("host_os").notNull(),
  channel: sessionChannelEnum("channel").notNull().default("desktop"),
  compatibility: jsonb("compatibility").notNull(),
  profileId: varchar("profile_id", { length: 120 }),
  supported: boolean("supported").notNull().default(false),
  browserVerifiedAt: timestamp("browser_verified_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index("sessions_device_idx").on(table.deviceId),
  index("sessions_expires_idx").on(table.expiresAt),
  uniqueIndex("sessions_request_nonce_uq").on(table.requestNonceHash)
]);

export const browserPairingChallenges = pgTable("browser_pairing_challenges", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  nonce: varchar("nonce", { length: 96 }).notNull(),
  browserNonceHash: varchar("browser_nonce_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("browser_pairing_challenges_nonce_uq").on(table.nonce),
  index("browser_pairing_challenges_session_idx").on(table.sessionId)
]);

export const walletChallenges = pgTable("wallet_challenges", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  wallet: varchar("wallet", { length: 44 }).notNull(),
  purpose: walletChallengePurposeEnum("purpose").notNull().default("checkout"),
  orderId: uuid("order_id"),
  licenseId: uuid("license_id"),
  message: text("message").notNull(),
  nonce: varchar("nonce", { length: 96 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [uniqueIndex("wallet_challenges_nonce_uq").on(table.nonce)]);

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  deviceId: varchar("device_id", { length: 64 }).notNull(),
  wallet: varchar("wallet", { length: 44 }).notNull(),
  kind: orderKindEnum("kind").notNull(),
  status: orderStatusEnum("status").notNull(),
  reference: varchar("reference", { length: 44 }).notNull(),
  amountBaseUnits: bigint("amount_base_units", { mode: "bigint" }).notNull(),
  mint: varchar("mint", { length: 44 }).notNull(),
  treasury: varchar("treasury", { length: 44 }).notNull(),
  betaInviteTokenDigest: varchar("beta_invite_token_digest", { length: 64 }),
  transactionSignature: varchar("transaction_signature", { length: 128 }),
  paymentSlot: bigint("payment_slot", { mode: "number" }),
  paymentBlockTime: timestamp("payment_block_time", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("orders_reference_uq").on(table.reference),
  uniqueIndex("orders_transaction_signature_uq").on(table.transactionSignature),
  uniqueIndex("orders_open_device_uq").on(table.deviceId).where(sql`${table.status} in ('awaiting_payment', 'awaiting_promo')`),
  index("orders_device_idx").on(table.deviceId),
  index("orders_wallet_idx").on(table.wallet)
]);

export const devices = pgTable("devices", {
  id: varchar("id", { length: 64 }).primaryKey(),
  profileId: varchar("profile_id", { length: 120 }),
  serialVerified: boolean("serial_verified").notNull().default(false),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  licensedAt: timestamp("licensed_at", { withTimezone: true })
});

export const licenses = pgTable("licenses", {
  id: uuid("id").primaryKey(),
  deviceId: varchar("device_id", { length: 64 }).notNull().references(() => devices.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  receiptWallet: varchar("receipt_wallet", { length: 44 }).notNull(),
  status: licenseStatusEnum("status").notNull().default("active"),
  tokenDigest: varchar("token_digest", { length: 64 }),
  recoveryCredentialDigest: varchar("recovery_credential_digest", { length: 64 }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  modificationStartedAt: timestamp("modification_started_at", { withTimezone: true }),
  // These immutable fields bind a destructive boundary to one reviewed
  // profile/release/artifact set. They make an interrupted installation
  // resumable without letting a later manifest substitution change its plan.
  installationProfileId: varchar("installation_profile_id", { length: 120 }),
  // Keep the exact signed profile envelope that admitted this device. Profile
  // deactivation may stop new starts, but must never make a boundary-crossed
  // PSG1 unable to retrieve its already-signed recovery release.
  installationProfileDocument: jsonb("installation_profile_document"),
  installationProfileSignature: text("installation_profile_signature"),
  // A version label and artifact list are not a sufficient release identity:
  // a re-signed manifest could reuse both. Persist the immutable release row
  // id plus the canonical manifest digest for exact post-boundary resume.
  installationReleaseId: uuid("installation_release_id"),
  installationReleaseVersion: varchar("installation_release_version", { length: 64 }),
  installationManifestSha256: varchar("installation_manifest_sha256", { length: 64 }),
  installationArtifactHashes: jsonb("installation_artifact_hashes"),
  // An expiring opaque credential is kept only in the same-origin persistent
  // browser journal. It restores an already-bound release after a tab/browser
  // crash in Fastboot; it cannot create a fresh entitlement.
  installationResumeCredentialDigest: varchar("installation_resume_credential_digest", { length: 64 }),
  installationResumeCredentialExpiresAt: timestamp("installation_resume_credential_expires_at", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true })
}, (table) => [uniqueIndex("licenses_device_uq").on(table.deviceId), uniqueIndex("licenses_order_uq").on(table.orderId)]);

// Append-only write-ahead records for an active browser installation. The
// browser keeps its raw Fastboot serial locally; the server stores only its
// hashed device binding and signed release identifiers.
export const installationJournalEntries = pgTable("installation_journal_entries", {
  id: uuid("id").primaryKey(),
  // Monotonic per-license sequence assigned while holding the license advisory
  // lock. It makes a journal chain deterministic even if two records share a
  // timestamp and prevents concurrent tabs from branching the state machine.
  sequence: integer("sequence").notNull(),
  licenseId: uuid("license_id").notNull().references(() => licenses.id, { onDelete: "cascade" }),
  deviceId: varchar("device_id", { length: 64 }).notNull().references(() => devices.id),
  profileId: varchar("profile_id", { length: 120 }).notNull(),
  releaseVersion: varchar("release_version", { length: 64 }).notNull(),
  artifactHashes: jsonb("artifact_hashes").notNull(),
  stage: varchar("stage", { length: 64 }).notNull(),
  operation: varchar("operation", { length: 64 }).notNull(),
  operationState: varchar("operation_state", { length: 16 }).notNull(),
  operationIndex: integer("operation_index").notNull().default(0),
  operationCount: integer("operation_count").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("installation_journal_entries_license_sequence_uq").on(table.licenseId, table.sequence),
  index("installation_journal_entries_license_time_idx").on(table.licenseId, table.createdAt),
  index("installation_journal_entries_device_time_idx").on(table.deviceId, table.createdAt)
]);

export const betaInvites = pgTable("beta_invites", {
  id: uuid("id").primaryKey(),
  tokenDigest: varchar("token_digest", { length: 64 }).notNull(),
  // A Discord code is intentionally unbound when issued. The redemption
  // transaction binds it to its first supported physical PSG1.
  deviceId: varchar("device_id", { length: 64 }),
  label: varchar("label", { length: 120 }),
  // `hardware_pilot` has a database uniqueness constraint: only a single
  // unvalidated destructive hardware pilot can ever be issued.
  kind: varchar("kind", { length: 32 }).notNull().default("cohort"),
  enabled: boolean("enabled").notNull().default(true),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  redeemedOrderId: uuid("redeemed_order_id").references(() => orders.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("beta_invites_token_uq").on(table.tokenDigest),
  uniqueIndex("beta_invites_device_uq").on(table.deviceId).where(sql`${table.deviceId} is not null`),
  uniqueIndex("beta_invites_hardware_pilot_once_uq").on(table.kind).where(sql`${table.kind} = 'hardware_pilot'`),
  uniqueIndex("beta_invites_order_uq").on(table.redeemedOrderId)
]);

export const promoCodes = pgTable("promo_codes", {
  codeHash: varchar("code_hash", { length: 64 }).primaryKey(),
  label: varchar("label", { length: 64 }).notNull(),
  maxRedemptions: integer("max_redemptions").notNull(),
  redemptionCount: integer("redemption_count").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const promoRedemptions = pgTable("promo_redemptions", {
  id: uuid("id").primaryKey(),
  codeHash: varchar("code_hash", { length: 64 }).notNull().references(() => promoCodes.codeHash),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  deviceId: varchar("device_id", { length: 64 }).notNull(),
  wallet: varchar("wallet", { length: 44 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [uniqueIndex("promo_redemptions_order_uq").on(table.orderId), uniqueIndex("promo_redemptions_device_uq").on(table.deviceId)]);

export const compatibilityProfiles = pgTable("compatibility_profiles", {
  id: varchar("id", { length: 120 }).primaryKey(),
  version: integer("version").notNull(),
  signedDocument: jsonb("signed_document").notNull(),
  signature: text("signature").notNull(),
  active: boolean("active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const releases = pgTable("releases", {
  id: uuid("id").primaryKey(),
  version: varchar("version", { length: 64 }).notNull(),
  channel: varchar("channel", { length: 20 }).notNull().default("stable"),
  signedManifest: jsonb("signed_manifest").notNull(),
  signature: text("signature").notNull(),
  active: boolean("active").notNull().default(false),
  // A superseded release is removed from new selection (`active=false`) but
  // retained for the exact devices that already crossed its boundary.
  resumeAvailable: boolean("resume_available").notNull().default(true),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("releases_version_channel_uq").on(table.version, table.channel)]);

export const compatibilityReports = pgTable("compatibility_reports", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  profileCandidate: jsonb("profile_candidate").notNull(),
  consentToNotify: boolean("consent_to_notify").notNull().default(false),
  reportTokenDigest: varchar("report_token_digest", { length: 64 }).notNull(),
  status: varchar("status", { length: 24 }).notNull().default("pending"),
  matchedProfileId: varchar("matched_profile_id", { length: 120 }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const crashReports = pgTable("crash_reports", {
  id: uuid("id").primaryKey(),
  installId: uuid("install_id").notNull(),
  appVersion: varchar("app_version", { length: 32 }).notNull(),
  hostOs: hostOsEnum("host_os").notNull(),
  architecture: varchar("architecture", { length: 32 }).notNull(),
  stage: varchar("stage", { length: 64 }).notNull(),
  errorCode: varchar("error_code", { length: 64 }).notNull(),
  stack: text("stack"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [index("crash_reports_error_idx").on(table.errorCode, table.createdAt)]);

export const refunds = pgTable("refunds", {
  id: uuid("id").primaryKey(),
  licenseId: uuid("license_id").notNull().references(() => licenses.id),
  reason: text("reason").notNull(),
  verifiedIncompatibility: boolean("verified_incompatibility").notNull().default(false),
  status: varchar("status", { length: 24 }).notNull().default("requested"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true })
}, (table) => [uniqueIndex("refunds_license_uq").on(table.licenseId)]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  actorHash: varchar("actor_hash", { length: 64 }),
  subjectId: varchar("subject_id", { length: 120 }),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [index("audit_events_type_time_idx").on(table.eventType, table.createdAt)]);

export const launchGateChecks = pgTable("launch_gate_checks", {
  key: varchar("key", { length: 80 }).primaryKey(),
  passed: boolean("passed").notNull().default(false),
  evidence: jsonb("evidence").notNull().default({}),
  verifiedBy: varchar("verified_by", { length: 120 }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
