import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { groupPartDataset } from "@/lib/server/multiProvider/groupPartDataset";

const routeState = vi.hoisted(() => ({ job: null as any, part: null as any, frozen: null as any, objects: {} as Record<string, string>, reads: [] as string[], signed: [] as string[], uploads: [] as string[], partError: null as any, frozenError: null as any, storageError: null as any }));
function query(table: string) {
  const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q, insert: async () => ({ error: null }), update: () => q, maybeSingle: async () => table === "job_group_parts" ? { data: routeState.part, error: routeState.partError } : { data: routeState.frozen, error: routeState.frozenError }, single: async () => ({ data: routeState.job, error: null }), then: (resolve: any, reject: any) => Promise.resolve({ data: [], error: null }).then(resolve, reject) };
  return q;
}
vi.mock("@/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u", app_metadata: { role: routeState.job?.admin ? "admin" : undefined } } } }) } })),
  createAdminClient: vi.fn(() => ({ from: (table: string) => table === "jobs" ? { ...query(table), single: async () => ({ data: routeState.job, error: null }) } : query(table), storage: { from: () => ({ download: async (path: string) => { routeState.reads.push(path); if (routeState.storageError) return { data: null, error: routeState.storageError }; const text = routeState.objects[path]; return text === undefined ? { data: null, error: new Error("not found") } : { data: new Blob([text]), error: null }; }, upload: async (path: string, body: Buffer) => { routeState.uploads.push(path); routeState.objects[path] = body.toString("utf8"); return { error: null }; }, createSignedUrl: async (path: string) => { routeState.signed.push(path); return { data: { signedUrl: `https://signed/${path}` }, error: null }; } }) } })),
}));
import { GET as downloadRoute } from "@/app/api/jobs/[id]/download/route";
import { GET as dataRoute } from "@/app/api/jobs/[id]/data/route";

const routeA = JSON.stringify({ metadata: { title: "A", entityType: "companies" }, rows: [{ company_name: "A" }] });
const routeB = JSON.stringify({ metadata: { title: "B", entityType: "companies" }, rows: [{ company_name: "B" }] });
function seedRoute(status = "completed", rowCount = 1) {
  const sha = createHash("sha256").update(routeA).digest("hex");
  routeState.job = { id: "j", user_id: "u", status, delivered_units: status === "failed" ? 0 : rowCount, charged_credits: status === "failed" ? 0 : 10, reserved_credits: 10, target_volume_max: rowCount, params: {}, endpoint_id: "x", template_slug: "x", created_at: "2026-01-01", finished_at: "2026-01-02" };
  routeState.part = { group_id: "grp_1", part_index: 1 }; routeState.partError = null;
  routeState.frozen = { path: `u/j/frozen-${sha}.json`, sha256: sha, row_count: rowCount }; routeState.frozenError = null; routeState.storageError = null;
  routeState.objects = { [routeState.frozen.path]: routeA, "u/j/data.json": routeB, "j/data.json": routeB, "result.xlsx": routeB, "u/j/result.xlsx": routeB };
  routeState.reads = []; routeState.signed = []; routeState.uploads = [];
  return sha;
}
function callRoute(fn: any, path: string, query = "") { return fn(new NextRequest(`https://site.test/api/jobs/j/${path}${query}`, { headers: { authorization: "Bearer token" } }), { params: Promise.resolve({ id: "j" }) }); }

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
    seedRoute("running"); routeState.frozen = null;
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
    seedRoute(); routeState.frozen = null;
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

  it("pins generated files under served-sha names", async () => {
    const sha = seedRoute();
    const res = await callRoute(downloadRoute, "download", "?format=json");
    expect(res.status).toBe(200);
    expect(routeState.uploads).toContain(`u/j/served-${sha}.json`);
    expect(routeState.signed).toContain(`u/j/served-${sha}.json`);
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
    seedRoute(); routeState.frozen = { path: `u/j/frozen-${shaB}.json`, sha256: shaB, row_count: 1 };
    routeState.objects[routeState.frozen.path] = routeB;
    const res = await callRoute(dataRoute, "data");
    expect(res.status).toBe(200);
    expect(JSON.stringify((await res.json()).rows)).toContain('"B"');
    expect(routeState.reads).toEqual([`u/j/frozen-${shaB}.json`]);
  });

  it("concurrent reads stay pinned while mutable sources are rewritten", async () => {
    const shaA = seedRoute();
    const pathA = `u/j/frozen-${shaA}.json`;
    const reads = Array.from({ length: 10 }, () => callRoute(dataRoute, "data"));
    routeState.objects["u/j/data.json"] = routeB;
    routeState.objects["j/data.json"] = routeB;
    const responses = await Promise.all(reads);
    expect(responses.every((res) => res.status === 200)).toBe(true);
    for (const res of responses) expect(JSON.stringify((await res.json()).rows)).toContain('"A"');
    expect(routeState.reads).toEqual(Array(10).fill(pathA));
  });

  it("has no dependency on PR-6 through PR-10", async () => {
    const source = await import("node:fs").then(({ readFileSync }) => readFileSync("tests/job-groups-serving.test.ts", "utf8"));
    expect(source).not.toMatch(/from ["'][^"']*(jobGroupWorker|jobGroupPlan|jobGroups|planUpgrade)[^"']*["']/);
  });
});
