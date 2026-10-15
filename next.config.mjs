import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./src/assets/fonts/**/*",
      "./node_modules/pdfkit/js/data/**/*",
    ],
  },
  env: {
    NEXT_PUBLIC_GIT_COMMIT: process.env.NEXT_PUBLIC_GIT_COMMIT || "83444cf",
  },
  async redirects() {
    // www.diger.tech → diger.tech (keeps one canonical host for cookies, e-mailed links and SEO).
    return [
      { source: "/:path*", has: [{ type: "host", value: "www.diger.tech" }], destination: "https://diger.tech/:path*", permanent: true },
    ];
  },
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Strict-Transport-Security", value: "max-age=31536000" },
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
