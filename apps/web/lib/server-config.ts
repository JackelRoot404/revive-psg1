import "server-only";

export function isEarlyAccessFree(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.EARLY_ACCESS_FREE !== "false";
}

export function isDevelopmentHardwareFixtureEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV === "development" && environment.REVIVE_DEV_HARDWARE_FIXTURE === "true";
}
