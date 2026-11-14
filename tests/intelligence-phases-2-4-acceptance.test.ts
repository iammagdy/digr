import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import {
  buildCapabilityRegistry, capabilitySelectionOf, chainBindingIssues, discoverCapabilities, limitationLinesAr, mixesSocialAndOther, researchNeedOf, safeFallback, verifyApprovedScope,
  type CapabilityDiscovery, type CapabilityRegistry, type RegistryAvailability,
} from "../src/lib/agentMission/capabilities";
import { loadRegistryArtifact, minLevelFor, routingFactsOf } from "../src/lib/agentMission/capabilities/routingFacts";
import { diffRegistries } from "../src/lib/agentMission/capabilities/registryDiff";
import { levelRank } from "../src/lib/agentMission/capabilities/evidence";
import type { RegistryArtifact } from "../src/lib/agentMission/capabilities/artifact";
import type { BriefObjective } from "../src/lib/agentMission/researchBrief";
import { PROVIDER_LABELS } from "../src/lib/agentMission/providerLabels";

/**
 * PHASES 2–4, CROSS-PHASE ACCEPTANCE (docs/intelligence/PHASES-2-4-ACCEPTANCE.md). Offline and deterministic: the request → understanding → discovery → router → validated selection → approval-boundary path, over the REAL catalog snapshot,
 * the REAL data policy, the REAL hand cards and the REAL reviewed registry artifact (whose live evidence is Diger's own recorded calls). No provider answer is used here except where a journey says SIMULATED; no network (fetch throws).
 *
 * Router facts: «production» = a normal customer account (production-eligible capabilities only); «test» = a test account (fixture- or live-verified). Every journey also runs the cross-cutting invariants (`assertHonest`).
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const catalog = loadTregCatalog();
const artifact = loadRegistryArtifact();
const allowed = (id: string) => !blockedEndpointReason(id) && policyVerdict(id, { isAdmin: false, verifiedBusiness: false }).allowed;
const registryOf = (extra: Partial<RegistryAvailability> = {}): CapabilityRegistry => buildCapabilityRegistry(catalog, { isAllowed: allowed, webKeys: { firecrawl: true, contextdev: true }, dailyCapUsd: { firecrawl: 1, contextdev: 1 }, handCards: true, extendedFamilies: true, ...extra });
const REG = registryOf();
const facts = (account: "production" | "test") => routingFactsOf(artifact, { minLevel: minLevelFor(account === "test") });
const levelOf = (id: string, op: string) => artifact.capabilities.find((c) => c.id === id && c.operation === op)?.verification.level ?? "advertised";

function route(request: string, account: "production" | "test", o: { answer?: string; brief?: Parameters<typeof researchNeedOf>[0]["brief"]; registry?: CapabilityRegistry; enrichWebsites?: boolean } = {}): CapabilityDiscovery {
  const need = researchNeedOf({ request, ...(o.answer ? { answer: o.answer } : {}), ...(o.brief ? { brief: o.brief } : {}), extendedFamilies: true });
  const d = discoverCapabilities(need, o.registry ?? REG, { routing: facts(account), ...(o.enrichWebsites ? { enrichWebsites: true } : {}) });
  assertHonest(d, account, o.registry ?? REG);
  return d;
}

const PROVIDER_WORD = new RegExp(`(?<![a-z])(?:${PROVIDER_LABELS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-z])`, "i");
/** The invariants every routed request keeps (journeys and scenarios). */
function assertHonest(d: CapabilityDiscovery, account: "production" | "test", reg: CapabilityRegistry) {
  // no provider, endpoint, model or price in anything the customer reads
  const customer = [d.messageAr, d.alternativeAr, ...limitationLinesAr(d)].filter((x): x is string => typeof x === "string");
  for (const t of customer) {
    expect(t, t).not.toMatch(PROVIDER_WORD);
    expect(t, t).not.toMatch(/\$|USD|دولار|سنت/);
  }
  for (const s of d.stages) {
    // the code's choice is the router's first candidate; every candidate is public and at least as verified as the account allows
    expect(s.selected ?? null).toBe(s.eligible[0]?.id ?? null);
    for (const e of s.eligible) {
      const cap = reg.all.find((c) => c.id === e.id && c.operation === s.stage.operation)!;
      expect(cap.privacy, e.id).toBe("public");
      expect(levelRank(e.routed!.level), `${e.id} ${e.routed!.level}`).toBeGreaterThanOrEqual(levelRank(minLevelFor(account === "test")));
      expect(e.routed!.level).not.toBe("broken");
    }
  }
  // every dependency of the selected chain is bound by a documented field
  expect(chainBindingIssues(d.stages.filter((s) => s.selected))).toEqual([]);
  // nothing is silently lost: a supported request selects every stage; otherwise the customer is told what is missing
  if (d.status === "supported") expect(d.stages.every((s) => s.selected)).toBe(true);
  if (d.status === "partial" || d.status === "unsupported" || d.status === "blocked") expect(d.messageAr).toBeTruthy();
}

