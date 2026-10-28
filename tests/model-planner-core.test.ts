import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadTregCatalog, type CatalogEndpoint } from "../src/lib/treg/catalog";
import { chargeForUnits, reserveForUnits, unitPricePointsFromCost } from "../src/lib/recordPricing";
import { applyPlanToRows, applyTransform, mapRow, readDateIso, rowFilterVerdict } from "../src/lib/modelPlanner/fieldMap";
import { callEstimateUsd, pricePlan, priceStep, unitCost } from "../src/lib/modelPlanner/pricing";
import { checkParamValue, isWindowParamName, quoteIsFromCustomer, safeSummaryAr, statedWindowOf, validatePlan, type StepSample, type ValidateContext } from "../src/lib/modelPlanner/validate";
import { buildShapeDigest, digestFields, digestFromCatalogExample } from "../src/lib/modelPlanner/digest";
import { ProposePlanSchema, type ProposePlanInput } from "../src/lib/modelPlanner/types";
import { anthropicToolDefinitions, proposePlanJsonSchema, toolCatalogSearch, toolDescribeEndpoint } from "../src/lib/modelPlanner/tools";

const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync("tests/fixtures/replay/real-rows_anyapi.x.user.posts.json", "utf-8"));
const xRows: Array<Record<string, unknown>> = fixture.pages[0].rows;
const xEndpoint = catalog.byId.get("anyapi.x.user.posts")!;
const TODAY = new Date("2026-10-27T12:00:00Z");

const sampleOf = (endpointId: string, rows: Array<Record<string, unknown>>): StepSample => ({ endpointId, rows, digest: buildShapeDigest({ rows }, catalog.byId.get(endpointId) ?? xEndpoint).digest, costUsd: 0.0005 });
const ctx = (over: Partial<ValidateContext> = {}): ValidateContext => ({ customerText: "أريد ١٠ منشورات من حساب @elonmusk على منصة X", access: { isAdmin: false, verifiedBusiness: false }, catalog, samples: new Map([["anyapi.x.user.posts", sampleOf("anyapi.x.user.posts", xRows)]]), today: TODAY, ...over });
const plan = (over: Record<string, unknown> = {}, stepOver: Record<string, unknown> = {}): ProposePlanInput => ProposePlanSchema.parse({
  summaryAr: "جمع ١٠ منشورات من حساب @elonmusk",
  steps: [{
    endpointId: "anyapi.x.user.posts", volume: 10,
    params: [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }],
    fieldMap: { columns: [{ field: "text", headerAr: "نص المنشور", role: "text" }, { field: "authorHandle", headerAr: "الحساب", role: "author_handle" }, { field: "createdUtc", headerAr: "تاريخ النشر", role: "date" }, { field: "likes", headerAr: "الإعجابات", role: "likes", transform: "number" }, { field: "url", headerAr: "الرابط", role: "url" }], pagination: { kind: "token", param: "cursor" } },
    filters: [{ kind: "author_equals", field: "authorHandle", value: "elonmusk", quote: "@elonmusk" }, { kind: "exclude_true", field: "isReply" }, { kind: "exclude_prefix", field: "text", prefix: "RT @" }],
    ...stepOver,
  }],
  ...over,
});
const codes = (p: ProposePlanInput, c = ctx()) => { const r = validatePlan(p, c); return r.ok ? [] : r.issues.map((i) => i.code); };

