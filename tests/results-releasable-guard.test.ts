import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The live job of 14:59 UTC (PR #253) failed at settlement and released its hold (charged 0) but `delivered_units` stayed 2 and the result file, saved BEFORE
 * settlement, stayed downloadable. A result is released only when the request settled and charged: `resultsReleasable`. SIMULATION: the real routes over an
 * in-memory database and storage; nothing is read from or written to a money table.
 */
const state = vi.hoisted(() => ({
  user: null as any,
  job: null as any,
  versions: [] as any[],
  storage: {} as Record<string, string>,
  calls: [] as string[],
  storageCalls: [] as string[],
  signed: [] as string[],
}));

function chain(result: () => any) {
  const c: any = {
    select: () => c, eq: () => c, not: () => c, order: () => c, limit: () => c, in: () => c,
    single: async () => result(),
    maybeSingle: async () => result(),
    then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
  };
  return c;
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: async (name: string) => { state.calls.push(`rpc:${name}`); return { data: null, error: null }; },
    from: (table: string) => {
      state.calls.push(`from:${table}`);
      if (table === "jobs") return chain(() => ({ data: state.job, error: state.job ? null : new Error("nf") }));
      if (table === "artifact_versions") return chain(() => ({ data: state.versions, error: null }));
      return chain(() => ({ data: [], error: null }));
    },
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          state.storageCalls.push(`download:${bucket}/${path}`);
          const text = state.storage[path];
          return text ? { data: { text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer }, error: null } : { data: null, error: new Error("nf") };
        },
        upload: async (path: string) => { state.storageCalls.push(`upload:${bucket}/${path}`); return { error: null }; },
        createSignedUrl: async (path: string) => { state.storageCalls.push(`sign:${bucket}/${path}`); state.signed.push(path); return { data: { signedUrl: "https://signed.example/x" }, error: null }; },
      }),
    },
  })),
}));

import { GET as download } from "../src/app/api/jobs/[id]/download/route";
import { GET as data } from "../src/app/api/jobs/[id]/data/route";
import { GET as artifacts } from "../src/app/api/jobs/[id]/artifacts/route";
import { NO_RELEASABLE_RESULT_AR, resultsReleasable } from "../src/lib/producedFormats";

const params = { params: Promise.resolve({ id: "job_quote_9bb" }) };
const FILE = "owner-1/job_quote_9bb/result.xlsx";
const DATA_JSON = JSON.stringify({ metadata: { platform: "people", title: "صناع القرار", template: "professional-people-search", entityType: "people" }, rows: [{ contact_name: "Person One", work_email: "p1@x.example" }, { contact_name: "Person Two", work_email: "p2@y.example" }] });
const job = (extra: Record<string, any>) => ({ id: "job_quote_9bb", user_id: "owner-1", status: "failed", delivered_units: 2, charged_credits: 0, reserved_credits: 891, target_volume_max: 3, params: {}, endpoint_id: "treg.people.search", ...extra });

beforeEach(() => {
  state.user = { id: "owner-1", app_metadata: {} };
  state.calls = []; state.storageCalls = []; state.signed = [];
  state.versions = [{ id: "ver_1", version_number: 1, file_id_xlsx: FILE, file_id_pdf: null, file_id_csv: null, created_at: "2026-10-26T15:00:45Z", job_id: "job_quote_9bb", user_id: "owner-1" }];
  state.storage = { [FILE]: "xlsx-bytes", "owner-1/job_quote_9bb/data.json": DATA_JSON };
});
afterEach(() => vi.restoreAllMocks());

describe("resultsReleasable", () => {
  it("true for completed or done, or when points were charged; false for a failed, cancelled, queued or running request with nothing charged", () => {
    for (const status of ["completed", "done", "COMPLETED"]) expect(resultsReleasable({ status, charged_credits: 0 }), status).toBe(true);
    expect(resultsReleasable({ status: "failed", charged_credits: 406 })).toBe(true); // charged: the customer paid for it
    expect(resultsReleasable({ status: "cancelled", chargedCredits: 55 })).toBe(true);
    for (const status of ["failed", "cancelled", "queued", "running", "refused", ""]) expect(resultsReleasable({ status, charged_credits: 0 }), status).toBe(false);
    expect(resultsReleasable({ status: "failed", charged_credits: "0" })).toBe(false);
    expect(resultsReleasable({ status: "failed", delivered_units: 2 } as any)).toBe(false);
    expect(resultsReleasable({ status: "failed" })).toBe(false);
    expect(resultsReleasable(null)).toBe(false);
    expect(NO_RELEASABLE_RESULT_AR).toBe("لا يوجد ملف لتحميله لأن هذا الطلب لم يكتمل، ولم يُخصم منك أي رصيد.");
    expect(NO_RELEASABLE_RESULT_AR).not.toMatch(/[A-Za-z0-9]/);
  });
});

