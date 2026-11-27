import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { setChatModelForTesting, type ChatModelCall } from "../src/lib/agentMission/chatModel";
import { deterministicShapeSpec, isInternalColumnKey, type DatasetColumn } from "../src/lib/fileSpec";
import { isFileShapingMessage } from "../src/functions/shared/requestScope";
import { columnChoicesAr } from "../src/lib/server/savedResultColumns";
import { closestSystemPrompt, namedColumnProblems, namesAreRelated, parseShapeModelAnswer, runClosestColumns, shapeSystemPrompt, validateShapedOutput } from "../src/lib/shapeTurn";
import { createChatDb } from "./helpers/chatSession";
import { createMemoryDb } from "./helpers/memoryDb";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import type { ChatModelInput } from "../src/lib/agentMission/chatModel";

/**
 * UL2a-2b C5 (D-0255): the CTO's real-model replay of #718: «قسّم الملف حسب المحافظة ورتبه حسب اسم الشركة» on a file with «المدينة» but no «المحافظة» → the shaping model quietly used «المدينة» and built the file 5/5.
 * Must-pass: (1) a named column the file does not have is ALWAYS said by name (card or line), combined with a sort or not, and also when the model put another real column in its place; (2) the card lists the CLOSEST real
 * columns first, not the first 8; (3) the product's own fields («حقل إضافي ١/٢», keys starting «_») never appear as options, in a reply or in a prompt. Offline: scripted models; nothing here needs a key.
 */
const T = (key: string, titleAr: string): DatasetColumn => ({ key, titleAr });
/** A real delivered file: the city is the 9th visible column, so a cut at 8 loses it (also in the list a split offers, which leaves out contacts and links); the last two are the product's own fields. */
const COLUMNS: DatasetColumn[] = [
  T("company_name", "اسم الشركة"), T("industry", "النشاط"), T("website", "الموقع الإلكتروني"), T("phone", "رقم الهاتف المهني"), T("work_email", "البريد المهني"),
  T("size", "حجم الشركة"), T("founded", "سنة التأسيس"), T("rating", "التقييم"), T("employees", "عدد الموظفين"), T("revenue", "الإيرادات"), T("funding", "التمويل"), T("lang", "لغة الموقع"), T("city", "المدينة"), T("location", "المقر والنطاق الجغرافي"), T("description", "وصف الشركة"),
  T("_relevance_status", "حقل إضافي ١"), T("_relevance_reason", "حقل إضافي ٢"),
];
const C5 = "قسّم الملف حسب المحافظة ورتبه حسب اسم الشركة";
const C1 = "قسّم الملف حسب المحافظة";
const json = (obj: unknown, usage = { inputTokens: 420, outputTokens: 60 }) => ({ ok: true as const, text: JSON.stringify(obj), usage });
const MODEL_SUBSTITUTES = { kind: "shape", spec: { groupBy: { column: "المدينة" }, sortBy: [{ column: "اسم الشركة", direction: "asc" }] }, named: [{ said: "المحافظة", column: "المدينة" }, { said: "اسم الشركة", column: "اسم الشركة" }], closest: ["المدينة", "المقر والنطاق الجغرافي"] };

afterEach(() => setChatModelForTesting(null));
async function session(answers: any[]) {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  await db.createRow({ tableId: "conversations", rowId: "c_c5", data: { userId: "u_c5", title: "x", status: "active", totalTokens: 0 } });
  const legacy = vi.fn(async () => { throw new Error("the legacy planning model must never be asked about a turn on the delivered file"); });
  (handler as any).llm.executeTurn = legacy;
  const queue = [...answers];
  const model = vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])) as unknown as ChatModelCall & ReturnType<typeof vi.fn>;
  setChatModelForTesting(model);
  const send = (message: string) => handler.handleUserMessage({ userId: "u_c5", conversationId: "c_c5", message, userBalance: 5000, resultColumns: COLUMNS }) as Promise<any>;
  return { db, legacy, model, send };
}
const rowsOf = (db: ReturnType<typeof createChatDb>, table: string) => (db.store.get(table) || []) as any[];
const nothingPaid = (db: ReturnType<typeof createChatDb>, res: any) => {
  expect(res.planQuote).toBeUndefined();
  expect(res.agentMission).toBeUndefined();
  for (const table of ["credit_ledger", "jobs", "plans_quotes", "agent_missions"]) expect(rowsOf(db, table), table).toHaveLength(0);
};
const noInternal = (text: string) => { expect(text).not.toContain("حقل إضافي"); expect(text).not.toContain("_relevance"); };

