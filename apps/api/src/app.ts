import { randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import Redis from "ioredis";
import {
  BETA_PROMO_CODE,
  BETA_PROMO_LIMIT,
  betaActivateSchema,
  betaResumeSchema,
  DEVELOPMENT_FIXTURE_DEVICE_ID,
  DEVELOPMENT_FIXTURE_PROFILE_ID,
  DEVELOPMENT_MODIFIED_PROFILE_ID,
  INSTALLATION_RESUME_CREDENTIAL_TTL_SECONDS,
  LICENSE_PRICE_USDC,
  SESSION_TTL_SECONDS,
  WEB_INSTALLER_SESSION_TTL_SECONDS,
  SOLANA_USDC_MINT,
  TREASURY_WALLET,
  USDC_AMOUNT_BASE_UNITS,
  browserProofMessage,
  browserProofChallengeRequestSchema,
  browserProofStatusSchema,
  browserProofVerifySchema,
  compatibilityProfileSchema,
  compatibilityReportSchema,
  crashReportSchema,
  deviceIdSchema,
  entitlementRecoverySchema,
  fastbootResumeSchema,
  isExactDevelopmentFixture,
  isSafeDevelopmentModifiedScan,
  installationJournalEntrySchema,
  installationStartSchema,
  licenseClaimMessage,
  licenseClaimSchema,
  orderCreateSchema,
  orderVerifySchema,
  publicActivateSchema,
  publicResumeSchema,
  refundRequestSchema,
  releaseManifestSchema,
  sessionCreateSchema,
  sessionProofMessage,
  walletChallengeMessage,
  walletChallengeRequestSchema,
  walletVerifySchema,
  webInstallerChallengeRequestSchema,
  webInstallerVerifySchema,
  webInstallerWalletChallengeMessage,
  webCompatibilitySnapshotSchema,
  webCheckoutWalletChallengeMessage,
  webSessionCreateSchema,
  webSessionDecisionSchema,
  webSessionProofMessage,
  uuidSchema
} from "@revive-psg1/contracts";
import type { CompatibilityProfile, InstallationJournalEntry, ReleaseManifest, WebCompatibilitySnapshot, WebSessionDecision } from "@revive-psg1/contracts";
import type { Config } from "./config";
import type { Database } from "./db/client";
import {
  browserPairingChallenges,
  betaInvites,
  compatibilityProfiles,
  compatibilityReports,
  crashReports,
  devices,
  installationJournalEntries,
  launchGateChecks,
  licenses,
  orders,
  promoCodes,
  promoRedemptions,
  refunds,
  releases,
  sessions,
  walletChallenges
} from "./db/schema";
import { audit } from "./audit";
import { profileMatches, selectHighestPriorityProfile, type ProfileSelection, verifySignedDocument, webPreflightBlockers, webProfileMatches } from "./profiles";
import { SolanaPaymentVerifier } from "./payment";
import { bearerToken, randomNonce, randomSolanaAddress, safeEqualHex, sha256, TokenService, verifyEd25519Base58 } from "./security";
import { ArtifactStorage } from "./storage";

type Dependencies = {
  config: Config;
  db: Database;
  tokenService?: TokenService;
  paymentVerifier?: SolanaPaymentVerifier;
  storage?: ArtifactStorage;
};

export async function buildApp(dependencies: Dependencies) {
  const { config, db } = dependencies;
  const tokens = dependencies.tokenService ?? new TokenService(config);
  const payments = dependencies.paymentVerifier ?? new SolanaPaymentVerifier(config);
  const storage = dependencies.storage ?? new ArtifactStorage(config);
  const app = Fastify({
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    trustProxy: config.nodeEnv === "production" ? 1 : false,
    logger: { redact: [
      "req.headers.authorization", "req.headers.cookie", "req.body.signature", "req.body.pairingProof",
      "req.body.transactionSignature", "req.body.wallet", "req.body.deviceId", "req.body.profileCandidate",
      "req.body.browserNonce", "req.body.requestNonce", "req.body.betaInviteToken", "req.body.recoveryCredential",
      "req.body.reason", "req.body.stack",
      "req.params.deviceId"
    ] }
  });
  const redis = config.valkeyUrl ? new Redis(config.valkeyUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: true }) : undefined;
  if (redis) {
    await redis.connect();
    app.addHook("onClose", async () => { await redis.quit(); });
  }

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Origin is not allowed"), false);
    },
    methods: ["GET", "POST"]
  });
  await app.register(rateLimit, { max: 60, timeWindow: "1 minute", ...(redis ? { redis } : {}) });
  app.addHook("onRequest", async (request, reply) => {
    // The former paid/wallet flow does not meet the public installer’s
    // device-state and release-evidence gates. Keep it unavailable rather
    // than allowing it to become an alternate entitlement path in any mode.
    if (isLegacyCommerceOrRecoveryPath(request.url)) {
      return reply.code(404).send({ code: "BETA_ONLY_ROUTE_DISABLED" });
    }
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      if (redis) await redis.ping();
      return { ready: true };
    } catch {
      return reply.code(503).send({ ready: false });
    }
  });

  app.post("/v1/sessions", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = sessionCreateSchema.parse(request.body);
    if (Math.abs(Date.now() - Date.parse(input.createdAt)) > 5 * 60_000) {
      return reply.code(400).send({ code: "SESSION_PROOF_EXPIRED" });
    }
    const proofMessage = sessionProofMessage(input);
    if (!verifyEd25519Base58({ publicKey: input.pairingPublicKey, signature: input.pairingProof, message: proofMessage })) {
      return reply.code(401).send({ code: "INVALID_PAIRING_PROOF", message: "Desktop pairing proof is invalid" });
    }
    const activeProfiles = await db.select().from(compatibilityProfiles).where(eq(compatibilityProfiles.active, true));
    const verifiedProfiles = verifiedCompatibilityProfiles(activeProfiles, config);
    const selection = selectHighestPriorityProfile(
      verifiedProfiles.filter(({ profile }) => profileMatches(profile, input.compatibility)).map(({ profile }) => profile)
    );
    const matched = selection.status === "matched"
      ? verifiedProfiles.find(({ profile }) => profile.id === selection.profile.id)
      : undefined;
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    try {
      await db.insert(sessions).values({
        id,
        deviceId: input.deviceId,
        pairingPublicKey: input.pairingPublicKey,
        appVersion: input.appVersion,
        requestNonceHash: sha256(input.requestNonce),
        hostOs: input.hostOs,
        channel: "desktop",
        compatibility: input.compatibility,
        profileId: matched?.profile.id,
        supported: Boolean(matched),
        expiresAt
      });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ code: "SESSION_PROOF_REPLAYED" });
      throw error;
    }
    const desktopToken = await tokens.issueSessionToken({ audience: "desktop-session", subject: input.pairingPublicKey, sessionId: id, deviceId: input.deviceId });
    const checkoutToken = await tokens.issueSessionToken({ audience: "checkout", subject: id, sessionId: id, deviceId: input.deviceId });
    await audit(db, "session.created", {
      actor: input.deviceId,
      subjectId: id,
      payload: {
        supported: Boolean(matched),
        profileId: matched?.profile.id,
        profileSelection: selection.status
      }
    });
    return reply.code(201).send({
      sessionId: id,
      supported: Boolean(matched),
      profileId: matched?.profile.id ?? null,
      profile: matched?.signedDocument ?? null,
      profileSignature: matched?.signature ?? null,
      desktopToken,
      checkoutUrl: `${config.publicWebUrl}/checkout/${id}#token=${encodeURIComponent(checkoutToken)}`,
      expiresAt: expiresAt.toISOString()
    });
  });

  app.post("/v1/web/sessions", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = webSessionCreateSchema.parse(request.body);
    const developmentFixture = Boolean(input.developmentFixture)
      && config.developmentHardwareFixture
      && config.nodeEnv === "development"
      && isExactDevelopmentFixture(input.deviceId, input.compatibility);
    const developmentModified = !input.developmentFixture
      && config.developmentHardwareFixture
      && config.nodeEnv === "development"
      && isSafeDevelopmentModifiedScan(input.compatibility);
    if (input.developmentFixture && !developmentFixture) {
      return reply.code(403).send({ code: "DEVELOPMENT_FIXTURE_FORBIDDEN" });
    }
    if (Math.abs(Date.now() - Date.parse(input.createdAt)) > 5 * 60_000) {
      return reply.code(400).send({ code: "SESSION_PROOF_EXPIRED" });
    }
    const proofMessage = webSessionProofMessage(input);
    if (!verifyEd25519Base58({ publicKey: input.pairingPublicKey, signature: input.pairingProof, message: proofMessage })) {
      return reply.code(401).send({ code: "INVALID_PAIRING_PROOF", message: "Web pairing proof is invalid" });
    }
    const activeProfiles = developmentFixture || developmentModified ? [] : await db.select().from(compatibilityProfiles).where(eq(compatibilityProfiles.active, true));
    const verifiedProfiles = verifiedCompatibilityProfiles(activeProfiles, config);
    const selection = selectHighestPriorityProfile(
      verifiedProfiles.filter(({ profile }) => webProfileMatches(profile, input.compatibility)).map(({ profile }) => profile)
    );
    const matched = selection.status === "matched"
      ? verifiedProfiles.find(({ profile }) => profile.id === selection.profile.id)
      : undefined;
    const preflightBlockers = matched ? webPreflightBlockers(matched.profile, input.compatibility) : [];
    const profileId = developmentFixture ? DEVELOPMENT_FIXTURE_PROFILE_ID : developmentModified ? DEVELOPMENT_MODIFIED_PROFILE_ID : matched?.profile.id;
    const supported = developmentFixture || developmentModified || Boolean(matched && preflightBlockers.length === 0);
    const publicReleaseReady = config.installerMode === "public" && Boolean(profileId) && !developmentFixture && !developmentModified && Boolean(matched)
      ? await publicReleaseReadyForProfile(db, config, profileId!, input.appVersion)
      : false;
    const decision = buildWebSessionDecision({
      selection,
      snapshot: input.compatibility,
      installerMode: config.installerMode,
      preflightBlockers,
      developmentRecognized: developmentFixture || developmentModified,
      publicReleaseReady,
      installerNewStartsEnabled: config.installerNewStartsEnabled
    });
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + WEB_INSTALLER_SESSION_TTL_SECONDS * 1000);
    try {
      await db.insert(sessions).values({
        id,
        deviceId: input.deviceId,
        pairingPublicKey: input.pairingPublicKey,
        appVersion: input.appVersion,
        requestNonceHash: sha256(input.requestNonce),
        hostOs: "web",
        channel: "web",
        compatibility: input.compatibility,
        profileId,
        supported,
        expiresAt
      });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ code: "SESSION_PROOF_REPLAYED" });
      throw error;
    }
    const browserToken = await tokens.issueSessionToken({
      audience: "browser-checkout",
      subject: input.pairingPublicKey,
      sessionId: id,
      deviceId: input.deviceId,
      expiresAt
    });
    await audit(db, "session.created", { actor: input.deviceId, subjectId: id, payload: { channel: "web", supported, profileId, developmentFixture, developmentModified } });
    return reply.code(201).send({
      sessionId: id,
      supported,
      installationState: input.compatibility.installationState,
      destructiveAllowed: false,
      profileId: profileId ?? null,
      profile: matched?.signedDocument ?? null,
      profileSignature: matched?.signature ?? null,
      decision,
      browserToken,
      expiresAt: expiresAt.toISOString()
    });
  });

  // This endpoint intentionally returns no artifact URL or entitlement. It is
  // only a way for a Windows user whose first Fastboot picker is empty to
  // obtain the driver metadata from a release envelope the browser can verify
  // with the offline release key. An environment URL must never replace it.
  app.get("/v1/public/windows-fastboot-driver", async (_request, reply) => {
    if (config.installerMode !== "public") return reply.code(404).send({ code: "PUBLIC_INSTALLER_NOT_AVAILABLE" });
    const candidates = (await signedStableReleaseCandidates(db, config, "new_start"))
      .filter((release) => publicManifestEvidenceReady(release.manifest));
    const keyForDriver = (release: ActiveSignedStableRelease) => JSON.stringify(release.manifest.publicEvidence?.windowsFastbootDriver ?? null);
    const uniqueDrivers = new Set(candidates.map(keyForDriver));
    if (candidates.length === 0) return reply.code(404).send({ code: "PUBLIC_RELEASE_NOT_READY" });
    if (uniqueDrivers.size !== 1) return reply.code(409).send({ code: "WINDOWS_DRIVER_AMBIGUOUS" });
    const release = candidates[0]!;
    return {
      manifest: release.release.signedManifest,
      signature: release.release.signature
    };
  });

  app.post("/v1/public/activate", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    if (config.installerMode !== "public") {
      return reply.code(403).send({ code: config.installerMode === "scan_only" ? "COMPATIBILITY_CHECKER_ONLY" : "PUBLIC_INSTALLER_NOT_AVAILABLE" });
    }
    // The explicit resume route remains available to a boundary-crossed
    // handheld during a safety pause. This activation route is deliberately
    // closed before authentication so it can never mint/rebind a new start.
    if (!config.installerNewStartsEnabled) return reply.code(503).send({ code: "INSTALLER_NEW_STARTS_PAUSED" });
    const auth = await requireToken(request, tokens, "browser-checkout");
    const input = publicActivateSchema.parse(request.body);
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    if (!session || session.channel !== "web" || auth.sub !== session.pairingPublicKey) return reply.code(403).send({ code: "WEB_PAIRING_REQUIRED" });
    let license = await activeLicenseForDevice(db, session.deviceId);
    // A boundary-crossed device must retain its original release binding even
    // if a newer public release now serves the same profile. Do not route it
    // through the new-start availability check.
    if (license?.modificationStartedAt) {
      if (!hasInstallationBinding(license)) return reply.code(409).send({ code: "INSTALLATION_BINDING_MISSING" });
      const release = await activeSignedReleaseForInstallationBinding(db, config, installationBindingOf(license));
      if (!release || !evidenceReadyForResume(release.manifest)) return reply.code(409).send({ code: "RESUME_RELEASE_UNAVAILABLE" });
      const webInstallerToken = await tokens.issueSessionToken({
        audience: "web-installer", subject: license.id, sessionId: session.id, deviceId: session.deviceId, expiresAt: session.expiresAt
      });
      await audit(db, "public.resumed", {
        actor: session.deviceId,
        subjectId: license.id,
        payload: { profileId: license.installationProfileId, releaseVersion: license.installationReleaseVersion, source: "activate-existing" }
      });
      return reply.code(200).send({
        activation: "public_resume", resume: true, free: true, deviceBound: true, alreadyLicensed: true,
        licenseId: license.id, orderId: license.orderId, webInstallerToken,
        expiresInSeconds: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000))
      });
    }
    // All fresh activity—including an already-created free entitlement that
    // has not crossed the boundary—must be re-evaluated against the current
    // signed profile set. A later, higher-priority variant profile cannot be
    // bypassed with a stale universal-profile scan.
    const currentProfile = await revalidateCurrentWebProfile(db, config, session);
    if (!currentProfile || !session.profileId) return reply.code(409).send({ code: "SESSION_PROFILE_CHANGED" });
    if (!isPassingStockLockedWebSession(session, currentProfile.profile.id)) return reply.code(409).send({ code: "DESTRUCTIVE_TEST_MODE_BLOCKED" });
    const publicRelease = await activeSignedStableRelease(db, config, currentProfile.profile.id);
    if (!publicRelease || !publicManifestEvidenceReady(publicRelease.manifest)) {
      return reply.code(503).send({ code: "PUBLIC_RELEASE_NOT_READY" });
    }
    if (!installerVersionSatisfies(session.appVersion, publicRelease.manifest.minimumInstallerVersion)) {
      return reply.code(409).send({ code: "INSTALLER_UPDATE_REQUIRED" });
    }
    await enforceDistributedLimit(redis, `public-activate:ip:${request.ip}`, 10, 60 * 60);
    await enforceDistributedLimit(redis, `public-activate:device:${session.deviceId}`, 5, 60 * 60);

    let created = false;
    if (!license) {
      const orderId = randomUUID();
      const licenseId = randomUUID();
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${session.deviceId}, 0))`);
          const [existingLicense] = await tx.select({ id: licenses.id }).from(licenses).where(and(
            eq(licenses.deviceId, session.deviceId),
            eq(licenses.status, "active")
          )).limit(1);
          if (existingLicense) return;
          await tx.insert(orders).values({
            id: orderId,
            sessionId: session.id,
            deviceId: session.deviceId,
            wallet: session.pairingPublicKey,
            kind: "early_access",
            status: "free_activated",
            reference: randomSolanaAddress(),
            amountBaseUnits: 0n,
            mint: SOLANA_USDC_MINT,
            treasury: config.treasuryWallet,
            expiresAt: session.expiresAt
          });
          await tx.insert(devices).values({
            id: session.deviceId,
            profileId: currentProfile.profile.id,
            serialVerified: true,
            licensedAt: new Date()
          }).onConflictDoUpdate({
            target: devices.id,
            set: { profileId: currentProfile.profile.id, serialVerified: true, lastSeenAt: new Date(), licensedAt: new Date() }
          });
          await tx.insert(licenses).values({
            id: licenseId,
            deviceId: session.deviceId,
            orderId,
            receiptWallet: session.pairingPublicKey
          });
          created = true;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      license = await activeLicenseForDevice(db, session.deviceId);
    }
    if (!license) throw new Error("Public activation did not produce an active device entitlement");
    if (!license.modificationStartedAt) {
      await db.update(devices).set({
        profileId: currentProfile.profile.id,
        serialVerified: true,
        lastSeenAt: new Date(),
        licensedAt: new Date()
      }).where(eq(devices.id, session.deviceId));
    }
    const webInstallerToken = await tokens.issueSessionToken({
      audience: "web-installer",
      subject: license.id,
      sessionId: session.id,
      deviceId: session.deviceId,
      expiresAt: session.expiresAt
    });
    await audit(db, created ? "public.activated" : "public.resumed", {
      actor: session.deviceId,
      subjectId: license.id,
      payload: { orderId: license.orderId, profileId: currentProfile.profile.id }
    });
    return reply.code(created ? 201 : 200).send({
      activation: "public_free",
      free: true,
      deviceBound: true,
      alreadyLicensed: !created,
      licenseId: license.id,
      orderId: license.orderId,
      webInstallerToken,
      expiresInSeconds: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000))
    });
  });

  // A public installation can be resumed only after a destructive boundary
  // was already recorded for this same cross-mode-verified device. This route
  // deliberately accepts a post-unlock/modified scan: the authorization is
  // tied to the existing immutable release binding, not to a fresh install.
  app.post("/v1/public/resume", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    const auth = await requireToken(request, tokens, "browser-checkout");
    const input = publicResumeSchema.parse(request.body);
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    if (!session || session.channel !== "web" || auth.sub !== session.pairingPublicKey) {
      return reply.code(403).send({ code: "WEB_PAIRING_REQUIRED" });
    }
    if (!hasCrossModeWebScanProof(session)) return reply.code(409).send({ code: "DESTRUCTIVE_TEST_MODE_BLOCKED" });
    const license = await activeLicenseForDevice(db, session.deviceId);
    if (!license?.modificationStartedAt || !hasInstallationBinding(license)) {
      return reply.code(404).send({ code: "PUBLIC_RESUME_NOT_FOUND" });
    }
    const release = await activeSignedReleaseForInstallationBinding(db, config, installationBindingOf(license));
    if (!release || !evidenceReadyForResume(release.manifest)) {
      return reply.code(409).send({ code: "RESUME_RELEASE_UNAVAILABLE" });
    }
    const webInstallerToken = await tokens.issueSessionToken({
      audience: "web-installer",
      subject: license.id,
      sessionId: session.id,
      deviceId: session.deviceId,
      expiresAt: session.expiresAt
    });
    await audit(db, "public.resumed", {
      actor: session.deviceId,
      subjectId: license.id,
      payload: { profileId: license.installationProfileId, releaseVersion: license.installationReleaseVersion, source: "resume" }
    });
    return {
      activation: "public_resume",
      resume: true,
      licenseId: license.id,
      webInstallerToken,
      expiresInSeconds: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000))
    };
  });

  // A browser crash can leave the PSG1 in bootloader Fastbootd, where an ADB
  // scan cannot be restarted. The credential below is created only at the
  // irreversible boundary, lives only in the browser's same-origin persistent
  // journal, rotates on use, and restores only this exact signed binding.
  app.post("/v1/public/fastboot-resume", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    const input = fastbootResumeSchema.parse(request.body);
    const license = await activeLicenseForDevice(db, input.deviceId);
    const now = new Date();
    if (!license?.modificationStartedAt || !hasInstallationBinding(license)
      || !license.installationResumeCredentialDigest || !license.installationResumeCredentialExpiresAt
      || license.installationResumeCredentialExpiresAt <= now
      || !safeEqualHex(license.installationResumeCredentialDigest, sha256(input.resumeCredential))) {
      return reply.code(404).send({ code: "FASTBOOT_RESUME_NOT_FOUND" });
    }
    const release = await activeSignedReleaseForInstallationBinding(db, config, installationBindingOf(license));
    if (!release || !evidenceReadyForResume(release.manifest)) {
      return reply.code(409).send({ code: "RESUME_RELEASE_UNAVAILABLE" });
    }
    const resume = await rotateInstallationResumeCredential(db, license.id);
    const webInstallerToken = await tokens.issueSessionToken({
      audience: "web-installer-resume", subject: license.id, sessionId: `fastboot-resume:${license.id}`,
      deviceId: license.deviceId, expiresIn: "15m"
    });
    await audit(db, "public.resumed", {
      payload: { source: "durable-fastboot-resume", releaseVersion: license.installationReleaseVersion }
    });
    return {
      activation: "public_resume",
      resume: true,
      licenseId: license.id,
      webInstallerToken,
      resumeCredential: resume.credential,
      resumeCredentialExpiresAt: resume.expiresAt.toISOString(),
      expiresInSeconds: 15 * 60
    };
  });

  app.post("/v1/early-access/activate", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    if (installerBlockedInScanOnlyMode(config)) return reply.code(403).send({ code: "COMPATIBILITY_CHECKER_ONLY" });
    if (config.installerMode === "private_beta") return reply.code(403).send({ code: "BETA_CODE_REQUIRED" });
    // This legacy endpoint lacks the public release-evidence and stock-locked
    // checks above, so it must never become an alternate public entitlement.
    return reply.code(403).send({ code: "PUBLIC_ACTIVATION_REQUIRED" });
  });

  // A Discord code is intentionally not a generic coupon. It becomes bound
  // to the first supported physical PSG1 that redeems it inside this single
  // transaction, and can never be used again.
  app.post("/v1/beta/activate", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    if (installerBlockedInScanOnlyMode(config)) return reply.code(403).send({ code: "COMPATIBILITY_CHECKER_ONLY" });
    if (config.installerMode !== "private_beta") return reply.code(403).send({ code: "PRIVATE_BETA_MODE_REQUIRED" });
    if (!config.installerNewStartsEnabled) return reply.code(503).send({ code: "INSTALLER_NEW_STARTS_PAUSED" });
    const auth = await requireToken(request, tokens, "browser-checkout");
    const input = betaActivateSchema.parse(request.body);
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    if (!session?.supported) return reply.code(409).send({ code: "UNSUPPORTED_FIRMWARE" });
    if (session.channel !== "web" || auth.sub !== session.pairingPublicKey) return reply.code(403).send({ code: "WEB_PAIRING_REQUIRED" });
    const state = (session.compatibility as { installationState?: string }).installationState;
    if (state !== "stock_locked") return reply.code(409).send({ code: "DESTRUCTIVE_TEST_MODE_BLOCKED" });
    const releaseReadiness = await betaReleaseReadiness(db, config, session.profileId ?? undefined);
    if (!releaseReadiness) return reply.code(503).send({ code: "BETA_RELEASE_NOT_READY" });
    await enforceDistributedLimit(redis, `beta-code:ip:${request.ip}`, 10, 60 * 60);
    await enforceDistributedLimit(redis, `beta-code:device:${session.deviceId}`, 5, 60 * 60);

    let license = await activeLicenseForDevice(db, session.deviceId);
    let created = false;
    if (!license) {
      const orderId = randomUUID();
      const licenseId = randomUUID();
      const inviteDigest = sha256(input.betaInviteToken);
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${session.deviceId}, 0))`);
          const [existingLicense] = await tx.select({ id: licenses.id }).from(licenses).where(and(eq(licenses.deviceId, session.deviceId), eq(licenses.status, "active"))).limit(1);
          if (existingLicense) return;
          const boundInvite = await tx.update(betaInvites).set({ deviceId: session.deviceId }).where(and(
            eq(betaInvites.tokenDigest, inviteDigest),
            eq(betaInvites.enabled, true),
            gt(betaInvites.expiresAt, new Date()),
            isNull(betaInvites.redeemedAt),
            isNull(betaInvites.deviceId)
          )).returning({ id: betaInvites.id, kind: betaInvites.kind });
          const expectedInviteKind = releaseReadiness === "pilot" ? "hardware_pilot" : "cohort";
          if (!boundInvite.length || boundInvite[0]!.kind !== expectedInviteKind) throw apiError("BETA_INVITE_INVALID_OR_USED", 409);
          await tx.insert(promoCodes).values({
            codeHash: sha256(BETA_PROMO_CODE), label: "Discord browser beta", maxRedemptions: BETA_PROMO_LIMIT
          }).onConflictDoNothing();
          const counter = await tx.update(promoCodes).set({ redemptionCount: sql`${promoCodes.redemptionCount} + 1` }).where(and(
            eq(promoCodes.codeHash, sha256(BETA_PROMO_CODE)),
            eq(promoCodes.enabled, true),
            sql`${promoCodes.redemptionCount} < ${BETA_PROMO_LIMIT}`
          )).returning({ codeHash: promoCodes.codeHash });
          if (!counter.length) throw apiError("BETA_COHORT_FULL", 409);
          await tx.insert(orders).values({
            id: orderId, sessionId: session.id, deviceId: session.deviceId,
            wallet: session.pairingPublicKey, kind: "early_access", status: "free_activated",
            reference: randomSolanaAddress(), amountBaseUnits: 0n, mint: SOLANA_USDC_MINT,
            treasury: config.treasuryWallet, betaInviteTokenDigest: inviteDigest, expiresAt: session.expiresAt
          });
          await tx.update(betaInvites).set({ redeemedAt: new Date(), redeemedOrderId: orderId }).where(eq(betaInvites.id, boundInvite[0]!.id));
          await tx.insert(promoRedemptions).values({ id: randomUUID(), codeHash: sha256(BETA_PROMO_CODE), orderId, deviceId: session.deviceId, wallet: session.pairingPublicKey });
          if (!session.profileId) throw apiError("SESSION_PROFILE_MISSING", 409);
          await tx.insert(devices).values({ id: session.deviceId, profileId: session.profileId, serialVerified: true, licensedAt: new Date() })
            .onConflictDoUpdate({ target: devices.id, set: { profileId: session.profileId, serialVerified: true, lastSeenAt: new Date(), licensedAt: new Date() } });
          await tx.insert(licenses).values({ id: licenseId, deviceId: session.deviceId, orderId, receiptWallet: session.pairingPublicKey });
          created = true;
        });
      } catch (error) {
        if (isUniqueViolation(error)) return reply.code(409).send({ code: "DEVICE_ALREADY_LICENSED_OR_CODE_BOUND" });
        throw error;
      }
      license = await activeLicenseForDevice(db, session.deviceId);
    }
    if (!license) throw new Error("Beta activation did not produce a device entitlement");
    const webInstallerToken = await tokens.issueSessionToken({
      audience: "web-installer", subject: license.id, sessionId: session.id, deviceId: session.deviceId, expiresAt: session.expiresAt
    });
    await audit(db, created ? "beta.activated" : "beta.resumed", { actor: session.deviceId, subjectId: license.id, payload: { orderId: license.orderId } });
    return reply.code(created ? 201 : 200).send({ licenseId: license.id, orderId: license.orderId, webInstallerToken, expiresInSeconds: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)) });
  });

  // A device-bound beta entitlement may be resumed after a reload or USB
  // interruption without reusing the Discord code. The fresh browser session
  // still proves possession of the same cross-checked hardware identifier.
  app.post("/v1/beta/resume", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    if (installerBlockedInScanOnlyMode(config)) return reply.code(403).send({ code: "COMPATIBILITY_CHECKER_ONLY" });
    if (config.installerMode !== "private_beta") return reply.code(403).send({ code: "PRIVATE_BETA_MODE_REQUIRED" });
    const auth = await requireToken(request, tokens, "browser-checkout");
    const input = betaResumeSchema.parse(request.body);
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    if (!session?.supported || session.channel !== "web" || auth.sub !== session.pairingPublicKey) {
      return reply.code(403).send({ code: "WEB_PAIRING_REQUIRED" });
    }
    const license = await activeLicenseForDevice(db, session.deviceId);
    if (!license) return reply.code(404).send({ code: "BETA_ENTITLEMENT_NOT_FOUND" });
    const [order] = await db.select({ kind: orders.kind, betaInviteTokenDigest: orders.betaInviteTokenDigest }).from(orders).where(eq(orders.id, license.orderId)).limit(1);
    if (order?.kind !== "early_access" || !order.betaInviteTokenDigest) return reply.code(404).send({ code: "BETA_ENTITLEMENT_NOT_FOUND" });
    const webInstallerToken = await tokens.issueSessionToken({
      audience: "web-installer", subject: license.id, sessionId: session.id, deviceId: session.deviceId, expiresAt: session.expiresAt
    });
    await audit(db, "beta.resumed", { actor: session.deviceId, subjectId: license.id, payload: { orderId: license.orderId, source: "resume" } });
    return { licenseId: license.id, webInstallerToken, expiresInSeconds: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)) };
  });

  app.post("/v1/sessions/:id/browser-proof/challenge", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const checkout = await requireToken(request, tokens, "checkout");
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const input = browserProofChallengeRequestSchema.parse(request.body);
    if (checkout.sessionId !== id) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, id);
    if (!session?.supported) return reply.code(409).send({ code: "UNSUPPORTED_FIRMWARE" });
    if (session.browserVerifiedAt) return reply.send({ verified: true });
    const challengeId = randomUUID();
    const nonce = randomNonce();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const message = browserProofMessage({
      domain: new URL(config.publicWebUrl).host,
      challengeId,
      sessionId: session.id,
      deviceId: session.deviceId,
      pairingPublicKey: session.pairingPublicKey,
      browserNonceHash: sha256(input.browserNonce),
      nonce,
      expiresAt: expiresAt.toISOString()
    });
    await db.insert(browserPairingChallenges).values({ id: challengeId, sessionId: id, message, nonce, browserNonceHash: sha256(input.browserNonce), expiresAt });
    return reply.code(201).send({ challengeId, message, expiresAt: expiresAt.toISOString() });
  });

  app.post("/v1/sessions/:id/browser-proof/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const desktop = await requireToken(request, tokens, "desktop-session");
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const input = browserProofVerifySchema.parse(request.body);
    if (desktop.sessionId !== id) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const [challenge] = await db.select().from(browserPairingChallenges).where(and(
      eq(browserPairingChallenges.id, input.challengeId),
      eq(browserPairingChallenges.sessionId, id),
      gt(browserPairingChallenges.expiresAt, new Date()),
      isNull(browserPairingChallenges.consumedAt)
    )).limit(1);
    const session = await activeSession(db, id);
    if (!challenge || !session) return reply.code(401).send({ code: "BROWSER_PROOF_INVALID" });
    if (!verifyEd25519Base58({ publicKey: session.pairingPublicKey, signature: input.signature, message: challenge.message })) {
      return reply.code(401).send({ code: "BROWSER_PROOF_SIGNATURE_INVALID" });
    }
    const consumedAt = new Date();
    const consumed = await db.transaction(async (tx) => {
      const rows = await tx.update(browserPairingChallenges).set({ consumedAt }).where(and(
        eq(browserPairingChallenges.id, challenge.id),
        isNull(browserPairingChallenges.consumedAt)
      )).returning({ id: browserPairingChallenges.id });
      if (rows.length) await tx.update(sessions).set({ browserVerifiedAt: consumedAt }).where(eq(sessions.id, id));
      return rows;
    });
    if (!consumed.length) return reply.code(409).send({ code: "BROWSER_PROOF_ALREADY_USED" });
    await audit(db, "session.browser_verified", { actor: session.deviceId, subjectId: session.id });
    return { verified: true };
  });

  app.post("/v1/sessions/:id/browser-proof/status", async (request, reply) => {
    const checkout = await requireToken(request, tokens, "checkout");
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const input = browserProofStatusSchema.parse(request.body);
    if (checkout.sessionId !== id) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, id);
    if (!session) return reply.code(404).send({ code: "SESSION_INVALID" });
    const [challenge] = await db.select().from(browserPairingChallenges).where(and(
      eq(browserPairingChallenges.id, input.challengeId),
      eq(browserPairingChallenges.sessionId, id),
      gt(browserPairingChallenges.expiresAt, new Date())
    )).limit(1);
    if (!challenge || challenge.browserNonceHash !== sha256(input.browserNonce)) return reply.code(401).send({ code: "BROWSER_PROOF_INVALID" });
    if (!challenge.consumedAt || !session.browserVerifiedAt) return { verified: false };
    const browserToken = await tokens.issueSessionToken({
      audience: "browser-checkout", subject: challenge.id, sessionId: id, deviceId: session.deviceId, expiresIn: "15m"
    });
    return { verified: true, browserToken };
  });

  app.post("/v1/wallet/challenge", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const auth = await requireToken(request, tokens, "browser-checkout");
    const input = walletChallengeRequestSchema.parse(request.body);
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    if (!session?.supported) return reply.code(409).send({ code: "UNSUPPORTED_FIRMWARE" });
    if (session.channel === "desktop") {
      if (!session.browserVerifiedAt) return reply.code(403).send({ code: "LOCAL_DESKTOP_PROOF_REQUIRED" });
    } else if (session.channel === "web") {
      if (auth.sub !== session.pairingPublicKey) return reply.code(403).send({ code: "WEB_PAIRING_REQUIRED" });
    } else {
      return reply.code(403).send({ code: "SESSION_CHANNEL_INVALID" });
    }
    const id = randomUUID();
    const nonce = randomNonce();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const challengeInput = {
      domain: new URL(config.publicWebUrl).host,
      challengeId: id,
      sessionId: session.id,
      deviceId: session.deviceId,
      pairingPublicKey: session.pairingPublicKey,
      wallet: input.wallet,
      nonce,
      expiresAt: expiresAt.toISOString()
    };
    const message = session.channel === "web"
      ? webCheckoutWalletChallengeMessage(challengeInput)
      : walletChallengeMessage(challengeInput);
    await db.insert(walletChallenges).values({ id, sessionId: session.id, wallet: input.wallet, purpose: "checkout", message, nonce, expiresAt });
    return reply.code(201).send({ challengeId: id, message, expiresAt: expiresAt.toISOString() });
  });

  app.post("/v1/wallet/verify", async (request, reply) => {
    const checkout = await requireToken(request, tokens, "browser-checkout");
    const input = walletVerifySchema.parse(request.body);
    const [challenge] = await db.select().from(walletChallenges).where(and(
      eq(walletChallenges.id, input.challengeId),
      eq(walletChallenges.purpose, "checkout"),
      gt(walletChallenges.expiresAt, new Date())
    )).limit(1);
    if (!challenge || challenge.consumedAt || checkout.sessionId !== challenge.sessionId) {
      return reply.code(401).send({ code: "CHALLENGE_INVALID" });
    }
    if (!verifyEd25519Base58({ publicKey: challenge.wallet, signature: input.signature, message: challenge.message })) {
      return reply.code(401).send({ code: "WALLET_SIGNATURE_INVALID" });
    }
    const [session] = await db.select().from(sessions).where(eq(sessions.id, challenge.sessionId)).limit(1);
    if (!session) return reply.code(401).send({ code: "SESSION_INVALID" });
    const consumed = await db.update(walletChallenges).set({ consumedAt: new Date() }).where(and(eq(walletChallenges.id, challenge.id), isNull(walletChallenges.consumedAt))).returning({ id: walletChallenges.id });
    if (!consumed.length) return reply.code(409).send({ code: "CHALLENGE_ALREADY_USED" });
    const walletToken = await tokens.issueSessionToken({
      audience: "wallet",
      subject: challenge.wallet,
      sessionId: challenge.sessionId,
      deviceId: session.deviceId,
      wallet: challenge.wallet,
      expiresIn: "30m"
    });
    return { walletToken };
  });

  app.post("/v1/web/wizard/challenge", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (installerBlockedInScanOnlyMode(config)) return reply.code(403).send({ code: "COMPATIBILITY_CHECKER_ONLY" });
    const auth = await requireToken(request, tokens, "browser-checkout");
    const input = webInstallerChallengeRequestSchema.parse(request.body);
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    if (!session || session.channel !== "web" || auth.sub !== session.pairingPublicKey) {
      return reply.code(403).send({ code: "WEB_PAIRING_REQUIRED" });
    }
    const [order] = await db.select().from(orders).where(and(
      eq(orders.id, input.orderId),
      eq(orders.deviceId, session.deviceId),
      eq(orders.wallet, input.wallet),
      inArray(orders.status, ["paid", "promo_redeemed"])
    )).limit(1);
    if (!order) return reply.code(404).send({ code: "PAID_ORDER_NOT_FOUND" });
    const [license] = await db.select().from(licenses).where(and(
      eq(licenses.orderId, order.id),
      eq(licenses.deviceId, session.deviceId),
      eq(licenses.receiptWallet, input.wallet),
      eq(licenses.status, "active")
    )).limit(1);
    if (!license) return reply.code(403).send({ code: "ACTIVE_LICENSE_REQUIRED" });
    const challengeId = randomUUID();
    const nonce = randomNonce();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const message = webInstallerWalletChallengeMessage({
      domain: new URL(config.publicWebUrl).host,
      challengeId,
      sessionId: session.id,
      deviceId: session.deviceId,
      orderId: order.id,
      licenseId: license.id,
      wallet: input.wallet,
      nonce,
      expiresAt: expiresAt.toISOString()
    });
    await db.insert(walletChallenges).values({
      id: challengeId,
      sessionId: session.id,
      wallet: input.wallet,
      purpose: "web_installer",
      orderId: order.id,
      licenseId: license.id,
      message,
      nonce,
      expiresAt
    });
    return reply.code(201).send({ challengeId, message, expiresAt: expiresAt.toISOString() });
  });

  app.post("/v1/web/wizard/verify", async (request, reply) => {
    if (installerBlockedInScanOnlyMode(config)) return reply.code(403).send({ code: "COMPATIBILITY_CHECKER_ONLY" });
    const auth = await requireToken(request, tokens, "browser-checkout");
    const input = webInstallerVerifySchema.parse(request.body);
    const [challenge] = await db.select().from(walletChallenges).where(and(
      eq(walletChallenges.id, input.challengeId),
      eq(walletChallenges.purpose, "web_installer"),
      gt(walletChallenges.expiresAt, new Date()),
      isNull(walletChallenges.consumedAt)
    )).limit(1);
    if (!challenge || !challenge.orderId || !challenge.licenseId || auth.sessionId !== challenge.sessionId) {
      return reply.code(401).send({ code: "CHALLENGE_INVALID" });
    }
    const session = await activeSession(db, challenge.sessionId);
    if (!session || session.channel !== "web" || auth.sub !== session.pairingPublicKey) {
      return reply.code(403).send({ code: "WEB_PAIRING_REQUIRED" });
    }
    if (!verifyEd25519Base58({ publicKey: challenge.wallet, signature: input.signature, message: challenge.message })) {
      return reply.code(401).send({ code: "WALLET_SIGNATURE_INVALID" });
    }
    const [license] = await db.select().from(licenses).where(and(
      eq(licenses.id, challenge.licenseId),
      eq(licenses.orderId, challenge.orderId),
      eq(licenses.deviceId, session.deviceId),
      eq(licenses.receiptWallet, challenge.wallet),
      eq(licenses.status, "active")
    )).limit(1);
    const [order] = await db.select().from(orders).where(and(
      eq(orders.id, challenge.orderId),
      eq(orders.wallet, challenge.wallet),
      inArray(orders.status, ["paid", "promo_redeemed"])
    )).limit(1);
    if (!license || !order) return reply.code(403).send({ code: "ACTIVE_LICENSE_REQUIRED" });
    const consumed = await db.update(walletChallenges).set({ consumedAt: new Date() }).where(and(
      eq(walletChallenges.id, challenge.id),
      isNull(walletChallenges.consumedAt)
    )).returning({ id: walletChallenges.id });
    if (!consumed.length) return reply.code(409).send({ code: "CHALLENGE_ALREADY_USED" });
    const webInstallerToken = await tokens.issueSessionToken({
      audience: "web-installer",
      subject: license.id,
      sessionId: session.id,
      deviceId: session.deviceId,
      wallet: challenge.wallet,
      expiresIn: "10m"
    });
    await audit(db, "web_installer.authorized", { actor: challenge.wallet, subjectId: license.id, payload: { orderId: order.id } });
    return { webInstallerToken, licenseId: license.id, expiresInSeconds: 600 };
  });

  app.post("/v1/orders", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const auth = await requireToken(request, tokens, "wallet");
    const input = orderCreateSchema.parse(request.body);
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    if (!session?.supported) return reply.code(409).send({ code: "UNSUPPORTED_FIRMWARE" });
    await enforceDistributedLimit(redis, `orders:device:${session.deviceId}`, 5, 60 * 60);
    await enforceDistributedLimit(redis, `orders:wallet:${String(auth.wallet)}`, 5, 60 * 60);
    const existing = await activeLicenseForDevice(db, session.deviceId);
    if (existing) return reply.send({
      alreadyLicensed: true,
      licenseId: existing.id,
      ...(existing.receiptWallet === auth.wallet ? { orderId: existing.orderId } : { walletAuthorizationRequired: true })
    });

    const betaInviteDigest = input.betaInviteToken ? sha256(input.betaInviteToken) : null;
    if (betaInviteDigest) await enforceDistributedLimit(redis, `beta-invite:ip:${request.ip}`, 10, 60 * 60);
    if (!betaInviteDigest && (!config.publicSalesEnabled || !await publicSaleReady(db))) return reply.code(403).send({ code: "PUBLIC_SALES_DISABLED" });
    const id = randomUUID();
    const reference = randomSolanaAddress();
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${session.deviceId}, 0))`);
        if (betaInviteDigest) {
          const [invite] = await tx.select({ id: betaInvites.id }).from(betaInvites).where(and(
            eq(betaInvites.tokenDigest, betaInviteDigest),
            eq(betaInvites.deviceId, session.deviceId),
            eq(betaInvites.enabled, true),
            gt(betaInvites.expiresAt, new Date()),
            isNull(betaInvites.redeemedAt)
          )).limit(1);
          if (!invite) throw apiError("BETA_INVITE_INVALID", 400);
        }
        await tx.update(orders).set({ status: "expired" }).where(and(
          eq(orders.deviceId, session.deviceId),
          inArray(orders.status, ["awaiting_payment", "awaiting_promo"]),
          lt(orders.expiresAt, new Date())
        ));
        const [open] = await tx.select({ id: orders.id }).from(orders).where(and(
          eq(orders.deviceId, session.deviceId),
          inArray(orders.status, ["awaiting_payment", "awaiting_promo"])
        )).limit(1);
        if (open) throw apiError("DEVICE_CHECKOUT_IN_PROGRESS", 409);
        await tx.insert(orders).values({
          id,
          sessionId: session.id,
          deviceId: session.deviceId,
          wallet: String(auth.wallet),
          kind: betaInviteDigest ? "promo" : "paid",
          status: betaInviteDigest ? "awaiting_promo" : "awaiting_payment",
          reference,
          amountBaseUnits: betaInviteDigest ? 0n : USDC_AMOUNT_BASE_UNITS,
          mint: SOLANA_USDC_MINT,
          treasury: config.treasuryWallet,
          betaInviteTokenDigest: betaInviteDigest,
          expiresAt
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ code: "DEVICE_CHECKOUT_IN_PROGRESS" });
      throw error;
    }
    return reply.code(201).send({
      orderId: id,
      kind: betaInviteDigest ? "promo" : "paid",
      reference,
      amount: betaInviteDigest ? "0" : LICENSE_PRICE_USDC,
      amountBaseUnits: betaInviteDigest ? "0" : USDC_AMOUNT_BASE_UNITS.toString(),
      mint: SOLANA_USDC_MINT,
      treasury: TREASURY_WALLET,
      expiresAt: expiresAt.toISOString()
    });
  });

  app.post("/v1/orders/:id/verify", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const auth = await requireToken(request, tokens, "wallet");
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const input = orderVerifySchema.parse(request.body);
    await enforceDistributedLimit(redis, `payment-verify:order:${id}`, 30, 60);
    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order || order.wallet !== auth.wallet || order.sessionId !== auth.sessionId) return reply.code(404).send({ code: "ORDER_NOT_FOUND" });
    if (["paid", "promo_redeemed"].includes(order.status)) {
      const [bound] = await db.select({ id: licenses.id }).from(licenses).where(eq(licenses.orderId, order.id)).limit(1);
      if (!bound) throw new Error("Verified order is missing its atomic license");
      return { verified: true, orderId: order.id, licenseId: bound.id };
    }
    if (order.expiresAt <= new Date() || order.status === "expired") return reply.code(410).send({ code: "ORDER_EXPIRED" });

    const licenseId = randomUUID();
    if (order.kind === "promo") {
      const promoHash = sha256(BETA_PROMO_CODE);
      const inviteDigest = order.betaInviteTokenDigest;
      if (!inviteDigest) throw new Error("Beta order is missing its invite binding");
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${order.deviceId}, 0))`);
          const invite = await tx.update(betaInvites).set({ redeemedAt: new Date(), redeemedOrderId: order.id }).where(and(
            eq(betaInvites.tokenDigest, inviteDigest),
            eq(betaInvites.deviceId, order.deviceId),
            eq(betaInvites.enabled, true),
            gt(betaInvites.expiresAt, new Date()),
            isNull(betaInvites.redeemedAt)
          )).returning({ id: betaInvites.id });
          if (!invite.length) throw apiError("BETA_INVITE_INVALID_OR_USED", 409);
          const claimed = await tx.update(promoCodes).set({
            redemptionCount: sql`${promoCodes.redemptionCount} + 1`
          }).where(and(
            eq(promoCodes.codeHash, promoHash),
            eq(promoCodes.enabled, true),
            sql`${promoCodes.redemptionCount} < least(${promoCodes.maxRedemptions}, ${BETA_PROMO_LIMIT})`
          )).returning({ codeHash: promoCodes.codeHash });
          if (!claimed.length) throw apiError("PROMO_EXHAUSTED", 409);
          const transitioned = await tx.update(orders).set({ status: "promo_redeemed", paidAt: new Date() }).where(and(
            eq(orders.id, order.id), eq(orders.status, "awaiting_promo")
          )).returning({ id: orders.id });
          if (!transitioned.length) throw apiError("ORDER_ALREADY_VERIFIED", 409);
          await tx.insert(promoRedemptions).values({ id: randomUUID(), codeHash: promoHash, orderId: order.id, deviceId: order.deviceId, wallet: order.wallet });
          const [session] = await tx.select({ profileId: sessions.profileId }).from(sessions).where(eq(sessions.id, order.sessionId)).limit(1);
          if (!session?.profileId) throw apiError("SESSION_PROFILE_MISSING", 409);
          await tx.insert(devices).values({ id: order.deviceId, profileId: session.profileId, serialVerified: true, licensedAt: new Date() })
            .onConflictDoUpdate({ target: devices.id, set: { profileId: session.profileId, serialVerified: true, lastSeenAt: new Date(), licensedAt: new Date() } });
          await tx.insert(licenses).values({ id: licenseId, deviceId: order.deviceId, orderId: order.id, receiptWallet: order.wallet });
        });
      } catch (error) {
        if (isUniqueViolation(error)) return reply.code(409).send({ code: "DEVICE_ALREADY_LICENSED" });
        throw error;
      }
    } else {
      if (!input.transactionSignature) return reply.code(400).send({ code: "TRANSACTION_REQUIRED" });
      const verifiedPayment = await payments.verify({
        transactionSignature: input.transactionSignature,
        payer: order.wallet,
        treasury: order.treasury,
        reference: order.reference,
        mint: order.mint,
        amountBaseUnits: order.amountBaseUnits
      });
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${order.deviceId}, 0))`);
          const updated = await tx.update(orders).set({
            status: "paid",
            transactionSignature: input.transactionSignature,
            paymentSlot: verifiedPayment.slot,
            paymentBlockTime: verifiedPayment.blockTime ? new Date(verifiedPayment.blockTime * 1_000) : null,
            paidAt: new Date()
          }).where(and(eq(orders.id, order.id), eq(orders.status, "awaiting_payment"))).returning({ id: orders.id });
          if (!updated.length) throw apiError("ORDER_ALREADY_VERIFIED", 409);
          const [session] = await tx.select({ profileId: sessions.profileId }).from(sessions).where(eq(sessions.id, order.sessionId)).limit(1);
          if (!session?.profileId) throw apiError("SESSION_PROFILE_MISSING", 409);
          await tx.insert(devices).values({ id: order.deviceId, profileId: session.profileId, serialVerified: true, licensedAt: new Date() })
            .onConflictDoUpdate({ target: devices.id, set: { profileId: session.profileId, serialVerified: true, lastSeenAt: new Date(), licensedAt: new Date() } });
          await tx.insert(licenses).values({ id: licenseId, deviceId: order.deviceId, orderId: order.id, receiptWallet: order.wallet });
        });
      } catch (error) {
        if (isUniqueViolation(error)) return reply.code(409).send({ code: "PAYMENT_ALREADY_USED_OR_DEVICE_LICENSED" });
        throw error;
      }
    }
    await audit(db, "order.verified", { actor: order.wallet, subjectId: order.id, payload: { kind: order.kind } });
    await audit(db, "license.created", { actor: order.deviceId, subjectId: licenseId, payload: { orderId: order.id } });
    return { verified: true, orderId: order.id, licenseId };
  });

  app.post("/v1/licenses/:id/claim", async (request, reply) => {
    const auth = await requireToken(request, tokens, "desktop-session");
    const orderId = uuidSchema.parse((request.params as { id: string }).id);
    const input = licenseClaimSchema.parse(request.body);
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!session || !order || order.deviceId !== session.deviceId || !["paid", "promo_redeemed", "free_activated"].includes(order.status)) {
      return reply.code(409).send({ code: "ORDER_NOT_LICENSEABLE" });
    }
    const message = licenseClaimMessage({ orderId, sessionId: session.id, deviceId: session.deviceId });
    if (!verifyEd25519Base58({ publicKey: session.pairingPublicKey, signature: input.pairingProof, message })) {
      return reply.code(401).send({ code: "PAIRING_PROOF_INVALID" });
    }
    const license = await activeLicenseForDevice(db, session.deviceId);
    if (!license || license.orderId !== order.id) throw new Error("Verified order is missing its atomic license");
    if (license.recoveryCredentialDigest && !safeEqualHex(license.recoveryCredentialDigest, sha256(input.recoveryCredential))) {
      return reply.code(409).send({ code: "RECOVERY_CREDENTIAL_ALREADY_ISSUED" });
    }
    const firstClaim = await db.update(licenses).set({
      recoveryCredentialDigest: sha256(input.recoveryCredential),
      claimedAt: new Date()
    }).where(and(
      eq(licenses.id, license.id),
      isNull(licenses.recoveryCredentialDigest)
    )).returning({ id: licenses.id });
    const licenseToken = await tokens.issueLicenseToken({ licenseId: license.id, deviceId: license.deviceId, wallet: license.receiptWallet });
    await db.update(licenses).set({ tokenDigest: sha256(licenseToken), claimedAt: new Date() }).where(eq(licenses.id, license.id));
    await audit(db, "license.claimed", { actor: session.deviceId, subjectId: license.id });
    return {
      licenseId: license.id,
      deviceId: license.deviceId,
      licenseToken,
      status: license.status,
      entitlement: "all-releases",
      recoveryCredential: firstClaim.length ? input.recoveryCredential : undefined,
      receipt: receiptFromOrder(order, license.modificationStartedAt)
    };
  });

  app.get("/v1/devices/:deviceId/entitlement", async (request, reply) => {
    const auth = await requireToken(request, tokens, "desktop-session");
    const deviceId = deviceIdSchema.parse((request.params as { deviceId: string }).deviceId);
    if (auth.deviceId !== deviceId) return reply.code(403).send({ code: "DEVICE_MISMATCH" });
    const license = await activeLicenseForDevice(db, deviceId);
    if (!license) return reply.code(404).send({ licensed: false });
    return {
      licensed: true,
      licenseId: license.id,
      deviceId,
      status: license.status,
      recoveryRequired: true
    };
  });

  app.post("/v1/devices/:deviceId/entitlement/recover", async (request, reply) => {
    const auth = await requireToken(request, tokens, "desktop-session");
    const deviceId = deviceIdSchema.parse((request.params as { deviceId: string }).deviceId);
    const input = entitlementRecoverySchema.parse(request.body);
    if (auth.deviceId !== deviceId) return reply.code(403).send({ code: "DEVICE_MISMATCH" });
    await enforceDistributedLimit(redis, `recovery:device:${deviceId}`, 10, 60 * 60);
    const license = await activeLicenseForDevice(db, deviceId);
    if (!license?.recoveryCredentialDigest || !safeEqualHex(license.recoveryCredentialDigest, sha256(input.recoveryCredential))) {
      return reply.code(401).send({ code: "RECOVERY_CREDENTIAL_INVALID" });
    }
    const licenseToken = await tokens.issueLicenseToken({ licenseId: license.id, deviceId, wallet: license.receiptWallet });
    const [order] = await db.select().from(orders).where(eq(orders.id, license.orderId)).limit(1);
    if (!order) throw new Error("License receipt order is missing");
    await db.update(licenses).set({ tokenDigest: sha256(licenseToken), claimedAt: new Date() }).where(eq(licenses.id, license.id));
    await audit(db, "license.recovered", { actor: deviceId, subjectId: license.id });
    return {
      licensed: true,
      licenseId: license.id,
      deviceId,
      licenseToken,
      status: license.status,
      entitlement: "all-releases",
      receipt: receiptFromOrder(order, license.modificationStartedAt)
    };
  });

  app.post("/v1/licenses/:id/installation-started", async (request, reply) => {
    const { auth, session } = await requireActiveWebInstallerAccess(request, tokens, db);
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const acknowledgement = installationStartSchema.parse(request.body);
    if (auth.sub !== id) return reply.code(403).send({ code: "LICENSE_MISMATCH" });
    const [current] = await db.select().from(licenses).where(and(eq(licenses.id, id), eq(licenses.status, "active"))).limit(1);
    if (!current || auth.deviceId !== current.deviceId) return reply.code(404).send({ code: "LICENSE_NOT_FOUND" });
    const [device] = await db.select({ profileId: devices.profileId }).from(devices).where(eq(devices.id, current.deviceId)).limit(1);

    // Repeated calls after the irreversible boundary are not new starts. They
    // only succeed if the client presents exactly the already-bound signed
    // profile/release/artifact map, which keeps an emergency pause resumable.
    if (current.modificationStartedAt) {
      if (!hasInstallationBinding(current)) return reply.code(409).send({ code: "INSTALLATION_BINDING_MISSING" });
      if (!installationBindingMatchesStartInput(installationBindingOf(current), acknowledgement)) {
        return reply.code(409).send({ code: "INSTALLATION_BINDING_MISMATCH" });
      }
      const release = await activeSignedReleaseForInstallationBinding(db, config, installationBindingOf(current));
      if (!release || !evidenceReadyForResume(release.manifest)) return reply.code(409).send({ code: "RESUME_RELEASE_UNAVAILABLE" });
      const resume = await rotateInstallationResumeCredential(db, current.id);
      return {
        modificationStartedAt: current.modificationStartedAt.toISOString(), resumed: true,
        resumeCredential: resume.credential, resumeCredentialExpiresAt: resume.expiresAt.toISOString()
      };
    }

    if (!session) return reply.code(403).send({ code: "INSTALLER_SESSION_REQUIRED" });
    if (installerBlockedInScanOnlyMode(config)) return reply.code(403).send({ code: "COMPATIBILITY_CHECKER_ONLY" });
    if (!config.installerNewStartsEnabled) return reply.code(503).send({ code: "INSTALLER_NEW_STARTS_PAUSED" });
    const currentProfile = await revalidateCurrentWebProfile(db, config, session);
    if (!currentProfile || currentProfile.profile.id !== acknowledgement.profileId) {
      return reply.code(409).send({ code: "SESSION_PROFILE_CHANGED" });
    }
    if (!isPassingStockLockedWebSession(session, currentProfile.profile.id)
      || !device?.profileId || device.profileId !== acknowledgement.profileId) {
      return reply.code(409).send({ code: "DESTRUCTIVE_TEST_MODE_BLOCKED" });
    }
    const release = await activeSignedStableRelease(db, config, acknowledgement.profileId);
    if (!release || !releaseBindingMatchesStart(release, acknowledgement)) {
      return reply.code(409).send({ code: "INSTALLATION_RELEASE_MISMATCH" });
    }
    if (!installerVersionSatisfies(session.appVersion, release.manifest.minimumInstallerVersion)) {
      return reply.code(409).send({ code: "INSTALLER_UPDATE_REQUIRED" });
    }
    if (config.installerMode === "public" && !publicManifestEvidenceReady(release.manifest)) {
      return reply.code(503).send({ code: "PUBLIC_RELEASE_NOT_READY" });
    }
    if (config.installerMode === "private_beta" && !betaManifestEvidenceReady(release.manifest)) {
      return reply.code(503).send({ code: "BETA_RELEASE_NOT_READY" });
    }
    const manifestSha256 = canonicalSignedManifestSha256(release);
    if (!manifestSha256) return reply.code(409).send({ code: "INSTALLATION_RELEASE_MISMATCH" });
    const resume = newInstallationResumeCredential();
    const resumeExpiresAt = new Date(Date.now() + INSTALLATION_RESUME_CREDENTIAL_TTL_SECONDS * 1000);
    const result = await db.update(licenses).set({
      modificationStartedAt: new Date(),
      installationProfileId: acknowledgement.profileId,
      installationProfileDocument: currentProfile.signedDocument,
      installationProfileSignature: currentProfile.signature,
      installationReleaseId: release.release.id,
      installationReleaseVersion: acknowledgement.releaseVersion,
      installationManifestSha256: manifestSha256,
      installationArtifactHashes: acknowledgement.artifactHashes,
      installationResumeCredentialDigest: sha256(resume),
      installationResumeCredentialExpiresAt: resumeExpiresAt
    }).where(and(eq(licenses.id, id), eq(licenses.status, "active"), isNull(licenses.modificationStartedAt))).returning();
    if (!result.length) return reply.code(409).send({ code: "INSTALLATION_BOUNDARY_RACE" });
    await audit(db, "installation.started", {
      actor: String(auth.deviceId), subjectId: id,
      payload: { termsVersion: acknowledgement.termsVersion, irreversibleRiskAcknowledged: true }
    });
    return {
      modificationStartedAt: result[0]!.modificationStartedAt?.toISOString(),
      resumeCredential: resume,
      resumeCredentialExpiresAt: resumeExpiresAt.toISOString()
    };
  });

  // Persist each write-ahead state independently. A browser may crash between
  // USB transfers; retaining `intent` and `sent` lets resume treat that step
  // as indeterminate instead of assuming a flash or unlock completed.
  app.post("/v1/licenses/:id/installation-journal", async (request, reply) => {
    const { auth } = await requireActiveWebInstallerAccess(request, tokens, db);
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const entry = installationJournalEntrySchema.parse(request.body);
    if (auth.sub !== id) return reply.code(403).send({ code: "LICENSE_MISMATCH" });
    const [license] = await db.select().from(licenses).where(and(eq(licenses.id, id), eq(licenses.status, "active"))).limit(1);
    if (!license || license.deviceId !== auth.deviceId) return reply.code(404).send({ code: "LICENSE_NOT_FOUND" });
    if (!license.modificationStartedAt || !hasInstallationBinding(license)) {
      return reply.code(409).send({ code: "INSTALLATION_NOT_STARTED" });
    }
    const binding = installationBindingOf(license);
    if (!installationBindingMatchesInput(binding, entry)) {
      return reply.code(409).send({ code: "INSTALLATION_BINDING_MISMATCH" });
    }
    const release = await activeSignedReleaseForInstallationBinding(db, config, binding);
    if (!release || !evidenceReadyForResume(release.manifest)) {
      return reply.code(409).send({ code: "RESUME_RELEASE_UNAVAILABLE" });
    }
    // The state-machine read/validate/write is serialised per installation.
    // Without this lock, two restored tabs could validate against the same
    // last record and append divergent commands that share a timestamp.
    const journalWrite = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${license.id}, 0))`);
      const [previous] = await tx.select({
        sequence: installationJournalEntries.sequence,
        stage: installationJournalEntries.stage,
        operation: installationJournalEntries.operation,
        operationState: installationJournalEntries.operationState,
        operationIndex: installationJournalEntries.operationIndex,
        operationCount: installationJournalEntries.operationCount
      }).from(installationJournalEntries).where(eq(installationJournalEntries.licenseId, license.id))
        .orderBy(desc(installationJournalEntries.sequence)).limit(1);
      const transitionError = validateInstallationJournalTransition(previous ?? null, entry);
      if (transitionError) return { transitionError };
      const createdAt = new Date();
      const sequence = (previous?.sequence ?? 0) + 1;
      await tx.insert(installationJournalEntries).values({
        id: randomUUID(),
        sequence,
        licenseId: license.id,
        deviceId: license.deviceId,
        profileId: entry.profileId,
        releaseVersion: entry.releaseVersion,
        artifactHashes: entry.artifactHashes,
        stage: entry.stage,
        operation: entry.operation,
        operationState: entry.operationState,
        operationIndex: entry.operationIndex,
        operationCount: entry.operationCount,
        createdAt
      });
      return { createdAt, sequence };
    });
    if ("transitionError" in journalWrite) {
      return reply.code(409).send({ code: "JOURNAL_TRANSITION_INVALID", message: journalWrite.transitionError });
    }
    await audit(db, "installation.journaled", {
      actor: license.deviceId,
      subjectId: license.id,
      payload: {
        stage: entry.stage, operation: entry.operation, operationState: entry.operationState,
        operationIndex: entry.operationIndex, operationCount: entry.operationCount, sequence: journalWrite.sequence, releaseVersion: entry.releaseVersion
      }
    });
    return reply.code(202).send({ recordedAt: journalWrite.createdAt.toISOString(), sequence: journalWrite.sequence });
  });

  app.get("/v1/licenses/:id/installation-journal", async (request, reply) => {
    const { auth } = await requireActiveWebInstallerAccess(request, tokens, db);
    const id = uuidSchema.parse((request.params as { id: string }).id);
    if (auth.sub !== id) return reply.code(403).send({ code: "LICENSE_MISMATCH" });
    const [license] = await db.select().from(licenses).where(and(eq(licenses.id, id), eq(licenses.status, "active"))).limit(1);
    if (!license || license.deviceId !== auth.deviceId) return reply.code(404).send({ code: "LICENSE_NOT_FOUND" });
    if (!license.modificationStartedAt || !hasInstallationBinding(license)) {
      return reply.code(409).send({ code: "INSTALLATION_NOT_STARTED" });
    }
    const [entry] = await db.select({
      sequence: installationJournalEntries.sequence,
      deviceId: installationJournalEntries.deviceId,
      profileId: installationJournalEntries.profileId,
      releaseVersion: installationJournalEntries.releaseVersion,
      artifactHashes: installationJournalEntries.artifactHashes,
      stage: installationJournalEntries.stage,
      operation: installationJournalEntries.operation,
      operationState: installationJournalEntries.operationState,
      operationIndex: installationJournalEntries.operationIndex,
      operationCount: installationJournalEntries.operationCount,
      createdAt: installationJournalEntries.createdAt
    }).from(installationJournalEntries).where(eq(installationJournalEntries.licenseId, license.id))
      .orderBy(desc(installationJournalEntries.sequence)).limit(1);
    return entry ? {
      entry: {
        ...entry,
        updatedAt: entry.createdAt.toISOString()
      }
    } : { entry: null };
  });

  app.post("/v1/licenses/:id/refunds", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ code: "LICENSE_REQUIRED" });
    const auth = await tokens.verifyLicenseToken(token);
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const input = refundRequestSchema.parse(request.body);
    const [license] = await db.select().from(licenses).where(eq(licenses.id, id)).limit(1);
    if (!license || license.status !== "active" || auth.sub !== id || auth.deviceId !== license.deviceId) return reply.code(404).send({ code: "LICENSE_NOT_FOUND" });
    const [order] = await db.select().from(orders).where(eq(orders.id, license.orderId)).limit(1);
    if (order?.kind !== "paid") return reply.code(409).send({ code: "FREE_ACCESS_HAS_NO_REFUND_VALUE" });
    const refundId = randomUUID();
    const isReview = Boolean(license.modificationStartedAt);
    if (isReview && input.category !== "suspected_incompatibility") {
      return reply.code(409).send({ code: "NORMAL_REFUND_WINDOW_CLOSED", message: "Only verified incompatibility can be reviewed after installation begins" });
    }
    try {
      await db.transaction(async (tx) => {
        if (!isReview) {
          const transitioned = await tx.update(licenses).set({ status: "refund_pending" }).where(and(
            eq(licenses.id, id), eq(licenses.status, "active"), isNull(licenses.modificationStartedAt)
          )).returning({ id: licenses.id });
          if (!transitioned.length) throw apiError("REFUND_BOUNDARY_CLOSED", 409);
        }
        await tx.insert(refunds).values({
          id: refundId,
          licenseId: id,
          reason: sanitizeText(input.reason),
          status: isReview ? "incompatibility_review" : "requested"
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ code: "REFUND_ALREADY_REQUESTED" });
      throw error;
    }
    await audit(db, "refund.requested", { actor: license.deviceId, subjectId: refundId });
    return reply.code(202).send({
      refundId,
      status: isReview ? "incompatibility_review" : "requested",
      normalRefundEligible: !isReview,
      licenseSuspended: !isReview
    });
  });

  app.get("/v1/releases/stable", async (request, reply) => {
    const { auth, session } = await requireActiveWebInstallerAccess(request, tokens, db);
    const license = await activeLicenseForDevice(db, String(auth.deviceId));
    if (!license || license.id !== auth.sub) return reply.code(403).send({ code: "LICENSE_INACTIVE" });
    const isResume = Boolean(license.modificationStartedAt);
    // Scan-only is both the initial public posture and the runtime emergency
    // switch. It denies new downloads but leaves an authenticated, already
    // started device able to retrieve only its exact signed release.
    if (installerBlockedInScanOnlyMode(config) && !isResume) {
      return reply.code(403).send({ code: "COMPATIBILITY_CHECKER_ONLY" });
    }
    const [device] = await db.select().from(devices).where(eq(devices.id, license.deviceId)).limit(1);
    if (config.developmentHardwareFixture && config.nodeEnv === "development" && license.deviceId === DEVELOPMENT_FIXTURE_DEVICE_ID) {
      return {
        manifest: { version: "development-fixture", channel: "diagnostics-only", artifacts: [] },
        signature: "development-only-no-release-signature",
        profile: { id: DEVELOPMENT_FIXTURE_PROFILE_ID, mode: "simulated-stock-locked" },
        profileSignature: "development-only-no-profile-signature",
        downloadUrls: {},
        destructiveAllowed: false
      };
    }
    if (config.developmentHardwareFixture && config.nodeEnv === "development" && device?.profileId === DEVELOPMENT_MODIFIED_PROFILE_ID) {
      return {
        manifest: { version: "development-modified-safe-test", channel: "diagnostics-only", artifacts: [] },
        signature: "development-only-no-release-signature",
        profile: { id: DEVELOPMENT_MODIFIED_PROFILE_ID, mode: "already-modified-safe-test" },
        profileSignature: "development-only-no-profile-signature",
        downloadUrls: {},
        destructiveAllowed: false
      };
    }
    let currentProfile: VerifiedCompatibilityProfile | null = null;
    if (!isResume) {
      if (!session) return reply.code(403).send({ code: "INSTALLER_SESSION_REQUIRED" });
      if (!config.installerNewStartsEnabled) return reply.code(503).send({ code: "INSTALLER_NEW_STARTS_PAUSED" });
      currentProfile = await revalidateCurrentWebProfile(db, config, session);
      if (!currentProfile || !device?.profileId || device.profileId !== currentProfile.profile.id) {
        return reply.code(409).send({ code: "SESSION_PROFILE_CHANGED" });
      }
      if (!isPassingStockLockedWebSession(session, currentProfile.profile.id)) {
        return reply.code(409).send({ code: "DESTRUCTIVE_TEST_MODE_BLOCKED" });
      }
    }
    const profileId = isResume
      ? (hasInstallationBinding(license) ? license.installationProfileId : undefined)
      : currentProfile?.profile.id;
    if (!profileId) return reply.code(409).send({ code: isResume ? "INSTALLATION_BINDING_MISSING" : "DEVICE_PROFILE_MISSING" });
    const verifiedProfile = isResume
      ? frozenInstallationProfile(license, config)
      : currentProfile ?? undefined;
    if (!verifiedProfile || verifiedProfile.profile.id !== profileId) return reply.code(409).send({ code: "DEVICE_PROFILE_INACTIVE" });
    const release = isResume
      ? await activeSignedReleaseForInstallationBinding(db, config, installationBindingOf(license))
      : await activeSignedStableRelease(db, config, verifiedProfile.profile.id);
    if (!release) return reply.code(isResume ? 409 : 404).send({ code: isResume ? "RESUME_RELEASE_UNAVAILABLE" : "NO_STABLE_RELEASE" });
    if (!isResume && !installerVersionSatisfies(session?.appVersion ?? "", release.manifest.minimumInstallerVersion)) {
      return reply.code(409).send({ code: "INSTALLER_UPDATE_REQUIRED" });
    }
    const manifest = release.manifest;
    if (!manifest.profileIds.includes(verifiedProfile.profile.id)) return reply.code(409).send({ code: "RELEASE_PROFILE_UNSUPPORTED" });
    if (isResume && !evidenceReadyForResume(manifest)) return reply.code(409).send({ code: "RESUME_RELEASE_UNAVAILABLE" });
    if (!isResume && config.installerMode === "private_beta" && !betaManifestEvidenceReady(manifest)) return reply.code(503).send({ code: "BETA_RELEASE_NOT_READY" });
    if (!isResume && config.installerMode === "public" && !publicManifestEvidenceReady(manifest)) return reply.code(503).send({ code: "PUBLIC_RELEASE_NOT_READY" });
    const privateArtifacts = manifest.artifacts.filter((artifact) => artifact.delivery === "private");
    const downloadUrls = Object.fromEntries(await Promise.all(privateArtifacts.map(async (artifact) => [
      artifact.objectKey,
      await storage.signedDownloadUrl(artifact.objectKey)
    ])));
    return {
      manifest: release.release.signedManifest,
      signature: release.release.signature,
      profile: verifiedProfile.signedDocument,
      profileSignature: verifiedProfile.signature,
      downloadUrls
    };
  });

  app.post("/v1/compatibility-reports", async (request, reply) => {
    const auth = await requireCompatibilityReportToken(request, tokens);
    const input = compatibilityReportSchema.parse(request.body);
    if (!compatibilityReportConsentGranted(input)) {
      return reply.code(400).send({ code: "COMPATIBILITY_REPORT_CONSENT_REQUIRED" });
    }
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    if (!session) return reply.code(404).send({ code: "SESSION_INVALID" });
    if (session.supported) return reply.code(409).send({ code: "FIRMWARE_ALREADY_SUPPORTED" });
    const id = randomUUID();
    const reportToken = randomNonce();
    await db.insert(compatibilityReports).values({
      id,
      sessionId: input.sessionId,
      profileCandidate: sanitizeTelemetryRecord(input.profileCandidate),
      consentToNotify: input.consentToNotify,
      reportTokenDigest: sha256(reportToken)
    });
    return reply.code(202).send({ reportId: id, reportToken, status: "pending" });
  });

  app.get("/v1/compatibility-reports/:id", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ code: "REPORT_TOKEN_REQUIRED" });
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const [report] = await db.select({
      tokenDigest: compatibilityReports.reportTokenDigest,
      status: compatibilityReports.status,
      matchedProfileId: compatibilityReports.matchedProfileId,
      reviewedAt: compatibilityReports.reviewedAt
    }).from(compatibilityReports).where(eq(compatibilityReports.id, id)).limit(1);
    if (!report || !safeEqualHex(report.tokenDigest, sha256(token))) return reply.code(404).send({ code: "REPORT_NOT_FOUND" });
    return {
      reportId: id,
      status: report.status,
      matchedProfileId: report.matchedProfileId,
      reviewedAt: report.reviewedAt?.toISOString() ?? null
    };
  });

  app.post("/v1/crashes", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    if (!config.crashReportsEnabled) return reply.code(404).send();
    const input = crashReportSchema.parse(request.body);
    await enforceDistributedLimit(redis, `crash:install:${input.installId}`, 10, 60 * 60);
    const id = randomUUID();
    await db.insert(crashReports).values({
      id,
      ...input,
      architecture: sanitizeText(input.architecture),
      stage: sanitizeText(input.stage),
      errorCode: sanitizeText(input.errorCode),
      stack: input.stack ? sanitizeText(input.stack) : null
    });
    return reply.code(202).send({ reportId: id });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error && typeof error === "object" && "issues" in error) {
      const issues = Array.isArray(error.issues) ? error.issues : [];
      const paths = [...new Set(issues.map((issue) => {
        if (!issue || typeof issue !== "object" || !("path" in issue) || !Array.isArray(issue.path)) return "request";
        return issue.path.map(String).join(".") || "request";
      }))].slice(0, 5);
      const suffix = paths.length ? `: ${paths.join(", ")}` : "";
      return reply.code(400).send({ code: "INVALID_REQUEST", message: `Request validation failed${suffix}` });
    }
    app.log.error({ err: error }, "request failed");
    const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "REQUEST_FAILED";
    return reply.code(statusCode < 500 ? statusCode : 500).send({ code, message: statusCode < 500 && error instanceof Error ? error.message : "Request failed" });
  });
  return app;
}

