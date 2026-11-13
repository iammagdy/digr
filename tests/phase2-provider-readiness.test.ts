import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict, type AccountAccess } from "../src/lib/treg/dataPolicy";
import {
  buildCapabilityRegistry, discoverCapabilities, researchNeedOf, stagesOfNeed, withEnrichmentStage, readWebViaTregFlag, WEB_VIA_TREG_FLAG_KEY, ENRICH_STAGE_KEY, availableKindsAr,
  subListSchema, tregPricingOf, type RegistryAvailability,
} from "../src/lib/agentMission/capabilities";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createWebGateway } from "../agent/src/webGateway";
import { fakeRecorder, makeHarness, NOT_ADMIN, tregResult, USER_ID } from "./helpers/agentHarness";
import { fakeContextDev } from "./helpers/fakeContextDev";

/**
 * PHASE 2, PROVIDER INTEGRATION READINESS, OFFLINE ACCEPTANCE (docs/intelligence/PHASES-2-4-BASELINE.md, task 2.5 A–J). Every provider answer here is a FAKE built on the documented shapes (labelled SIMULATED); the catalog,
 * the data policy and the block list are the real repository files. No network: `fetch` throws.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const catalog = loadTregCatalog();
const allowedFor = (access: AccountAccess | null) => (id: string) => !blockedEndpointReason(id) && policyVerdict(id, access).allowed;
const registryOf = (extra: Partial<RegistryAvailability> = {}, access: AccountAccess | null = NOT_ADMIN) => buildCapabilityRegistry(catalog, { isAllowed: allowedFor(access), webKeys: { firecrawl: true, contextdev: true }, dailyCapUsd: { firecrawl: 1, contextdev: 1 }, ...extra });
const byId = (reg: ReturnType<typeof registryOf>, id: string) => reg.all.find((c) => c.id === id)!;

function webSetup(options: { key?: string | null; fake?: Parameters<typeof fakeContextDev>[0]; dailyCap?: number } = {}) {
  const store = createMemoryStore();
  const mission = newMission({ id: "msn_p2web001", user_id: USER_ID, status: "planning" });
  store.missions.set(mission.id, mission);
  const rec = fakeRecorder({ dailyCapUsd: options.dailyCap });
  const world = fakeContextDev(options.fake);
  const budget = createJobCallBudget({ ceilingUsd: 0.1, spentUsd: 0 });
  const web = createWebGateway({ store, missionId: mission.id, jobId: null, phase: "planning", budget, recorder: rec.recorder, providerKey: async () => (options.key === undefined ? "key-for-test" : options.key), fetchFn: world.fetchFn as any, counter: { seq: 0 } });
  return { store, rec, world, budget, web };
}

describe("2.1 the four audit ids, as the CURRENT snapshot describes them", () => {
  it("exist, are public, and reach the registry with the right operation, access and pricing basis", () => {
    const reg = registryOf();
    for (const id of ["treg.web.extract", "branddev.brand.retrieve-by-name", "branddev.web.search", "firecrawl.web.search"]) {
      expect(catalog.byId.get(id), id).toBeTruthy();
      expect(policyVerdict(id, NOT_ADMIN).allowed, id).toBe(true);
    }
    expect(byId(reg, "treg.web.extract")).toMatchObject({ operation: "web.read", access: "treg_routed", pricing: { basis: "estimated", billedOnFailure: true } });
    expect(byId(reg, "branddev.brand.retrieve-by-name")).toMatchObject({ operation: "company.enrich", access: "treg_direct", takes: ["company_name"], pricing: { basis: "verified", usd: 0.02534, billedOnFailure: false } });
    expect(byId(reg, "branddev.web.search")).toMatchObject({ operation: "web.search", access: "treg_direct", pricing: { basis: "verified" } });
    expect(byId(reg, "firecrawl.web.search")).toMatchObject({ operation: "web.search", access: "treg_direct", pricing: { basis: "verified" } });
  });

  it("a sub-list schema (brand colours, page headings) is NOT read as the record's outputs: they stay unknown", () => {
    const reg = registryOf();
    // branddev.brand.retrieve-by-name documents `brand.colors` items (hex/name/source): those are colours, not the company
    expect(subListSchema(catalog.byId.get("branddev.brand.retrieve-by-name")!, "company.enrich")).toBe(true);
    expect(byId(reg, "branddev.brand.retrieve-by-name")).toMatchObject({ outputsKnown: false, outputs: [] });
    // branddev.web.scrape documents `metadata.headings` (level/text): the headings, not the page text (before this round it counted as PROVEN page text)
    expect(byId(reg, "branddev.web.scrape")).toMatchObject({ outputsKnown: false, outputs: [] });
    // a batch whose list IS the pages still documents them
    expect(byId(reg, "limadata.web.extract").outputsKnown).toBe(true);
    // the rule is only for one-record operations: a search's list is its results
    expect(subListSchema(catalog.byId.get("branddev.web.search")!, "web.search")).toBe(false);
  });

  it("enrichment is an internal step: never offered to the customer as a kind of data", () => {
    expect(availableKindsAr(registryOf()).join("\n")).not.toContain("المواقع الرسمية للشركات");
  });
});

describe("2.5 offline acceptance A–J", () => {
  it("A. company discovery through TREG: the selected source is a TREG endpoint; its call passes every gateway check and is traced to its cost record", async () => {
    const d = discoverCapabilities(researchNeedOf({ request: "عايز ٥٠ شركة مقاولات في مصر" }), registryOf());
    expect(d.status).toBe("supported");
    const companies = d.stages.find((s) => s.stage.key === "companies")!;
    const pick = companies.eligible.find((e) => e.provider === "treg" && catalog.byId.get(e.id)?.inputs.some((i) => i.required))!;
    expect(pick).toBeTruthy();
    const ep = catalog.byId.get(pick.id)!;
    const params = Object.fromEntries(ep.inputs.filter((i) => i.required).map((i) => [i.name, i.type === "number" || i.type === "integer" ? 10 : "construction"]));
    const h = makeHarness({ responses: [tregResult({ data: [{ id: "c1", name: "شركة مقاولات (SIMULATED)", website: "https://c1.example" }] }, 0.001)] });
    const r: any = await h.gateway.tregCall({ endpoint_id: pick.id, params });
    expect(r.ok).toBe(true);
    expect(h.call).toHaveBeenCalledTimes(1);
    expect(h.providerCosts).toHaveLength(1);
    expect(h.store.calls[0]).toMatchObject({ mission_id: h.mission.id, endpoint_id: pick.id, phase: "planning", status: "ok", provider_cost_id: h.providerCosts[0].costId });
  });

  it("B. company website enrichment through TREG-resold capabilities, ONLY with `web_via_treg`: companies → official website → contacts", async () => {
    // no companies source documents a website for this account: the enrichment step is the only way to the websites
    const noDocumentedWebsite = (id: string) => { const c = catalog.byId.get(id); return !(c && /^companies\.(search|businesses\.search)$|^linkedin\.search\.companies$/.test(String(c.capability)) && c.item_fields && Object.keys(c.item_fields).some((f) => /website|domain|^urls?$/i.test(f))); };
    // (Context.dev's maps parser also documents websites: without its key, only TREG serves the companies; contacts come from TREG's company e-mail sources)
    const reg = buildCapabilityRegistry(catalog, { isAllowed: (id) => allowedFor(NOT_ADMIN)(id) && noDocumentedWebsite(id), webKeys: { firecrawl: false, contextdev: false } });
    const need = researchNeedOf({ request: "شركات تسويق في دبي والإيميلات الرسمية اللي على مواقعهم" });
    const off = discoverCapabilities(need, reg);
    const on = discoverCapabilities(need, reg, { enrichWebsites: true });
    // OFF: exactly the chain of before (no enrichment stage)
    expect(off.stages.map((s) => s.stage)).toEqual(stagesOfNeed(need));
    expect(off.stages.some((s) => s.stage.operation === "company.enrich")).toBe(false);
    // ON: the enrichment step sits between the companies and their contacts, fed by the company's NAME
    const enrich = on.stages.find((s) => s.stage.key === ENRICH_STAGE_KEY)!;
    expect(enrich.stage).toMatchObject({ operation: "company.enrich", parentKey: "companies", requires: ["website"], accepts: ["company_name"] });
    expect(on.stages.find((s) => s.stage.key === "company_emails")!.stage.parentKey).toBe(ENRICH_STAGE_KEY);
    expect(enrich.eligible.map((e) => e.id)).toContain("branddev.brand.retrieve-by-name");
    // a source that DOCUMENTS the website ranks before the brand API, whose record fields the snapshot does not document (unknown: proved on a sample, never claimed)
    const brand = enrich.eligible.find((e) => e.id === "branddev.brand.retrieve-by-name")!;
    expect(brand.outputsVerified).toBe(false);
    expect(enrich.eligible[0].outputsVerified).toBe(true);
    expect(enrich.eligible[0].rank).toBeLessThan(brand.rank);
    expect(enrich.link).toEqual({ from: "name", to: "company_name" });
    // the call goes through the EXISTING TREG gateway (no new key): budget, cap reservation, recording
    const h = makeHarness({ responses: [tregResult({ brand: { domain: "acme.example", title: "Acme (SIMULATED)", colors: [{ hex: "#000000", name: "Black", source: "logo" }] } }, 0.02534)] });
    const r: any = await h.gateway.tregCall({ endpoint_id: "branddev.brand.retrieve-by-name", params: { name: "Acme Marketing", country_gl: "ae" } });
    expect(r.ok).toBe(true);
    expect(h.call.mock.calls[0][0]).toMatchObject({ endpointId: "branddev.brand.retrieve-by-name" });
    expect(h.store.calls[0]).toMatchObject({ status: "ok", provider_cost_id: 1, storage_path: "raw/call_0001.json" });
    // FINDING (pinned): the gateway reads this endpoint's rows at the catalog's `brand.colors`, so its row count is the brand's COLOURS, not the company. The record (domain) is in the saved raw answer only. This is why the
    // registry keeps its outputs UNKNOWN, and why Diger's own reliability report must not read `rows_returned` of this endpoint as usable companies.
    expect(h.store.calls[0].rows_returned).toBe(1);
    expect(JSON.parse((await h.store.getFile(h.mission.id, "raw/call_0001.json"))!)).toMatchObject({ brand: { domain: "acme.example" } });
    // the same family's sensitive sibling (brand by an e-mail) stays refused for a normal account, by the data policy, before any call
    const s = makeHarness();
    const refused: any = await s.gateway.tregCall({ endpoint_id: "branddev.brand.retrieve-by-email", params: { email: "x@y.example" } });
    expect(refused).toMatchObject({ ok: false, refused: "sensitive_not_allowed" });
    expect(s.call).not.toHaveBeenCalled();
  });

  it("B'. when a companies source documents websites, the switch adds nothing (no paid step that is not needed)", () => {
    const reg = registryOf();
    const need = researchNeedOf({ request: "عايز ٥٠ شركة مقاولات في مصر ومواقعها الرسمية" });
    expect(withEnrichmentStage(stagesOfNeed(need), reg)).toEqual(stagesOfNeed(need));
  });

  it("the switch is read like every scoped switch and is OFF unless set", () => {
    expect(readWebViaTregFlag({}, USER_ID)).toBe(false);
    expect(readWebViaTregFlag({ [WEB_VIA_TREG_FLAG_KEY]: { user_ids: [USER_ID] } }, USER_ID)).toBe(true);
    expect(readWebViaTregFlag({ [WEB_VIA_TREG_FLAG_KEY]: { user_ids: [USER_ID] } }, "someone-else")).toBe(false);
    expect(readWebViaTregFlag({ [WEB_VIA_TREG_FLAG_KEY]: "off" }, USER_ID)).toBe(false);
  });

  it("C. web search with Context.dev (direct): documented request, recorded charge, call traced to its provider_costs row", async () => {
    const t = webSetup({ fake: { search: () => [{ url: "https://news.example/a", title: "خبر (SIMULATED)", description: "..." }] } });
    const r: any = await t.web.webSearch({ provider: "contextdev", query: "السياحة في مصر", limit: 10 });
    expect(r.ok).toBe(true);
    expect(t.world.requests[0].url).toContain("context.dev");
    expect(t.rec.rows).toHaveLength(1);
    expect(t.store.calls[0]).toMatchObject({ endpoint_id: "contextdev.search", status: "ok", provider_cost_id: t.rec.rows[0].costId });
  });

  it("D. web search with Firecrawl (direct): the same rules, its own provider and cost record", async () => {
    const t = webSetup({ fake: { search: () => [{ url: "https://news.example/b", title: "خبر (SIMULATED)", description: "..." }] } });
    const r: any = await t.web.webSearch({ provider: "firecrawl", query: "السياحة في مصر", limit: 10 });
    expect(r.ok).toBe(true);
    expect(t.world.requests[0].url).toContain("firecrawl");
    expect(t.rec.rows[0]).toMatchObject({ provider: "firecrawl" });
    expect(t.store.calls[0]).toMatchObject({ endpoint_id: "firecrawl.search", provider_cost_id: t.rec.rows[0].costId });
  });

  it("E. public page extraction: a public page is read; a private address is refused before any request", async () => {
    const t = webSetup({ fake: { scrape: () => ({ markdown: "# صفحة عامة (SIMULATED)\nنص الصفحة بطول كافٍ لقراءته كنص صفحة عامة حقيقي مع روابط.", credits: 1 }) } });
    const ok: any = await t.web.webScrape({ provider: "contextdev", url: "https://company.example/about" });
    expect(ok.ok).toBe(true);
    expect(t.store.calls[0].provider_cost_id).toBe(t.rec.rows[0].costId);
    const bad: any = await t.web.webScrape({ provider: "contextdev", url: "http://localhost/admin" });
    expect(bad).toMatchObject({ ok: false, refused: "bad_url" });
    expect(t.world.requests).toHaveLength(1);
  });

  it("F. a missing provider key: its capabilities are unavailable, discovery never selects them, and a call is refused before any request", async () => {
    const reg = registryOf({ webKeys: { firecrawl: false, contextdev: false } });
    expect(reg.all.filter((c) => c.provider !== "treg").every((c) => c.unavailable === "provider_key_missing")).toBe(true);
    const d = discoverCapabilities(researchNeedOf({ request: "اخبار عن السياحة في مصر" }), reg);
    for (const s of d.stages) expect(s.eligible.every((e) => e.provider === "treg")).toBe(true);
    const t = webSetup({ key: null });
    const r: any = await t.web.webSearch({ provider: "contextdev", query: "السياحة في مصر" });
    expect(r).toMatchObject({ ok: false, refused: "source_unavailable" });
    expect(t.world.requests).toHaveLength(0);
    expect(t.rec.rows).toHaveLength(0);
  });

  it("G. an EXHAUSTED daily cap (not only a cap of 0): the provider is unavailable for planning; TREG's own cap counts too; the recorder still refuses at call time", async () => {
    const web = registryOf({ dailyCapUsd: { firecrawl: 1, contextdev: 1 }, spentTodayUsd: { firecrawl: 1, contextdev: 0.2 } });
    expect(byId(web, "firecrawl.search").unavailable).toBe("provider_daily_cap_exhausted");
    expect(byId(web, "contextdev.search").unavailable).toBeNull();
    const treg = registryOf({ tregDailyCapUsd: 0.8, spentTodayUsd: { treg: 0.85 } });
    expect(treg.all.filter((c) => c.provider === "treg").every((c) => c.unavailable === "provider_daily_cap_exhausted" || c.unavailable === "not_sellable" || c.unavailable === "not_permitted")).toBe(true);
    // the companies are then served only by a provider whose cap has room (Context.dev's maps parser); with that one unavailable too, nothing is promised
    const d0 = discoverCapabilities(researchNeedOf({ request: "عايز ٥٠ شركة مقاولات في مصر" }), treg);
    expect(d0.stages[0].eligible.every((e) => e.provider !== "treg")).toBe(true);
    const none = registryOf({ tregDailyCapUsd: 0.8, spentTodayUsd: { treg: 0.85, contextdev: 1 } });
    const d = discoverCapabilities(researchNeedOf({ request: "عايز ٥٠ شركة مقاولات في مصر" }), none);
    expect(d.status).toBe("unsupported");
    expect(d.unsupported[0].reason).toBe("provider_unavailable");
    expect(d.messageAr).toContain("غير متاح الآن");
    // an unreadable spend (null) is UNKNOWN, never taken as 0 or as exhausted
    expect(byId(registryOf({ tregDailyCapUsd: 0.8, spentTodayUsd: { treg: null } }), "branddev.web.search").unavailable).toBeNull();
    // call time is unchanged: the recorder's own cap refuses
    const t = webSetup({ dailyCap: 0, fake: { search: () => [] } });
    const r: any = await t.web.webSearch({ provider: "contextdev", query: "السياحة في مصر" });
    expect(r).toMatchObject({ ok: false, refused: "daily_cap" });
    expect(t.world.requests).toHaveLength(0);
  });

  it("H. a provider timeout or error: the call is failed, its estimate stays counted (never assumed free), and the row is traced", async () => {
    const thrower = webSetup();
    (thrower.world.fetchFn as any).mockImplementation(async () => { throw new Error("socket hang up (SIMULATED)"); });
    const a: any = await thrower.web.webSearch({ provider: "contextdev", query: "السياحة في مصر" });
    expect(a.ok).toBe(false);
    // the mission's budget keeps the estimate, and the call row says the charge is UNKNOWN (never «free»)
    expect(thrower.budget.spentUsd()).toBeGreaterThan(0);
    expect(thrower.store.calls[0]).toMatchObject({ status: "failed", provider_cost_id: thrower.rec.rows[0].costId });
    expect(thrower.store.calls[0].params_digest).toMatchObject({ charge_unknown: true });
    // KNOWN GAP (owner decision, docs/intelligence/PHASES-2-4-ACCEPTANCE.md): the shared httpCall commits 0 to provider_costs for an unanswered call, which gives its room back to the provider's daily cap. The TREG gateway
    // commits the estimate. Changing it changes the provider spend-cap accounting, so it is NOT changed here; this assertion pins today's behaviour so a change is a reviewed one.
    expect(thrower.rec.rows[0].committedUsd).toBe(0);
    // TREG: a call that timed out keeps its estimate too
    const h = makeHarness({ responses: [tregResult(null, 0, { ok: false, timedOut: true, error: "timeout", httpStatus: 0 } as any)] });
    const r: any = await h.gateway.tregCall({ endpoint_id: "branddev.web.search", params: { query: "x", numResults: 10 } });
    expect(r.ok).toBe(false);
    expect(Number(h.store.calls[0].cost_usd)).toBeGreaterThan(0);
  });

  it("I. an unpriced or routed operation is labelled honestly; an unpriced capability never ranks above a priced one", () => {
    const reg = registryOf();
    const crunchbase = byId(reg, "crunchbase.companies.enrich");
    expect(crunchbase.pricing.basis).toBe("unknown");
    expect(crunchbase.usdPerRow).toBeNull();
    expect(tregPricingOf(catalog.byId.get("treg.web.search")!)).toMatchObject({ basis: "estimated", billedOnFailure: true });
    // the direct providers' USD figures are credits × a dated per-credit figure: estimates, never verified
    for (const id of ["firecrawl.search", "contextdev.search", "contextdev.scrape", "contextdev.parse.emails"]) expect(byId(reg, id).pricing.basis, id).toBe("estimated");
    const enrich = discoverCapabilities(researchNeedOf({ request: "شركات تسويق في دبي والإيميلات الرسمية" }), reg, { enrichWebsites: true });
    // within the same ability, an unpriced candidate is never ranked before a priced one
    const ability = (e: (typeof enrich.stages)[number]["eligible"][number]) => [e.outputsVerified, e.feedsChild, e.reachesVolume, e.filtersCovered.length, e.preferredOutputs].join("|");
    let pairs = 0;
    for (const s of enrich.stages) {
      for (let i = 1; i < s.eligible.length; i += 1) {
        const [a, b] = [s.eligible[i - 1], s.eligible[i]];
        if (ability(a) === ability(b) && a.usdPerRow === null) { pairs += 1; expect(b.usdPerRow, `${s.stage.key}: ${a.id} before ${b.id}`).toBeNull(); }
      }
    }
    expect(enrich.stages.some((s) => s.eligible.some((e) => e.usdPerRow === null))).toBe(true);
    // an unsupported platform is said honestly, no mission
    const snap = discoverCapabilities(researchNeedOf({ request: "تعليقات سناب شات عن السياحة" }), reg);
    expect(snap.status).toBe("unsupported");
    expect(snap.messageAr).toContain("سناب شات");
  });

  it("J. a privacy-blocked capability: never available to a normal account, never mapped when private, and a private request is blocked", async () => {
    const reg = registryOf();
    expect(byId(reg, "branddev.brand.retrieve-by-email").unavailable).toBe("not_permitted");
    expect(reg.all.some((c) => /people\.(profile\.from_phone|identity\.from_email)/.test(String(catalog.byId.get(c.id)?.capability)))).toBe(false);
    const d = discoverCapabilities(researchNeedOf({ request: "عايز أرقام موبايلات الناس اللي علقوا على البوست ده" }), reg);
    expect(d.status).toBe("blocked");
    expect(d.stages).toHaveLength(0);
  });
});
