import { describe, it, expect, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { getJobIdForQuote } from "../src/lib/md5";
import { latestDeliveredJob } from "../src/lib/server/conversationJobs";
import { loadLatestResultColumns } from "../src/lib/server/savedResultColumns";
import { fileEditAnswerAr, unsupportedFileEdit } from "../src/lib/fileSpec";
import { createStatefulSupabase } from "./helpers/statefulSupabase";

/**
 * The conversation of the live test, with the production schema: a delivered electricity job (approved from quote Q1) and,
 * later in the same chat, a priced plan card that was never approved (quote Q2, which has no job). The page sends no
 * columns with a card answer or with these typed messages, so everything must come from the stored conversation.
 */
const rows = [
  { company_name: "Nile Energy", industry: "Utilities", website: "https://nile.example", location: "Cairo, Egypt", phone: "+20 100 000 0000", work_email: "info@nile.example", description: "Electricity distribution", contact_name: "Mona Saleh" },
  { company_name: "Delta Power", industry: "Utilities", website: "https://delta.example", location: "Alexandria, Egypt", phone: "+20 100 000 0001", work_email: "info@delta.example", description: "Power plants", contact_name: "Omar Adel" },
];
const JOB_ID = getJobIdForQuote("Q1");

function seededConversation() {
  const message = (id: string, role: string, text: string, extra: Record<string, unknown>, minute: number) => ({
    id, conversation_id: "c1", user_id: "u1", role, content_ar: text, created_at: `2026-10-19T10:${String(minute).padStart(2, "0")}:00.000Z`, ...extra,
  });
  return createStatefulSupabase({
    tables: {
      profiles: [{ id: "u1", name: "سلمى" }],
      conversations: [{ id: "c1", user_id: "u1", status: "active", brief: null, title: "شركات كهرباء" }],
      messages: [
        message("m1", "user", "عايز شركتين كهرباء في مصر", { request_quote_id: "Q1", request_status: "accepted" }, 0),
        message("m2", "assistant", "أعددت لك خطة الاستخراج وعرض السعر بالنقاط", { quote: { quoteId: "Q1", items: [] } }, 1),
        message("m3", "user", "عايز شركتين كهرباء", { request_quote_id: "Q2", request_status: "quoted" }, 30),
        message("m4", "assistant", "أعددت لك خطة الاستخراج وعرض السعر بالنقاط", { quote: { quoteId: "Q2", items: [] } }, 31),
      ],
      jobs: [{ id: JOB_ID, user_id: "u1", status: "completed", delivered_units: 2, target_volume_max: 2, template_slug: "companies", endpoint_id: "icypeas.companies.search", platform: "companies", created_at: "2026-10-19T10:05:00.000Z" }],
      plans_quotes: [{ id: "Q1", user_id: "u1", status: "accepted" }, { id: "Q2", user_id: "u1", status: "quoted" }],
      llm_usage: [],
      credit_ledger: [],
    },
    files: { [`results/u1/${JOB_ID}/data.json`]: JSON.stringify({ rows, metadata: { country: "Egypt", entityType: "companies", title: "شركات" } }) },
  });
}

function session() {
  const store = seededConversation();
  const handler = new ChatHandler(store.client as any);
  // Whatever the model would say, a turn about the file must not reach a priced flow: here it asks the country question.
  const model = vi.fn(async () => ({
    output: { type: "ask_clarification", reasonAr: "قبل إعداد الخطة أحتاج الدولة", questions: [{ id: "company_country_required", text: "ما الدولة التي تريد البحث عن الشركات فيها؟", question: "ما الدولة التي تريد البحث عن الشركات فيها؟", type: "single", options: ["مصر"] }] },
    inputTokens: 900, outputTokens: 80, costUsd: 0.001, model: "claude-haiku-5-5", promptVersion: "t",
  }));
  (handler as any).llm.executeTurn = model;
  const send = (message: string) => handler.handleUserMessage({ userId: "u1", conversationId: "c1", message, userBalance: 5000 }) as Promise<any>;
  return { store, model, send };
}

const answer = (questionId: string, value: string) => JSON.stringify({ type: "clarification_answers", answers: [{ questionId, question: "؟", value }] });
const hasCountryQuestion = (reply: any) => JSON.stringify(reply.clarificationItems || []).includes("country_required") || /ما الدولة التي/.test(reply.contentAr || "");

/** What every file turn must satisfy, in any state of the conversation. */
function expectFree(store: ReturnType<typeof seededConversation>, model: ReturnType<typeof vi.fn>, replies: any[]) {
  for (const reply of replies) {
    expect(reply.planQuote, reply.contentAr).toBeUndefined();
    expect(hasCountryQuestion(reply), reply.contentAr).toBe(false);
    expect(reply.contentAr).not.toMatch(/التكلفة المتوقعة|undefined|null/);
  }
  expect(model).not.toHaveBeenCalled();
  expect(store.rows("plans_quotes")).toHaveLength(2);
  expect(store.rows("credit_ledger")).toHaveLength(0);
  expect(store.rpcCalls).toEqual([]);
  const usage = store.rows("llm_usage");
  expect(usage).toHaveLength(replies.length);
  for (const row of usage) expect(row).toMatchObject({ model: "deterministic", tokens_in: 0, tokens_out: 0, cost_usd: 0 });
}

describe("the conversation's delivered job is found through its quotes, as in production", () => {
  it("jobs have no conversation_id: the quote-based lookup finds the delivered job and skips the unapproved quote", async () => {
    const store = seededConversation();
    const job = await latestDeliveredJob(store.client, { conversationId: "c1", userId: "u1" });
    expect(job?.id).toBe(JOB_ID);
    const saved = await loadLatestResultColumns(store.client, { conversationId: "c1", userId: "u1" });
    expect(saved.jobId).toBe(JOB_ID);
    expect(saved.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["company_name", "city", "phone"]));
  });

  it("another customer's conversation gives nothing", async () => {
    const store = seededConversation();
    expect(await latestDeliveredJob(store.client, { conversationId: "c1", userId: "someone-else" })).toBeNull();
  });
});

