import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { getJobIdForQuote } from "../src/lib/md5";
import { asksForMethodology, methodologyAnswerAr, methodologyNoDataAr, methodologyChargeId, methodologyOffered, methodologyPurchasedAr, methodologyUnavailableAr, METHODOLOGY_POINTS } from "../src/lib/methodologyOffer";
import { isMethodologyPurchased } from "../src/lib/server/methodologyPurchase";
import { methodologyMessageText } from "../src/lib/honestDisplay";
import { generateMethodologyText } from "../src/functions/shared/fileGenerators";
import { createStatefulSupabase } from "./helpers/statefulSupabase";

/**
 * The methodology add-on (10 points) was reachable only from the «التقرير» tab, and that tab exists only for a job that produced a
 * PDF; the default job produces Excel only, so no customer could ever see it. It is offered in the files area of every finished
 * job that delivered at least one record, and a request for it in the chat is answered by code.
 */
describe("when the methodology add-on is offered", () => {
  it("every finished job that delivered a record, including a partial delivery; never one with nothing delivered", () => {
    expect(methodologyOffered({ status: "done", delivered: 2 })).toBe(true);
    expect(methodologyOffered({ status: "completed", delivered: 2 })).toBe(true);
    expect(methodologyOffered({ status: "completed", delivered: 1 })).toBe(true); // partial: 1 of 3 asked
    expect(methodologyOffered({ status: "done", delivered: 0 })).toBe(false);
    expect(methodologyOffered({ status: "failed", delivered: 0 })).toBe(false);
    expect(methodologyOffered({ status: "failed", delivered: 4 })).toBe(false);
    expect(methodologyOffered({ status: "cancelled", delivered: 4 })).toBe(false);
    expect(methodologyOffered({ status: "running", delivered: 4 })).toBe(false);
    expect(methodologyOffered({ status: "queued", delivered: 0 })).toBe(false);
    expect(methodologyOffered({ status: "done" })).toBe(false);
    expect(methodologyOffered(undefined)).toBe(false);
    expect(methodologyOffered({ status: "DONE", delivered: "3" })).toBe(true);
  });

  it("the files area offers it with its price, outside the formats the job produced, and the price is the server's", () => {
    const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
    const filesTab = canvas.slice(canvas.indexOf('{tab === "files" && ('));
    const offer = filesTab.slice(filesTab.indexOf('data-testid="methodology-offer"') - 140);
    // the call now also passes the rows loaded from the saved data (`savedRows`), so the offer is not drawn where the purchase would be refused
    expect(offer).toContain("methodologyOffered({ status: jobStatus, delivered: deliveredCount, savedRows: records.length })");
    expect(offer).toContain("اكتب المنهجية الرسمية");
    expect(offer).toContain("formatNumber(METHODOLOGY_POINTS)");
    // not inside the per-format list: a job that produced only Excel still shows it
    const beforeOffer = filesTab.slice(0, filesTab.indexOf('data-testid="methodology-offer"'));
    expect(beforeOffer.lastIndexOf("producedFormats(fileIds)")).toBeLessThan(beforeOffer.lastIndexOf("))}"));
    const route = readFileSync("src/app/api/jobs/[id]/methodology/route.ts", "utf8");
    expect(route).toContain(`const METHODOLOGY_DEFAULT_POINTS = ${METHODOLOGY_POINTS};`);
    expect(METHODOLOGY_POINTS).toBe(10);
  });

  it("the report tab no longer shows the paid button for a job that delivered nothing", () => {
    const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
    expect((canvas.match(/methodologyOffered\(\{ status: jobStatus, delivered: deliveredCount, savedRows: records\.length \}\)/g) || []).length).toBe(2);
  });
});

describe("a request for the methodology document is recognised", () => {
  it.each(["ملف المنهجية", "تقرير المنهجية PDF", "اكتب المنهجية الرسمية", "عايز المنهجية بتاعت الملف", "محتاج ملف منهجية", "Methodology PDF"])("«%s»", (message) => {
    expect(asksForMethodology(message)).toBe(true);
  });
  it.each(["عايز ٥ شركات مقاولات في مصر", "ما هي المنهجية العلمية في البحث", "رتب الملف حسب المدينة", "ابحث عن منهجية التدريس الحديثة"])("not «%s»", (message) => {
    expect(asksForMethodology(message)).toBe(false);
  });
  it("the answer says where to press and the cost, in Arabic digits, as one sentence", () => {
    const answer = methodologyAnswerAr();
    expect(answer).toContain("«الملفات»");
    expect(answer).toContain("اكتب المنهجية الرسمية");
    expect(answer).toContain("١٠ نقاط");
    expect(answer).not.toMatch(/[0-9]|undefined|null|USD|\$/);
    expect(answer.split(/[.؟!]/).filter(Boolean)).toHaveLength(1);
  });
});

