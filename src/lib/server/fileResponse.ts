import { NextResponse } from "next/server";
import { contentDispositionOf, contentTypeOfName } from "../downloadName";

/**
 * A FILE THE SITE SERVES ITSELF (round 20). The storage service names a signed-link download by the `download` it was given, percent-encoded in a plain `filename=`: an Arabic name arrives as «%D8%AA...xlsx». So a route reads the bytes from the signed link on the server and answers with ITS OWN header
 * (`filename*` and an ASCII fallback, `contentDispositionOf`); the storage service's headers are never forwarded. The body is passed on as a stream. A failed read is an Arabic error, never a half file.
 */
export const FILE_ERROR_AR = "تعذّر تنزيل الملف الآن. حاول بعد قليل.";

export async function fileResponseFromUrl(signedUrl: string, name: string, fetchFn: typeof fetch = fetch, disposition: "attachment" | "inline" = "attachment"): Promise<Response> {
  const fail = () => NextResponse.json({ success: false, error: FILE_ERROR_AR }, { status: 502 });
  let upstream: Response;
  try { upstream = await fetchFn(signedUrl, { cache: "no-store" }); } catch { return fail(); }
  if (!upstream.ok || !upstream.body) return fail();
  const headers = new Headers({
    "Content-Type": contentTypeOfName(name),
    "Content-Disposition": contentDispositionOf(name, disposition),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const length = upstream.headers.get("content-length");
  if (length && /^\d+$/.test(length)) headers.set("Content-Length", length);
  return new Response(upstream.body, { status: 200, headers });
}

/** A file the site BUILT itself (no storage link to read it from): the same safe headers as above, the bytes as the body. */
export function fileResponseFromBytes(bytes: Uint8Array, name: string, disposition: "attachment" | "inline" = "attachment"): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentTypeOfName(name),
      "Content-Disposition": contentDispositionOf(name, disposition),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(bytes.byteLength),
    },
  });
}
