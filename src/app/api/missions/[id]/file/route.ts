import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { customerFileLink } from "@/lib/agentMission/customerActions";
import { fileResponseFromUrl } from "@/lib/server/fileResponse";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";

export const dynamic = "force-dynamic";

/**
 * ?name=result.xlsx: a two-minute link to that result file of the customer's own mission (JSON). ROUND 20, `&stream=1`: the FILE ITSELF, answered with the site's own `Content-Disposition` (`filename*` with the Arabic name and an ASCII fallback): a signed storage link saves an Arabic name
 * percent-encoded («%D8%AA...xlsx»), and that name is not ours to write.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = safeMissionId((await ctx.params).id);
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!id || !/^result\.(xlsx|csv)$/.test(name)) return NextResponse.json({ success: false, error: "bad_request" }, { status: 400 });
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const r = await customerFileLink(createAdminClient(), { id, userId: auth.viewer.userId, name });
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status });
  if (new URL(req.url).searchParams.get("stream") === "1") return fileResponseFromUrl(r.url, r.download);
  return NextResponse.json({ success: true, url: r.url });
}