async function requireToken(request: FastifyRequest, tokens: TokenService, audience: "desktop-session" | "checkout" | "browser-checkout" | "wallet" | "web-installer") {
  const token = bearerToken(request.headers.authorization);
  if (!token) throw Object.assign(new Error("Authorization required"), { statusCode: 401 });
  return tokens.verifySessionToken(token, audience);
}

async function requireCompatibilityReportToken(request: FastifyRequest, tokens: TokenService) {
  const token = bearerToken(request.headers.authorization);
  if (!token) throw Object.assign(new Error("Authorization required"), { statusCode: 401 });
  try {
    return await tokens.verifySessionToken(token, "desktop-session");
  } catch {
    return tokens.verifySessionToken(token, "browser-checkout");
  }
}

async function requireActiveWebInstallerAccess(request: FastifyRequest, tokens: TokenService, db: Database) {
  const token = bearerToken(request.headers.authorization);
  if (!token) throw Object.assign(new Error("License authorization required"), { statusCode: 401, code: "LICENSE_REQUIRED" });
  let auth;
  let durableResume = false;
  try {
    auth = await tokens.verifySessionToken(token, "web-installer");
  } catch {
    try {
      auth = await tokens.verifySessionToken(token, "web-installer-resume");
      durableResume = true;
    } catch {
      throw Object.assign(new Error("Installer authorization is invalid or expired"), { statusCode: 401, code: "INSTALLER_AUTH_INVALID" });
    }
  }
  const sessionId = typeof auth.sessionId === "string" ? auth.sessionId : "";
  const deviceId = typeof auth.deviceId === "string" ? auth.deviceId : "";
  if (durableResume) {
    if (!deviceId || typeof auth.sub !== "string" || !auth.sub) {
      throw Object.assign(new Error("Installer resume authorization is invalid"), { statusCode: 401, code: "INSTALLER_AUTH_INVALID" });
    }
    return { auth, session: null, durableResume: true };
  }
  const session = sessionId ? await activeSession(db, sessionId) : undefined;
  if (!session || session.channel !== "web" || session.deviceId !== deviceId) {
    throw Object.assign(new Error("A fresh PSG1 browser scan is required before installation can continue"), { statusCode: 403, code: "INSTALLER_SESSION_REQUIRED" });
  }
  return { auth, session, durableResume: false };
}

