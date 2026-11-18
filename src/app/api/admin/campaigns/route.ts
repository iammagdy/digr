import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { createCampaign, listCampaigns, parseDraft, saveCampaign } from "@/lib/server/campaignStore";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** «الحملات» (DT-20261118-06 phase 2B, Tier A): the admin's campaign drafts. Admin only, server only. Nothing here sends to a customer. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const listed = await listCampaigns(createAdminClient());
  if (!listed.ok) return NextResponse.json({ error: listed.messageAr, notReady: listed.code === "not_ready" }, { status: listed.status });
  return NextResponse.json({ campaigns: listed.rows }, { headers: { "Cache-Control": "no-store" } });
}

/** Create a draft (no id) or save one (id + the revision the screen saw). */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  const parsed = parseDraft(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr }, { status: 400 });
  const db = createAdminClient();
  if (body.id === undefined || body.id === null || body.id === "") {
    const made = await createCampaign(db, { adminId: auth.ctx.adminId, draft: parsed.draft });
    if (!made.ok) return NextResponse.json({ error: made.messageAr, notReady: made.code === "not_ready" }, { status: made.status });
    try { await auth.ctx.audit("email", "مسودة حملة جديدة", made.row.name, { targetType: "campaign", targetId: made.row.id }); } catch { /* the draft is saved; a lost audit row is not a failure */ }
    return NextResponse.json({ campaign: made.row });
  }
  const id = String(body.id);
  const revision = Number(body.revision);
  if (!UUID.test(id) || !Number.isInteger(revision) || revision < 1) return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  const saved = await saveCampaign(db, { adminId: auth.ctx.adminId, id, revision, draft: parsed.draft });
  if (!saved.ok) return NextResponse.json({ error: saved.messageAr, notReady: saved.code === "not_ready" }, { status: saved.status });
  return NextResponse.json({ campaign: saved.row });
}
