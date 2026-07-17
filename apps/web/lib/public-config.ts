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
    process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === "development" ? "http://localhost:8080" : undefined),
    process.env.NODE_ENV === "development" ? [HTTPS, "http:"] : [HTTPS]
  );
}

export function solanaRpcUrl(): string {
  return validUrl(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
    process.env.NODE_ENV === "development" ? [HTTPS, "http:"] : [HTTPS]
  ) ?? "https://api.mainnet-beta.solana.com";
}

export const publicSalesState = process.env.NEXT_PUBLIC_SALES_STATE === "public"
  ? "public"
  : process.env.NEXT_PUBLIC_SALES_STATE === "beta"
    ? "beta"
    : "closed";

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