describe("the test's own premises", () => {
  it("C5 is a text the shaping reader accepts and the code cannot read (so it is the shaping model's), and the city is beyond the first 8 offered columns", () => {
    expect(isFileShapingMessage(C5)).toBe(true);
    expect(deterministicShapeSpec(C5, COLUMNS)).toBeNull();
    expect(columnChoicesAr(COLUMNS, 8, true)).not.toContain("المدينة");
  });
});

describe("(3) the product's own fields never appear", () => {
  it("a key that starts with «_» or ends «_relevance_status» is internal; an ordinary key is not", () => {
    expect(isInternalColumnKey("_relevance_reason")).toBe(true);
    expect(isInternalColumnKey("x_relevance_status")).toBe(true);
    expect(isInternalColumnKey("company_name")).toBe(false);
  });
  it("columnChoicesAr never offers them (also with a huge limit); the prompts of both model calls never list them", () => {
    noInternal(columnChoicesAr(COLUMNS, 100).join("|"));
    noInternal(columnChoicesAr(COLUMNS, 100, true).join("|"));
    noInternal(shapeSystemPrompt(COLUMNS));
    noInternal(closestSystemPrompt(COLUMNS));
  });
  it("preferred titles come first and survive the cut; a title that is not a real offered column is ignored", () => {
    const choices = columnChoicesAr(COLUMNS, 3, false, ["المدينة", "عمود غير موجود", "حقل إضافي ٢", "المقر والنطاق الجغرافي"]);
    expect(choices).toEqual(["المدينة", "المقر والنطاق الجغرافي", "اسم الشركة"]);
  });
});

describe("names: the customer's words against the real title, by spelling only", () => {
  it("one name written two ways is related (article, plural form of the letter, one inside the other, a near spelling)", () => {
    for (const [said, title] of [["الاسم", "اسم الشركة"], ["المدينه", "المدينة"], ["مدينة", "المدينة"], ["اسم الشركه", "اسم الشركة"], ["الهاتف", "رقم الهاتف المهني"]]) expect(namesAreRelated(said!, title!), `${said} ~ ${title}`).toBe(true);
  });
  it("two different columns are not related, whatever the model says", () => {
    for (const [said, title] of [["المحافظة", "المدينة"], ["المحافظة", "المقر والنطاق الجغرافي"], ["الدولة", "اسم الشركة"], ["السعر", "التقييم"], ["اس", "اسم الشركة"]]) expect(namesAreRelated(said!, title!), `${said} ~ ${title}`).toBe(false);
  });
  it("problems: null, a title that is not real, and a real column that is another name are problems; the same name and a near spelling are not", () => {
    const p = namedColumnProblems([
      { said: "المحافظة", column: "المدينة" }, { said: "الدولة", column: null }, { said: "الاقليم", column: "عمود وهمي" },
      { said: "اسم الشركة", column: "اسم الشركة" }, { said: "المدينه", column: "المدينة" }, { said: "حقل إضافي ٢", column: "حقل إضافي ٢" },
    ], COLUMNS);
    expect(p.map((x) => x.said)).toEqual(["المحافظة", "الدولة", "الاقليم", "حقل إضافي ٢"]);
    expect(namedColumnProblems(undefined, COLUMNS)).toEqual([]);
  });
});