const ops = (d: CapabilityDiscovery) => d.stages.map((s) => s.stage.operation);
const sel = (d: CapabilityDiscovery, op: string) => d.stages.find((s) => s.stage.operation === op)?.selected ?? null;
const obj = (id: string, operation: BriefObjective["operation"], o: Partial<BriefObjective> = {}): BriefObjective => ({ id, operation, platform: null, parent: null, contacts: [], what: "", ...o } as BriefObjective);

// ================================================================================================================================================================================
describe("the 20 required offline journeys", () => {
  it("J1. Egyptian construction companies + their websites: the companies source must DOCUMENT websites; test account served by a measured source, a customer account told honestly", () => {
    const t = route("عايز ٥٠ شركة مقاولات في مصر ومواقعها الرسمية", "test");
    expect(t.need).toMatchObject({ kind: "companies", count: 50, conditions: { country: true } });
    expect(ops(t)).toEqual(["companies.discover"]);
    expect(t.stages[0].stage.requires).toContain("website");
    expect(t.status).toBe("supported");
    expect(t.stages[0].eligible[0].outputs).toContain("website");
    const p = route("عايز ٥٠ شركة مقاولات في مصر ومواقعها الرسمية", "production");
    expect(p.status).toBe("unsupported");
    expect(p.unsupported[0].reason).toBe("not_verified");
  });

  it("J1b. websites through the TREG-resold enrichment step (web_via_treg) when no companies source documents them: companies → official website → contacts", () => {
    const noDocumentedWebsite = (id: string) => !(String(catalog.byId.get(id)?.capability ?? "").match(/^companies\.(search|businesses\.search)$|^linkedin\.search\.companies$/) && Object.keys(catalog.byId.get(id)?.item_fields ?? {}).some((f) => /website|domain|^urls?$/i.test(f)));
    const reg = buildCapabilityRegistry(catalog, { isAllowed: (id) => allowed(id) && noDocumentedWebsite(id), webKeys: { firecrawl: false, contextdev: false }, handCards: true, extendedFamilies: true });
    const need = researchNeedOf({ request: "شركات تسويق في دبي والإيميلات الرسمية اللي على مواقعهم", extendedFamilies: true });
    const d = discoverCapabilities(need, reg, { enrichWebsites: true });
    expect(ops(d)).toEqual(["companies.discover", "company.enrich", "company.contacts"]);
    expect(d.stages[1].link).toEqual({ from: "name", to: "company_name" });
    expect(d.stages[2].stage.parentKey).toBe("company_websites");
    // under the router (test account), the enrichment step needs evidence Diger does not have yet: honestly partial, never guessed
    const routed = discoverCapabilities(need, reg, { enrichWebsites: true, routing: facts("test") });
    assertHonest(routed, "test", reg);
    expect(routed.stages.find((s) => s.stage.operation === "company.enrich")!.selected).toBeNull();
    expect(["partial", "unsupported"]).toContain(routed.status);
  });

  it("J2. Egyptian companies + public e-mails and phones: a contacts stage per kind, each fed by the company's website or domain; never a person's private contact", () => {
    const t = route("عايز ٥٠ شركة مقاولات في مصر وإيميلاتها وتليفوناتها الرسمية", "test");
    expect(t.need.contacts).toEqual({ email: true, phone: true });
    expect(ops(t)).toEqual(["companies.discover", "company.contacts", "company.contacts"]);
    for (const s of t.stages.slice(1)) expect(s.stage.accepts).toEqual(["domain", "url"]);
    expect(t.need.privacy).toBe("ok");
  });

  it("J3. software companies + their employees (decision makers): people are read from the companies (child stage)", () => {
    const t = route("شركات برمجيات في القاهرة والمديرين فيها", "test");
    expect(ops(t)).toEqual(["companies.discover", "people.discover"]);
    expect(t.stages[1].stage.parentKey).toBe("companies");
    expect(t.status).toBe("supported");
  });

  it("J4. Google Maps places in a named district: a places source; measured sources for a test account; a customer account told the source is not verified yet", () => {
    const t = route("صيدليات في المعادي على خرايط جوجل", "test");
    expect(t.need.kind).toBe("places");
    expect(ops(t)).toEqual(["places.discover"]);
    expect(t.status).toBe("supported");
    expect(route("صيدليات في المعادي على خرايط جوجل", "production").unsupported[0].reason).toBe("not_verified");
  });

  it("J5. reviews of a named place: places → reviews, bound by the place reference", () => {
    const t = route("تقييمات مطعم أبو طارق على جوجل ماب، آخر ٢٠٠ ريفيو", "test");
    expect(ops(t)).toEqual(["places.discover", "places.reviews"]);
    expect(t.stages[0].stage.requires).toContain("place_ref");
    expect(["place_ref", "url"]).toContain(t.stages[1].link?.to);
  });

  it("J6. TikTok videos + comments + replies: a 3-stage chain served by production-eligible hand cards for a customer account", () => {
    const p = route("هات الكومنتات والريبلايز على فيديوهات تيكتوك عن السياحة", "production");
    expect(ops(p)).toEqual(["social.parents", "social.comments", "social.replies"]);
    expect(p.status).toBe("supported");
    expect(sel(p, "social.replies")).toBe("anyapi.tiktok.comment_replies");
    for (const s of p.stages) expect(levelOf(s.selected!, s.stage.operation)).toBe("production_eligible");
    expect(p.stages[2].link).toMatchObject({ to: "comment_ref" });
  });

  it("J7. an Instagram public account and its posts: the account listing is used (the account is named); the account's PROFILE is said as not yet collectable, never dropped", () => {
    for (const account of ["production", "test"] as const) {
      const d = route("بيانات حساب انستاجرام بتاع وزارة السياحة وآخر ١٠ بوستات", account);
      expect(d.need.profiles).toEqual(["instagram"]);
      expect(ops(d)).toEqual(["social.profile", "social.parents"]);
      expect(sel(d, "social.parents")).toBe("scrapecreators.instagram.user.posts");
      expect(d.status).toBe("partial");
      expect(d.messageAr).toContain("بيانات الحسابات العامة على إنستجرام");
      expect(d.alternativeAr).toContain("منشورات وفيديوهات إنستجرام");
    }
  });

  it("J8. Instagram topic discovery: an account listing is NEVER used for a topic; a customer account has no reviewed topic source (honest), a test account gets a measured one", () => {
    const p = route("بوستات انستجرام عن القهوة المختصة", "production");
    expect(p.need.namedSource).toBeUndefined();
    expect(p.stages[0].eligible.some((e) => e.id === "scrapecreators.instagram.user.posts")).toBe(false);
    expect(p.status).toBe("unsupported");
    const t = route("بوستات انستجرام عن القهوة المختصة", "test");
    expect(t.status).toBe("supported");
    expect(t.stages[0].eligible[0].takes).toContain("query");
  });

  it("J9. YouTube video comments (a link is given): parents → comments on production-eligible cards", () => {
    const p = route("كومنتات فيديو يوتيوب ده https://youtu.be/dQw4w9WgXcQ", "production");
    expect(ops(p)).toEqual(["social.parents", "social.comments"]);
    expect(p.status).toBe("supported");
    expect(levelOf(sel(p, "social.comments")!, "social.comments")).toBe("production_eligible");
  });

  it("J10. X posts in a date window: the period is read and the chosen source enforces it (no «cannot enforce the period» limitation)", () => {
    const p = route("تغريدات عن الانتخابات من ١ لـ ١٥ أكتوبر ٢٠٢٦ بس", "production");
    expect(p.need.conditions.period).toBe(true);
    expect(sel(p, "social.parents")).toBe("anyapi.x.search.posts");
    expect(p.stages[0].eligible[0].filtersCovered).toContain("period");
    expect(p.limitations.filter((l) => l.code === "filter_not_enforceable")).toEqual([]);
  });

  it("J11. Reddit public discussion search: posts → comments on sources Diger has measured (test account); a customer account told they are not verified yet", () => {
    const t = route("عايز بوستات ريديت عن الذكاء الاصطناعي وتعليقاتها", "test");
    expect(t.need.extraPlatforms).toEqual(["reddit"]);
    expect(ops(t)).toEqual(["social.parents", "social.comments"]);
    expect(t.status).toBe("supported");
    for (const s of t.stages) expect(levelOf(s.selected!, s.stage.operation)).toBe("live_verified");
    const p = route("عايز بوستات ريديت عن الذكاء الاصطناعي وتعليقاتها", "production");
    expect(p.status).toBe("unsupported");
    expect(p.messageAr).toContain("ريديت");
  });

  it("J12. public web search then page extraction: the search's link feeds the page read", () => {
    const t = route("مقالات عن السياحة في مصر وعايز نص كل مقالة", "test");
    expect(ops(t)).toEqual(["web.search", "web.read"]);
    expect(t.stages[1].link).toEqual({ from: "url", to: "url" });
    expect(t.status).toBe("supported");
  });

  it("J13. multiple objectives: social comments AND companies are separate chains (each its own plan and price, asked before planning)", () => {
    const brief = { platforms: ["tiktok"], content: [], count: null, objectives: [obj("o1", "social.parents", { platform: "tiktok" }), obj("o2", "social.comments", { platform: "tiktok", parent: "o1" }), obj("o3", "companies.discover")] } as Parameters<typeof researchNeedOf>[0]["brief"];
    const t = route("هات تعليقات تيك توك عن السياحة وكمان شركات السياحة في مصر", "test", { brief });
    expect(t.need.kind).toBe("mixed");
    expect(mixesSocialAndOther(t)).toBe(true);
    expect(t.stages.filter((s) => s.stage.parentKey === null).map((s) => s.stage.operation).sort()).toEqual(["companies.discover", "social.parents"]);
  });

  it("J14. a provider unavailable (no key): its capabilities are never candidates; the request is served by another provider or said unavailable", () => {
    const noWeb = registryOf({ webKeys: { firecrawl: false, contextdev: false } });
    const t = route("مقالات عن السياحة في مصر وعايز نص كل مقالة", "test", { registry: noWeb });
    for (const s of t.stages) expect(s.eligible.every((e) => e.provider === "treg")).toBe(true);
    const exhausted = registryOf({ tregDailyCapUsd: 0.8, spentTodayUsd: { treg: 0.9 }, webKeys: { firecrawl: false, contextdev: false } });
    const none = route("هات تعليقات تيك توك عن السياحة", "production", { registry: exhausted });
    expect(none.status).toBe("unsupported");
    expect(none.unsupported[0].reason).toBe("provider_unavailable");
  });

  it("J15. a provider with no usable rows (measured): it is broken and never selected, however cheap", () => {
    for (const [id, op] of [["litescrape.google.serp.maps", "places.discover"], ["crawl4ai.facebook.user.posts", "social.parents"]] as const) {
      expect(levelOf(id, op)).toBe("broken");
    }
    const t = route("صيدليات في المعادي على خرايط جوجل", "test");
    expect(t.stages[0].rejected).toContainEqual({ id: "litescrape.google.serp.maps", reason: "broken_or_deprecated" });
  });

  it("J16. a provider with an unknown price is never planned (the router excludes it)", () => {
    const unpriced = REG.all.find((c) => c.operation === "company.enrich" && c.pricing.basis === "unknown")!;
    expect(unpriced).toBeTruthy();
    const reg = { all: [...REG.all.filter((c) => c.operation !== "social.parents" || c.platform !== "tiktok"), { ...REG.all.find((c) => c.id === "anyapi.tiktok.search.videos")!, id: "zz.unpriced.tiktok", usdPerRow: null, pricing: { unit: "call", usd: null, basis: "unknown" as const, billedOnFailure: null } }], byId: REG.byId };
    const f = { ...facts("test"), levelOf: (id: string, op: Parameters<ReturnType<typeof facts>["levelOf"]>[1]) => (id === "zz.unpriced.tiktok" ? "production_eligible" as const : facts("test").levelOf(id, op)) };
    const d = discoverCapabilities(researchNeedOf({ request: "هات تعليقات تيك توك عن السياحة", extendedFamilies: true }), reg, { routing: f });
    expect(d.stages[0].rejected).toContainEqual({ id: "zz.unpriced.tiktok", reason: "price_unknown" });
  });

  it("J17. a CHEAPER provider lacking the mandatory country filter loses to one that carries it (real catalog, real evidence)", () => {
    const p = route("محتاج 200 comments من TikTok videos عن AI في مصر", "production");
    expect(p.need.conditions.country).toBe(true);
    const parents = p.stages[0];
    const chosen = parents.eligible[0];
    expect(chosen.id).toBe("tikhub.tiktok.search.videos");
    expect(chosen.filtersCovered).toContain("country");
    const cheaperWithout = parents.eligible.filter((e) => !e.filtersCovered.includes("country") && (e.routed!.usdPerUsableRow ?? Infinity) < (chosen.routed!.usdPerUsableRow ?? Infinity));
    expect(cheaperWithout.length).toBeGreaterThan(0);
    for (const e of cheaperWithout) expect(e.rank).toBeGreaterThan(chosen.rank);
  });

  it("J18. a provider returning a changed schema: the registry diff flags the breaking change on a production-eligible capability for review, and a broken capability is never routed", () => {
    const after = JSON.parse(JSON.stringify(artifact)) as RegistryArtifact;
    const pe = after.capabilities.find((c) => c.id === "anyapi.tiktok.video.comments")!;
    pe.schema_fingerprint = "0000000000000000";
    pe.list_path = "items";
    const d = diffRegistries(artifact, after);
    expect(d.changes).toContainEqual(expect.objectContaining({ key: pe.key, kind: "breaking_output", reviewRequired: true }));
    expect(d.violations.some((v) => v.startsWith(pe.key))).toBe(true);
    const brokenFacts = { ...facts("production"), levelOf: (id: string, op: Parameters<ReturnType<typeof facts>["levelOf"]>[1]) => (id === "anyapi.tiktok.video.comments" ? "broken" as const : facts("production").levelOf(id, op)) };
    const r = discoverCapabilities(researchNeedOf({ request: "هات تعليقات تيك توك عن السياحة", extendedFamilies: true }), REG, { routing: brokenFacts });
    expect(r.stages[1].selected).not.toBe("anyapi.tiktok.video.comments");
  });

  it("J19. a timeout with a SAFE fallback: a test account falls back to another measured comments source carrying the same constraints; a customer account with no second reviewed source gets an honest partial", () => {
    const t = route("هات تعليقات تيك توك عن السياحة", "test");
    const comments = t.stages[1];
    const fb = safeFallback(comments, comments.selected!, "timeout");
    expect(fb.id).not.toBeNull();
    expect(fb.id).not.toBe(comments.selected);
    expect(safeFallback(comments, comments.selected!, "refused_cap").id).toBeNull();
    const p = route("هات تعليقات تيك توك عن السياحة", "production");
    const pc = p.stages[1];
    const pf = safeFallback(pc, pc.selected!, "timeout");
    if (pc.eligible.length === 1) expect(pf.id).toBeNull();
    else expect(levelOf(pf.id!, "social.comments")).toBe("production_eligible");
  });

  it("J20. private personal information stays refused: no stage, no capability, the fixed answer (for every account)", () => {
    for (const r of ["عايز رسايل الواتساب بتاعة جروب الشغل", "أرقام موبايلات الناس اللي علّقوا على البوست ده", "عايز عناوين سكن المتابعين"]) {
      for (const account of ["production", "test"] as const) {
        const d = route(r, account);
        expect(d.status, r).toBe("blocked");
        expect(d.stages).toEqual([]);
      }
    }
    // FINDING (owner decision, docs/intelligence/PHASES-2-4-ACCEPTANCE.md §6): the chat guard lets «personal e-mails of company employees» through in a business context. Downstream, no capability that returns personal contacts is
    // ever a candidate for a normal account: the request becomes company-level public contacts only, never a person's private address.
    const d = route("إيميلات الموظفين الشخصية في شركات المقاولات", "test");
    for (const s of d.stages) for (const e of s.eligible) expect(policyVerdict(e.id, { isAdmin: false, verifiedBusiness: false }).category === "sensitive" && e.provider === "treg").toBe(false);
  });
});

