import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { reserveForUnits } from "../src/lib/recordPricing";
import { countryOfRequest, geoViewOf, rowMatchesCountry } from "../src/lib/modelPlanner/countryGate";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { runModelPlanChunk } from "../src/lib/modelPlanner/interpreter";
import { runPlanner, PLAN_UNAVAILABLE_AR } from "../src/lib/modelPlanner/planner";
import { createScriptedTransport } from "../src/lib/modelPlanner/transport";
import { MODEL_PLAN_PARAM, MODEL_PLAN_SLUG } from "../src/lib/modelPlanner/constants";
import { ProposePlanSchema, type StoredModelPlan } from "../src/lib/modelPlanner/types";
import { validatePlan, type StepSample } from "../src/lib/modelPlanner/validate";
import { resetExplorationMemoryForTesting } from "../src/lib/modelPlanner/exploration";
import type { ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";
import type { TregCallResult } from "../src/functions/shared/tregClient";
import { createMemoryDb } from "./helpers/memoryDb";
import { describe as describeTool, propose, sample, search, stubGateway, X_REQUEST, type GatewayStub } from "./helpers/plannerKit";

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

// ---------------------------------------------------------------------------------------------------- 4. the stored plan is re-validated
describe("a stored model plan is re-validated by code", () => {
  const STORED_X: { stored: StoredModelPlan } = JSON.parse(readFileSync(join(__dirname, "fixtures", "model-planner-stored-items.json"), "utf8")).reviewItemsX;

  it("only the unchanged step can reuse approved measurements without a fresh sample", () => {
    const stored = STORED_X.stored;
    const step = stored.steps[0];
    const proposal = { summaryAr: "جمع ٤٠ منشورًا من حساب @elonmusk", steps: [{ endpointId: step.endpointId, volume: 40, params: step.params, fieldMap: step.fieldMap, filters: step.filters }] };
    const context = { customerText: X_REQUEST, access: nobody, catalog, samples: new Map<string, StepSample>(), today: TODAY };
    const same = validatePlan(ProposePlanSchema.parse(proposal), { ...context, approved: stored });
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.plan.steps[0].price.measuredFrom).toBe("approved_plan");
    // a step whose field map is NOT the approved one gets no shortcut: it is checked against real evidence again (and with no sample it cannot stand)
    const forgedMap = { ...stored.steps[0].fieldMap, columns: [...stored.steps[0].fieldMap.columns].reverse() };
    const changed = validatePlan(ProposePlanSchema.parse({ ...proposal, steps: [{ ...proposal.steps[0], fieldMap: forgedMap }] }), { ...context, approved: stored });
    expect(changed.ok).toBe(false);
    // and without the approved plan the same unchanged proposal has no price at all
    const bare = validatePlan(ProposePlanSchema.parse(proposal), context);
    expect(bare.ok).toBe(false);
  });
});