describe("full chains on the live conversation: free, no country question, no model, no quote", () => {
  it("«رتب الملف حسب المحافظة» -> pick an option -> the free file", async () => {
    const { store, model, send } = session();
    const asked = await send("رتب الملف حسب المحافظة");
    expect(asked.clarificationItems[0].id).toBe("shape_sort_asc_required");
    const options: string[] = asked.clarificationItems[0].options;
    const done = await send(answer("shape_sort_asc_required", options[0]));
    expect(done.fileShape.spec.sortBy).toHaveLength(1);
    expect(done.contentAr).toContain("جهزت لك الملف");
    expectFree(store, model, [asked, done]);
  });

  it("«فلتر الملف على المحافظة يساوي القاهرة» -> answer -> the free file", async () => {
    const { store, model, send } = session();
    const asked = await send("فلتر الملف على المحافظة يساوي القاهرة");
    expect(asked.clarificationItems[0].id).toBe("shape_filter_column_required");
    const done = await send(answer("shape_filter_column_required", "المدينة"));
    expect(done.fileShape.spec.filters).toEqual([{ column: "city", op: "equals", value: "القاهرة" }]);
    expectFree(store, model, [asked, done]);
  });

  it("«سيب الأعمدة الاسم والمحافظة» -> answer -> the free file", async () => {
    const { store, model, send } = session();
    const asked = await send("سيب الأعمدة الاسم والمحافظة");
    expect(asked.clarificationItems[0].id).toBe("shape_columns_required");
    const done = await send(answer("shape_columns_required", "المدينة"));
    expect(done.fileShape.spec.columns).toContain("city");
    expectFree(store, model, [asked, done]);
  });

  it("the whole sequence of the live test, one after another, never leaves the free flow", async () => {
    const { store, model, send } = session();
    const replies: any[] = [];
    replies.push(await send("رتب النتائج حسب المدينة تنازلياً"));
    replies.push(await send("رتب الملف حسب اسم الشركة"));
    replies.push(await send("فلتر الملف على المدينة يساوي القاهرة"));
    replies.push(await send("سيب الأعمدة اسم الشركة والمدينة فقط"));
    replies.push(await send("قسّم الملف شيت لكل مدينة"));
    const q1 = await send("رتب الملف حسب المحافظة"); replies.push(q1);
    replies.push(await send(answer("shape_sort_asc_required", q1.clarificationItems[0].options[0])));
    const q2 = await send("فلتر الملف على المحافظة يساوي القاهرة"); replies.push(q2);
    replies.push(await send(answer("shape_filter_column_required", q2.clarificationItems[0].options[0])));
    const q3 = await send("سيب الأعمدة الاسم والمحافظة"); replies.push(q3);
    replies.push(await send(answer("shape_columns_required", q3.clarificationItems[0].options[0])));
    replies.push(await send("احذف التكرار من الملف"));
    replies.push(await send("عدل اتجاه الشيت RTL"));
    expectFree(store, model, replies);
    expect(replies.filter((reply) => reply.fileShape)).toHaveLength(8);
  });
});

