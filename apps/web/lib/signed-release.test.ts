import { describe, expect, it } from "vitest";
import { canonicalSignedDocument, canonicalSignedDocumentSha256 } from "./signed-release";

describe("signed release canonicalization", () => {
  it("matches the API's RFC-8785-compatible boundary digest across key order", async () => {
    const document = { z: [3, { b: "x", a: true }], a: { nested: "✓", count: 2 } };
    const reordered = { a: { count: 2, nested: "✓" }, z: [3, { a: true, b: "x" }] };
    expect(canonicalSignedDocument(document)).toBe('{"a":{"count":2,"nested":"✓"},"z":[3,{"a":true,"b":"x"}]}');
    await expect(canonicalSignedDocumentSha256(document)).resolves.toBe("260637f7b07bd42cfeba494fa85936a22418da91bb12e4edad745c90d31f1d56");
    await expect(canonicalSignedDocumentSha256(reordered)).resolves.toBe("260637f7b07bd42cfeba494fa85936a22418da91bb12e4edad745c90d31f1d56");
    await expect(canonicalSignedDocumentSha256({ ...reordered, z: [4] })).resolves.not.toBe("260637f7b07bd42cfeba494fa85936a22418da91bb12e4edad745c90d31f1d56");
  });
});
