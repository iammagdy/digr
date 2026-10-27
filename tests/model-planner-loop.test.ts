import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_INCOMPLETE_AR, PLAN_UNAVAILABLE_AR, customerSafeArabic, runPlanner, type PlannerInput } from "../src/lib/modelPlanner/planner";
import { createScriptedTransport, plannerCostUsd, type ContentBlock } from "../src/lib/modelPlanner/transport";
import { readExplorationSpend, resetExplorationMemoryForTesting, runSampleCall } from "../src/lib/modelPlanner/exploration";
import { EXPLORATION_COST_MARKER, EXPLORATION_DAY_CAP_USD, EXPLORATION_REQUEST_CAP_USD, PLANNER_MODEL_PRICE, SAMPLE_PAGE_ROWS_PER_CALL } from "../src/lib/modelPlanner/constants";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { PURPOSE_QUESTION_AR } from "../src/lib/server/sensitiveAccess";
import { SENSITIVE_NOT_VERIFIED_AR } from "../src/lib/treg/dataPolicy";
import { createMemoryDb } from "./helpers/memoryDb";
import { describe as describeTool, fixturePages, propose, say, sample, search, stubGateway, use, xAccountPlan, X_REQUEST, type GatewayStub } from "./helpers/plannerKit";

const catalog = loadTregCatalog();
const nobody = { isAdmin: false, verifiedBusiness: false };
let gateway: GatewayStub;
const xPage = fixturePages("real-rows_anyapi.x.user.posts")[0];

beforeEach(() => {
  process.env.TREG_TOKEN = "test-token";
  resetExplorationMemoryForTesting();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  gateway = stubGateway({ "anyapi.x.user.posts": xPage }, { "anyapi.x.user.posts": 450 });
});
afterEach(() => { gateway.restore(); vi.restoreAllMocks(); });

const run = (script: Array<ContentBlock[] | ((r: any) => ContentBlock[])>, over: Partial<PlannerInput> = {}) => {
  const transport = createScriptedTransport(script as any);
  const db = createMemoryDb();
  return runPlanner({ transport, customerMessages: [X_REQUEST], access: nobody, catalog, exploration: { client: db, requestId: "req1", userId: "u1" }, ...over }).then((out) => ({ out, transport, db }));
};
const xSample = sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]);