const rows = [
  { company_name: "Nile Energy", industry: "Utilities", location: "Cairo, Egypt", phone: "+20 100 000 0000", description: "Electricity distribution" },
  { company_name: "Delta Power", industry: "Utilities", location: "Alexandria, Egypt", phone: "+20 100 000 0001", description: "Power plants" },
];
const JOB_ID = getJobIdForQuote("Q1");

function conversation(withJob: boolean, ledger: Array<Record<string, unknown>> = [], withSavedData = true) {
  const message = (id: string, role: string, text: string, extra: Record<string, unknown>, minute: number) => ({
    id, conversation_id: "c1", user_id: "u1", role, content_ar: text, created_at: `2026-10-19T10:${String(minute).padStart(2, "0")}:00.000Z`, ...extra,
  });
  const store = createStatefulSupabase({
    tables: {
      profiles: [{ id: "u1", name: "سلمى" }],
      conversations: [{ id: "c1", user_id: "u1", status: "active", brief: null, title: "شركات كهرباء" }],
      messages: [
        message("m1", "user", "عايز شركتين كهرباء في مصر", { request_quote_id: "Q1", request_status: "accepted" }, 0),
        message("m2", "assistant", "أعددت لك خطة الاستخراج وعرض السعر بالنقاط", { quote: { quoteId: "Q1", items: [] } }, 1),
      ],
      jobs: withJob ? [{ id: JOB_ID, user_id: "u1", status: "completed", delivered_units: 2, target_volume_max: 2, template_slug: "companies", endpoint_id: "icypeas.companies.search", platform: "companies", created_at: "2026-10-19T10:05:00.000Z" }] : [],
      plans_quotes: [{ id: "Q1", user_id: "u1", status: "accepted" }],
      llm_usage: [],
      credit_ledger: ledger.map((row) => ({ ...row })),
    },
    files: withSavedData ? { [`results/u1/${JOB_ID}/data.json`]: JSON.stringify({ rows, metadata: { country: "Egypt", entityType: "companies", title: "شركات" } }) } : {},
  });
  const handler = new ChatHandler(store.client as any);
  const model = vi.fn(async () => ({
    output: { type: "answer_question", answerAr: "رد النموذج" },
    inputTokens: 900, outputTokens: 80, costUsd: 0.001, model: "claude-haiku-5-5", promptVersion: "t",
  }));
  (handler as any).llm.executeTurn = model;
  return { store, model, send: (message: string) => handler.handleUserMessage({ userId: "u1", conversationId: "c1", message, userBalance: 5000 }) as Promise<any> };
}

