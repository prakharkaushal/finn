import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Committed snapshot data (demo fallback + filings archive) is read with fs at
  // runtime, so it has to be traced into the serverless bundles explicitly.
  outputFileTracingIncludes: {
    "/api/*": ["./data/snapshot/**/*"],
    "/api/**/*": ["./data/snapshot/**/*"],
  },
  // pdf.js (via unpdf) ships its own worker build; keep it out of the bundler.
  serverExternalPackages: ["unpdf"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
