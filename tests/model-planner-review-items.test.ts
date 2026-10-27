import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { reserveForUnits } from "../src/lib/recordPricing";
import { countryOfRequest, geoViewOf, rowMatchesCountry } from "../src/lib/modelPlanner/countryGate";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { runModelPlanChunk } from "../src/lib/modelPlanner/interpreter";
import { runPlanner, PLAN_UNAVAILABLE_AR } from "../src/lib/modelPlanner/planner";
import { createScriptedTransport } from "../src/lib/modelPlanner/transport";
import { EDIT_NOT_AVAILABLE_AR, EDIT_REJECTED_AR, editModelPlanQuote, revalidateStoredPlan } from "../src/lib/modelPlanner/editPlan";
import { GUEST_SIGNUP_AR } from "../src/lib/modelPlanner/chatTurn";
import { MODEL_PLAN_PARAM, MODEL_PLAN_REQUEST_PARAM, MODEL_PLAN_SLUG } from "../src/lib/modelPlanner/constants";
import { ProposePlanSchema } from "../src/lib/modelPlanner/types";
import { validatePlan, type StepSample } from "../src/lib/modelPlanner/validate";
import { resetExplorationMemoryForTesting } from "../src/lib/modelPlanner/exploration";
import type { ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";
import type { TregCallResult } from "../src/functions/shared/tregClient";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { createChatDb } from "./helpers/chatSession";
import { createMemoryDb } from "./helpers/memoryDb";
import { describe as describeTool, propose, sample, search, stubGateway, xAccountPlan, X_REQUEST, fixturePages, type GatewayStub } from "./helpers/plannerKit";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/replayWorld")).world.supabaseServerMock());
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

const catalog = loadTregCatalog();
const TODAY = new Date("2026-10-27T12:00:00Z");
const nobody = { isAdmin: false, verifiedBusiness: false };
let gateway: GatewayStub | null = null;

beforeEach(() => {
  process.env.TREG_TOKEN = "test-token";
  resetExplorationMemoryForTesting();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { gateway?.restore(); gateway = null; vi.restoreAllMocks(); });

const sampleOf = (endpointId: string, rows: Array<Record<string, unknown>>): StepSample => ({ endpointId, rows, digest: buildShapeDigest({ rows }, catalog.byId.get(endpointId)!).digest, costUsd: 0.0005 });

// ---------------------------------------------------------------------------------------------------- 2. never priced from a catalog example
describe("NEVER PRICED FROM A CATALOG EXAMPLE (the planning loop)", () => {
  const request = "أريد ٥ تغريدات عن AI trenches على منصة X";
  const noSamplePlan = {
    summaryAr: "جمع ٥ تغريدات عن AI trenches", topic: "AI trenches",
    steps: [{ endpointId: "anyapi.x.search.posts", volume: 5, params: [{ name: "query", value: "AI trenches", source: "customer_text", quote: "AI trenches" }], fieldMap: { columns: [{ field: "text", headerAr: "نص التغريدة", role: "text" }], pagination: { kind: "token", param: "cursor" } } }],
  };
  const page = { output: { data: { items: Array.from({ length: 6 }, (_, i) => ({ text: `ai trenches ${i}`, authorUsername: "a", createdUtc: 1790000000 + i, likeCount: i, url: `https://x.com/a/${i}` })) } } };
  const run = (script: any[], over: Record<string, unknown> = {}) => {
    const transport = createScriptedTransport(script);
    const db = createMemoryDb();
    return runPlanner({ transport, customerMessages: [request], access: nobody, catalog, exploration: { client: db, requestId: "req1", userId: "u1" }, today: TODAY, ...over } as any).then((out) => ({ out, transport }));
  };

  it("a plan proposed with no real sample goes back with the instruction to sample first; after one tiny real check it is priced from the rows that call returned", async () => {
    gateway = stubGateway({ "anyapi.x.search.posts": page }, { "anyapi.x.search.posts": 750 });
    const { out, transport } = await run([propose(noSamplePlan), sample("anyapi.x.search.posts", [{ name: "query", value: "AI trenches", source: "customer_text", quote: "AI trenches" }]), propose(noSamplePlan)]);
    expect(out.kind).toBe("plan");
    if (out.kind !== "plan") return;
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].map((i) => i.code)).toEqual(["needs_real_sample"]);
    const sentBack = JSON.stringify(transport.requests[1].messages);
    expect(sentBack).toContain("sample_call");
    expect(sentBack).toContain("trimmed to one list item");
    expect(out.plan.steps[0].price.measuredFrom).toBe("sample");
    expect(out.plan.steps[0].price.rowsPerCall).toBe(6);
    expect(out.sampleCalls).toBe(1);
  });

  it("a model that never samples ends with the honest sentence, no card and nothing held (the second failure ends the turn)", async () => {
    gateway = stubGateway({});
    const { out } = await run([propose(noSamplePlan), propose(noSamplePlan)]);
    expect(out).toMatchObject({ kind: "message", reason: "unavailable", messageAr: PLAN_UNAVAILABLE_AR });
    expect(gateway.calls).toHaveLength(0);
  });

  it("the Facebook keyword search (0.0295 USD per call) can now take ONE real sample under the 0.05 USD per-request cap, and is then priced from it; an endpoint above the cap (0.066 USD) still cannot be sampled and leaves the plan unpriced: no card", async () => {
    const fbPage = { code: 0, data: { results: Array.from({ length: 5 }, (_, i) => ({ post_id: `p${i}`, url: `https://www.facebook.com/x/posts/${i}`, message: `post ${i}`, comments_count: i })), cursor: "c1" } };
    gateway = stubGateway({ "justoneapi.x.facebook-search-post-v1": fbPage }, { "justoneapi.x.facebook-search-post-v1": 29_520 });
    const customerMessages = ["أريد ٣٠ منشورًا عن الغلا"];
    const plan = { summaryAr: "جمع ٣٠ منشورًا عن الغلا", steps: [{ endpointId: "justoneapi.x.facebook-search-post-v1", volume: 30, params: [{ name: "keyword", value: "الغلا", source: "customer_text", quote: "الغلا" }], fieldMap: { columns: [{ field: "message", headerAr: "نص المنشور", role: "text" }], pagination: { kind: "token", param: "cursor" } } }] };
    const ok = await run([sample("justoneapi.x.facebook-search-post-v1", [{ name: "keyword", value: "الغلا", source: "customer_text", quote: "الغلا" }]), propose(plan)], { customerMessages });
    expect(ok.out.kind).toBe("plan");
    expect(gateway.calls).toHaveLength(1);
    if (ok.out.kind === "plan") expect(ok.out.plan.steps[0].price).toMatchObject({ rowsPerCall: 5, measuredFrom: "sample" });
    gateway.restore();
    gateway = stubGateway({});
    const dear = { summaryAr: "جمع ٣٠ منشورًا عن الغلا", steps: [{ endpointId: "anyapi.facebook.search_posts", volume: 30, params: [{ name: "query", value: "الغلا", source: "customer_text", quote: "الغلا" }], fieldMap: { columns: [{ field: "message", headerAr: "نص المنشور", role: "text" }], pagination: { kind: "single" } } }] };
    const refused = await run([sample("anyapi.facebook.search_posts", [{ name: "query", value: "الغلا", source: "customer_text", quote: "الغلا" }]), propose(dear), propose(dear)], { customerMessages });
    expect(JSON.stringify(refused.transport.requests[1].messages)).toContain("exploration budget");
    expect(refused.out.kind).toBe("message");
    expect(gateway.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------- 3. the country gate
describe("COUNTRY GATE on the model path: a named country holds company and person rows to that country, deterministically", () => {
  const request = "أريد ١٠ شركات صواريخ في ليختنشتاين";
  const egyptian = { name: "Cairo Rockets", address: "Cairo, Egypt", website: "https://www.cairo-rockets.com.eg", industry: "Aerospace", description: "rocket engines" };
  const alpine = { name: "Vaduz Space", address: "Vaduz, Liechtenstein", website: "https://www.vaduz-space.li", industry: "Aerospace", description: "rocket components" };
  const unknown = { name: "Nowhere Ltd", address: "", website: "https://nowhere.example", industry: "Aerospace", description: "rockets" };
  const plan = ProposePlanSchema.parse({
    summaryAr: "جمع ١٠ شركات صواريخ في ليختنشتاين", topic: "شركات صواريخ",
    steps: [{ endpointId: "icypeas.companies.search", volume: 10, params: [{ name: "query", value: { keyword: { include: ["rocket"] }, location: { include: ["Liechtenstein"] } }, source: "derived", quote: "شركات صواريخ في ليختنشتاين" }], fieldMap: { columns: [{ field: "name", headerAr: "اسم الشركة", role: "company" }, { field: "address", headerAr: "العنوان", role: "location" }], pagination: { kind: "single" } } }],
  });
  const ctx = (rows: Array<Record<string, unknown>>) => ({ customerText: request, access: nobody, catalog, samples: new Map([["icypeas.companies.search", sampleOf("icypeas.companies.search", rows)]]), today: TODAY });

  it("the country is read from the customer's own words (a city counts), as on the old path", () => {
    expect(countryOfRequest(request)).toEqual({ canonicalEnglish: "Liechtenstein", arabicLabel: "ليختنشتاين" });
    expect(countryOfRequest("شركات مقاولات في جدة")?.canonicalEnglish).toBe("Saudi Arabia");
    expect(countryOfRequest("شركات تقنية")).toBeNull();
  });

  it("COMPANY rows need positive evidence of the country: Egyptian and unknown-location companies are never delivered for Liechtenstein; a Vaduz company is", () => {
    const country = countryOfRequest(request)!;
    expect(rowMatchesCountry(egyptian, country, "company")).toBe(false);
    expect(rowMatchesCountry(unknown, country, "company")).toBe(false);
    expect(rowMatchesCountry(alpine, country, "company")).toBe(true);
    // a source's own field names are read, whatever they are called
    expect(geoViewOf({ hq: { city: "Vaduz", country: "Liechtenstein" }, domain: "x.li" })).toMatchObject({ country: "Liechtenstein", website: "x.li" });
    expect(rowMatchesCountry({ name: "N", hq: { city: "Vaduz", country: "Liechtenstein" } }, country, "company")).toBe(true);
    expect(rowMatchesCountry({ name: "N", hq: { city: "Cairo", country: "Egypt" } }, country, "company")).toBe(false);
  });

  it("PERSON rows are refused only when the row names ANOTHER country (their own address or their company's); no country data contradicts nothing", () => {
    const egypt = countryOfRequest("مدراء في مصر")!;
    expect(rowMatchesCountry({ firstname: "A", address: "Berlin, Germany" }, egypt, "person")).toBe(false);
    expect(rowMatchesCountry({ firstname: "A", address: "Cairo, Egypt", lastCompanyAddress: "Munich, Germany" }, egypt, "person")).toBe(false);
    expect(rowMatchesCountry({ firstname: "A", address: "Cairo, Egypt", lastCompanyAddress: "Giza, Egypt" }, egypt, "person")).toBe(true);
    expect(rowMatchesCountry({ firstname: "A" }, egypt, "person")).toBe(true);
  });

  it("PLANNING: rockets in Liechtenstein with a sample of Egyptian companies is refused (zero rows pass), and the model is told why; with a Vaduz row it is priced from the share that passes and the country is stored on the plan", () => {
    const bad = validatePlan(plan, ctx([egyptian, egyptian, unknown]));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues[0].code).toBe("zero_pass_rate");
    expect(bad.issues[0].message).toContain("outside the country");
    const good = validatePlan(plan, ctx([egyptian, alpine, egyptian, alpine]));
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.plan.steps[0].price).toMatchObject({ rowsPerCall: 4, passRate: 0.5, measuredFrom: "sample" });
    expect(good.plan.stored.country).toEqual({ canonicalEnglish: "Liechtenstein", arabicLabel: "ليختنشتاين" });
    expect(good.plan.stored.steps[0].facts.entity).toBe("company");
    // the card's sample rows are held to the country too
    expect(JSON.stringify(good.plan.sampleRows)).not.toContain("Cairo");
    // no country named: no gate
    const open = validatePlan(ProposePlanSchema.parse({ ...plan, steps: [{ ...plan.steps[0], params: [{ name: "query", value: { keyword: { include: ["rocket"] } }, source: "derived", quote: "شركات صواريخ" }] }] }), { ...ctx([egyptian]), customerText: "أريد ١٠ شركات صواريخ" });
    expect(open.ok).toBe(true);
    if (open.ok) expect(open.plan.stored.country).toBeUndefined();
  });

  it("EXECUTION: the old failure (rockets in Liechtenstein) never delivers an Egyptian company; the page's Egyptian and location-less rows are dropped, the Vaduz row is delivered", async () => {
    const good = validatePlan(plan, ctx([alpine, egyptian]));
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const ok = (data: any): TregCallResult => ({ ok: true, httpStatus: 200, tregCallId: "c", costMicro: 380, latencyMs: 1, data, isRouteMaxCost: false, isPlatformBalanceLow: false });
    const call = async () => ok({ leads: [egyptian, egyptian, alpine, unknown, egyptian] });
    const input: ProviderAdapterCallInput = {
      jobId: "job_1", userId: "u1", step: 0, endpointId: "icypeas.companies.search", capabilitySlug: MODEL_PLAN_SLUG, method: "POST", params: { [MODEL_PLAN_PARAM]: good.plan.stored }, paginationStrategy: "cursor",
      cursor: null, pageSize: 10, remainingNeeded: 10, targetVolumeMax: 10, deliveredSoFar: 0,
    };
    const out = await runModelPlanChunk(input, { call, advisor: async (given) => ({ verdicts: new Map(given.rows.map((r) => [r.index, { verdict: "match", reasonAr: "" }])) as any, usage: null as any, failure: null }) });
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(JSON.stringify(out.rows)).toContain("Vaduz");
    expect(JSON.stringify(out.rows)).not.toMatch(/Cairo|Egypt|Nowhere/);
  });
});

// ---------------------------------------------------------------------------------------------------- 4. plan edit, 5. guests (through the chat, the replay-style stubbed gateway)
describe("a model plan can be edited; a guest is asked to sign up", () => {
  const xPage = fixturePages("real-rows_anyapi.x.user.posts")[0];
  let seq = 0;
  async function chat(opts: { email?: string; guest?: boolean; allow?: boolean }) {
    const world = (await import("./helpers/replayWorld")).world;
    world.mem.reset();
    gateway = stubGateway({ "anyapi.x.user.posts": xPage }, { "anyapi.x.user.posts": 500 });
    const db: any = createChatDb();
    const handler = new ChatHandler(db);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the old model path must not run"); });
    handler.modelPlanner = { transport: createScriptedTransport([search("x", ["user", "posts"]), describeTool("anyapi.x.user.posts"), sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), propose(xAccountPlan())]), client: world.mem, today: () => TODAY };
    if (opts.allow) handler.modelPlannerFor = () => true;
    const conversationId = `conv_rv_${++seq}`;
    await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_replay", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    const r: any = await handler.handleUserMessage({ userId: "user_replay", ...(opts.email ? { userEmail: opts.email } : {}), ...(opts.guest ? { isGuest: true } : {}), conversationId, message: X_REQUEST, userBalance: 40_000 });
    return { r, db, world };
  }

  it("EDIT: the card of a model plan offers the same edit; a volume edit validates and prices the plan AGAIN and saves a NEW quote (the hold follows the new volume); no provider call is made", async () => {
    const { r, db, world } = await chat({ email: "magdy.saber@outlook.com" });
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    const callsBefore = gateway!.calls.length;
    const unit = item.unitPricePoints;
    const edited = await editModelPlanQuote({ tables: db, client: world.mem, conversationId: r.conversationId, userId: "user_replay", userBalance: 40_000, quoteItem: item, summaryAr: r.planQuote.summaryAr, outputFormats: ["xlsx", "csv"], operations: [{ action: "set_limit", targetVolumeMax: 25 }, { action: "set_formats", formats: ["csv"] }], today: TODAY });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.quote.quoteId).not.toBe(r.planQuote.quoteId);
    expect(edited.quote.targetVolumeMax).toBe(25);
    expect(edited.quote.unitPricePoints).toBe(unit); // the same plan, the same measured yield, today's catalog cost
    expect(edited.quote.quotedPoints).toBe(reserveForUnits(25, unit));
    expect(edited.quote.outputFormats).toEqual(["csv"]);
    expect(edited.quote.items[0].capabilitySlug).toBe(MODEL_PLAN_SLUG);
    expect(edited.quote.items[0].params[MODEL_PLAN_PARAM].steps[0].volume).toBe(25);
    expect(edited.quote.summaryAr).toContain("٢٥");
    expect(gateway!.calls.length).toBe(callsBefore); // an edit asks no source
  });

  it("EDIT re-runs code validation: a parameter whose quote is no longer the customer's words, a changed price basis, an operation the plan does not offer, a plan that is no longer allowed: each is refused or re-priced by code, never saved as is", async () => {
    const { r, db, world } = await chat({ email: "magdy.saber@outlook.com" });
    const item = r.planQuote.items[0];
    const base = { tables: db, client: world.mem, conversationId: r.conversationId, userId: "user_replay", userBalance: 40_000, summaryAr: r.planQuote.summaryAr, outputFormats: ["xlsx" as const], today: TODAY };
    const limit = [{ action: "set_limit", targetVolumeMax: 20 }];
    // the customer's own words are checked again: a plan whose account is not in them cannot be re-approved
    const tampered = JSON.parse(JSON.stringify(item));
    tampered.params[MODEL_PLAN_REQUEST_PARAM] = "أريد منشورات من حساب آخر";
    expect(await editModelPlanQuote({ ...base, quoteItem: tampered, operations: limit })).toEqual({ ok: false, messageAr: EDIT_REJECTED_AR });
    // an endpoint that is not sellable (a write action) is refused
    const blocked = JSON.parse(JSON.stringify(item));
    blocked.params[MODEL_PLAN_PARAM].steps[0].endpointId = "x.x.post.create";
    expect(await editModelPlanQuote({ ...base, quoteItem: blocked, operations: limit })).toEqual({ ok: false, messageAr: EDIT_REJECTED_AR });
    // the price follows the measured values stored with the plan, through the shared function
    const cheaper = JSON.parse(JSON.stringify(item));
    cheaper.params[MODEL_PLAN_PARAM].measured[0].passRate = 0.6;
    const repriced = await editModelPlanQuote({ ...base, quoteItem: cheaper, operations: limit });
    expect(repriced.ok).toBe(true);
    if (repriced.ok) expect(repriced.quote.unitPricePoints).toBeLessThan(item.unitPricePoints);
    // only the volume and the formats are offered
    expect(await editModelPlanQuote({ ...base, quoteItem: item, operations: [{ action: "set_param" }] })).toEqual({ ok: false, messageAr: EDIT_NOT_AVAILABLE_AR });
    // a stored item that is not a model plan is not edited here
    expect(await editModelPlanQuote({ ...base, quoteItem: { capabilitySlug: "social-x-posts", params: {} }, operations: limit })).toEqual({ ok: false, messageAr: EDIT_REJECTED_AR });
  });

  it("revalidateStoredPlan: the unchanged step keeps its measured values (no new sample); a changed step gets no shortcut", async () => {
    const { r } = await chat({ email: "magdy.saber@outlook.com" });
    const stored = r.planQuote.items[0].params[MODEL_PLAN_PARAM];
    const args = { stored, summaryAr: r.planQuote.summaryAr, customerText: X_REQUEST, newVolume: 40, access: nobody, today: TODAY };
    const same = revalidateStoredPlan(args);
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.plan.steps[0].price.measuredFrom).toBe("approved_plan");
    // a step whose field map is NOT the approved one gets no shortcut: it is checked against real evidence again (and with no sample it cannot stand)
    const forgedMap = { ...stored.steps[0].fieldMap, columns: [...stored.steps[0].fieldMap.columns].reverse() };
    const changed = validatePlan(ProposePlanSchema.parse({ summaryAr: "جمع ٤٠ منشورًا من حساب @elonmusk", steps: [{ endpointId: "anyapi.x.user.posts", volume: 40, params: stored.steps[0].params, fieldMap: forgedMap, filters: stored.steps[0].filters }] }), { customerText: X_REQUEST, access: nobody, catalog, samples: new Map(), today: TODAY, approved: stored });
    expect(changed.ok).toBe(false);
    // and without the approved plan the same unchanged proposal has no price at all
    const bare = validatePlan(ProposePlanSchema.parse({ summaryAr: "جمع ٤٠ منشورًا من حساب @elonmusk", steps: [{ endpointId: "anyapi.x.user.posts", volume: 40, params: stored.steps[0].params, fieldMap: stored.steps[0].fieldMap, filters: stored.steps[0].filters }] }), { customerText: X_REQUEST, access: nobody, catalog, samples: new Map(), today: TODAY });
    expect(bare.ok).toBe(false);
  });

  it("GUEST: planned like anyone (the same new path), but no quote is saved, no card is shown and nothing can be approved: the guest reads what was understood and the sign-up sentence", async () => {
    const { r, db } = await chat({ guest: true, allow: true });
    expect(r.outputType).toBe("answer_question");
    expect(r.planQuote).toBeUndefined();
    expect(r.contentAr).toContain(GUEST_SIGNUP_AR);
    expect(r.contentAr).not.toMatch(/USD|anyapi|[٠-٩0-9]+ نقط/);
    // no quote row of any table: nothing a guest could approve
    expect((db.store.get("plans_quotes") ?? []).length).toBe(0);
    const signedIn = await chat({ email: "magdy.saber@outlook.com" });
    expect((signedIn.db.store.get("plans_quotes") ?? []).length).toBe(1);
    expect(gateway!.calls.length).toBeGreaterThan(0); // the planner did its one tiny real check, within the exploration caps
  });

  it("a guest is NOT on the allowlist (it has no e-mail of its own): without the injected rule it stays on the old path", async () => {
    const world = (await import("./helpers/replayWorld")).world;
    const db: any = createChatDb();
    const handler = new ChatHandler(db);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
    const transport = createScriptedTransport([[{ type: "text", text: "x" }]]);
    handler.modelPlanner = { transport, client: world.mem, today: () => TODAY };
    expect(handler.modelPlannerFor({ email: "magdy.saber@outlook.com", isGuest: true })).toBe(false);
    expect(transport.requests).toHaveLength(0);
  });
});
