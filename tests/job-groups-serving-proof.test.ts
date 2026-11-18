import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GROUP_PART_FILE_PENDING_AR, GROUP_PART_FILE_UNAVAILABLE_AR } from "@/lib/multiProvider/copy";
import { NO_RELEASABLE_RESULT_AR } from "@/lib/producedFormats";

/**
 * PR-4 serving PROOF (D-0067): QA gaps 1-5 of tests/job-groups-serving.test.ts, against the REAL download and data routes and the REAL
 * groupPartDataset, with a fake database and a BUCKET-AWARE fake storage (results vs partials) and recording generator fakes.
 *  (1)(3)(13) the generated CONTENT per format (xlsx, pdf, json, admin csv) is A, with the exact upload / sign operations, also when the
 *      mutable sources are rewritten to B after the freeze (before the call and DURING the request);
 *  (4)(5)(7)(8)(12) every R-1 format + the data route; ordinary-job stored-file fallback when regeneration throws;
 *  (9) 3 parts, 10 + 10 concurrent downloads in xlsx AND json while storage keeps rewriting, plus the data route; this file imports no PR-6..PR-10 module;
 *  (10) each B source (a/b/c/d) isolated, per reader; (11) the served-<sha> path and the link object that stays unchanged.
 * Case numbers are those of plan-r7.md line 468 (T6). Nothing here changes route code.
 */

const S = vi.hoisted(() => ({
  admin: false,
  jobs: {} as Record<string, any>,
  parts: {} as Record<string, any>,
  frozen: {} as Record<string, any>,
  av: {} as Record<string, any>,
  partError: null as any,
  partTimeout: false,
  frozenError: null as any,
  frozenTimeout: false,
  buckets: { results: {}, partials: {} } as Record<string, Record<string, string>>,
  storageErr: null as null | ((bucket: string, path: string) => any),
  uploadError: null as any,
  genThrows: false,
  ops: [] as { op: "download" | "upload" | "sign"; bucket: string; path: string; bytes?: string; upsert?: boolean }[],
  links: [] as any[],
  tables: [] as string[],
  gen: { xlsx: [] as string[][], pdf: [] as string[][], csv: [] as string[][] },
  onRead: null as null | ((bucket: string, path: string) => void),
}));

function query(table: string) {
  const f: Record<string, string> = {};
  let mode = "select";
  let patch: any = null;
  S.tables.push(table);
  const never = () => new Promise(() => {});
  const run = () => {
    if (table === "artifact_versions") {
      const row = S.av[f.job_id ?? ""] ?? null;
      if (mode === "update") {
        if (row && row.id === f.id) { Object.assign(row, patch); S.links.push({ op: "update", job: f.job_id ?? row.job_id, patch }); }
        return { data: null, error: null };
      }
      return { data: row ? [row] : [], error: null };
    }
    return { data: [], error: null };
  };
  const q: any = {
    select: () => q, not: () => q, order: () => q, limit: () => q,
    eq: (c: string, v: string) => { f[c] = v; return q; },
    update: (p: any) => { mode = "update"; patch = p; return q; },
    insert: async (row: any) => { if (table === "artifact_versions") { S.av[row.job_id] = { ...row }; S.links.push({ op: "insert", job: row.job_id, row }); } return { error: null }; },
    maybeSingle: async () => {
      if (table === "job_group_parts") return S.partTimeout ? never() : { data: S.parts[f.job_id] ?? null, error: S.partError };
      if (table === "job_group_frozen") return S.frozenTimeout ? never() : { data: S.frozen[f.job_id] ?? null, error: S.frozenError };
      return { data: null, error: null };
    },
    single: async () => ({ data: S.jobs[f.id] ?? null, error: null }),
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u", app_metadata: { role: S.admin ? "admin" : undefined } } } }) } })),
  createAdminClient: vi.fn(() => ({
    from: (table: string) => query(table),
    storage: {
      from: (bucket: string) => ({
        download: async (p: string) => {
          S.ops.push({ op: "download", bucket, path: p });
          const err = S.storageErr?.(bucket, p);
          const text = S.buckets[bucket]?.[p];
          const out = err ? { data: null, error: err } : text === undefined ? { data: null, error: new Error("not found") } : { data: new Blob([text]), error: null };
          S.onRead?.(bucket, p);
          return out;
        },
        upload: async (p: string, body: Buffer, opts?: any) => {
          S.ops.push({ op: "upload", bucket, path: p, bytes: Buffer.from(body).toString("utf8"), upsert: opts?.upsert });
          if (S.uploadError) return { error: S.uploadError };
          S.buckets[bucket][p] = Buffer.from(body).toString("utf8");
          return { error: null };
        },
        createSignedUrl: async (p: string) => {
          S.ops.push({ op: "sign", bucket, path: p });
          if (S.buckets[bucket]?.[p] === undefined) return { data: null, error: new Error("Object not found") };
          return { data: { signedUrl: `https://signed/${bucket}/${p}` }, error: null };
        },
      }),
    },
  })),
}));

