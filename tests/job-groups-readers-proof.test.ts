import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { GROUP_PART_FILE_PENDING_AR, GROUP_PART_FILE_UNAVAILABLE_AR } from "@/lib/multiProvider/copy";
import { createAdminClient } from "@/lib/supabase/server";
import { readJobDatasetText } from "@/lib/server/savedResultColumns";
import { jobHasSavedData } from "@/lib/server/methodologyPurchase";

/**
 * PR-5 readers proof (D-0068, plan-r7 T6 reader table lines 7-15): the cases (1) (2) (4) (5) (7) (8) for
 *   R-3 artifacts edit path (POST, paid revision row present)      R-4 methodology route (POST; the guard sits BEFORE the purchase rpc)
 *   R-5 savedResultColumns.readJobDatasetText                      R-6 methodologyPurchase.jobHasSavedData
 * on the REAL routes / helpers and the REAL groupPartDataset, over a fake database and a bucket-aware fake storage that records every operation.
 * Independent file: it imports no other proof file. It changes no source code.
 */
const S = vi.hoisted(() => ({
  jobs: {} as Record<string, any>,
  parts: {} as Record<string, any>,
  frozen: {} as Record<string, any>,
  avRows: [] as any[],
  ledger: new Set<string>(),
  partError: null as any, partTimeout: false, frozenError: null as any, frozenTimeout: false,
  buckets: { results: {}, partials: {} } as Record<string, Record<string, string>>,
  storageErr: null as null | ((bucket: string, path: string) => any),
  ops: [] as { op: string; bucket?: string; path?: string; bytes?: string; name?: string; args?: any }[],
  inserts: [] as any[],
  tables: [] as string[],
}));

function query(table: string) {
  const f: Record<string, string> = {};
  S.tables.push(table);
  const never = () => new Promise(() => {});
  const q: any = {
    select: () => q, not: () => q, limit: () => q, order: () => q,
    eq: (c: string, v: string) => { f[c] = v; return q; },
    insert: async (row: any) => { S.inserts.push({ table, row }); return { error: null }; },
    maybeSingle: async () => {
      if (table === "job_group_parts") return S.partTimeout ? never() : { data: S.parts[f.job_id] ?? null, error: S.partError };
      if (table === "job_group_frozen") return S.frozenTimeout ? never() : { data: S.frozen[f.job_id] ?? null, error: S.frozenError };
      if (table === "credit_ledger") return { data: f.id && S.ledger.has(f.id) ? { id: f.id } : null, error: null };
      return { data: null, error: null };               // missions, ...
    },
    single: async () => ({ data: S.jobs[f.id] ?? null, error: null }),
    then: (res: any, rej: any) => Promise.resolve(table === "artifact_versions" ? { data: S.avRows.filter((r) => r.job_id === f.job_id), error: null } : { data: [], error: null }).then(res, rej),
  };
  return q;
}
vi.mock("@/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u", app_metadata: {} } } }) } })),
  createAdminClient: vi.fn(() => ({
    from: (table: string) => query(table),
    rpc: async (name: string, args: any) => { S.ops.push({ op: "rpc", name, args }); return { data: { success: true, charged: 50, balance: 950 }, error: null }; },
    storage: {
      from: (bucket: string) => ({
        download: async (p: string) => {
          S.ops.push({ op: "download", bucket, path: p });
          const err = S.storageErr?.(bucket, p); const text = S.buckets[bucket]?.[p];
          return err ? { data: null, error: err } : text === undefined ? { data: null, error: new Error("not found") } : { data: new Blob([text]), error: null };
        },
        upload: async (p: string, body: Buffer) => { S.ops.push({ op: "upload", bucket, path: p, bytes: Buffer.from(body).toString("utf8") }); S.buckets[bucket][p] = Buffer.from(body).toString("utf8"); return { error: null }; },
        createSignedUrl: async (p: string) => { S.ops.push({ op: "sign", bucket, path: p }); return { data: { signedUrl: `https://signed/${bucket}/${p}` }, error: null }; },
        remove: async (paths: string[]) => { S.ops.push({ op: "remove", bucket, path: paths.join(",") }); return { error: null }; },
      }),
    },
  })),
}));
const names = (payload: any): string[] => (payload?.rows ?? []).map((r: any) => r.company_name);
vi.mock("@/functions/shared/fileGenerators", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/functions/shared/fileGenerators")>();
  const rec = (tag: string) => (payload: any) => { S.ops.push({ op: `gen:${tag}`, name: names(payload).join(",") }); return Buffer.from(`${tag}|${names(payload).join(",")}`); };
  return { ...actual, generateExcelReport: async (p: any) => rec("XLSX")(p), generatePdfReport: async (p: any) => rec("PDF")(p), generateCsvReport: (p: any) => rec("CSV")(p) };
});
import { POST as artifactsPost } from "@/app/api/jobs/[id]/artifacts/route";
import { POST as methodologyPost } from "@/app/api/jobs/[id]/methodology/route";