describe("the field map and the filters: real X rows (all values are text, as the live source sends them)", () => {
  it("transforms are a CLOSED list that never throws on a value it cannot read", () => {
    expect(applyTransform("1792308962", "unix_s_to_iso")).toBe("2026-10-18T07:36:02Z");
    expect(applyTransform(1792308962000, "unix_ms_to_iso")).toBe("2026-10-18T07:36:02Z");
    expect(applyTransform("False", "bool")).toBe(false);
    expect(applyTransform("True", "bool")).toBe(true);
    expect(applyTransform("1,200", "number")).toBe(1200);
    expect(applyTransform("@elonmusk", "strip_at")).toBe("elonmusk");
    expect(applyTransform("https://www.Example.com/a/b?x=1", "domain")).toBe("example.com");
    expect(applyTransform(["a", "b"], "join")).toBe("a، b");
    expect(applyTransform(["a", "b"], "first")).toBe("a");
    expect(applyTransform("not a time", "unix_s_to_iso")).toBe("not a time");
    expect(applyTransform(undefined, "number")).toBeUndefined();
    expect(readDateIso("1792308962")).toBe("2026-10-18T07:36:02Z");
    expect(readDateIso("2026-10-15T09:00:00Z")).toBe("2026-10-15T09:00:00Z");
    expect(readDateIso("garbage")).toBeUndefined();
  });

  it("a column with a role is written under the platform's standard key, any other under its own Arabic header", () => {
    const p = plan();
    const rec = mapRow(xRows[0], p.steps[0].fieldMap)!;
    expect(Object.keys(rec)).toEqual(["text", "username", "published_at", "likes_count", "url"]);
    expect(rec.username).toBe("elonmusk");
    expect(rec.published_at).toBe("2026-10-18T07:36:02Z");
    expect(rec.likes_count).toBe(10);
    const custom = mapRow(xRows[0], { columns: [{ field: "views", headerAr: "عدد المشاهدات الكلي", transform: "number" }, { field: "lang", headerAr: "اللغة" }] })!;
    expect(Object.keys(custom)).toEqual(["عدد المشاهدات الكلي", "اللغة"]);
  });

  it("the filters of the plan keep the account's own posts, drop replies and reposts, and HOLD a row they cannot read (never deliver it, never charge it)", () => {
    const p = plan();
    const applied = applyPlanToRows(xRows, p.steps[0].fieldMap, p.steps[0].filters);
    expect(applied.seen).toBe(10);
    expect(applied.records.length).toBe(3); // the live job's ten rows: 3 own posts that are neither replies nor reposts
    expect(applied.dropped.excluded).toBeGreaterThan(0);
    expect(rowFilterVerdict({ authorHandle: "ELONMUSK", isReply: "False", text: "x" }, p.steps[0].filters)).toEqual({ keep: true, reason: null });
    expect(rowFilterVerdict({ authorHandle: "@elonmusk", isReply: "False", text: "x" }, p.steps[0].filters).keep).toBe(true);
    expect(rowFilterVerdict({ authorHandle: "someoneelse", isReply: "False", text: "x" }, p.steps[0].filters)).toEqual({ keep: false, reason: "author" });
    expect(rowFilterVerdict({ isReply: "False", text: "x" }, p.steps[0].filters)).toEqual({ keep: false, reason: "unreadable" });
    expect(rowFilterVerdict({ authorHandle: "elonmusk", isReply: "maybe", text: "x" }, p.steps[0].filters)).toEqual({ keep: false, reason: "unreadable" });
    expect(rowFilterVerdict({ authorHandle: "elonmusk", isReply: "True", text: "x" }, p.steps[0].filters)).toEqual({ keep: false, reason: "excluded" });
    expect(rowFilterVerdict({ authorHandle: "elonmusk", isReply: "False", text: "RT @someone: hi" }, p.steps[0].filters)).toEqual({ keep: false, reason: "excluded" });
  });

  it("a date_window filter keeps the rows whose date lies inside the window (Unix seconds written as text)", () => {
    const f = [{ kind: "date_window" as const, field: "createdUtc", from: "2026-10-18", to: "2026-10-18", quote: "x", format: "unix_s" as const }];
    expect(rowFilterVerdict({ createdUtc: "1792308962" }, f).keep).toBe(true);
    expect(rowFilterVerdict({ createdUtc: "1792108962" }, f)).toEqual({ keep: false, reason: "window" });
    expect(rowFilterVerdict({ createdUtc: "" }, f)).toEqual({ keep: false, reason: "unreadable" });
  });
});

