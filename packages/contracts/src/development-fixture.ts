import type { WebCompatibilitySnapshot } from "./schemas";

export const DEVELOPMENT_FIXTURE_DEVICE_ID = "e9074fc42bae73eb1d2b5d8bf65f29da39ced1e3174cdcde596ab84687553070";
export const DEVELOPMENT_FIXTURE_PROFILE_ID = "dev-fixture-psg1-stock-locked";

export const DEVELOPMENT_FIXTURE_COMPATIBILITY: WebCompatibilitySnapshot = Object.freeze({
  product: "PSG1",
  model: "PSG1",
  board: "RK3588S PSG1 V11",
  hardware: "RK3588S",
  buildFingerprint: "PlaySolana/PSG1/PSG1:15/AP4A.241205.013.C1/playsolana-20260521-145647:user/release-keys",
  buildIncremental: "playsolana-20260521-145647",
  systemBuildFingerprint: "PlaySolana/PSG1/PSG1:15/AP4A.241205.013.C1/playsolana-20260521-145647:user/release-keys",
  vendorBuildFingerprint: "PlaySolana/PSG1/PSG1:15/AP4A.241205.013.C1/playsolana-20260521-145647:user/release-keys",
  systemBuildIncremental: "playsolana-20260521-145647",
  systemBuildType: "user",
  lineageVersion: "",
  bootloaderUnlocked: false,
  installationState: "development_fixture",
  androidApiLevel: 35,
  vendorApiLevel: 35,
  batteryPercent: 85,
  charging: true,
  serialVerified: true,
  usbStable: true,
  recoveryCapable: true,
  hostBytesAvailable: 64_000_000_000,
  systemPartitionBytes: 4_000_000_000
});

export function isExactDevelopmentFixture(deviceId: string, compatibility: WebCompatibilitySnapshot): boolean {
  return deviceId === DEVELOPMENT_FIXTURE_DEVICE_ID
    && Object.entries(DEVELOPMENT_FIXTURE_COMPATIBILITY).every(([key, value]) =>
      compatibility[key as keyof WebCompatibilitySnapshot] === value
    );
}
