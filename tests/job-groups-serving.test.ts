import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { groupPartDataset } from "@/lib/server/multiProvider/groupPartDataset";
import { readJobDatasetText } from "@/lib/server/savedResultColumns";
import { jobHasSavedData } from "@/lib/server/methodologyPurchase";

const routeState = vi.hoisted(() => ({ job: null as any, jobs: {} as Record<string, any>, part: null as any, parts: {} as Record<string, any>, frozen: null as any, frozens: {} as Record<string, any>, objects: {} as Record<string, string>, reads: [] as string[], signed: [] as string[], uploads: [] as string[], partError: null as any, frozenError: null as any, partTimeout: false, storageError: null as any, generatorThrows: false }));
function query(table: string) {
  let jobId = "j";
  const q: any = { select: () => q, eq: (column: string, value: string) => { if (column === "id" || column === "job_id") jobId = value; return q; }, order: () => q, limit: () => q, insert: async () => ({ error: null }), update: () => q, maybeSingle: async () => table === "job_group_parts" ? (routeState.partTimeout ? new Promise(() => {}) : { data: routeState.parts[jobId] ?? routeState.part, error: routeState.partError }) : { data: routeState.frozens[jobId] ?? routeState.frozen, error: routeState.frozenError }, single: async () => ({ data: routeState.jobs[jobId] ?? routeState.job, error: null }), then: (resolve: any, reject: any) => Promise.resolve({ data: [], error: null }).then(resolve, reject) };
  return q;
}
vi.mock("@/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u", app_metadata: { role: routeState.job?.admin ? "admin" : undefined } } } }) } })),
  createAdminClient: vi.fn(() => ({ from: (table: string) => table === "jobs" ? { ...query(table), single: async () => ({ data: routeState.job, error: null }) } : query(table), storage: { from: () => ({ download: async (path: string) => { routeState.reads.push(path); if (routeState.storageError) return { data: null, error: routeState.storageError }; const text = routeState.objects[path]; return text === undefined ? { data: null, error: new Error("not found") } : { data: new Blob([text]), error: null }; }, upload: async (path: string, body: Buffer) => { routeState.uploads.push(path); routeState.objects[path] = body.toString("utf8"); return { error: null }; }, createSignedUrl: async (path: string) => { routeState.signed.push(path); return { data: { signedUrl: `https://signed/${path}` }, error: null }; } }) } })),
}));
vi.mock("@/functions/shared/fileGenerators", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/functions/shared/fileGenerators")>();
  return { ...actual, generateExcelReport: (payload: any, options?: any) => { if (routeState.generatorThrows) throw new Error("generator failure"); return actual.generateExcelReport(payload, options); } };
});
import { GET as downloadRoute } from "@/app/api/jobs/[id]/download/route";
import { GET as dataRoute } from "@/app/api/jobs/[id]/data/route";

const routeA = JSON.stringify({ metadata: { title: "A", entityType: "companies" }, rows: [{ company_name: "A" }] });
const routeB = JSON.stringify({ metadata: { title: "B", entityType: "companies" }, rows: [{ company_name: "B" }] });
function seedRoute(status = "completed", rowCount = 1, jobId = "j", dataset = routeA) {
  const sha = createHash("sha256").update(dataset).digest("hex");
  const job = { id: jobId, user_id: "u", status, delivered_units: status === "failed" ? 0 : rowCount, charged_credits: status === "failed" ? 0 : 10, reserved_credits: 10, target_volume_max: rowCount, params: {}, endpoint_id: "x", template_slug: "x", created_at: "2026-01-01", finished_at: "2026-01-02" };
  const part = { group_id: "grp_1", part_index: 1 };
  const frozen = { path: `u/${jobId}/frozen-${sha}.json`, sha256: sha, row_count: rowCount };
  routeState.job = job; routeState.jobs[jobId] = job;
  routeState.part = part; routeState.parts[jobId] = part; routeState.partError = null; routeState.partTimeout = false;
  routeState.frozen = frozen; routeState.frozens[jobId] = frozen; routeState.frozenError = null; routeState.storageError = null; routeState.generatorThrows = false;
  routeState.objects = { ...routeState.objects, [frozen.path]: dataset, [`u/${jobId}/data.json`]: routeB, [`${jobId}/data.json`]: routeB, "result.xlsx": routeB, [`u/${jobId}/result.xlsx`]: routeB };
  routeState.reads = []; routeState.signed = []; routeState.uploads = [];
  return sha;
}
function callRoute(fn: any, path: string, query = "", jobId = "j") { return fn(new NextRequest(`https://site.test/api/jobs/${jobId}/${path}${query}`, { headers: { authorization: "Bearer token" } }), { params: Promise.resolve({ id: jobId }) }); }