const names = (payload: any): string[] => (payload?.rows ?? []).map((r: any) => r.company_name);
/** the data route returns NORMALIZED rows: the company name comes back under author_name. */
const rowName = (r: any): string => r.company_name ?? r.author_name;
vi.mock("@/functions/shared/fileGenerators", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/functions/shared/fileGenerators")>();
  const rec = (kind: "xlsx" | "pdf" | "csv", tag: string) => (payload: any) => {
    S.gen[kind].push(names(payload));
    if (S.genThrows) throw new Error("generator failure");
    return Buffer.from(`${tag}|${names(payload).join(",")}`);
  };
  return {
    ...actual,
    generateExcelReport: async (payload: any) => rec("xlsx", "XLSX")(payload),
    generatePdfReport: async (payload: any) => rec("pdf", "PDF")(payload),
    generateCsvReport: (payload: any) => rec("csv", "CSV")(payload),
  };
});

import { GET as downloadRoute } from "@/app/api/jobs/[id]/download/route";
import { GET as dataRoute } from "@/app/api/jobs/[id]/data/route";

// ---- datasets: disjoint company names so "built from A" is a string fact ---------------------------------------------------------------------
const mk = (tag: string, n = 3) => JSON.stringify({ metadata: { title: tag, entityType: "companies" }, rows: Array.from({ length: n }, (_, i) => ({ company_name: `${tag}-${i + 1}`, company_website: `${tag.toLowerCase()}${i + 1}.example` })) });
const namesOf = (tag: string, n = 3) => Array.from({ length: n }, (_, i) => `${tag}-${i + 1}`);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const A = mk("A"); const B = mk("B");
const shaA = sha(A); const shaB = sha(B);
const FORMATS = ["xlsx", "pdf", "json", "csv"] as const;
type Fmt = (typeof FORMATS)[number];
const FMT_TAG: Record<string, string> = { xlsx: "XLSX", pdf: "PDF", csv: "CSV" };
const S10 = GROUP_PART_FILE_UNAVAILABLE_AR; const S9 = GROUP_PART_FILE_PENDING_AR;
const NOT_READY_404 = "الملف المطلوب غير جاهز للتحميل بعد أو انتهت صلاحيته.";

/** every mutable place a stale or later-rewritten copy of the part's rows can live (both buckets, every candidate path, stored files and artifact rows). */
const mutablePaths = (job: string, uid = "u"): [string, string][] => [
  ...["results", "partials"].flatMap((b) => [`${uid}/${job}/data.json`, `${job}/data.json`, `partials/${job}/data.json`, `${job}/step_0.json`, `json_${job}`].map((p) => [b, p] as [string, string])),
  ...["xlsx", "pdf", "csv"].flatMap((f) => [`${uid}/${job}/result.${f}`, `${job}/result.${f}`, `${uid}/${job}/data.${f}`, `${job}/data.${f}`, `result.${f}`].map((p) => ["results", p] as [string, string])),
  ["results", `${uid}/${job}/methodology.pdf`], ["results", `${uid}/${job}/stored.xlsx`], ["results", `${uid}/${job}/stored.pdf`], ["results", `${uid}/${job}/stored.csv`],
];
const setMutable = (text: string, job = "j", uid = "u") => { for (const [b, p] of mutablePaths(job, uid)) S.buckets[b][p] = text; };

