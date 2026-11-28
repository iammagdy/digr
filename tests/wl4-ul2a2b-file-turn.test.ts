import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { buildSystemPrompt, decideTurn, parseModelAnswer, openResultPromptLines } from "../src/lib/agentMission/conversationModel";
import { prepareAgentTurn, agentChatTurn, turnNeedsNoDecision } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting, type ChatModelCall } from "../src/lib/agentMission/chatModel";
import { SHAPE_CHOICE_QUESTION_ID, deterministicShapeSpec, resolveShapeAnswer, shapeAnswerFromMessage, validateFileSpec, type DatasetColumn } from "../src/lib/fileSpec";
import { isFileShapingMessage } from "../src/functions/shared/requestScope";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";
import { SHAPE_UNCLEAR_AGAIN_AR, SHAPE_UNCLEAR_AR, buildUnclearShapeReply, isFileShapingTurnFor, readShapingTurn, routeFileTurn, unclearShapeOptions } from "../src/lib/shapeTurn";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * UL2a-2b (D-0249): while a delivered result file is open on the page, the chat model decides — in the call the turn makes anyway — whether a message is about the shape of that file. The word reader
 * (`isFileShapingMessage`) is here only as the ORACLE of what routing did before, and as the answer when no decision was asked for or the model's call failed.
 */
const ROUTES: Array<{ kind: string; text: string; reader: boolean; route: string }> = JSON.parse(readFileSync(join(__dirname, "fixtures", "wl4-ul2a2b-routes-today.json"), "utf8"));

function columnsOf(rows: Array<Record<string, unknown>>, entityType = "companies"): DatasetColumn[] {
  const n: any = normalizeDataset({ rows, metadata: { country: "Egypt", entityType } }, { title: "نتائج" });
  return (n.columns || []).slice(0, 60).map((key: string) => ({ key, titleAr: n.codebook?.find((c: any) => c.field === key)?.titleAr || key }));
}
const companyColumns = columnsOf([{ company_name: "Nile Energy", industry: "Utilities", website: "https://nile.example", location: "Cairo, Egypt", phone: "+20 100 000 0000", work_email: "info@nile.example", description: "Electricity" }]);

afterEach(() => setChatModelForTesting(null));

// ------------------------------------------------------------------------------------------------------------------------- 0. today's routing, measured (the oracle for f and g)
describe("today's routing, measured (56 messages, a result open on the page)", () => {
  it("the fixture is the measurement: reader + the page's columns decide, exactly as before this patch", () => {
    for (const row of ROUTES) {
      const r = readShapingTurn(row.text);
      const shaping = isFileShapingTurnFor({ ...r, columnCount: companyColumns.length, hasDeliveredResultJob: false });
      expect(shaping, row.text).toBe(row.route !== "agent");
      expect(isFileShapingMessage(row.text), row.text).toBe(row.reader);
    }
  });
  it("the gap, in numbers: 13 of 14 vague shaping texts, every new data request, every general question and every unclear text go to the agent", () => {
    const toAgent = (kind: string) => ROUTES.filter((r) => r.kind.startsWith(kind) && r.route === "agent").length;
    expect(ROUTES.filter((r) => r.kind.startsWith("C")).length).toBe(14);
    expect(toAgent("C")).toBe(13);
    expect(toAgent("D")).toBe(ROUTES.filter((r) => r.kind.startsWith("D")).length);
    expect(toAgent("E")).toBe(ROUTES.filter((r) => r.kind.startsWith("E")).length);
    expect(toAgent("F")).toBe(ROUTES.filter((r) => r.kind.startsWith("F")).length);
  });
});

