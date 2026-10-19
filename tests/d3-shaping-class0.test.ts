import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { deterministicShapeSpec, validateFileSpec, type DatasetColumn } from "../src/lib/fileSpec";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { createChatDb } from "./helpers/chatSession";

/** The columns a delivered company file really has, built the way loadLatestResultColumns builds them. */
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
  return (normalized.columns || []).slice(0, 60).map((key: string) => ({
    key,
    titleAr: normalized.codebook?.find((c: any) => c.field === key)?.titleAr || key,
  }));
}

const columns = deliveredCompanyColumns();

describe("Class 0: a sort, a filter with an operator and a column choice are read by code", () => {
  it("a sort names a real column, with the direction the customer said", () => {
    expect(deterministicShapeSpec("رتب الملف حسب المدينة", columns)).toEqual({ version: 1, sortBy: [{ column: "city", direction: "asc" }] });
    expect(deterministicShapeSpec("رتب النتائج حسب المدينة تنازلياً", columns)).toEqual({ version: 1, sortBy: [{ column: "city", direction: "desc" }] });
    expect(deterministicShapeSpec("رتبها حسب اسم الشركة تصاعدي", columns)).toEqual({ version: 1, sortBy: [{ column: "company_name", direction: "asc" }] });
    expect(deterministicShapeSpec("رتب الشيت حسب المدينة", columns)!.sortBy).toBeDefined();
  });

  it("the plural ending and the article do not hide a column", () => {
    const cols: DatasetColumn[] = [{ key: "followers", titleAr: "المتابعون" }];
    expect(deterministicShapeSpec("رتب النتائج حسب المتابعين تنازلياً", cols)).toEqual({ version: 1, sortBy: [{ column: "followers", direction: "desc" }] });
  });

  it("a column the file does not have keeps the customer's word, which validation turns into the column question", () => {
    const spec = deterministicShapeSpec("رتب الملف حسب المحافظة", columns)!;
    expect(spec.sortBy![0].column).toBe("المحافظة");
    expect(validateFileSpec(spec, columns).ok).toBe(false);
  });

  it("a filter needs an explicit operator word; a bare value is ambiguous and stays with the model", () => {
    expect(deterministicShapeSpec("فلتر الملف على المدينة يساوي القاهرة", columns)).toEqual({ version: 1, filters: [{ column: "city", op: "equals", value: "القاهرة" }] });
    expect(deterministicShapeSpec("فلتر النتائج على اسم الشركة يحتوي Nile", columns)).toEqual({ version: 1, filters: [{ column: "company_name", op: "contains", value: "Nile" }] });
    expect(deterministicShapeSpec("فلتر النتائج على القاهرة", columns)).toBeNull();
    expect(deterministicShapeSpec("فلتر النتائج لتشمل فقط الحسابات الموثقة", columns)).toBeNull();
  });

  it("a numeric filter needs a number", () => {
    const cols: DatasetColumn[] = [{ key: "followers", titleAr: "المتابعين" }];
    expect(deterministicShapeSpec("فلتر الملف على المتابعين أكبر من ١٠٠٠", cols)).toEqual({ version: 1, filters: [{ column: "followers", op: "gt", value: 1000 }] });
    expect(deterministicShapeSpec("فلتر الملف على المتابعين أكبر من كتير", cols)).toBeNull();
  });

  it("a column choice keeps the named columns, in the order said", () => {
    expect(deterministicShapeSpec("سيب الأعمدة اسم الشركة والمدينة والهاتف فقط", columns)).toEqual({ version: 1, columns: ["company_name", "city", "phone"] });
    expect(deterministicShapeSpec("اعرض الأعمدة اسم الشركة، المدينة", columns)).toEqual({ version: 1, columns: ["company_name", "city"] });
  });

  it("a compound request or anything that is not one step is left to the model", () => {
    expect(deterministicShapeSpec("قسّم الملف حسب المدينة ورتبه حسب الاسم", columns)).toBeNull();
    expect(deterministicShapeSpec("رتب الملف حسب المدينة وفلتر على مصر", columns)).toBeNull();
    expect(deterministicShapeSpec("عايز ٥ شركات كهرباء في مصر", columns)).toBeNull();
  });
});

