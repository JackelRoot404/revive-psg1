import { Wizard } from "./wizard";

export const metadata = {
  title: "Web wizard",
  description: "Scan and license a compatible PSG1 directly from desktop Chrome or Edge."
};

export default function WizardPage() {
  return <main className="wizard-shell"><Wizard /></main>;
}
