import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { approvalAvailable, approveAddonForCustomer } from "@/lib/agentMission/stage4/approvalRoute";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, error: string) => NextResponse.json({ success: false, error }, { status, headers: NO_STORE });

/**
 * LAUNCH ROUND, WORKSTREAM 2 (docs/STAGE-4-APPROVAL-ROUTE.md): THE CUSTOMER APPROVES A REVIEW OR AN EDIT QUOTE. Behind DIGER_STAGE4_APPROVAL (exactly «on»), read FIRST: off is a 404 before the id, the viewer, the body or the database is looked at.
 *   GET   {available:true} for a signed-in viewer (a guest or an unverified account is told why only when it tries: the POST answers 401 / 403) (the page asks before it draws a button); 404 while the feature is off.
 *   POST  {requestId, expectedPoints} and NOTHING else (any other key is a 400): the request's id and the hold the page showed. The customer is the signed-in viewer (a guest signs up first, an unverified account verifies its e-mail); the price is recalculated here by code
 *         and `expectedPoints` is only compared with it. All the logic is `approveAddonForCustomer` (stage4/approvalRoute.ts): the guard, then the existing approval function (the three existing money functions, deterministic ids, compare-and-set).
 * 200 approved; 409 already approved (a second click), a changed price, another open add-on, a version that moved, an uncertain outcome (`state: "uncertain"`: the points MAY be held, re-read the request's status); 402 not enough points (nothing held); 400 bad body; 401 guest;
 * 403 e-mail not verified; 404 not theirs / not this file's / feature off; 503 the database could not answer. Never cached. No job id, quote id, ledger id, provider or USD is ever in an answer.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!approvalAvailable()) return refuse(404, "not_found");
  const id = safeMissionId((await ctx.params).id);
  if (!id) return refuse(400, "bad_request");
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ success: true, available: true }, { headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!approvalAvailable()) return refuse(404, "not_found");
  const id = safeMissionId((await ctx.params).id);
  if (!id) return refuse(400, "bad_request");
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  // the money-moving call is JSON only: a cross-site form post cannot send this content type without a preflight (belt and braces over the cookie's SameSite)
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return refuse(400, "bad_request");
  let body: unknown = null;
  try { body = await req.json(); } catch { /* bad input: the function answers 400 */ }
  const { userId, isGuest, emailVerified } = auth.viewer;
  const r = await approveAddonForCustomer(createAdminClient(), { missionId: id, userId, isGuest, emailVerified, body });
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
