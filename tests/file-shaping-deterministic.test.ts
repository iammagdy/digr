import { describe, it, expect, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { deterministicShapeSpec, resolveGroupColumn, shapingGroupName, validateFileSpec, type DatasetColumn } from "../src/lib/fileSpec";
import { columnChoicesAr } from "../src/lib/server/savedResultColumns";
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

describe("«sheet per X» is read by code against the real columns", () => {
  const columns = deliveredCompanyColumns();

  it("the delivered file has a city column and no governorate column (premise of the QA failures)", () => {
    expect(columns.map((c) => c.key)).toContain("city");
    expect(columns.map((c) => c.key)).not.toContain("governorate");
    expect(columns.map((c) => c.key)).toContain("phone");
  });

  it("shapingGroupName reads the named column and ignores everything else", () => {
    expect(shapingGroupName("قسّم الملف شيت لكل مدينة")).toBe("مدينة");
    expect(shapingGroupName("قسّم الملف شيت لكل محافظة")).toBe("محافظة");
    expect(shapingGroupName("اعمل شيت لكل محافظة لو سمحت")).toBe("محافظة");
    expect(shapingGroupName("قسم الملف حسب مجال النشاط")).toBe("مجال النشاط");
    expect(shapingGroupName("رتب الملف حسب التاريخ")).toBeNull();
    expect(shapingGroupName("قسّم الملف شيت لكل مدينة ورتبها حسب الاسم")).toBeNull();
    expect(shapingGroupName("فلتر الملف على مصر")).toBeNull();
    expect(shapingGroupName("عايز ٥ شركات كهرباء في مصر")).toBeNull();
    expect(shapingGroupName("")).toBeNull();
  });

  it("a word that names a real column gives a spec with that column's real key", () => {
    expect(deterministicShapeSpec("قسّم الملف شيت لكل مدينة", columns)).toEqual({ version: 1, groupBy: { column: "city", mode: "sheets" } });
    expect(deterministicShapeSpec("قسّم الملف شيت لكل المدن", columns)).toEqual({ version: 1, groupBy: { column: "city", mode: "sheets" } });
    expect(deterministicShapeSpec("قسّم الملف شيت لكل المدينة", columns)).toEqual({ version: 1, groupBy: { column: "city", mode: "sheets" } });
    expect(deterministicShapeSpec("قسّم الملف حسب مجال النشاط", columns)).toEqual({ version: 1, groupBy: { column: "industry", mode: "sheets" } });
    expect(deterministicShapeSpec("قسّم الملف حسب النشاط", columns)).toEqual({ version: 1, groupBy: { column: "industry", mode: "sheets" } });
    expect(resolveGroupColumn("مدينة", columns)?.key).toBe("city");
    // never the phone column for a city request
    expect(deterministicShapeSpec("قسّم الملف شيت لكل مدينة", columns)!.groupBy!.column).not.toBe("phone");
  });

  it("a word with no such column keeps the customer's own word, which validation turns into the column question", () => {
    const spec = deterministicShapeSpec("قسّم الملف شيت لكل محافظة", columns)!;
    expect(spec).toEqual({ version: 1, groupBy: { column: "محافظة", mode: "sheets" } });
    const checked = validateFileSpec(spec, columns);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errorAr).toContain("«محافظة»");
  });

  it("a sort or a column choice is read by code too; a compound request gives nothing, so the model keeps it", () => {
    expect(deterministicShapeSpec("رتّب الملف حسب اسم الشركة", columns)).toEqual({ version: 1, sortBy: [{ column: "company_name", direction: "asc" }] });
    expect(deterministicShapeSpec("سيب بس الأعمدة اسم الشركة والهاتف", columns)).toEqual({ version: 1, columns: ["company_name", "phone"] });
    expect(deterministicShapeSpec("قسّم الملف شيت لكل مدينة ورتبها حسب الاسم", columns)).toBeNull();
  });

  it("the choices offered for a split leave out contact, link, id and status columns; the default list is unchanged", () => {
    const grouping = columnChoicesAr(columns, 60, true);
    for (const key of ["phone", "work_email", "website", "linkedin_url"]) {
      const title = columns.find((c) => c.key === key)?.titleAr;
      if (title) expect(grouping).not.toContain(title);
    }
    expect(grouping).toContain("اسم الشركة");
    expect(grouping).toContain("المدينة");
    expect(grouping.some((title) => /توفر|حالة التحقق/.test(title))).toBe(false);
    const all = columnChoicesAr(columns, 60);
    expect(all).toContain(columns.find((c) => c.key === "phone")!.titleAr);
    expect(all.length).toBeGreaterThan(grouping.length);
  });
});

