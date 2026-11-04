import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asciiFallbackNameOf, contentDispositionOf, fileNameFromDisposition } from "../src/lib/downloadName";
import { fileResponseFromUrl } from "../src/lib/server/fileResponse";

/**
 * ROUND 20, ITEM 2: THE DOWNLOAD NAME. The Excel arrived as «%D8%AA%D8%B9...xlsx»: the site gave the browser a Supabase signed link made with `{ download: <Arabic name> }`, and the storage service writes that name percent-encoded into a plain `filename=`
 * (no `filename*`), which the browser saves as it is. A name the site does not control cannot be fixed there, so every file the site serves now goes through ITS OWN response: the bytes are read from the signed link by the server and returned with
 * `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded name>` (RFC 6266 / 5987). These tests read the RESPONSE HEADER, as a browser does.
 */
const ARABIC = "تغريدات عن محمد صلاح - ٥ - ٣ نوفمبر ٢٠٢٦.xlsx";
const STAR = /^attachment; filename="([\x20-\x7e]+)"; filename\*=UTF-8''((?:%[0-9A-F]{2}|[A-Za-z0-9._~!$&+^`|#-])+)$/;

describe("contentDispositionOf: filename* with the UTF-8 name and a plain ASCII fallback", () => {
  it("an Arabic name: the star form decodes to the exact name, the fallback is plain ASCII with the same extension", () => {
    const h = contentDispositionOf(ARABIC);
    const m = STAR.exec(h);
    expect(m, h).not.toBeNull();
    expect(decodeURIComponent(m![2])).toBe(ARABIC);
    expect(m![1]).toMatch(/^[A-Za-z0-9 ._-]+\.xlsx$/);
    expect(m![1]).not.toContain("%");
    expect(h).not.toMatch(/[^\x20-\x7e]/);
  });
  it("an ASCII name stays itself in both forms", () => {
    expect(contentDispositionOf("report-2026-11-04.pdf")).toBe(`attachment; filename="report-2026-11-04.pdf"; filename*=UTF-8''report-2026-11-04.pdf`);
    expect(contentDispositionOf("calls-log-2026-11-04.csv", "inline")).toBe(`inline; filename="calls-log-2026-11-04.csv"; filename*=UTF-8''calls-log-2026-11-04.csv`);
  });
  it("the characters RFC 5987 does not allow in a value are escaped: ' ( ) * and the percent sign", () => {
    const h = contentDispositionOf("نتائج (١٠٠%) 'أ'*.csv");
    const star = /filename\*=UTF-8''(.+)$/.exec(h)![1];
    expect(star).not.toMatch(/['()*]/);
    expect(decodeURIComponent(star)).toBe("نتائج (١٠٠%) 'أ'*.csv");
  });
  it("a hostile name cannot add a header, a second parameter or a path: quotes, CR, LF, NUL, slashes and backslashes are removed or replaced", () => {
    const h = contentDispositionOf('a"; filename=evil.exe\r\nSet-Cookie: x=1\u0000/..\\b.xlsx');
    expect(h).not.toMatch(/[\r\n\u0000]/);
    expect(h.split(";").length).toBe(3);
    const fallback = /filename="([^"]*)"/.exec(h)![1];
    expect(fallback).not.toMatch(/["\\/]/);
    const decoded = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(h)![1]);
    expect(decoded).not.toMatch(/[\r\n\u0000"\\/]/);
    expect(decoded.endsWith(".xlsx")).toBe(true);
  });
  it("a name with no ASCII letter at all gets a readable ASCII fallback, never underscores only; the extension is kept", () => {
    expect(asciiFallbackNameOf("تغريدات عن محمد صلاح.xlsx")).toBe("diger-results.xlsx");
    expect(asciiFallbackNameOf("نتائج.pdf")).toBe("diger-results.pdf");
    expect(asciiFallbackNameOf("")).toBe("diger-results");
    expect(asciiFallbackNameOf("Mohamed Salah - ٥ - 3 Nov.xlsx")).toBe("Mohamed Salah - - 3 Nov.xlsx");
  });
  it("a very long name stays a valid name: the extension is kept, no half character, the header stays small", () => {
    const long = `${"تغريدات ".repeat(80)}.xlsx`;
    const h = contentDispositionOf(long);
    const decoded = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(h)![1]);
    expect(decoded.endsWith(".xlsx")).toBe(true);
    expect(decoded).not.toContain("�");
    expect(h.length).toBeLessThan(1500);
  });
  it("the name is read back the way the site's own client reads it: filename* first (UTF-8), else the plain name, else null", () => {
    expect(fileNameFromDisposition(contentDispositionOf(ARABIC))).toBe(ARABIC);
    expect(fileNameFromDisposition('attachment; filename="plain.csv"')).toBe("plain.csv");
    expect(fileNameFromDisposition("attachment; filename=%D8%AA.xlsx")).toBe("%D8%AA.xlsx");
    expect(fileNameFromDisposition(null)).toBeNull();
    expect(fileNameFromDisposition("inline")).toBeNull();
  });
});

describe("fileResponseFromUrl: the bytes of a signed link, returned with the site's own header", () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
  it("xlsx: the type, the header, no cache, and the storage service's own (percent-encoded) header is NOT forwarded", async () => {
    const upstream = async () => new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=%D8%AA%D8%B9.xlsx", "content-length": "7" } });
    const res = await fileResponseFromUrl("https://signed.example/f", ARABIC, upstream as unknown as typeof fetch);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(contentDispositionOf(ARABIC));
    expect(res.headers.get("Content-Disposition")).not.toContain("filename=%");
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });
  it.each([["نتائج.csv", "text/csv; charset=utf-8"], ["تقرير.pdf", "application/pdf"], ["بيانات.json", "application/json; charset=utf-8"], ["x.bin", "application/octet-stream"]])("%s is served as %s", async (name, type) => {
    const res = await fileResponseFromUrl("https://signed.example/f", name, (async () => new Response(bytes)) as unknown as typeof fetch);
    expect(res.headers.get("Content-Type")).toBe(type);
    expect(STAR.test(res.headers.get("Content-Disposition") ?? "")).toBe(true);
  });
  it("a storage answer that is not 200, or a call that throws, gives an Arabic JSON error and never a file", async () => {
    for (const upstream of [async () => new Response("nope", { status: 404 }), async () => { throw new Error("network"); }]) {
      const res = await fileResponseFromUrl("https://signed.example/f", ARABIC, upstream as unknown as typeof fetch);
      expect(res.status).toBe(502);
      expect(res.headers.get("Content-Disposition")).toBeNull();
      expect(await res.json()).toEqual({ success: false, error: "تعذّر تنزيل الملف الآن. حاول بعد قليل." });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE ROUTES: every route that handed the browser a signed link now has a mode that serves the file itself (`stream=1`), and the site's own pages use it.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const world = vi.hoisted(() => ({
  user: "u1",
  admin: false,
  mission: null as null | Record<string, unknown>,
  job: null as null | Record<string, unknown>,
  signed: [] as Array<{ path: string; download?: string }>,
  files: new Map<string, string>(),
}));

vi.mock("../src/lib/supabase/server", () => {
  const chain = (result: () => unknown): Record<string, unknown> => {
    const c: Record<string, unknown> = { select: () => c, eq: () => c, not: () => c, order: () => c, limit: () => c, in: () => c, update: () => c, insert: () => c, upsert: () => c, delete: () => c, single: async () => result(), maybeSingle: async () => result(), then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject) };
    return c;
  };
  return {
    createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: world.user, app_metadata: world.admin ? { role: "admin" } : {}, user_metadata: {} } }, error: null })) } })),
    createAdminClient: vi.fn(() => ({
      rpc: async () => ({ data: null, error: null }),
      from: (table: string) => {
        if (table === "missions") return chain(() => ({ data: world.mission, error: null }));
        if (table === "jobs") return chain(() => ({ data: world.job, error: null }));
        if (table === "artifact_versions") return chain(() => ({ data: [{ id: "v1", version_number: 1, file_id_xlsx: "u1/job_x1/result.xlsx", file_id_csv: null, file_id_pdf: null }], error: null }));
        return chain(() => ({ data: [], error: null }));
      },
      storage: {
        from: () => ({
          download: async () => ({ data: null, error: new Error("not found") }),
          upload: async () => ({ error: null }),
          createSignedUrl: async (path: string, _t: number, o?: { download?: string }) => { world.signed.push({ path, download: o?.download }); return { data: { signedUrl: `https://signed.example/${path}?download=${encodeURIComponent(o?.download ?? "")}` }, error: null }; },
        }),
      },
    })),
  };
});
vi.mock("../src/lib/server/adminAuth", async (orig) => ({ ...(await orig<typeof import("../src/lib/server/adminAuth")>()), authenticateAdmin: vi.fn(async () => ({ ok: true, ctx: {} })) }));

