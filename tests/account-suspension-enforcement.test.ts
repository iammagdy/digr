import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * DT-20261118-06 phase 1C (Tier A): the suspension holds ON THE SERVER. A token issued before the ban is still readable locally until it expires (localClaims.ts), so every customer route that
 * starts work, approves, edits a plan, tops up or opens a request asks the sign-in service about the ban, and answers 403 with the customer sentence.
 */
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const state = { bannedUntil: null as string | null, outage: "none" as "none" | "error" | "throw", lookups: 0 };
vi.mock("../src/lib/supabase/server", () => ({
  // the customer's own client: the token is read locally, so the user carries no ban field (as with local claims)
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER_ID, email: "c@example.com", app_metadata: {}, user_metadata: {}, created_at: "2026-11-01T00:00:00Z" } }, error: null }) } })),
  createAdminClient: () => ({ auth: { admin: { getUserById: async () => {
    state.lookups += 1;
    if (state.outage === "throw") throw new Error("service down");
    if (state.outage === "error") return { data: { user: null }, error: { message: "service unavailable" } };
    return { data: { user: { id: USER_ID, banned_until: state.bannedUntil } }, error: null };
  } } } }),
}));
vi.mock("../src/lib/server/trustedEmailVerification", () => ({ resolveTrustedEmailVerified: async () => true }));

import { authenticateUser } from "../src/lib/server/userAuth";
import { resolveMissionViewer } from "../src/lib/server/missionViewer";
import { SUSPENDED_AR, SUSPENSION_UNKNOWN_AR, forgetSuspension } from "../src/lib/server/accountSuspension";

const req = () => new NextRequest("http://localhost/api/x", { headers: { authorization: "Bearer token" } });
beforeEach(() => { state.bannedUntil = null; state.outage = "none"; state.lookups = 0; forgetSuspension(); });

describe("the shared customer sign-in helpers refuse a suspended account", () => {
  it("authenticateUser: 403 with the customer sentence while banned; the customer as before when not", async () => {
    expect(await authenticateUser(req())).toMatchObject({ ok: true, user: { id: USER_ID } });
    forgetSuspension();
    state.bannedUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const r = await authenticateUser(req());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.response.status).toBe(403); expect(await r.response.json()).toMatchObject({ success: false, suspended: true, error: SUSPENDED_AR }); }
  });
  it("resolveMissionViewer: a suspended customer cannot open, approve or download a request (and is not let in as a guest instead)", async () => {
    state.bannedUntil = new Date(Date.now() + 86_400_000).toISOString();
    const r = await resolveMissionViewer(req());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.response.status).toBe(403); expect((await r.response.json()).error).toBe(SUSPENDED_AR); }
  });
});

describe("the routes that sign the customer in themselves check the ban right after the sign-in", () => {
  it.each([
    "src/app/api/chat/route.ts",
    "src/app/api/chat/accept-quote/route.ts",
    "src/app/api/chat/sample-remainder/route.ts",
    "src/app/api/chat/edit-plan/route.ts",
    "src/app/api/topup/submit/route.ts",
    // Gate 1 P1-1: the methodology purchase spends points; the artifacts edit is a charged change of a request
    "src/app/api/jobs/[id]/methodology/route.ts",
  ])("%s", (file) => {
    const src = readFileSync(file, "utf8");
    const signIn = src.lastIndexOf("auth.getUser(");
    // fix push (QA FAIL at 6af74613): an action that changes something asks fresh and fails closed (suspensionBlock); the cached read answer is not what these routes use
    const check = src.indexOf("await suspensionBlock(() => createAdminClient(), user");
    expect(signIn).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(signIn);
    expect(src.indexOf("if (blocked)", check)).toBeGreaterThan(check);
    expect(src).not.toMatch(/await isAccountSuspended\(\(\) => createAdminClient\(\), user\.id[^\n]*\) (return|\{)[^\n]*suspendedResponse/);
  });
});

describe("the artifacts route: an edit (POST) asks fresh and fails closed, the read (GET) keeps the memory", () => {
  it("authenticate() branches on the method of the request", () => {
    const src = readFileSync("src/app/api/jobs/[id]/artifacts/route.ts", "utf8");
    const signIn = src.lastIndexOf("auth.getUser(");
    const branch = src.indexOf("if (isSensitiveMethod(req.method))", signIn);
    expect(branch).toBeGreaterThan(signIn);
    expect(src.indexOf("await suspensionBlock(() => createAdminClient(), user", branch)).toBeGreaterThan(branch);
    expect(src.indexOf("else if (await isAccountSuspended(", branch)).toBeGreaterThan(branch);
  });
});

const post = () => new NextRequest("http://localhost/api/x", { method: "POST", headers: { authorization: "Bearer token" } });
describe("QA FAIL at 6af74613: an action that changes something fails CLOSED when the ban cannot be established", () => {
  it.each(["error", "throw"] as const)("authenticateUser POST with the sign-in service down (%s): 503, the retryable sentence, never let through; a GET still reads", async (outage) => {
    state.outage = outage;
    const r = await authenticateUser(post());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.response.status).toBe(503); expect(await r.response.json()).toMatchObject({ success: false, retryable: true, error: SUSPENSION_UNKNOWN_AR }); }
    forgetSuspension();
    expect(await authenticateUser(req())).toMatchObject({ ok: true, user: { id: USER_ID } });
  });
  it("resolveMissionViewer POST with the service down: 503; a GET opens the request as before", async () => {
    state.outage = "error";
    const r = await resolveMissionViewer(post());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(503);
    forgetSuspension();
    expect(await resolveMissionViewer(req())).toMatchObject({ ok: true, viewer: { userId: USER_ID } });
  });
  it("telemetry is never refused: analytics passes { sensitive: false }", () => {
    expect(readFileSync("src/app/api/analytics/collect/route.ts", "utf8")).toContain("authenticateUser(req, { sensitive: false })");
  });
});

