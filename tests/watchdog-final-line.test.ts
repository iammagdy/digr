import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { checkCustomerText, customerSafeText } from "../src/lib/agentMission/text";
import { normalizeReleaseWording } from "../src/lib/releaseWording";
import { operatorReleaseReasonAr, staleReleaseReasonAr } from "../src/lib/multiProvider/copy";
import { readFileSync } from "node:fs";
import { CAPABILITIES } from "../src/lib/multiProvider/catalog";

/** T-WD (plan v8 section 3.10b, v9): the watchdog release message of a STARTED job carries «٠ من N» and the reason chosen by PATH. Fakes only. */
const state = vi.hoisted(() => ({
  stale: [] as any[],
  specific: null as any,
  jobsQueries: [] as string[][],
  rpc: [] as Array<{ name: string; args: any }>,
  release: { success: true, released_credits: 207, already_released: false } as any,
}));

vi.mock("../src/lib/server/cronAuth", () => ({ verifyCronSecret: () => true }));
vi.mock("../src/lib/supabase/ledger", async (original) => ({ ...(await original<any>()), getBalance: vi.fn(async () => 5123) }));
vi.mock("../src/lib/server/sendPlatformEmail", async (original) => ({
  ...(await original<any>()),
  getRecipient: vi.fn(async () => ({ email: "u1@example.com", name: "سلمى" })),
  sendPlatformEmail: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string, args: any) => { state.rpc.push({ name, args }); return { data: state.release, error: null }; }),
    auth: { admin: {} },
    storage: { from: () => ({ list: async () => ({ data: [] }), remove: async () => ({}) }) },
    from: (table: string) => {
      const calls: string[] = [];
      if (table === "jobs") state.jobsQueries.push(calls);
      const api: any = {
        select: (cols: string) => { calls.push(`select:${cols}`); return api; },
        eq: (col: string, val: unknown) => { calls.push(`eq:${col}:${String(val)}`); return api; },
        in: (col: string, vals: unknown[]) => { calls.push(`in:${col}:${JSON.stringify(vals)}`); return api; },
        or: () => { calls.push("or"); return api; },
        not: () => api, lte: () => api, limit: () => api,
        maybeSingle: async () => ({ data: table === "jobs" ? state.specific : null, error: null }),
        insert: async () => ({ error: null }),
        delete: () => api, update: () => api,
        then: (resolve: any) => resolve({ data: table === "jobs" ? state.stale : [], error: null }),
      };
      return api;
    },
  })),
}));

const WD_SELECT = "id, user_id, status, step, lease_until, updated_at, target_volume_max, delivered_units";
const PROVIDER_WORDS = /treg|tomba|icypeas|firecrawl|context\.?dev|hunter|apollo|blitz|aviato|enrichlayer|serp|reoon/i;
/** Every provider of the TREG catalog snapshot and every provider and capability id of CAPABILITIES, computed at test time (plan v9 T-N). */
const FORBIDDEN_IDS: string[] = (() => {
  const snapshot = JSON.parse(readFileSync("data/treg/treg_catalog_sellable.json", "utf8")) as { endpoints: Array<{ provider?: string }> };
  const ids = new Set<string>();
  for (const e of snapshot.endpoints) if (typeof e.provider === "string" && e.provider.length > 0) ids.add(e.provider.toLowerCase());
  for (const c of CAPABILITIES) { ids.add(String(c.provider).toLowerCase()); ids.add(String(c.id).toLowerCase()); }
  return [...ids];
})();
const sweepRequest = () => new NextRequest("http://localhost/api/cron/watchdog", { headers: { authorization: "Bearer x" } });
const targetedRequest = (jobId: string) => new NextRequest(`http://localhost/api/cron/watchdog?jobId=${jobId}`, { headers: { authorization: "Bearer x" } });
const expired = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const row = (over: Record<string, unknown>) => ({ id: "job_wd_1", user_id: "u1", lease_until: expired(), updated_at: expired(), ...over });