// ================================================================================================================================================================================
/** The audit's 35 scenarios (chapter 11.2), each as the customer wrote it. `prod` / `test`: the router's verdict for a customer account and a test account; `ops`: the stages; `gap`: a known understanding gap (Phase 1) recorded, not hidden. */
const SCENARIOS: Array<{ n: number; request: string; kind: string; ops: string[]; prod: CapabilityDiscovery["status"]; test: CapabilityDiscovery["status"]; gap?: string }> = [
  { n: 1, request: "هات ١٠٠ تغريدة عن العاصمة الإدارية الشهر اللي فات", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 2, request: "عايز ٢٠ تويتة عن الدوري مع الردود بتاعتها", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 3, request: "فيديوهات تك توك عن الأكل الشعبي، ١٠ فيديوهات", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 4, request: "هات الكومنتات والريبلايز على فيديوهات تيكتوك عن السياحة", kind: "social", ops: ["social.parents", "social.comments", "social.replies"], prod: "supported", test: "supported" },
  { n: 5, request: "بيانات حساب انستاجرام بتاع وزارة السياحة وآخر ١٠ بوستات", kind: "social", ops: ["social.profile", "social.parents"], prod: "partial", test: "partial" },
  { n: 6, request: "منشورات صفحة الأهلي الرسمية على الفيس آخر شهر", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 7, request: "كل التعليقات على بوستات فيسبوك عن غلاء الأسعار", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 8, request: "فيديوهات قناة الجزيرة على يوتيوب عن غزة الشهر ده", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 9, request: "كومنتات فيديو يوتيوب ده https://youtu.be/dQw4w9WgXcQ", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 10, request: "٥٠ شركه مقاولات فمصر", kind: "companies", ops: ["companies.discover"], prod: "unsupported", test: "supported", gap: "«فمصر» is not read as the country (Phase 1 lexicon)" },
  { n: 11, request: "٥٠ شركة مقاولات في مصر ومعاها الموقع الرسمي لكل شركة", kind: "companies", ops: ["companies.discover"], prod: "unsupported", test: "supported" },
  { n: 12, request: "٥٠ شركة مقاولات في مصر والإيميل العام ورقم المقر لكل شركة", kind: "companies", ops: ["companies.discover", "company.contacts"], prod: "unsupported", test: "supported", gap: "«رقم المقر» (the HQ phone) is not read as a phone ask (Phase 1)" },
  { n: 13, request: "صيدليات في المعادي على خرايط جوجل", kind: "places", ops: ["places.discover"], prod: "unsupported", test: "supported" },
  { n: 14, request: "تقييمات مطعم أبو طارق على جوجل ماب، آخر ٢٠٠ ريفيو", kind: "places", ops: ["places.discover", "places.reviews"], prod: "unsupported", test: "supported" },
  { n: 15, request: "٣ مديرين من كل شركة برمجيات في السعودية مع إيميلات الشغل", kind: "companies", ops: ["companies.discover", "company.contacts", "people.discover"], prod: "unsupported", test: "supported" },
  { n: 16, request: "شركات الطاقة الشمسية في مصر ومواقعهم وصفحاتهم على السوشيال", kind: "companies", ops: ["companies.discover"], prod: "unsupported", test: "supported", gap: "a company's public social links have no stage (no operation maps them)" },
  { n: 17, request: "شركات تسويق في دبي + الإيميلات اللي على مواقعهم", kind: "companies", ops: ["companies.discover", "company.contacts"], prod: "unsupported", test: "supported" },
  { n: 18, request: "كومنتات تيك توك عن رمضان", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 19, request: "عايز رسايل الواتساب بتاعة جروب الشغل", kind: "unknown", ops: [], prod: "blocked", test: "blocked" },
  { n: 20, request: "هات تعليقات فيديوهات تيك توك الخاصة بالسياحه", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 21, request: "عايز الكومنتس بتاعة التك توك عن الاكل", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 22, request: "محتاج 200 comments من TikTok videos عن AI في مصر", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 23, request: "عايز داتا عن رأي الناس في الذكاء الاصطناعي", kind: "unknown", ops: [], prod: "needs_clarification", test: "needs_clarification" },
  { n: 24, request: "هات ٢٠ فيديو يوتيوب عن السياحة", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 25, request: "تغريدات عن الانتخابات من ١ لـ ١٥ أكتوبر ٢٠٢٦ بس", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 26, request: "فيديوهات تيك توك من السعوديه بس", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported", gap: "«السعوديه» (ه) is not read as the country (Phase 1)" },
  { n: 27, request: "بالظبط ٥٠٠ تعليق تيك توك عن السياحة، لا أكتر ولا أقل", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 28, request: "أرقام موبايلات الناس اللي علّقوا على البوست ده", kind: "unknown", ops: [], prod: "blocked", test: "blocked" },
  { n: 29, request: "اسحب لي اللي الناس كاتباه تحت فيديوهات عمرو أديب على يوتيوب", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported", gap: "«اللي الناس كاتباه تحت» (the comments) is not read as comments (Phase 1)" },
  { n: 30, request: "عايز بوستات ريديت عن الذكاء الاصطناعي وتعليقاتها", kind: "social", ops: ["social.parents", "social.comments"], prod: "unsupported", test: "supported" },
  { n: 31, request: "مقالات عن السياحة في مصر وعايز نص كل مقالة", kind: "web", ops: ["web.search", "web.read"], prod: "unsupported", test: "supported" },
  { n: 32, request: "بروفايل تيك توك بتاع عمرو دياب وعدد المتابعين", kind: "social", ops: ["social.profile", "social.parents"], prod: "partial", test: "supported" },
  { n: 33, request: "Find 50 software companies in Cairo with their official websites", kind: "companies", ops: ["companies.discover"], prod: "unsupported", test: "supported" },
  { n: 34, request: "هات منشورات فيسبوك عن السياحة مع التعليقات والردود", kind: "social", ops: ["social.parents", "social.comments", "social.replies"], prod: "supported", test: "supported" },
  { n: 35, request: "تعليقات تيك توك عن السياحة… لا خليهم على يوتيوب", kind: "social", ops: ["social.parents", "social.comments", "social.parents", "social.comments"], prod: "supported", test: "supported", gap: "a correction typed INSIDE one message is not applied by the words reading (both platforms are read); the chat's validated brief carries the latest correction (Phase 1), see the next test" },
];

describe("the audit's 35 scenarios through understanding → discovery → router (both account kinds)", () => {
  it("there are at least 35 distinct scenarios", () => {
    expect(new Set(SCENARIOS.map((s) => s.request)).size).toBeGreaterThanOrEqual(35);
  });
  for (const s of SCENARIOS) {
    it(`S${s.n}. ${s.request}${s.gap ? ` (known gap: ${s.gap})` : ""}`, () => {
      const p = route(s.request, "production");
      const t = route(s.request, "test");
      expect(p.need.kind).toBe(s.kind);
      expect(ops(p)).toEqual(s.ops);
      expect(p.status).toBe(s.prod);
      expect(t.status).toBe(s.test);
    });
  }
  it("S35 (multi-turn correction): when the chat's validated brief carries the correction, the router follows the latest platform only (YouTube), never the replaced one", () => {
    const brief = { platforms: ["youtube"], content: ["comments"], count: null, objectives: [obj("o1", "social.parents", { platform: "youtube" }), obj("o2", "social.comments", { platform: "youtube", parent: "o1" })] } as Parameters<typeof researchNeedOf>[0]["brief"];
    const d = route("تعليقات تيك توك عن السياحة… لا خليهم على يوتيوب", "production", { brief });
    expect(d.need.platforms).toEqual(["youtube"]);
    expect(d.stages.every((s) => s.stage.platform === "youtube")).toBe(true);
    expect(d.status).toBe("supported");
  });
});

// ================================================================================================================================================================================
/**
 * THE 20 STORED MISSIONS (tests/fixtures/live/replay-missions.json, real requests and their approved plans), replayed through the router for a CUSTOMER account. Each historical stage is recorded as: «same» (the router chooses it), «eligible»
 * (still a validated candidate, the router prefers another), or «excluded» with the reason. Every difference is explained in docs/intelligence/PHASES-2-4-ACCEPTANCE.md §5; a change to this table is a reviewed change.
 */
const HISTORICAL: Record<string, Array<[string, "same" | "eligible" | "excluded", string | null]>> = JSON.parse(readFileSync(new URL("./fixtures/phases-2-4-historical-routing.json", import.meta.url), "utf8")).missions;

describe("stored missions compared with their historical approved plans", () => {
  const missions = (JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string; stages: Array<{ endpoint_id: string }> }> }).missions;
  it("all 20 are served by the router for a customer account, and every historical choice is classified exactly as recorded", () => {
    expect(missions).toHaveLength(20);
    for (const m of missions) {
      const d = route(m.request, "production");
      expect(d.status, m.id).toBe("supported");
      const got = m.stages.map((st) => {
        const op = REG.all.find((c) => c.id === st.endpoint_id)?.operation ?? null;
        const s = d.stages.find((x) => x.stage.operation === op);
        if (!s) return [st.endpoint_id, "excluded", "no_stage"] as const;
        if (s.selected === st.endpoint_id) return [st.endpoint_id, "same", null] as const;
        if (s.eligible.some((e) => e.id === st.endpoint_id)) return [st.endpoint_id, "eligible", null] as const;
        return [st.endpoint_id, "excluded", s.rejected.find((r) => r.id === st.endpoint_id)?.reason ?? "not_a_candidate"] as const;
      });
      expect(got, m.id).toEqual(HISTORICAL[m.id]);
    }
  });
});

