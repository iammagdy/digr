export { CSP_REPORT_PATH, CONTENT_SECURITY_POLICY_REPORT_ONLY } from "./csp-policy.mjs";

/** One safe line per report: the directive and the blocked origin only, never a full URL, query or script sample. */
export function summarizeCspReport(raw: unknown): { directive: string; blocked: string } | null {
  const report = (raw as any)?.["csp-report"] ?? raw;
  if (!report || typeof report !== "object") return null;
  const directive = String((report as any)["effective-directive"] || (report as any)["violated-directive"] || "").split(" ")[0].slice(0, 40);
  if (!/^[a-z-]+$/.test(directive)) return null;
  const blockedRaw = String((report as any)["blocked-uri"] || "");
  let blocked = blockedRaw.slice(0, 20);
  try { blocked = new URL(blockedRaw).origin; } catch { /* keywords like inline, eval, data */ }
  return { directive, blocked: blocked.replace(/[^\w.:/*-]/g, "").slice(0, 80) || "unknown" };
}
