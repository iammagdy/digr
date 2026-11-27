import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { chatModelName, setChatModelForTesting, type ChatModelCall, type ChatModelInput } from "../src/lib/agentMission/chatModel";
import { deterministicShapeSpec, fileEditAnswerAr, unsupportedFileEdit, validateFileSpec, type DatasetColumn } from "../src/lib/fileSpec";
import { SHAPE_CHOICE_QUESTION_ID } from "../src/lib/fileSpec";
import { SHAPE_UNCLEAR_AGAIN_AR, SHAPE_UNCLEAR_AR, SHAPING_NEVER_A_PLAN_AR } from "../src/lib/shapeTurn";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * UL2a-2b, the whole chat turn through the real handler (agent on, a scripted chat model, an in-memory database). The cases of D-0249:
 *  a) a result is open + a vague shaping text → shaping, 0 points / jobs / quotes      b) + a clear new data request → the agent, as today
 *  c) + a general question → the UL2a-1 path                                            d) + unclear → ONE question with options from the real columns, never a plan, never a loop
 *  e) no result open → never shaping, as today                                          f) every text the reader accepts → the same outcome as today
 *  g) the model fails, times out or returns garbage → today's behaviour, no crash, no charge
 */
const ROUTES: Array<{ kind: string; text: string; reader: boolean; route: string }> = JSON.parse(readFileSync(join(__dirname, "fixtures", "wl4-ul2a2b-routes-today.json"), "utf8"));
const texts = (kind: string) => ROUTES.filter((r) => r.kind.startsWith(kind)).map((r) => r.text);

const n: any = normalizeDataset({ rows: [{ company_name: "Nile Energy", industry: "Utilities", website: "https://nile.example", location: "Cairo, Egypt", phone: "+20 100 000 0000", work_email: "info@nile.example", description: "Electricity" }], metadata: { country: "Egypt", entityType: "companies" } }, { title: "شركات" });
const columns: DatasetColumn[] = (n.columns || []).slice(0, 60).map((key: string) => ({ key, titleAr: n.codebook?.find((c: any) => c.field === key)?.titleAr || key }));

const USER = "u1";
const SHAPING_PROMPT_MARK = "You turn a customer's request about HOW THEIR ALREADY-DELIVERED";
type Script = { decide?: (text: string) => Record<string, unknown> | "fail" | "garbage" | "throw"; shape?: Record<string, unknown> | "fail" };

function world(script: Script) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "x", status: "active" }]);
  db.seed("profiles", [{ id: USER, email: "a@example.com" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 11676 }]);
  for (const t of ["plans_quotes", "jobs", "missions"]) db.seed(t, []);
  const calls: ChatModelInput[] = [];
  const model: ChatModelCall = async (input) => {
    calls.push(input);
    if (input.system.includes(SHAPING_PROMPT_MARK)) {
      const a = script.shape ?? { kind: "cant" };
      return a === "fail" ? { ok: false, failure: "http_503" } : { ok: true, text: JSON.stringify(a), usage: { inputTokens: 420, outputTokens: 60 } };
    }
    const text = input.messages[input.messages.length - 1]?.content ?? "";
    const a = script.decide ? script.decide(text) : { type: "data_request" };
    if (a === "throw") throw new Error("network down");
    if (a === "fail") return { ok: false, failure: "http_529" };
    if (a === "garbage") return { ok: true, text: "عذرًا، لا أستطيع التصنيف الآن." };
    return { ok: true, text: JSON.stringify({ type: "other", reason: "t", reply: "", count: null, ...a }), usage: { inputTokens: 700, outputTokens: 40 } };
  };
  setChatModelForTesting(model);
  const handler = new ChatHandler(db);
  const legacy = vi.fn(async () => { throw new Error("the legacy planning model must never run"); });
  (handler as any).llm.executeTurn = legacy;
  handler.agentChat = { enabled: true };
  const ledger0 = JSON.stringify(db.rows("credit_ledger"));
  const ask = (message: string, opts: { columns?: boolean } = {}) =>
    handler.handleUserMessage({ userId: USER, conversationId: "conv1", message, userBalance: 40_000, ...(opts.columns === false ? {} : { resultColumns: columns }) } as any) as Promise<any>;
  const nothingStarted = () => {
    expect(db.rows("missions")).toHaveLength(0);
    expect(db.rows("jobs")).toHaveLength(0);
    expect(db.rows("plans_quotes")).toHaveLength(0);
    expect(JSON.stringify(db.rows("credit_ledger"))).toBe(ledger0);
  };
  const shapingCalls = () => calls.filter((c) => c.system.includes(SHAPING_PROMPT_MARK)).length;
  const decideCalls = () => calls.filter((c) => !c.system.includes(SHAPING_PROMPT_MARK)).length;
  return { db, calls, legacy, ask, nothingStarted, shapingCalls, decideCalls };
}
beforeEach(() => { clearBriefCacheForTesting(); vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); })); });
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); });

