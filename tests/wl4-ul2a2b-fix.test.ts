import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { setChatModelForTesting, type ChatModelCall, type ChatModelInput } from "../src/lib/agentMission/chatModel";
import { decideTurn, type OpenRequest } from "../src/lib/agentMission/conversationModel";
import { SHAPING_NEVER_A_PLAN_AR } from "../src/lib/shapeTurn";
import type { DatasetColumn } from "../src/lib/fileSpec";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * UL2a-2b FIX (replay of PR 721, F1): with a delivered result open and NO open request, the decision model typed «فلتر النتائج على القاهرة» as edit_of_open_request (refers_to_open_request false, no file_turn) and the code
 * turned «an edit without an open request» into a data_request: a NEW agent mission, 5 of 5. An edit-type answer with a result open and no open request is an edit of the DELIVERED FILE: a file turn, never a mission.
 */
const COLUMNS: DatasetColumn[] = [{ key: "company_name", titleAr: "اسم الشركة" }, { key: "city", titleAr: "المدينة" }, { key: "industry", titleAr: "النشاط" }];
const TITLES = COLUMNS.map((c) => c.titleAr);
const FILTER_TEXT = "فلتر النتائج على القاهرة";
const EDIT_NO_FILE_TURN = { type: "edit_of_open_request", reason: "تعديل", reply: "", count: null, refers_to_open_request: false };
const DATA = { type: "data_request", reason: "طلب جمع جديد", reply: "", count: null, refers_to_open_request: false };
const SHAPE_MARK = "You turn a customer's request about HOW";

function world(decide: (text: string) => Record<string, unknown>) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: "u1", title: "x", status: "active" }]);
  db.seed("profiles", [{ id: "u1", email: "a@example.com" }]);
  db.seed("credit_ledger", [{ user_id: "u1", delta: 11676 }]);
  for (const t of ["plans_quotes", "jobs", "missions"]) db.seed(t, []);
  const calls: ChatModelInput[] = [];
  setChatModelForTesting((async (input: ChatModelInput) => {
    calls.push(input);
    if (input.system.includes(SHAPE_MARK)) return { ok: true, text: JSON.stringify({ kind: "cant" }), usage: { inputTokens: 5, outputTokens: 5 } };
    const text = input.messages[input.messages.length - 1]?.content ?? "";
    return { ok: true, text: JSON.stringify({ type: "other", reason: "t", reply: "", count: null, ...decide(text) }), usage: { inputTokens: 7, outputTokens: 4 } };
  }) as ChatModelCall);
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the legacy planning model must never run"); });
  handler.agentChat = { enabled: true };
  const ledger0 = JSON.stringify(db.rows("credit_ledger"));
  const ask = (message: string, columns = true) => handler.handleUserMessage({ userId: "u1", conversationId: "conv1", message, userBalance: 40_000, ...(columns ? { resultColumns: COLUMNS } : {}) } as any) as Promise<any>;
  const nothingStarted = () => { expect(db.rows("missions")).toHaveLength(0); expect(db.rows("jobs")).toHaveLength(0); expect(db.rows("plans_quotes")).toHaveLength(0); expect(JSON.stringify(db.rows("credit_ledger"))).toBe(ledger0); };
  const shapeCalls = () => calls.filter((c) => c.system.includes(SHAPE_MARK)).length;
  return { db, ask, nothingStarted, calls, shapeCalls };
}
beforeEach(() => { clearBriefCacheForTesting(); vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); })); });
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); });

const OPEN: OpenRequest = { id: "m1", state: "plan_ready", requestText: "هات ٥٠ شركة مقاولات في مصر" };
const decision = async (answer: Record<string, unknown>, ctx: { open: OpenRequest | null; openResult?: { columns: string[] } }) =>
  decideTurn({ message: FILTER_TEXT, balancePoints: 100, open: ctx.open, ...(ctx.openResult ? { openResult: ctx.openResult } : {}) }, (async () => ({ ok: true, text: JSON.stringify({ type: "other", reason: "t", reply: "", count: null, ...answer }), usage: { inputTokens: 1, outputTokens: 1 } })) as ChatModelCall);

describe("(1) F1: result open, no open request, the model says edit_of_open_request → a file turn, 0 missions", () => {
  it("decideTurn: the decision is a file turn (shape), not a data_request", async () => {
    const d = await decision(EDIT_NO_FILE_TURN, { open: null, openResult: { columns: TITLES } });
    expect(d.source).toBe("model");
    expect(d.type).not.toBe("data_request");
    expect(d.type).not.toBe("edit_of_open_request");
    expect(d.fileTurn).toBe("shape");
  });
  it("the model's own file_turn is kept when it gave one (unclear stays unclear)", async () => {
    const d = await decision({ ...EDIT_NO_FILE_TURN, file_turn: "unclear" }, { open: null, openResult: { columns: TITLES } });
    expect(d.fileTurn).toBe("unclear");
  });
  it("through the real handler: the shaping call is made, no mission, no job, no quote, the ledger untouched", async () => {
    const w = world(() => EDIT_NO_FILE_TURN);
    const r = await w.ask(FILTER_TEXT);
    expect(r.agentMission).toBeUndefined();
    expect(r.outputType).not.toBe("agent_mission");
    expect(r.contentAr).toBe(SHAPING_NEVER_A_PLAN_AR);
    expect(w.shapeCalls()).toBe(1);
    w.nothingStarted();
  });
  it("the decision prompt says that changing the delivered results is a file turn, not an edit of a request (only with a result open)", async () => {
    const w = world(() => EDIT_NO_FILE_TURN);
    await w.ask(FILTER_TEXT);
    const decide = w.calls.find((c) => c.system.includes("OPEN_RESULT: yes"))!;
    expect(decide.system).toMatch(/file_turn[^\n]*shape[^\n]*edit_of_open_request/);
    const plain = world(() => DATA);
    await plain.ask("هات ١٠ شركات", false);
    expect(plain.calls.every((c) => !c.system.includes("OPEN_RESULT"))).toBe(true);
  });
});

describe("(2)(3) counter-cases: nothing that was right changes", () => {
  it("(2) result open + a clear NEW research request (typed data_request) → a mission, as before; no shaping call", async () => {
    const w = world(() => DATA);
    const r = await w.ask("هات ٥٠ شركة مقاولات في دبي");
    expect(r.outputType).toBe("agent_mission");
    expect(w.db.rows("missions")).toHaveLength(1);
    expect(w.shapeCalls()).toBe(0);
  });
  it("(3) an OPEN request + an edit that refers to it → edit_of_open_request as before (no file turn); one that does not refer to it → data_request as before", async () => {
    const edit = await decision({ type: "edit_of_open_request", refers_to_open_request: true, count: 80 }, { open: OPEN, openResult: { columns: TITLES } });
    expect(edit.type).toBe("edit_of_open_request");
    expect(edit.fileTurn).toBeUndefined();
    const notRefers = await decision(EDIT_NO_FILE_TURN, { open: OPEN, openResult: { columns: TITLES } });
    expect(notRefers.type).toBe("data_request");
    expect(notRefers.fileTurn).toBeUndefined();
  });
  it("no result open: an edit-type answer with no open request is a data_request exactly as before", async () => {
    const d = await decision(EDIT_NO_FILE_TURN, { open: null });
    expect(d.type).toBe("data_request");
    expect(d.fileTurn).toBeUndefined();
  });
});