describe("chat: the methodology request is answered by code in a conversation with a delivered job", () => {
  it.each(["ملف المنهجية", "تقرير المنهجية PDF", "اكتب المنهجية الرسمية", "عايز ملف المنهجية بتاع الشركات"])("«%s»: one plain sentence, no plan, no quote, no model, no ledger or RPC", async (message) => {
    const { store, model, send } = conversation(true);
    const reply = await send(message);
    expect(reply.contentAr).toBe(methodologyAnswerAr());
    expect(reply.planQuote).toBeUndefined();
    expect(reply.clarificationItems || []).toHaveLength(0);
    expect(model).not.toHaveBeenCalled();
    expect(store.rows("plans_quotes")).toHaveLength(1);
    expect(store.rows("credit_ledger")).toHaveLength(0);
    expect(store.rpcCalls).toEqual([]);
    const usage = store.rows("llm_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: "deterministic", tokens_in: 0, tokens_out: 0, cost_usd: 0 });
  });

  it("a delivered job with NO saved data (a mission-era job) is never pointed to the paid button: one plain sentence, nothing charged, no plan, no model", async () => {
    const { store, model, send } = conversation(true, [], false);
    const reply = await send("ملف المنهجية");
    expect(reply.contentAr).toBe(methodologyNoDataAr());
    expect(reply.contentAr).not.toBe(methodologyAnswerAr());
    expect(reply.contentAr).not.toContain("اكتب المنهجية الرسمية");
    expect(reply.contentAr).not.toMatch(/[A-Za-z]|سجل|صف/);
    expect(reply.planQuote).toBeUndefined();
    expect(model).not.toHaveBeenCalled();
    expect(store.rows("credit_ledger")).toHaveLength(0);
    expect(store.rpcCalls).toEqual([]);
  });

  it("with no delivered job it still starts no plan and no price: one plain sentence says when the button appears", async () => {
    const { store, model, send } = conversation(false);
    const reply = await send("ملف المنهجية");
    expect(reply.contentAr).toBe(methodologyUnavailableAr());
    expect(reply.contentAr).not.toBe(methodologyAnswerAr());
    expect(reply.planQuote).toBeUndefined();
    expect(model).not.toHaveBeenCalled();
    expect(store.rows("plans_quotes")).toHaveLength(1);
    expect(store.rows("credit_ledger")).toHaveLength(0);
    expect(store.rpcCalls).toEqual([]);
  });
});

describe("a bought methodology file: the state comes from the ledger row chg_meth_<jobId>", () => {
  const bought = (userId = "u1") => [{ id: methodologyChargeId(JOB_ID), user_id: userId, delta: -10, type: "charge", job_id: JOB_ID }];

  it("the ledger row id is deterministic", () => {
    expect(methodologyChargeId("abc")).toBe("chg_meth_abc");
  });

  it("is purchased only for the owner and only for that job", async () => {
    const { store } = conversation(true, bought());
    expect(await isMethodologyPurchased(store.client, { userId: "u1", jobId: JOB_ID })).toBe(true);
    expect(await isMethodologyPurchased(store.client, { userId: "u2", jobId: JOB_ID })).toBe(false);
    expect(await isMethodologyPurchased(store.client, { userId: "u1", jobId: "other-job" })).toBe(false);
    expect(await isMethodologyPurchased(null, { userId: "u1", jobId: JOB_ID })).toBe(false);
  });

  it.each(["ملف المنهجية", "ابعتلي ملف المنهجية PDF", "اكتب المنهجية الرسمية"])("«%s»: one sentence that says it is already bought; no plan, no quote, no model, no new ledger row, no RPC", async (message) => {
    const { store, model, send } = conversation(true, bought());
    const reply = await send(message);
    expect(reply.contentAr).toBe(methodologyPurchasedAr());
    expect(reply.contentAr).not.toBe(methodologyAnswerAr());
    expect(reply.planQuote).toBeUndefined();
    expect(model).not.toHaveBeenCalled();
    expect(store.rows("plans_quotes")).toHaveLength(1);
    expect(store.rows("credit_ledger")).toHaveLength(1);
    expect(store.rpcCalls).toEqual([]);
    expect(reply.contentAr.split(/[.؟!]/).filter(Boolean)).toHaveLength(1);
  });

  it("another customer's purchase does not make this job look bought", async () => {
    const { send } = conversation(true, bought("u2"));
    expect((await send("ملف المنهجية")).contentAr).toBe(methodologyAnswerAr());
  });

  it("no customer message carries a link, a file name, a storage word or an id", () => {
    const messages = [
      methodologyPurchasedAr(),
      methodologyAnswerAr(),
      methodologyUnavailableAr(),
      methodologyMessageText(10, 290, generateMethodologyText({ metadata: { platform: "tiktok", collectedAt: "2026-10-01T00:00:00Z" }, rows: [{ text: "a" }] })),
      methodologyMessageText(undefined, undefined, "نص المنهجية"),
    ];
    for (const text of messages) {
      expect(text).not.toMatch(/https?:|www\.|\]\(|\.pdf|\.xlsx|\.csv|supabase|storage|chg_|res_|job_|undefined|null|NaN|USD|\$/i);
    }
  });

  it("the page reads the state from the server, shows the download button for a bought file, and never opens the dialog then", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("methodologyBoughtJobs");
    const handler = page.slice(page.indexOf("function handleGenerateMethodology()"), page.indexOf("function saveMethodologyFile"));
    expect(handler.indexOf("if (methodologyPurchased)")).toBeGreaterThan(-1);
    expect(handler.indexOf("if (methodologyPurchased)")).toBeLessThan(handler.indexOf("setMethodologyConfirmOpen(true)"));
    expect(page).not.toContain("methodologyMessageText(data.chargedPoints, data.remainingBalance, data.methodologyText, data.downloadUrl)");
    const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
    expect((canvas.match(/methodologyPurchased \? "تحميل المنهجية"/g) || []).length).toBe(2);
    const route = readFileSync("src/app/api/jobs/[id]/methodology/route.ts", "utf8");
    expect(route).toContain("export async function GET");
    expect(route).toContain("isMethodologyPurchased");
  });
});

describe("the methodology text itself", () => {
  it("is Arabic only: no Latin letters, no provider or tool names, no accuracy claim", () => {
    const text = generateMethodologyText({
      metadata: { platform: "tiktok", entityType: "comments", collectedAt: "2026-10-01T00:00:00Z" },
      rows: [{ text: "تعليق", author: "كاتب" }],
    });
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/apify|icypeas|openai|anthropic|claude|gpt|rapidapi|supabase|vercel/i);
    // «اكتمال الحقول: ١٠٠٪ (يقيس وجود القيم فقط)» states presence of values with its own caveat; any other percentage or accuracy promise is a claim.
    const withoutCompleteness = text.split("\n").filter((line) => !line.startsWith("اكتمال الحقول")).join("\n");
    expect(withoutCompleteness).not.toMatch(/[٪%]|دقة\s+(?:تامة|كاملة)|مضمون|مؤكد|موثوق\s+بالكامل/);
    expect(text).toContain("يقيس وجود القيم فقط");
  });
  it("the PDF facts table names the file kinds in Arabic", () => {
    const source = readFileSync("src/functions/shared/fileGenerators.ts", "utf8");
    expect(source).not.toContain("Excel: البيانات فقط");
    expect(source).toContain("ملف إكسل: البيانات فقط");
  });
});