describe("the model's answer: what it says the customer named is read, and a made-up quotation is dropped", () => {
  it("named + closest are kept; a «said» that is not in the customer's text is dropped; an empty spec with a missing column is a question, not «not understood»", () => {
    const a: any = parseShapeModelAnswer(JSON.stringify({ kind: "shape", spec: {}, named: [{ said: "المحافظة", column: null }, { said: "كلام ليس في النص", column: null }], closest: ["المدينة"] }), C1);
    expect(a.type).toBe("shape_file");
    expect(a.named).toEqual([{ said: "المحافظة", column: null }]);
    expect(a.closest).toEqual(["المدينة"]);
    const b: any = parseShapeModelAnswer(JSON.stringify({ kind: "shape", spec: {} }), C1);
    expect(b.type).toBe("answer_question");
  });
});

describe("(1)+(2) through the real handler: C5 with the model substituting a real column", () => {
  it("the file is NOT built; the reply says «المحافظة» is missing and ONE card lists the closest columns first, none internal; 0 points, 0 jobs, the planning model never asked", async () => {
    const { db, legacy, model, send } = await session([json(MODEL_SUBSTITUTES)]);
    const res = await send(C5);
    expect(model).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(res.fileShape).toBeUndefined();
    expect(res.outputType).toBe("ask_clarification");
    expect(res.contentAr).toContain("«المحافظة»");
    expect(res.contentAr).toContain("غير موجود");
    expect(res.clarificationItems).toHaveLength(1);
    expect(res.clarificationItems[0].id).toBe("shape_column_required");
    expect(res.clarificationItems[0].options.slice(0, 2)).toEqual(["المدينة", "المقر والنطاق الجغرافي"]);
    noInternal(JSON.stringify(res.clarificationItems) + res.contentAr);
    nothingPaid(db, res);
  });
  it("clicking the closest column builds the free file at once, with no model call", async () => {
    const { db, model, send } = await session([json(MODEL_SUBSTITUTES)]);
    await send(C5);
    const answered = await send(JSON.stringify({ type: "clarification_answers", answers: [{ questionId: "shape_column_required", question: "؟", value: "المدينة" }] }));
    expect(answered.fileShape.spec).toMatchObject({ groupBy: { column: "city" } });
    expect(model).toHaveBeenCalledTimes(1);
    nothingPaid(db, answered);
  });
  it("the model says «no such column» (null) and builds the rest: still named, no card for a step that has no card of its own, the closest columns listed, nothing built", async () => {
    const { db, send } = await session([json({ kind: "shape", spec: { sortBy: [{ column: "اسم الشركة", direction: "asc" }] }, named: [{ said: "المحافظة", column: null }, { said: "اسم الشركة", column: "اسم الشركة" }], closest: ["المدينة"] })]);
    const res = await send(C5);
    expect(res.fileShape).toBeUndefined();
    expect(res.outputType).toBe("answer_question");
    expect(res.contentAr).toContain("«المحافظة»");
    expect(res.contentAr.indexOf("«المدينة»")).toBeGreaterThan(-1);
    noInternal(res.contentAr);
    nothingPaid(db, res);
  });
  it("a sort on a missing column combined with a split (the model replaced it) → the SORT card, named", async () => {
    const { db, send } = await session([json({ kind: "shape", spec: { groupBy: { column: "المدينة" }, sortBy: [{ column: "التقييم", direction: "desc" }] }, named: [{ said: "المدينة", column: "المدينة" }, { said: "السعر", column: "التقييم" }], closest: ["التقييم"] })]);
    const res = await send("قسّم الملف حسب المدينة ورتبه تنازليا حسب السعر");
    expect(res.fileShape).toBeUndefined();
    expect(res.clarificationItems?.[0]?.id).toBe("shape_sort_desc_required");
    expect(res.contentAr).toContain("«السعر»");
    nothingPaid(db, res);
  });
});

