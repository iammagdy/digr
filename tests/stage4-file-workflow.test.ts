import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ME, MISSION, OTHER_MISSION, addonRowOf, objectsOf, previewClient, sizedVersion } from "./helpers/reviewQuoteWorld";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any, viewerCalls: 0, adminCalls: 0 }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => { state.adminCalls += 1; return state.client; }, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => { state.viewerCalls += 1; return state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) }; }) };
});

import { GET } from "../src/app/api/missions/[id]/workflow/route";
import { addonPhaseOf, fileWorkflowFor, workflowAvailable } from "../src/lib/agentMission/stage4/fileWorkflow";

/**
 * STAGE C: THE FILE'S WORKFLOW STATUS. GET /api/missions/[id]/workflow answers, for the customer's own mission, what state each add-on request on the file is in, so the page can say it truthfully. READ-ONLY. It never says «delivered» unless the output is VERIFIED published in storage, never
 * shows a charge amount except where a charge is recorded, and never lets a request whose approval may have moved money read as «nothing was reserved». The phases: waiting for approval, approval unverified, approved and processing, delivered, charged but delivery pending,
 * failed without charge, cancelled, closed after an approval attempt, and completed with no published output.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  state.viewer = { userId: ME, isGuest: false, emailVerified: true }; state.viewerCalls = 0; state.adminCalls = 0;
  vi.stubEnv("DIGER_STAGE4_EDITS", "on");
  vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const call = async (id = MISSION) => GET(new NextRequest(`http://localhost/api/missions/${id}/workflow`), { params: Promise.resolve({ id }) });
type Seed = Parameters<typeof addonRowOf>[0] & { job_id?: string | null; approved_at?: string | null; charged_points?: number | null; error?: string | null; created_at?: string };
const row = (seed: Seed) => { const { job_id, approved_at, charged_points, error, created_at, ...rest } = seed; return { ...addonRowOf(rest), job_id: job_id ?? null, approved_at: approved_at ?? null, charged_points: charged_points ?? 0, error: error ?? null, created_at: created_at ?? "2026-11-04T10:00:00.000Z" }; };
const world = (seeds: Seed[] = [], objects: Record<string, string> = objectsOf(sizedVersion(2, 2)), opts: Parameters<typeof previewClient>[1] = {}) => { state.client = previewClient(objects, { ...opts, addons: seeds.map(row) }); return state.client as ReturnType<typeof previewClient>; };
const items = async (seeds: Seed[], objects?: Record<string, string>) => { world(seeds, objects); const res = await call(); expect(res.status).toBe(200); return (await res.json()).workflow.items as any[]; };
const withObjects = (extra: Record<string, string>) => ({ ...objectsOf(sizedVersion(2, 2)), ...extra });
const V2 = `${MISSION}/versions/v0002.json`;
const R1 = `${MISSION}/reviews/r0001.json`;

describe("the phase of one request, pure", () => {
  const none = { versions: new Set<number>(), reviews: new Set<number>() };
  const phase = (seed: Seed, pub = none) => addonPhaseOf(row(seed) as any, pub)?.phase;
  it("waiting, with no job and no approval attempt: waiting for approval", () => {
    expect(phase({ status: "plan_ready", kind: "review" })).toBe("waiting_approval");
    expect(phase({ status: "plan_ready", kind: "edit" })).toBe("waiting_approval");
  });
  it("waiting but an approval WAS attempted (an approval time or a job): the money state is unverified, never «nothing was held»", () => {
    expect(phase({ status: "plan_ready", approved_at: "2026-11-04T10:00:00.000Z" })).toBe("approval_unverified");
    expect(phase({ status: "plan_ready", job_id: "job_quote_x" })).toBe("approval_unverified");
  });
  it("approved, queued, planning, needs input, executing: processing; whether the hold is KNOWN depends on the job", () => {
    for (const status of ["approved", "executing", "queued", "planning", "needs_input"]) {
      expect(addonPhaseOf(row({ status }) as any, none)).toMatchObject({ phase: "processing", held: false });
      expect(addonPhaseOf(row({ status, job_id: "job_quote_x" }) as any, none)).toMatchObject({ phase: "processing", held: true });
    }
  });
  it("completed is DELIVERED only if the output is verified published: a review needs its report, an edit or a fix needs its new version", () => {
    const pubReview = { versions: new Set<number>(), reviews: new Set([1]) };
    const pubEdit = { versions: new Set([2]), reviews: new Set<number>() };
    expect(phase({ status: "completed", kind: "review", base: 1 }, pubReview)).toBe("delivered");
    expect(phase({ status: "completed", kind: "edit", base: 1 }, pubEdit)).toBe("delivered");
    expect(phase({ status: "completed", kind: "review_fix", base: 1 }, pubEdit)).toBe("delivered");
    // the wrong object published: not delivered
    expect(phase({ status: "completed", kind: "review", base: 1 }, pubEdit)).not.toBe("delivered");
    expect(phase({ status: "completed", kind: "edit", base: 1 }, pubReview)).not.toBe("delivered");
    expect(phase({ status: "completed", kind: "edit", base: 1 })).toBe("delivery_pending");
    expect(phase({ status: "completed", kind: "edit", base: 1, charged_points: 100 })).toBe("charged_delivery_pending");
  });
  it("a charge is shown only where it is recorded and only in the two phases that may show it", () => {
    const pubEdit = { versions: new Set([2]), reviews: new Set<number>() };
    expect(addonPhaseOf(row({ status: "completed", kind: "edit", base: 1, charged_points: 120 }) as any, pubEdit)).toMatchObject({ phase: "delivered", chargedPoints: 120 });
    expect(addonPhaseOf(row({ status: "completed", kind: "edit", base: 1, charged_points: 0 }) as any, pubEdit)).not.toHaveProperty("chargedPoints");
    expect(addonPhaseOf(row({ status: "failed", charged_points: 100, error: "charged_not_published" }) as any, none)).toMatchObject({ phase: "charged_delivery_pending", chargedPoints: 100 });
    for (const seed of [{ status: "plan_ready" }, { status: "approved", charged_points: 50 }, { status: "executing", charged_points: 50 }, { status: "cancelled", charged_points: 50 }, { status: "unserved", charged_points: 0 }] as Seed[]) expect(addonPhaseOf(row(seed) as any, none), JSON.stringify(seed)).not.toHaveProperty("chargedPoints");
  });
  it("failed or unserved: charged-but-not-delivered if a charge is recorded (or the worker says so), otherwise failed without a recorded charge", () => {
    expect(phase({ status: "failed", charged_points: 100 })).toBe("charged_delivery_pending");
    expect(phase({ status: "failed", error: "charged_not_published" })).toBe("charged_delivery_pending");
    expect(phase({ status: "failed" })).toBe("failed_no_charge");
    expect(phase({ status: "unserved" })).toBe("failed_no_charge");
  });
  it("cancelled: «nothing was held» only for a request that never had an approval attempt or a job", () => {
    expect(phase({ status: "cancelled" })).toBe("cancelled");
    expect(phase({ status: "cancelled", approved_at: "2026-11-04T10:00:00.000Z" })).toBe("ended_unverified");
    expect(phase({ status: "cancelled", job_id: "job_quote_x" })).toBe("ended_unverified");
  });
  it("a row that is not an add-on, or has an unknown status, is not shown", () => {
    expect(addonPhaseOf({ id: "m", status: "completed", plan: { stages: [] } } as any, none)).toBeNull();
    expect(addonPhaseOf(row({ status: "weird" }) as any, none)).toBeNull();
  });
});

describe("the route: flag, identity, input", () => {
  it("the review flag or the edits flag opens it; both off, «test» or any other word is a 404 before the id, the viewer or the database is looked at", async () => {
    for (const [r, e, want] of [[undefined, undefined, 404], ["test", "test", 404], ["off", "yes", 404], ["on", undefined, 200], [undefined, "on", 200], ["on", "on", 200]] as const) {
      vi.unstubAllEnvs();
      if (r) vi.stubEnv("DIGER_STAGE4_REVIEW", r); if (e) vi.stubEnv("DIGER_STAGE4_EDITS", e);
      world([]);
      expect([String(r), String(e), (await call()).status]).toEqual([String(r), String(e), want]);
      if (want === 404) expect([state.viewerCalls, state.adminCalls]).toEqual([0, 0]);
      state.viewerCalls = 0; state.adminCalls = 0;
    }
    expect(workflowAvailable({})).toBe(false);
    expect(workflowAvailable({ DIGER_STAGE4_VERSIONS: "on" })).toBe(false);
    expect(workflowAvailable({ DIGER_STAGE4_EDITS: "on" })).toBe(true);
  });
  it("a bad id is a 400; not signed in is a 401 with nothing read; another customer's file and a missing file are the same 404", async () => {
    const w = world([]);
    expect((await call("../x")).status).toBe(400);
    state.viewer = null;
    expect((await call()).status).toBe(401);
    expect(w.calls).toEqual([]);
    state.viewer = { userId: ME, isGuest: false, emailVerified: true };
    const a = await call(OTHER_MISSION); const b = await call("msn_bbbbbbbbbbbbbbbbbbbb");
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(await a.json()).toEqual(await b.json());
  });
});

describe("the route: what it answers", () => {
  it("a file with no request: an empty list (not an error)", async () => {
    expect(await items([])).toEqual([]);
  });
  it("a waiting review request and a waiting edit request", async () => {
    expect(await items([{ status: "plan_ready", kind: "review", base: 2 }])).toEqual([{ kind: "review", version: 2, newVersion: null, phase: "waiting_approval" }]);
    expect(await items([{ status: "plan_ready", kind: "edit", base: 2 }])).toEqual([{ kind: "edit", version: 2, newVersion: 3, phase: "waiting_approval" }]);
  });
  it("completed and published: delivered; completed with the object NOT in storage: never delivered", async () => {
    const seed: Seed = { status: "completed", kind: "edit", base: 1, charged_points: 100 };
    expect(await items([seed], withObjects({ [V2]: "{}" }))).toEqual([{ kind: "edit", version: 1, newVersion: 2, phase: "delivered", chargedPoints: 100 }]);
    const missing = await items([seed]);
    expect(missing).toEqual([{ kind: "edit", version: 1, newVersion: 2, phase: "charged_delivery_pending", chargedPoints: 100 }]);
    expect(JSON.stringify(missing)).not.toContain("delivered");
    expect((await items([{ status: "completed", kind: "review", base: 1, charged_points: 100 }], withObjects({ [R1]: "{}" })))[0]).toMatchObject({ phase: "delivered", chargedPoints: 100 });
  });
  it("processing, failed without a recorded charge, charged but not published, cancelled and closed-after-attempt", async () => {
    const all = await items([
      { status: "executing", kind: "edit", base: 1, attempt: 1, job_id: "job_quote_x", created_at: "2026-11-04T10:05:00.000Z" },
      { status: "failed", kind: "review", base: 1, attempt: 2, created_at: "2026-11-04T10:04:00.000Z" },
      { status: "failed", kind: "edit", base: 2, attempt: 1, charged_points: 100, error: "charged_not_published", created_at: "2026-11-04T10:03:00.000Z" },
      { status: "cancelled", kind: "review", base: 2, attempt: 2, created_at: "2026-11-04T10:02:00.000Z" },
      { status: "cancelled", kind: "review", base: 3, attempt: 1, approved_at: "2026-11-04T09:00:00.000Z", created_at: "2026-11-04T10:01:00.000Z" },
    ]);
    expect(all.map((i) => i.phase)).toEqual(["processing", "failed_no_charge", "charged_delivery_pending", "cancelled", "ended_unverified"]);
    expect(all[0]).toMatchObject({ held: true });
  });
  it("an open request comes first whatever its age; the rest newest first; at most five", async () => {
    const seeds: Seed[] = [
      { status: "completed", kind: "review", base: 1, attempt: 1, created_at: "2026-11-04T10:09:00.000Z" },
      { status: "cancelled", kind: "review", base: 1, attempt: 2, created_at: "2026-11-04T10:08:00.000Z" },
      { status: "cancelled", kind: "review", base: 1, attempt: 3, created_at: "2026-11-04T10:07:00.000Z" },
      { status: "cancelled", kind: "review", base: 1, attempt: 4, created_at: "2026-11-04T10:06:00.000Z" },
      { status: "cancelled", kind: "review", base: 1, attempt: 5, created_at: "2026-11-04T10:05:00.000Z" },
      { status: "cancelled", kind: "review", base: 1, attempt: 6, created_at: "2026-11-04T10:04:00.000Z" },
      { status: "plan_ready", kind: "edit", base: 1, attempt: 7, created_at: "2026-11-04T09:00:00.000Z" },
    ];
    const out = await items(seeds);
    expect(out).toHaveLength(5);
    expect(out[0]).toMatchObject({ kind: "edit", phase: "waiting_approval" });
  });
  it("only THIS customer's requests on THIS file are read", async () => {
    const out = await items([{ status: "plan_ready", kind: "edit", base: 1, user: "u-2" }, { status: "plan_ready", kind: "edit", base: 1, of: OTHER_MISSION }]);
    expect(out).toEqual([]);
  });
  it("it exposes no request id, job id, row id, path, digest, summary or error text", async () => {
    world([{ status: "failed", kind: "edit", base: 1, charged_points: 100, error: "charged_not_published", job_id: "job_quote_secret" }]);
    const raw = await (await call()).text();
    for (const secret of ["msn_", "job_quote", "secret", "charged_not_published", "versions/", "reviews/", "addons/", "digest", "plan", "user_id", "u-1"]) expect(raw, secret).not.toContain(secret);
    expect(Object.keys(JSON.parse(raw).workflow.items[0]).sort()).toEqual(["chargedPoints", "kind", "newVersion", "phase", "version"]);
  });
  it("storage or database failures are a 503, never an empty list and never «delivered»", async () => {
    world([{ status: "completed", kind: "edit", base: 1, charged_points: 100 }], withObjects({ [V2]: "{}" }), { listError: true });
    const a = await call(); expect([a.status, (await a.json()).error]).toEqual([503, "unavailable"]);
    world([{ status: "plan_ready", kind: "edit", base: 1 }], undefined, { addonQueryError: true });
    expect((await call()).status).toBe(503);
    world([], undefined, { missionError: true });
    expect((await call()).status).toBe(503);
  });
  it("read-only: not one write or rpc, no provider; never cached", async () => {
    const w = world([{ status: "plan_ready", kind: "edit", base: 1 }]);
    const res = await call();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(w.writes).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("reading a file whose published objects are listed more than once, or in odd names, still answers from verified names only", async () => {
    const out = await items([{ status: "completed", kind: "edit", base: 1, charged_points: 100 }], withObjects({ [`${MISSION}/versions/v2.json`]: "{}", [`${MISSION}/versions/notes.txt`]: "x" }));
    expect(out[0].phase).toBe("charged_delivery_pending");
  });
});

describe("the source: a read of the missions table and two listings, nothing else", () => {
  const code = (f: string) => readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("no write, no rpc, no upload, no signed link; no card, quote, approval, settlement or provider; reads the flags by the stage-4 reader", () => {
    const src = ["src/lib/agentMission/stage4/fileWorkflow.ts", "src/app/api/missions/[id]/workflow/route.ts"].map(code).join("\n");
    expect(src).not.toMatch(/\.(rpc|insert|update|upsert|delete|upload|remove|createSignedUrl)\(/);
    expect(src).not.toMatch(/addonQuote|quotes"|reviewPreview|createAddonRow|settleAddon|approveAddon|accept_quote_atomic|release_job_atomic|credit_ledger|gateway|openai|process\.env/);
    expect(src).toMatch(/DIGER_STAGE4_REVIEW/); expect(src).toMatch(/DIGER_STAGE4_EDITS/);
  });
});

void fileWorkflowFor;

describe("AUDIT D3: the answer says whether the file has any published version", () => {
  it("a file with versions: hasVersions true; a file with none (delivered before versioning): hasVersions false", async () => {
    world([]);
    expect((await (await call()).json()).workflow).toEqual({ items: [], hasVersions: true });
    world([], {});
    expect((await (await call()).json()).workflow).toEqual({ items: [], hasVersions: false });
  });
});