const SORT_BY_FIRST = { kind: "shape", spec: { sortBy: [{ column: columns.find((c) => c.key === "company_name")!.titleAr, direction: "asc" }] } };

describe("a) a result is open + a vague shaping text → shaping: 0 points, 0 jobs, 0 quotes", () => {
  for (const text of ["رتبهم زي ما تحب", "نسق الملف", "خليه شيتات", "عدل الملف", "خلي الملف أحلى", "ممكن تعدل الملف شوية"]) {
    it(`«${text}»`, async () => {
      const w = world({ decide: () => ({ type: "other", file_turn: "shape" }), shape: SORT_BY_FIRST });
      const r = await w.ask(text);
      expect(w.legacy).not.toHaveBeenCalled();
      expect(r.outputType).toBe("answer_question");
      expect(r.fileShape?.spec).toMatchObject({ sortBy: [{ column: "company_name", direction: "asc" }] });
      expect(r.contentAr).toContain("لا يُخصم أي رصيد");
      w.nothingStarted();
      // the ONE decision of the turn carried the real columns; the shaping call came after it
      expect(w.decideCalls()).toBe(1);
      expect(w.shapingCalls()).toBe(1);
      const decide = w.calls.find((c) => !c.system.includes(SHAPING_PROMPT_MARK))!;
      expect(decide.system).toContain("OPEN_RESULT: yes");
      for (const c of columns) expect(decide.system).toContain(`«${c.titleAr}»`);
    });
  }
  it("the usage row of the turn holds both calls (the decision and the shaping call), under the chat model's name", async () => {
    const w = world({ decide: () => ({ type: "other", file_turn: "shape" }), shape: SORT_BY_FIRST });
    await w.ask("رتبهم زي ما تحب");
    const usage = w.db.rows("llm_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: chatModelName(), tokens_in: 700 + 420, tokens_out: 40 + 60 });
  });
  it("the model's shaping call that cannot say what to do: the fixed sentence, still nothing started", async () => {
    const w = world({ decide: () => ({ type: "other", file_turn: "shape" }), shape: { kind: "cant" } });
    const r = await w.ask("نسق الملف");
    expect(r.contentAr).toBe(SHAPING_NEVER_A_PLAN_AR);
    w.nothingStarted();
  });
});

describe("b) a result is open + a clear new data request → the agent, as today", () => {
  for (const text of texts("D")) {
    it(`«${text}»`, async () => {
      const w = world({ decide: () => ({ type: "data_request", file_turn: null }) });
      const r = await w.ask(text);
      expect(r.outputType).toBe("agent_mission");
      expect(w.db.rows("missions")).toHaveLength(1);
      expect(w.db.rows("missions")[0].status).toBe("queued");
      expect(w.db.rows("plans_quotes")).toHaveLength(0);
      expect(w.db.rows("jobs")).toHaveLength(0);
      expect(r.fileShape).toBeUndefined();
      // ONE call for the turn, as before: the decision made for the file question is the agent's own
      expect(w.calls).toHaveLength(1);
      expect(w.shapingCalls()).toBe(0);
      expect(w.db.rows("llm_usage").every((u: any) => !(u.tokens_in > 0))).toBe(true);
    });
  }
  it("the same message with the same answer, with and without a result open, makes the same mission (only the prompt differs)", async () => {
    const text = "هات لي ١٠٠ شركة في دبي وقسمهم شيت لكل مدينة";
    const open = world({ decide: () => ({ type: "data_request", file_turn: null }) });
    const closed = world({ decide: () => ({ type: "data_request" }) });
    const a = await open.ask(text);
    const b = await closed.ask(text, { columns: false });
    expect(a.outputType).toBe(b.outputType);
    expect(a.contentAr).toBe(b.contentAr);
    const strip = (rows: any[]) => rows.map(({ id, created_at, updated_at, ...rest }) => rest);
    expect(strip(open.db.rows("missions"))).toEqual(strip(closed.db.rows("missions")));
  });
});

describe("c) a result is open + a general question → the UL2a-1 path (a conversation, no mission, no quote)", () => {
  for (const text of texts("E")) {
    it(`«${text}»`, async () => {
      const w = world({ decide: () => ({ type: "service_question", file_turn: null, reply: "ديجر خدمة لجمع بيانات البحث وتسليمها في ملف منظم." }) });
      const r = await w.ask(text);
      expect(r.outputType).toBe("answer_question");
      expect(r.fileShape).toBeUndefined();
      w.nothingStarted();
      expect(w.calls).toHaveLength(1);
      expect(w.legacy).not.toHaveBeenCalled();
    });
  }
});

describe("d) unclear → ONE short question with options built from the real columns; never a plan, never a loop", () => {
  it("a card: one question, options are real-column instructions, nothing started, the usage row holds the decision", async () => {
    const w = world({ decide: () => ({ type: "other", file_turn: "unclear" }) });
    const r = await w.ask("عايز تعديل في الملف");
    expect(r.outputType).toBe("ask_clarification");
    expect(r.planQuote).toBeUndefined();
    expect(r.clarificationItems).toHaveLength(1);
    expect(r.clarificationItems[0].id).toBe(SHAPE_CHOICE_QUESTION_ID);
    const options: string[] = r.clarificationItems[0].options;
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const o of options) {
      const spec = deterministicShapeSpec(o, columns);
      expect(spec, o).not.toBeNull();
      expect(validateFileSpec(spec, columns).ok, o).toBe(true);
    }
    expect(r.contentAr).toBe(SHAPE_UNCLEAR_AR);
    w.nothingStarted();
    expect(w.shapingCalls()).toBe(0);
    expect(w.db.rows("llm_usage")[0]).toMatchObject({ model: chatModelName(), tokens_in: 700, tokens_out: 40 });
  });
  it("each option, chosen, makes the free file by code: no model call at all, nothing started", async () => {
    const probe = world({ decide: () => ({ type: "other", file_turn: "unclear" }) });
    const first = await probe.ask("عايز تعديل في الملف");
    for (const option of first.clarificationItems[0].options as string[]) {
      const w = world({ decide: () => ({ type: "other", file_turn: "unclear" }) });
      await w.ask("عايز تعديل في الملف");
      const callsBefore = w.calls.length;
      const answered = await w.ask(JSON.stringify({ type: "clarification_answers", answers: [{ questionId: SHAPE_CHOICE_QUESTION_ID, question: "؟", value: option }] }));
      expect(answered.fileShape?.spec, option).toBeDefined();
      expect(answered.outputType).toBe("answer_question");
      expect(w.calls.length).toBe(callsBefore);
      w.nothingStarted();
    }
  });
  it("never a loop: unclear right after the card, and again after that sentence, is a plain sentence; a card comes again only after something else was said", async () => {
    let kind: Record<string, unknown> = { type: "other", file_turn: "unclear" };
    const w = world({ decide: () => kind });
    const one = await w.ask("عايز تعديل في الملف");
    expect(one.outputType).toBe("ask_clarification");
    for (const text of ["مش عارف", "برضه مش عارف", "طيب إيه؟"]) {
      const again = await w.ask(text);
      expect(again.outputType, text).toBe("answer_question");
      expect(again.contentAr, text).toBe(SHAPE_UNCLEAR_AGAIN_AR);
      expect(again.clarificationItems ?? [], text).toHaveLength(0);
    }
    // something else is said (a general question, answered), then a file text that is unclear again: ONE card again
    kind = { type: "service_question", file_turn: null, reply: "ديجر خدمة لجمع بيانات البحث وتسليمها في ملف منظم." };
    await w.ask("انت بتعمل ايه؟");
    kind = { type: "other", file_turn: "unclear" };
    const later = await w.ask("عايز تعديل في الملف");
    expect(later.outputType).toBe("ask_clarification");
    expect(later.clarificationItems).toHaveLength(1);
    w.nothingStarted();
  });
  it("a card answer is never re-read by the model: the file turn decision is not asked for it", async () => {
    const w = world({ decide: () => ({ type: "other", file_turn: "unclear" }) });
    const one = await w.ask("عايز تعديل في الملف");
    const before = w.calls.length;
    await w.ask(JSON.stringify({ type: "clarification_answers", answers: [{ questionId: SHAPE_CHOICE_QUESTION_ID, question: "؟", value: one.clarificationItems[0].options[0] }] }));
    expect(w.calls.length).toBe(before);
  });
});

