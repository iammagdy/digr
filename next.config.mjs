import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_SECURITY_POLICY_REPORT_ONLY } from "./src/lib/csp-policy.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Keep PDFKit's package import map intact; Next's server bundle otherwise
  // drops its #standard-fonts/* imports under the deployed Node runtime.
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./src/assets/fonts/**/*",
      "./node_modules/pdfkit/js/data/**/*",
      "./node_modules/pdfkit/js/standard-fonts/**/*",
    ],
    // The catalog snapshot (10 MB) is READ AT RUNTIME by the model planner (chat) and the admin reverse lookup only; the worker never reads it (the approved plan carries what it needs).
    // (the plan edit re-validates a stored plan against it; the admin planner self-test runs the real planner)
    "/api/chat": ["./data/treg/treg_catalog_sellable.json", "./data/treg/treg_write_actions.json"],
    "/api/chat/edit-plan": ["./data/treg/treg_catalog_sellable.json", "./data/treg/treg_write_actions.json"],
    "/api/admin/reverse-lookup": ["./data/treg/treg_catalog_sellable.json", "./data/treg/treg_write_actions.json"],
    "/api/admin/planner-selftest": ["./data/treg/treg_catalog_sellable.json", "./data/treg/treg_write_actions.json"],
    "/api/admin/recipes-seed": ["./data/treg/treg_catalog_sellable.json"],
    "/api/admin/failures/retry": ["./data/treg/treg_catalog_sellable.json", "./data/treg/treg_write_actions.json"],
  },
  env: {
    NEXT_PUBLIC_GIT_COMMIT: process.env.NEXT_PUBLIC_GIT_COMMIT || "83444cf",
  },
  async redirects() {
    // www.diger.tech → diger.tech (keeps one canonical host for cookies, e-mailed links and SEO).
    return [
      { source: "/:path*", has: [{ type: "host", value: "www.diger.tech" }], destination: "https://diger.tech/:path*", permanent: true },
      // The legal pages live under /legal; the short addresses people type or paste land on them instead of a 404.
      { source: "/terms", destination: "/legal/terms", permanent: true },
      { source: "/privacy", destination: "/legal/privacy", permanent: true },
    ];
  },
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Strict-Transport-Security", value: "max-age=31536000" },
      // Report-only for now: violations go to /api/csp-report, nothing is blocked.
      { key: "Content-Security-Policy-Report-Only", value: CONTENT_SECURITY_POLICY_REPORT_ONLY },
    ];
    // Signed-in areas must never be indexed.
    const noindex = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];
    return [
      { source: "/:path*", headers: common },
      { source: "/dashboard/:path*", headers: noindex },
      { source: "/admin/:path*", headers: noindex },
      { source: "/api/:path*", headers: noindex },
      { source: "/(verify|reset|forgot)", headers: noindex },
    ];
  },
  webpack: (config) => {
    config.resolve.alias["@"] = path.resolve(__dirname, "src");
    return config;
  },
};

export default nextConfig;