function resetState() {
  S.admin = false; S.jobs = {}; S.parts = {}; S.frozen = {}; S.av = {}; S.partError = null; S.partTimeout = false; S.frozenError = null; S.frozenTimeout = false;
  S.buckets = { results: {}, partials: {} }; S.storageErr = null; S.uploadError = null; S.genThrows = false; S.ops = []; S.links = []; S.tables = [];
  S.gen = { xlsx: [], pdf: [], csv: [] }; S.onRead = null;
}
/** a group part frozen as `dataset` (rows n), every mutable source = `mutable`. */
function seedPart(opts: { job?: string; dataset?: string; mutable?: string; status?: string; charged?: number; delivered?: number; group?: boolean; frozen?: boolean } = {}) {
  const job = opts.job ?? "j"; const dataset = opts.dataset ?? A; const status = opts.status ?? "completed";
  const delivered = opts.delivered ?? 3;
  const sh = sha(dataset); const frozenPath = `u/${job}/frozen-${sh}.json`;
  S.jobs[job] = { id: job, user_id: "u", status, delivered_units: delivered, charged_credits: opts.charged ?? 10, reserved_credits: 10, target_volume_max: 3, params: {}, endpoint_id: "x", template_slug: "x" };
  if (opts.group !== false) S.parts[job] = { group_id: "grp_1", part_index: Number(job.replace(/\D/g, "")) || 1 };
  if (opts.group !== false && opts.frozen !== false) { S.frozen[job] = { path: frozenPath, sha256: sh, row_count: JSON.parse(dataset).rows.length }; S.buckets.results[frozenPath] = dataset; }
  setMutable(opts.mutable ?? B, job);
  S.av[job] = { id: `av_${job}`, job_id: job, user_id: "u", version_number: 1, file_id_xlsx: `u/${job}/stored.xlsx`, file_id_pdf: `u/${job}/stored.pdf`, file_id_csv: `u/${job}/stored.csv` };
  S.ops = []; S.links = []; S.tables = []; S.gen = { xlsx: [], pdf: [], csv: [] };
  return { job, sha: sh, frozenPath };
}
const req = (job: string, kind: "download" | "data", query = "") => new NextRequest(`https://site.test/api/jobs/${job}/${kind}${query}`, { headers: { authorization: "Bearer token" } });
const callDownload = (format: string, job = "j") => downloadRoute(req(job, "download", `?format=${format}`), { params: Promise.resolve({ id: job }) });
const callData = (job = "j") => dataRoute(req(job, "data"), { params: Promise.resolve({ id: job }) });
const call = (reader: string, job = "j") => (reader === "data" ? callData(job) : callDownload(reader, job));
const READERS = ["xlsx", "pdf", "json", "csv", "data"] as const;
const prepReader = (reader: string) => { S.admin = reader === "csv"; };
const downloads = () => S.ops.filter((o) => o.op === "download").map((o) => `${o.bucket}:${o.path}`);
const uploads = () => S.ops.filter((o) => o.op === "upload");
const signs = () => S.ops.filter((o) => o.op === "sign").map((o) => `${o.bucket}:${o.path}`);

/** the whole contract of a frozen part served as `dataset` (default A, job j): content per format, exact operations, link. */
async function expectServed(format: Fmt | "data", dataset = A, job = "j") {
  const sh = sha(dataset); const rows = names(JSON.parse(dataset)); const other = dataset === A ? "B-" : "A-";
  const res = await call(format, job); const body = await res.json();
  expect(res.status).toBe(200);
  expect(downloads()).toEqual([`results:u/${job}/frozen-${sh}.json`]);                       // the frozen copy only: no data.json, no partials
  if (format === "data") {
    expect(body.success).toBe(true);
    expect(body.rows.map(rowName)).toEqual(rows);
    expect(JSON.stringify(body)).not.toContain(other);
    expect(uploads()).toEqual([]); expect(signs()).toEqual([]);
    return body;
  }
  const served = `u/${job}/served-${sh}.${format}`;
  expect(body.success).toBe(true); expect(body.signedUrl).toBe(`https://signed/results/${served}`);
  expect(uploads().map((o) => [o.bucket, o.path, o.upsert])).toEqual([["results", served, true]]);   // exact upload: the pinned path, never result.* / frozen-*
  expect(signs()).toEqual([`results:${served}`]);                                              // exact sign: the same path, no stored candidate
  const bytes = uploads()[0].bytes!;
  if (format === "json") {
    expect(bytes).toBe(JSON.stringify(JSON.parse(dataset), null, 2));                           // the json body = A
    expect(names(JSON.parse(bytes))).toEqual(rows);
  } else {
    expect(S.gen[format]).toEqual([rows]);                                                     // the generator fake received exactly A
    expect(bytes).toBe(`${FMT_TAG[format]}|${rows.join(",")}`);                                // and the stored bytes are what it built
  }
  expect(bytes).not.toContain(other);
  if (format !== "json") expect(S.av[job].file_id_xlsx === served || S.av[job][`file_id_${format}`] === served).toBe(true); // the link points at the pinned object
  return body;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { resetState(); errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errSpy.mockRestore(); vi.useRealTimers(); });