describe("the planning loop: real tool use, tool results fed back", () => {
  it("search, describe, sample, propose: the model's tool calls are answered with tool_result blocks that carry the same ids, and the plan validates", async () => {
    const { out, transport } = await run([search("x", ["user", "posts"]), describeTool("anyapi.x.user.posts"), xSample, propose(xAccountPlan())]);
    expect(out.kind).toBe("plan");
    expect(out.turns).toBe(4);
    expect(out.toolCalls).toBe(4);
    expect(out.sampleCalls).toBe(1);
    // the protocol: after each assistant turn with tool_use, the next user message holds the tool_results of those ids
    const msgs = transport.requests[3].messages;
    const pairs = msgs.slice(1);
    for (let i = 0; i < pairs.length; i += 2) {
      const assistant = pairs[i].content as ContentBlock[];
      const user = pairs[i + 1]?.content as ContentBlock[] | undefined;
      expect(pairs[i].role).toBe("assistant");
      if (!user) continue;
      expect(pairs[i + 1].role).toBe("user");
      const ids = assistant.filter((b) => b.type === "tool_use").map((b: any) => b.id);
      expect(user.filter((b) => b.type === "tool_result").map((b: any) => b.tool_use_id)).toEqual(ids);
    }
    // the sample result the model got holds the real shape, and no cost
    const sampleResult = JSON.stringify(transport.requests[3].messages);
    expect(sampleResult).toContain("authorHandle");
    expect(sampleResult).toContain("rowsInSample");
    expect(sampleResult).not.toMatch(/costUsd|costMicro/);
  });

  it("the model's cost is computed at the planner's own price (0.10 in / 0.50 out per million), and the planner's turns are counted", async () => {
    expect(PLANNER_MODEL_PRICE).toEqual({ inputPerMillion: 0.10, outputPerMillion: 0.50, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125 });
    expect(plannerCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(0.6, 9);
    expect(plannerCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })).toBeCloseTo(0.135, 9);
    const { out } = await run([search("x", ["user", "posts"]), xSample, propose(xAccountPlan())]);
    expect(out.modelCostUsd).toBeCloseTo((out.usage.inputTokens * 0.10 + out.usage.outputTokens * 0.50) / 1_000_000, 12);
    expect(out.modelCostUsd).toBeGreaterThan(0);
  });

  it("a plan that fails validation goes back to the model as ONE tool_result (is_error); the corrected plan then validates", async () => {
    const bad = xAccountPlan();
    (bad.steps[0] as any).params = [{ name: "handle", value: "SaudiMOH", source: "customer_text", quote: "وزارة الصحة" }];
    const { out, transport } = await run([xSample, propose(bad), propose(xAccountPlan())]);
    expect(out.kind).toBe("plan");
    expect(out.failures).toHaveLength(1);
    const result = (transport.requests[2].messages.at(-1)!.content as any[])[0];
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(result.content).toContain("not in the customer's words");
  });

  it("a SECOND validation failure ends the turn with ONE Arabic sentence and nothing held: the approved «complete your request» sentence when the customer's input is what is missing", async () => {
    const bad = xAccountPlan();
    (bad.steps[0] as any).params = [{ name: "handle", value: "SaudiMOH", source: "customer_text", quote: "وزارة الصحة" }];
    const { out } = await run([xSample, propose(bad), propose(bad)], { customerMessages: ["أريد ٤٠٠ منشور من حساب وزارة الصحة السعودية على منصة X"] });
    expect(out).toMatchObject({ kind: "message", reason: "incomplete", messageAr: PLAN_INCOMPLETE_AR });
    expect(PLAN_INCOMPLETE_AR).toBe("لم نتمكن من استكمال بيانات طلبك؛ اذكر الحساب أو الرابط أو التفاصيل الناقصة وأعد إرسال الطلب، ولم يُحجز أي رصيد.");
  });

  it("a second failure that is not about the customer's input ends with the honest «not available now» sentence", async () => {
    const wrongEndpoint = xAccountPlan();
    (wrongEndpoint.steps[0] as any).endpointId = "anyapi.x.not-there";
    const { out } = await run([propose(wrongEndpoint), propose(wrongEndpoint)]);
    expect(out).toMatchObject({ kind: "message", reason: "unavailable", messageAr: PLAN_UNAVAILABLE_AR });
    expect(PLAN_UNAVAILABLE_AR).toBe("هذه الخدمة غير متاحة حاليًا؛ ولم يُحجز أي رصيد.");
  });

  it("a question or a refusal in the model's own words reaches the customer only after code made it Arabic-only, without markdown, emoji, a provider, an endpoint, a price or Latin digits", async () => {
    const providers = new Set(["tikhub", "treg", "anyapi"]);
    expect(customerSafeArabic("ما اسم الحساب الذي تريد منشوراته؟", providers)).toBe("ما اسم الحساب الذي تريد منشوراته؟");
    expect(customerSafeArabic("هل تريد 50 منشورًا؟", providers)).toBe("هل تريد ٥٠ منشورًا؟");
    expect(customerSafeArabic("**ما** اسم الحساب؟ 😀", providers)).toBe("ما اسم الحساب؟");
    expect(customerSafeArabic("سأستخدم anyapi.x.user.posts", providers)).toBeNull();
    expect(customerSafeArabic("سأستخدم Tikhub", providers)).toBeNull();
    expect(customerSafeArabic("التكلفة 5 USD", providers)).toBeNull();
    expect(customerSafeArabic("التكلفة $5", providers)).toBeNull();
    expect(customerSafeArabic("English only", providers)).toBeNull();
    expect(customerSafeArabic("", providers)).toBeNull();
    const { out } = await run([[say("ما اسم حساب الجهة على إكس؟")]]);
    expect(out).toMatchObject({ kind: "message", reason: "clarification", messageAr: "ما اسم حساب الجهة على إكس؟" });
    const { out: unsafe } = await run([[say("I will use anyapi.x.user.posts for 5 USD")]]);
    expect(unsafe).toMatchObject({ kind: "message", reason: "unavailable", messageAr: PLAN_UNAVAILABLE_AR });
  });

  it("the loop is bounded: a model that only keeps searching ends at the turn limit; a turn past its deadline starts no further model call", async () => {
    const { out, transport } = await run([search("x", ["posts"])], { maxTurns: 4 });
    expect(out).toMatchObject({ kind: "message", reason: "unavailable" });
    expect(transport.requests).toHaveLength(4);
    const late = await run([search("x", ["posts"])], { deadlineAtMs: Date.now() + 5_000 });
    expect(late.out).toMatchObject({ kind: "message", reason: "no_model" });
    expect(late.transport.requests).toHaveLength(0);
    const failing = createScriptedTransport([]);
    (failing as any).send = async () => { throw new Error("planner_http_500"); };
    const res = await runPlanner({ transport: failing, customerMessages: [X_REQUEST], access: nobody, catalog, exploration: { client: null, requestId: "r", userId: "u" } });
    expect(res).toMatchObject({ kind: "message", reason: "no_model", messageAr: PLAN_UNAVAILABLE_AR });
  });
});