type VerifiedCompatibilityProfile = {
  profile: CompatibilityProfile;
  signedDocument: unknown;
  signature: string;
};

function verifiedCompatibilityProfiles(
  rows: Array<typeof compatibilityProfiles.$inferSelect>,
  config: Config
): VerifiedCompatibilityProfile[] {
  return rows.flatMap((row) => {
    if (!row.signedDocument || typeof row.signedDocument !== "object" || Array.isArray(row.signedDocument)) return [];
    const parsed = compatibilityProfileSchema.safeParse({ ...row.signedDocument, signature: row.signature });
    if (!parsed.success
      || parsed.data.id !== row.id
      || !verifySignedDocument(row.signedDocument, row.signature, config.releasePublicKeyPem)) return [];
    return [{ profile: parsed.data, signedDocument: row.signedDocument, signature: row.signature }];
  });
}

function frozenInstallationProfile(
  license: typeof licenses.$inferSelect,
  config: Config
): VerifiedCompatibilityProfile | null {
  if (!hasInstallationBinding(license)
    || !license.installationProfileDocument
    || typeof license.installationProfileDocument !== "object"
    || Array.isArray(license.installationProfileDocument)
    || typeof license.installationProfileSignature !== "string") return null;
  const parsed = compatibilityProfileSchema.safeParse({
    ...license.installationProfileDocument,
    signature: license.installationProfileSignature
  });
  if (!parsed.success
    || parsed.data.id !== license.installationProfileId
    || !verifySignedDocument(license.installationProfileDocument, license.installationProfileSignature, config.releasePublicKeyPem)) {
    return null;
  }
  return {
    profile: parsed.data,
    signedDocument: license.installationProfileDocument,
    signature: license.installationProfileSignature
  };
}

