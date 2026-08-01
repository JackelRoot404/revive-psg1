import { Wizard } from "./wizard";
import { isDevelopmentHardwareFixtureEnabled } from "../../lib/server-config";

export const metadata = {
  title: "PSG1 browser installer",
  description: "Free browser-guided compatibility and installation for supported stock PSG1 handhelds."
};

export default function WizardPage() {
  return <main className="wizard-shell"><Wizard developmentHardwareFixture={isDevelopmentHardwareFixtureEnabled()} /></main>;
}