describe("pricing: by code only, from the catalog and what was measured", () => {
  it("a per-call endpoint is divided by the rows one call returns and by the share that passes the filters; the unit price is the shared function (cost x 5,500, fractional)", () => {
    const cost = unitCost(xEndpoint, catalog)!;
    expect(cost).toEqual({ usd: 0.0005, unit: "call", basis: "catalog" });
    const price = priceStep(cost, { rowsPerCall: 20, passRate: 0.5, source: "sample" });
    expect(price.costPerCallUsd).toBe(0.0005);
    expect(price.costPerRecordUsd).toBeCloseTo(0.00005, 12);
    const plan1 = pricePlan([price]);
    expect(plan1.unitPricePoints).toBe(unitPricePointsFromCost(0.00005));
    expect(plan1.unitPricePoints).toBe(0.275);
    // the hold and the charge are the shared functions: ceil(volume x unit x 1.15) and ceil(delivered x unit), never above the hold
    expect(reserveForUnits(10, plan1.unitPricePoints)).toBe(4);
    expect(chargeForUnits(3, plan1.unitPricePoints)).toBe(1);
    expect(chargeForUnits(10, plan1.unitPricePoints)).toBeLessThanOrEqual(reserveForUnits(10, plan1.unitPricePoints));
  });

  it("a per-record endpoint is the catalog price per record, divided by the share that passes; a call estimate is the page it asks for", () => {
    const companies = catalog.byId.get("icypeas.companies.search")!;
    const cost = unitCost(companies, catalog)!;
    expect(cost).toMatchObject({ usd: 0.00038, unit: "record" });
    expect(priceStep(cost, { rowsPerCall: 10, passRate: 1, source: "sample" }).costPerRecordUsd).toBeCloseTo(0.00038, 12);
    expect(priceStep(cost, { rowsPerCall: 10, passRate: 0.25, source: "sample" }).costPerRecordUsd).toBeCloseTo(0.00152, 12);
    expect(callEstimateUsd(cost, 10)).toBeCloseTo(0.0038, 12);
    expect(callEstimateUsd(unitCost(xEndpoint, catalog)!, 10)).toBe(0.0005);
  });

  it("a ROUTED endpoint is priced at its HIGHEST sibling, unless a measured average exists", () => {
    const routed = catalog.byId.get("treg.tiktok.search.videos")!;
    expect(routed.kind).toBe("routed");
    const worst = Math.max(...routed.siblings.map((s) => catalog.byId.get(s)?.cost?.usd ?? 0));
    expect(unitCost(routed, catalog)).toEqual({ usd: worst, unit: "call", basis: "routed_worst_sibling" });
    expect(worst).toBeGreaterThan(routed.cost!.usd!);
    expect(unitCost(routed, catalog, 0.0021)).toEqual({ usd: 0.0021, unit: "call", basis: "measured_average" });
  });

  it("an endpoint whose price cannot be turned into a price per record is NOT priceable (a character, a missing price)", () => {
    const fake = (unit: string | null, usd: number | null): CatalogEndpoint => ({ ...xEndpoint, id: "p.x", cost: { unit, usd, type: null, currency: "USD", value: usd, per: 1, billing_note: null, failed_or_empty_billed: null } });
    expect(unitCost(fake("character", 0.001), catalog)).toBeNull();
    expect(unitCost(fake("call", null), catalog)).toBeNull();
    expect(unitCost(fake("call", 0), catalog)).toBeNull();
    expect(unitCost(fake("call", 0.001), catalog)).not.toBeNull();
    // snapshot-wide: how many endpoints cannot be priced (they are never offered)
    const unpriceable = catalog.endpoints.filter((e) => unitCost(e, catalog) === null).length;
    expect(unpriceable).toBeGreaterThan(0);
    expect(unpriceable).toBeLessThan(catalog.endpoints.length / 2);
  });

  it("two stages (a listing, then one call per listed item): the listing's cost per listed item is spread over the records each item delivers", () => {
    const search = priceStep({ usd: 0.0012, unit: "call", basis: "catalog" }, { rowsPerCall: 18, passRate: 1, source: "sample" });
    const comments = priceStep({ usd: 0.001, unit: "call", basis: "catalog" }, { rowsPerCall: 20, passRate: 1, source: "sample" });
    const total = pricePlan([search, comments], 10);
    expect(total.costPerRecordUsd).toBeCloseTo(0.001 / 20 + (0.0012 / 18) / 10, 12);
    expect(total.unitPricePoints).toBe(unitPricePointsFromCost(total.costPerRecordUsd));
  });
});

