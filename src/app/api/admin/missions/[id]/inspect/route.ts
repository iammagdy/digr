import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../../../lib/supabase/server";
import { loadInspection } from "../../../../../../lib/server/adminMissionInspector";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const safeId = (id: string) => (/^msn_[a-z0-9]{8,40}$/.test(id) ? id : null);

/**
 * Admin only, READ ONLY (this file exports GET and nothing else: no route here accepts a body). One mission as the inspector shows it: the calls, the stages, the planner's decision, the events, by an allow-list with every string redacted
 * (src/lib/server/adminMissionInspector.ts). Who looked is recorded once per opening of the page (`?first=1`), never per poll, and never for a refused or unknown id.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const id = safeId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "bad_input" }, { status: 400 });
  let r;
  try { r = await loadInspection(createAdminClient(), { id }); } catch { return NextResponse.json({ error: "inspect_failed" }, { status: 500 }); }
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  if (new URL(req.url).searchParams.get("first") === "1") await auth.ctx.audit("inspect", "فحص تفاصيل مهمة", id);
  return NextResponse.json(r.body, { headers: { "cache-control": "no-store" } });
}