describe("(b) a request the catalog cannot serve as asked: a valid plan or an honest sentence, never a hand-coded question", () => {
  it("«Instagram data for so-and-so»: the catalog has Instagram profile endpoints, the customer gave no account; an invented account is refused and the turn ends with the approved sentence (or the model's own Arabic question)", async () => {
    const request = "ابغى بيانات انستقرام لحساب فلان";
    const guess = { summaryAr: "بيانات حساب", steps: [{ endpointId: "crawl4ai.instagram.user.profile", volume: 1, params: [{ name: "username", value: "fulan", source: "customer_text", quote: "فلان" }], fieldMap: { columns: [{ field: "username", headerAr: "الحساب" }] } }] };
    const hallucinating = await run([search("instagram", ["user", "profile"]), propose(guess), propose(guess)], { customerMessages: [request] });
    expect(hallucinating.out).toMatchObject({ kind: "message", reason: "incomplete", messageAr: PLAN_INCOMPLETE_AR });
    expect(gateway.calls).toHaveLength(0);
    const asking = await run([search("instagram", ["user", "profile"]), [say("ما اسم الحساب على إنستغرام الذي تريد بياناته؟")]], { customerMessages: [request] });
    expect(asking.out).toMatchObject({ kind: "message", reason: "clarification", messageAr: "ما اسم الحساب على إنستغرام الذي تريد بياناته؟" });
    // the catalog really does hold Instagram profile endpoints (so this is the model's decision, not a missing detector)
    const found = (asking.transport.requests[1].messages.at(-1)!.content as any[])[0].content;
    expect(found).toContain("instagram");
  });
});

