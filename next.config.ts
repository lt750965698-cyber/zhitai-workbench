import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Electron starts the generated self-contained Node server directly. This
  // keeps build tooling out of the installed app and avoids writable state in
  // Program Files on Windows.
  output: "standalone",
};

export default nextConfig;