describe("chat turns about the delivered file", () => {
  async function session() {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    await db.createRow({ tableId: "conversations", rowId: "c_d3", data: { userId: "u_d3", title: "x", status: "active", totalTokens: 0 } });
    const executeTurn = vi.fn(async () => {
      throw new Error("the model must not be called for a one-step shaping request");
    });
    (handler as any).llm.executeTurn = executeTurn;
    const send = (message: string) => handler.handleUserMessage({ userId: "u_d3", conversationId: "c_d3", message, userBalance: 5000, resultColumns: columns });
    return { db, handler, executeTurn, send };
  }

  const usageOf = (db: ReturnType<typeof createChatDb>) => (db.store.get("llm_usage") || []) as any[];

  for (const [name, text, expected] of [
    ["sort", "رتب النتائج حسب المدينة تنازلياً", { sortBy: [{ column: "city", direction: "desc" }] }],
    ["filter", "فلتر الملف على المدينة يساوي القاهرة", { filters: [{ column: "city", op: "equals", value: "القاهرة" }] }],
    ["column choice", "سيب الأعمدة اسم الشركة والمدينة فقط", { columns: ["company_name", "city"] }],
  ] as Array<[string, string, Record<string, unknown>]>) {
    it(`${name}: a spec at once, no model call, no ledger, one usage row with zero tokens`, async () => {
      const { db, executeTurn, send } = await session();
      const res: any = await send(text);
      expect(executeTurn).not.toHaveBeenCalled();
      expect(res.outputType).toBe("answer_question");
      expect(res.fileShape.spec).toMatchObject(expected);
      expect(res.planQuote).toBeUndefined();
      expect(res.revisionQuote).toBeUndefined();
      expect(res.contentAr).toContain("لا يُخصم أي رصيد");
      expect(res.tokensUsed).toEqual({ input: 0, output: 0, costUsd: 0 });
      expect(usageOf(db)).toHaveLength(1);
      expect(usageOf(db)[0]).toMatchObject({ model: "deterministic", inputTokens: 0, outputTokens: 0, costUsd: 0 });
      expect(db.store.get("credit_ledger") || []).toHaveLength(0);
    });
  }

  it("a sort by a column the file does not have asks ONE question naming the real columns; the answer completes the sort, direction kept", async () => {
    const { handler, executeTurn, send } = await session();
    const res: any = await send("رتب الملف حسب المحافظة تنازلياً");
    expect(executeTurn).not.toHaveBeenCalled();
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationItems).toHaveLength(1);
    expect(res.clarificationItems[0].id).toBe("shape_sort_desc_required");
    expect(res.clarificationItems[0].options).toContain("المدينة");
    expect(res.contentAr).toContain("لن يُخصم أي رصيد");
    const answer = JSON.stringify({ type: "clarification_answers", answers: [{ questionId: "shape_sort_desc_required", question: "بأي عمود تريد ترتيب الملف؟", value: "المدينة" }] });
    // The answer turn is resolved by code too: the chosen option plus the direction carried by the question id.
    const seen: string[] = [];
    (handler as any).llm.executeTurn = async (opts: any) => {
      seen.push(opts.messages.at(-1).content);
      return { output: { type: "shape_file", replyAr: "تمام", spec: { sortBy: [{ column: "المدينة", direction: "desc" }] } }, inputTokens: 500, outputTokens: 30, costUsd: 0.0005, model: "claude-haiku-5-5", promptVersion: "t" };
    };
    const sorted: any = await send(answer);
    expect(seen).toEqual([]);
    expect(sorted.fileShape.spec.sortBy).toEqual([{ column: "city", direction: "desc" }]);
  });

  it("an unknown column in a filter or a column choice is answered with the real columns, no model call", async () => {
    const { executeTurn, send } = await session();
    const filtered: any = await send("فلتر الملف على المحافظة يساوي القاهرة");
    expect(filtered.contentAr).toContain("«المحافظة»");
    expect(filtered.contentAr).toContain("الأعمدة المتاحة");
    expect(filtered.fileShape).toBeUndefined();
    const picked: any = await send("سيب الأعمدة الاسم والمحافظة فقط");
    expect(picked.contentAr).toContain("الأعمدة المتاحة");
    expect(picked.fileShape).toBeUndefined();
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("a compound request is the model's: one turn, whose spec the code validates", async () => {
    const { handler, send } = await session();
    const seen = vi.fn(async () => ({ output: { type: "shape_file", replyAr: "تمام", spec: { groupBy: { column: "المدينة" }, sortBy: [{ column: "اسم الشركة", direction: "asc" }] } }, inputTokens: 500, outputTokens: 30, costUsd: 0.0005, model: "claude-haiku-5-5", promptVersion: "t" }));
    (handler as any).llm.executeTurn = seen;
    const res: any = await send("قسّم الملف حسب المدينة ورتبه حسب اسم الشركة");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(res.fileShape.spec).toMatchObject({ groupBy: { column: "city" }, sortBy: [{ column: "company_name", direction: "asc" }] });
  });

  it("a model-written sort, filter or column choice through edit_artifact becomes file shaping: free, no revision card", async () => {
    for (const [action, parameters, expected] of [
      ["sort", { field: "المدينة", direction: "desc" }, { sortBy: [{ column: "city", direction: "desc" }] }],
      ["select_columns", { columns: ["اسم الشركة", "المدينة"] }, { columns: ["company_name", "city"] }],
      ["filter", { field: "المدينة", operator: "equals", value: "القاهرة" }, { filters: [{ column: "city", op: "equals", value: "القاهرة" }] }],
    ] as Array<[string, Record<string, unknown>, Record<string, unknown>]>) {
      const { handler, send } = await session();
      (handler as any).llm.executeTurn = vi.fn(async () => ({ output: { type: "edit_artifact", action, parameters, reasonAr: "تعديل" }, inputTokens: 500, outputTokens: 30, costUsd: 0.0005, model: "claude-haiku-5-5", promptVersion: "t" }));
      const res: any = await send("ممكن تعدل الملف شوية");
      expect(res.revisionQuote).toBeUndefined();
      expect(res.fileShape.spec).toMatchObject(expected);
      expect(res.contentAr).not.toMatch(/نقاط|١٠|10/);
    }
  });

  it("any other model-written edit is answered plainly: not available now, shaping is free; no price, no card", async () => {
    const { handler, send } = await session();
    (handler as any).llm.executeTurn = vi.fn(async () => ({ output: { type: "edit_artifact", action: "dedupe", parameters: {}, reasonAr: "حذف التكرار" }, inputTokens: 500, outputTokens: 30, costUsd: 0.0005, model: "claude-haiku-5-5", promptVersion: "t" }));
    const res: any = await send("ممكن تحذف التكرار");
    expect(res.revisionQuote).toBeUndefined();
    expect(res.outputType).toBe("answer_question");
    expect(res.contentAr).toContain("غير متاح الآن");
    expect(res.contentAr).toContain("فمجاني");
    expect(res.contentAr).not.toMatch(/نقاط|purchase|atomic|[A-Za-z]{4,}/);
  });
});

describe("the retired paid-revision card", () => {
  it("the chat page no longer renders the card or applies a revision", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).not.toContain("RevisionQuoteCard");
    expect(page).not.toContain("handleApplyRevisionQuote");
  });

  it("the system prompt no longer offers sort, filter or column choice as a paid edit", () => {
    const prompt = readFileSync("src/functions/shared/systemPrompt.ts", "utf8");
    expect(prompt).not.toContain('"action": "filter"|"sort"|"select_columns"|"dedupe"');
  });

  it("the artifacts route's 409 text is plain Arabic with no internal name and no platform wording", () => {
    const route = readFileSync("src/app/api/jobs/[id]/artifacts/route.ts", "utf8");
    expect(route).not.toContain("purchase_revision_atomic");
    expect(route).not.toContain("إدارة المنصة");
    expect(route).toContain("هذا التعديل غير متاح الآن");
    expect(route).toContain("revision_charging_pending_owner_approval");
  });
});