const mk = (tag: string, n = 3) => JSON.stringify({ metadata: { title: tag, entityType: "companies" }, rows: Array.from({ length: n }, (_, i) => ({ company_name: `${tag}-${i + 1}`, company_website: `${tag.toLowerCase()}${i + 1}.example` })) });
const namesOf = (tag: string, n = 3) => Array.from({ length: n }, (_, i) => `${tag}-${i + 1}`);
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const A = mk("A"); const B = mk("B"); const O = mk("O"); const P = mk("P");
const shaA = sha(A); const frozenPath = `u/j/frozen-${shaA}.json`;
const S10 = GROUP_PART_FILE_UNAVAILABLE_AR; const S9 = GROUP_PART_FILE_PENDING_AR;
const NOT_COMPLETE_EDIT_AR = "لا يمكن تعديل النتيجة قبل اكتمال الطلب.";

const MUTABLE: [string, string][] = ["results", "partials"].flatMap((b) => ["u/j/data.json", "j/data.json", "results/j/data.json", "partials/j/data.json", "json_j"].map((p) => [b, p] as [string, string]));
function reset() { S.jobs = {}; S.parts = {}; S.frozen = {}; S.avRows = []; S.ledger = new Set(); S.partError = null; S.partTimeout = false; S.frozenError = null; S.frozenTimeout = false; S.buckets = { results: {}, partials: {} }; S.storageErr = null; S.ops = []; S.inserts = []; S.tables = []; }
/** a completed group part frozen as `dataset`; every data.json of both buckets = `mutable`; a paid revision row for version 2 and the first artifact version exist. */
function seed(opts: { dataset?: string; mutable?: string; status?: string; group?: boolean; frozen?: boolean } = {}) {
  const dataset = opts.dataset ?? A; const sh = sha(dataset); const fp = `u/j/frozen-${sh}.json`;
  S.jobs.j = { id: "j", user_id: "u", status: opts.status ?? "completed", delivered_units: 3, charged_credits: 10, reserved_credits: 10, target_volume_max: 3, params: {}, endpoint_id: "x", template_slug: "x" };
  if (opts.group !== false) S.parts.j = { group_id: "grp_1", part_index: 1 };
  if (opts.group !== false && opts.frozen !== false) { S.frozen.j = { path: fp, sha256: sh, row_count: JSON.parse(dataset).rows.length }; S.buckets.results[fp] = dataset; }
  for (const [b, p] of MUTABLE) S.buckets[b][p] = opts.mutable ?? B;
  S.avRows = [{ id: "av_1", job_id: "j", user_id: "u", version_number: 1, file_id_xlsx: "j/v1.xlsx", file_id_pdf: null, file_id_csv: null, created_at: "2026-11-18T00:00:00Z" }];
  S.ledger = new Set(["chg_rev_j_v2"]);
  S.ops = []; S.inserts = []; S.tables = [];
  return { sha: sh, frozenPath: fp };
}

