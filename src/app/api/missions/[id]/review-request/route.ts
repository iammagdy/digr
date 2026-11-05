import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { cancelReviewRequest, createReviewRequest, currentReviewRequest } from "@/lib/agentMission/stage4/reviewRequest";
import { reviewPreviewAvailable } from "@/lib/agentMission/stage4/reviewPreview";
import { parseVersionNumber } from "@/lib/agentMission/stage4/versionFile";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, error: string) => NextResponse.json({ success: false, error }, { status, headers: NO_STORE });

/**
 * MONEY PR 7d (2B-2 task 3), behind DIGER_STAGE4_REVIEW (read FIRST: off is a 404 before the id, the viewer or the database is looked at). A review request BEFORE payment: nothing is held, charged, released or refunded; no job, no provider, no model.
 *   GET                                 the waiting review request of this file, or null (the page finds it again after a refresh);
 *   POST {action:"create", version}     makes the request for that PUBLISHED version: 201 {created:true, request}, or 200 {created:false, request} when it already waits (a second click, a refresh);
 *   POST {action:"cancel", requestId}   cancels an UNPAID waiting request with one compare-and-set.
 * The body holds the version or the request id and NOTHING else: any other field (a price, a cell count, a plan, an owner) is a 400. The owner is the signed-in viewer; the price, the cells and the plan are made here by code.
 * 400 bad input; 401 not signed in; 404 a mission or request that is not theirs and one that does not exist (the same answer), or a version that is not published; 409 `open_addon` (another add-on is open), `review_exists` (reviewed already, free),
 * `too_large`, `nothing_to_review`, `changed` (the request is no longer waiting); 503 the storage or the database could not answer; 500 a stored object that is not this mission's version. Never cached.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!reviewPreviewAvailable()) return refuse(404, "not_found");
  const id = safeMissionId((await ctx.params).id);
  if (!id) return refuse(400, "bad_request");
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const r = await currentReviewRequest(createAdminClient(), { missionId: id, userId: auth.viewer.userId });
  return r.ok ? NextResponse.json({ success: true, request: r.request }, { headers: NO_STORE }) : refuse(r.status, r.error);
}

const ALLOWED_KEYS: Record<string, readonly string[]> = { create: ["action", "version"], cancel: ["action", "requestId"] };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!reviewPreviewAvailable()) return refuse(404, "not_found");
  const id = safeMissionId((await ctx.params).id);
  if (!id) return refuse(400, "bad_request");
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  let body: any = null;
  try { body = await req.json(); } catch { /* bad input below */ }
  const action = body && typeof body === "object" && !Array.isArray(body) && typeof body.action === "string" ? body.action : "";
  const allowed = ALLOWED_KEYS[action];
  if (!allowed || Object.keys(body).some((k) => !allowed.includes(k))) return refuse(400, "bad_request");
  const client = createAdminClient();
  const { userId } = auth.viewer;
  if (action === "create") {
    const version = typeof body.version === "number" || typeof body.version === "string" ? parseVersionNumber(String(body.version)) : null;
    if (version === null) return refuse(400, "bad_request");
    const r = await createReviewRequest(client, { missionId: id, userId, version });
    return r.ok ? NextResponse.json({ success: true, created: r.created, request: r.request }, { status: r.created ? 201 : 200, headers: NO_STORE }) : refuse(r.status, r.error);
  }
  const requestId = typeof body.requestId === "string" ? safeMissionId(body.requestId) : null;
  if (!requestId) return refuse(400, "bad_request");
  const r = await cancelReviewRequest(client, { missionId: id, userId, requestId });
  return r.ok ? NextResponse.json({ success: true }, { headers: NO_STORE }) : refuse(r.status, r.error);
}