describe("e) no result open → never shaping, as today", () => {
  for (const text of ["رتبهم زي ما تحب", "نسق الملف", "خليه شيتات", "رتب الملف حسب المدينة"]) {
    it(`«${text}», the page sent no columns: the prompt has no open result, a «shape» from the model is never read, the agent takes it as before`, async () => {
      const w = world({ decide: () => ({ type: "data_request", file_turn: "shape" }) });
      const r = await w.ask(text, { columns: false });
      expect(r.fileShape).toBeUndefined();
      expect(w.shapingCalls()).toBe(0);
      expect(w.calls).toHaveLength(1);
      expect(w.calls[0].system).not.toContain("OPEN_RESULT");
      expect(w.calls[0].system).not.toContain("file_turn");
      expect(r.outputType).toBe("agent_mission");
    });
  }
});

describe("f) every text the reader accepts today → the same outcome as today (the model agrees with the file turn)", () => {
  const accepted = ROUTES.filter((r) => r.route !== "agent");
  it("a text code reads: the same spec as the code reader builds, no shaping call, nothing started", async () => {
    for (const row of accepted.filter((r) => r.route === "shape:code")) {
      const w = world({ decide: () => ({ type: "other", file_turn: "shape" }) });
      const r = await w.ask(row.text);
      const expected = deterministicShapeSpec(row.text, columns);
      const checked = validateFileSpec(expected, columns);
      if (checked.ok) expect(r.fileShape?.spec, row.text).toEqual(checked.spec);
      else expect(r.fileShape, row.text).toBeUndefined();
      expect(w.shapingCalls(), row.text).toBe(0);
      w.nothingStarted();
    }
  });
  it("an edit that is not offered: the same one sentence", async () => {
    for (const row of accepted.filter((r) => r.route === "shape:edit-answer")) {
      const w = world({ decide: () => ({ type: "other", file_turn: "shape" }) });
      const r = await w.ask(row.text);
      expect(r.contentAr, row.text).toBe(fileEditAnswerAr(unsupportedFileEdit(row.text)!));
      w.nothingStarted();
    }
  });
  it("a text the reader accepts and code cannot read: the shaping call, as before", async () => {
    for (const row of accepted.filter((r) => r.route === "shape:model")) {
      const w = world({ decide: () => ({ type: "other", file_turn: "shape" }), shape: { kind: "cant" } });
      const r = await w.ask(row.text);
      expect(w.shapingCalls(), row.text).toBe(1);
      expect(r.contentAr, row.text).toBe(SHAPING_NEVER_A_PLAN_AR);
      w.nothingStarted();
    }
  });
});

