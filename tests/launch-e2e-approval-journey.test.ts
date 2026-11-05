import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase/server", async () => {
  const { session } = await import("./helpers/e2eSession");
  return { createAdminClient: () => { session.adminCalls += 1; return session.client; }, createServerSideClient: vi.fn() };
});
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  const { session } = await import("./helpers/e2eSession");
  return { ...real, resolveMissionViewer: vi.fn(async () => { session.viewerCalls += 1; return session.viewer ? { ok: true, viewer: session.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) }; }) };
});

import { runAddonSafely } from "../agent/src/stage4/runAddon";
import { checkAddonLedger } from "./helpers/addonWorld";
import { session, signInAs } from "./helpers/e2eSession";
import { MISSION, ME, OTHER_USER, e2eWorld, parseXlsx, sheetsOfVersion, type E2eWorld } from "./helpers/e2eWorld";
import { api, json } from "./helpers/e2eRoutes";

/**
 * LAUNCH ROUND, WORKSTREAM 3: THE CUSTOMER'S PAID JOURNEY, ROUTE BY ROUTE, with the new APPROVAL ROUTE in the place where the earlier end-to-end flows called the approval function directly. The REAL route handlers (versions, file, review quote, review request, edit request,
 * approval, review report), the REAL guard and approval function (hardened FAKE money core), the REAL worker add-on runner and the REAL review/edit engines share one fake world. `fetch` throws: no provider, no live account, no model, no real money.
 * Delivered file -> Review quote -> Review request -> APPROVE (route) -> review report -> Edit quote -> Edit request -> APPROVE (route) -> new file version -> download. Then the refusals a customer can meet on the way.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear();
  for (const f of ["DIGER_STAGE4_VERSIONS", "DIGER_STAGE4_REVIEW", "DIGER_STAGE4_EDITS", "DIGER_STAGE4_APPROVAL"]) vi.stubEnv(f, "on");
  signInAs(ME);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** The routes' storage and mission rows with the money core's rpc and tables: one client for everything the approval route touches. */
const world = async (opts: Parameters<typeof e2eWorld>[0] = {}): Promise<E2eWorld> => {
  const w = await e2eWorld(opts);
  session.client = new Proxy(w.routes as any, { get: (t, k) => (k === "rpc" ? (n: string, a: unknown) => w.money.client.rpc(n, a) : k === "from" ? (tb: string) => (tb === "missions" ? t.from(tb) : (w.money.client as any).from(tb)) : t[k]) });
  return w;
};
const approve = (requestId: string, expectedPoints: number) => api.approve({ requestId, expectedPoints });
const ledger = (w: E2eWorld) => w.money.ledger.map((l) => l.type);