describe("edits the file does not offer are answered by code with one plain sentence", () => {
  it("«احذف التكرار من الملف»: no question, no plan; says the file has no duplicates and what is free", async () => {
    const { store, model, send } = session();
    const reply = await send("احذف التكرار من الملف");
    expect(reply.outputType).toBe("answer_question");
    expect(reply.contentAr).toBe(fileEditAnswerAr("dedupe"));
    expect(reply.contentAr).toContain("دون سجلات مكررة أصلًا");
    expect(reply.contentAr).toContain("غير متاح الآن");
    expect(reply.contentAr).toContain("فمجاني");
    expectFree(store, model, [reply]);
  });

  it("«عدل اتجاه الشيت RTL»: the same, and no English word reaches the customer", async () => {
    const { store, model, send } = session();
    const reply = await send("عدل اتجاه الشيت RTL");
    expect(reply.outputType).toBe("answer_question");
    expect(reply.contentAr).toBe(fileEditAnswerAr("direction"));
    expect(reply.contentAr).not.toMatch(/[A-Za-z]/);
    expectFree(store, model, [reply]);
  });

  it("anonymize and an export request get the generic sentence", async () => {
    const { store, model, send } = session();
    const anonymize = await send("اخف أسماء جهات الاتصال في الملف");
    const exported = await send("حول الملف إلى PDF");
    expect(anonymize.contentAr).toBe(fileEditAnswerAr("anonymize"));
    expect(exported.contentAr).toBe(fileEditAnswerAr("export"));
    expectFree(store, model, [anonymize, exported]);
  });

  it("the detector recognises each edit and not a research request", () => {
    expect(unsupportedFileEdit("احذف التكرار من الملف")).toBe("dedupe");
    expect(unsupportedFileEdit("عدل اتجاه الشيت RTL")).toBe("direction");
    expect(unsupportedFileEdit("اخف أسماء جهات الاتصال")).toBe("anonymize");
    expect(unsupportedFileEdit("حول الملف إلى PDF")).toBe("export");
    expect(unsupportedFileEdit("عايز ٥ شركات كهرباء في مصر")).toBeNull();
    expect(unsupportedFileEdit("هات ١٠ تغريدات عن كرة السلة")).toBeNull();
  });
});

describe("a turn about the file never reaches a priced flow, whatever the model would say", () => {
  it("a compound request the model would turn into a country question or a plan is answered plainly", async () => {
    const { store, model, send } = session();
    const reply = await send("قسّم الملف حسب المدينة ورتبه حسب اسم الشركة وفلتر على القاهرة");
    expect(model).toHaveBeenCalledTimes(1);
    expect(reply.outputType).toBe("answer_question");
    expect(reply.planQuote).toBeUndefined();
    expect(hasCountryQuestion(reply)).toBe(false);
    expect(store.rows("plans_quotes")).toHaveLength(2);
    expect(store.rows("credit_ledger")).toHaveLength(0);
    expect(store.rpcCalls).toEqual([]);
  });

  it("an answer to a shaping question with no readable result is plain, not a country question", async () => {
    const store = createStatefulSupabase({ tables: { profiles: [{ id: "u1" }], conversations: [{ id: "c1", user_id: "u1", status: "active", brief: null, title: "x" }], messages: [], jobs: [], llm_usage: [] } });
    const handler = new ChatHandler(store.client as any);
    const model = vi.fn();
    (handler as any).llm.executeTurn = model;
    const reply: any = await handler.handleUserMessage({ userId: "u1", conversationId: "c1", message: answer("shape_sort_asc_required", "المدينة"), userBalance: 5000 });
    expect(reply.planQuote).toBeUndefined();
    expect(hasCountryQuestion(reply)).toBe(false);
    expect(reply.contentAr).toContain("ولم يُخصم أي رصيد");
    expect(model).not.toHaveBeenCalled();
  });
});