type Reader = "artifacts" | "methodology" | "dataset" | "hasdata";
const READERS: Reader[] = ["artifacts", "methodology", "dataset", "hasdata"];
type Out = { status?: number; body?: any; value?: any };
const hreq = (kind: string, body: any) => new NextRequest(`https://site.test/api/jobs/j/${kind}`, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) });
async function run(reader: Reader): Promise<Out> {
  if (reader === "artifacts") {
    const r = await artifactsPost(hreq("artifacts", { expectedVersionId: "av_1", operation: { action: "convert_formats", formats: ["xlsx", "pdf", "csv"] } }), { params: Promise.resolve({ id: "j" }) });
    return { status: r.status, body: await r.json() };
  }
  if (reader === "methodology") {
    const r = await methodologyPost(hreq("methodology", { confirmed: true, expectedPoints: 50 }), { params: Promise.resolve({ id: "j" }) });
    return { status: r.status, body: await r.json() };
  }
  if (reader === "dataset") return { value: await readJobDatasetText(createAdminClient() as any, { id: "j", user_id: "u" }) };
  return { value: await jobHasSavedData(createAdminClient() as any, { userId: "u", jobId: "j" }) };
}
const ops = (k: string) => S.ops.filter((o) => o.op === k);
const downloads = () => ops("download").map((o) => `${o.bucket}:${o.path}`);
const uploads = () => ops("upload").map((o) => `${o.bucket}:${o.path}`);
const rpcs = () => ops("rpc");
const gens = () => S.ops.filter((o) => o.op.startsWith("gen:")).map((o) => `${o.op.slice(4)}:${o.name}`);
/** nothing was read from mutable sources, written, charged or recorded. */
const expectNothingDone = () => {
  expect(uploads()).toEqual([]); expect(rpcs()).toEqual([]); expect(gens()).toEqual([]); expect(S.inserts).toEqual([]); expect(ops("sign")).toEqual([]);
};
/** the contract of a reader that was REFUSED by the group gate. */
function expectRefused(reader: Reader, out: Out, errorAr: string, status: number) {
  if (reader === "artifacts" || reader === "methodology") { expect(out.status).toBe(status); expect(out.body.success).toBe(false); expect(out.body.error).toBe(errorAr); }
  else if (reader === "dataset") expect(out.value).toBe("");
  else expect(out.value).toBeNull();
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { reset(); errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errSpy.mockRestore(); vi.useRealTimers(); });

// =====================================================================================================================================================
describe("case (1) FROZEN: frozen = A, every data.json (both buckets) = B => every reader yields A, only the frozen copy is read", () => {
  it("R-3 artifacts: the edit is built from A (xlsx, pdf, csv generators receive A) and saved as version 2", async () => {
    seed({ mutable: B });
    const out = await run("artifacts");
    expect(out.status).toBe(200); expect(out.body.success).toBe(true);
    expect(out.body.version.rowCount).toBe(3); expect(out.body.version.versionNum).toBe(2);
    expect(gens().sort()).toEqual([`CSV:${namesOf("A").join(",")}`, `PDF:${namesOf("A").join(",")}`, `XLSX:${namesOf("A").join(",")}`].sort());
    expect(ops("upload").map((o) => [o.path, o.bytes]).sort()).toEqual([
      ["j/v2.csv", `CSV|${namesOf("A").join(",")}`], ["j/v2.pdf", `PDF|${namesOf("A").join(",")}`], ["j/v2.xlsx", `XLSX|${namesOf("A").join(",")}`],
    ]);
    expect(S.inserts.map((i) => [i.table, i.row.version_number, i.row.file_id_xlsx, i.row.file_id_pdf, i.row.file_id_csv])).toEqual([["artifact_versions", 2, "j/v2.xlsx", "j/v2.pdf", "j/v2.csv"]]);
    expect(downloads()).toEqual([`results:${frozenPath}`]);
    expect(JSON.stringify(S.ops)).not.toContain("B-");
  });
  it("R-4 methodology: the PDF is built from A BEFORE the purchase rpc, the rpc runs once with the exact arguments, no data.json is read", async () => {
    seed({ mutable: B });
    const out = await run("methodology");
    expect(out.status).toBe(200); expect(out.body.success).toBe(true); expect(out.body.chargedPoints).toBe(50);
    expect(out.body.methodologyText).not.toContain("B-");
    expect(gens()).toEqual([`PDF:${namesOf("A").join(",")}`]);
    expect(ops("upload").map((o) => [o.path, o.bytes])).toEqual([["u/j/methodology-addon.pdf", `PDF|${namesOf("A").join(",")}`]]);
    expect(rpcs().map((r) => [r.name, r.args])).toEqual([["purchase_methodology_atomic", { p_user_id: "u", p_job_id: "j", p_amount: 50, p_note: expect.any(String) }]]);
    const order = S.ops.map((o) => o.op);                                       // the charge is the LAST step: generated, uploaded, signed, then the rpc
    expect(order.indexOf("rpc")).toBeGreaterThan(order.indexOf("gen:PDF"));
    expect(order.indexOf("rpc")).toBeGreaterThan(order.indexOf("upload"));
    expect(downloads()).toEqual([`results:${frozenPath}`]);
  });
  it("R-5 readJobDatasetText returns exactly the frozen text A; R-6 jobHasSavedData is true; both read only the frozen copy", async () => {
    seed({ mutable: B });
    expect((await run("dataset")).value).toBe(A);
    expect(downloads()).toEqual([`results:${frozenPath}`]);
    S.ops = [];
    expect((await run("hasdata")).value).toBe(true);
    expect(downloads()).toEqual([`results:${frozenPath}`]);
  });
});

