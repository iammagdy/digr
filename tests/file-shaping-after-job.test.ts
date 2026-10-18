import { describe, expect, it } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { loadLatestResultColumns, columnChoicesAr } from "../src/lib/server/savedResultColumns";
import { isStandaloneResearchRequest, scopeRequestText } from "../src/functions/shared/requestScope";
import { extractBriefFromMessage } from "../src/functions/shared/briefManager";
import { looksLikeFileShapingRequest } from "../src/lib/fileSpec";
import { createChatDb } from "./helpers/chatSession";

const SHAPE = "قسّم الملف شيت لكل محافظة";
const COMPANY_REQUEST = "عايز ٥ شركات كهرباء في مصر";
/** The columns a delivered company job exposes (key + Arabic title), without a dedicated governorate column. */
const COMPANY_COLUMNS = [
  { key: "company_name", titleAr: "اسم الشركة" }, { key: "industry", titleAr: "مجال النشاط" }, { key: "website", titleAr: "الموقع الإلكتروني" },
  { key: "location", titleAr: "المقر والنطاق الجغرافي" }, { key: "phone", titleAr: "رقم الهاتف المهني" }, { key: "description", titleAr: "نبذة عن النشاط" },
];

async function session() {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  await db.createRow({ tableId: "conversations", rowId: "c_shape", data: { userId: "u_shape", title: "x", status: "active", totalTokens: 0 } });
  const send = (message: string, resultColumns?: any[]) => handler.handleUserMessage({ userId: "u_shape", conversationId: "c_shape", message, userBalance: 5000, resultColumns });
  return { db, send, handler };
}

describe("4. «قسّم الملف شيت لكل محافظة» after a delivered job shapes the saved file", () => {
  it("is recognised as a file request and never as a research request or a pollution source", () => {
    expect(looksLikeFileShapingRequest(SHAPE)).toBe(true);
    expect(isStandaloneResearchRequest(SHAPE)).toBe(false);
    // the earlier company request is not pulled into the shaping turn's routing text...
    expect(scopeRequestText([COMPANY_REQUEST], SHAPE)).not.toContain("شركات كهرباء");
    // ...and the shaping words never become a topic
    const brief = extractBriefFromMessage(SHAPE, extractBriefFromMessage(COMPANY_REQUEST));
    expect([...brief.topics, ...(brief.keywords || [])].join(" ")).not.toMatch(/قسّم|الملف|شيت|محافظة/);
  });

  it("after a company job, the exact text triggers the file flow: no quote, no provider call, one question naming the real columns", async () => {
    const { send } = await session();
    const first = await send(COMPANY_REQUEST);
    expect(first.outputType).toBe("propose_plan");
    const res: any = await send(SHAPE, COMPANY_COLUMNS);
    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.revisionQuote).toBeUndefined();
    expect(res.contentAr).toContain("لا أجد في بياناتك: «محافظة»");
    expect(res.contentAr).toContain("لن يُخصم أي رصيد");
    expect(res.clarificationQuestions).toEqual(["بأي عمود تريد تقسيم الملف إلى شيتات؟"]);
    const options: string[] = res.clarificationItems[0].options;
    expect(options).toEqual(expect.arrayContaining(["اسم الشركة", "المقر والنطاق الجغرافي", "مجال النشاط"]));
    expect(options.every((o) => /[؀-ۿ]/.test(o))).toBe(true);
    expect(options.length).toBeLessThanOrEqual(8);
  });

  it("answering with a column builds the shaped file from the saved data", async () => {
    const { send, handler } = await session();
    await send(COMPANY_REQUEST);
    await send(SHAPE, COMPANY_COLUMNS);
    const seen: any[] = [];
    // The model sees the answer as the shaping request it completes and writes the spec from the real column title.
    (handler as any).llm.executeTurn = async (opts: any) => {
      seen.push(opts.messages.at(-1));
      return { output: { type: "shape_file", replyAr: "تمام", spec: { groupBy: { column: "المقر والنطاق الجغرافي", mode: "sheets" } } }, inputTokens: 700, outputTokens: 40, costUsd: 0.0007, model: "claude-haiku-5-5", promptVersion: "t" };
    };
    const answer = JSON.stringify({ type: "clarification_answers", answers: [{ questionId: "shape_column_required", question: "بأي عمود تريد تقسيم الملف إلى شيتات؟", value: "المقر والنطاق الجغرافي" }] });
    const res: any = await send(answer, COMPANY_COLUMNS);
    expect(seen[0].content).toBe("قسّم الملف شيت لكل المقر والنطاق الجغرافي");
    expect(res.outputType).toBe("answer_question");
    expect(res.planQuote).toBeUndefined();
    expect(res.revisionQuote).toBeUndefined();
    expect(res.fileShape.spec.groupBy).toEqual({ column: "location", mode: "sheets" });
    expect(res.contentAr).toContain("تحميل الملف المخصص");
    expect(res.contentAr).toContain("لا يُخصم أي رصيد");
  });

  it("when a governorate column does exist the file is shaped at once", async () => {
    const { send } = await session();
    await send(COMPANY_REQUEST);
    const res: any = await send(SHAPE, [...COMPANY_COLUMNS, { key: "governorate", titleAr: "المحافظة" }]);
    expect(res.outputType).toBe("answer_question");
    expect(res.fileShape.spec.groupBy).toEqual({ column: "governorate", mode: "sheets" });
    expect(res.planQuote).toBeUndefined();
  });

  it("a research request that only names a layout is still research, not a file request", async () => {
    expect(isStandaloneResearchRequest("عايز ١٠ شركات سياحة في دبي في ملف لكل مجال")).toBe(true);
  });
});

