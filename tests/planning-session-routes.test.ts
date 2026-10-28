import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { createScriptedTransport } from "../src/lib/modelPlanner/transport";

let mem: MemoryDb;
let authedUser: { id: string } | null = { id: "user_a" };
let transportScript: any[] = [];

vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => mem, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/userAuth", () => ({
  authenticateUser: vi.fn(async () => authedUser ? { ok: true, user: authedUser } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) }),
}));
vi.mock("../src/lib/modelPlanner/chatTurn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/modelPlanner/chatTurn")>()),
  defaultModelPlannerConfig: () => ({ transport: createScriptedTransport(transportScript, { model: "recorded" }), client: mem, today: () => new Date("2026-10-27T12:00:00Z") }),
}));

import { POST as stepRoute } from "../src/app/api/chat/planning/[id]/step/route";
import { GET as stateRoute } from "../src/app/api/chat/planning/[id]/route";
import { GET as driveRoute } from "../src/app/api/cron/drive/route";
import { PLANNING_SESSIONS_TABLE, type PlanningSession } from "../src/lib/modelPlanner/planningSession";
import { resetExplorationMemoryForTesting } from "../src/lib/modelPlanner/exploration";
import { say } from "./helpers/plannerKit";

const ID = "session_route_0001";
const sessionRow = (over: Partial<PlanningSession> = {}): PlanningSession => ({
  id: ID, user_id: "user_a", conversation_id: "conv_1", user_msg_id: "um1", assistant_msg_id: "am1", status: "running", version: 0, lease_until: null,
  request: { message: "اكس", messagesContext: [], guest: false, userBalance: 40_000 }, state: null, result: null, steps: 0, errors: 0,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
});
const req = (method: string, id: string) => new NextRequest(`http://127.0.0.1:3000/api/chat/planning/${id}${method === "POST" ? "/step" : ""}`, { method, headers: { authorization: "Bearer t" } });
const ctxOf = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mem = createMemoryDb();
  authedUser = { id: "user_a" };
  transportScript = [];
  resetExplorationMemoryForTesting();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("the planning session routes: the customer's own session only", () => {
  it("a malformed id is a 400, a signed-out caller a 401, another customer's session a 404 (for the step and for the state)", async () => {
    mem.seed(PLANNING_SESSIONS_TABLE, [sessionRow()]);
    expect((await stepRoute(req("POST", "x"), ctxOf("x"))).status).toBe(400);
    expect((await stateRoute(req("GET", "bad id"), ctxOf("bad id"))).status).toBe(400);
    authedUser = null;
    expect((await stepRoute(req("POST", ID), ctxOf(ID))).status).toBe(401);
    expect((await stateRoute(req("GET", ID), ctxOf(ID))).status).toBe(401);
    authedUser = { id: "user_b" };
    expect((await stepRoute(req("POST", ID), ctxOf(ID))).status).toBe(404);
    expect((await stateRoute(req("GET", ID), ctxOf(ID))).status).toBe(404);
    expect(mem.rows(PLANNING_SESSIONS_TABLE)[0].version).toBe(0);
  });

  it("an unknown session is a 404", async () => {
    expect((await stepRoute(req("POST", "session_unknown_1"), ctxOf("session_unknown_1"))).status).toBe(404);
  });

  it("a finished session answers with its saved response and does not step again", async () => {
    mem.seed(PLANNING_SESSIONS_TABLE, [sessionRow({ status: "done", result: { outputType: "propose_plan", response: { outputType: "propose_plan", planQuote: { quoteId: "q9" } } } })]);
    const res = await stepRoute(req("POST", ID), ctxOf(ID));
    const json = await res.json();
    expect(json).toMatchObject({ success: true, status: "done", response: { planQuote: { quoteId: "q9" } } });
    expect(mem.rows(PLANNING_SESSIONS_TABLE)[0].version).toBe(0);
    const state = await (await stateRoute(req("GET", ID), ctxOf(ID))).json();
    expect(state).toMatchObject({ status: "done" });
  });

  it("a running session is stepped: a model that asks its one question ends the session and the answer is saved in the conversation", async () => {
    transportScript = [[say("هل تريد حسابًا بعينه أم موضوعًا؟")]];
    mem.seed(PLANNING_SESSIONS_TABLE, [sessionRow()]);
    const json = await (await stepRoute(req("POST", ID), ctxOf(ID))).json();
    expect(json.status).toBe("done");
    expect(json.response.outputType).toBe("answer_question");
    expect(String(json.response.contentAr)).toContain("؟");
    const saved = mem.rows(PLANNING_SESSIONS_TABLE)[0];
    expect(saved.status).toBe("done");
    expect(saved.result.outputType).toBe("answer_question");
    // the usage of the step is written beside the other model calls
    expect(mem.rows("llm_usage").length).toBeGreaterThanOrEqual(1);
  });

  it("a model that keeps failing is retried across steps and ends in ONE honest sentence, never «غير متاحة» and never an error the customer sees", async () => {
    transportScript = Array.from({ length: 12 }, () => () => { throw new Error("boom"); });
    mem.seed(PLANNING_SESSIONS_TABLE, [sessionRow()]);
    let json: any = null;
    for (let i = 0; i < 6 && json?.status !== "done"; i++) {
      const res = await stepRoute(req("POST", ID), ctxOf(ID));
      expect(res.status).toBe(200);
      json = await res.json();
      mem.rows(PLANNING_SESSIONS_TABLE)[0].lease_until = null;
    }
    expect(json.status).toBe("done");
    expect(String(json.response.contentAr)).not.toContain("غير متاحة");
    expect(String(json.response.contentAr).length).toBeGreaterThan(10);
  });
});

describe("the background driver continues stale planning sessions", () => {
  it("a running session nobody has stepped for a while is stepped by /api/cron/drive; a fresh one is left alone", async () => {
    process.env.CRON_SECRET = "drive-secret";
    // the jobs query of the driver (it uses `or`, which the in-memory database does not have): no job is due
    const emptyJobs: any = { select: () => emptyJobs, in: () => emptyJobs, or: () => emptyJobs, gt: () => emptyJobs, lt: () => emptyJobs, eq: () => emptyJobs, is: () => emptyJobs, order: () => emptyJobs, limit: () => emptyJobs, then: (resolve: any) => resolve({ data: [], error: null }) };
    const inner = mem;
    mem = { ...inner, from: (t: string) => (t === "jobs" ? emptyJobs : inner.from(t)), rows: inner.rows, seed: inner.seed } as any;
    transportScript = [[say("هل تريد حسابًا بعينه أم موضوعًا؟")]];
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    mem.seed(PLANNING_SESSIONS_TABLE, [sessionRow({ id: "session_stale_001", updated_at: stale, created_at: stale }), sessionRow({ id: "session_fresh_001" })]);
    const res = await driveRoute(new NextRequest("http://127.0.0.1:3000/api/cron/drive", { headers: { authorization: "Bearer drive-secret" } }));
    expect(res.status).toBeLessThan(500);
    const rows = mem.rows(PLANNING_SESSIONS_TABLE);
    expect(rows.find((r) => r.id === "session_stale_001")?.status).toBe("done");
    expect(rows.find((r) => r.id === "session_fresh_001")?.status).toBe("running");
  });
});