// =====================================================================================================================================================
describe("case (2) BEFORE FREEZE: the part is still collecting (running, no frozen row)", () => {
  it("R-3 artifacts: 409 «لا يمكن تعديل النتيجة قبل اكتمال الطلب» (the status gate), nothing read, written or recorded", async () => {
    seed({ status: "running", frozen: false, mutable: B });
    const out = await run("artifacts");
    expect(out.status).toBe(409); expect(out.body.error).toBe(NOT_COMPLETE_EDIT_AR);
    expect(downloads()).toEqual([]); expectNothingDone();
  });
  it("R-4 methodology: the group gate answers S9 409 BEFORE the status check and BEFORE any purchase rpc; nothing read or written", async () => {
    seed({ status: "running", frozen: false, mutable: B });
    const out = await run("methodology");
    expect(out.status).toBe(409); expect(out.body.error).toBe(S9);
    expect(downloads()).toEqual([]); expectNothingDone();
  });
  it("R-5 returns \"\" and R-6 returns null; no data.json path is downloaded", async () => {
    seed({ status: "running", frozen: false, mutable: B });
    expect((await run("dataset")).value).toBe(""); expect((await run("hasdata")).value).toBeNull();
    expect(downloads()).toEqual([]);
  });
});

// =====================================================================================================================================================
describe("case (4) lookup failures: S10 503 / \"\" / null in every reader, no data.json read, no purchase rpc, nothing written", () => {
  const lookupCases: [string, () => void, boolean][] = [
    ["group lookup error code XX000", () => { S.partError = { code: "XX000", message: "lookup error" }; }, false],
    ["group lookup timeout", () => { S.partTimeout = true; }, true],
    ["job_group_frozen select error", () => { S.frozenError = { code: "XX000", message: "frozen select failed" }; }, false],
    ["job_group_frozen select timeout", () => { S.frozenTimeout = true; }, true],
  ];
  for (const [label, setup, timeout] of lookupCases) {
    it.each(READERS)(`${label}: %s`, async (reader) => {
      if (timeout) vi.useFakeTimers();
      seed({ mutable: B }); setup();
      const p = run(reader); if (timeout) await vi.advanceTimersByTimeAsync(4_500);
      expectRefused(reader, await p, S10, 503);
      expect(downloads()).toEqual([]); expectNothingDone();
    });
  }
});

// =====================================================================================================================================================
describe("case (5) a bad frozen object: S10 503 / \"\" / null, no fallback read, no purchase rpc, nothing written", () => {
  const cases: [string, (s: { sha: string }) => void, string[]][] = [
    ["frozen object missing", () => { delete S.buckets.results[frozenPath]; }, [`results:${frozenPath}`]],
    ["storage 500 on the frozen object", () => { S.storageErr = (b, p) => (p === frozenPath ? { message: "storage 500", status: 500 } : null); }, [`results:${frozenPath}`]],
    ["bytes whose sha256 differs from the recorded one", () => { S.buckets.results[frozenPath] = A.replace("A-1", "A-X"); }, [`results:${frozenPath}`]],
    ["row_count mismatch (row says 2, payload has 3)", () => { S.frozen.j.row_count = 2; }, [`results:${frozenPath}`]],
    ["path not of the frozen form (a data.json path)", () => { S.frozen.j.path = "u/j/data.json"; }, []],
    ["path of another user's prefix", (s) => { S.frozen.j.path = `other/j/frozen-${s.sha}.json`; }, []],
  ];
  for (const [label, mutate, reads] of cases) {
    it.each(READERS)(`${label}: %s`, async (reader) => {
      const s = seed({ mutable: B }); mutate(s);
      expectRefused(reader, await run(reader), S10, 503);
      expect(downloads()).toEqual(reads); expectNothingDone();
    });
  }
});