// =====================================================================================================================================================
describe("(1)(3)(13) frozen = A: the generated content is A in every format, with exact operations, whatever the mutable sources hold", () => {
  it.each(FORMATS)("(1) %s: frozen A, every data.json / stored file / artifact = B => content A, exact upload + sign", async (format) => {
    seedPart({ mutable: B }); S.admin = format === "csv";
    await expectServed(format);
  });
  it("(1) data: frozen A, every mutable source B => rows A, only the frozen copy is read", async () => {
    seedPart({ mutable: B });
    await expectServed("data");
  });
  it.each(FORMATS)("(13) %s: the mutable sources held A at the freeze and are REWRITTEN to B after it => still A", async (format) => {
    seedPart({ mutable: A }); S.admin = format === "csv";
    expect(S.buckets.results["u/j/data.json"]).toBe(A);          // pre-state: collected A
    setMutable(B);                                               // the rewrite after the freeze
    expect(S.buckets.partials["u/j/data.json"]).toBe(B);
    await expectServed(format);
  });
  it("(13) data: rewritten to B after the freeze => rows A", async () => {
    seedPart({ mutable: A }); setMutable(B);
    await expectServed("data");
  });
  it.each(FORMATS)("(3) %s: the sources are rewritten to B DURING the request, right after the frozen copy is read => still A, nothing else read", async (format) => {
    const { frozenPath } = seedPart({ mutable: A }); S.admin = format === "csv";
    S.onRead = (b, p) => { if (p === frozenPath) setMutable(B); };
    await expectServed(format);
    expect(S.buckets.results["u/j/data.json"]).toBe(B);          // the rewrite really happened
  });
  it("(3) data: rewritten right after the frozen read => rows A", async () => {
    const { frozenPath } = seedPart({ mutable: A });
    S.onRead = (b, p) => { if (p === frozenPath) setMutable(B); };
    await expectServed("data");
  });
});

// =====================================================================================================================================================
describe("(4) lookup failures: 503 S10 in every reader, no data.json read, nothing created or signed", () => {
  const expectClosed = async (reader: string) => {
    prepReader(reader);
    const res = await call(reader);
    expect(res.status).toBe(503); expect((await res.json()).error).toBe(S10);
    expect(downloads()).toEqual([]); expect(uploads()).toEqual([]); expect(signs()).toEqual([]);
    expect(S.gen.xlsx.length + S.gen.pdf.length + S.gen.csv.length).toBe(0);
  };
  it.each(READERS)("%s: group lookup error code XX000", async (reader) => {
    seedPart(); S.partError = { code: "XX000", message: "lookup error" };
    await expectClosed(reader);
  });
  it.each(READERS)("%s: group lookup timeout (4 s)", async (reader) => {
    vi.useFakeTimers(); seedPart(); S.partTimeout = true; prepReader(reader);
    const p = call(reader); await vi.advanceTimersByTimeAsync(4_500); const res = await p;
    expect(res.status).toBe(503); expect((await res.json()).error).toBe(S10);
    expect(downloads()).toEqual([]); expect(uploads()).toEqual([]); expect(signs()).toEqual([]);
  });
  it.each(READERS)("%s: job_group_frozen select error", async (reader) => {
    seedPart(); S.frozenError = { code: "XX000", message: "frozen select failed" };
    await expectClosed(reader);
  });
  it.each(READERS)("%s: job_group_frozen select timeout", async (reader) => {
    vi.useFakeTimers(); seedPart(); S.frozenTimeout = true; prepReader(reader);
    const p = call(reader); await vi.advanceTimersByTimeAsync(4_500); const res = await p;
    expect(res.status).toBe(503); expect((await res.json()).error).toBe(S10);
    expect(downloads()).toEqual([]); expect(uploads()).toEqual([]); expect(signs()).toEqual([]);
  });
});

// =====================================================================================================================================================
describe("(5) a bad frozen object: 503 S10, no fallback read, nothing created or signed", () => {
  const cases: [string, (s: { frozenPath: string; sha: string }) => void, (s: { frozenPath: string }) => string[]][] = [
    ["frozen object missing", (s) => { delete S.buckets.results[s.frozenPath]; }, (s) => [`results:${s.frozenPath}`]],
    ["storage 500 on the frozen object", (s) => { S.storageErr = (b, p) => (p === s.frozenPath ? { message: "storage 500", status: 500 } : null); }, (s) => [`results:${s.frozenPath}`]],
    ["bytes whose sha256 differs from the recorded one", (s) => { S.buckets.results[s.frozenPath] = mk("A", 3).replace("A-1", "A-X"); }, (s) => [`results:${s.frozenPath}`]],
    ["row_count mismatch (row says 2, payload has 3)", (s) => { S.frozen.j.row_count = 2; }, (s) => [`results:${s.frozenPath}`]],
    ["path not of the frozen form (a data.json path)", () => { S.frozen.j.path = "u/j/data.json"; }, () => []],
    ["path of another user's prefix", (s) => { S.frozen.j.path = `other/j/frozen-${s.sha}.json`; }, () => []],
  ];
  for (const [label, mutate, expectedReads] of cases) {
    it.each(READERS)(`${label}: %s`, async (reader) => {
      const seeded = seedPart({ mutable: B }); mutate(seeded); prepReader(reader);
      const res = await call(reader);
      expect(res.status).toBe(503); expect((await res.json()).error).toBe(S10);
      expect(downloads()).toEqual(expectedReads(seeded));          // the frozen object at most; never a data.json / result file
      expect(uploads()).toEqual([]); expect(signs()).toEqual([]);
      expect(S.gen.xlsx.length + S.gen.pdf.length + S.gen.csv.length).toBe(0);
    });
  }
});

