import "server-only";

export function isEarlyAccessFree(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.EARLY_ACCESS_FREE !== "false";
}