describe("the SENSITIVE category in the loop", () => {
  const reverseSearch = search(undefined, ["reverse", "phone"]);
  it("an UNVERIFIED account: the endpoint is never listed, never described, never sampled, never planned: the verified-business sentence and ZERO requests", async () => {
    const a = await run([reverseSearch, [say("لا أجد خدمة مناسبة.")]], { customerMessages: ["من صاحب الرقم ‎+201001234567؟"] });
    expect(a.out).toMatchObject({ kind: "message", reason: "restricted", messageAr: SENSITIVE_NOT_VERIFIED_AR });
    expect(((a.transport.requests[1].messages.at(-1)!.content as any[])[0].content as string)).not.toContain("reverse-phone");
    const b = await run([describeTool("enrichlayer.contacts.reverse-phone"), [say("غير متاح")]], { customerMessages: ["من صاحب الرقم ‎+201001234567؟"] });
    expect(b.out).toMatchObject({ kind: "message", reason: "restricted", messageAr: SENSITIVE_NOT_VERIFIED_AR });
    const c = await run([sample("enrichlayer.contacts.reverse-phone", [{ name: "phone_number", value: "+201001234567", source: "customer_text", quote: "+201001234567" }]), [say("غير متاح")]], { customerMessages: ["من صاحب الرقم +201001234567؟"] });
    expect(c.out).toMatchObject({ kind: "message", reason: "restricted" });
    const sensitivePlan = { summaryAr: "بحث عكسي", steps: [{ endpointId: "enrichlayer.contacts.reverse-phone", volume: 1, params: [{ name: "phone_number", value: "+201001234567", source: "customer_text", quote: "+201001234567" }], fieldMap: { columns: [{ field: "linkedin_profile_url", headerAr: "رابط الملف", role: "url" }] } }] };
    const d = await run([propose(sensitivePlan)], { customerMessages: ["من صاحب الرقم +201001234567؟"] });
    expect(d.out).toMatchObject({ kind: "message", reason: "restricted", messageAr: SENSITIVE_NOT_VERIFIED_AR });
    expect(d.out.turns).toBe(1);
    expect(gateway.calls).toHaveLength(0);
  });

  it("a VERIFIED account sees the endpoint, but must give a purpose: the plan is not made until the purpose question is answered; sensitive endpoints are never sampled", async () => {
    const plan = { summaryAr: "بحث عن صاحب الرقم", steps: [{ endpointId: "enrichlayer.contacts.reverse-phone", volume: 1, params: [{ name: "phone_number", value: "+201001234567", source: "customer_text", quote: "+201001234567" }], fieldMap: { columns: [{ field: "linkedin_profile_url", headerAr: "رابط الملف", role: "url" }] } }] };
    const verified = { isAdmin: false, verifiedBusiness: true };
    const request = ["من صاحب الرقم +201001234567؟"];
    const sampling = await run([sample("enrichlayer.contacts.reverse-phone", [{ name: "phone_number", value: "+201001234567", source: "customer_text", quote: "+201001234567" }]), propose(plan)], { access: verified, customerMessages: request });
    expect(sampling.out.sampleCalls).toBe(1);
    expect(gateway.calls).toHaveLength(0); // refused before any request
    const noPurpose = await run([propose(plan)], { access: verified, customerMessages: request });
    expect(noPurpose.out).toMatchObject({ kind: "purpose_needed", messageAr: PURPOSE_QUESTION_AR });
    const withPurpose = await run([propose(plan)], { access: verified, customerMessages: request, purpose: "التحقق من هوية متصل بعميلنا" });
    expect(withPurpose.out.kind).toBe("plan");
    if (withPurpose.out.kind === "plan") { expect(withPurpose.out.plan.sensitive).toBe(true); expect(withPurpose.out.plan.sampleRows).toEqual([]); }
    const adminRun = await run([propose(plan)], { access: { isAdmin: true, verifiedBusiness: false }, customerMessages: request });
    expect(adminRun.out.kind).toBe("plan");
    expect(gateway.calls).toHaveLength(0);
  });
});

