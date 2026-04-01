import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  turbopack: {
    // Explicitly set root so Turbopack finds next/package.json even when the
    // sandbox infers a wrong workspace root from the directory structure.
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
