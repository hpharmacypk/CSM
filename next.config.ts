import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Hide the floating Next.js "N" badge in local development.
  devIndicators: false,
  // Tailwind runs through postcss.config.mjs for both Turbopack (dev) and
  // webpack (production build), so no bundler-specific CSS loader here.
};

export default nextConfig;