describe("counter-cases: nothing that was right changes", () => {
  it("a column named with a near spelling that really is that column still resolves: the file is built", async () => {
    const { db, send } = await session([json({ kind: "shape", spec: { groupBy: { column: "المدينة" }, sortBy: [{ column: "اسم الشركة", direction: "asc" }] }, named: [{ said: "المدينه", column: "المدينة" }, { said: "اسم الشركة", column: "اسم الشركة" }], closest: [] })]);
    const res = await send("قسّم الملف حسب المدينه ورتبه حسب اسم الشركة");
    expect(res.fileShape.spec).toMatchObject({ groupBy: { column: "city" } });
    nothingPaid(db, res);
  });
  it("a vague request names no column: the model's own choice is built as before (named is empty)", async () => {
    const { db, send } = await session([json({ kind: "shape", spec: { sortBy: [{ column: "اسم الشركة", direction: "asc" }] }, named: [], closest: [] })]);
    const res = await send("قسّم الملف زي ما تحب");
    expect(res.fileShape.spec).toMatchObject({ sortBy: [{ column: "company_name" }] });
    nothingPaid(db, res);
  });
  it("an answer with no «named» at all (the older form) is read as before", async () => {
    const { send } = await session([json({ kind: "shape", spec: { sortBy: [{ column: "اسم الشركة", direction: "asc" }] } })]);
    const res = await send("قسّم الملف زي ما تحب");
    expect(res.fileShape.spec).toMatchObject({ sortBy: [{ column: "company_name" }] });
  });
  it("a made-up «said» (not in the customer's text) proves nothing and does not block a good spec", () => {
    const out: any = parseShapeModelAnswer(JSON.stringify({ kind: "shape", spec: { sortBy: [{ column: "اسم الشركة", direction: "asc" }] }, named: [{ said: "جملة من خيال الموديل", column: null }] }), "رتب الملف زي ما تحب");
    expect(validateShapedOutput(out, COLUMNS)?.kind).toBe("ok");
  });
});

describe("C1–C4: a column that code read and the file does not have → still ONE card, now with the closest columns first", () => {
  it("C1: one small call names the nearest columns; they come first; the call's tokens are on the usage row; 0 points", async () => {
    const { db, model, send } = await session([json({ closest: ["المدينة", "المقر والنطاق الجغرافي", "عمود وهمي", "حقل إضافي ٢"] }, { inputTokens: 300, outputTokens: 20 })]);
    const res = await send(C1);
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationItems).toHaveLength(1);
    expect(res.clarificationItems[0].id).toBe("shape_column_required");
    expect(res.clarificationItems[0].options.slice(0, 2)).toEqual(["المدينة", "المقر والنطاق الجغرافي"]);
    expect(res.clarificationItems[0].options).not.toContain("عمود وهمي");
    noInternal(JSON.stringify(res.clarificationItems) + res.contentAr);
    expect(model).toHaveBeenCalledTimes(1);
    expect(rowsOf(db, "llm_usage")).toHaveLength(1);
    expect(rowsOf(db, "llm_usage")[0]).toMatchObject({ inputTokens: 300, outputTokens: 20 });
    nothingPaid(db, res);
  });
  it("the call fails or answers garbage: the same ONE card as before (the file's own order), no internal field, no crash", async () => {
    for (const answer of [{ ok: false, failure: "http_529" }, { ok: true, text: "not json", usage: { inputTokens: 1, outputTokens: 1 } }]) {
      const { db, send } = await session([answer]);
      const res = await send(C1);
      expect(res.outputType).toBe("ask_clarification");
      expect(res.clarificationItems[0].options).toHaveLength(8);
      noInternal(JSON.stringify(res.clarificationItems));
      nothingPaid(db, res);
    }
  });
  it("a column that exists: no closest call at all (A kind stays 0 calls)", async () => {
    const { model, send } = await session([json({ closest: [] })]);
    const res = await send("قسّم الملف حسب المدينة");
    expect(res.fileShape).toBeDefined();
    expect(model).not.toHaveBeenCalled();
  });
  it("runClosestColumns: only real offered titles, at most 3; no columns or no word → no call", async () => {
    const model = vi.fn(async () => json({ closest: ["المدينة", "اسم الشركة", "النشاط", "التقييم", "عمود وهمي"] })) as unknown as ChatModelCall;
    const run = await runClosestColumns({ missing: ["المحافظة"], columns: COLUMNS, model });
    expect(run.closest).toEqual(["المدينة", "اسم الشركة", "النشاط"]);
    const none = await runClosestColumns({ missing: [], columns: COLUMNS, model });
    expect(none.asked).toBe(false);
    expect(model).toHaveBeenCalledTimes(1);
  });
});

