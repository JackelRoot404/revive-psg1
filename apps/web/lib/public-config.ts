const HTTPS = "https:";

function validUrl(value: string | undefined, protocols: string[] = [HTTPS]): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

export function apiUrl(): string | null {
  return validUrl(
    process.env.NEXT_PUBLIC_API_URL,
    process.env.NODE_ENV === "development" ? [HTTPS, "http:"] : [HTTPS]
  );
}

export function solanaRpcUrl(): string {
  return validUrl(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
    process.env.NODE_ENV === "development" ? [HTTPS, "http:"] : [HTTPS]
  ) ?? "https://api.mainnet-beta.solana.com";
}

export const releaseDownloads = {
  macos: validUrl(process.env.NEXT_PUBLIC_MACOS_DOWNLOAD_URL),
  windows: validUrl(process.env.NEXT_PUBLIC_WINDOWS_DOWNLOAD_URL)
} as const;

export const publicSalesState = process.env.NEXT_PUBLIC_SALES_STATE === "public"
  ? "public"
  : process.env.NEXT_PUBLIC_SALES_STATE === "beta"
    ? "beta"
    : "closed";

// This is deliberately a source-level launch gate, not an environment toggle.
// A copied checkout URL currently works on another computer. Do not enable checkout
// until the desktop-local, signed, one-use browser proof in docs/checkout-pairing.md
// is implemented and covered by end-to-end tests.
export const SAME_COMPUTER_PAIRING_IMPLEMENTED = false;

export const legalConfig = {
  entity: process.env.NEXT_PUBLIC_LEGAL_ENTITY?.trim() || "biccsdev",
  supportUrl: validUrl(process.env.NEXT_PUBLIC_SUPPORT_URL) ?? "https://discord.gg/QWYxkJgEHH",
  governingLaw: process.env.NEXT_PUBLIC_GOVERNING_LAW?.trim() || null,
  effectiveDate: process.env.NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE?.trim() || null,
  retention: process.env.NEXT_PUBLIC_DATA_RETENTION_POLICY?.trim() || null
} as const;

export const legalConfigComplete = Boolean(
  legalConfig.entity
  && legalConfig.supportUrl
  && legalConfig.governingLaw
  && legalConfig.effectiveDate
  && legalConfig.retention
);