// =====================================================================================================================================================
describe("(7) completed-unfrozen / awaiting freeze / released part", () => {
  it.each(READERS)("%s: completed with NO frozen row (invariant broken) => 503 S10 and the [job-groups:completed-unfrozen] line, no data.json read", async (reader) => {
    seedPart({ frozen: false, mutable: B }); prepReader(reader);
    const res = await call(reader);
    expect(res.status).toBe(503); expect((await res.json()).error).toBe(S10);
    expect(errSpy.mock.calls.some((c: any[]) => c[0] === "[job-groups:completed-unfrozen]")).toBe(true);
    expect(downloads()).toEqual([]); expect(uploads()).toEqual([]); expect(signs()).toEqual([]);
  });
  it.each(READERS)("%s: awaiting freeze, not yet charged ('running', 0 charged) => NO_RELEASABLE_RESULT_AR 409 BEFORE the group gate (no group lookup), nothing read", async (reader) => {
    seedPart({ frozen: false, status: "running", charged: 0, delivered: 0, mutable: B }); prepReader(reader);
    const res = await call(reader);
    expect(res.status).toBe(409); expect((await res.json()).error).toBe(NO_RELEASABLE_RESULT_AR);
    expect(S.tables).not.toContain("job_group_parts");
    expect(downloads()).toEqual([]); expect(uploads()).toEqual([]); expect(signs()).toEqual([]);
  });
  it.each(READERS)("%s: running with a charge but no frozen row yet => S9 409, nothing read", async (reader) => {
    seedPart({ frozen: false, status: "running", charged: 10, mutable: B }); prepReader(reader);
    const res = await call(reader);
    expect(res.status).toBe(409); expect((await res.json()).error).toBe(S9);
    expect(downloads()).toEqual([]); expect(uploads()).toEqual([]); expect(signs()).toEqual([]);
  });
  it.each(READERS)("%s: a part released by F6 ('failed', 0 delivered, 0 charged) => 409, its data.json never read", async (reader) => {
    seedPart({ frozen: false, status: "failed", charged: 0, delivered: 0, mutable: B }); prepReader(reader);
    const res = await call(reader);
    expect(res.status).toBe(409);
    const error = (await res.json()).error;
    expect(error).toBe(reader === "data" ? NO_RELEASABLE_RESULT_AR : "لا يوجد ملف لتحميله لأن هذا الطلب لم يُسلّم أي سجل، ولم يُخصم منك أي رصيد.");
    expect(S.tables).not.toContain("job_group_parts");
    expect(downloads()).toEqual([]); expect(uploads()).toEqual([]); expect(signs()).toEqual([]);
  });
});

