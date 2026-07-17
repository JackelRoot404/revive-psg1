import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import "./states.css";
import { legalConfig } from "../lib/public-config";

export const metadata: Metadata = {
  title: { default: "Revive PSG1", template: "%s · Revive PSG1" },
  description: "Turn your unused PSG1 into a focused Android gaming handheld.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://revivepsg.com"),
  openGraph: {
    title: "Revive your PSG1",
    description: "A deterministic, self-service Android gaming conversion for compatible PSG1 handhelds.",
    images: [{ url: "/og.png", width: 1200, height: 630 }]
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link className="brand" href="/"><span className="brand-mark">R</span> Revive PSG1</Link>
          <nav aria-label="Primary"><Link href="/docs">How it works</Link><Link href="/license">License status</Link><Link href="/#download">Download</Link></nav>
        </header>
        {children}
        <footer><span>Independent PSG1 recovery tooling by biccsdev. Not affiliated with PlaySolana or Google.</span><nav><a href={legalConfig.supportUrl}>Support</a><Link href="/license">License status</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></nav></footer>
      </body>
    </html>
  );
}
