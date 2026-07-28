import "server-only";

export function isEarlyAccessFree(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.EARLY_ACCESS_FREE !== "false";
}

export function isDevelopmentHardwareFixtureEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV === "development" && environment.REVIVE_DEV_HARDWARE_FIXTURE === "true";
}

export function isCompatibilityCheckerOnly(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NEXT_PUBLIC_COMPATIBILITY_CHECKER_ONLY !== "false";
}

export function isBetaBrowserInstallerEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NEXT_PUBLIC_BETA_BROWSER_INSTALLER === "true";
}

export function isDestructiveBrowserFlashingValidated(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NEXT_PUBLIC_DESTRUCTIVE_BROWSER_FLASHING_VALIDATED === "true";
}

// This is intentionally separate from the completed-validation gate. The API
// still permits only its one database-backed hardware-pilot code in this mode.
export function isHardwarePilotEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NEXT_PUBLIC_HARDWARE_PILOT_ENABLED === "true";
}