// =====================================================================================================================================================
describe("(8) NOT A GROUP PART: today's behaviour is kept (first readable data.json; a stored file is still signed when regeneration throws)", () => {
  const ORD = mk("O"); const ORD2 = mk("P");
  /** an ordinary job (no group part row): data.json = O in results; a second copy P in the later candidate path; stored result files marked STORED-. */
  const seedOrdinary = () => {
    seedPart({ group: false, mutable: ORD2 });
    S.buckets.results["u/j/data.json"] = ORD;
    for (const f of ["xlsx", "pdf", "csv"]) S.buckets.results[`u/j/result.${f}`] = `STORED-${f}`;
    delete S.av.j;
    S.ops = [];
  };
  const notGroupCases: [string, () => void][] = [
    ["no part row", () => {}],
    ["lookup error code PGRST205 (schema not installed)", () => { S.partError = { code: "PGRST205", message: "no table" }; }],
    ["lookup error code 42P01 (undefined table)", () => { S.partError = { code: "42P01", message: "no relation" }; }],
  ];
  for (const [label, mutate] of notGroupCases) {
    it.each(["xlsx", "pdf", "csv"] as const)(`${label}: %s is regenerated from the first readable data.json (O) and saved at result.<format>`, async (format) => {
      seedOrdinary(); mutate(); S.admin = format === "csv";
      const res = await callDownload(format); const body = await res.json();
      expect(res.status).toBe(200);
      expect(downloads()).toEqual(["results:u/j/data.json"]);                        // the FIRST readable candidate, then it stops
      expect(S.gen[format]).toEqual([namesOf("O")]);                                  // the generator received O (today's behaviour), not P
      expect(uploads().map((o) => o.path)).toEqual([`u/j/result.${format}`]);
      expect(uploads()[0].bytes).toBe(`${FMT_TAG[format]}|${namesOf("O").join(",")}`);
      expect(body.signedUrl).toBe(`https://signed/results/u/j/result.${format}`);
      expect(S.tables).toContain("job_group_parts");                                  // the lookup ran and found no group
    });
    it(`${label}: json signs the stored data.json as today (the json candidate list contains data.json), nothing uploaded; the data route returns O`, async () => {
      seedOrdinary(); mutate();
      const res = await callDownload("json"); const body = await res.json();
      expect(res.status).toBe(200); expect(body.signedUrl).toBe("https://signed/results/u/j/data.json");   // today's behaviour of the ordinary path
      expect(uploads()).toEqual([]);
      expect(signs().at(-1)).toBe("results:u/j/data.json");                                    // earlier candidates (result.json ...) did not exist; the first existing one is signed
      expect(names(JSON.parse(S.buckets.results["u/j/data.json"]))).toEqual(namesOf("O"));
      S.ops = [];
      const d = await (await callData()).json();
      expect(d.rows.map(rowName)).toEqual(namesOf("O"));
      expect(downloads()).toEqual(["results:u/j/data.json"]);
    });
    it.each(["xlsx", "pdf", "csv"] as const)(`${label}: regeneration throws => the STORED result.<format> is still signed (ordinary job only), nothing uploaded: %s`, async (format) => {
      seedOrdinary(); mutate(); S.admin = format === "csv"; S.genThrows = true;
      const res = await callDownload(format); const body = await res.json();
      expect(res.status).toBe(200);
      expect(S.gen[format].length).toBe(1);                                            // regeneration was attempted and threw
      expect(body.signedUrl).toBe(`https://signed/results/u/j/result.${format}`);     // the stored file
      expect(S.buckets.results[`u/j/result.${format}`]).toBe(`STORED-${format}`);     // untouched
      expect(uploads()).toEqual([]);
      expect(signs()).toEqual([`results:u/j/result.${format}`]);
    });
  }
  it("the first readable data.json may live in the partials bucket (results has none): today's order results then partials", async () => {
    seedOrdinary(); S.buckets.results = { ...Object.fromEntries(Object.entries(S.buckets.results).filter(([p]) => !p.endsWith("data.json") && !p.endsWith("step_0.json") && !p.startsWith("json_"))) };
    S.buckets.partials["u/j/data.json"] = ORD;
    const res = await callDownload("xlsx");
    expect(res.status).toBe(200);
    expect(S.gen.xlsx).toEqual([namesOf("O")]);
    expect(downloads().filter((d) => d.startsWith("partials:"))).toEqual(["partials:u/j/data.json"]);
  });
  it("a group part is NOT treated like this: the same job with a part row and a frozen A serves A, not O", async () => {
    seedOrdinary(); S.parts.j = { group_id: "grp_1", part_index: 1 };
    const sh = shaA; S.frozen.j = { path: `u/j/frozen-${sh}.json`, sha256: sh, row_count: 3 }; S.buckets.results[`u/j/frozen-${sh}.json`] = A;
    S.ops = [];
    await expectServed("xlsx");
  });
});

