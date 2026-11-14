import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { ALL_CASES, ACCEPTED_DIFFERENCES, OPEN_RISKS } from "../../../../lib/agentMission/shadow/corpus";
import { compareCase, compareCorpus } from "../../../../lib/agentMission/shadow/compare";
import { buildShadowContext } from "../../../../lib/agentMission/shadow/context";
import type { ShadowReport } from "../../../../lib/agentMission/shadow/types";

export const dynamic = "force-dynamic";

/** The only body fields the ad-hoc comparison reads. Anything else (an identifier, an amount, a switch) is refused: the route takes nothing it could act on. */
const ALLOWED_FIELDS = new Set(["request", "answer"]);
const MAX_TEXT = 2000;

let cachedReport: ShadowReport | null = null;
const reportOf = (): ShadowReport => (cachedReport ??= compareCorpus(ALL_CASES, buildShadowContext(), ACCEPTED_DIFFERENCES, OPEN_RISKS));

/**
 * PHASE 7, ADMIN ONLY (docs/intelligence/PHASE-7-SHADOW-EVALUATION.md). OFFLINE and READ-ONLY: it compares production today with the proposed Intelligence behaviour on stored requests, plans and fixtures, and returns a redacted report. It
 * calls no provider and no model, reads no database table, no secret and no Intelligence switch, writes nothing, and cannot turn anything on.
 *   GET            → the summary (counts, gates, risks, assumptions) and the case index;
 *   GET ?case=<id> → one case in full (every finding with its evidence label).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const report = reportOf();
  const id = req.nextUrl.searchParams.get("case");
  if (id !== null) {
    const found = report.cases.find((c) => c.id === id);
    return found ? NextResponse.json({ case: found }) : NextResponse.json({ error: "unknown_case" }, { status: 404 });
  }
  const { cases, ...summary } = report;
  return NextResponse.json({
    ...summary,
    cases: cases.map((c) => ({
      id: c.id, origin: c.origin, group: c.group, request: c.request, verdict: c.verdict,
      counts: { regression: c.findings.filter((f) => f.severity === "regression").length, review: c.findings.filter((f) => f.severity === "review").length, improvement: c.findings.filter((f) => f.severity === "improvement").length },
      customer: c.proposed.production.status, test: c.proposed.test.status,
    })),
  });
}

/** {request, answer?}: the same comparison for a typed request. Never stored and never sent anywhere; the request is echoed back redacted. */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  let body: Record<string, unknown> = {};
  try { const b = await req.json(); body = b && typeof b === "object" && !Array.isArray(b) ? b : {}; } catch { /* bad input below */ }
  const request = typeof body.request === "string" ? body.request.trim() : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : null;
  if (Object.keys(body).some((k) => !ALLOWED_FIELDS.has(k)) || request.length < 3 || request.length > MAX_TEXT || (answer !== null && answer.length > MAX_TEXT)) return NextResponse.json({ error: "bad_input" }, { status: 400 });
  const ctx = { ...buildShadowContext(), nowMs: Date.now() };
  return NextResponse.json({ case: compareCase({ id: "ad-hoc", origin: "ad_hoc", request, ...(answer ? { answer } : {}) }, ctx) });
}
