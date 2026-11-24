import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The round "N" badge Next.js shows in a corner on localhost (never on the
  // live site) covered the Cancel button in edit mode, and no corner is free
  // on a phone-width screen. Next.js still shows errors with it off.
  devIndicators: false,
  partialPrefetching: true,
  // The service worker must never be served from a saved copy, or phones could
  // keep running an old version. It may only load scripts from this site.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
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