/**
 * A web scan records the observed snapshot, not an everlasting profile
 * decision. Before any new entitlement, artifact download, or destructive
 * boundary we select the unique highest-priority *current* signed profile
 * again. This lets a reviewed variant override the universal profile without
 * a stale browser session bypassing its tighter constraints.
 */
async function revalidateCurrentWebProfile(
  db: Database,
  config: Config,
  session: typeof sessions.$inferSelect
): Promise<VerifiedCompatibilityProfile | null> {
  if (session.channel !== "web" || !session.profileId) return null;
  const snapshot = webCompatibilitySnapshotSchema.safeParse(session.compatibility);
  if (!snapshot.success) return null;
  const rows = await db.select().from(compatibilityProfiles).where(eq(compatibilityProfiles.active, true));
  const verified = verifiedCompatibilityProfiles(rows, config);
  const selection = selectHighestPriorityProfile(
    verified.filter(({ profile }) => webProfileMatches(profile, snapshot.data)).map(({ profile }) => profile)
  );
  if (selection.status !== "matched" || selection.profile.id !== session.profileId) return null;
  const matched = verified.find(({ profile }) => profile.id === selection.profile.id);
  if (!matched || webPreflightBlockers(matched.profile, snapshot.data).length) return null;
  return matched;
}

type WebSessionDecisionInput = {
  selection: ProfileSelection;
  snapshot: WebCompatibilitySnapshot;
  installerMode: Config["installerMode"];
  preflightBlockers: string[];
  developmentRecognized: boolean;
  publicReleaseReady: boolean;
  installerNewStartsEnabled: boolean;
};

