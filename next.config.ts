import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Tailwind runs through postcss.config.mjs for both Turbopack (dev) and
  // webpack (production build), so no bundler-specific CSS loader here.
};

export default nextConfig;