describe("chat turn about the delivered file: no model call for a split", () => {
  const columns = deliveredCompanyColumns();

  async function session() {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    await db.createRow({ tableId: "conversations", rowId: "c_det", data: { userId: "u_det", title: "x", status: "active", totalTokens: 0 } });
    const executeTurn = vi.fn(async () => {
      throw new Error("the model must not be called for a split of a delivered file");
    });
    (handler as any).llm.executeTurn = executeTurn;
    const send = (message: string) => handler.handleUserMessage({ userId: "u_det", conversationId: "c_det", message, userBalance: 5000, resultColumns: columns });
    return { db, handler, executeTurn, send };
  }

  it("«قسّم الملف شيت لكل مدينة» builds the file spec at once from the city column; zero tokens, no quote, no charge", async () => {
    const { db, executeTurn, send } = await session();
    const res: any = await send("قسّم الملف شيت لكل مدينة");
    expect(executeTurn).not.toHaveBeenCalled();
    expect(res.outputType).toBe("answer_question");
    expect(res.fileShape.spec.groupBy).toEqual({ column: "city", mode: "sheets" });
    expect(res.planQuote).toBeUndefined();
    expect(res.revisionQuote).toBeUndefined();
    expect(res.contentAr).toContain("تحميل الملف المخصص");
    expect(res.contentAr).toContain("لا يُخصم أي رصيد");
    expect(res.contentAr).not.toContain("المساعد غير متاح");
    expect(res.tokensUsed).toEqual({ input: 0, output: 0, costUsd: 0 });
    const usage = (db.store.get("llm_usage") || []) as any[];
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: "deterministic", inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it("«قسّم الملف شيت لكل محافظة» (no such column) asks ONE question naming real columns; no model call", async () => {
    const { executeTurn, send } = await session();
    const res: any = await send("قسّم الملف شيت لكل محافظة");
    expect(executeTurn).not.toHaveBeenCalled();
    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.contentAr).toContain("لا أجد في بياناتك: «محافظة»");
    expect(res.contentAr).toContain("لن يُخصم أي رصيد");
    expect(res.contentAr).not.toContain("المساعد غير متاح");
    expect(res.clarificationItems).toHaveLength(1);
    expect(res.clarificationItems[0].id).toBe("shape_column_required");
    const options: string[] = res.clarificationItems[0].options;
    expect(options).toEqual(expect.arrayContaining(["اسم الشركة", "المدينة", "مجال النشاط"]));
    const contactTitles = columns.filter((c) => /^(?:phone|work_email|website|linkedin_url)$/.test(c.key)).map((c) => c.titleAr);
    for (const title of contactTitles) expect(options).not.toContain(title);
    expect(options.length).toBeLessThanOrEqual(8);
  });

  it("a sort is read by code (no model call); a card answer to the column question is resolved by code too (no model call)", async () => {
    const { executeTurn, send, handler } = await session();
    const seen: string[] = [];
    (handler as any).llm.executeTurn = async (opts: any) => {
      seen.push(opts.messages.at(-1).content);
      return { output: { type: "shape_file", replyAr: "تمام", spec: { sortBy: [{ column: "المدينة", direction: "asc" }] } }, inputTokens: 500, outputTokens: 30, costUsd: 0.0005, model: "claude-haiku-5-5", promptVersion: "t" };
    };
    const sorted: any = await send("رتّب الملف حسب المدينة");
    expect(seen).toHaveLength(0);
    expect(sorted.fileShape.spec.sortBy).toEqual([{ column: "city", direction: "asc" }]);
    const answer = JSON.stringify({ type: "clarification_answers", answers: [{ questionId: "shape_column_required", question: "بأي عمود تريد تقسيم الملف إلى شيتات؟", value: "المدينة" }] });
    const answered: any = await send(answer);
    expect(seen).toHaveLength(0);
    expect(answered.fileShape.spec.groupBy).toEqual({ column: "city", mode: "sheets" });
    expect(executeTurn).not.toHaveBeenCalled();
  });
});
