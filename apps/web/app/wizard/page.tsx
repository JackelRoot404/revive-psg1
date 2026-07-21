import { Wizard } from "./wizard";
import { isCompatibilityCheckerOnly, isDevelopmentHardwareFixtureEnabled, isEarlyAccessFree } from "../../lib/server-config";

export const metadata = {
  title: "Compatibility checker",
  description: "Run a free read-only WebUSB scan to see if your PSG1 matches a supported Revive profile."
};

export default function WizardPage() {
  return <main className="wizard-shell"><Wizard
    earlyAccessFree={isEarlyAccessFree()}
    developmentHardwareFixture={isDevelopmentHardwareFixtureEnabled()}
    compatibilityCheckerOnly={isCompatibilityCheckerOnly()}
  /></main>;
}