export function buildWebSessionDecision(input: WebSessionDecisionInput): WebSessionDecision {
  const profileMatched = input.developmentRecognized || input.selection.status === "matched";
  const blockers: string[] = [];
  if (!profileMatched) {
    blockers.push(input.selection.status === "ambiguous" ? "PROFILE_SELECTION_AMBIGUOUS" : "PROFILE_NOT_RECOGNIZED");
  }
  if (profileMatched) blockers.push(...input.preflightBlockers);
  const preflight = profileMatched && input.preflightBlockers.length === 0 ? "passed" : "blocked";

  if (input.snapshot.installationState === "stock_unlocked") blockers.push("DEVICE_STATE_STOCK_UNLOCKED");
  if (input.snapshot.installationState === "already_modified") blockers.push("DEVICE_STATE_ALREADY_MODIFIED");
  if (input.snapshot.installationState === "development_fixture") blockers.push("DEVELOPMENT_FIXTURE_FORBIDDEN");

  const deviceInstallable = input.snapshot.installationState === "stock_locked";
  if (input.installerMode === "scan_only") blockers.push("INSTALLER_SCAN_ONLY");
  if (input.installerMode === "private_beta") blockers.push("PRIVATE_BETA_INVITE_REQUIRED");
  if (!input.installerNewStartsEnabled) blockers.push("INSTALLER_NEW_STARTS_PAUSED");
  if (input.installerMode === "public" && profileMatched && preflight === "passed" && deviceInstallable && !input.publicReleaseReady) {
    blockers.push("PUBLIC_RELEASE_NOT_READY");
  }
  const canInstall = profileMatched
    && preflight === "passed"
    && deviceInstallable
    && input.installerMode === "public"
    && input.publicReleaseReady
    && input.installerNewStartsEnabled;

  return webSessionDecisionSchema.parse({
    profile: profileMatched ? "matched" : "not_recognized",
    deviceState: input.snapshot.installationState,
    preflight,
    blockers: [...new Set(blockers)],
    installerMode: input.installerMode,
    canInstall
  });
}