function makeAdmin(opts: { part?: any; frozen?: any; bytes?: string; storageError?: any } = {}) {
  const selects: string[] = [];
  const admin: any = {
    selects,
    from(table: string) {
      selects.push(table);
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: table === "job_group_parts" ? ("part" in opts ? opts.part : { group_id: "grp_1", part_index: 1 }) : (opts.frozen ?? null), error: null }),
      };
    },
    storage: { from: () => ({ download: async (path: string) => ({ data: opts.storageError ? null : new Blob([opts.bytes ?? ""]), error: opts.storageError ?? null, path }) }) },
  };
  return admin;
}

describe("groupPartDataset", () => {
  it("serves only the hash-pinned frozen copy", async () => {
    const text = JSON.stringify({ rows: [{ id: "A" }] });
    const sha256 = createHash("sha256").update(text).digest("hex");
    const admin = makeAdmin({ frozen: { path: `u/j/frozen-${sha256}.json`, sha256, row_count: 1 }, bytes: text });
    await expect(groupPartDataset(admin, { id: "j", user_id: "u", status: "completed" })).resolves.toEqual({ kind: "frozen", text, rowCount: 1, sha256 });
    expect(admin.selects).toEqual(["job_group_parts", "job_group_frozen"]);
  });

  it("preserves ordinary jobs when group lookup confirms no row", async () => {
    const admin = makeAdmin({ part: null });
    await expect(groupPartDataset(admin, { id: "j", user_id: "u" })).resolves.toEqual({ kind: "not_group" });
    expect(admin.selects).toEqual(["job_group_parts"]);
  });

  it("refuses an absent freeze for completed parts and a corrupted copy", async () => {
    const admin = makeAdmin({ frozen: null });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(groupPartDataset(admin, { id: "j", user_id: "u", status: "completed" })).resolves.toMatchObject({ kind: "refuse", status: 503 });
    error.mockRestore();

    const text = JSON.stringify({ rows: [{ id: "A" }] });
    const sha256 = "0".repeat(64);
    const corrupted = makeAdmin({ frozen: { path: `u/j/frozen-${sha256}.json`, sha256, row_count: 1 }, bytes: text });
    await expect(groupPartDataset(corrupted, { id: "j", user_id: "u", status: "completed" })).resolves.toMatchObject({ kind: "refuse", status: 503 });
  });
});

describe("PR-5 saved dataset readers", () => {
  const text = JSON.stringify({ rows: [{ id: "A" }] });
  const sha = createHash("sha256").update(text).digest("hex");
  const frozen = { path: `u/j/frozen-${sha}.json`, sha256: sha, row_count: 1 };
  function admin(part: any, freeze: any = frozen, bytes = text, opts: { partError?: any; freezeError?: any; storageError?: any } = {}) {
    return {
      from: (table: string) => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: table === "job_group_parts" ? part : freeze, error: table === "job_group_parts" ? opts.partError ?? null : opts.freezeError ?? null }) }),
      storage: { from: () => ({ download: async (path: string) => ({ data: opts.storageError || path !== frozen.path ? null : new Blob([bytes]), error: opts.storageError ?? null }) }) },
    };
  }
  it.each(["frozen", "pending", "lookup-error", "storage-error", "completed-unfrozen", "ordinary"])("R-5/R-6 case %s follows the E-1 frozen dataset rules", async (kind) => {
    const part = kind === "ordinary" ? null : { group_id: "g", part_index: 1 };
    const freeze = kind === "frozen" ? frozen : null;
    const opts = kind === "lookup-error" ? { partError: { code: "XX000" } } : kind === "storage-error" ? { storageError: { status: 500 } } : {};
    const db = admin(part, freeze, text, opts);
    const expectedText = kind === "frozen" ? text : "";
    const expectedSaved = kind === "frozen" ? true : kind === "ordinary" ? false : null;
    await expect(readJobDatasetText(db, { id: "j", user_id: "u" })).resolves.toBe(expectedText);
    await expect(jobHasSavedData(db, { jobId: "j", userId: "u" })).resolves.toBe(expectedSaved);
  });
});