describe("validation: the plan is checked against the catalog, the policy, the customer's words and the REAL sample rows", () => {
  it("a good plan validates, is priced from the sample (3 of 10 rows pass) and carries up to three masked real sample rows for the card", () => {
    const r = validatePlan(plan(), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps[0].price).toMatchObject({ rowsPerCall: 10, passRate: 0.3, measuredFrom: "sample" });
    expect(r.plan.price.unitPricePoints).toBe(unitPricePointsFromCost(0.0005 / (10 * 0.3)));
    expect(r.plan.sampleRows).toHaveLength(3);
    expect(r.plan.sampleColumns.map((c) => c.titleAr)).toEqual(["نص المنشور", "الحساب", "تاريخ النشر", "الإعجابات", "الرابط"]);
    expect(r.plan.stored.steps[0].facts).toMatchObject({ method: "POST", scope: "any_account", limitName: "limit", limitMax: 100, callEstimateUsd: 0.0005 });
    expect(r.plan.stored.measured[0]).toEqual({ rowsPerCall: 10, passRate: 0.3, costPerCallUsd: 0.0005, from: "sample" });
    expect(r.plan.sensitive).toBe(false);
    // the goal line is the model's, made safe by code
    expect(r.plan.summaryAr).toBe("جمع ١٠ منشورات من حساب @elonmusk");
  });

  it("an id the model made up is refused, whatever its source: it must be IN the customer's words (the 26 Oct failure, structurally)", () => {
    expect(codes(plan({}, { params: [{ name: "handle", value: "SaudiMOH", source: "customer_text", quote: "@elonmusk" }] }))).toContain("quote_not_in_customer_text");
    expect(codes(plan({}, { params: [{ name: "handle", value: "SaudiMOH", source: "customer_text", quote: "وزارة الصحة السعودية" }] }))).toContain("quote_not_in_customer_text");
    expect(codes(plan({}, { params: [{ name: "handle", value: "elonmusk", source: "literal" }] }))).toContain("id_like_literal");
    expect(codes(plan({}, { params: [{ name: "handle", value: "elonmusk", source: "derived", quote: "@elonmusk" }] }))).toContain("id_like_literal");
    for (const placeholder of ["<UNKNOWN>", "[ID]", "{{handle}}", "xxx", "UNKNOWN", "undefined"]) {
      expect(codes(plan({}, { params: [{ name: "handle", value: placeholder, source: "customer_text", quote: "@elonmusk" }] })), placeholder).toEqual(expect.arrayContaining([expect.stringMatching(/invented_value|quote_not_in_customer_text/)]));
    }
  });

  it("a required value the customer did not give is reported as missing, never invented", () => {
    expect(codes(plan({}, { params: [] }))).toContain("missing_required");
    expect(codes(ProposePlanSchema.parse({ summaryAr: "جمع", steps: [{ endpointId: "anyapi.x.user.posts", volume: 5, params: [{ name: "handle", source: "customer_text" }], fieldMap: { columns: [{ field: "text", headerAr: "نص" }] } }] }))).toEqual(expect.arrayContaining(["no_provenance"]));
  });

  it("(a) NO date window unless the customer's own words state one: a period parameter or a date_window filter with no stated period is refused", () => {
    // the TikTok topic request of the live check: «30 comments about basketball in Egypt» states no period
    const request = "هات ٣٠ تعليق تيك توك عن كرة السلة في مصر";
    const search = catalog.byId.get("anyapi.tiktok.search.videos")!;
    expect(search.inputs.some((i) => i.name === "datePosted")).toBe(true);
    const c = ctx({ customerText: request, samples: new Map() });
    const withWindow = (source: string, quote?: string, value = "this-month") => ProposePlanSchema.parse({
      summaryAr: "جمع تعليقات", steps: [{ endpointId: "anyapi.tiktok.search.videos", volume: 30, params: [{ name: "query", value: "كرة السلة في مصر", source: "customer_text", quote: "كرة السلة في مصر" }, { name: "datePosted", value, source, ...(quote ? { quote } : {}) }], fieldMap: { columns: [{ field: "id", headerAr: "المعرف", role: "id" }] } }],
    });
    expect(codes(withWindow("literal"), c)).toContain("window_not_stated");
    expect(codes(withWindow("derived", "آخر شهر"), c)).toContain("quote_not_in_customer_text"); // the code added «آخر شهر»: not the customer's words
    expect(codes(withWindow("derived", "كرة السلة"), c)).toContain("window_not_stated"); // a quote of the customer's words that states no period
    const dateFilter = (quote: string) => plan({ summaryAr: "جمع" }, { filters: [{ kind: "date_window", field: "createdUtc", from: "2026-09-27", to: "2026-10-27", quote, format: "unix_s" }] });
    expect(codes(dateFilter("آخر شهر"))).toContain("window_not_stated"); // «آخر شهر» is not in «أريد ١٠ منشورات من حساب @elonmusk على منصة X»
    expect(isWindowParamName("datePosted")).toBe(true);
    expect(isWindowParamName("publish_time")).toBe(true);
    expect(isWindowParamName("start_date")).toBe(true);
    expect(isWindowParamName("sortBy")).toBe(false);
    expect(isWindowParamName("order_by_date")).toBe(false);
    expect(isWindowParamName("query")).toBe(false);
  });

  it("a period the customer DID state is accepted only with their own words and the right dates", () => {
    const text = "أريد ١٠ منشورات من حساب @elonmusk على منصة X آخر شهر";
    expect(statedWindowOf("آخر شهر", TODAY)).toEqual({ from: "2026-09-27", to: "2026-10-27" });
    expect(statedWindowOf("أريد ١٠ منشورات", TODAY)).toBeNull();
    const win = (from: string, to: string, quote = "آخر شهر") => plan({}, { filters: [{ kind: "author_equals", field: "authorHandle", value: "elonmusk", quote: "@elonmusk" }, { kind: "date_window", field: "createdUtc", from, to, quote, format: "unix_s" }] });
    const ok = validatePlan(win("2026-09-27", "2026-10-27"), ctx({ customerText: text }));
    expect(ok.ok).toBe(true);
    expect(codes(win("2026-08-01", "2026-10-27"), ctx({ customerText: text }))).toContain("bad_filter");
    expect(quoteIsFromCustomer("آخر شهر", text)).toBe(true);
    expect(quoteIsFromCustomer("آخر أسبوع", text)).toBe(false);
  });

  it("the endpoint's own input schema decides: unknown parameter, type, allowed values, range, required", () => {
    expect(codes(plan({}, { params: [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }, { name: "username", value: "x", source: "literal" }] }))).toContain("unknown_param");
    const limit = xEndpoint.inputs.find((i) => i.name === "limit")!;
    expect(checkParamValue(limit, 50)).toBeNull();
    expect(checkParamValue(limit, 500)).toMatchObject({ code: "bad_param_range" });
    expect(checkParamValue(limit, "abc")).toMatchObject({ code: "bad_param_type" });
    expect(checkParamValue(limit, 2.5)).toMatchObject({ code: "bad_param_type" });
    expect(checkParamValue({ ...limit, type: "string", enum: ["a", "b"], maximum: null }, "c")).toMatchObject({ code: "bad_param_enum" });
    expect(checkParamValue({ ...limit, type: "boolean", maximum: null }, "maybe")).toMatchObject({ code: "bad_param_type" });
  });

  it("an endpoint that is not in the catalog, a write action, a paused provider and a private-messaging deep link are never planned", () => {
    for (const id of ["x.y.z", "anyapi.x.not-there", "openmart.deny-rules.create", "apollo.people.search", "tikhub.x.tiktok-app-v3-open-tiktok-app-to-send-private-message"]) {
      const bad = plan({}, { endpointId: id });
      const r = validatePlan(bad, ctx());
      expect(r.ok, id).toBe(false);
      expect(r.ok ? [] : r.issues.map((i) => i.code), id).toEqual(expect.arrayContaining([expect.stringMatching(/unknown_endpoint|not_allowed/)]));
    }
  });

  it("the field map is checked against the REAL rows: a path no row has, a filter on a missing field, a list path that is not the list, a field that is not a date", () => {
    expect(codes(plan({}, { fieldMap: { columns: [{ field: "no.such.field", headerAr: "غير موجود" }], pagination: { kind: "single" } } }))).toContain("bad_field_path");
    expect(codes(plan({}, { filters: [{ kind: "exclude_true", field: "nothing" }] }))).toContain("bad_filter");
    expect(codes(plan({}, { filters: [{ kind: "exclude_true", field: "text" }] }))).toContain("bad_filter");
    expect(codes(plan({}, { fieldMap: { rowsPath: "wrong.path", columns: [{ field: "text", headerAr: "نص" }], pagination: { kind: "single" } } }))).toContain("bad_rows_path");
    expect(codes(plan({}, { fieldMap: { columns: [{ field: "lang", headerAr: "تاريخ", role: "date" }], pagination: { kind: "single" } } }))).toContain("bad_transform");
    expect(codes(plan({}, { fieldMap: { columns: [{ field: "text", headerAr: "نص" }], pagination: { kind: "token", param: "no_such_param" } } }))).toContain("bad_pagination");
  });

  it("a sample where NONE of the rows pass the filters is not priced: the model is told; a plan with no sample at all is told to sample first", () => {
    const stranger = xRows.map((r) => ({ ...r, authorHandle: "someoneelse" }));
    expect(codes(plan(), ctx({ samples: new Map([["anyapi.x.user.posts", sampleOf("anyapi.x.user.posts", stranger)]]) }))).toContain("zero_pass_rate");
    const noSample = validatePlan(plan(), ctx({ samples: new Map() }));
    // the catalog's own example of this endpoint has no author field: the filter cannot be checked against anything
    expect(noSample.ok).toBe(false);
  });

  it("NEVER PRICED FROM A CATALOG EXAMPLE: a per-call endpoint with no real sample (and no recipe) is refused with `needs_real_sample`; the example is trimmed to one item and says nothing about rows per call", () => {
    const customerText = "أريد ٥ تغريدات عن AI trenches على منصة X";
    const p = ProposePlanSchema.parse({
      summaryAr: "جمع ٥ تغريدات عن AI trenches", topic: "AI trenches",
      steps: [{ endpointId: "anyapi.x.search.posts", volume: 5, params: [{ name: "query", value: "AI trenches", source: "customer_text", quote: "AI trenches" }], fieldMap: { columns: [{ field: "text", headerAr: "نص التغريدة", role: "text" }, { field: "authorUsername", headerAr: "الحساب", role: "author_handle" }], pagination: { kind: "token", param: "cursor" } } }],
    });
    expect(catalog.byId.get("anyapi.x.search.posts")!.cost?.unit).toBe("call");
    const r = validatePlan(p, ctx({ customerText, samples: new Map() }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(["needs_real_sample"]);
    expect(r.issues[0].message).toMatch(/sample_call/);
    // with a REAL sample the same plan is priced, from the rows that call returned
    const row = { text: "ai trenches are here", authorUsername: "someone", createdUtc: 1790000000 };
    const sample = { endpointId: "anyapi.x.search.posts", rows: Array.from({ length: 4 }, () => row), digest: buildShapeDigest({ rows: [row] }, catalog.byId.get("anyapi.x.search.posts")!).digest, costUsd: 0.00075 };
    const ok = validatePlan(p, ctx({ customerText, samples: new Map([["anyapi.x.search.posts", sample]]) }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.plan.steps[0].price).toMatchObject({ rowsPerCall: 4, passRate: 1, measuredFrom: "sample" });
  });

  it("a per-RECORD catalog unit is priced from the catalog (no sample needed); the card still shows no row (only a real sample's rows are shown)", () => {
    const e = catalog.byId.get("icypeas.companies.search")!;
    expect(e.cost?.unit).toBe("result");
    const customerText = "أريد ١٠ شركات تقنية";
    const p = ProposePlanSchema.parse({
      summaryAr: "جمع ١٠ شركات تقنية", topic: "شركات تقنية",
      steps: [{ endpointId: "icypeas.companies.search", volume: 10, params: [{ name: "query", value: { industry: { include: ["Technology"] } }, source: "derived", quote: "شركات تقنية" }], fieldMap: { columns: [{ field: "name", headerAr: "اسم الشركة", role: "company" }], pagination: { kind: "single" } } }],
    });
    const r = validatePlan(p, ctx({ customerText, samples: new Map() }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps[0].price).toMatchObject({ rowsPerCall: 1, passRate: 1, measuredFrom: "catalog_unit" });
    expect(r.plan.price.costPerRecordUsd).toBeCloseTo(e.cost!.usd!, 12);
    expect(r.plan.sampleRows).toEqual([]);
  });

  it("two stages: step 2 must take a value from step 1's rows, and only a field step 1 maps", () => {
    const c = ctx({ customerText: "هات ٣٠ تعليق تيك توك عن كرة السلة", samples: new Map() });
    const two = (fromField: string) => ProposePlanSchema.parse({
      summaryAr: "جمع تعليقات", topic: "كرة السلة",
      steps: [
        { endpointId: "anyapi.tiktok.search.videos", volume: 30, params: [{ name: "query", value: "كرة السلة", source: "customer_text", quote: "كرة السلة" }], fieldMap: { columns: [{ field: "id", headerAr: "المعرف", role: "id" }, { field: "caption", headerAr: "الوصف", role: "title" }], pagination: { kind: "token", param: "cursor" } } },
        { endpointId: "tikhub.tiktok.video.comments", volume: 30, params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: fromField } }], fieldMap: { columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }], pagination: { kind: "single" } } },
      ],
    });
    const bad = validatePlan(two("not_mapped"), c);
    expect(bad.ok ? [] : bad.issues.map((i) => i.code)).toContain("bad_step_reference");
    const oneStepWithPrior = validatePlan(ProposePlanSchema.parse({ summaryAr: "جمع", steps: [{ endpointId: "tikhub.tiktok.video.comments", volume: 5, params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }], fieldMap: { columns: [{ field: "text", headerAr: "نص" }] } }] }), c);
    expect(oneStepWithPrior.ok).toBe(false);
  });

  it("the plan card's goal line never states money, a provider or an endpoint, and keeps Arabic-Indic digits", () => {
    const text = "أريد ١٠ منشورات من حساب @elonmusk";
    expect(safeSummaryAr("جمع 10 منشورات من حساب @elonmusk", 10, text)).toBe("جمع ١٠ منشورات من حساب @elonmusk");
    expect(safeSummaryAr("جمع ١٠ منشورات بسعر ٥ نقاط", 10, text)).toBe("جمع ١٠ سجل حسب طلبك");
    expect(safeSummaryAr("جمع من anyapi.x.user.posts", 10, text)).toBe("جمع ١٠ سجل حسب طلبك");
    expect(safeSummaryAr("جمع عبر Tikhub", 10, text)).toBe("جمع ١٠ سجل حسب طلبك");
    expect(safeSummaryAr("**جمع** 😀 المنشورات", 10, text)).toBe("جمع المنشورات");
    expect(safeSummaryAr("collect ten posts", 10, text)).toBe("جمع ١٠ سجل حسب طلبك");
  });
});

