import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { customerFileLink } from "@/lib/agentMission/customerActions";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";

export const dynamic = "force-dynamic";

/** ?name=result.xlsx: a two-minute link to that result file of the customer's own mission. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = safeMissionId((await ctx.params).id);
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!id || !/^result\.(xlsx|csv)$/.test(name)) return NextResponse.json({ success: false, error: "bad_request" }, { status: 400 });
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const r = await customerFileLink(createAdminClient(), { id, userId: auth.viewer.userId, name });
  return r.ok ? NextResponse.json({ success: true, url: r.url }) : NextResponse.json({ success: false, error: r.error }, { status: r.status });
}