// ------------------------------------------------------------------------------------------------------------------------- 1. the model's call: prompt and answer
describe("the prompt carries the open result only when there is one", () => {
  const base = { balancePoints: 100, open: null };
  it("no open result: the prompt is byte-for-byte what it was (no section, no new field, no OPEN_RESULT)", () => {
    const without = buildSystemPrompt(base);
    expect(buildSystemPrompt({ ...base, openResult: undefined })).toBe(without);
    expect(without).not.toContain("OPEN_RESULT");
    expect(without).not.toContain("file_turn");
    expect(without).toContain('{"type":"...","reason":"...","reply":"...","count":null,"refers_to_open_request":false}');
  });
  it("an open result: the real column titles as data, the three values of file_turn, the JSON line carries the field", () => {
    const titles = companyColumns.map((c) => c.titleAr);
    const prompt = buildSystemPrompt({ ...base, openResult: { columns: titles } });
    expect(prompt).toContain("OPEN_RESULT: yes");
    for (const t of titles) expect(prompt).toContain(`«${t}»`);
    expect(prompt).toContain('"file_turn":null');
    expect(prompt).toContain("file_turn بالقيمة \"shape\"");
    expect(prompt).toContain("file_turn بالقيمة \"unclear\"");
    expect(prompt).toContain("file_turn بالقيمة null");
    expect(PROVIDER_NAME_PATTERN.test(openResultPromptLines(titles).join("\n"))).toBe(false);
  });
  it("an empty column list adds nothing; more than 60 columns are cut at 60", () => {
    expect(buildSystemPrompt({ ...base, openResult: { columns: [] } })).toBe(buildSystemPrompt(base));
    const many = Array.from({ length: 80 }, (_, i) => `عمود${i}`);
    const prompt = buildSystemPrompt({ ...base, openResult: { columns: many } });
    expect(prompt).toContain("«عمود59»");
    expect(prompt).not.toContain("«عمود60»");
  });
});

describe("parseModelAnswer reads file_turn", () => {
  const line = (extra: Record<string, unknown>) => JSON.stringify({ type: "other", reason: "r", reply: "", count: null, ...extra });
  it("shape and unclear are read (case and spaces ignored); null, other words and other kinds are not", () => {
    expect(parseModelAnswer(line({ file_turn: "shape" }))?.file_turn).toBe("shape");
    expect(parseModelAnswer(line({ file_turn: " Unclear " }))?.file_turn).toBe("unclear");
    for (const v of [null, "", "none", "sort", 5, true, ["shape"], {}]) expect(parseModelAnswer(line({ file_turn: v }))?.file_turn, JSON.stringify(v)).toBeUndefined();
    expect(parseModelAnswer(line({}))?.file_turn).toBeUndefined();
  });
  it("a reply cut after its type still routes (no file_turn then)", () => {
    expect(parseModelAnswer('{"type":"data_request","rea')).toMatchObject({ type: "data_request" });
  });
});

function scripted(answer: Record<string, unknown> | "fail" | "garbage", usage = { inputTokens: 700, outputTokens: 40 }): ChatModelCall & ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    if (answer === "fail") return { ok: false as const, failure: "http_529" };
    if (answer === "garbage") return { ok: true as const, text: "عذرًا، لا أستطيع." };
    return { ok: true as const, text: JSON.stringify({ type: "other", reason: "r", reply: "", count: null, ...answer }), usage };
  }) as any;
}
const ctx = { message: "رتبهم زي ما تحب", balancePoints: 100, open: null };
const withResult = { openResult: { columns: companyColumns.map((c) => c.titleAr) } };

