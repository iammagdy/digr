import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

/**
 * AN OLD «FACEBOOK TOPIC REPORT» JOB (DT-20261126-wl4-ph1b, COMMANDER decision a). The report feature was removed (it was never offered to a customer); a job whose saved data still carries
 * `metadata.facebookReport` gets an honest Arabic 410 from the download route BEFORE anything is built or saved (never a 500, never a wrong file). Every other job is served exactly as before.
 */
const world = vi.hoisted(() => ({
  admin: false,
  user: "owner-1",
  /** the results bucket: path -> text or bytes */
  files: new Map<string, string | Buffer>(),
  versions: [] as Array<Record<string, unknown>>,
  signed: [] as Array<{ path: string; download?: string }>,
  uploaded: [] as Array<{ path: string; bytes: Buffer }>,
  /** every database write attempted (table and kind); when `noDbWrites` is on, ANY write throws */
  writes: [] as string[],
  noDbWrites: false,
}));

vi.mock("../src/lib/supabase/server", () => {
  const chain = (result: () => any, table = "?"): any => {
    const write = (kind: string) => () => { world.writes.push(`${kind}:${table}`); if (world.noDbWrites) throw new Error(`DATABASE WRITE (${kind} ${table})`); return c; };
    const c: any = { select: () => c, eq: () => c, not: () => c, order: () => c, limit: () => c, in: () => c, update: write("update"), insert: write("insert"), upsert: write("upsert"), delete: write("delete"), single: async () => result(), maybeSingle: async () => result(), then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject) }; return c; };
  return {
    createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: world.user, app_metadata: world.admin ? { role: "admin" } : {} } }, error: null })) } })),
    createAdminClient: vi.fn(() => ({
      rpc: async () => { world.writes.push("rpc"); if (world.noDbWrites) throw new Error("DATABASE WRITE (rpc)"); return { data: null, error: null }; },
      from: (table: string) => {
        if (table === "job_group_parts") return chain(() => ({ data: null, error: null }));
        if (table === "jobs") return chain(() => ({ data: { id: "job_old1", user_id: "owner-1", status: "completed", delivered_units: 3, charged_credits: 9, reserved_credits: 9, target_volume_max: 3, params: {}, endpoint_id: "x", created_at: "2026-09-01T10:00:00Z", finished_at: "2026-09-01T10:30:00Z" }, error: null }), table);
        if (table === "artifact_versions") return chain(() => ({ data: world.versions, error: null }), table);
        return chain(() => ({ data: table === "missions" ? null : [], error: null }), table);
      },
      storage: {
        from: () => ({
          // like the real storage: a path that holds no file has no signed link and no download
          download: async (path: string) => { const f = world.files.get(path); return f === undefined ? { data: null, error: new Error("not found") } : { data: { text: async () => (typeof f === "string" ? f : f.toString("utf8")) }, error: null }; },
          upload: async (path: string, bytes: Buffer) => { world.files.set(path, bytes); world.uploaded.push({ path, bytes }); return { error: null }; },
          createSignedUrl: async (path: string, _t: number, o?: { download?: string }) => { if (!world.files.has(path)) return { data: null, error: new Error("not found") }; world.signed.push({ path, download: o?.download }); return { data: { signedUrl: `https://signed.example/${path}` }, error: null }; },
        }),
      },
    })),
  };
});
import { GET as downloadRoute } from "../src/app/api/jobs/[id]/download/route";

const OLD_REPORT_DATA = {
  metadata: { title: "old report job", facebookReport: { v: 1, posts: [{ id: "p1" }], request: { topic: "t" }, collection: {} } },
  rows: [{ video_url: "https://example.com/p1", comment_text: "تعليق أول", author: "أحمد" }, { video_url: "https://example.com/p1", comment_text: "تعليق ثانٍ", author: "منى" }],
};
const PLAIN_DATA = { metadata: { title: "plain job" }, rows: OLD_REPORT_DATA.rows };

async function ask(format: string): Promise<{ status: number; json: any }> {
  world.signed = []; world.uploaded = []; world.writes = [];
  const res = await downloadRoute(new NextRequest(`https://x.example/api/jobs/job_old1/download?format=${format}`, { headers: { authorization: "Bearer t" } }), { params: Promise.resolve({ id: "job_old1" }) });
  return { status: res.status, json: await res.json() };
}
function reset(data: unknown) {
  world.admin = false; world.noDbWrites = false; world.files = new Map(); world.versions = [];
  world.files.set("owner-1/job_old1/data.json", JSON.stringify(data));
}

describe("a job saved with the removed report's data gets an honest 410", () => {
  it.each(["xlsx", "pdf", "csv"])("%s: 410 with the Arabic message; nothing is built, uploaded, signed or written", async (format) => {
    reset(OLD_REPORT_DATA);
    world.noDbWrites = true;
    const { status, json } = await ask(format);
    expect(status).toBe(410);
    expect(json.success).toBe(false);
    expect(json.error).toContain("لم يعد متاحًا");
    expect(world.uploaded).toEqual([]);
    expect(world.signed).toEqual([]);
    expect(world.writes).toEqual([]);
  });
});

describe("every other job is served exactly as before (counter-cases)", () => {
  it("xlsx of a job without the report key: 200 and a real workbook with sheets", async () => {
    reset(PLAIN_DATA);
    const { status, json } = await ask("xlsx");
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, format: "xlsx" });
    expect(world.uploaded).toHaveLength(1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(world.uploaded[0].bytes as unknown as ArrayBuffer);
    expect(wb.worksheets.length).toBeGreaterThan(0);
  });
  it("pdf of a job without the report key: 200 and a real PDF (starts with %PDF)", async () => {
    reset(PLAIN_DATA);
    const { status, json } = await ask("pdf");
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, format: "pdf" });
    expect(world.uploaded[0].bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
  it("a job whose title or rows merely mention «تقرير» is an ordinary job (the key, not the word, decides)", async () => {
    reset({ metadata: { title: "تقرير عن الدوري" }, rows: [{ comment_text: "تقرير ممتاز", author: "أحمد" }] });
    const { status } = await ask("xlsx");
    expect(status).toBe(200);
  });
});
