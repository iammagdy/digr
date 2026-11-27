import { afterEach, describe, it, expect, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { chatModelName, setChatModelForTesting, type ChatModelCall } from "../src/lib/agentMission/chatModel";
import { type DatasetColumn } from "../src/lib/fileSpec";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { SHAPE_MODEL_FAILED_AR, SHAPE_NOT_UNDERSTOOD_AR, SHAPING_NEVER_A_PLAN_AR } from "../src/lib/shapeTurn";
import { createChatDb } from "./helpers/chatSession";

/**
 * UL2a-2 (D-0247, D1 = a): the whole chat turn about the customer's delivered file, through the real handler. The must-pass cases of the order:
 *  1) columns sent + free text the code cannot read → a valid spec on the REAL columns, 0 points, 0 jobs, ledger unchanged
 *  2) a clear instruction that code already reads → the same result as before and NO model call
 *  3) unclear text → one short answer, never a loop of cards
 *  4) the model returns unknown/invalid columns → checked against the real columns, falls back to the existing question card, no crash
 *  5) counter-case: a new data request typed while a file is open is NOT shaped
 *  6) the legacy planning model (`executeTurn`) is never reached from the shaping branch
 */
function deliveredCompanyColumns(): DatasetColumn[] {
  const normalized: any = normalizeDataset(
    {
      rows: [
        { company_name: "Nile Energy", industry: "Utilities", website: "https://nile.example", location: "Cairo, Egypt", phone: "+20 100 000 0000", work_email: "info@nile.example", description: "Electricity distribution" },
        { company_name: "Delta Power", industry: "Utilities", website: "https://delta.example", location: "Alexandria, Egypt", phone: "+20 100 000 0001", work_email: "info@delta.example", description: "Power plants" },
      ],
      metadata: { country: "Egypt", entityType: "companies" },
    },
    { title: "شركات" },
  );
  return (normalized.columns || []).slice(0, 60).map((key: string) => ({ key, titleAr: normalized.codebook?.find((c: any) => c.field === key)?.titleAr || key }));
}
const columns = deliveredCompanyColumns();

const json = (obj: unknown, usage = { inputTokens: 420, outputTokens: 60 }) => ({ ok: true as const, text: JSON.stringify(obj), usage });
/** A request the shaping reader accepts (isFileShapingMessage) and the code cannot turn into a spec (deterministicShapeSpec returns null). */
const UNREADABLE = "قسّم الملف زي ما تحب";
const SORT_BY_NAME = { kind: "shape", spec: { sortBy: [{ column: "اسم الشركة", direction: "asc" }] } };

afterEach(() => setChatModelForTesting(null));

async function session(shapeAnswers: any[] = [json({ kind: "cant" })]) {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  await db.createRow({ tableId: "conversations", rowId: "c_ul2a2", data: { userId: "u_ul2a2", title: "x", status: "active", totalTokens: 0 } });
  const legacy = vi.fn(async () => { throw new Error("the legacy planning model must never be asked about a turn on the delivered file"); });
  (handler as any).llm.executeTurn = legacy;
  const queue = [...shapeAnswers];
  const shapeModel = vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])) as unknown as ChatModelCall & ReturnType<typeof vi.fn>;
  setChatModelForTesting(shapeModel);
  const send = (message: string, resultColumns: DatasetColumn[] | undefined = columns) => handler.handleUserMessage({ userId: "u_ul2a2", conversationId: "c_ul2a2", message, userBalance: 5000, ...(resultColumns ? { resultColumns } : {}) }) as Promise<any>;
  return { db, handler, legacy, shapeModel, send };
}
const rowsOf = (db: ReturnType<typeof createChatDb>, table: string) => (db.store.get(table) || []) as any[];
function expectNothingPaid(db: ReturnType<typeof createChatDb>, res: any) {
  expect(res.planQuote).toBeUndefined();
  expect(res.revisionQuote).toBeUndefined();
  expect(res.agentMission).toBeUndefined();
  for (const table of ["credit_ledger", "jobs", "plans_quotes", "job_events", "agent_missions"]) expect(rowsOf(db, table), table).toHaveLength(0);
}