describe("decideTurn: the file turn of the decision", () => {
  it("with an open result: shape / unclear are carried, with the tokens of the call", async () => {
    const d1 = await decideTurn({ ...ctx, ...withResult }, scripted({ file_turn: "shape" }));
    expect(d1).toMatchObject({ source: "model", fileTurn: "shape", usage: { inputTokens: 700, outputTokens: 40 } });
    const d2 = await decideTurn({ ...ctx, ...withResult }, scripted({ file_turn: "unclear" }));
    expect(d2.fileTurn).toBe("unclear");
  });
  it("without an open result the field is never asked and never read: the decision is exactly what it was (no fileTurn, no usage key)", async () => {
    const d = await decideTurn(ctx, scripted({ file_turn: "shape" }));
    expect(d.fileTurn).toBeUndefined();
    expect("usage" in d).toBe(false);
    expect(d.type).toBe("other");
  });
  it("only the types without a handling of their own may be a file turn: a greeting, an account question, a methodology request never are", async () => {
    for (const type of ["data_request", "other", "service_question"]) {
      expect((await decideTurn({ ...ctx, ...withResult }, scripted({ type, file_turn: "shape", reply: "ديجر خدمة" }))).fileTurn, type).toBe("shape");
    }
    for (const type of ["greeting_or_small_talk", "account_question", "trust_question", "methodology_request"]) {
      expect((await decideTurn({ ...ctx, ...withResult }, scripted({ type, file_turn: "shape", account_topic: "name", reply: "أهلًا" }))).fileTurn, type).toBeUndefined();
    }
  });
  it("a model that fails or answers with garbage says nothing about the file (the keyword fallback, source «keyword»)", async () => {
    for (const bad of ["fail", "garbage"] as const) {
      const d = await decideTurn({ ...ctx, ...withResult }, scripted(bad));
      expect(d.source).toBe("keyword");
      expect(d.fileTurn).toBeUndefined();
    }
  });
  it("an unknown value of file_turn is ignored; a call is made once for a readable answer", async () => {
    const model = scripted({ file_turn: "sort_it" });
    const d = await decideTurn({ ...ctx, ...withResult }, model);
    expect(d.fileTurn).toBeUndefined();
    expect(model).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------- 2. who decides
describe("routeFileTurn: the model decides when it was asked and answered; the reader answers otherwise", () => {
  it("every combination", () => {
    for (const reader of [false, true]) {
      expect(routeFileTurn({ readerSaysShaping: reader, decision: null })).toEqual({ shaping: reader, unclear: false, by: "reader" });
      expect(routeFileTurn({ readerSaysShaping: reader, decision: { source: "keyword" } })).toEqual({ shaping: reader, unclear: false, by: "reader" });
      expect(routeFileTurn({ readerSaysShaping: reader, decision: { source: "model", fileTurn: "shape" } })).toEqual({ shaping: true, unclear: false, by: "model" });
      expect(routeFileTurn({ readerSaysShaping: reader, decision: { source: "model", fileTurn: "unclear" } })).toEqual({ shaping: true, unclear: true, by: "model" });
      expect(routeFileTurn({ readerSaysShaping: reader, decision: { source: "model" } })).toEqual({ shaping: false, unclear: false, by: "model" });
    }
  });
  it("f) oracle: a model that agrees with today's routing on every one of the 56 measured messages routes every one exactly as before", () => {
    for (const row of ROUTES) {
      const today = row.route !== "agent";
      const decision = { source: "model", ...(today ? { fileTurn: "shape" as const } : {}) };
      expect(routeFileTurn({ readerSaysShaping: today, decision }).shaping, row.text).toBe(today);
    }
  });
  it("g) oracle: a model that fails, times out or returns garbage routes every one of the 56 as before (the reader)", () => {
    for (const row of ROUTES) expect(routeFileTurn({ readerSaysShaping: row.route !== "agent", decision: { source: "keyword" } }).shaping, row.text).toBe(row.route !== "agent");
  });
});

// ------------------------------------------------------------------------------------------------------------------------- 3. the question for an unclear file request
describe("unclearShapeOptions: built from the REAL columns, each read by the code that answers it", () => {
  const sets: Array<[string, DatasetColumn[]]> = [
    ["companies", companyColumns],
    ["posts", columnsOf([{ username: "a", text: "hello", likes: 5, comments: 2, created_at: "2026-01-01", url: "https://x.example/1" }], "posts")],
    ["titles with spaces and English", [{ key: "company_name", titleAr: "اسم الشركة" }, { key: "city", titleAr: "المدينة" }, { key: "likes", titleAr: "Likes" }, { key: "phone", titleAr: "رقم الهاتف" }]],
    ["duplicate titles", [{ key: "a", titleAr: "الاسم" }, { key: "b", titleAr: "الاسم" }, { key: "c", titleAr: "المدينة" }]],
  ];
  for (const [name, cols] of sets) {
    it(`${name}: 2 to 4 options, every one is read into a spec that validates against the real columns, none is a plan`, () => {
      const options = unclearShapeOptions(cols);
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options.length).toBeLessThanOrEqual(4);
      expect(new Set(options).size).toBe(options.length);
      for (const option of options) {
        const spec = deterministicShapeSpec(option, cols);
        expect(spec, option).not.toBeNull();
        expect(validateFileSpec(spec, cols).ok, option).toBe(true);
        const answered = resolveShapeAnswer({ questionId: SHAPE_CHOICE_QUESTION_ID, value: option, columns: cols });
        expect(answered.ok, option).toBe(true);
        expect(shapeAnswerFromMessage(JSON.stringify({ type: "clarification_answers", answers: [{ questionId: SHAPE_CHOICE_QUESTION_ID, question: "؟", value: option }] }))).toEqual({ questionId: SHAPE_CHOICE_QUESTION_ID, value: option });
      }
    });
  }
  it("fewer than two usable options → no card, a plain sentence", () => {
    const one = [{ key: "phone", titleAr: "الهاتف" }]; // a contact column is never split by: one sort option only
    const reply = buildUnclearShapeReply({ columns: one, previousAssistantText: null });
    expect(reply.kind).toBe("answer");
    expect(buildUnclearShapeReply({ columns: [], previousAssistantText: null }).kind).toBe("answer");
  });
  it("one card; asked again right after it (the previous message of the assistant is this card) → a plain sentence, never a second card", () => {
    const first = buildUnclearShapeReply({ columns: companyColumns, previousAssistantText: null });
    expect(first.kind).toBe("question");
    if (first.kind !== "question") return;
    expect(first.item.id).toBe(SHAPE_CHOICE_QUESTION_ID);
    expect(first.item.options.length).toBeGreaterThanOrEqual(2);
    expect(first.finalContentAr).toBe(SHAPE_UNCLEAR_AR);
    expect(first.output.type).toBe("ask_clarification");
    const again = buildUnclearShapeReply({ columns: companyColumns, previousAssistantText: `${SHAPE_UNCLEAR_AR}` });
    expect(again).toEqual({ kind: "answer", finalContentAr: SHAPE_UNCLEAR_AGAIN_AR, output: { type: "answer_question", answerAr: SHAPE_UNCLEAR_AGAIN_AR } });
    expect(buildUnclearShapeReply({ columns: companyColumns, previousAssistantText: "أي رسالة أخرى" }).kind).toBe("question");
  });
  it("a typed answer or a wrong option is not read as a choice (the answer fails, never guesses)", () => {
    expect(resolveShapeAnswer({ questionId: SHAPE_CHOICE_QUESTION_ID, value: "أي كلام", columns: companyColumns }).ok).toBe(false);
    expect(resolveShapeAnswer({ questionId: SHAPE_CHOICE_QUESTION_ID, value: "", columns: companyColumns }).ok).toBe(false);
    expect(resolveShapeAnswer({ questionId: SHAPE_CHOICE_QUESTION_ID, value: "رتب الملف حسب المحافظة", columns: companyColumns }).ok).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------- 4. the turn is prepared once and handed on
describe("prepareAgentTurn: one decision per turn, reused by the agent's turn", () => {
  const USER = "u1";
  function world() {
    const db: any = createMemoryDb();
    db.seed("conversations", [{ id: "conv1", user_id: USER, title: "x", status: "active" }]);
    db.seed("profiles", [{ id: USER, email: "a@example.com" }]);
    db.seed("credit_ledger", [{ user_id: USER, delta: 5000 }]);
    for (const t of ["plans_quotes", "jobs", "missions", "messages"]) db.seed(t, []);
    return db;
  }
  const input = (db: any, message: string) => ({ sb: db, userId: USER, conversationId: "conv1", userMsgId: "um1", assistantMsgId: "am1", message });
  it("the chat's own button messages and a typed approval need no decision (null, no call)", async () => {
    const model = scripted({ type: "data_request" });
    setChatModelForTesting(model);
    for (const text of ["اعتمد", "حاول مرة أخرى بنفس الخطة", "راجع الخطة"]) if (turnNeedsNoDecision(text)) expect(await prepareAgentTurn(input(world(), text))).toBeNull();
    expect(turnNeedsNoDecision("رتب الملف حسب المدينة")).toBe(false);
  });
  it("a prepared turn is not decided again: the agent's turn makes NO second call", async () => {
    const db = world();
    const model = scripted({ type: "data_request", file_turn: null });
    setChatModelForTesting(model);
    const prepared = await prepareAgentTurn(input(db, "عايز ٥٠ شركة مقاولات في مصر"), withResult.openResult);
    expect(prepared?.decision).toMatchObject({ type: "data_request", source: "model" });
    expect(model).toHaveBeenCalledTimes(1);
    const result = await agentChatTurn({ ...input(db, "عايز ٥٠ شركة مقاولات في مصر"), prepared });
    expect(result.ok).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    expect(db.rows("missions")).toHaveLength(1);
  });
  it("not prepared: the agent's turn decides once, as before", async () => {
    const db = world();
    const model = scripted({ type: "data_request" });
    setChatModelForTesting(model);
    const result = await agentChatTurn(input(db, "عايز ٥٠ شركة مقاولات في مصر"));
    expect(result.ok).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
  });
});