// =====================================================================================================================================================
describe("(9) MULTI-PART RACE AFTER THE STOP: 3 frozen parts, concurrent downloads while storage keeps rewriting, plus the data route", () => {
  const D: Record<string, string> = { job_p1: mk("A1"), job_p2: mk("A2"), job_p3: mk("A3") };
  const seedThree = () => {
    for (const job of ["job_p1", "job_p2", "job_p3"]) seedPart({ job, dataset: D[job], mutable: mk("A3") }); // every mutable copy holds A3's companies
    S.ops = []; S.links = []; S.gen = { xlsx: [], pdf: [], csv: [] };
  };
  // every read of ANY storage object triggers another rewrite of part 1's mutable sources (the storage "keeps rewriting between reads")
  const keepRewriting = () => { S.onRead = () => { setMutable(mk("A3"), "job_p1"); S.buckets.results["u/job_p1/stored.xlsx"] = mk("A3"); }; };
  const jobOfPath = (p: string) => (p.match(/job_p\d/) ?? [""])[0];
  const shaOf = (job: string) => sha(D[job]);

  it.each(["xlsx", "json"] as const)("10 downloads of part 1 and 10 of part 3 at once in %s (+ the data route for all three parts): part 1 is built from A1, part 3 from A3, no data.json is read", async (format) => {
    seedThree(); keepRewriting();
    const jobs = [...Array(10).fill("job_p1"), ...Array(10).fill("job_p3")];
    const results = await Promise.all([...jobs.map((j) => callDownload(format, j).then(async (r) => ({ j, status: r.status, body: await r.json() }))),
      ...["job_p1", "job_p2", "job_p3"].map((j) => callData(j).then(async (r) => ({ j: `data:${j}`, status: r.status, body: await r.json() })))]);
    for (const r of results.slice(0, 20)) {
      expect(r.status).toBe(200);
      expect(r.body.signedUrl).toBe(`https://signed/results/u/${r.j}/served-${shaOf(r.j)}.${format}`);
    }
    const dataRows = (j: string) => results.find((r) => r.j === `data:${j}`)!.body.rows.map(rowName);
    expect(dataRows("job_p1")).toEqual(namesOf("A1")); expect(dataRows("job_p2")).toEqual(namesOf("A2")); expect(dataRows("job_p3")).toEqual(namesOf("A3"));
    // the served objects hold exactly their own part's rows
    for (const job of ["job_p1", "job_p3"]) {
      const obj = S.buckets.results[`u/${job}/served-${shaOf(job)}.${format}`];
      const tag = job === "job_p1" ? "A1" : "A3";
      expect(format === "json" ? names(JSON.parse(obj)) : obj.split("|")[1].split(",")).toEqual(namesOf(tag));
      expect(obj).not.toContain(job === "job_p1" ? "A3-" : "A1-");
    }
    if (format === "xlsx") {                                                              // the generator fake saw A1 ten times and A3 ten times, nothing else
      expect(S.gen.xlsx.length).toBe(20);
      expect(S.gen.xlsx.filter((n) => n.join() === namesOf("A1").join()).length).toBe(10);
      expect(S.gen.xlsx.filter((n) => n.join() === namesOf("A3").join()).length).toBe(10);
    }
    // no mutable path of any of the three parts was read; only the frozen copies were
    const reads = downloads();
    expect(reads.filter((r) => !/\/frozen-[0-9a-f]{64}\.json$/.test(r))).toEqual([]);
    expect(new Set(reads.map(jobOfPath))).toEqual(new Set(["job_p1", "job_p2", "job_p3"]));
    expect(reads.length).toBe(23);                                                        // 20 downloads + 3 data reads, one frozen read each
    // the rewrites really happened (the test is not vacuous)
    expect(S.buckets.results["u/job_p1/data.json"]).toBe(mk("A3"));
    // the served paths are pinned: no result.* upload
    expect(uploads().every((o) => /\/served-[0-9a-f]{64}\.(xlsx|json)$/.test(o.path))).toBe(true);
    expect(uploads().length).toBe(20);
  });

  it("this file imports no PR-6..PR-10 module (every import / mock specifier is on the PR-4 allow-list)", () => {
    const text = readFileSync(path.join(__dirname, "job-groups-serving-proof.test.ts"), "utf8");
    const specs = [...text.matchAll(/(?:from\s+|vi\.mock\(\s*|import\(\s*)["']([^"']+)["']/g)].map((m) => m[1]).filter((s) => !s.includes("`"));
    const allowed = new Set([
      "vitest", "next/server", "node:crypto", "node:fs", "node:path",
      "@/lib/multiProvider/copy", "@/lib/producedFormats",
      "@/app/api/jobs/[id]/download/route", "@/app/api/jobs/[id]/data/route",
      "@/lib/supabase/server", "@/functions/shared/fileGenerators",
    ]);
    expect(specs.length).toBeGreaterThanOrEqual(9);
    expect(specs.filter((s) => !allowed.has(s))).toEqual([]);
  });
});

// =====================================================================================================================================================
describe("(10) OTHER SOURCES DIFFER: each B source isolated, per reader; bucket-aware storage", () => {
  // frozen = A = partials data.json = latest artifact rows; ONLY ONE source = B
  const sources: [string, string, string][] = [
    ["a", "results", "u/j/data.json"],
    ["b", "results", "json_j"],
    ["c", "results", "result.xlsx"],
    ["d", "partials", "u/j/data.json"],
    ["e", "results", "u/j/stored.xlsx"],
  ];
  for (const [id, bucket, p] of sources) {
    it.each(READERS)(`source ${id} (only ${bucket}:${p} = B): %s is built from A and that path is never downloaded or signed`, async (reader) => {
      seedPart({ mutable: A });
      S.buckets[bucket][p] = B;
      prepReader(reader);
      await expectServed(reader as Fmt | "data");
      expect(downloads()).not.toContain(`${bucket}:${p}`);
      expect(signs()).not.toContain(`${bucket}:${p}`);
      expect(S.buckets[bucket][p]).toBe(B);                                         // the fake really holds B there
    });
  }
  it("the fake is bucket-aware: the same path holds different rows in results and partials, and a read of either is recorded with its bucket", async () => {
    seedPart({ mutable: A });
    S.buckets.results["u/j/data.json"] = B; S.buckets.partials["u/j/data.json"] = A;
    expect(S.buckets.results["u/j/data.json"]).not.toBe(S.buckets.partials["u/j/data.json"]);
    await expectServed("json");
    expect(downloads().some((d) => d.endsWith("data.json"))).toBe(false);
  });
});

// =====================================================================================================================================================
describe("(11) PINNED PATH: served-<sha>.<format>, the link object never changes, and a failed regeneration serves nothing stored", () => {
  it.each(["xlsx", "json"] as const)("%s: upload and sign path = u/j/served-<sha>.%s (never result.*, never frozen-*)", async (format) => {
    seedPart({ mutable: B });
    await expectServed(format);
    expect([...uploads().map((o) => o.path), ...S.ops.filter((o) => o.op === "sign").map((o) => o.path)].some((p) => /result\.|frozen-/.test(p))).toBe(false);
  });
  it.each(["xlsx", "pdf", "csv"] as const)("%s: after the link is made the fake overwrites result.%s with B => the linked object is unchanged and is what a later download serves", async (format) => {
    seedPart({ mutable: B }); S.admin = format === "csv";
    await expectServed(format);
    const served = `u/j/served-${shaA}.${format}`;
    expect(S.av.j[`file_id_${format}`]).toBe(served);                                  // the link (artifact_versions) points at the pinned object
    const linked = S.buckets.results[served];
    S.buckets.results[`u/j/result.${format}`] = `OVERWRITTEN-${B}`; S.buckets.results["result.xlsx"] = B; S.buckets.results[`u/j/stored.${format}`] = B; // result.xlsx etc. overwritten with B
    expect(S.buckets.results[served]).toBe(linked);                                    // the linked object is unchanged by the overwrite
    expect(linked).toBe(`${FMT_TAG[format]}|${namesOf("A").join(",")}`);
    S.ops = []; S.gen = { xlsx: [], pdf: [], csv: [] };
    const again = await (await callDownload(format)).json();                           // the next download (the artifact row now holds the served path)
    expect(again.signedUrl).toBe(`https://signed/results/${served}`);
    expect(signs()).toEqual([`results:${served}`]); expect(S.buckets.results[served]).toBe(linked);
  });
  it.each(["xlsx", "pdf", "csv"] as const)("%s: the generator throws => 404 «الملف المطلوب غير جاهز…», NO stored candidate path is signed, nothing is uploaded", async (format) => {
    seedPart({ mutable: B }); S.admin = format === "csv"; S.genThrows = true;
    expect(S.buckets.results[`u/j/result.${format}`]).toBe(B);                         // a signable stored candidate EXISTS and must still not be served
    const res = await callDownload(format);
    expect(res.status).toBe(404); expect((await res.json()).error).toBe(NOT_READY_404);
    expect(S.gen[format].length).toBe(1);
    expect(signs()).toEqual([]); expect(uploads()).toEqual([]);
    expect(downloads()).toEqual([`results:u/j/frozen-${shaA}.json`]);
    expect(S.links).toEqual([]);                                                        // nothing linked
  });
  it("json: the upload fails => 404, no stored result.json is signed, nothing linked", async () => {
    seedPart({ mutable: B }); S.buckets.results["u/j/result.json"] = B; S.uploadError = { message: "upload failed" };
    const res = await callDownload("json");
    expect(res.status).toBe(404); expect((await res.json()).error).toBe(NOT_READY_404);
    expect(signs()).toEqual([]); expect(S.links).toEqual([]);
  });
});

// =====================================================================================================================================================
describe("(12) TWO FROZEN OBJECTS: storage holds frozen-<sha A> and frozen-<sha B>; job_group_frozen binds B => every reader serves B, the A object is never read", () => {
  it.each(READERS)("%s serves B", async (reader) => {
    seedPart({ dataset: B, mutable: A });                                               // the row binds B (and B's frozen object exists)
    S.buckets.results[`u/j/frozen-${shaA}.json`] = A;                                   // a second frozen object: A
    prepReader(reader);
    await expectServed(reader as Fmt | "data", B);
    expect(downloads()).not.toContain(`results:u/j/frozen-${shaA}.json`);
    expect(JSON.stringify(uploads())).not.toContain("A-1");
  });
});
