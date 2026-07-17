import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, importPKCS8, importSPKI, jwtVerify, type JWTPayload } from "jose";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { Config } from "./config";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomNonce(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomSolanaAddress(): string {
  return bs58.encode(randomBytes(32));
}

export function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function verifyEd25519Base58(input: { publicKey: string; signature: string; message: string }): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(input.message),
      bs58.decode(input.signature),
      bs58.decode(input.publicKey)
    );
  } catch {
    return false;
  }
}

type TokenAudience = "desktop-session" | "checkout" | "browser-checkout" | "wallet";

export class TokenService {
  private readonly sessionSecret: Uint8Array;
  private readonly licensePrivateKeyPromise: ReturnType<typeof importPKCS8>;
  private readonly licensePublicKeyPromise: ReturnType<typeof importSPKI>;

  constructor(private readonly config: Config) {
    this.sessionSecret = new TextEncoder().encode(config.sessionTokenSecret);
    let privatePem = config.licensePrivateKeyPem;
    let publicPem = config.licensePublicKeyPem;
    if (!privatePem || !publicPem) {
      const generated = generateKeyPairSync("ed25519");
      privatePem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      publicPem = generated.publicKey.export({ type: "spki", format: "pem" }).toString();
    }
    this.licensePrivateKeyPromise = importPKCS8(privatePem, "EdDSA");
    this.licensePublicKeyPromise = importSPKI(publicPem, "EdDSA");
  }

  async issueSessionToken(input: {
    audience: TokenAudience;
    subject: string;
    sessionId: string;
    deviceId: string;
    wallet?: string;
    expiresIn?: string;
  }): Promise<string> {
    return new SignJWT({ sessionId: input.sessionId, deviceId: input.deviceId, wallet: input.wallet })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("revive-psg1-api")
      .setAudience(input.audience)
      .setSubject(input.subject)
      .setIssuedAt()
      .setExpirationTime(input.expiresIn ?? "15m")
      .sign(this.sessionSecret);
  }

  async verifySessionToken(token: string, audience: TokenAudience): Promise<JWTPayload> {
    const result = await jwtVerify(token, this.sessionSecret, {
      issuer: "revive-psg1-api",
      audience
    });
    return result.payload;
  }

  async issueLicenseToken(input: { licenseId: string; deviceId: string; wallet: string }): Promise<string> {
    const key = await this.licensePrivateKeyPromise;
    return new SignJWT({
      deviceId: input.deviceId,
      receiptWallet: input.wallet,
      entitlement: "all-releases"
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: this.config.licenseKeyId })
      .setIssuer("revive-psg1-api")
      .setAudience("revive-psg1-desktop")
      .setSubject(input.licenseId)
      .setIssuedAt()
      .sign(key);
  }

  async verifyLicenseToken(token: string): Promise<JWTPayload> {
    const key = await this.licensePublicKeyPromise;
    const result = await jwtVerify(token, key, {
      issuer: "revive-psg1-api",
      audience: "revive-psg1-desktop"
    });
    return result.payload;
  }
}

export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token.length > 0 ? token : null;
}
