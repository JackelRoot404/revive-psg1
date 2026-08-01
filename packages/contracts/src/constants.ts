export const PRODUCT_NAME = "Revive PSG1";
export const DEVICE_ID_DOMAIN = "revive-psg1:v1";
export const LICENSE_PRICE_USDC = "19.000000";
export const USDC_DECIMALS = 6;
export const USDC_AMOUNT_BASE_UNITS = 19_000_000n;
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TREASURY_WALLET = "EAjkNpwau3hB58C2M4U8rQWFANHRidA8XiB4Dvq78T4y";
// Internal program counter only. This string is never a redeemable code.
export const BETA_PROMO_CODE = "DISCORD_BROWSER_BETA";
export const BETA_PROMO_LIMIT = 25;
export const BETA_INVITE_PREFIX = "rpb_";
export const RECOVERY_CREDENTIAL_PREFIX = "rpr_";
// Stored only in the browser's persistent same-origin installation journal.
// It can resume one already-bound signed release; it can never activate or
// start a new PSG1 installation.
export const INSTALLATION_RESUME_CREDENTIAL_PREFIX = "rpi_";
export const INSTALLATION_RESUME_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60;
export const WIPE_CONFIRMATION = "ERASE PSG1";
export const SESSION_TTL_SECONDS = 15 * 60;
// Browser installation sessions cover signed-artifact verification and the
// explicit risk review. Every destructive route still requires this live
// session, so it is longer than an ordinary desktop pairing session but never
// an unbounded license credential.
export const WEB_INSTALLER_SESSION_TTL_SECONDS = 2 * 60 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;

export const ERROR_CODES = {
  unsupportedDevice: "RPSG-E-DEVICE-001",
  unsupportedFirmware: "RPSG-E-FIRMWARE-001",
  unauthorizedAdb: "RPSG-E-ADB-001",
  serialMismatch: "RPSG-E-SERIAL-001",
  lowBattery: "RPSG-E-POWER-001",
  insufficientStorage: "RPSG-E-STORAGE-001",
  unlockFailed: "RPSG-E-UNLOCK-001",
  fastbootdFailed: "RPSG-E-FASTBOOTD-001",
  artifactSignature: "RPSG-E-SIGNATURE-001",
  artifactHash: "RPSG-E-HASH-001",
  flashFailed: "RPSG-E-FLASH-001",
  firstBootTimeout: "RPSG-E-BOOT-001"
} as const;