// ================================================================================================================================================================================
describe("approval boundary and pricing ownership", () => {
  it("the approved plan executes exactly the validated capabilities: a swapped capability, an added stage or changed parameters after approval are refused; no fallback is allowed to bypass it", () => {
    const d = route("هات الكومنتات والريبلايز على فيديوهات تيكتوك عن السياحة", "production");
    const plan = { stages: d.stages.map((s) => ({ key: s.stage.key, endpoint_id: s.selected!, parent_key: s.stage.parentKey, params: { q: "السياحة", limit: 20 } })) };
    const approved = { ...plan, capability_selection: capabilitySelectionOf(plan, d) };
    expect(verifyApprovedScope(approved, catalog)).toEqual({ ok: true, checked: true });
    const fallback = safeFallback(d.stages[1], d.stages[1].selected!, "timeout");
    const swapped = { ...approved, stages: approved.stages.map((s, i) => (i === 1 ? { ...s, endpoint_id: fallback.id ?? "tikhub.tiktok.video.comments" } : s)) };
    expect(verifyApprovedScope(swapped, catalog)).toMatchObject({ ok: false });
    const added = { ...approved, stages: [...approved.stages, { key: "extra", endpoint_id: "anyapi.x.search.posts", parent_key: null, params: {} }] };
    expect(verifyApprovedScope(added, catalog)).toMatchObject({ ok: false, issues: expect.arrayContaining(["stage_added:extra"]) });
    const bigger = { ...approved, stages: approved.stages.map((s) => ({ ...s, params: { ...s.params, limit: 500 } })) };
    expect(verifyApprovedScope(bigger, catalog)).toMatchObject({ ok: false, issues: expect.arrayContaining(["approved_parameters_changed"]) });
  });

  it("pricing stays code-owned: discovery and the router carry internal USD only (never in a customer text); the customer's point price is not computed here", () => {
    const d = route("عايز ٥٠ شركة مقاولات في مصر ومواقعها الرسمية", "test");
    const customer = [d.messageAr, d.alternativeAr, ...limitationLinesAr(d)].join(" ");
    expect(customer).not.toMatch(/\d+(\.\d+)?\s*(?:\$|USD|دولار|نقطة|نقاط)/);
    expect(JSON.stringify(d)).not.toMatch(/"points"|"price_points"|"unit_points"/);
  });
});
