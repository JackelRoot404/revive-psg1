export function sessionProofMessage(input: {
  deviceId: string;
  pairingPublicKey: string;
  appVersion: string;
  requestNonce: string;
  createdAt: string;
}): string {
  return [
    "Revive PSG1 desktop pairing",
    `device:${input.deviceId}`,
    `pairing-key:${input.pairingPublicKey}`,
    `app-version:${input.appVersion}`,
    `request-nonce:${input.requestNonce}`,
    `created-at:${input.createdAt}`
  ].join("\n");
}

export function walletChallengeMessage(input: {
  domain: string;
  challengeId: string;
  sessionId: string;
  deviceId: string;
  pairingPublicKey: string;
  wallet: string;
  nonce: string;
  expiresAt: string;
}): string {
  return [
    "Revive PSG1 checkout authorization",
    `domain:${input.domain}`,
    `challenge:${input.challengeId}`,
    `session:${input.sessionId}`,
    `device:${input.deviceId}`,
    `desktop-key:${input.pairingPublicKey}`,
    `wallet:${input.wallet}`,
    `nonce:${input.nonce}`,
    `expires:${input.expiresAt}`,
    "This signature does not authorize a blockchain transaction."
  ].join("\n");
}

export function browserProofMessage(input: {
  domain: string;
  challengeId: string;
  sessionId: string;
  deviceId: string;
  pairingPublicKey: string;
  browserNonceHash: string;
  nonce: string;
  expiresAt: string;
}): string {
  return [
    "Revive PSG1 local browser proof",
    `domain:${input.domain}`,
    `challenge:${input.challengeId}`,
    `session:${input.sessionId}`,
    `device:${input.deviceId}`,
    `desktop-key:${input.pairingPublicKey}`,
    `browser-nonce-hash:${input.browserNonceHash}`,
    `nonce:${input.nonce}`,
    `expires:${input.expiresAt}`,
    "Only sign this after a checkout page on this computer requests it."
  ].join("\n");
}

export function licenseClaimMessage(input: { orderId: string; sessionId: string; deviceId: string }): string {
  return [
    "Revive PSG1 license claim",
    `order:${input.orderId}`,
    `session:${input.sessionId}`,
    `device:${input.deviceId}`
  ].join("\n");
}
