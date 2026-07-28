import { z } from "zod";
import { TREASURY_WALLET } from "@revive-psg1/contracts";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_API_URL: z.string().url().default("http://localhost:8080"),
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:3000"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).default("postgresql://revive:revive@localhost:5432/revive_psg1"),
  DATABASE_CA_PATH: z.string().optional(),
  DATABASE_CA_PEM: z.string().optional(),
  VALKEY_URL: z.string().optional(),
  SESSION_TOKEN_SECRET: z.string().min(32).default("revive-local-development-session-secret-only"),
  LICENSE_PRIVATE_KEY_PEM: z.string().optional(),
  LICENSE_PUBLIC_KEY_PEM: z.string().optional(),
  LICENSE_KEY_ID: z.string().default("license-dev-1"),
  RELEASE_PUBLIC_KEY_PEM: z.string().optional(),
  SOLANA_RPC_PRIMARY: z.string().url().default("https://api.mainnet-beta.solana.com"),
  SOLANA_RPC_FALLBACK: z.string().url().optional(),
  TREASURY_WALLET: z.string().default(TREASURY_WALLET),
  SPACES_REGION: z.string().default("nyc3"),
  SPACES_BUCKET: z.string().default("revive-psg1-artifacts"),
  SPACES_ACCESS_KEY: z.string().optional(),
  SPACES_SECRET_KEY: z.string().optional(),
  CRASH_REPORTS_ENABLED: z.string().default("true").transform((value) => value === "true"),
  EARLY_ACCESS_FREE: z.string().default("true").transform((value) => value === "true"),
  REVIVE_DEV_HARDWARE_FIXTURE: z.string().default("false").transform((value) => value === "true"),
  PUBLIC_SALES_ENABLED: z.string().default("false").transform((value) => value === "true"),
  COMPATIBILITY_CHECKER_ONLY: z.string().default("true").transform((value) => value === "true"),
  BETA_BROWSER_INSTALLER: z.string().default("false").transform((value) => value === "true"),
  // This does not open the beta cohort. It merely permits the one
  // database-backed hardware-pilot invite for a signed pilot-pending release.
  BETA_HARDWARE_PILOT_ENABLED: z.string().default("false").transform((value) => value === "true")
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  publicApiUrl: string;
  publicWebUrl: string;
  allowedOrigins: string[];
  databaseUrl: string;
  databaseCaPath?: string;
  databaseCaPem?: string;
  valkeyUrl?: string;
  sessionTokenSecret: string;
  licensePrivateKeyPem?: string;
  licensePublicKeyPem?: string;
  licenseKeyId: string;
  releasePublicKeyPem?: string;
  solanaRpcPrimary: string;
  solanaRpcFallback?: string;
  treasuryWallet: string;
  spacesRegion: string;
  spacesBucket: string;
  spacesAccessKey?: string;
  spacesSecretKey?: string;
  crashReportsEnabled: boolean;
  earlyAccessFree: boolean;
  developmentHardwareFixture: boolean;
  publicSalesEnabled: boolean;
  compatibilityCheckerOnly: boolean;
  betaBrowserInstaller: boolean;
  betaHardwarePilotEnabled: boolean;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const value = environmentSchema.parse(environment);
  if (value.NODE_ENV === "production") {
    if (value.REVIVE_DEV_HARDWARE_FIXTURE) throw new Error("The development hardware fixture is forbidden in production");
    if (value.SESSION_TOKEN_SECRET === "revive-local-development-session-secret-only") {
      throw new Error("Production requires a unique session token secret");
    }
    if (!value.LICENSE_PRIVATE_KEY_PEM || !value.LICENSE_PUBLIC_KEY_PEM || !value.RELEASE_PUBLIC_KEY_PEM) {
      throw new Error("Production requires license issuance keys and the offline release verification public key");
    }
    if (!value.VALKEY_URL) throw new Error("Production requires Valkey for distributed replay and rate-limit state");
    if (!value.SOLANA_RPC_FALLBACK) throw new Error("Production requires primary and fallback Solana RPC endpoints");
    if (!value.DATABASE_CA_PATH && !value.DATABASE_CA_PEM) throw new Error("Production requires a PostgreSQL CA certificate for verify-full TLS");
    if (!value.SPACES_ACCESS_KEY || !value.SPACES_SECRET_KEY) throw new Error("Production requires private Spaces credentials");
    if (!value.PUBLIC_API_URL.startsWith("https://") || !value.PUBLIC_WEB_URL.startsWith("https://")) {
      throw new Error("Production public URLs must use HTTPS");
    }
    if (value.ALLOWED_ORIGINS.split(",").some((origin) => !origin.trim().startsWith("https://"))) {
      throw new Error("Production CORS origins must use HTTPS");
    }
  }
  if (value.TREASURY_WALLET !== TREASURY_WALLET) throw new Error("Treasury wallet does not match the approved Revive PSG1 treasury");
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    publicApiUrl: value.PUBLIC_API_URL,
    publicWebUrl: value.PUBLIC_WEB_URL,
    allowedOrigins: value.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    databaseUrl: value.DATABASE_URL,
    ...(value.DATABASE_CA_PATH ? { databaseCaPath: value.DATABASE_CA_PATH } : {}),
    ...(value.DATABASE_CA_PEM ? { databaseCaPem: value.DATABASE_CA_PEM.replaceAll("\\n", "\n") } : {}),
    ...(value.VALKEY_URL ? { valkeyUrl: value.VALKEY_URL } : {}),
    sessionTokenSecret: value.SESSION_TOKEN_SECRET,
    ...(value.LICENSE_PRIVATE_KEY_PEM ? { licensePrivateKeyPem: value.LICENSE_PRIVATE_KEY_PEM.replaceAll("\\n", "\n") } : {}),
    ...(value.LICENSE_PUBLIC_KEY_PEM ? { licensePublicKeyPem: value.LICENSE_PUBLIC_KEY_PEM.replaceAll("\\n", "\n") } : {}),
    licenseKeyId: value.LICENSE_KEY_ID,
    ...(value.RELEASE_PUBLIC_KEY_PEM ? { releasePublicKeyPem: value.RELEASE_PUBLIC_KEY_PEM.replaceAll("\\n", "\n") } : {}),
    solanaRpcPrimary: value.SOLANA_RPC_PRIMARY,
    ...(value.SOLANA_RPC_FALLBACK ? { solanaRpcFallback: value.SOLANA_RPC_FALLBACK } : {}),
    treasuryWallet: value.TREASURY_WALLET,
    spacesRegion: value.SPACES_REGION,
    spacesBucket: value.SPACES_BUCKET,
    ...(value.SPACES_ACCESS_KEY ? { spacesAccessKey: value.SPACES_ACCESS_KEY } : {}),
    ...(value.SPACES_SECRET_KEY ? { spacesSecretKey: value.SPACES_SECRET_KEY } : {}),
    crashReportsEnabled: value.CRASH_REPORTS_ENABLED,
    earlyAccessFree: value.EARLY_ACCESS_FREE,
    developmentHardwareFixture: value.REVIVE_DEV_HARDWARE_FIXTURE,
    publicSalesEnabled: value.PUBLIC_SALES_ENABLED,
    compatibilityCheckerOnly: value.COMPATIBILITY_CHECKER_ONLY,
    betaBrowserInstaller: value.BETA_BROWSER_INSTALLER,
    betaHardwarePilotEnabled: value.BETA_HARDWARE_PILOT_ENABLED
  };
}
