#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const output = resolve(process.argv[2] ?? "work/artifacts/diagnostics-release");
const required = ["REVIVE_ANDROID_KEYSTORE_FILE", "REVIVE_ANDROID_KEY_ALIAS", "REVIVE_ANDROID_STORE_PASSWORD", "REVIVE_ANDROID_KEY_PASSWORD"];
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}; refusing to produce an unsigned diagnostics release.`);
if (!existsSync(process.env.REVIVE_ANDROID_KEYSTORE_FILE)) throw new Error("REVIVE_ANDROID_KEYSTORE_FILE does not exist.");

const apksigner = commandPath("apksigner");
const zipalign = resolve(dirname(apksigner), "zipalign");
if (!existsSync(zipalign)) throw new Error("zipalign was not found beside apksigner.");

run("./gradlew", ["--no-daemon", "assembleRelease", "assembleDebugAndroidTest"], { cwd: "apps/diagnostics" });
const source = [
  { id: "revive-diagnostics.apk", path: "apps/diagnostics/app/build/outputs/apk/release/app-release-unsigned.apk", packageName: "com.revivepsg1.diagnostics", versionName: "0.1.0" },
  { id: "revive-diagnostics-test.apk", path: "apps/diagnostics/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk", packageName: "com.revivepsg1.diagnostics.test" }
];
mkdirSync(output, { recursive: true, mode: 0o700 });

const evidence = [];
for (const artifact of source) {
  const input = resolve(artifact.path);
  if (!existsSync(input)) throw new Error(`Expected Gradle output is missing: ${input}`);
  const aligned = resolve(output, `${artifact.id}.aligned`);
  const destination = resolve(output, artifact.id);
  rmSync(aligned, { force: true }); rmSync(destination, { force: true });
  run(zipalign, ["-p", "-f", "4", input, aligned]);
  run(apksigner, ["sign", "--ks", process.env.REVIVE_ANDROID_KEYSTORE_FILE, "--ks-key-alias", process.env.REVIVE_ANDROID_KEY_ALIAS,
    "--ks-pass", "env:REVIVE_ANDROID_STORE_PASSWORD", "--key-pass", "env:REVIVE_ANDROID_KEY_PASSWORD", "--out", destination, aligned]);
  rmSync(aligned, { force: true });
  const verification = run(apksigner, ["verify", "--verbose", "--print-certs", destination]);
  const signerSha256 = verification.match(/Signer #1 certificate SHA-256 digest:\s*([a-f0-9]{64})/iu)?.[1]?.toLowerCase();
  if (!signerSha256) throw new Error(`Could not read the signing certificate digest for ${artifact.id}.`);
  evidence.push({ ...artifact, size: readFileSync(destination).byteLength, sha256: sha256(destination), signerSha256 });
}
if (new Set(evidence.map((artifact) => artifact.signerSha256)).size !== 1) throw new Error("Diagnostics APKs were not signed by the same release certificate.");
writeFileSync(resolve(output, "diagnostics-release-evidence.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), artifacts: evidence }, null, 2)}\n`, { mode: 0o600 });
for (const artifact of evidence) process.stdout.write(`${basename(artifact.id)} sha256=${artifact.sha256} signerSha256=${artifact.signerSha256}\n`);

function commandPath(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`${command} is not installed or not on PATH.`);
  return result.stdout.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return result.stdout;
}

function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