describe("g) the model fails, times out or returns garbage → today's behaviour: never a crash, never a charge", () => {
  for (const failure of ["fail", "garbage", "throw"] as const) {
    it(`a text the reader accepts keeps being shaped by code (${failure})`, async () => {
      const w = world({ decide: () => failure });
      const r = await w.ask("رتب الملف حسب المدينة");
      expect(r.fileShape?.spec).toMatchObject({ sortBy: [{ column: "city", direction: "asc" }] });
      expect(w.shapingCalls()).toBe(0);
      w.nothingStarted();
    });
    it(`a vague text the reader rejects goes the agent's way as today, nothing charged, no shaping (${failure})`, async () => {
      const w = world({ decide: () => failure });
      const r = await w.ask("رتبهم زي ما تحب");
      expect(r.fileShape).toBeUndefined();
      expect(r.clarificationItems ?? []).toHaveLength(0);
      expect(w.shapingCalls()).toBe(0);
      expect(w.legacy).not.toHaveBeenCalled();
      expect(w.db.rows("plans_quotes")).toHaveLength(0);
      expect(w.db.rows("jobs")).toHaveLength(0);
      expect(JSON.stringify(w.db.rows("credit_ledger"))).toBe(JSON.stringify([{ user_id: USER, delta: 11676 }]));
    });
  }
  it("a model that answers the decision but the shaping call fails: the fixed sentence, nothing started", async () => {
    const w = world({ decide: () => ({ type: "other", file_turn: "shape" }), shape: "fail" });
    const r = await w.ask("خليه شيتات");
    expect(r.outputType).toBe("answer_question");
    expect(r.fileShape).toBeUndefined();
    w.nothingStarted();
  });
});