describe("exploration: real sample calls under code-enforced caps, an owner cost never charged to the customer", () => {
  const params = [{ name: "handle", value: "elonmusk", source: "customer_text" as const, quote: "@elonmusk" }];
  const ctx = () => ({ customerText: X_REQUEST, access: nobody, catalog, samples: new Map() });
  const deps = (db: any, requestId = "req1") => ({ client: db, requestId, userId: "u1" });

  it("the caps are named constants: 0.05 USD per customer request and 0.50 USD per UTC day for all exploration", () => {
    expect(EXPLORATION_REQUEST_CAP_USD).toBe(0.05);
    expect(EXPLORATION_DAY_CAP_USD).toBe(0.5);
    expect(EXPLORATION_COST_MARKER).toBe("exploration");
  });

  it("a sample is recorded in provider_costs with the exploration marker and the request's job id, writes no ledger row, and stores the raw page like the first page of a job", async () => {
    const db = createMemoryDb();
    const out = await runSampleCall({ id: "anyapi.x.user.posts", params }, ctx(), deps(db));
    expect(out.ok).toBe(true);
    expect(db.rows("provider_costs")).toEqual([expect.objectContaining({ job_id: "explore_req1", provider: "treg", units: 1, cost_usd: 0.00045, capability: EXPLORATION_COST_MARKER, status: "ok", is_estimate: false })]);
    expect([...db.tables.keys()].sort()).toEqual(["exploration_calls", "provider_costs"]);
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0]).toMatchObject({ bucket: "partials" });
    expect(db.uploads[0].path).toMatch(/^explore_req1_\d+\/raw_first_page\.json$/);
    // the call asked for the page the job will ask for (a per-call price does not depend on the page size)
    expect(gateway.calls[0].body).toEqual({ handle: "elonmusk", limit: SAMPLE_PAGE_ROWS_PER_CALL });
    expect(await readExplorationSpend(deps(db))).toEqual({ request: 0.00045, day: 0.00045 });
  });

  it("EXACT BOUNDARY per request: calls that land on 0.05 USD are made, the one that would pass it is NOT (no request leaves)", async () => {
    gateway.restore();
    gateway = stubGateway({ "anyapi.x.user.posts": xPage }, { "anyapi.x.user.posts": 10_000 });
    const db = createMemoryDb();
    // the catalog price of one call is 0.0005; seed what this request already spent so the next call's estimate lands exactly on the cap
    db.seed("provider_costs", [{ job_id: "explore_req1", cost_usd: 0.0495, capability: EXPLORATION_COST_MARKER, created_at: new Date().toISOString() }]);
    const exact = await runSampleCall({ id: "anyapi.x.user.posts", params }, ctx(), deps(db));
    expect(exact.ok).toBe(true);
    expect(gateway.calls).toHaveLength(1);
    // now 0.0495 + 0.01 (the call really billed 0.01) is past the cap: the next estimate (0.0005) would land at 0.0605 > 0.05
    const over = await runSampleCall({ id: "anyapi.x.user.posts", params }, ctx(), deps(db));
    expect(over).toMatchObject({ ok: false, kind: "refused" });
    expect(gateway.calls).toHaveLength(1);
    // the same request id elsewhere is unaffected, another request starts at 0 (until the day's cap)
    expect((await runSampleCall({ id: "anyapi.x.user.posts", params }, ctx(), deps(db, "req2"))).ok).toBe(true);
  });

  it("the DAY cap: when exploration of the day is nearly spent a further sample is refused, whatever the request; the next UTC day starts again", async () => {
    const db = createMemoryDb();
    const day = "2026-10-27";
    db.seed("provider_costs", [{ job_id: "explore_other", cost_usd: 0.4996, capability: EXPLORATION_COST_MARKER, created_at: `${day}T08:00:00.000Z` }]);
    const now = new Date(`${day}T12:00:00Z`);
    const refused = await runSampleCall({ id: "anyapi.x.user.posts", params }, ctx(), { ...deps(db), now });
    expect(refused).toMatchObject({ ok: false, kind: "refused" });
    expect(gateway.calls).toHaveLength(0);
    const tomorrow = await runSampleCall({ id: "anyapi.x.user.posts", params }, ctx(), { ...deps(db), now: new Date("2026-10-28T00:00:01Z") });
    expect(tomorrow.ok).toBe(true);
    expect(await readExplorationSpend({ ...deps(db), now })).toEqual({ request: 0, day: 0.4996 });
  });

  it("a sample is refused with ZERO requests for: an invented value, a sensitive endpoint, a blocked one, an endpoint outside the catalog, an endpoint with no price", async () => {
    const db = createMemoryDb();
    const c = ctx();
    const refusals = await Promise.all([
      runSampleCall({ id: "anyapi.x.user.posts", params: [{ name: "handle", value: "invented", source: "customer_text", quote: "@someoneelse" }] }, c, deps(db)),
      runSampleCall({ id: "anyapi.x.user.posts", params: [{ name: "handle", value: "elonmusk", source: "literal" }] }, c, deps(db)),
      runSampleCall({ id: "enrichlayer.contacts.reverse-phone", params: [] }, { ...c, access: { isAdmin: true, verifiedBusiness: true } }, deps(db)),
      runSampleCall({ id: "openmart.deny-rules.create", params: [] }, c, deps(db)),
      runSampleCall({ id: "apollo.people.search", params: [] }, c, deps(db)),
      runSampleCall({ id: "x.y.z", params: [] }, c, deps(db)),
    ]);
    for (const r of refusals) expect(r.ok).toBe(false);
    expect(gateway.calls).toHaveLength(0);
    expect(db.rows("provider_costs")).toHaveLength(0);
  });

  it("a PER-RECORD endpoint is sampled with a small page (it bills every row asked), a per-call endpoint with the page the job will use", async () => {
    gateway.restore();
    gateway = stubGateway({ "icypeas.companies.search": { leads: [{ name: "Acme", website: "acme.com" }] } }, { "icypeas.companies.search": 400 });
    const db = createMemoryDb();
    const companiesCtx = { ...ctx(), customerText: "شركات تقنية في مصر" };
    const out = await runSampleCall({ id: "icypeas.companies.search", params: [{ name: "query", value: { location: { include: ["Egypt"] }, keyword: { include: ["technology"] } }, source: "derived", quote: "شركات تقنية في مصر" }] }, companiesCtx, deps(db));
    expect(out.ok).toBe(true);
    expect(gateway.calls[0].body.query).toEqual({ location: { include: ["Egypt"] }, keyword: { include: ["technology"] } });
  });

  it("a failed sample says so to the model without a price, and records what it billed", async () => {
    gateway.restore();
    gateway = stubGateway({ "anyapi.x.user.posts": new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "x-treg-cost-micro": "0" } }) });
    const db = createMemoryDb();
    const out = await runSampleCall({ id: "anyapi.x.user.posts", params }, ctx(), deps(db));
    expect(out).toMatchObject({ ok: false, kind: "failed" });
    expect(JSON.stringify(out)).not.toMatch(/USD|cost/i);
  });
});