describe("the whole paid journey through the approval route", () => {
  it("REVIEW: quote -> request -> approve (route) -> worker -> report; the hold is the shown price, the charge is once and never above it, release first", async () => {
    const w = await world();
    const B = w.money.balance();
    expect((await json(await api.approvalAvailable())).available).toBe(true);
    const quote = (await json(await api.reviewQuote(MISSION, "version=1"))).quote;
    const made = await json(await api.reviewRequestPost({ action: "create", version: 1 }));
    expect(made.request.points).toBe(quote.points);
    // consent: nothing moved before the approval
    expect([ledger(w), w.money.jobs.size]).toEqual([["topup"], 0]);
    const res = await approve(made.request.id, made.request.points);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual({ success: true, state: "approved", kind: "review", holdPoints: quote.points });
    expect(JSON.stringify(body)).not.toMatch(/job_|quote_|res_|usd/i);
    expect(ledger(w)).toEqual(["topup", "reserve"]);
    expect(w.money.balance()).toBe(B - quote.points);
    const claimed = await w.store.claimMission("worker-1", 120);
    expect(claimed?.id).toBe(made.request.id);
    const job = [...w.money.jobs.keys()][0];
    await runAddonSafely(w.deps, claimed!);
    expect(checkAddonLedger(w.money, job, { reserved: quote.points, charged: quote.points })).toEqual([]);
    expect(ledger(w)).toEqual(["topup", "reserve", "release", "charge"]);
    expect(w.money.balance()).toBe(B - quote.points);
    expect(w.money.balance()).toBeGreaterThanOrEqual(0);
    const report = await api.reviewReport(MISSION, "version=1");
    expect(report.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("EDIT: schema -> quote -> request -> approve (route) -> worker -> version 2; version 1 is untouched; both download as genuine workbooks; the charge never exceeds the hold", async () => {
    const w = await world();
    const B = w.money.balance();
    const edit = { kind: "rename_column", sheet: "العملاء", from: "الهاتف", to: "رقم الهاتف" };
    const quote = (await json(await api.editRequestPost({ action: "quote", version: 1, edit }))).quote;
    expect(quote.state).toBe("offer");
    const made = await json(await api.editRequestPost({ action: "create", version: 1, edit }));
    expect(made.request.holdPoints).toBe(quote.holdPoints);
    expect([ledger(w), w.money.jobs.size]).toEqual([["topup"], 0]);
    const res = await approve(made.request.id, made.request.holdPoints);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ success: true, state: "approved", kind: "edit", holdPoints: quote.holdPoints });
    expect(ledger(w)).toEqual(["topup", "reserve"]);
    const claimed = await w.store.claimMission("worker-1", 120);
    const job = [...w.money.jobs.keys()][0];
    await runAddonSafely(w.deps, claimed!);
    const charged = w.money.jobs.get(job)!.charged_credits as number;
    expect(charged).toBeGreaterThan(0);
    expect(charged).toBeLessThanOrEqual(quote.holdPoints);
    expect(checkAddonLedger(w.money, job, { reserved: quote.holdPoints, charged })).toEqual([]);
    expect(w.money.balance()).toBe(B - charged);
    // the new version is published; the original is the same bytes as before
    expect(w.versionFiles()).toEqual([`${MISSION}/versions/v0001.json`, `${MISSION}/versions/v0002.json`]);
    expect(JSON.parse((await w.store.getFile(MISSION, "versions/v0001.json"))!).digest).toBe(w.v1.digest);
    const v1 = await parseXlsx(new Uint8Array(await (await api.versionFile(1)).arrayBuffer()));
    expect(v1).toEqual(sheetsOfVersion(w.v1));
    const v2 = await parseXlsx(new Uint8Array(await (await api.versionFile(2)).arrayBuffer()));
    expect(v2.find((s) => s.name === "العملاء")!.headers).toContain("رقم الهاتف");
    expect(v2.find((s) => s.name === "العملاء")!.headers).not.toContain("الهاتف");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("REVIEW THEN EDIT in one file: two approvals, two holds, each its own job and ledger rows, the balance is the sum of the two charges, never negative", async () => {
    const w = await world();
    const B = w.money.balance();
    const q1 = (await json(await api.reviewQuote(MISSION, "version=1"))).quote;
    const r1 = await json(await api.reviewRequestPost({ action: "create", version: 1 }));
    expect((await approve(r1.request.id, q1.points)).status).toBe(200);
    await runAddonSafely(w.deps, (await w.store.claimMission("worker-1", 120))!);
    const edit = { kind: "rename_column", sheet: "العملاء", from: "الهاتف", to: "رقم الهاتف" };
    const r2 = await json(await api.editRequestPost({ action: "create", version: 1, edit }));
    expect((await approve(r2.request.id, r2.request.holdPoints)).status).toBe(200);
    await runAddonSafely(w.deps, (await w.store.claimMission("worker-1", 120))!);
    const jobs = [...w.money.jobs.values()];
    expect(jobs).toHaveLength(2);
    const charged = jobs.reduce((n, j) => n + (j.charged_credits as number), 0);
    expect(w.money.balance()).toBe(B - charged);
    expect(w.money.balance()).toBeGreaterThanOrEqual(0);
    for (const j of jobs) expect(checkAddonLedger(w.money, j.id as string, { reserved: j.reserved_credits as number, charged: j.charged_credits as number })).toEqual([]);
    expect(new Set(w.money.ledger.map((l) => l.id)).size).toBe(w.money.ledger.length);
  });
});

describe("what the customer can meet on the way", () => {
  it("five simultaneous clicks on the approval: exactly ONE hold", async () => {
    const w = await world();
    const made = await json(await api.reviewRequestPost({ action: "create", version: 1 }));
    const answers = await Promise.all(Array.from({ length: 5 }, () => approve(made.request.id, made.request.points)));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(w.money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    expect(w.money.balance()).toBe(w.startBalance - made.request.points);
  });
  it("a balance below the price: 402, the Arabic sentence, nothing held, and the request still waits", async () => {
    const w = await world({ balance: 50 });
    const madeRes = await api.reviewRequestPost({ action: "create", version: 1 });
    const made = await json(madeRes);
    const res = await approve(made.request.id, made.request.points);
    expect(res.status).toBe(402);
    expect(await json(res)).toMatchObject({ success: false, state: "refused", code: "insufficient_balance" });
    expect(w.money.ledger.filter((l) => l.type === "reserve")).toEqual([]);
    expect(w.money.balance()).toBe(50);
    // the request is STILL a waiting, unpaid request: found again, honestly described, and cancellable (the customer is not stuck)
    expect((await json(await api.reviewRequest())).request.id).toBe(made.request.id);
    const cancelled = await api.reviewRequestPost({ action: "cancel", requestId: made.request.id });
    expect(cancelled.status).toBe(200);
    expect(w.money.ledger.map((l) => l.type)).toEqual(["topup"]);
  });
  it("the price the page showed is not the server's: 409, nothing held", async () => {
    const w = await world();
    const made = await json(await api.reviewRequestPost({ action: "create", version: 1 }));
    const res = await approve(made.request.id, made.request.points + 1);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("price_mismatch");
    expect(w.money.calls).toEqual([]);
  });
  it("another customer, another file, a guest and a signed-out call cannot approve it", async () => {
    const w = await world();
    const made = await json(await api.reviewRequestPost({ action: "create", version: 1 }));
    signInAs(OTHER_USER);
    expect((await approve(made.request.id, made.request.points)).status).toBe(404);
    signInAs(ME);
    expect((await api.approve({ requestId: made.request.id, expectedPoints: made.request.points }, "msn_aaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    session.viewer = { userId: ME, isGuest: true, emailVerified: false };
    expect((await approve(made.request.id, made.request.points)).status).toBe(401);
    signInAs(null);
    expect((await approve(made.request.id, made.request.points)).status).toBe(401);
    expect(w.money.calls).toEqual([]);
  });
  it("the approval switched off: the route and its availability answer 404 before anything is looked at, and the rest of the journey is unchanged", async () => {
    const w = await world();
    const made = await json(await api.reviewRequestPost({ action: "create", version: 1 }));
    vi.stubEnv("DIGER_STAGE4_APPROVAL", "");
    const before = [session.viewerCalls, session.adminCalls];
    expect((await approve(made.request.id, made.request.points)).status).toBe(404);
    expect((await api.approvalAvailable()).status).toBe(404);
    expect([session.viewerCalls, session.adminCalls]).toEqual(before);
    expect(w.money.calls).toEqual([]);
    expect((await json(await api.reviewRequest())).request.id).toBe(made.request.id);
  });
  it("a bad body (an extra key, a missing price, a non-JSON content type) is a 400 and moves nothing", async () => {
    const w = await world();
    const made = await json(await api.reviewRequestPost({ action: "create", version: 1 }));
    expect((await api.approve({ requestId: made.request.id, expectedPoints: made.request.points, price: 1 })).status).toBe(400);
    expect((await api.approve({ requestId: made.request.id })).status).toBe(400);
    expect((await api.approve("not json")).status).toBe(400);
    expect(w.money.calls).toEqual([]);
  });
});