describe("QA FAIL at 6af74613: another instance's «not banned» memory does not let a suspended customer act", () => {
  // two server instances = two copies of the modules, each with its own memory, one sign-in service
  const instance = async () => { vi.resetModules(); return { auth: await import("../src/lib/server/userAuth"), viewer: await import("../src/lib/server/missionViewer") }; };
  it("instance B remembered «not banned» for a read; the admin bans through instance A; B's next POST is refused at once (and B's GET still uses its memory for up to 30 s)", async () => {
    const b = await instance();
    expect(await b.auth.authenticateUser(req())).toMatchObject({ ok: true }); // B's memory: active
    const lookupsAfterRead = state.lookups;
    state.bannedUntil = new Date(Date.now() + 7 * 86_400_000).toISOString(); // suspended by instance A: B's memory is not cleared
    expect(await b.auth.authenticateUser(req())).toMatchObject({ ok: true }); // a read may use B's memory
    expect(state.lookups).toBe(lookupsAfterRead);
    const act = await b.auth.authenticateUser(post());
    expect(act.ok).toBe(false);
    if (!act.ok) { expect(act.response.status).toBe(403); expect((await act.response.json()).error).toBe(SUSPENDED_AR); }
    const view = await b.viewer.resolveMissionViewer(post());
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.response.status).toBe(403);
  });
  it("the methodology purchase on instance B: remembered «not banned», then banned elsewhere: 403 before anything is read or charged; with the service down: 503", async () => {
    const b = await instance();
    const route = await import("../src/app/api/jobs/[id]/methodology/route");
    const call = () => route.POST(new NextRequest("http://localhost/api/jobs/job1/methodology", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ confirmed: true, expectedPoints: 50 }) }), { params: Promise.resolve({ id: "job1" }) });
    expect(await b.auth.authenticateUser(req())).toMatchObject({ ok: true }); // B's memory: active
    state.bannedUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const banned = await call();
    expect(banned.status).toBe(403);
    expect(await banned.json()).toMatchObject({ suspended: true, error: SUSPENDED_AR });
    state.bannedUntil = null; state.outage = "error";
    const down = await call();
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ retryable: true, error: SUSPENSION_UNKNOWN_AR });
  });
  it("an artifact edit on instance B: banned elsewhere: 403; service down: 503 (the GET of the same route is not refused for an outage)", async () => {
    const b = await instance();
    const route = await import("../src/app/api/jobs/[id]/artifacts/route");
    const call = () => route.POST(new NextRequest("http://localhost/api/jobs/job1/artifacts", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id: "job1" }) });
    expect(await b.auth.authenticateUser(req())).toMatchObject({ ok: true });
    state.bannedUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect((await call()).status).toBe(403);
    state.bannedUntil = null; state.outage = "throw";
    expect((await call()).status).toBe(503);
  });
});
