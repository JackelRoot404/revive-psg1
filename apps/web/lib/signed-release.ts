import { releasePublicKeyPem } from "./public-config";

export async function verifySignedReleaseDocument(document: unknown, signature: string): Promise<void> {
  if (!releasePublicKeyPem) throw new Error("The browser release verification key is not configured.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) throw new Error("The release signature encoding is invalid.");
  const key = await crypto.subtle.importKey(
    "spki", asArrayBuffer(pemBytes(releasePublicKeyPem)), { name: "Ed25519" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "Ed25519", key, asArrayBuffer(base64Bytes(signature)), asArrayBuffer(new TextEncoder().encode(canonicalJson(document)))
  );
  if (!valid) throw new Error("The signed release could not be verified in this browser.");
}

/**
 * SHA-256 of the same RFC-8785-compatible canonical document bytes covered by
 * the offline signature. The browser sends this at the destructive boundary
 * so the API can reject a release that changed after this exact manifest was
 * downloaded and verified.
 */
export async function canonicalSignedDocumentSha256(document: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(document)));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

// RFC 8785-compatible for the JSON values accepted by the signed manifest/profile schemas.
export function canonicalSignedDocument(value: unknown): string {
  return canonicalJson(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("The signed release contains an unsupported JSON value.");
}

function pemBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/gu, "");
  return base64Bytes(body);
}

function base64Bytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return new Uint8Array(value).buffer as ArrayBuffer;
}
