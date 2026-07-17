import { BETA_PROMO_CODE, BETA_PROMO_LIMIT } from "@revive-psg1/contracts";
import { loadConfig } from "../config";
import { sha256 } from "../security";
import { createDatabase } from "./client";
import { launchGateChecks, promoCodes } from "./schema";

const { db, client } = createDatabase(loadConfig());
await db.insert(promoCodes).values({
  codeHash: sha256(BETA_PROMO_CODE),
  label: "Private beta",
  maxRedemptions: BETA_PROMO_LIMIT
}).onConflictDoNothing();
await db.insert(launchGateChecks).values([
  "beta_licenses_redeemed_10", "windows_success_5", "macos_success_5", "all_beta_profiles_signed",
  "no_unrecovered_beta_devices", "serial_uniqueness_confirmed", "stock_restore_tested", "adversarial_suite_passed"
].map((key) => ({ key }))).onConflictDoNothing();
await client.end();