async function activeSession(db: Database, id: string) {
  const [session] = await db.select().from(sessions).where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()))).limit(1);
  return session;
}

function isPassingStockLockedWebSession(session: typeof sessions.$inferSelect, profileId: string): boolean {
  const compatibility = session.compatibility as Partial<WebCompatibilitySnapshot>;
  return session.channel === "web"
    && session.supported
    && session.profileId === profileId
    && compatibility.installationState === "stock_locked"
    && hasCrossModeWebScanProof(session);
}

function hasCrossModeWebScanProof(session: typeof sessions.$inferSelect): boolean {
  const compatibility = session.compatibility as Partial<WebCompatibilitySnapshot>;
  return session.channel === "web"
    && compatibility.serialVerified === true
    && compatibility.immutableSerialVerified === true
    && compatibility.usbStable === true
    && compatibility.recoveryCapable === true;
}

async function activeLicenseForDevice(db: Database, deviceId: string) {
  const [license] = await db.select().from(licenses).where(and(eq(licenses.deviceId, deviceId), eq(licenses.status, "active"))).limit(1);
  return license;
}

type ReceiptOrder = typeof orders.$inferSelect;
function receiptFromOrder(order: ReceiptOrder, modificationStartedAt: Date | null) {
  return {
    orderId: order.id,
    kind: order.kind,
    payerWallet: order.wallet,
    transactionSignature: order.transactionSignature,
    reference: order.reference,
    amountBaseUnits: order.amountBaseUnits.toString(),
    mint: order.mint,
    treasury: order.treasury,
    paidAt: order.paidAt?.toISOString() ?? null,
    paymentSlot: order.paymentSlot,
    paymentBlockTime: order.paymentBlockTime?.toISOString() ?? null,
    normalRefundEligible: order.kind === "paid" && !modificationStartedAt
  };
}

