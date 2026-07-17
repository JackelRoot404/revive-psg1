import { Wizard } from "./wizard";
import { isDevelopmentHardwareFixtureEnabled, isEarlyAccessFree } from "../../lib/server-config";

export const metadata = {
  title: "Web wizard",
  description: "Scan and unlock a compatible PSG1 for free during Early Access."
};

export default function WizardPage() {
  return <main className="wizard-shell"><Wizard
    earlyAccessFree={isEarlyAccessFree()}
    developmentHardwareFixture={isDevelopmentHardwareFixtureEnabled()}
  /></main>;
}