describe("the tools the model gets", () => {
  it("are exactly catalog_search, describe_endpoint, sample_call, propose_plan; no tool takes or returns a price field the plan could carry", () => {
    const tools = anthropicToolDefinitions();
    expect(tools.map((t) => t.name)).toEqual(["catalog_search", "describe_endpoint", "sample_call", "propose_plan"]);
    const schema = JSON.stringify(proposePlanJsonSchema());
    expect(schema).not.toMatch(/price|points|cost|usd/i);
    expect(schema).toContain("customer_text");
    expect(schema).not.toContain("$schema");
    expect(JSON.stringify(tools)).not.toMatch(/"oneOf"/);
  });

  it("catalog_search never lists an endpoint the account may not use, and says when the best match is restricted", () => {
    const none = { isAdmin: false, verifiedBusiness: false };
    const hits = toolCatalogSearch({ words: ["reverse", "phone"] }, none, catalog);
    expect(hits.hits.map((h: any) => h.id)).not.toContain("enrichlayer.contacts.reverse-phone");
    expect(hits.restrictedTop).toBe(true);
    const allowed = toolCatalogSearch({ words: ["reverse", "phone"], limit: 10 }, { isAdmin: false, verifiedBusiness: true }, catalog);
    expect(allowed.hits.map((h: any) => h.id)).toContain("enrichlayer.contacts.reverse-phone");
    expect(allowed.restrictedTop).toBe(false);
    for (const h of toolCatalogSearch({ platform: "x", words: ["posts"] }, none, catalog).hits) expect(unitCost(catalog.byId.get(h.id as string)!, catalog), String(h.id)).not.toBeNull();
    const none2 = toolCatalogSearch({ words: ["send", "message"] }, none, catalog);
    for (const h of none2.hits) expect(String(h.id)).not.toMatch(/private-message/);
  });

  it("describe_endpoint answers for an allowed endpoint and refuses a sensitive one for an account that may not use it, a write action and an unknown id", () => {
    const none = { isAdmin: false, verifiedBusiness: false };
    const ok = toolDescribeEndpoint({ id: "anyapi.x.user.posts" }, none, catalog);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.endpoint.inputs as any[]).map((i) => i.name)).toEqual(["cursor", "handle", "limit"]);
    expect(toolDescribeEndpoint({ id: "blitzapi.people.phone.reverse" }, none, catalog)).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(toolDescribeEndpoint({ id: "blitzapi.people.phone.reverse" }, { isAdmin: true, verifiedBusiness: false }, catalog).ok).toBe(true);
    expect(toolDescribeEndpoint({ id: "openmart.deny-rules.create" }, { isAdmin: true, verifiedBusiness: true }, catalog)).toMatchObject({ ok: false });
    expect(toolDescribeEndpoint({ id: "nope.nope" }, none, catalog)).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("the digest of a REAL answer lists the list path, the fields with their types and how many rows carry them, and three masked rows", () => {
    const { digest } = buildShapeDigest({ rows: [...xRows, { text: "mail me at someone@example.com or +20 100 123 4567" }] }, xEndpoint);
    expect(digest.listPath).toBe("rows");
    expect(digest.rowsInSample).toBe(11);
    expect(digest.fields.find((f) => f.path === "authorHandle")).toMatchObject({ type: "string", presentIn: 10 });
    expect(digest.sampleRows).toHaveLength(3);
    const masked = buildShapeDigest({ rows: [{ text: "mail me at someone@example.com or +20 100 123 4567" }] }, xEndpoint).digest;
    expect(JSON.stringify(masked.sampleRows)).not.toContain("someone@example.com");
    expect(JSON.stringify(masked.sampleRows)).not.toContain("123 4567");
    expect(digestFields([{ a: { b: 1, c: null }, d: "" }]).map((f) => [f.path, f.presentIn])).toEqual([["a.b", 1], ["a.c", 0], ["d", 0]]);
    expect(digestFromCatalogExample(xEndpoint)?.digest.rowsInSample).toBeGreaterThanOrEqual(1);
  });
});