beforeEach(() => {
  state.stale = []; state.specific = null; state.jobsQueries = []; state.rpc = [];
  state.release = { success: true, released_credits: 207, already_released: false };
});

function expectOneRelease(job: { id: string }, message: string) {
  expect(state.rpc).toHaveLength(1);
  expect(state.rpc[0]!.name).toBe("release_job_atomic");
  expect(Object.keys(state.rpc[0]!.args)).toEqual(["p_job_id", "p_error_message", "p_force"]);
  expect(state.rpc[0]!.args.p_job_id).toBe(job.id);
  expect(state.rpc[0]!.args.p_force).toBe(true);
  expect(state.rpc[0]!.args.p_error_message).toBe(message);
  expect(state.rpc[0]!.args.p_error_message).not.toMatch(PROVIDER_WORDS);
const recorded = String(state.rpc[0]!.args.p_error_message).toLowerCase();
expect(FORBIDDEN_IDS.length).toBeGreaterThan(0);
for (const id of FORBIDDEN_IDS) expect(recorded.includes(id), id).toBe(false);
}

const STALL_45 = "المسلَّم ٠ من ٤٥ مطلوب. السبب: توقفت المعالجة عن التقدم قبل اكتمال العدد، وهو حجز مؤقت مُحرَّر كاملًا ولم يُخصم منك شيء.";
const STALL_30 = "المسلَّم ٠ من ٣٠ مطلوب. السبب: توقفت المعالجة عن التقدم قبل اكتمال العدد، وهو حجز مؤقت مُحرَّر كاملًا ولم يُخصم منك شيء.";
const TODAY = "تم إلغاء الطلب تلقائياً لتأخر التنفيذ والنقاط المحجوزة: حجز مؤقت مُحرَّر كاملًا.";

describe("T-WD the watchdog SWEEP path", () => {
  it.each([
    ["R2: the winner died after the terminal commit, nobody running", row({ status: "running", step: 3, delivered_units: 45, target_volume_max: 45 }), STALL_45],
    ["R4: a loser that is not terminal, nobody assembles (the text is built from N, never from delivered_units 20)", row({ status: "running", step: 2, delivered_units: 20, target_volume_max: 45 }), STALL_45],
    ["first-chunk kill: running at step 0", row({ status: "running", step: 0, delivered_units: 0, target_volume_max: 30 }), STALL_30],
    ["never claimed: queued at step 0 keeps today's count-less text", row({ status: "queued", step: 0, delivered_units: 0, target_volume_max: 30 }), TODAY],
    ["invalid N null", row({ status: "running", step: 3, target_volume_max: null }), TODAY],
    ["invalid N 0", row({ status: "running", step: 3, target_volume_max: 0 }), TODAY],
    ["invalid N -1", row({ status: "running", step: 3, target_volume_max: -1 }), TODAY],
    ["invalid N 1.5", row({ status: "running", step: 3, target_volume_max: 1.5 }), TODAY],
    ["invalid N abc", row({ status: "running", step: 3, target_volume_max: "abc" }), TODAY],
  ])("T-WD sweep %s", async (_name, job, expected) => {
    state.stale = [job];
    const { GET } = await import("../src/app/api/cron/watchdog/route");
    const res = await GET(sweepRequest());
    expect(res.status).toBe(200);
    expectOneRelease(job as { id: string }, expected as string);
  });
});

const OPER_45 = "المسلَّم ٠ من ٤٥ مطلوب. السبب: أوقفنا معالجة هذا الطلب من جانبنا قبل اكتمال العدد، وهو حجز مؤقت مُحرَّر كاملًا ولم يُخصم منك شيء.";

