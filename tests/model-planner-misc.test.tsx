import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { readShape } from "../src/lib/treg/shapeReader";
import { createAndSaveManagedQuote, type PlanItem } from "../src/functions/shared/planManager";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { loadRecipeForEndpoint, recipeRowFromPlan, recipeSlug, saveRecipeAfterDelivery } from "../src/lib/modelPlanner/recipes";
import { customerWordsOf, purposeFrom } from "../src/lib/modelPlanner/chatTurn";
import { MODEL_PLAN_PURPOSE_PARAM, MODEL_PLAN_SLUG } from "../src/lib/modelPlanner/constants";
import { runModelPlannerTurn } from "../src/lib/modelPlanner/chatTurn";
import { createScriptedTransport } from "../src/lib/modelPlanner/transport";
import { PURPOSE_QUESTION_AR, PURPOSE_QUESTION_ID } from "../src/lib/server/sensitiveAccess";
import { SENSITIVE_NOT_VERIFIED_AR } from "../src/lib/treg/dataPolicy";
import { quoteScopeGaps } from "../src/lib/quoteScopeGaps";
import { createChatDb } from "./helpers/chatSession";
import { createMemoryDb } from "./helpers/memoryDb";
import { propose, sample, stubGateway, xAccountPlan, X_REQUEST, fixturePages, type GatewayStub } from "./helpers/plannerKit";
import { validatePlan } from "../src/lib/modelPlanner/validate";
import { ProposePlanSchema } from "../src/lib/modelPlanner/types";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";

describe("the shape reader: an endpoint that answers ONE record as the answer itself", () => {
  const body = { linkedin_profile_url: "https://linkedin.com/in/someone", twitter_profile_url: null };
  it("is read as one row only when the caller says the endpoint has no list; otherwise (and for an empty answer) nothing is invented", () => {
    expect(readShape(body, { rootObjectIsRow: true })).toMatchObject({ rows: [body], listStrategy: "root_object", listPath: "root" });
    expect(readShape(body, {}).rows).toEqual([]);
    expect(readShape({ a: null, b: "" }, { rootObjectIsRow: true }).rows).toEqual([]);
    expect(readShape({ rows: [{ x: 1 }], extra: 1 }, { rootObjectIsRow: true }).rows).toEqual([{ x: 1 }]);
  });
});

describe("recipes", () => {
  const catalog = loadTregCatalog();
  const validated = () => {
    const rows = fixturePages("real-rows_anyapi.x.user.posts")[0].rows;
    const ep = catalog.byId.get("anyapi.x.user.posts")!;
    const samples = new Map([["anyapi.x.user.posts", { endpointId: "anyapi.x.user.posts", rows, digest: buildShapeDigest({ rows }, ep).digest, costUsd: 0.0005 }]]);
    const r = validatePlan(ProposePlanSchema.parse(xAccountPlan()), { customerText: X_REQUEST, access: { isAdmin: false, verifiedBusiness: false }, catalog, samples, today: new Date("2026-10-27T12:00:00Z") });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.plan.stored;
  };

  it("the slug is stable, short, lower-case, and follows the table's own constraint; the row is a DRAFT with no customer value", () => {
    const stored = validated();
    expect(recipeSlug(stored)).toBe(recipeSlug(JSON.parse(JSON.stringify(stored))));
    expect(recipeSlug(stored)).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/);
    const row = recipeRowFromPlan(stored, { deliveredUnits: 3, jobId: "job_1", snapshotSha256: "a".repeat(64) });
    expect(row).toMatchObject({ status: "draft", version: 1, endpoint_id: "anyapi.x.user.posts", created_by: "agent", fixture_refs: [], catalog_snapshot_sha256: "a".repeat(64) });
    expect(JSON.stringify(row)).not.toMatch(/elonmusk|@elon/);
    expect(row.params_template).toEqual({ steps: [{ handle: { from: "customer_text" } }] });
    expect(row.price_basis).toMatchObject({ measured: [{ rowsPerCall: 10, passRate: 0.3 }], firstJobDeliveredUnits: 3 });
    expect(JSON.stringify(row.price_basis)).not.toMatch(/points|price_points/);
  });

  it("saving never throws: no table, an existing recipe, a job that delivered nothing, no database", async () => {
    const stored = validated();
    expect(await saveRecipeAfterDelivery(createMemoryDb({ missing: ["recipes"] }), stored, { deliveredUnits: 3, jobId: "j" })).toBe(false);
    const db = createMemoryDb();
    expect(await saveRecipeAfterDelivery(db, stored, { deliveredUnits: 0, jobId: "j" })).toBe(false);
    expect(await saveRecipeAfterDelivery(db, stored, { deliveredUnits: 3, jobId: "j" })).toBe(true);
    expect(await saveRecipeAfterDelivery(db, stored, { deliveredUnits: 3, jobId: "j2" })).toBe(false);
    expect(await saveRecipeAfterDelivery(null, stored, { deliveredUnits: 3, jobId: "j" })).toBe(false);
    expect(await saveRecipeAfterDelivery(db, undefined, { deliveredUnits: 3, jobId: "j" })).toBe(false);
    const loaded = await loadRecipeForEndpoint(db, "anyapi.x.user.posts");
    expect(loaded).toMatchObject({ endpointIds: ["anyapi.x.user.posts"], measured: [{ rowsPerCall: 10, passRate: 0.3 }] });
    expect(loaded!.knownFields).toEqual(expect.arrayContaining(["text", "authorHandle", "isReply"]));
    expect(await loadRecipeForEndpoint(createMemoryDb({ missing: ["recipes"] }), "anyapi.x.user.posts")).toBeNull();
    expect(await loadRecipeForEndpoint(db, "other.endpoint")).toBeNull();
  });
});

