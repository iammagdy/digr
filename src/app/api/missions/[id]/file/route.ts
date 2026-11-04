import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { customerFileLink, customerCsvFile, CSV_REQUEST_INVALID_AR, CUSTOMER_CSV_NAMES } from "@/lib/agentMission/customerActions";
import { contentDispositionOf, contentTypeOfName } from "@/lib/downloadName";
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
  if (!id || !(name === "result.xlsx" || CUSTOMER_CSV_NAMES.includes(name))) return NextResponse.json({ success: false, error: CSV_REQUEST_INVALID_AR }, { status: 400 });
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  // ROUND 32: a CSV is the file itself, built from the customer's own Excel (one stage: a CSV; more: an archive of CSVs with the methodology); an error is an Arabic sentence, and the Excel is never given in its place
  if (CUSTOMER_CSV_NAMES.includes(name)) {
    const csv = await customerCsvFile(createAdminClient(), { id, userId: auth.viewer.userId, name });
    if (!csv.ok) return NextResponse.json({ success: false, error: csv.error }, { status: csv.status });
    return new Response(new Uint8Array(csv.body), { status: 200, headers: { "Content-Type": contentTypeOfName(csv.download), "Content-Disposition": contentDispositionOf(csv.download), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Length": String(csv.body.length) } });
  }
  const r = await customerFileLink(createAdminClient(), { id, userId: auth.viewer.userId, name });
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status });
  if (new URL(req.url).searchParams.get("stream") === "1") return fileResponseFromUrl(r.url, r.download);
  return NextResponse.json({ success: true, url: r.url });
}
