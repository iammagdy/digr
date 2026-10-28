import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../../../lib/supabase/server";
import { fileLink } from "../../../../../../lib/agentMission/adminActions";

export const dynamic = "force-dynamic";

/** Admin only. ?name=result.xlsx: a two-minute link to that result file of the mission. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const id = (await ctx.params).id;
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!/^msn_[a-z0-9]{8,40}$/.test(id) || !/^result\.(xlsx|csv)$/.test(name)) return NextResponse.json({ error: "bad_input" }, { status: 400 });
  const r = await fileLink(createAdminClient(), { id, name });
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