describe("the quote writer: the model planner prices by an optional hook; every other caller is unchanged", () => {
  const items = (): PlanItem[] => [{ capabilitySlug: "social-x-posts", endpointId: "anyapi.x.search.posts", params: { query: "ai", channel: "" , search: "ai" }, targetVolumeMin: 1, targetVolumeMax: 10 } as any];
  it("without the hook the unit price is the capability's own rule; with it, the hook's number is the unit price, and it is stored on the item", async () => {
    const tables: any = createChatDb();
    const caps = APPROVED_CAPABILITY_CATALOG;
    const normal = await createAndSaveManagedQuote(tables, { conversationId: "c", userId: "u", plan: { summaryAr: "x", items: items(), outputFormats: ["xlsx"] }, userBalance: 40_000, capabilities: caps });
    const hooked = await createAndSaveManagedQuote(tables, { conversationId: "c", userId: "u", plan: { summaryAr: "x", items: items(), outputFormats: ["xlsx"] }, userBalance: 40_000, capabilities: caps, unitPriceOverride: () => 0.5 });
    expect(normal.items[0].unitPricePoints).toBe(0.11715);
    expect(hooked.items[0].unitPricePoints).toBe(0.5);
    expect(hooked.quotedPoints).toBe(Math.ceil(10 * 0.5 * 1.15));
    // a hook that answers null leaves the capability's rule in force
    const none = await createAndSaveManagedQuote(tables, { conversationId: "c", userId: "u", plan: { summaryAr: "x", items: items(), outputFormats: ["xlsx"] }, userBalance: 40_000, capabilities: caps, unitPriceOverride: () => null });
    expect(none.items[0].unitPricePoints).toBe(0.11715);
  });
});

describe("the plan card: real sample rows before approval, and the same edit button for a model plan", () => {
  const quote = (over: Record<string, unknown> = {}): PlanQuoteData => ({
    quoteId: "q1", planHash: "h", summaryAr: "جمع ١٠ منشورات من حساب @elonmusk",
    items: [{ capabilitySlug: MODEL_PLAN_SLUG, endpointId: "anyapi.x.user.posts", params: { _modelStep: { v: 1 } }, targetVolumeMin: 1, targetVolumeMax: 10, unitPricePoints: 0.916667 }],
    targetVolumeMax: 10, unitPricePoints: 0.916667, expectedPoints: 10, quotedPoints: 11, isAffordable: true, userBalance: 5000, outputFormats: ["xlsx", "csv"], expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(), status: "quoted",
    ...over,
  } as unknown as PlanQuoteData);
  const render = (q: PlanQuoteData) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote: q, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any));

  it("shows up to three real rows with the plan's Arabic headers and Arabic-Indic digits; a model plan has the same edit button and can be approved", () => {
    const html = render(quote({ modelPlanned: true, sampleRows: { columns: [{ key: "text", titleAr: "نص المنشور" }, { key: "likes_count", titleAr: "الإعجابات" }], rows: [{ text: "hello 2026", likes_count: 10 }, { text: "world", likes_count: 12 }] } }));
    expect(html).toContain('data-testid="plan-sample-rows"');
    expect(html).toContain("نص المنشور");
    expect(html).toContain("hello ٢٠٢٦");
    expect(html).toContain("١٢");
    expect(html).toContain('data-testid="edit-plan-btn"');
    expect(html).toContain("أوافق وابدأ البحث");
    expect(html).not.toMatch(/anyapi|treg|USD|دولار/);
  });
  it("the edit panel of a model plan offers the volume, the formats and the points cap only (no parameter text, country or activity is sent back); an old-path plan keeps its fields", () => {
    const panel = (q: PlanQuoteData) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote: q, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {}, initiallyEditing: true } as any));
    const model = panel(quote({ modelPlanned: true }));
    expect(model).toContain("pq-limit-q1");
    expect(model).toContain("pq-cap-q1");
    expect(model).toContain("حفظ التعديل");
    expect(model).not.toContain("pq-param-q1");
    expect(model).not.toContain("pq-country-q1");
    expect(model).not.toContain("pq-industry-q1");
    const old = panel(quote({ items: [{ capabilitySlug: "icypeas-companies-search", params: { country: "Egypt", location: "Egypt", industry: "الكهرباء", query: { keyword: { include: ["electrical"] }, industry: { include: ["Utilities"] }, location: { include: ["Egypt"] } } }, targetVolumeMin: 1, targetVolumeMax: 5, unitPricePoints: 3.168 }] }));
    expect(old).toContain("pq-param-q1");
  });
  it("a quote of the old path keeps its edit button and shows no sample block", () => {
    const html = render(quote({ items: [{ capabilitySlug: "icypeas-companies-search", params: { country: "Egypt", location: "Egypt", industry: "الكهرباء", query: { keyword: { include: ["electrical"] }, industry: { include: ["Utilities"] }, location: { include: ["Egypt"] } } }, targetVolumeMin: 1, targetVolumeMax: 5, unitPricePoints: 3.168 }] }));
    expect(html).toContain('data-testid="edit-plan-btn"');
    expect(html).not.toContain("plan-sample-rows");
  });
  it("a model plan item is complete for the scope guard (no gap), so the approve button is offered", () => {
    expect(quoteScopeGaps(quote().items)).toEqual([]);
  });
});

