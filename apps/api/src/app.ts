import { randomUUID } from "node:crypto";
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
  DEVELOPMENT_FIXTURE_DEVICE_ID,
  DEVELOPMENT_FIXTURE_PROFILE_ID,
  DEVELOPMENT_MODIFIED_PROFILE_ID,
  LICENSE_PRICE_USDC,
  SESSION_TTL_SECONDS,
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
  earlyAccessActivateSchema,
  entitlementRecoverySchema,
  isExactDevelopmentFixture,
  isSafeDevelopmentModifiedScan,
  installationStartSchema,
  licenseClaimMessage,
  licenseClaimSchema,
  orderCreateSchema,
  orderVerifySchema,
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
  webCheckoutWalletChallengeMessage,
  webSessionCreateSchema,
  webSessionProofMessage,
  uuidSchema
} from "@revive-psg1/contracts";
import type { Config } from "./config";
import type { Database } from "./db/client";
import {
  browserPairingChallenges,
  betaInvites,
  compatibilityProfiles,
  compatibilityReports,
  crashReports,
  devices,
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
import { profileMatches, verifySignedDocument, webPreflightMatches, webProfileMatches } from "./profiles";
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
    const matched = activeProfiles.find((row) => {
      const parsed = compatibilityProfileSchema.safeParse({ ...(row.signedDocument as object), signature: row.signature });
      return parsed.success
        && verifySignedDocument(row.signedDocument, row.signature, config.releasePublicKeyPem)
        && profileMatches(parsed.data, input.compatibility);
    });
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
        profileId: matched?.id,
        supported: Boolean(matched),
        expiresAt
      });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ code: "SESSION_PROOF_REPLAYED" });
      throw error;
    }
    const desktopToken = await tokens.issueSessionToken({ audience: "desktop-session", subject: input.pairingPublicKey, sessionId: id, deviceId: input.deviceId });
    const checkoutToken = await tokens.issueSessionToken({ audience: "checkout", subject: id, sessionId: id, deviceId: input.deviceId });
    await audit(db, "session.created", { actor: input.deviceId, subjectId: id, payload: { supported: Boolean(matched), profileId: matched?.id } });
    return reply.code(201).send({
      sessionId: id,
      supported: Boolean(matched),
      profileId: matched?.id ?? null,
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
    const matched = activeProfiles.find((row) => {
      const parsed = compatibilityProfileSchema.safeParse({ ...(row.signedDocument as object), signature: row.signature });
      return parsed.success
        && verifySignedDocument(row.signedDocument, row.signature, config.releasePublicKeyPem)
        && webProfileMatches(parsed.data, input.compatibility)
        && webPreflightMatches(parsed.data, input.compatibility);
    });
    const profileId = developmentFixture ? DEVELOPMENT_FIXTURE_PROFILE_ID : developmentModified ? DEVELOPMENT_MODIFIED_PROFILE_ID : matched?.id;
    const supported = developmentFixture || developmentModified || Boolean(matched);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
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
      deviceId: input.deviceId
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
      browserToken,
      expiresAt: expiresAt.toISOString()
    });
  });

  app.post("/v1/early-access/activate", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    if (config.betaBrowserInstaller) return reply.code(403).send({ code: "BETA_CODE_REQUIRED" });
    if (installerBlockedInScanOnlyMode(config)) return reply.code(403).send({ code: "COMPATIBILITY_CHECKER_ONLY" });
    const auth = await requireToken(request, tokens, "browser-checkout");
    const input = earlyAccessActivateSchema.parse(request.body);
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    if (!session?.supported) return reply.code(409).send({ code: "UNSUPPORTED_FIRMWARE" });
    if (session.channel !== "web" || auth.sub !== session.pairingPublicKey) {
      return reply.code(403).send({ code: "WEB_PAIRING_REQUIRED" });
    }
    await enforceDistributedLimit(redis, `early-access:device:${session.deviceId}`, 10, 60 * 60);

    let license = await activeLicenseForDevice(db, session.deviceId);
    if (license && !config.earlyAccessFree) {
      const [existingOrder] = await db.select({ kind: orders.kind }).from(orders).where(eq(orders.id, license.orderId)).limit(1);
      if (!earlyAccessAllowed(config.earlyAccessFree, existingOrder?.kind)) return reply.code(404).send({ code: "EARLY_ACCESS_DISABLED" });
    }
    if (!license && !earlyAccessAllowed(config.earlyAccessFree)) return reply.code(404).send({ code: "EARLY_ACCESS_DISABLED" });

    let created = false;
    if (!license) {
      const orderId = randomUUID();
      const licenseId = randomUUID();
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${session.deviceId}, 0))`);
          const [raceWinner] = await tx.select({ id: licenses.id }).from(licenses).where(and(
            eq(licenses.deviceId, session.deviceId),
            eq(licenses.status, "active")
          )).limit(1);
          if (raceWinner) return;
          if (!session.profileId) throw apiError("SESSION_PROFILE_MISSING", 409);
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
            profileId: session.profileId,
            serialVerified: true,
            licensedAt: new Date()
          }).onConflictDoUpdate({
            target: devices.id,
            set: { profileId: session.profileId, serialVerified: true, lastSeenAt: new Date(), licensedAt: new Date() }
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
    if (!license) throw new Error("Early Access activation did not produce an active device entitlement");

    const webInstallerToken = await tokens.issueSessionToken({
      audience: "web-installer",
      subject: license.id,
      sessionId: session.id,
      deviceId: session.deviceId,
      expiresIn: "10m"
    });
    await audit(db, created ? "early_access.activated" : "early_access.restored", {
      actor: session.deviceId,
      subjectId: license.id,
      payload: { orderId: license.orderId }
    });
    return reply.code(created ? 201 : 200).send({
      earlyAccessFree: true,
      alreadyLicensed: !created,
      orderId: license.orderId,
      licenseId: license.id,
      webInstallerToken,
      expiresInSeconds: 600
    });
  });

  // A Discord code is intentionally not a generic coupon. It becomes bound
  // to the first supported physical PSG1 that redeems it inside this single
  // transaction, and can never be used again.
  app.post("/v1/beta/activate", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    if (installerBlockedInScanOnlyMode(config)) return reply.code(403).send({ code: "BETA_INSTALLER_CLOSED" });
    const auth = await requireToken(request, tokens, "browser-checkout");
    const input = betaActivateSchema.parse(request.body);
    if (auth.sessionId !== input.sessionId) return reply.code(403).send({ code: "SESSION_MISMATCH" });
    const session = await activeSession(db, input.sessionId);
    if (!session?.supported) return reply.code(409).send({ code: "UNSUPPORTED_FIRMWARE" });
    if (session.channel !== "web" || auth.sub !== session.pairingPublicKey) return reply.code(403).send({ code: "WEB_PAIRING_REQUIRED" });
    const state = (session.compatibility as { installationState?: string }).installationState;
    if (state !== "stock_locked") return reply.code(409).send({ code: "DESTRUCTIVE_TEST_MODE_BLOCKED" });
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
          )).returning({ id: betaInvites.id });
          if (!boundInvite.length) throw apiError("BETA_INVITE_INVALID_OR_USED", 409);
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
      audience: "web-installer", subject: license.id, sessionId: session.id, deviceId: session.deviceId, expiresIn: "2h"
    });
    await audit(db, created ? "beta.activated" : "beta.resumed", { actor: session.deviceId, subjectId: license.id, payload: { orderId: license.orderId } });
    return reply.code(created ? 201 : 200).send({ licenseId: license.id, orderId: license.orderId, webInstallerToken, expiresInSeconds: 7200 });
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
    if (installerBlockedInScanOnlyMode(config)) return reply.code(403).send({ code: "COMPATIBILITY_CHECKER_ONLY" });
    const auth = await verifyInstallerAccess(request, tokens);
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const acknowledgement = installationStartSchema.parse(request.body);
    if (auth.sub !== id) return reply.code(403).send({ code: "LICENSE_MISMATCH" });
    const [current] = await db.select().from(licenses).where(and(eq(licenses.id, id), eq(licenses.status, "active"))).limit(1);
    if (!current || auth.deviceId !== current.deviceId) return reply.code(404).send({ code: "LICENSE_NOT_FOUND" });
    const currentSessionId = typeof auth.sessionId === "string" ? auth.sessionId : undefined;
    const [origin] = currentSessionId
      ? await db.select({ compatibility: sessions.compatibility }).from(sessions).where(eq(sessions.id, currentSessionId)).limit(1)
      : await db.select({ compatibility: sessions.compatibility }).from(orders)
        .innerJoin(sessions, eq(sessions.id, orders.sessionId))
        .where(eq(orders.id, current.orderId)).limit(1);
    const installationState = (origin?.compatibility as { installationState?: string } | undefined)?.installationState;
    if (installationState === "already_modified" || installationState === "development_fixture") {
      return reply.code(409).send({ code: "DESTRUCTIVE_TEST_MODE_BLOCKED" });
    }
    if (current.modificationStartedAt) return { modificationStartedAt: current.modificationStartedAt.toISOString() };
    const result = await db.update(licenses).set({ modificationStartedAt: new Date() }).where(and(eq(licenses.id, id), eq(licenses.status, "active"), isNull(licenses.modificationStartedAt))).returning();
    if (!result.length) return reply.code(409).send({ code: "INSTALLATION_BOUNDARY_RACE" });
    await audit(db, "installation.started", {
      actor: String(auth.deviceId), subjectId: id,
      payload: { termsVersion: acknowledgement.termsVersion, irreversibleRiskAcknowledged: true }
    });
    return { modificationStartedAt: result[0]!.modificationStartedAt?.toISOString() };
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
    if (installerBlockedInScanOnlyMode(config)) return reply.code(403).send({ code: "COMPATIBILITY_CHECKER_ONLY" });
    const auth = await verifyInstallerAccess(request, tokens);
    const license = await activeLicenseForDevice(db, String(auth.deviceId));
    if (!license || license.id !== auth.sub) return reply.code(403).send({ code: "LICENSE_INACTIVE" });
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
    if (!device?.profileId) return reply.code(409).send({ code: "DEVICE_PROFILE_MISSING" });
    const [profile] = await db.select().from(compatibilityProfiles).where(and(eq(compatibilityProfiles.id, device.profileId), eq(compatibilityProfiles.active, true))).limit(1);
    if (!profile || !verifySignedDocument(profile.signedDocument, profile.signature, config.releasePublicKeyPem)) return reply.code(409).send({ code: "DEVICE_PROFILE_INACTIVE" });
    const [release] = await db.select().from(releases).where(and(eq(releases.channel, "stable"), eq(releases.active, true))).orderBy(desc(releases.publishedAt)).limit(1);
    if (!release || !verifySignedDocument(release.signedManifest, release.signature, config.releasePublicKeyPem)) return reply.code(404).send({ code: "NO_STABLE_RELEASE" });
    const manifest = releaseManifestSchema.safeParse({ ...(release.signedManifest as object), signature: release.signature });
    if (!manifest.success) return reply.code(409).send({ code: "RELEASE_MANIFEST_INVALID" });
    const privateArtifacts = manifest.data.artifacts.filter((artifact) => artifact.delivery === "private");
    const downloadUrls = Object.fromEntries(await Promise.all(privateArtifacts.map(async (artifact) => [
      artifact.objectKey,
      await storage.signedDownloadUrl(artifact.objectKey)
    ])));
    return { manifest: release.signedManifest, signature: release.signature, profile: profile.signedDocument, profileSignature: profile.signature, downloadUrls };
  });

  app.post("/v1/compatibility-reports", async (request, reply) => {
    const auth = await requireToken(request, tokens, "desktop-session");
    const input = compatibilityReportSchema.parse(request.body);
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

async function verifyInstallerAccess(request: FastifyRequest, tokens: TokenService) {
  const token = bearerToken(request.headers.authorization);
  if (!token) throw Object.assign(new Error("License authorization required"), { statusCode: 401, code: "LICENSE_REQUIRED" });
  try {
    return await tokens.verifyLicenseToken(token);
  } catch {
    try {
      return await tokens.verifySessionToken(token, "web-installer");
    } catch {
      throw Object.assign(new Error("Installer authorization is invalid or expired"), { statusCode: 401, code: "INSTALLER_AUTH_INVALID" });
    }
  }
}

async function activeSession(db: Database, id: string) {
  const [session] = await db.select().from(sessions).where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()))).limit(1);
  return session;
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
  return config.compatibilityCheckerOnly || !config.betaBrowserInstaller;
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