describe("the live case: a failed job with delivered_units 2 and charged 0, whose file was saved before settlement", () => {
  beforeEach(() => { state.job = job({}); });

  it("download: 409 with the Arabic sentence, before any storage, signing, ledger or provider call", async () => {
    for (const format of ["xlsx", "csv", "pdf", "json"]) {
      state.calls = []; state.storageCalls = [];
      const res = await download(new NextRequest(`http://localhost/api/jobs/job_quote_9bb/download?format=${format}`), params);
      const body = await res.json();
      expect(res.status, format).toBe(409);
      expect(body).toEqual({ success: false, error: NO_RELEASABLE_RESULT_AR });
      expect(state.storageCalls, format).toEqual([]);
      expect(state.calls.filter((c) => c.startsWith("rpc:") || c.includes("credit_ledger") || c.includes("provider_costs")), format).toEqual([]);
      expect(state.calls, format).toEqual(["from:jobs"]);
    }
    expect(state.signed).toEqual([]);
  });

  it("data: 409, no rows, no file ids, nothing read from storage", async () => {
    const res = await data(new NextRequest("http://localhost/api/jobs/job_quote_9bb/data"), params);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toEqual({ success: false, error: NO_RELEASABLE_RESULT_AR });
    expect(JSON.stringify(body)).not.toContain("Person One");
    expect(state.storageCalls).toEqual([]);
  });

  it("artifacts (the list of result versions): empty, so no file id is offered", async () => {
    const res = await artifacts(new NextRequest("http://localhost/api/jobs/job_quote_9bb/artifacts"), params);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, historyAvailable: true, current: null, versions: [] });
    expect(state.calls).not.toContain("from:artifact_versions");
  });

  it("another customer's request is still a 403, whatever its state", async () => {
    state.user = { id: "someone-else", app_metadata: {} };
    for (const route of [download, data, artifacts]) expect((await route(new NextRequest("http://localhost/api/jobs/job_quote_9bb/download?format=xlsx"), params)).status).toBe(403);
  });

  it("the same job once it settled and charged is released: completed, charged 406", async () => {
    state.job = job({ status: "completed", charged_credits: 406, reserved_credits: 891 });
    const rows = await data(new NextRequest("http://localhost/api/jobs/job_quote_9bb/data"), params);
    const body = await rows.json();
    expect(rows.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.rows).toHaveLength(2);
    expect(state.storageCalls.length).toBeGreaterThan(0);
    const list = await artifacts(new NextRequest("http://localhost/api/jobs/job_quote_9bb/artifacts"), params);
    expect((await list.json()).success).toBe(true);
    state.calls = [];
    const file = await download(new NextRequest("http://localhost/api/jobs/job_quote_9bb/download?format=xlsx"), params);
    expect(file.status).not.toBe(409);
    expect(state.calls.length).toBeGreaterThan(1); // it went past the guard
  });

  it("a failed job that WAS charged (settled, then something else failed) is still released", async () => {
    state.job = job({ status: "failed", charged_credits: 203 });
    const res = await data(new NextRequest("http://localhost/api/jobs/job_quote_9bb/data"), params);
    expect(res.status).toBe(200);
  });

  it("a failed job that delivered nothing keeps its own, more specific sentence", async () => {
    state.job = job({ delivered_units: 0 });
    const res = await download(new NextRequest("http://localhost/api/jobs/job_quote_9bb/download?format=xlsx"), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("لا يوجد ملف لتحميله لأن هذا الطلب لم يُسلّم أي سجل، ولم يُخصم منك أي رصيد.");
  });
});

describe("the requests page and the guard's reach", () => {
  it("«طلباتي» offers no file for a request that did not settle and charge (it uses the same function)", () => {
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).toContain('import { resultsReleasable } from "@/lib/producedFormats";');
    expect(page).toContain("|| !resultsReleasable({ status: j.status, charged_credits: j.chargedCredits })");
    expect(page).toContain("const availableFormats = nothingDelivered ? [] :");
  });

  it("nothing in this change writes or deletes: the routes only read; no stored object is removed and no money table is touched", () => {
    for (const path of ["src/app/api/jobs/[id]/download/route.ts", "src/app/api/jobs/[id]/data/route.ts", "src/lib/producedFormats.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/\.remove\(|\.delete\(\)|credit_ledger|\.rpc\(["'](?:release|settle)/);
    }
  });
});
