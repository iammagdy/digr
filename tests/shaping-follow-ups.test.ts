import { describe, it, expect, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { SHAPE_QUESTION_IDS, resolveGroupColumn, resolveShapeAnswer, shapeAnswerFromMessage, type DatasetColumn } from "../src/lib/fileSpec";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { createChatDb } from "./helpers/chatSession";

/** The columns a delivered company file really has, built the way loadLatestResultColumns builds them. */
function deliveredCompanyColumns(): DatasetColumn[] {
  const normalized: any = normalizeDataset(
    {
      rows: [
        { company_name: "Nile Energy", industry: "Utilities", website: "https://nile.example", location: "Cairo, Egypt", phone: "+20 100 000 0000", work_email: "info@nile.example", description: "Electricity distribution", contact_name: "Mona Saleh" },
        { company_name: "Delta Power", industry: "Utilities", website: "https://delta.example", location: "Alexandria, Egypt", phone: "+20 100 000 0001", work_email: "info@delta.example", description: "Power plants", contact_name: "Omar Adel" },
      ],
      metadata: { country: "Egypt", entityType: "companies" },
    },
    { title: "شركات" },
  );
  return (normalized.columns || []).slice(0, 60).map((key: string) => ({
    key,
    titleAr: normalized.codebook?.find((c: any) => c.field === key)?.titleAr || key,
  }));
}

const columns = deliveredCompanyColumns();
const planFromModel = { type: "propose_plan", summaryAr: "خطة جديدة", capabilities: [{ stepId: "plan_step_1", capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", params: { query: { location: { include: ["Egypt"] } } }, targetVolumeMin: 1, targetVolumeMax: 2 }], outputFormats: ["xlsx"] };

/** The unknown-column request that raises each question, and what its answer must build. */
const CASES: Array<{ id: string; request: string; expect: (key: string) => Record<string, unknown> }> = [
  { id: "shape_column_required", request: "قسّم الملف شيت لكل محافظة", expect: (key) => ({ groupBy: { column: key, mode: "sheets" } }) },
  { id: "shape_sort_asc_required", request: "رتب الملف حسب المحافظة", expect: (key) => ({ sortBy: [{ column: key, direction: "asc" }] }) },
  { id: "shape_sort_desc_required", request: "رتب الملف حسب المحافظة تنازلياً", expect: (key) => ({ sortBy: [{ column: key, direction: "desc" }] }) },
  { id: "shape_filter_column_required", request: "فلتر الملف على المحافظة يساوي القاهرة", expect: (key) => ({ filters: [{ column: key, op: "equals", value: "القاهرة" }] }) },
  { id: "shape_columns_required", request: "سيب الأعمدة اسم الشركة والمحافظة فقط", expect: (key) => ({ columns: [...new Set(["company_name", key])] }) },
];

async function session() {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  await db.createRow({ tableId: "conversations", rowId: "c_shape", data: { userId: "u_shape", title: "x", status: "active", totalTokens: 0 } });
  const model = vi.fn(async () => ({ output: planFromModel, inputTokens: 900, outputTokens: 80, costUsd: 0.001, model: "claude-haiku-5-5", promptVersion: "t" }));
  (handler as any).llm.executeTurn = model;
  const send = (message: string) => handler.handleUserMessage({ userId: "u_shape", conversationId: "c_shape", message, userBalance: 5000, resultColumns: columns });
  return { db, handler, model, send };
}

const answerPayload = (questionId: string, value: string) =>
  JSON.stringify({ type: "clarification_answers", answers: [{ questionId, question: "؟", value }] });

describe("every shaping question is answered in code, by each of its options", () => {
  it("the five question ids are the ones the handler asks", () => {
    expect([...SHAPE_QUESTION_IDS].sort()).toEqual(CASES.map((c) => c.id).sort());
  });

  for (const testCase of CASES) {
    it(`${testCase.id}: each option gives the free custom file: no model call, no quote, no ledger, one usage row with zero tokens`, async () => {
      const probe = await session();
      const asked: any = await probe.send(testCase.request);
      expect(asked.outputType).toBe("ask_clarification");
      expect(asked.clarificationItems).toHaveLength(1);
      expect(asked.clarificationItems[0].id).toBe(testCase.id);
      const options: string[] = asked.clarificationItems[0].options;
      expect(options.length).toBeGreaterThanOrEqual(3);
      expect(probe.model).not.toHaveBeenCalled();

      for (const option of options) {
        const { db, model, send } = await session();
        await send(testCase.request);
        const usageBefore = ((db.store.get("llm_usage") || []) as any[]).length;
        const res: any = await send(answerPayload(testCase.id, option));
        const key = resolveGroupColumn(option, columns)!.key;
        expect(res.fileShape, option).toBeDefined();
        expect(res.fileShape.spec).toMatchObject(testCase.expect(key));
        expect(res.outputType).toBe("answer_question");
        expect(res.contentAr).toContain("جهزت لك الملف");
        expect(res.contentAr).toContain("لا يُخصم أي رصيد");
        expect(res.planQuote).toBeUndefined();
        expect(res.revisionQuote).toBeUndefined();
        expect(model, option).not.toHaveBeenCalled();
        expect(db.store.get("plans_quotes") || []).toHaveLength(0);
        expect(db.store.get("credit_ledger") || []).toHaveLength(0);
        const usage = (db.store.get("llm_usage") || []) as any[];
        expect(usage).toHaveLength(usageBefore + 1);
        expect(usage.at(-1)).toMatchObject({ model: "deterministic", inputTokens: 0, outputTokens: 0, costUsd: 0 });
      }
    });
  }
});

describe("the answer turn never yields a quote, even when the model would return a plan", () => {
  it("an answer that cannot be resolved is answered plainly, with no model call and no plan", async () => {
    const { db, model, send } = await session();
    await send("رتب الملف حسب المحافظة");
    const res: any = await send(answerPayload("shape_sort_asc_required", "عمود غير موجود"));
    expect(res.outputType).toBe("answer_question");
    expect(res.planQuote).toBeUndefined();
    expect(res.fileShape).toBeUndefined();
    expect(res.contentAr).toContain("لن يُخصم أي رصيد");
    expect(model).not.toHaveBeenCalled();
    expect(db.store.get("plans_quotes") || []).toHaveLength(0);
  });

  it("a filter answer with no earlier filter request in the history is answered plainly, never with a plan", async () => {
    const { db, model, send } = await session();
    const res: any = await send(answerPayload("shape_filter_column_required", columns.find((c) => c.key === "city")!.titleAr));
    expect(res.planQuote).toBeUndefined();
    expect(res.fileShape).toBeUndefined();
    expect(model).not.toHaveBeenCalled();
    expect(db.store.get("plans_quotes") || []).toHaveLength(0);
  });

  it("when the model would answer a shaping turn with a plan (a compound request), it is turned into a plain answer", async () => {
    const { db, model, send } = await session();
    const res: any = await send("قسّم الملف حسب المدينة ورتبه حسب اسم الشركة وفلتر على القاهرة");
    expect(model).toHaveBeenCalledTimes(1);
    expect(res.outputType).toBe("answer_question");
    expect(res.planQuote).toBeUndefined();
    expect(res.contentAr).toContain("لن يُخصم عليه أي رصيد");
    expect(db.store.get("plans_quotes") || []).toHaveLength(0);
  });
});

describe("the pure resolver", () => {
  it("reads only shaping answers from a card payload", () => {
    expect(shapeAnswerFromMessage(answerPayload("shape_sort_desc_required", "المدينة"))).toEqual({ questionId: "shape_sort_desc_required", value: "المدينة" });
    expect(shapeAnswerFromMessage(answerPayload("company_country_required", "مصر"))).toBeNull();
    expect(shapeAnswerFromMessage("رتب الملف حسب المدينة")).toBeNull();
  });

  it("a column choice with two unknown names replaces the first and reports the other", () => {
    const resolved = resolveShapeAnswer({
      questionId: "shape_columns_required",
      value: columns.find((c) => c.key === "city")!.titleAr,
      originalText: "سيب الأعمدة اسم الشركة والمحافظة والبلدية فقط",
      columns,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.spec.columns).toEqual(["company_name", "city"]);
      expect(resolved.ignored).toEqual(["البلدية"]);
    }
  });
});