describe("the fallback is counted: one log tag every time the reader decides (D-0250)", () => {
  const tags = (spy: { mock: { calls: unknown[][] } }): any[] => spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes('"file_turn_fallback"')).map((l: string) => JSON.parse(l));
  it("the decision call failed (any way): ONE tag, with the failure code and what the reader decided", async () => {
    for (const failure of ["fail", "garbage", "throw"] as const) {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      try {
        const w = world({ decide: () => failure });
        await w.ask("رتب الملف حسب المدينة");
        const found = tags(info);
        expect(found, failure).toHaveLength(1);
        expect(found[0]).toMatchObject({ tag: "file_turn_fallback", asked: true, shaping: true });
        expect(typeof found[0].failure).toBe("string");
        const vague = world({ decide: () => failure });
        info.mockClear();
        await vague.ask("رتبهم زي ما تحب");
        expect(tags(info), failure).toHaveLength(1);
        expect(tags(info)[0]).toMatchObject({ asked: true, shaping: false });
      } finally { info.mockRestore(); }
    }
  });
  it("the model decided: no tag, whatever it said", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      for (const answer of [{ type: "other", file_turn: "shape" }, { type: "other", file_turn: "unclear" }, { type: "data_request", file_turn: null }, { type: "service_question", file_turn: null, reply: "ديجر خدمة لجمع بيانات البحث." }]) {
        const w = world({ decide: () => answer, shape: { kind: "cant" } });
        await w.ask("رتب الملف حسب المدينة");
      }
      expect(tags(info)).toHaveLength(0);
    } finally { info.mockRestore(); }
  });
  it("no decision asked (no open result): no tag for an ordinary turn; a tag when the reader alone says «file turn» (agent off, columns sent)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const closed = world({ decide: () => ({ type: "data_request" }) });
      await closed.ask("عايز ٥٠ شركة مقاولات في مصر", { columns: false });
      expect(tags(info)).toHaveLength(0);
      const off = world({});
      (off as any).legacy.mockClear?.();
      const handler = new ChatHandler(off.db);
      (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("no legacy model"); });
      handler.agentChat = null;
      const r: any = await handler.handleUserMessage({ userId: USER, conversationId: "conv1", message: "رتب الملف حسب المدينة", userBalance: 40_000, resultColumns: columns } as any);
      expect(r.fileShape).toBeDefined();
      expect(tags(info)).toHaveLength(1);
      expect(tags(info)[0]).toMatchObject({ asked: false, shaping: true });
      expect(tags(info)[0].failure).toBeUndefined();
    } finally { info.mockRestore(); }
  });
});

describe("a model-routed file turn ends like a reader-routed one (same stored result)", () => {
  const stored = (w: ReturnType<typeof world>) => w.db.rows("messages").map((m: any) => ({ role: m.role, request_status: m.request_status ?? null, content: String(m.content_ar ?? "").slice(0, 60) }));
  for (const text of ["رتب الملف حسب المحافظة", "رتب الملف حسب المدينة"]) {
    it(`«${text}»: the customer's message and the answer are stored exactly as when the reader routed it`, async () => {
      const reader = world({ decide: () => "fail" });
      const model = world({ decide: () => ({ type: "other", file_turn: "shape" }) });
      await reader.ask(text);
      await model.ask(text);
      expect(stored(model)).toEqual(stored(reader));
    });
  }
  it("the model says «unclear» for a text the code can read: the code's spec wins, no card", async () => {
    const w = world({ decide: () => ({ type: "other", file_turn: "unclear" }) });
    const r = await w.ask("رتب الملف حسب المدينة");
    expect(r.fileShape?.spec).toMatchObject({ sortBy: [{ column: "city", direction: "asc" }] });
    expect(r.clarificationItems ?? []).toHaveLength(0);
    w.nothingStarted();
  });
});

describe("the turn is read once", () => {
  it("every kind of turn with a result open makes exactly the model calls it needs: data / general / unclear → 1; shaping the code reads → 1; shaping it cannot → 2", async () => {
    const cases: Array<[string, Record<string, unknown>, number]> = [
      ["عايز ٥٠ شركة مقاولات في مصر", { type: "data_request", file_turn: null }, 1],
      ["انت بتعمل ايه؟", { type: "service_question", file_turn: null, reply: "ديجر خدمة لجمع بيانات البحث." }, 1],
      ["عايز تعديل في الملف", { type: "other", file_turn: "unclear" }, 1],
      ["رتب الملف حسب المدينة", { type: "other", file_turn: "shape" }, 1],
      ["قسّم الملف زي ما تحب", { type: "other", file_turn: "shape" }, 2],
    ];
    for (const [text, answer, expected] of cases) {
      const w = world({ decide: () => answer, shape: SORT_BY_FIRST });
      await w.ask(text);
      expect(w.calls.length, text).toBe(expected);
    }
  });
});