import { GET as adminFileRoute } from "../src/app/api/admin/agent/[id]/file/route";
import { GET as jobDownloadRoute } from "../src/app/api/jobs/[id]/download/route";
import { GET as missionFileRoute } from "../src/app/api/missions/[id]/file/route";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const BYTES = new Uint8Array([80, 75, 3, 4, 9, 9, 9]);
const fetched: string[] = [];
const MISSION = (over: Record<string, unknown> = {}) => ({
  id: "msn_ready0001", user_id: "u1", plan: null, request_text: "هات تغريدات", delivered_units: 5, updated_at: "2026-11-03T10:00:00Z",
  files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx", download_name: ARABIC }, { name: "result.csv", path: "result/result.csv", kind: "csv", download_name: "تغريدات عن محمد صلاح - ٥ - ٣ نوفمبر ٢٠٢٦.csv" }],
  ...over,
});
beforeEach(() => {
  world.user = "u1"; world.admin = false; world.mission = MISSION(); world.signed = []; fetched.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(String(url));
    // the storage service as it is: the Arabic name percent-encoded in a plain filename=
    return new Response(BYTES, { status: 200, headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename=${encodeURIComponent(ARABIC)}` } });
  }));
});

const ask = (path: string, headers: Record<string, string> = { authorization: "Bearer t" }) => new NextRequest(`https://x.example${path}`, { headers });

describe("the customer's mission file (the Facebook smoke's Excel)", () => {
  it("stream=1: the bytes with filename* = the mission's Arabic name, a plain ASCII fallback, the Excel type and no cache", async () => {
    const res = await missionFileRoute(ask("/api/missions/msn_ready0001/file?name=result.xlsx&stream=1"), { params: Promise.resolve({ id: "msn_ready0001" }) });
    expect(res.status).toBe(200);
    const h = res.headers.get("Content-Disposition") ?? "";
    expect(STAR.test(h), h).toBe(true);
    expect(fileNameFromDisposition(h)).toBe(ARABIC);
    expect(h).not.toContain("filename=%");
    expect(res.headers.get("Content-Type")).toBe(XLSX_TYPE);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatch(/^https:\/\/signed\.example\/msn_ready0001\/result\/result\.xlsx/);
  });
  it("a customer who asks for the CSV still gets the Excel (the Excel's name and type), as before", async () => {
    const res = await missionFileRoute(ask("/api/missions/msn_ready0001/file?name=result.csv&stream=1"), { params: Promise.resolve({ id: "msn_ready0001" }) });
    expect(res.status).toBe(200);
    expect(fileNameFromDisposition(res.headers.get("Content-Disposition"))).toBe(ARABIC);
    expect(res.headers.get("Content-Type")).toBe(XLSX_TYPE);
  });
  it("without stream the route is what it was: JSON with the signed link", async () => {
    const res = await missionFileRoute(ask("/api/missions/msn_ready0001/file?name=result.xlsx"), { params: Promise.resolve({ id: "msn_ready0001" }) });
    const json = await res.json();
    expect(json).toMatchObject({ success: true });
    expect(String(json.url)).toMatch(/^https:\/\/signed\.example\//);
    expect(fetched).toHaveLength(0);
  });
  it("another customer's mission: 404 JSON, nothing is fetched, no file", async () => {
    world.user = "someone-else";
    const res = await missionFileRoute(ask("/api/missions/msn_ready0001/file?name=result.xlsx&stream=1"), { params: Promise.resolve({ id: "msn_ready0001" }) });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(fetched).toHaveLength(0);
  });
});

describe("the admin's mission file (xlsx and csv)", () => {
  it("stream=1: the Excel and the CSV each with their own type and a filename* with the Arabic name", async () => {
    const x = await adminFileRoute(ask("/api/admin/agent/msn_ready0001/file?name=result.xlsx&stream=1"), { params: Promise.resolve({ id: "msn_ready0001" }) });
    expect(x.status).toBe(200);
    expect(fileNameFromDisposition(x.headers.get("Content-Disposition"))).toBe(ARABIC);
    expect(x.headers.get("Content-Type")).toBe(XLSX_TYPE);
    const c = await adminFileRoute(ask("/api/admin/agent/msn_ready0001/file?name=result.csv&stream=1"), { params: Promise.resolve({ id: "msn_ready0001" }) });
    expect(c.status).toBe(200);
    expect(fileNameFromDisposition(c.headers.get("Content-Disposition"))).toMatch(/\.csv$/);
    expect(c.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(STAR.test(c.headers.get("Content-Disposition") ?? "")).toBe(true);
  });
  it("without stream: JSON with the link, as before", async () => {
    const res = await adminFileRoute(ask("/api/admin/agent/msn_ready0001/file?name=result.xlsx"), { params: Promise.resolve({ id: "msn_ready0001" }) });
    expect(await res.json()).toMatchObject({ url: expect.stringMatching(/^https:\/\/signed\.example\//) });
  });
});

describe("the older request's file (/api/jobs/<id>/download)", () => {
  beforeEach(() => {
    world.mission = null;
    world.job = { id: "job_x1", user_id: "u1", status: "completed", delivered_units: 3, charged_credits: 9, reserved_credits: 9, target_volume_max: 3, params: {}, endpoint_id: "x", created_at: "2026-09-01T10:00:00Z", finished_at: "2026-09-01T10:30:00Z" };
  });
  it("stream=1: the Excel with a filename* (the job's Arabic file name) and the Excel type; the JSON mode still names the file", async () => {
    const res = await jobDownloadRoute(ask("/api/jobs/job_x1/download?format=xlsx&stream=1"), { params: Promise.resolve({ id: "job_x1" }) });
    expect(res.status).toBe(200);
    const h = res.headers.get("Content-Disposition") ?? "";
    expect(STAR.test(h), h).toBe(true);
    expect(fileNameFromDisposition(h)).toMatch(/\.xlsx$/);
    expect(res.headers.get("Content-Type")).toBe(XLSX_TYPE);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    const json = await (await jobDownloadRoute(ask("/api/jobs/job_x1/download?format=xlsx"), { params: Promise.resolve({ id: "job_x1" }) })).json();
    expect(json).toMatchObject({ success: true, format: "xlsx" });
    expect(fileNameFromDisposition(res.headers.get("Content-Disposition"))).toBe(json.downloadFileName);
  });
});
