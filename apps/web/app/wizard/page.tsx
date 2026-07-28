import { Wizard } from "./wizard";
import { isBetaBrowserInstallerEnabled, isCompatibilityCheckerOnly, isDevelopmentHardwareFixtureEnabled } from "../../lib/server-config";

export const metadata = {
  title: "PSG1 browser beta",
  description: "Discord-supervised browser beta for supported PSG1 handhelds."
};

export default function WizardPage() {
  return <main className="wizard-shell"><Wizard
    developmentHardwareFixture={isDevelopmentHardwareFixtureEnabled()}
    compatibilityCheckerOnly={isCompatibilityCheckerOnly()}
    betaBrowserInstaller={isBetaBrowserInstallerEnabled()}
  /></main>;
}