describe("T-WD the TARGETED ?jobId= path chooses its own reason (plan v9)", () => {
  it.each([
    ["targeted fresh: running, step 1, lease not expired (no staleness filter on this path)", row({ id: "job_fresh_1", status: "running", step: 1, delivered_units: 10, target_volume_max: 45, updated_at: new Date(Date.now() - 60 * 1000).toISOString(), lease_until: new Date(Date.now() + 50 * 1000).toISOString() }), OPER_45],
    ["targeted R2 (the path decides the reason, not the row)", row({ id: "job_wd_t2", status: "running", step: 3, delivered_units: 45, target_volume_max: 45 }), OPER_45],
    ["targeted never claimed keeps today's literal", row({ id: "job_wd_t3", status: "queued", step: 0, delivered_units: 0, target_volume_max: 30 }), TODAY],
    ["targeted invalid N keeps today's literal", row({ id: "job_wd_t4", status: "running", step: 3, target_volume_max: "abc" }), TODAY],
  ])("T-WD %s", async (_name, job, expected) => {
    state.specific = job;
    const { GET } = await import("../src/app/api/cron/watchdog/route");
    const res = await GET(targetedRequest((job as { id: string }).id));
    expect(res.status).toBe(200);
    expectOneRelease(job as { id: string }, expected as string);
    expect(state.rpc[0]!.args.p_error_message).not.toContain("توقفت المعالجة عن التقدم");
    const wdQuery = state.jobsQueries.find((q) => q.includes(`select:${WD_SELECT}`));
    expect(wdQuery).toBeDefined();
    expect(wdQuery).toContain(`eq:id:${(job as { id: string }).id}`);
    expect(wdQuery).toContain(`in:status:${JSON.stringify(["queued", "running"])}`);
    expect(wdQuery).not.toContain("or");
  });

  it("T-WD both selects carry target_volume_max and delivered_units (list path and ?jobId= path)", async () => {
    const { GET } = await import("../src/app/api/cron/watchdog/route");
    state.stale = [row({ status: "running", step: 3, delivered_units: 45, target_volume_max: 45 })];
    await GET(sweepRequest());
    const listQuery = state.jobsQueries.find((q) => q.includes(`select:${WD_SELECT}`));
    expect(listQuery).toBeDefined();
    expect(listQuery).toContain("or");
    state.jobsQueries = []; state.rpc = [];
    state.specific = row({ id: "job_wd_sel", status: "running", step: 3, delivered_units: 45, target_volume_max: 45 });
    await GET(targetedRequest("job_wd_sel"));
    const oneQuery = state.jobsQueries.find((q) => q.includes(`select:${WD_SELECT}`));
    expect(oneQuery).toBeDefined();
    expect(state.rpc[0]!.args.p_error_message).toBe(OPER_45);
    expect(state.rpc[0]!.args.p_error_message).not.toBe(STALL_45);
  });
});

describe("T-WD the two sentences themselves", () => {
  it.each([["sweep", staleReleaseReasonAr(45), "المسلَّم ٠ من ٤٥ مطلوب. السبب: توقفت المعالجة عن التقدم قبل اكتمال العدد، وهو حجز مؤقت مُحرَّر كاملًا ولم يُخصم منك شيء."], ["targeted", operatorReleaseReasonAr(45), "المسلَّم ٠ من ٤٥ مطلوب. السبب: أوقفنا معالجة هذا الطلب من جانبنا قبل اكتمال العدد، وهو حجز مؤقت مُحرَّر كاملًا ولم يُخصم منك شيء."]])("T-WD text %s", (_name, t, literal) => {
    expect(t).toBe(literal);
    expect(checkCustomerText(t).issues).toEqual([]);
    expect(customerSafeText(t)).toBe(t);
    expect(normalizeReleaseWording(t)).toBe(t);
    for (const word of ["تلقائياً", "لتأخر التنفيذ", "لتجاوز المهلة الزمنية"]) expect(t).not.toContain(word);
    expect(t).toContain("حجز مؤقت مُحرَّر");
    expect(t).not.toMatch(PROVIDER_WORDS);
  });
});