describe("4. when the page sent no columns, they come from the delivered result", () => {
  const dataset = JSON.stringify({ rows: [{ company_name: "الشركة العربية", website: "https://example.org", location: "القاهرة، مصر", industry: "كهرباء" }], metadata: {} });
  const adminWith = (jobs: any[], files: Record<string, string>) => ({
    from: (table: string) => {
      const filters: Array<[string, any]> = [];
      const b: any = {
        select: () => b, eq: (c: string, v: any) => { filters.push([c, v]); return b; }, in: () => b, order: () => b, limit: () => b,
        maybeSingle: async () => ({ data: table === "jobs" ? jobs.find((j) => filters.every(([c, v]) => j[c] === v)) ?? null : null, error: null }),
      };
      return b;
    },
    storage: { from: (bucket: string) => ({ download: async (path: string) => (files[`${bucket}/${path}`] ? { data: { text: async () => files[`${bucket}/${path}`] }, error: null } : { data: null, error: { message: "nf" } }) }) },
  });

  it("reads the latest delivered job of the conversation and returns its real columns", async () => {
    const job = { id: "job_1", user_id: "u1", conversation_id: "c1", status: "completed", template_slug: "companies", endpoint_id: "icypeas.companies.search", platform: "companies" };
    const saved = await loadLatestResultColumns(adminWith([job], { "results/u1/job_1/data.json": dataset }), { conversationId: "c1", userId: "u1" });
    expect(saved.jobId).toBe("job_1");
    expect(saved.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["company_name", "website", "location"]));
    expect(saved.columns.find((c) => c.key === "location")?.titleAr).toBe("المقر والنطاق الجغرافي");
  });

  it("reports no job, or a job whose file cannot be read, without guessing", async () => {
    expect(await loadLatestResultColumns(adminWith([], {}), { conversationId: "c1", userId: "u1" })).toEqual({ jobId: null, columns: [] });
    const job = { id: "job_2", user_id: "u1", conversation_id: "c1", status: "completed" };
    expect(await loadLatestResultColumns(adminWith([job], {}), { conversationId: "c1", userId: "u1" })).toEqual({ jobId: "job_2", columns: [] });
    expect(await loadLatestResultColumns(null, { conversationId: "c1", userId: "u1" })).toEqual({ jobId: null, columns: [] });
  });

  it("lists text-heavy columns last when offering choices", () => {
    expect(columnChoicesAr([{ key: "description", titleAr: "نبذة عن النشاط" }, { key: "location", titleAr: "المقر والنطاق الجغرافي" }], 8)).toEqual(["المقر والنطاق الجغرافي", "نبذة عن النشاط"]);
  });
});
