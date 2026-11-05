import { NextRequest } from "next/server";
import { GET as editGet, POST as editPost } from "../../src/app/api/missions/[id]/edit-request/route";
import { GET as fileGet } from "../../src/app/api/missions/[id]/file/route";
import { GET as reviewQuoteGet } from "../../src/app/api/missions/[id]/review-quote/route";
import { GET as reviewReportGet } from "../../src/app/api/missions/[id]/review-report/route";
import { GET as reviewRequestGet, POST as reviewRequestPost } from "../../src/app/api/missions/[id]/review-request/route";
import { GET as versionsGet } from "../../src/app/api/missions/[id]/versions/route";
import { MISSION } from "./e2eWorld";

/**
 * STAGE F: THE SITE'S ROUTES AS A CUSTOMER'S BROWSER CALLS THEM (real handlers, real `NextRequest`s; the viewer and the admin client are the mocked, shared session of `e2eSession.ts`).
 */
type Get = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const url = (id: string, path: string, query: string) => `http://localhost/api/missions/${id}/${path}${query ? `?${query}` : ""}`;
const get = (h: Get, path: string) => (id: string = MISSION, query = ""): Promise<Response> => h(new NextRequest(url(id, path, query)), { params: Promise.resolve({ id }) });
const post = (h: Get, path: string) => (body: unknown, id: string = MISSION): Promise<Response> => h(new NextRequest(url(id, path, ""), { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });

export const api = {
  versions: get(versionsGet, "versions"),
  /** the delivered file: `file(id, "name=result.xlsx")` is the ordinary link; `version=N&stream=1` is a published version. */
  file: get(fileGet, "file"),
  versionFile: (n: number | string, id: string = MISSION) => get(fileGet, "file")(id, `name=result.xlsx&version=${n}&stream=1`),
  reviewQuote: get(reviewQuoteGet, "review-quote"),
  reviewRequest: get(reviewRequestGet, "review-request"),
  reviewRequestPost: post(reviewRequestPost as Get, "review-request"),
  reviewReport: get(reviewReportGet, "review-report"),
  editRequest: get(editGet, "edit-request"),
  editRequestPost: post(editPost as Get, "edit-request"),
};
export const json = async (res: Response): Promise<any> => res.json();