async function enforceDistributedLimit(redis: Redis | undefined, key: string, limit: number, windowSeconds: number): Promise<void> {
  if (!redis) return;
  const count = Number(await redis.eval(
    "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
    1,
    `revive:limit:${key}`,
    String(windowSeconds)
  ));
  if (count > limit) throw apiError("RATE_LIMIT_EXCEEDED", 429);
}

function apiError(code: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(code), { code, statusCode });
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}

const REQUIRED_LAUNCH_GATES = [
  "beta_licenses_redeemed_10", "windows_success_5", "macos_success_5", "all_beta_profiles_signed",
  "no_unrecovered_beta_devices", "serial_uniqueness_confirmed", "stock_restore_tested", "adversarial_suite_passed"
] as const;
async function publicSaleReady(db: Database): Promise<boolean> {
  const checks = await db.select({
    key: launchGateChecks.key,
    passed: launchGateChecks.passed,
    evidence: launchGateChecks.evidence,
    verifiedBy: launchGateChecks.verifiedBy,
    verifiedAt: launchGateChecks.verifiedAt
  }).from(launchGateChecks);
  const [{ count: betaRedemptions } = { count: 0 }] = await db.select({
    count: sql<number>`count(*)::int`
  }).from(promoRedemptions).where(eq(promoRedemptions.codeHash, sha256(BETA_PROMO_CODE)));
  return launchGateSetComplete(checks, betaRedemptions);
}

export function installerBlockedInScanOnlyMode(config: Config): boolean {
  return config.installerMode === "scan_only";
}

/** Numeric semver comparison for the browser protocol version, including builds such as 0.3.0-browser. */
export function installerVersionSatisfies(current: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(value);
    if (!match) return null;
    const parts = match.slice(1, 4).map((part) => Number.parseInt(part, 10));
    return parts.every(Number.isSafeInteger) ? parts as [number, number, number] : null;
  };
  const actual = parse(current);
  const required = parse(minimum);
  if (!actual || !required) return false;
  return actual[0] > required[0]
    || (actual[0] === required[0] && actual[1] > required[1])
    || (actual[0] === required[0] && actual[1] === required[1] && actual[2] >= required[2]);
}

function isLegacyCommerceOrRecoveryPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return /^\/v1\/(?:web\/wizard|wallet|orders)(?:\/|$)/u.test(pathname)
    || /^\/v1\/licenses\/[^/]+\/refunds(?:\/|$)/u.test(pathname)
    || /^\/v1\/devices\/[^/]+\/entitlement\/(?:claim|recover)(?:\/|$)/u.test(pathname);
}

/** A redacted report is still optional personal telemetry; never persist it without an explicit opt-in. */
export function compatibilityReportConsentGranted(input: { consentToNotify: boolean }): boolean {
  return input.consentToNotify === true;
}

async function betaReleaseReadiness(db: Database, config: Config, profileId?: string): Promise<"full" | "pilot" | null> {
  const release = await activeSignedStableRelease(db, config, profileId);
  if (!release || !betaManifestEvidenceReady(release.manifest)) return null;
  if (release.manifest.betaEvidence?.stockPsg1Validation.status === "passed") return "full";
  if (config.betaHardwarePilotEnabled && release.manifest.betaEvidence?.stockPsg1Validation.status === "pilot_pending") return "pilot";
  return null;
}

type ActiveSignedStableRelease = {
  release: typeof releases.$inferSelect;
  manifest: ReleaseManifest;
};

async function activeSignedStableRelease(db: Database, config: Config, profileId?: string): Promise<ActiveSignedStableRelease | null> {
  const matches = await signedStableReleaseCandidates(db, config, "new_start");
  // Publishing tools deactivate the prior release for an overlapping profile.
  // If the database nevertheless has two signed active candidates, refusing
  // both is safer than silently selecting a potentially wrong flash plan.
  return selectUniqueReleaseForProfile(matches, profileId);
}

async function signedStableReleaseCandidates(
  db: Database,
  config: Config,
  availability: "new_start" | "resume"
): Promise<ActiveSignedStableRelease[]> {
  const candidates = await db.select().from(releases).where(and(
    eq(releases.channel, "stable"),
    availability === "new_start" ? eq(releases.active, true) : eq(releases.resumeAvailable, true)
  )).orderBy(desc(releases.publishedAt));
  const matches: ActiveSignedStableRelease[] = [];
  for (const release of candidates) {
    if (!release.signedManifest || typeof release.signedManifest !== "object" || Array.isArray(release.signedManifest)) continue;
    if (!verifySignedDocument(release.signedManifest, release.signature, config.releasePublicKeyPem)) continue;
    const manifest = releaseManifestSchema.safeParse({ ...release.signedManifest, signature: release.signature });
    if (!manifest.success || manifest.data.releaseId !== release.id) continue;
    matches.push({ release, manifest: manifest.data });
  }
  return matches;
}

export function selectUniqueReleaseForProfile<T extends { manifest: Pick<ReleaseManifest, "profileIds"> }>(
  candidates: T[],
  profileId?: string
): T | null {
  const matching = profileId ? candidates.filter((candidate) => candidate.manifest.profileIds.includes(profileId)) : candidates;
  return matching.length === 1 ? matching[0]! : null;
}

type InstallationBinding = {
  profileId: string;
  releaseId: string;
  releaseVersion: string;
  manifestSha256: string;
  artifactHashes: Record<string, string>;
};

type InstallationBindingInput = Pick<InstallationBinding, "profileId" | "releaseVersion" | "artifactHashes">;
type InstallationStartBindingInput = InstallationBindingInput & Pick<InstallationBinding, "releaseId" | "manifestSha256">;

function hasInstallationBinding(license: typeof licenses.$inferSelect): license is typeof licenses.$inferSelect & {
  installationProfileId: string;
  installationProfileDocument: Record<string, unknown>;
  installationProfileSignature: string;
  installationReleaseId: string;
  installationReleaseVersion: string;
  installationManifestSha256: string;
  installationArtifactHashes: Record<string, string>;
} {
  return Boolean(license.installationProfileId)
    && Boolean(license.installationProfileDocument)
    && typeof license.installationProfileDocument === "object"
    && !Array.isArray(license.installationProfileDocument)
    && typeof license.installationProfileSignature === "string"
    && license.installationProfileSignature.length >= 64
    && typeof license.installationReleaseId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(license.installationReleaseId)
    && Boolean(license.installationReleaseVersion)
    && typeof license.installationManifestSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(license.installationManifestSha256)
    && isArtifactHashMap(license.installationArtifactHashes);
}

function installationBindingOf(license: typeof licenses.$inferSelect): InstallationBinding {
  if (!hasInstallationBinding(license)) throw new Error("Installation release binding is missing.");
  return {
    profileId: license.installationProfileId,
    releaseId: license.installationReleaseId,
    releaseVersion: license.installationReleaseVersion,
    manifestSha256: license.installationManifestSha256,
    artifactHashes: license.installationArtifactHashes
  };
}

function isArtifactHashMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([id, hash]) => /^[a-z0-9][a-z0-9_-]{0,99}$/u.test(id) && typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash));
}

function artifactHashMapsMatch(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every(([id, hash]) => right[id] === hash);
}

function signedInstallerArtifactHashes(manifest: ReleaseManifest): Record<string, string> | null {
  const required = ["android_system", "verified_boot", "diagnostics", "diagnostics_test", "aurora_store", "retroarch"] as const;
  const selected = required.map((component) => manifest.artifacts.find((artifact) => artifact.delivery === "private" && artifact.component === component));
  if (selected.some((artifact) => !artifact)) return null;
  return Object.fromEntries(selected.map((artifact) => [artifact!.id, artifact!.sha256]));
}