// =====================================================================================================================================================
describe("case (7) completed but NO frozen row (the invariant is broken)", () => {
  it("R-3 artifacts (paid revision present): 503 S10 + the [job-groups:completed-unfrozen] line, nothing read, written or recorded", async () => {
    seed({ frozen: false, mutable: B });
    expect(S.ledger.has("chg_rev_j_v2")).toBe(true);
    expectRefused("artifacts", await run("artifacts"), S10, 503);
    expect(errSpy.mock.calls.some((c: any[]) => c[0] === "[job-groups:completed-unfrozen]")).toBe(true);
    expect(downloads()).toEqual([]); expectNothingDone();
  });
  it("R-4 methodology: 503 S10 + the log line, NO purchase rpc, no upload, no data.json read", async () => {
    seed({ frozen: false, mutable: B });
    expectRefused("methodology", await run("methodology"), S10, 503);
    expect(errSpy.mock.calls.some((c: any[]) => c[0] === "[job-groups:completed-unfrozen]")).toBe(true);
    expect(downloads()).toEqual([]); expectNothingDone();
  });
  it("R-5 \"\" and R-6 null (a part that cannot be proven frozen is never read from its data.json)", async () => {
    seed({ frozen: false, mutable: B });
    expectRefused("dataset", await run("dataset"), S10, 503); expectRefused("hasdata", await run("hasdata"), S10, 503);
    expect(downloads()).toEqual([]);
  });
});

// =====================================================================================================================================================
describe("case (8) NOT A GROUP PART: today's behaviour is kept (the first readable data.json)", () => {
  const notGroup: [string, () => void][] = [
    ["no part row", () => {}],
    ["lookup error code PGRST205", () => { S.partError = { code: "PGRST205", message: "no table" }; }],
    ["lookup error code 42P01", () => { S.partError = { code: "42P01", message: "no relation" }; }],
  ];
  /** an ordinary job: the first candidate holds O, a later one P (so "the first readable" is observable). */
  const seedOrdinary = () => { seed({ group: false, mutable: P }); S.buckets.results["u/j/data.json"] = O; S.ops = []; };
  for (const [label, mutate] of notGroup) {
    it(`${label}: R-3 artifacts builds the edit from O (the first readable data.json), saves v2`, async () => {
      seedOrdinary(); mutate();
      const out = await run("artifacts");
      expect(out.status).toBe(200);
      expect(gens().sort()).toEqual([`CSV:${namesOf("O").join(",")}`, `PDF:${namesOf("O").join(",")}`, `XLSX:${namesOf("O").join(",")}`].sort());
      expect(downloads()).toEqual(["results:u/j/data.json"]);
      expect(S.tables).toContain("job_group_parts");                               // the lookup ran and found no group
    });
    it(`${label}: R-4 methodology builds the PDF from O, then charges once`, async () => {
      seedOrdinary(); mutate();
      const out = await run("methodology");
      expect(out.status).toBe(200);
      expect(gens()).toEqual([`PDF:${namesOf("O").join(",")}`]);
      expect(rpcs().length).toBe(1);
      expect(downloads()).toEqual(["results:u/j/data.json"]);
    });
    it(`${label}: R-5 returns the text of that first data.json and R-6 is true`, async () => {
      seedOrdinary(); mutate();
      expect((await run("dataset")).value).toBe(O);
      expect(downloads()).toEqual(["results:u/j/data.json"]);
      S.ops = [];
      expect((await run("hasdata")).value).toBe(true);
      expect(downloads()).toEqual(["results:u/j/data.json"]);
    });
  }
  it("an ordinary job with NO data.json at all: R-5 \"\", R-6 false, R-3 409, R-4 409 with no purchase rpc (as before)", async () => {
    seed({ group: false, mutable: B });
    for (const [b, p] of MUTABLE) delete S.buckets[b][p];
    S.ops = [];
    expect((await run("dataset")).value).toBe(""); expect((await run("hasdata")).value).toBe(false);
    const a = await run("artifacts"); expect(a.status).toBe(409); expect(a.body.error).toBe("بيانات النتيجة الأصلية غير متاحة للتحرير.");
    const m = await run("methodology"); expect(m.status).toBe(409);
    expect(rpcs()).toEqual([]); expect(uploads()).toEqual([]);
  });
  it("a job WITH a part row is not read like this: the same ordinary data.json O is ignored once the part is frozen as A", async () => {
    seed({ mutable: P }); S.buckets.results["u/j/data.json"] = O; S.ops = [];
    expect((await run("dataset")).value).toBe(A);
    expect(downloads()).toEqual([`results:${frozenPath}`]);
  });
});
