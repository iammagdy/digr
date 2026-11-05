import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { customerFileLink, customerCsvFile, CSV_REQUEST_INVALID_AR, CUSTOMER_CSV_NAMES } from "@/lib/agentMission/customerActions";
import { contentDispositionOf, contentTypeOfName } from "@/lib/downloadName";
import { fileResponseFromBytes, fileResponseFromUrl } from "@/lib/server/fileResponse";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { versionsAvailable } from "@/lib/agentMission/stage4/versionList";
import { parseVersionNumber, readVersionFile } from "@/lib/agentMission/stage4/versionFile";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, error: string) => NextResponse.json({ success: false, error }, { status, headers: NO_STORE });

/**
 * MONEY PR 7b (2B-2 task 1), `&version=N`: the Excel file of ONE PUBLISHED VERSION of the customer's own mission, built from the stored `versions/vNNNN.json` and answered as the file itself (always streamed). Behind DIGER_STAGE4_VERSIONS, read FIRST:
 * off is a 404 before the id, the viewer or the database is looked at. Then: a bad id, a name other than result.xlsx or a version that is not exactly one positive whole number is a 400; not signed in is the viewer's 401; a mission that is not theirs and one
 * that does not exist are the same 404, and so is a version that is not published (a pending one is not); storage that cannot answer is a 503 (never «missing»); a stored object that is not this mission's well-formed version is a 500 and is never served.
 * Read-only: no write, no signed link, no price, no charge. A request without `version` never comes here.
 */
async function versionFile(req: NextRequest, rawId: string, name: string, versions: string[]): Promise<Response> {
  if (!versionsAvailable()) return refuse(404, "not_found");
  const id = safeMissionId(rawId);
  const version = versions.length === 1 ? parseVersionNumber(versions[0]) : null;
  if (!id || name !== "result.xlsx" || version === null) return refuse(400, "bad_request");
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const r = await readVersionFile(createAdminClient(), { missionId: id, userId: auth.viewer.userId, version });
  if (!r.ok) return refuse(r.status, r.error);
  return fileResponseFromBytes(r.bytes, r.name);
}

/**
 * ?name=result.xlsx: a two-minute link to that result file of the customer's own mission (JSON). ROUND 20, `&stream=1`: the FILE ITSELF, answered with the site's own `Content-Disposition` (`filename*` with the Arabic name and an ASCII fallback): a signed storage link saves an Arabic name
 * percent-encoded («%D8%AA...xlsx»), and that name is not ours to write.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const rawId = (await ctx.params).id;
  const params = new URL(req.url).searchParams;
  // the version branch of the stack (`?version=N`, Excel only: versionFile refuses any other name) and the CSV branch of main (a CSV by name) are separate: a version is served only for `?version=N`, a CSV only for a CSV name
  if (params.has("version")) return versionFile(req, rawId, params.get("name") ?? "", params.getAll("version"));
  const id = safeMissionId(rawId);
  const name = params.get("name") ?? "";
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