describe("(3) the chat model's own call (the turn's decision, agent on) is given the real columns without the product's fields", () => {
  it("the open result's columns in the decision prompt: the real titles, never «حقل إضافي»", async () => {
    clearBriefCacheForTesting();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
    const db: any = createMemoryDb();
    db.seed("conversations", [{ id: "conv1", user_id: "u1", title: "x", status: "active" }]);
    db.seed("profiles", [{ id: "u1", email: "a@example.com" }]);
    db.seed("credit_ledger", [{ user_id: "u1", delta: 11676 }]);
    for (const t of ["plans_quotes", "jobs", "missions"]) db.seed(t, []);
    const calls: ChatModelInput[] = [];
    setChatModelForTesting((async (input: ChatModelInput) => {
      calls.push(input);
      if (input.system.includes("You turn a customer's request about HOW")) return { ok: true, text: JSON.stringify({ kind: "cant" }), usage: { inputTokens: 1, outputTokens: 1 } };
      return { ok: true, text: JSON.stringify({ type: "other", reason: "t", reply: "", count: null, file_turn: "shape" }), usage: { inputTokens: 1, outputTokens: 1 } };
    }) as ChatModelCall);
    const handler = new ChatHandler(db);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("never"); });
    handler.agentChat = { enabled: true };
    await handler.handleUserMessage({ userId: "u1", conversationId: "conv1", message: "قسّم الملف زي ما تحب", userBalance: 40_000, resultColumns: COLUMNS } as any);
    vi.unstubAllGlobals();
    const decision = calls.find((c) => c.system.includes("OPEN_RESULT: yes"));
    expect(decision, "the decision call carried the open result").toBeDefined();
    expect(decision!.system).toContain("اسم الشركة");
    noInternal(decision!.system);
    for (const c of calls) noInternal(c.system);
  });
});

describe("F2 (replay of PR 721): a named-column problem the shaping model found but gave NO nearest columns for → the same tiny closest call as the code-read path", () => {
  const SUBST_NO_CLOSEST = { ...MODEL_SUBSTITUTES, closest: [] };
  it("the options start with what the closest call names; the call's tokens are on the usage row; still ONE card, no file, 0 points", async () => {
    const { db, model, send } = await session([json(SUBST_NO_CLOSEST), json({ closest: ["المقر والنطاق الجغرافي", "المدينة"] }, { inputTokens: 300, outputTokens: 20 })]);
    const res = await send(C5);
    expect(model).toHaveBeenCalledTimes(2);
    expect(res.fileShape).toBeUndefined();
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationItems).toHaveLength(1);
    expect(res.clarificationItems[0].options.slice(0, 2)).toEqual(["المقر والنطاق الجغرافي", "المدينة"]);
    noInternal(JSON.stringify(res.clarificationItems) + res.contentAr);
    expect(rowsOf(db, "llm_usage")[0]).toMatchObject({ inputTokens: 420 + 300, outputTokens: 60 + 20 });
    nothingPaid(db, res);
  });
  it("the closest call fails or answers garbage: the generic order, no crash, still no file", async () => {
    for (const second of [{ ok: false, failure: "http_529" }, { ok: true, text: "not json", usage: { inputTokens: 1, outputTokens: 1 } }]) {
      const { db, send } = await session([json(SUBST_NO_CLOSEST), second]);
      const res = await send(C5);
      expect(res.fileShape).toBeUndefined();
      expect(res.outputType).toBe("ask_clarification");
      expect(res.clarificationItems[0].options).toHaveLength(8);
      noInternal(JSON.stringify(res.clarificationItems));
      nothingPaid(db, res);
    }
  });
  it("counter-cases: the model's own closest is used with NO extra call; an unknown column with no named problem (model path) still makes no extra call", async () => {
    const a = await session([json(MODEL_SUBSTITUTES)]);
    await a.send(C5);
    expect(a.model).toHaveBeenCalledTimes(1);
    const b = await session([json({ kind: "shape", spec: { groupBy: { column: "المحافظة" } } })]);
    await b.send("قسّم الملف زي ما تحب");
    expect(b.model).toHaveBeenCalledTimes(1);
  });
});