function manifestArtifactBindingMatches(manifest: ReleaseManifest, input: InstallationBindingInput): boolean {
  const expected = signedInstallerArtifactHashes(manifest);
  return Boolean(expected)
    && manifest.profileIds.includes(input.profileId)
    && manifest.version === input.releaseVersion
    && artifactHashMapsMatch(expected!, input.artifactHashes);
}

function releaseBindingMatchesStart(release: ActiveSignedStableRelease, input: InstallationStartBindingInput): boolean {
  return release.release.id === input.releaseId
    && canonicalSignedManifestSha256(release) === input.manifestSha256
    && manifestArtifactBindingMatches(release.manifest, input);
}

function installationBindingMatchesInput(binding: InstallationBinding, input: InstallationBindingInput): boolean {
  return binding.profileId === input.profileId
    && binding.releaseVersion === input.releaseVersion
    && artifactHashMapsMatch(binding.artifactHashes, input.artifactHashes);
}

function installationBindingMatchesStartInput(binding: InstallationBinding, input: InstallationStartBindingInput): boolean {
  return binding.releaseId === input.releaseId
    && binding.manifestSha256 === input.manifestSha256
    && installationBindingMatchesInput(binding, input);
}

function newInstallationResumeCredential(): string {
  return `rpi_${randomNonce(32)}`;
}

async function rotateInstallationResumeCredential(db: Database, licenseId: string): Promise<{ credential: string; expiresAt: Date }> {
  const credential = newInstallationResumeCredential();
  const expiresAt = new Date(Date.now() + INSTALLATION_RESUME_CREDENTIAL_TTL_SECONDS * 1000);
  await db.update(licenses).set({
    installationResumeCredentialDigest: sha256(credential),
    installationResumeCredentialExpiresAt: expiresAt
  }).where(and(eq(licenses.id, licenseId), eq(licenses.status, "active")));
  return { credential, expiresAt };
}

async function activeSignedReleaseForInstallationBinding(
  db: Database,
  config: Config,
  binding: InstallationBinding
): Promise<ActiveSignedStableRelease | null> {
  const matches = (await signedStableReleaseCandidates(db, config, "resume"))
    .filter((release) => release.release.id === binding.releaseId
      && canonicalSignedManifestSha256(release) === binding.manifestSha256
      && manifestArtifactBindingMatches(release.manifest, binding));
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Bind a started installation to the canonical signed release document, not
 * merely a human version string. This blocks a same-version manifest rewrite
 * from changing a flash plan during an emergency resume.
 */
export function canonicalSignedManifestSha256(release: ActiveSignedStableRelease): string | null {
  return canonicalSignedDocumentSha256(release.release.signedManifest);
}

/** The boundary digest is over the unsigned document exactly as its offline signature was made. */
export function canonicalSignedDocumentSha256(document: unknown): string | null {
  const canonical = canonicalize(document);
  return canonical ? sha256(canonical) : null;
}

async function publicReleaseReadyForProfile(db: Database, config: Config, profileId: string, installerVersion?: string): Promise<boolean> {
  const release = await activeSignedStableRelease(db, config, profileId);
  return Boolean(release
    && publicManifestEvidenceReady(release.manifest)
    && (!installerVersion || installerVersionSatisfies(installerVersion, release.manifest.minimumInstallerVersion)));
}

export function betaManifestEvidenceReady(manifest: ReleaseManifest): boolean {
  const required = ["android_system", "verified_boot", "diagnostics", "diagnostics_test", "aurora_store", "retroarch"];
  if (!manifest.betaEvidence) return false;
  const privateArtifacts = manifest.artifacts.filter((artifact) => artifact.delivery === "private");
  return required.every((component) => privateArtifacts.some((artifact) => artifact.component === component))
    && privateArtifacts.every((artifact) => manifest.betaEvidence?.artifactSha256[artifact.id] === artifact.sha256);
}

export function publicManifestEvidenceReady(manifest: ReleaseManifest): boolean {
  const required = ["android_system", "verified_boot", "diagnostics", "diagnostics_test", "aurora_store", "retroarch"];
  if (!manifest.publicEvidence) return false;
  const privateArtifacts = manifest.artifacts.filter((artifact) => artifact.delivery === "private");
  return required.every((component) => privateArtifacts.some((artifact) => artifact.component === component))
    && manifest.artifacts.every((artifact) => manifest.publicEvidence?.artifactSha256[artifact.id] === artifact.sha256);
}

function evidenceReadyForResume(manifest: ReleaseManifest): boolean {
  return publicManifestEvidenceReady(manifest) || betaManifestEvidenceReady(manifest);
}

type InstallationCheckpointDefinition = {
  operation: InstallationJournalEntry["operation"];
  before: InstallationJournalEntry["stage"];
  after: InstallationJournalEntry["stage"];
  idempotent: boolean;
  /** A reconnect in the exact target mode can prove an interrupted reboot. */
  verifiableAfterReconnect?: boolean;
};

// This is deliberately a server-side fixed state machine, not a sequence the
// browser can supply in a release manifest. Each command has an exact signed
// checkpoint and only the system image's independently idempotent sparse
// `flash:system` transfers may repeat with a segment index.
const INSTALLATION_CHECKPOINTS: readonly InstallationCheckpointDefinition[] = [
  { operation: "begin", before: "start", after: "awaiting_bootloader_unlock", idempotent: true, verifiableAfterReconnect: true },
  { operation: "unlock", before: "awaiting_bootloader_unlock", after: "awaiting_unlocked_android", idempotent: false },
  { operation: "reboot_for_vbmeta", before: "awaiting_unlocked_android", after: "awaiting_vbmeta_bootloader", idempotent: true, verifiableAfterReconnect: true },
  { operation: "flash_vbmeta", before: "awaiting_vbmeta_bootloader", after: "awaiting_vbmeta_bootloader", idempotent: true },
  { operation: "reboot_after_vbmeta", before: "awaiting_vbmeta_bootloader", after: "awaiting_system_android", idempotent: true, verifiableAfterReconnect: true },
  { operation: "reboot_for_fastbootd", before: "awaiting_system_android", after: "awaiting_fastbootd_system", idempotent: true, verifiableAfterReconnect: true },
  { operation: "resize_system", before: "awaiting_fastbootd_system", after: "awaiting_fastbootd_system", idempotent: true },
  { operation: "flash_system", before: "awaiting_fastbootd_system", after: "awaiting_fastbootd_system", idempotent: true },
  { operation: "wipe_userdata", before: "awaiting_fastbootd_system", after: "awaiting_fastbootd_system", idempotent: true },
  { operation: "reboot_after_system", before: "awaiting_fastbootd_system", after: "awaiting_postflash_android", idempotent: true, verifiableAfterReconnect: true },
  { operation: "install_diagnostics", before: "awaiting_postflash_android", after: "awaiting_postflash_android", idempotent: true },
  { operation: "install_diagnostics_test", before: "awaiting_postflash_android", after: "awaiting_postflash_android", idempotent: true },
  { operation: "install_aurora_store", before: "awaiting_postflash_android", after: "awaiting_postflash_android", idempotent: true },
  { operation: "install_retroarch", before: "awaiting_postflash_android", after: "awaiting_postflash_android", idempotent: true },
  { operation: "reboot_after_apps", before: "awaiting_postflash_android", after: "awaiting_first_cold_boot", idempotent: true, verifiableAfterReconnect: true },
  { operation: "first_cold_boot", before: "awaiting_first_cold_boot", after: "awaiting_second_cold_boot", idempotent: true, verifiableAfterReconnect: true },
  { operation: "diagnostics", before: "awaiting_second_cold_boot", after: "complete", idempotent: true }
];

type JournalHistoryEntry = {
  stage: string;
  operation: string;
  operationState: string;
  operationIndex: number;
  operationCount: number;
};

export function validateInstallationJournalTransition(
  previous: JournalHistoryEntry | null,
  next: InstallationJournalEntry
): string | null {
  const checkpointIndex = INSTALLATION_CHECKPOINTS.findIndex((checkpoint) => checkpoint.operation === next.operation);
  const checkpoint = INSTALLATION_CHECKPOINTS[checkpointIndex];
  if (!checkpoint) return "The installation operation is not part of the signed PSG1 checkpoint plan.";
  if (next.operation !== "flash_system" && (next.operationIndex !== 0 || next.operationCount !== 1)) {
    return "Only signed sparse system transfers may use a multi-segment checkpoint.";
  }
  if (next.operationState === "intent" && next.stage !== checkpoint.before) {
    return "An installation intent must be recorded at its exact pre-command checkpoint.";
  }
  if ((next.operationState === "sent" || next.operationState === "verified") && next.stage !== checkpoint.after) {
    return "A sent or verified installation command must use its exact post-command checkpoint.";
  }
  if (next.operationState === "unknown" && next.stage !== checkpoint.before && next.stage !== checkpoint.after) {
    return "An uncertain installation command must use one of its signed checkpoints.";
  }
  if (!previous) {
    return next.operation === "begin" && next.operationState === "intent" && next.operationIndex === 0 && next.operationCount === 1
      ? null
      : "The journal must begin with the signed installation intent.";
  }

  const previousIndex = INSTALLATION_CHECKPOINTS.findIndex((candidate) => candidate.operation === previous.operation);
  const previousCheckpoint = INSTALLATION_CHECKPOINTS[previousIndex];
  if (!previousCheckpoint) return "The existing installation journal has an unknown checkpoint.";
  const sameSegment = previous.operation === next.operation
    && previous.operationIndex === next.operationIndex
    && previous.operationCount === next.operationCount;
  if (sameSegment) {
    if (previous.operationState === "intent") {
      if ((next.operationState === "intent" || next.operationState === "unknown") && next.stage === checkpoint.before) return null;
      if (next.operationState === "sent" && next.stage === checkpoint.after) return null;
    }
    if (previous.operationState === "sent") {
      if ((next.operationState === "verified" || next.operationState === "unknown") && next.stage === checkpoint.after) return null;
      // A tab loss after `sent` can only retry an explicitly idempotent
      // checkpoint. Unlock must instead be verified from Android state.
      if (next.operationState === "intent" && checkpoint.idempotent && next.stage === checkpoint.before) return null;
    }
    if (previous.operationState === "unknown") {
      if (next.operationState === "intent" && (checkpoint.idempotent || previous.stage === checkpoint.before) && next.stage === checkpoint.before) return null;
      if (next.operationState === "verified" && checkpoint.operation === "unlock" && previous.stage === checkpoint.after) return null;
      if (next.operationState === "verified" && checkpoint.verifiableAfterReconnect === true && previous.stage === checkpoint.after) return null;
    }
    if (previous.operationState === "verified" && next.operationState === "verified" && next.stage === checkpoint.after) return null;
    return "The journal state must advance intent → sent → verified, or retry only an idempotent signed checkpoint.";
  }

  if (previous.operationState !== "verified") {
    return "The previous installation checkpoint is unresolved and cannot advance to a new command.";
  }
  const nextOperation = previousCheckpoint.operation === "flash_system" && previous.operationIndex + 1 < previous.operationCount
    ? "flash_system"
    : INSTALLATION_CHECKPOINTS[previousIndex + 1]?.operation;
  if (next.operation !== nextOperation || next.operationState !== "intent") {
    return "The journal operation is out of order for the signed PSG1 checkpoint plan.";
  }
  if (next.operation === "flash_system") {
    if (previousCheckpoint.operation === "flash_system") {
      if (next.operationCount !== previous.operationCount || next.operationIndex !== previous.operationIndex + 1) {
        return "Sparse system transfer checkpoints must continue in exact signed order.";
      }
    } else if (next.operationIndex !== 0) {
      return "The first sparse system transfer checkpoint must start at segment zero.";
    }
  } else if (next.operationIndex !== 0 || next.operationCount !== 1) {
    return "This signed checkpoint does not permit segment indexing.";
  }
  return null;
}

export function launchGateSetComplete(
  checks: Array<{ key: string; passed: boolean; evidence: unknown; verifiedBy: string | null; verifiedAt: Date | null }>,
  betaRedemptions: number
): boolean {
  const passed = new Map(checks.map((check) => [check.key, check]));
  return betaRedemptions >= BETA_PROMO_LIMIT && REQUIRED_LAUNCH_GATES.every((key) => {
    const check = passed.get(key);
    return check?.passed === true
      && Boolean(check.verifiedBy)
      && Boolean(check.verifiedAt)
      && isNonEmptyEvidence(check.evidence);
  });
}

export function earlyAccessAllowed(enabled: boolean, existingOrderKind?: "paid" | "promo" | "early_access"): boolean {
  return enabled || existingOrderKind === "early_access";
}

function isNonEmptyEvidence(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
}

const SENSITIVE_TELEMETRY_KEY = /(serial|wallet|signature|token|authorization|cookie|hostname|computer.?id|android.?id|adb|usb)/i;
export function sanitizeTelemetryRecord(value: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_TELEMETRY_KEY.test(key))
    .map(([key, item]) => [key, typeof item === "string" ? sanitizeText(item) : item]));
}

export function sanitizeText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .replace(/\bPS\d{2}(?:-[A-Za-z0-9]+){3,}\b/gi, "[redacted-device-serial]")
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,128}/g, "[redacted-token]")
    .replace(/\b[A-Fa-f0-9]{64}\b/g, "[redacted-hash]")
    .slice(0, 16_000);
}