describe("the chat turn of the model planner: the customer's words, the purpose question and its answer", () => {
  let gateway: GatewayStub;
  beforeEach(() => { process.env.TREG_TOKEN = "t"; vi.stubEnv("JOB_MAX_POINTS_CAP", ""); gateway = stubGateway({}); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { gateway.restore(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("the words are the customer's messages after the last plan card, control buttons left out, newest last", () => {
    const history = [
      { role: "user", content: "قديم" }, { role: "assistant", content: "خطة", quote: { quoteId: "q0" } },
      { role: "user", content: "أريد ١٠ منشورات من @a" }, { role: "assistant", content: "ما الحساب؟" }, { role: "user", content: "أوافق وابدأ" },
    ];
    expect(customerWordsOf(history as any, "@a على إكس")).toEqual(["أريد ١٠ منشورات من @a", "@a على إكس"]);
    expect(customerWordsOf([], "طلب")).toEqual(["طلب"]);
    expect(purposeFrom([{ role: "assistant", content: PURPOSE_QUESTION_AR }], "للتواصل مع عميل")).toBe("للتواصل مع عميل");
    expect(purposeFrom([{ role: "assistant", content: "سؤال آخر" }], "للتواصل مع عميل")).toBeNull();
    expect(purposeFrom([{ role: "assistant", content: PURPOSE_QUESTION_AR }], '{"type":"x"}')).toBeNull();
  });

  const reversePlan = { summaryAr: "البحث عن صاحب الرقم", steps: [{ endpointId: "enrichlayer.contacts.reverse-phone", volume: 1, params: [{ name: "phone_number", value: "+201001234567", source: "customer_text", quote: "+201001234567" }], fieldMap: { columns: [{ field: "linkedin_profile_url", headerAr: "رابط الملف", role: "url" }] } }] };
  const turn = (db: any, userId: string, message: string, messagesContext: any[], script: any[]) => runModelPlannerTurn({
    config: { transport: createScriptedTransport(script), client: db }, tables: createChatDb(), userId, conversationId: "c1", userBalance: 40_000, message, messagesContext, requestId: "r1",
  });

  it("a VERIFIED account asking for a reverse lookup is first asked for the purpose (a free-text question card); its answer then gives the plan, with the purpose on the quote item; an unverified account gets the verified-business sentence", async () => {
    const db = createMemoryDb();
    db.seed("verified_business_accounts", [{ user_id: "vb", verified: true }]);
    const ask = "من صاحب الرقم +201001234567؟";
    const first = await turn(db, "vb", ask, [{ role: "user", content: ask }], [propose(reversePlan)]);
    expect(first).toMatchObject({ kind: "message", reason: "purpose_needed", contentAr: PURPOSE_QUESTION_AR });
    expect((first as any).clarificationItems).toEqual([{ id: PURPOSE_QUESTION_ID, text: PURPOSE_QUESTION_AR, question: PURPOSE_QUESTION_AR, type: "free", options: [], allowOther: false }]);
    const answer = "التحقق من هوية متصل بعميلنا";
    const second = await turn(db, "vb", answer, [{ role: "user", content: ask }, { role: "assistant", content: PURPOSE_QUESTION_AR }, { role: "user", content: answer }], [propose(reversePlan)]);
    expect(second.kind).toBe("plan");
    if (second.kind === "plan") {
      expect(second.sensitive).toBe(true);
      const item = (second.planQuote as any).items[0];
      expect(item.params[MODEL_PLAN_PURPOSE_PARAM]).toBe(answer);
      expect((second.planQuote as any).sampleRows).toBeUndefined();
    }
    const stranger = await turn(db, "someone-else", ask, [{ role: "user", content: ask }], [propose(reversePlan), propose(reversePlan)]);
    expect(stranger).toMatchObject({ kind: "message", reason: "restricted", contentAr: SENSITIVE_NOT_VERIFIED_AR });
    expect(gateway.calls).toHaveLength(0);
  });
});
