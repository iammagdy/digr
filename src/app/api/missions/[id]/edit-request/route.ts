import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { cancelEditRequest, createEditRequest, currentEditRequest, editQuoteFor, editSchemaFor, editsAvailable, parseEditInput } from "@/lib/agentMission/stage4/editRequest";
import { parseVersionNumber } from "@/lib/agentMission/stage4/versionFile";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, error: string, messageAr?: string) => NextResponse.json({ success: false, error, ...(messageAr ? { messageAr } : {}) }, { status, headers: NO_STORE });

/**
 * STAGE B, behind DIGER_STAGE4_EDITS (read FIRST: off is a 404 before the id, the viewer or the database is looked at). An edit request BEFORE payment: nothing is held, charged, released or refunded; no job, no provider, no model; the original version is never written.
 *   GET                                 the waiting edit request of this file, or null (the page finds it again after a refresh);
 *   GET ?schema=1                       the latest published version's sheets, editable columns and item counts (no item id, no value);
 *   POST {action:"quote", version, edit}   what the edit would cost, priced HERE by the existing card: read-only, 200 with a state (offer, unsupported, rejected, blocked, not_latest, already_edited, too_large);
 *   POST {action:"create", version, edit}  makes the UNPAID request: 201 {created:true, request}, or 200 {created:false, request} when the very same edit already waits (a second click, a refresh);
 *   POST {action:"cancel", requestId}      cancels an UNPAID waiting request with one compare-and-set.
 * The body holds the version and the edit (or the request id) and NOTHING else: any other field (a price, units, a plan, an owner, an item id, a recipe) is a 400. The owner is the signed-in viewer; the price, the item ids and the plan are made here by code.
 * 400 bad input; 401 not signed in; 404 a mission or request that is not theirs and one that does not exist (the same answer), or a version that is not published; 409 `open_addon`, `not_latest_version`, `already_edited`, `too_large`, `unsupported` (the edit needs a new lookup),
 * `rejected` (with its sentence), `changed`; 503 the storage or the database could not answer; 500 a stored object that is not this mission's version. Never cached.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!editsAvailable()) return refuse(404, "not_found");
  const id = safeMissionId((await ctx.params).id);
  const schema = new URL(req.url).searchParams.getAll("schema");
  if (!id || schema.length > 1 || (schema.length === 1 && schema[0] !== "1")) return refuse(400, "bad_request");
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  if (schema.length === 1) {
    const s = await editSchemaFor(client, { missionId: id, userId: auth.viewer.userId });
    return s.ok ? NextResponse.json({ success: true, schema: s.schema }, { headers: NO_STORE }) : refuse(s.status, s.error);
  }
  const r = await currentEditRequest(client, { missionId: id, userId: auth.viewer.userId });
  return r.ok ? NextResponse.json({ success: true, request: r.request }, { headers: NO_STORE }) : refuse(r.status, r.error);
}

const ALLOWED_KEYS: Record<string, readonly string[]> = { quote: ["action", "version", "edit"], create: ["action", "version", "edit"], cancel: ["action", "requestId"] };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!editsAvailable()) return refuse(404, "not_found");
  const id = safeMissionId((await ctx.params).id);
  if (!id) return refuse(400, "bad_request");
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  let body: any = null;
  try { body = await req.json(); } catch { /* bad input below */ }
  const action = body && typeof body === "object" && !Array.isArray(body) && typeof body.action === "string" ? body.action : "";
  const allowed = ALLOWED_KEYS[action];
  if (!allowed || Object.keys(body).some((k) => !allowed.includes(k)) || !allowed.every((k) => k in body)) return refuse(400, "bad_request");
  const client = createAdminClient();
  const { userId } = auth.viewer;
  if (action === "cancel") {
    const requestId = typeof body.requestId === "string" ? safeMissionId(body.requestId) : null;
    if (!requestId) return refuse(400, "bad_request");
    const r = await cancelEditRequest(client, { missionId: id, userId, requestId });
    return r.ok ? NextResponse.json({ success: true }, { headers: NO_STORE }) : refuse(r.status, r.error);
  }
  const version = typeof body.version === "number" || typeof body.version === "string" ? parseVersionNumber(String(body.version)) : null;
  const edit = parseEditInput(body.edit);
  if (version === null || (!edit.ok && edit.bad)) return refuse(400, "bad_request");
  if (action === "quote") {
    const r = await editQuoteFor(client, { missionId: id, userId, version, edit });
    return r.ok ? NextResponse.json({ success: true, quote: r.quote }, { headers: NO_STORE }) : refuse(r.status, r.error);
  }
  const r = await createEditRequest(client, { missionId: id, userId, version, edit });
  return r.ok ? NextResponse.json({ success: true, created: r.created, request: r.request }, { status: r.created ? 201 : 200, headers: NO_STORE }) : refuse(r.status, r.error, r.messageAr);
}