describe("PR-4 real download and data readers", () => {
  beforeEach(() => { seedRoute(); });

  it.each(["xlsx", "pdf", "json", "csv"] as const)("download %s serves the frozen A payload, never stored candidates", async (format) => {
    const sha = seedRoute();
    if (format === "csv") routeState.job.admin = true;
    const res = await callRoute(downloadRoute, "download", `?format=${format}`);
    expect(res.status).toBe(200);
    expect(routeState.reads).toEqual([`u/j/frozen-${sha}.json`]);
    expect(routeState.signed.every((path) => path.includes(`served-${sha}.`))).toBe(true);
    expect(routeState.uploads.every((path) => path.includes(`served-${sha}.`))).toBe(true);
  });

  it("data route returns frozen A and reads no mutable dataset", async () => {
    const sha = seedRoute();
    const res = await callRoute(dataRoute, "data");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(JSON.stringify(body.rows)).toContain('"A"');
    expect(routeState.reads).toEqual([`u/j/frozen-${sha}.json`]);
  });

  it.each(["download", "data"] as const)("%s refuses before freeze without reading storage", async (reader) => {
    seedRoute("running"); routeState.frozen = null; routeState.frozens.j = null;
    const res = await callRoute(reader === "download" ? downloadRoute : dataRoute, reader);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("ملف هذا الجزء قيد التجهيز ولم يُتح للتحميل بعد. حاول مرة أخرى لاحقًا.");
    expect(routeState.reads).toEqual([]);
  });

  it.each(["XX000", "PGRST205", "42P01"])("unknown/missing group lookup code %s fails closed or keeps ordinary behavior", async (code) => {
    seedRoute(); routeState.partError = { code, message: "lookup error" };
    const res = await callRoute(dataRoute, "data");
    if (code === "XX000") expect(res.status).toBe(503);
    else expect(res.status).toBe(200);
  });

  it("rejects completed-unfrozen and does not read data.json", async () => {
    seedRoute(); routeState.frozen = null; routeState.frozens.j = null;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callRoute(dataRoute, "data");
    expect(res.status).toBe(503);
    expect(log).toHaveBeenCalledWith("[job-groups:completed-unfrozen]", { jobId: "j" });
    expect(routeState.reads).toEqual([]); log.mockRestore();
  });

  it("returns NO_RELEASABLE_RESULT for running or failed parts before touching storage", async () => {
    for (const status of ["running", "failed"]) {
      seedRoute(status); routeState.job.charged_credits = 0; const res = await callRoute(dataRoute, "data");
      expect(res.status).toBe(409); expect(routeState.reads).toEqual([]);
    }
  });

  it("refuses a hash mismatch without fallback reads", async () => {
    seedRoute(); routeState.objects[routeState.frozen.path] = routeB;
    const res = await callRoute(dataRoute, "data");
    expect(res.status).toBe(503); expect(routeState.reads).toHaveLength(1);
  });

  it.each(["lookup-error", "lookup-timeout", "frozen-select-error"])("(4) %s fails closed on both readers without mutable reads", async (kind) => {
    seedRoute();
    if (kind === "lookup-error") routeState.partError = { code: "XX000", message: "boom" };
    if (kind === "lookup-timeout") routeState.partTimeout = true;
    if (kind === "frozen-select-error") routeState.frozenError = { code: "XX000", message: "boom" };
    const requests = [callRoute(downloadRoute, "download", "?format=xlsx"), callRoute(downloadRoute, "download", "?format=json"), callRoute(dataRoute, "data")];
    const responses = await Promise.all(requests);
    expect(responses.map((res) => res.status)).toEqual([503, 503, 503]);
    for (const res of responses) expect((await res.json()).error).toBe("تعذّر تحميل ملف هذا الجزء الآن. حاول مرة أخرى لاحقًا.");
    expect(routeState.reads).toEqual([]);
  });

  it.each(["missing", "storage-500", "row-count", "bad-path"])("(5) %s refuses without fallback", async (kind) => {
    seedRoute();
    if (kind === "missing") delete routeState.objects[routeState.frozen.path];
    if (kind === "storage-500") routeState.storageError = { status: 500 };
    if (kind === "row-count") routeState.frozen.row_count = 2;
    if (kind === "bad-path") routeState.frozen.path = "u/j/result.json";
    const res = await callRoute(dataRoute, "data");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("تعذّر تحميل ملف هذا الجزء الآن. حاول مرة أخرى لاحقًا.");
    expect(routeState.reads.length).toBeLessThanOrEqual(1);
    expect(routeState.reads.some((path) => path.endsWith("data.json"))).toBe(false);
  });

  it("pins generated files under served-sha names", async () => {
    const sha = seedRoute();
    const res = await callRoute(downloadRoute, "download", "?format=json");
    expect(res.status).toBe(200);
    expect(routeState.uploads).toContain(`u/j/served-${sha}.json`);
    expect(routeState.signed).toContain(`u/j/served-${sha}.json`);
  });

  it("(11) generator failure returns exact 404 and signs no stored candidate", async () => {
    seedRoute();
    routeState.generatorThrows = true;
    const res = await callRoute(downloadRoute, "download", "?format=xlsx");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("الملف المطلوب غير جاهز للتحميل بعد أو انتهت صلاحيته.");
    expect(routeState.signed).toEqual([]);
    routeState.generatorThrows = false;
  });

  it.each(["both buckets", "results only", "json candidate only", "stored result only"])("mutable %s sources cannot replace the frozen rows", async () => {
    const sha = seedRoute();
    routeState.objects["u/j/data.json"] = routeB;
    routeState.objects["j/data.json"] = routeB;
    routeState.objects["json_j"] = routeB;
    routeState.objects["u/j/result.xlsx"] = routeB;
    const res = await callRoute(dataRoute, "data");
    expect(res.status).toBe(200);
    expect(JSON.stringify((await res.json()).rows)).toContain('"A"');
    expect(routeState.reads).toEqual([`u/j/frozen-${sha}.json`]);
  });

  it("serves the database-bound second frozen object and never reads the first", async () => {
    const shaB = createHash("sha256").update(routeB).digest("hex");
    seedRoute(); routeState.frozen = { path: `u/j/frozen-${shaB}.json`, sha256: shaB, row_count: 1 }; routeState.frozens.j = routeState.frozen;
    routeState.objects[routeState.frozen.path] = routeB;
    const res = await callRoute(dataRoute, "data");
    expect(res.status).toBe(200);
    expect(JSON.stringify((await res.json()).rows)).toContain('"B"');
    expect(routeState.reads).toEqual([`u/j/frozen-${shaB}.json`]);
  });

  it("(9) 10 concurrent downloads each for frozen part 1 and part 3 stay pinned during mutable rewrites", async () => {
    const shaA1 = seedRoute("completed", 1, "j1", JSON.stringify({ rows: [{ company_name: "A1" }] }));
    const dataA3 = JSON.stringify({ rows: [{ company_name: "A3" }] });
    const shaA3 = seedRoute("completed", 1, "j3", dataA3);
    const path1 = `u/j1/frozen-${shaA1}.json`, path3 = `u/j3/frozen-${shaA3}.json`;
    const calls = [
      ...Array.from({ length: 10 }, () => callRoute(downloadRoute, "download", "?format=json", "j1")),
      ...Array.from({ length: 10 }, () => callRoute(downloadRoute, "download", "?format=json", "j3")),
    ];
    routeState.objects["u/j1/data.json"] = dataA3; routeState.objects["j1/data.json"] = dataA3;
    routeState.objects["u/j3/data.json"] = routeB; routeState.objects["j3/data.json"] = routeB;
    const responses = await Promise.all(calls);
    expect(responses.every((res) => res.status === 200)).toBe(true);
    for (const [index, res] of responses.entries()) {
      await res.json();
      const name = index < 10 ? "A1" : "A3";
      const served = routeState.uploads[index];
      expect(routeState.objects[served]).toContain(name);
    }
    expect(routeState.reads.filter((path) => path.includes("data.json"))).toEqual([]);
    expect(routeState.reads.filter((path) => path === path1)).toHaveLength(10);
    expect(routeState.reads.filter((path) => path === path3)).toHaveLength(10);
    const ownSource = await import("node:fs").then(({ readFileSync }) => readFileSync("tests/job-groups-serving.test.ts", "utf8"));
    expect(ownSource).not.toMatch(/from ["'][^"']*(jobGroupWorker|jobGroupPlan|jobGroups|planUpgrade)[^"']*["']/);
  });

  it("has no dependency on PR-6 through PR-10", async () => {
    const source = await import("node:fs").then(({ readFileSync }) => readFileSync("tests/job-groups-serving.test.ts", "utf8"));
    expect(source).not.toMatch(/from ["'][^"']*(jobGroupWorker|jobGroupPlan|jobGroups|planUpgrade)[^"']*["']/);
  });
});