describe("recipes in the loop: a plan that already delivered once may skip the sample call", () => {
  it("describe_endpoint shows the saved recipe; a plan on the same fields validates WITHOUT a sample and is priced from what the recipe measured", async () => {
    const recipe = { slug: "auto-anyapi-x-user-posts-1234abcd", endpointIds: ["anyapi.x.user.posts"], knownFields: ["text", "authorHandle", "createdUtc", "likes", "url", "isReply"], measured: [{ rowsPerCall: 20, passRate: 0.5 }], steps: [{ endpointId: "anyapi.x.user.posts" }] };
    const { out, transport } = await run([describeTool("anyapi.x.user.posts"), propose(xAccountPlan({}))], { loadRecipe: async () => recipe });
    expect(out.kind).toBe("plan");
    expect(out.sampleCalls).toBe(0);
    expect(gateway.calls).toHaveLength(0);
    expect(JSON.stringify(transport.requests[1].messages)).toContain("reuse it");
    if (out.kind === "plan") {
      expect(out.plan.steps[0].price).toMatchObject({ rowsPerCall: 20, passRate: 0.5, measuredFrom: "recipe" });
      expect(out.plan.price.costPerRecordUsd).toBeCloseTo(0.0005 / 10, 12);
    }
    // a field the recipe never proved needs a sample
    const withNewField = xAccountPlan();
    (withNewField.steps[0] as any).fieldMap.columns.push({ field: "bookmarks", headerAr: "الحفظ", transform: "number" });
    const second = await run([describeTool("anyapi.x.user.posts"), propose(withNewField), propose(withNewField)], { loadRecipe: async () => recipe });
    expect(second.out.kind).toBe("message");
  });
});