describe("1) a text the code cannot read, columns sent → one constrained call, a valid spec on the real columns", () => {
  it("«قسّم الملف زي ما تحب»: the file is shaped, 0 points, 0 jobs, no quote, the ledger untouched, the planning model never asked", async () => {
    const { db, legacy, shapeModel, send } = await session([json(SORT_BY_NAME)]);
    const res = await send(UNREADABLE);
    expect(shapeModel).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(res.outputType).toBe("answer_question");
    expect(res.fileShape.spec).toMatchObject({ sortBy: [{ column: "company_name", direction: "asc" }] });
    expect(res.contentAr).toContain("لا يُخصم أي رصيد");
    expect(res.contentAr).toContain("تحميل الملف المخصص");
    expectNothingPaid(db, res);
    const input = (shapeModel as any).mock.calls[0][0];
    for (const c of columns) expect(input.system).toContain(c.titleAr);
    expect(input.messages).toEqual([{ role: "user", content: UNREADABLE }]);
  });

  it("one usage row, priced at the shaping call's tokens; the model's name is the chat model's", async () => {
    const { db, send } = await session([json(SORT_BY_NAME, { inputTokens: 700, outputTokens: 90 })]);
    await send(UNREADABLE);
    const usage = rowsOf(db, "llm_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: chatModelName(), inputTokens: 700, outputTokens: 90 });
    expect(usage[0].costUsd).toBeGreaterThan(0);
  });

  it("a compound request in words the code cannot read is the model's: groupBy + sortBy on the real columns", async () => {
    const { db, send, legacy } = await session([json({ kind: "shape", spec: { groupBy: { column: "المدينة" }, sortBy: [{ column: "اسم الشركة", direction: "asc" }] } })]);
    const res = await send("قسّم الملف حسب المدينة ورتبه حسب اسم الشركة");
    expect(res.fileShape.spec).toMatchObject({ groupBy: { column: "city" }, sortBy: [{ column: "company_name", direction: "asc" }] });
    expect(legacy).not.toHaveBeenCalled();
    expectNothingPaid(db, res);
  });
});

describe("2) an instruction the code already reads → the same result as today, and NO model call", () => {
  for (const [text, expected] of [
    ["رتب النتائج حسب المدينة تنازلياً", { sortBy: [{ column: "city", direction: "desc" }] }],
    ["فلتر الملف على المدينة يساوي القاهرة", { filters: [{ column: "city", op: "equals", value: "القاهرة" }] }],
    ["سيب الأعمدة اسم الشركة والمدينة فقط", { columns: ["company_name", "city"] }],
    ["قسّم الملف شيت لكل مدينة", { groupBy: { column: "city" } }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(text, async () => {
      const { db, legacy, shapeModel, send } = await session([json(SORT_BY_NAME)]);
      const res = await send(text);
      expect(shapeModel).not.toHaveBeenCalled();
      expect(legacy).not.toHaveBeenCalled();
      expect(res.fileShape.spec).toMatchObject(expected);
      expect(res.tokensUsed).toEqual({ input: 0, output: 0, costUsd: 0 });
      expect(rowsOf(db, "llm_usage")[0]).toMatchObject({ model: "deterministic", inputTokens: 0, outputTokens: 0, costUsd: 0 });
      expectNothingPaid(db, res);
    });
  }
  it("an edit that is not offered and the answer to a shaping question are code too", async () => {
    const { legacy, shapeModel, send } = await session();
    const dedupe = await send("احذف التكرار من الملف");
    expect(dedupe.outputType).toBe("answer_question");
    const answer = JSON.stringify({ type: "clarification_answers", answers: [{ questionId: "shape_sort_asc_required", question: "؟", value: "المدينة" }] });
    const answered = await send(answer);
    expect(answered.fileShape.spec).toMatchObject({ sortBy: [{ column: "city", direction: "asc" }] });
    expect(shapeModel).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("3) unclear text → one short answer or the existing question card, never a loop of cards", () => {
  it("three unclear turns in a row: three one-sentence answers, no card, no plan", async () => {
    const sentence = "ما الترتيب الذي تريده؟ مثلًا: حسب اسم الشركة أو حسب المدينة.";
    const { db, shapeModel, send } = await session([json({ kind: "answer", answerAr: sentence })]);
    for (let i = 0; i < 3; i++) {
      const res = await send(UNREADABLE);
      expect(res.contentAr).toBe(sentence);
      expect(res.outputType).toBe("answer_question");
      expect(res.clarificationItems ?? []).toHaveLength(0);
      expect(res.fileShape).toBeUndefined();
      expectNothingPaid(db, res);
    }
    expect(shapeModel).toHaveBeenCalledTimes(3);
  });
  it("an answer with a number in it is replaced by the fixed sentence", async () => {
    const { send } = await session([json({ kind: "answer", answerAr: "سيُخصم ٥٠ نقطة" })]);
    const res = await send(UNREADABLE);
    expect(res.contentAr).toBe(SHAPE_NOT_UNDERSTOOD_AR);
  });
  it("the model says it is not about the file → the shaping-is-free sentence, no plan", async () => {
    const { db, send } = await session([json({ kind: "cant" })]);
    const res = await send(UNREADABLE);
    expect(res.contentAr).toBe(SHAPING_NEVER_A_PLAN_AR);
    expectNothingPaid(db, res);
  });
});

describe("4) unknown or invalid columns from the model are checked against the real columns", () => {
  it("an unknown column to split on → the existing ONE question with the real columns as options; its answer is code", async () => {
    const { db, legacy, shapeModel, send } = await session([json({ kind: "shape", spec: { groupBy: { column: "المحافظة" } } })]);
    const res = await send(UNREADABLE);
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationItems).toHaveLength(1);
    expect(res.clarificationItems[0].id).toBe("shape_column_required");
    expect(res.clarificationItems[0].options).toContain("المدينة");
    expect(res.contentAr).toContain("لن يُخصم أي رصيد");
    expectNothingPaid(db, res);
    const answered = await send(JSON.stringify({ type: "clarification_answers", answers: [{ questionId: "shape_column_required", question: "؟", value: "المدينة" }] }));
    expect(answered.fileShape).toBeDefined();
    expect(shapeModel).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });
  it("an unknown column in a filter → the real columns are named, no spec, no card loop", async () => {
    const { send, db } = await session([json({ kind: "shape", spec: { filters: [{ column: "المحافظة", op: "equals", value: "القاهرة" }] } })]);
    const res = await send(UNREADABLE);
    expect(res.contentAr).toContain("الأعمدة المتاحة");
    expect(res.fileShape).toBeUndefined();
    expectNothingPaid(db, res);
  });
  it("a spec the strict schema refuses (extra key, wrong shape) → the fixed sentence, no crash", async () => {
    for (const spec of [{ sortBy: [{ column: "المدينة", direction: "asc" }], price: 5 }, "رتب", { columns: [] }]) {
      const { send } = await session([json({ kind: "shape", spec })]);
      const res = await send(UNREADABLE);
      expect(res.outputType).toBe("answer_question");
      expect(res.fileShape).toBeUndefined();
    }
  });
  it("the model call fails, throws or answers garbage → the fixed sentence, nothing charged, no crash", async () => {
    for (const answer of [{ ok: false, failure: "http_503" }, { ok: true, text: "كلام بلا JSON" }, { ok: true, text: "{" }, { ok: true, text: "" }]) {
      const { send, db, legacy } = await session([answer]);
      const res = await send(UNREADABLE);
      expect(res.contentAr).toBe(SHAPE_MODEL_FAILED_AR);
      expectNothingPaid(db, res);
      expect(legacy).not.toHaveBeenCalled();
    }
    const { handler, send, legacy } = await session();
    setChatModelForTesting(async () => { throw new Error("boom"); });
    const res = await send(UNREADABLE);
    expect(res.contentAr).toBe(SHAPE_MODEL_FAILED_AR);
    expect(legacy).not.toHaveBeenCalled();
    expect(handler).toBeDefined();
  });
});

describe("a vague text that the shaping reader does not accept is not a shaping turn (pre-existing routing, unchanged by UL2a-2)", () => {
  it("«رتبهم زي ما تحب» and «خلي الملف أحلى» never reach the shaping model", async () => {
    for (const text of ["رتبهم زي ما تحب", "خلي الملف أحلى"]) {
      const { handler, shapeModel } = await session();
      const planner = vi.fn(async () => ({ output: { type: "answer_question", answerAr: "تمام" }, inputTokens: 1, outputTokens: 1, costUsd: 0, model: "claude-haiku-5-5", promptVersion: "t" }));
      (handler as any).llm.executeTurn = planner;
      await handler.handleUserMessage({ userId: "u_ul2a2", conversationId: "c_ul2a2", message: text, userBalance: 5000, resultColumns: columns } as any).catch(() => undefined);
      expect(shapeModel, text).not.toHaveBeenCalled();
    }
  });
});

describe("5) counter-case: a new data request typed while a file is open is NOT shaped", () => {
  it("«عايز ٥٠ شركة مقاولات في مصر» with columns on the page: the shaping model is never asked, the request goes the way it went before", async () => {
    const { db, handler, legacy, shapeModel } = await session();
    // the request path (not the shaping branch) is asked: here the old planning model stub answers once, so that the route taken is visible
    const planner = vi.fn(async () => ({ output: { type: "answer_question", answerAr: "تمام" }, inputTokens: 1, outputTokens: 1, costUsd: 0, model: "claude-haiku-5-5", promptVersion: "t" }));
    (handler as any).llm.executeTurn = planner;
    await handler.handleUserMessage({ userId: "u_ul2a2", conversationId: "c_ul2a2", message: "عايز ٥٠ شركة مقاولات في مصر", userBalance: 5000, resultColumns: columns } as any).catch(() => undefined);
    expect(shapeModel).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(planner.mock.calls.length + rowsOf(db, "agent_missions").length + rowsOf(db, "messages").length).toBeGreaterThan(0);
  });
});

describe("6) the legacy planning model is never reached from the shaping branch", () => {
  const SHAPING_TURNS: Array<[string, any[]]> = [
    ["رتب النتائج حسب المدينة تنازلياً", [json({ kind: "cant" })]],
    ["فلتر النتائج على القاهرة", [json(SORT_BY_NAME)]],
    ["شيت لكل مدينة ورتب بالاسم", [json({ kind: "cant" })]],
    [UNREADABLE, [json(SORT_BY_NAME)]],
    [UNREADABLE, [json({ kind: "answer", answerAr: "ما الترتيب الذي تريده؟" })]],
    [UNREADABLE, [json({ kind: "cant" })]],
    [UNREADABLE, [json({ kind: "propose_plan", summaryAr: "خطة" })]],
    [UNREADABLE, [json({ kind: "shape", spec: { groupBy: { column: "المحافظة" } } })]],
    [UNREADABLE, [{ ok: false, failure: "timeout" }]],
    ["احذف التكرار من الملف", [json({ kind: "cant" })]],
    ["قسّم الملف حسب المدينة ورتبه حسب اسم الشركة وفلتر على القاهرة", [json({ kind: "cant" })]],
  ];
  it("whatever the text and whatever the shaping model says: executeTurn is called 0 times", async () => {
    for (const [text, answers] of SHAPING_TURNS) {
      const { send, legacy } = await session(answers);
      const res = await send(text);
      expect(res.contentAr, text).toBeTruthy();
      expect(legacy, `${text} / ${JSON.stringify(answers)}`).not.toHaveBeenCalled();
    }
  });
});
