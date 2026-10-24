/**
 * Pages and endpoints that never need to know who is asking: the middleware does not call the sign-in service for them. Every other path
 * keeps the session refresh and the checks of src/middleware.ts. At a conference the landing page, the QR path and the status polling take
 * most of the traffic, and a sign-in call per hit would spend the sign-in service's own limit on visitors who are only looking.
 */
const PUBLIC_EXACT = new Set(["/", "/pricing", "/calculator", "/contact", "/services", "/join", "/robots.txt", "/sitemap.xml", "/api/busy-status", "/api/driver-status", "/api/csp-report", "/api/llm-enabled", "/api/analytics/collect"]);
const PUBLIC_PREFIX = ["/legal/", "/for/", "/services/", "/join/", "/brand/", "/samples/", "/api/calculator/"];

export function isPublicPath(pathname: string): boolean {
  const path = String(pathname || "");
  if (PUBLIC_EXACT.has(path)) return true;
  return PUBLIC_PREFIX.some((prefix) => path.startsWith(prefix));
}
