import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  // This project exports static files. Netlify is the production HTTP server,
  // so the effective security and no-store headers live in netlify.toml rather
  // than in Next's server-only `headers()` hook (which static export ignores).
  poweredByHeader: false
};

export default nextConfig;
