import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { customerFileLink } from "@/lib/agentMission/customerActions";
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
  if (params.has("version")) return versionFile(req, rawId, params.get("name") ?? "", params.getAll("version"));
  const id = safeMissionId(rawId);
  const name = params.get("name") ?? "";
  if (!id || !/^result\.(xlsx|csv)$/.test(name)) return NextResponse.json({ success: false, error: "bad_request" }, { status: 400 });
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const r = await customerFileLink(createAdminClient(), { id, userId: auth.viewer.userId, name });
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status });
  if (new URL(req.url).searchParams.get("stream") === "1") return fileResponseFromUrl(r.url, r.download);
  return NextResponse.json({ success: true, url: r.url });
}
