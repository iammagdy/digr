/**
 * Content-Security-Policy, sent in REPORT-ONLY mode first: browsers report violations to /api/csp-report and block
 * nothing. 'unsafe-inline' is needed for Next's inline bootstrap scripts and styles until a nonce setup replaces it;
 * everything else is restricted to this site and the project's Supabase hosts.
 * Plain .mjs so next.config.mjs can import it without a TypeScript loader.
 */
export const CSP_REPORT_PATH = "/api/csp-report";

export const CONTENT_SECURITY_POLICY_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.supabase.co",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "worker-src 'self' blob:",
  `report-uri ${CSP_REPORT_PATH}`,
].join("; ");

