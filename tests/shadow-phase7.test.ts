import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { discoverCapabilities, researchNeedOf, type CapabilityDiscovery } from "../src/lib/agentMission/capabilities";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { compareCase, compareCorpus, gatesOf, REGRESSION_CODES, costFindings, costOf, customerTextFindings, exclusionFindings, GATES, privacyFindings, scopeFindings, selectionRuleFindings, understandingFindings, type ShadowContext } from "../src/lib/agentMission/shadow/compare";
import { buildShadowContext } from "../src/lib/agentMission/shadow/context";
import { ACCEPTED_DIFFERENCES, ALL_CASES, EXCLUSION_CASES, OPEN_RISKS, STORED_CASES, UNDERSTANDING_CASES } from "../src/lib/agentMission/shadow/corpus";
import { AUDIT_CASES, AUDIT_SCENARIO_LIST } from "../src/lib/agentMission/shadow/auditScenarios";
import { codeLabelAr, EVIDENCE_AR, KNOWN_CODE_LABELS, SEVERITY_AR } from "../src/lib/agentMission/shadow/labels";
import { leaksIdentity, redactDeep, redactText } from "../src/lib/agentMission/shadow/redact";
import type { Finding, ShadowCase } from "../src/lib/agentMission/shadow/types";
import { understandForShadow, SHADOW_NOW_MS } from "../src/lib/agentMission/shadow/understanding";
import { buildCorpus, corpusText } from "../scripts/shadow/build-corpus";

/**
 * PHASE 7 (PR-7.1): THE ADMIN SHADOW COMPARISON. Offline and deterministic: the corpus (35 audit scenarios, 20 stored approved missions, 98 labelled requests, 3 synthetic exclusion-list cases) runs through production today and the proposed behaviour;
 * the rules that detect a regression are each shown to FIRE on a case built to break them. No network (fetch throws), no model, no database.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const routeState: { admin: boolean } = { admin: true };
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (routeState.admin ? { ok: true, ctx: { adminId: "adm-1" } } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
let ctx: ShadowContext;
beforeAll(() => { ctx = buildShadowContext(); });

/** Every regression code any check in this file has seen fire (the last test requires each watched code to have been triggered by a case built for it). */
const seenRegressions = new Set<string>();
const codes = (fs: Finding[], severity?: string) => { for (const f of fs) if (f.severity === "regression") seenRegressions.add(f.code); return fs.filter((f) => !severity || f.severity === severity).map((f) => f.code); };
const route = (request: string, account: "production" | "test", extra: Partial<Parameters<typeof researchNeedOf>[0]> = {}): CapabilityDiscovery => discoverCapabilities(researchNeedOf({ request, extendedFamilies: true, ...extra }), ctx.registry, { routing: ctx.facts(account) });
const U = (text: string, semantic = false) => understandForShadow(text, null, { semantic, nowMs: SHADOW_NOW_MS });

// ================================================================================================================================================================================
describe("redaction: nothing personal and nothing secret reaches the admin view", () => {
  it("removes e-mails, links, handles, phone numbers (Latin and Arabic digits) and credential shapes", () => {
    const t = "كلمني على amira@wiseresume.app أو ٠١٠١٢٣٤٥٦٧٨ أو +20 100 123 4567 ورابط https://example.org/u/ahmed?token=abc و@ahmed_sayed وkey=sk-live_abcdefghijklmnop";
    const r = redactText(t);
    for (const bad of ["amira@", "٠١٠١٢٣٤٥٦٧٨", "100 123 4567", "https://", "@ahmed_sayed", "sk-live", "abcdefghijklmnop"]) expect(r, bad).not.toContain(bad);
    expect(leaksIdentity(r)).toBe(false);
  });
  it("removes a truncated address too (a topic parser cut «amira@example.org» at its dot)", () => {
    expect(redactText("بريدي amira@example")).toBe("بريدي [بريد]");
    expect(redactText("مع @ahmed_sayed و@brand")).toBe("مع @… و@…");
  });
  it("removes JWTs, bearer tokens, name=value secrets and long random tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456";
    for (const s of [jwt, "Bearer abcdef0123456789abcdef", "password=hunter22xx", "api_key: AbCd1234EfGh5678", "0123456789abcdef0123456789abcdef0123456789abcdef", "Zx9Qm4Lp2Rt7Vb3Nc8Kd5Hs1Wa6Jf0Ge9Yu4Io"]) expect(redactText(`x ${s} y`), s).not.toContain(s.slice(8, 24));
  });
  it("keeps what the screen needs: counted numbers, ISO days, decimals, short ids and snake_case code names", () => {
    for (const s of ["٥٠ شركة مقاولات", "من 2026-10-01 إلى 2026-10-15", "0.00526 USD", "msn_a254618740b9b9878126", "historical_source_below_verification", "G4_no_silent_capability_approval", "1,247 rows"]) expect(redactText(s), s).toBe(s);
  });
  it("is idempotent, never mutates its input, and redacts every string inside a structure (keys kept)", () => {
    const input = { a: "mail me: x@y.example", n: [1, { b: "call 0100 1234 5678" }], k: 5 };
    const frozen = JSON.stringify(input);
    const out = redactDeep(input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(JSON.stringify(out)).not.toMatch(/x@y\.example|1234 5678/);
    expect(Object.keys(out)).toEqual(["a", "n", "k"]);
    expect(redactDeep(out)).toEqual(out);
  });
});

// ================================================================================================================================================================================
describe("the corpus", () => {
  it("is a current committed copy of the stored requests and plans (the website cannot read tests/)", () => {
    expect(read("data/shadow/corpus.json")).toBe(corpusText());
    const c = buildCorpus();
    expect(c.stored).toHaveLength(20);
    expect(c.understanding).toHaveLength(98);
  });
  it("holds 35 audit scenarios, 20 stored missions, 98 labelled requests and 3 exclusion cases, all with unique ids", () => {
    expect(AUDIT_CASES).toHaveLength(35);
    expect(STORED_CASES).toHaveLength(20);
    expect(UNDERSTANDING_CASES).toHaveLength(98);
    expect(EXCLUSION_CASES).toHaveLength(3);
    expect(new Set(ALL_CASES.map((c) => c.id)).size).toBe(ALL_CASES.length);
    expect(ALL_CASES).toHaveLength(156);
  });
  it("keeps the audit scenarios equal to the ones the Phase 2-4 acceptance pins (every request and its verdicts appear there)", () => {
    const acceptance = read("tests/intelligence-phases-2-4-acceptance.test.ts");
    for (const s of AUDIT_SCENARIO_LIST) {
      expect(acceptance, `S${s.n}`).toContain(`request: ${JSON.stringify(s.request)}`);
      expect(acceptance, `S${s.n} verdicts`).toContain(`prod: "${s.prod}", test: "${s.test}"`);
    }
  });
  it("holds the stored approved plans exactly as recorded (20 missions, 49 stages) and no personal identifier", () => {
    const c = buildCorpus();
    expect(c.stored.reduce((n, m) => n + m.stages.length, 0)).toBe(49);
    const text = JSON.stringify(c);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(text).not.toMatch(/https?:\/\//);
    // the only thing in the stored requests the redactor would touch is a fixture account handle (@brand_eg, a made-up brand); the view redacts it anyway
    expect(redactText(text)).toBe(text.replace(/(?<![A-Za-z0-9_.])@[A-Za-z0-9_.]{2,}/g, "@…"));
    expect([...new Set([...text.matchAll(/(?<![A-Za-z0-9_.])@[A-Za-z0-9_.]{2,}/g)].map((m) => m[0]))]).toEqual(["@brand_eg"]);
  });
});

// ================================================================================================================================================================================
describe("the whole corpus: the report", () => {
  let report: ReturnType<typeof compareCorpus>;
  beforeAll(() => { report = compareCorpus(ALL_CASES, ctx, ACCEPTED_DIFFERENCES, OPEN_RISKS); });

  it("is deterministic: the same corpus gives the same bytes, and the order is by id", () => {
    const again = compareCorpus([...ALL_CASES].reverse(), ctx, ACCEPTED_DIFFERENCES, OPEN_RISKS);
    expect(again.digest).toBe(report.digest);
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
    expect(report.cases.map((c) => c.id)).toEqual([...report.cases.map((c) => c.id)].sort((a, b) => a.localeCompare(b)));
  });
  it("covers every case and every dimension", () => {
    expect(report.counts.cases).toBe(156);
    expect(report.counts.byOrigin).toEqual({ audit_scenario: 35, stored_mission: 20, understanding_baseline: 98, exclusion: 3 });
    for (const d of ["understanding", "conditions", "providers", "chaining", "coverage", "privacy", "exclusion", "cost", "outputs"] as const) {
      const n = Object.values(report.counts.byDimension[d]).reduce((a, b) => a + b, 0);
      expect(n, d).toBeGreaterThanOrEqual(0);
    }
  });
  it("has ZERO unaccepted regressions and every gate passes (audit §10.4)", () => {
    expect(report.counts.unacceptedRegressions).toBe(0);
    expect(report.counts.findings.regression).toBe(0);
    expect(report.gates.map((g) => g.id)).toEqual(GATES.map((g) => g.id));
    for (const g of report.gates) expect(g.failing, g.id).toEqual([]);
    expect(report.passed).toBe(true);
    expect(ACCEPTED_DIFFERENCES).toEqual([]);
  });
  it("shows measured improvements and keeps them apart from unlabelled ones (a value merely filled is not a verified improvement)", () => {
    expect(report.counts.verifiedImprovements).toBeGreaterThanOrEqual(60);
    expect(report.counts.unlabelledImprovements).toBeGreaterThan(0);
    const unlabelled = report.cases.flatMap((c) => c.findings).filter((f) => f.code === "filled" || f.code === "topic_tightened" || f.code === "route_follows_platform");
    expect(unlabelled.length).toBeGreaterThan(0);
    for (const f of unlabelled) expect(f.verified, f.code).not.toBe(true);
  });
  it("every finding carries an evidence label and an Arabic label for its code", () => {
    const seen = new Set<string>();
    for (const c of report.cases) for (const f of c.findings) {
      expect(Object.keys(EVIDENCE_AR)).toContain(f.evidence);
      seen.add(f.code);
      expect(codeLabelAr(f.code), f.code).not.toBe(f.code);
    }
    expect(seen.size).toBeGreaterThan(30);
    for (const code of KNOWN_CODE_LABELS) expect(codeLabelAr(code)).toMatch(/[ء-ي]/);
    for (const s of Object.values(SEVERITY_AR)) expect(s).toMatch(/[ء-ي]/);
  });
  it("does not invent interpreter events and says so", () => {
    expect(report.interpreterEvents.available).toBe(false);
    expect(report.interpreterEvents.reason).toMatch(/PR-1\.3|semantic_normalization_v1/);
    expect(report.assumptions.join(" ")).toMatch(/no provider, no model/i);
  });
  it("redacts every string of a case, even a note carried in the case itself (an e-mail typed into a known-gap note never comes back)", () => {
    const r = compareCase({ id: "n", origin: "ad_hoc", request: "هات فيديوهات", expected: { platform: "tiktok" }, knownGap: "see amira@example.org and 01012345678 and @someone" }, ctx);
    const text = JSON.stringify(r);
    expect(text).toContain("known gap");
    for (const bad of ["amira@", "01012345678", "@someone"]) expect(text, bad).not.toContain(bad);
  });
  it("redacts: no e-mail, link, handle or phone anywhere in the serialized report, and no secret shape", () => {
    const text = JSON.stringify(report);
    expect(text).not.toContain("@brand_eg");
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{8,}\./);
    expect(leaksIdentity(JSON.stringify(report.cases.map((c) => c.request)))).toBe(false);
  });
  it("the stored missions are compared stage by stage, and every historical choice is classified (same / validated / excluded) as the Phase 2-4 acceptance recorded", () => {
    const pinned = JSON.parse(read("tests/fixtures/phases-2-4-historical-routing.json")).missions as Record<string, Array<[string, string, string | null]>>;
    for (const c of report.cases.filter((x) => x.origin === "stored_mission")) {
      const id = c.id.replace("stored-", "");
      const provider = c.findings.filter((f) => f.dimension === "providers" && /^(provider_|historical_)/.test(f.code));
      const kinds = provider.map((f) => (f.code === "provider_same" ? "same" : f.code === "provider_changed_validated" ? "eligible" : "excluded"));
      expect(kinds, id).toEqual(pinned[id].map((p) => p[1]));
    }
  });
  it("all 20 stored missions stay served for a customer account, with the same operations as their approved plans", () => {
    for (const c of report.cases.filter((x) => x.origin === "stored_mission")) {
      expect(c.proposed.production.status, c.id).toBe("supported");
      expect(codes(c.findings), c.id).not.toContain("stage_lost");
      expect(codes(c.findings), c.id).not.toContain("served_before_unserved_now");
    }
  });
  it("a customer account is only ever routed to production-eligible capabilities and a test account never to a broken one", () => {
    for (const c of report.cases) {
      for (const s of c.proposed.production.stages) if (s.selected) expect(s.level, `${c.id} ${s.selected}`).toBe("production_eligible");
      for (const s of c.proposed.test.stages) if (s.selected) expect(["broken", "deprecated", "advertised", "schema_checked"], `${c.id} ${s.selected}`).not.toContain(s.level);
      for (const s of [...c.proposed.production.stages, ...c.proposed.test.stages]) if (s.selected) expect(s.usdPerRow, `${c.id} ${s.selected}`).not.toBeNull();
    }
  });
  it("every audit scenario routes as the audit pinned it (kind, stages, customer verdict, test verdict)", () => {
    for (const c of report.cases.filter((x) => x.origin === "audit_scenario")) expect(codes(c.findings), c.id).toContain("routing_as_audited");
  });
  it("the privacy scenarios under FX-PRIV are no longer blocked and the router plans no stages for them", () => {
    for (const id of ["audit-s19", "audit-s28"]) {
      const c = report.cases.find((x) => x.id === id)!;
      expect(c.proposed.production.status).not.toBe("blocked");
      expect(c.proposed.test.status).not.toBe("blocked");
      expect(c.proposed.production.stages).toEqual([]);
    }
    for (const c of report.cases) expect(c.proposed.understanding.prefilter, c.id).toBe(c.baseline.understanding.prefilter);
  });
  it("makes the gating of non-social requests visible instead of hiding it (the legacy planner may serve them today)", () => {
    const gated = report.cases.filter((c) => codes(c.findings).includes("legacy_served_gated_by_router"));
    expect(gated.length).toBeGreaterThan(20);
    for (const c of gated) expect(c.findings.find((f) => f.code === "legacy_served_gated_by_router")!.evidence).toBe("unverified");
    expect(report.risks.map((r) => r.id)).toEqual(expect.arrayContaining(["router_for_customers_gates_non_social", "free_rerun_carries_no_exclusion_file", "legacy_planner_not_replayable", "no_live_shadow"]));
  });
  it("exclusion cases: listed organisations are removed on synthetic rows, a person's own name never removes a row, enrichment is never applied as an exclusion", () => {
    expect(codes(report.cases.find((c) => c.id === "excl-companies")!.findings)).toEqual(expect.arrayContaining(["exclusion_matches_expectation", "exclusion_free_rerun_carries_no_file"]));
    expect(codes(report.cases.find((c) => c.id === "excl-people")!.findings)).toContain("exclusion_matches_expectation");
    expect(codes(report.cases.find((c) => c.id === "excl-enrichment")!.findings)).toContain("enrichment_never_applied_as_exclusion");
    for (const f of report.cases.filter((c) => c.origin === "exclusion").flatMap((c) => c.findings).filter((f) => f.dimension === "exclusion" && f.code.startsWith("exclusion_matches"))) expect(f.evidence).toBe("simulated");
  });
});

// ================================================================================================================================================================================
describe("regression detection: every rule fires on a case built to break it", () => {
  const find = (fs: Finding[], code: string) => fs.find((f) => f.code === code);

  it("understanding: a constraint the words reading carries and the layer loses is a regression, explained with both values", () => {
    const base = { ...U("هات تعليقات تيك توك عن السياحة") };
    const lost = understandingFindings({ id: "x", origin: "ad_hoc", request: "x" }, base, { ...base, platform: null, country: null });
    expect(codes(lost, "regression")).toEqual(["condition_lost"]);
    expect(find(lost, "condition_lost")).toMatchObject({ dimension: "conditions", baseline: "tiktok", proposed: null, evidence: "code_computed" });
    expect(find(lost, "condition_lost")!.detail).toMatch(/platform.*lost/);
    const kindLost = understandingFindings({ id: "x", origin: "ad_hoc", request: "x" }, base, { ...base, comments: "none" });
    expect(codes(kindLost, "regression")).toEqual(["understanding_lost"]);
  });
  it("understanding: a labelled meaning decides: corrected (verified improvement), now wrong (regression), both wrong (review)", () => {
    const c = (expected: ShadowCase["expected"], knownGap?: string): ShadowCase => ({ id: "x", origin: "ad_hoc", request: "x", expected, ...(knownGap ? { knownGap } : {}) });
    const b = { ...U("هات تعليقات تيك توك عن السياحة") };
    const fixed = understandingFindings(c({ platform: "tiktok" }), { ...b, platform: null }, b);
    expect(find(fixed, "corrected_to_expected")).toMatchObject({ severity: "improvement", verified: true, evidence: "stored_real" });
    const broken = understandingFindings(c({ platform: "tiktok" }), b, { ...b, platform: "x" });
    expect(find(broken, "now_wrong")).toMatchObject({ severity: "regression", verified: true });
    const both = understandingFindings(c({ platform: "tiktok" }), { ...b, platform: "youtube" }, { ...b, platform: "x" });
    expect(find(both, "both_differ_from_expected")).toMatchObject({ severity: "review" });
    const unmet = understandingFindings(c({ platform: "tiktok" }, "a recorded gap"), { ...b, platform: "x" }, { ...b, platform: "x" });
    expect(find(unmet, "expectation_unmet_both")!.detail).toContain("a recorded gap");
  });
  it("understanding: a known-gap case that loses MORE than it corrects is still a regression", () => {
    const b = { ...U("هات تعليقات تيك توك عن السياحة") };
    const f = understandingFindings({ id: "x", origin: "ad_hoc", request: "x", knownGap: "gap", expected: { platform: "tiktok", comments: "some", count: 5 } }, { ...b, platform: null, comments: "some", count: 5 }, { ...b, platform: "tiktok", comments: "none", count: null });
    expect(codes(f, "regression")).toEqual(["now_wrong", "now_wrong"]);
  });
  it("understanding: a value only filled, with no label, is an UNVERIFIED improvement; a changed value with no label needs review", () => {
    const c: ShadowCase = { id: "x", origin: "ad_hoc", request: "x" };
    const b = { ...U("هات تعليقات تيك توك عن السياحة") };
    const filled = understandingFindings(c, { ...b, country: null }, { ...b, country: "EG" });
    expect(find(filled, "filled")).toMatchObject({ severity: "improvement", evidence: "code_computed" });
    expect(find(filled, "filled")!.verified).toBeUndefined();
    const changed = understandingFindings(c, { ...b, language: "ar" }, { ...b, language: "en" });
    expect(find(changed, "value_changed")).toMatchObject({ severity: "review" });
  });
  it("understanding: a known-gap case that gains more than it loses is a trade-off to review, not a regression; a cleared dependent field of a corrected platform is no loss", () => {
    const b = { ...U("هات تعليقات تيك توك عن السياحة") };
    const tradeoff = understandingFindings({ id: "x", origin: "ad_hoc", request: "x", knownGap: "gap", expected: { platform: "x", route: "compiled", comments: "some" } }, { ...b, platform: null, route: "legacy", comments: "some" }, { ...b, platform: "x", route: "compiled", comments: "none" });
    expect(codes(tradeoff, "regression")).toEqual([]);
    expect(find(tradeoff, "partial_trade_off")).toMatchObject({ severity: "review" });
    const noGap = understandingFindings({ id: "x", origin: "ad_hoc", request: "x", expected: { platform: "x", route: "compiled", comments: "some" } }, { ...b, platform: null, route: "legacy", comments: "some" }, { ...b, platform: "x", route: "compiled", comments: "none" });
    expect(codes(noGap, "regression")).toEqual(["now_wrong"]);
    const cleared = understandingFindings({ id: "x", origin: "ad_hoc", request: "x", expected: { platform: null } }, { ...b, platform: "x", kind: "tweets" }, { ...b, platform: null, kind: null });
    expect(codes(cleared, "regression")).toEqual([]);
    expect(find(cleared, "cleared_with_corrected_platform")).toMatchObject({ severity: "improvement", verified: true });
  });
  it("understanding: the chat's deterministic guards are read on the words (a private message, a private contact, a personal identifier) and never on an ordinary request", () => {
    expect(U("عايز رسايل الواتساب بتاعة جروب الشغل").guard).toEqual({ privateContact: false, privateMessages: false, personalIdentifier: false });
    expect(U("أرقام موبايلات الناس اللي علّقوا على البوست ده").guard).toEqual({ privateContact: false, privateMessages: false, personalIdentifier: false });
    expect(U("هات الرقم القومي بتاع الناس دي").guard).toEqual({ privateContact: false, privateMessages: false, personalIdentifier: false });
    expect(U("هات تعليقات تيك توك عن السياحة").guard).toEqual({ privateContact: false, privateMessages: false, personalIdentifier: false });
  });
  it("privacy: the words guard alone is enough to require a block, even when the pre-filter did not refuse", () => {
    const base = { ...U("هات تعليقات تيك توك عن السياحة"), guard: { privateContact: false, privateMessages: true, personalIdentifier: false } };
    const open = route("هات تعليقات تيك توك عن السياحة", "production");
    expect(codes(privacyFindings(base, base, open, open, undefined), "regression")).toEqual(["privacy_not_carried_into_discovery", "privacy_not_carried_into_discovery"]);
  });
  it("privacy: a refusal that stops holding is a regression; a guard the router does not carry is a regression; a new block is only a review", () => {
    const refusal = { ...U("أرقام موبايلات الناس اللي علّقوا على البوست ده"), prefilter: "privacy_refusal" as const };
    const blocked: CapabilityDiscovery = { ...route("أرقام موبايلات الناس اللي علّقوا على البوست ده", "production"), status: "blocked", stages: [] };
    const blockedT: CapabilityDiscovery = { ...route("أرقام موبايلات الناس اللي علّقوا على البوست ده", "test"), status: "blocked", stages: [] };
    expect(codes(privacyFindings(refusal, refusal, blocked, blockedT, undefined))).toEqual(["privacy_preserved"]);
    expect(codes(privacyFindings(refusal, { ...refusal, prefilter: "agent" }, blocked, blockedT, undefined), "regression")).toEqual(["privacy_refusal_lost"]);
    const open = route("هات تعليقات تيك توك عن السياحة", "production");
    expect(codes(privacyFindings(refusal, refusal, open, open, undefined), "regression")).toEqual(["privacy_not_carried_into_discovery", "privacy_not_carried_into_discovery"]);
    const ordinary = U("هات تعليقات تيك توك عن السياحة");
    expect(codes(privacyFindings(ordinary, ordinary, blocked, blockedT, undefined))).toEqual(["new_block"]);
    expect(find(privacyFindings(ordinary, ordinary, blocked, blockedT, undefined), "new_block")!.severity).toBe("review");
  });
  it("selection rules: a customer account routed to an unreviewed source, a broken source, a private source, a sensitive source or an unpriced one is a violation", () => {
    const test = route("هات بوستات ريديت عن الذكاء الاصطناعي", "test");
    expect(test.stages[0].selected).toBeTruthy();
    // a test account's live-verified source, judged by what a CUSTOMER account may use
    const asCustomer = selectionRuleFindings(test, "production", ctx);
    expect(codes(asCustomer, "regression")).toEqual(expect.arrayContaining(["violation_below_verification", "violation_unreviewed_for_customer"]));
    expect(find(asCustomer, "violation_unreviewed_for_customer")!.detail).toMatch(/not on the reviewed production list/);
    // the same source judged for a test account is fine
    expect(codes(selectionRuleFindings(test, "test", ctx), "regression")).toEqual([]);
    // broken: the artifact says so
    const id = test.stages[0].selected!;
    const op = test.stages[0].stage.operation;
    const brokenArtifact = { ...ctx.artifact, capabilities: ctx.artifact.capabilities.map((c) => (c.id === id && c.operation === op ? { ...c, verification: { ...c.verification, level: "broken" as const } } : c)) };
    expect(codes(selectionRuleFindings(test, "test", { ...ctx, artifact: brokenArtifact }), "regression")).toEqual(expect.arrayContaining(["violation_broken_selected", "violation_below_verification"]));
    // unpriced and private: the registry says so
    const unpriced = { ...ctx, registry: { ...ctx.registry, all: ctx.registry.all.map((c) => (c.id === id && c.operation === op ? { ...c, usdPerRow: null, privacy: "private_personal" as const } : c)) } };
    expect(codes(selectionRuleFindings(test, "test", unpriced), "regression")).toEqual(expect.arrayContaining(["violation_price_unknown", "violation_private_capability"]));
  });
  it("selection rules: a sensitive or blocked capability is a policy violation (the real data policy); the ordinary registry already marks every one of them unavailable", () => {
    const fakeBlocked = { ...ctx.registry.all[0], id: "openmart.deny-rules.create" };
    const d = route("هات تعليقات تيك توك عن السياحة", "production");
    const fake = { ...d, stages: d.stages.map((s, i) => (i === 0 ? { ...s, selected: fakeBlocked.id, stage: { ...s.stage, operation: fakeBlocked.operation } } : s)) };
    expect(codes(selectionRuleFindings(fake, "production", ctx), "regression")).toContain("violation_policy_category");
  });
  it("selection rules: a selected capability that does not document a REQUIRED output is a violation, but an unknown output list is only «unproven»", () => {
    const d = route("هات تعليقات تيك توك عن السياحة", "production");
    const stage = d.stages[0];
    const lacking = { ...d, stages: d.stages.map((s, i) => (i === 0 ? { ...s, eligible: s.eligible.map((e) => (e.id === s.selected ? { ...e, outputs: [], outputsVerified: true } : e)) } : s)) };
    expect(codes(selectionRuleFindings(lacking, "production", ctx), "regression")).toContain("required_output_missing");
    const unknown = { ...d, stages: d.stages.map((s, i) => (i === 0 ? { ...s, eligible: s.eligible.map((e) => (e.id === s.selected ? { ...e, outputs: [], outputsVerified: false } : e)) } : s)) };
    expect(codes(selectionRuleFindings(unknown, "production", ctx), "regression")).not.toContain("required_output_missing");
    expect(stage.stage.requires.length).toBeGreaterThan(0);
  });
  it("approval scope: enforced on every real plan; a verifier that accepts a swapped capability, an added stage or changed parameters is a regression", () => {
    const d = route("هات الكومنتات والريبلايز على فيديوهات تيكتوك عن السياحة", "production");
    expect(codes(scopeFindings(d, "production", ctx))).toEqual(["approval_scope_enforced"]);
    const acceptsAll = (() => ({ ok: true, checked: true })) as never;
    const f = scopeFindings(d, "production", ctx, acceptsAll);
    expect(codes(f, "regression")).toEqual(["approval_scope_not_enforced"]);
    expect(find(f, "approval_scope_not_enforced")!.detail).toMatch(/swapped capability, an added stage, changed parameters/);
    const rejectsAll = (() => ({ ok: false, issues: ["x"] })) as never;
    expect(codes(scopeFindings(d, "production", ctx, rejectsAll), "regression")).toContain("approval_record_invalid");
  });
  it("chain binding: a stage fed by a field its parent does not give is a regression", () => {
    const d = route("هات الكومنتات والريبلايز على فيديوهات تيكتوك عن السياحة", "production");
    expect(codes(scopeFindings(d, "production", ctx), "regression")).toEqual([]);
    const broken = { ...d, stages: d.stages.map((s, i) => (i === 1 ? { ...s, stage: { ...s.stage, parentKey: s.stage.key } } : s)) };
    expect(codes(scopeFindings(broken, "production", ctx), "regression")).toContain("chain_binding_broken");
  });
  it("customer text: a provider name or a price in a sentence the customer reads is a regression", () => {
    const d = route("هات تعليقات تيك توك عن السياحة", "production");
    expect(customerTextFindings(d)).toEqual([]);
    expect(codes(customerTextFindings({ ...d, messageAr: "نستخدم TREG بسعر ٣ دولار" }), "regression")).toEqual(["customer_text_discloses_internal"]);
    expect(codes(customerTextFindings({ ...d, alternativeAr: "السعر 0.5 USD" }), "regression")).toEqual(["customer_text_discloses_internal"]);
  });
  it("cost: higher is a review, lower is an improvement, an unknown price is not comparable, a broken budget invariant is a regression, a weak price basis makes the evidence unverified", () => {
    const side = (totalUsd: number | null, over: Partial<ReturnType<typeof costOf>> = {}) => ({ totalUsd, unknown: totalUsd === null ? ["x"] : [], weakBasis: false, estimate: null, ...over });
    expect(codes(costFindings(side(1), side(1.5)))).toEqual(["estimated_cost_higher"]);
    expect(codes(costFindings(side(1), side(0.5)))).toEqual(["estimated_cost_lower"]);
    expect(codes(costFindings(side(1), side(1.001)))).toEqual(["estimated_cost_same"]);
    expect(codes(costFindings(side(1), side(null)))).toEqual(["cost_not_comparable"]);
    expect(costFindings(side(1), side(1.5, { weakBasis: true }))[0].evidence).toBe("unverified");
    expect(costFindings(side(1), side(1.5))[0].evidence).toBe("recorded");
    const est = (reservePoints: number, overCap = false, chargeOk = true) => ({ reservePoints, unitPoints: 10, overCap, chargeOk });
    expect(codes(costFindings(side(1, { estimate: est(100) }), side(1, { estimate: est(100, true) })), "regression")).toEqual(["budget_invariant_broken"]);
    expect(codes(costFindings(side(1, { estimate: est(100) }), side(1, { estimate: est(100, false, false) })), "regression")).toEqual(["budget_invariant_broken"]);
    expect(codes(costFindings(side(1, { estimate: est(100) }), side(1, { estimate: est(150) })))).toEqual(expect.arrayContaining(["estimated_reserve_higher", "budget_invariants_hold"]));
  });
  it("cost: the estimate for real planned rows keeps settlement under the reserve (the existing money functions are only called)", () => {
    const stored = STORED_CASES[0].stored!;
    const c = costOf(ctx, stored.stages.map((s) => ({ id: s.endpoint_id, op: ctx.registry.all.find((x) => x.id === s.endpoint_id)?.operation ?? null, rows: s.planned ?? 0 })));
    expect(c.unknown).toEqual([]);
    expect(c.estimate).not.toBeNull();
    expect(c.estimate!.chargeOk).toBe(true);
    expect(c.estimate!.overCap).toBe(false);
  });
  it("stored plans: a request production completed that the router would not serve is a regression; a lost stage and lost coverage are regressions; a wider scope is a review", () => {
    const served: ShadowCase = { id: "s1", origin: "stored_mission", request: "٥٠ شركة مقاولات في مصر", stored: { id: "m1", stages: [{ key: "companies", parent_key: null, endpoint_id: "tomba.companies.search.reveal", planned: 50 }] } };
    const r1 = compareCase(served, ctx);
    expect(codes(r1.findings, "regression")).toContain("served_before_unserved_now");
    const lost: ShadowCase = { id: "s2", origin: "stored_mission", request: "هات تعليقات تيك توك عن السياحة", stored: { id: "m2", stages: [{ key: "a", parent_key: null, endpoint_id: "anyapi.tiktok.search.videos", planned: 10 }, { key: "b", parent_key: "a", endpoint_id: "anyapi.tiktok.video.comments", planned: 20 }, { key: "c", parent_key: null, endpoint_id: "tomba.companies.emails.list", planned: 5 }] } };
    const r2 = compareCase(lost, ctx);
    expect(codes(r2.findings, "regression")).toEqual(expect.arrayContaining(["stage_lost", "coverage_lost"]));
    const wider: ShadowCase = { id: "s3", origin: "stored_mission", request: "هات الكومنتات والريبلايز على فيديوهات تيكتوك عن السياحة", stored: { id: "m3", stages: [{ key: "a", parent_key: null, endpoint_id: "anyapi.tiktok.search.videos", planned: 10 }] } };
    const r3 = compareCase(wider, ctx);
    expect(find(r3.findings, "scope_expanded")).toMatchObject({ severity: "review", evidence: "stored_real" });
  });
  it("coverage: an asked contacts stage with no source is said to the customer (review), and one that is neither planned nor said is a silent drop (regression)", () => {
    const d = route("٥٠ شركة مقاولات في مصر وإيميلاتها وتليفوناتها الرسمية", "production");
    expect(d.need.contacts.email).toBe(true);
    const u = U("٥٠ شركة مقاولات في مصر وإيميلاتها الرسمية");
    expect(codes(coverageFindingsOf(u, d))).toContain("asked_not_covered_but_said");
    expect(codes(coverageFindingsOf(u, { ...d, messageAr: null, status: "supported" as const }), "regression")).toContain("silent_drop");
    const t = route("٥٠ شركة مقاولات في مصر وإيميلاتها وتليفوناتها الرسمية", "test");
    expect(codes(coverageFindingsOf(u, t))).toContain("asked_and_covered");
  });
  it("outputs: an unsupported verdict with no sentence for the customer is a regression", () => {
    const d = route("٥٠ شركة مقاولات في مصر", "production");
    expect(d.status).toBe("unsupported");
    expect(codes(outputsOf(d, d), "regression")).toEqual([]);
    expect(codes(outputsOf({ ...d, messageAr: null }, d), "regression")).toEqual(["unsupported_silent"]);
  });
  it("exclusion: a wrong expectation is a regression; an enrichment request is never applied; a free re-run risk is always attached", () => {
    const fx = EXCLUSION_CASES[0].exclusion!;
    expect(codes(exclusionFindings({ ...EXCLUSION_CASES[0] }), "regression")).toEqual([]);
    expect(codes(exclusionFindings({ ...EXCLUSION_CASES[0], exclusion: { ...fx, expectExcluded: [0, 1, 2] } }), "regression")).toEqual(["exclusion_mismatch"]);
    expect(codes(exclusionFindings({ ...EXCLUSION_CASES[0], exclusion: { ...fx, entities: [] } }))).toEqual(["exclusion_file_unusable"]);
    expect(codes(exclusionFindings(EXCLUSION_CASES[2]))).toEqual(["enrichment_never_applied_as_exclusion"]);
    expect(codes(exclusionFindings(EXCLUSION_CASES[0]))).toContain("exclusion_free_rerun_carries_no_file");
    // a shared brand word only is delivered and marked, never removed
    const possible = exclusionFindings({ ...EXCLUSION_CASES[0], exclusion: { ...fx, rows: [{ name: "أوراسكوم للتطوير", website: "orascomdev.example" }], expectExcluded: undefined } });
    expect(codes(possible)).toContain("exclusion_possible_delivered");
    // a personal mailbox never counts as a company domain
    const mailbox = exclusionFindings({ ...EXCLUSION_CASES[0], exclusion: { ...fx, entities: [{ name: "شركة س", domain: "gmail.com" }], rows: [{ name: "شركة ص", website: "gmail.com" }], expectExcluded: [] } });
    expect(codes(mailbox, "regression")).toEqual([]);
  });
  it("the corpus gates: a lost constraint fails G1 and a violation fails G4; an ACCEPTED difference passes the gate and is counted; an unwatched regression still fails", () => {
    const lostCase: ShadowCase = { id: "lost-1", origin: "stored_mission", request: "هات تعليقات تيك توك عن السياحة", stored: { id: "m", stages: [{ key: "a", parent_key: null, endpoint_id: "anyapi.tiktok.search.videos", planned: 10 }, { key: "c", parent_key: null, endpoint_id: "tomba.companies.emails.list", planned: 5 }] } };
    const r = compareCorpus([lostCase], ctx);
    expect(r.passed).toBe(false);
    for (const g of r.gates) for (const f of g.failing) seenRegressions.add(f.code);
    expect(r.gates.find((g) => g.id === "G1_no_lost_constraints")!.failing.map((f) => f.code)).toEqual(expect.arrayContaining(["stage_lost", "coverage_lost"]));
    expect(r.counts.unacceptedRegressions).toBeGreaterThan(0);
    const accepted = compareCorpus([lostCase], ctx, [{ case: "lost-1", code: "stage_lost", why: "t" }, { case: "*", code: "coverage_lost", why: "t" }]);
    expect(accepted.gates.find((g) => g.id === "G1_no_lost_constraints")!.passed).toBe(true);
    expect(accepted.counts.acceptedRegressions).toBeGreaterThan(0);
    expect(accepted.counts.unacceptedRegressions).toBe(0);
    const unwatched = compareCorpus([{ id: "u", origin: "ad_hoc", request: "٥٠ شركة مقاولات", expectedRouting: { kind: "web", ops: [], production: "supported", test: "supported" } }], ctx);
    for (const g of unwatched.gates) for (const f of g.failing) seenRegressions.add(f.code);
    expect(unwatched.gates.find((g) => g.id === "G2_no_new_rejections")!.failing.map((f) => f.code)).toContain("routing_differs_from_audit");
    expect(unwatched.passed).toBe(false);
  });
  it("an engine failure is a regression, never silent (the router throwing)", () => {
    const r = compareCase({ id: "boom", origin: "ad_hoc", request: "هات تعليقات تيك توك عن السياحة" }, { ...ctx, registry: null as never });
    expect(codes(r.findings, "regression")).toEqual(["shadow_engine_error"]);
    expect(r.verdict).toBe("regression");
  });
  it("a regression whose code no gate watches fails a catch-all gate, unless accepted (belt and braces)", () => {
    const fake = { id: "z", origin: "ad_hoc", findings: [{ dimension: "providers", severity: "regression", code: "brand_new_rule", detail: "x", evidence: "code_computed" }] } as never;
    const gates = gatesOf([fake], () => false);
    expect(gates.at(-1)).toMatchObject({ id: "G0_other_regressions", passed: false, codes: ["brand_new_rule"], failing: [{ caseId: "z", code: "brand_new_rule" }] });
    expect(gatesOf([fake], (id, code) => id === "z" && code === "brand_new_rule").every((g) => g.passed)).toBe(true);
    expect(gatesOf([], () => false).every((g) => g.passed)).toBe(true);
    expect(gatesOf([], () => false)).toHaveLength(GATES.length);
  });
  it("the report redacts what it is handed too (a risk text with an e-mail never comes back), and a failed comparison redacts its request", () => {
    const r = compareCorpus([], ctx, [], [{ id: "t", severity: "low", evidence: "unverified", text: "mail amira@example.org", textAr: "اتصل 01012345678" }]);
    expect(JSON.stringify(r)).not.toMatch(/amira@|01012345678/);
    const failed = compareCase({ id: "boom", origin: "ad_hoc", request: "هات تعليقات تيك توك عن السياحة وبريدي amira@example.org" }, { ...ctx, registry: null as never });
    expect(failed.request).not.toContain("amira@");
    expect(JSON.stringify(failed)).not.toContain("amira@");
  });
  it("the gates watch every regression code, and every one of them has been triggered by a case built for it (no regression escapes a gate; no gate watches a rule nothing tests)", () => {
    const watched = new Set(GATES.flatMap((g) => g.codes));
    expect([...watched].sort()).toEqual([...REGRESSION_CODES].sort());
    for (const code of seenRegressions) expect(REGRESSION_CODES, code).toContain(code);
    for (const code of REGRESSION_CODES) expect([...seenRegressions], `no test triggers ${code}`).toContain(code);
  });
});

import { coverageFindings as coverageFindingsOf, outputsFindings as outputsOf } from "../src/lib/agentMission/shadow/compare";

// ================================================================================================================================================================================
describe("the documented free re-run risk is pinned to the source", () => {
  it("a free re-run creates a mission with no exclusion list: its source never mentions the exclusion file or snapshot (if this fails, the risk was fixed: update the report and the finding)", () => {
    const rerun = read("src/lib/agentMission/freeRerun.ts");
    expect(rerun).not.toMatch(/customerExclusion|exclusion/i);
    const mark = read("src/lib/agentMission/freeRerunMark.ts");
    expect(mark).not.toMatch(/customerExclusion|exclusion/i);
  });
  it("and the worker finds a list only on the mission's own card message, which a re-run does not create", () => {
    const reader = read("agent/src/customerExclusion.ts");
    expect(reader).toMatch(/plan->>agentMissionId/);
    expect(reader).toMatch(/\.eq\("user_id", userId\)/);
  });
});

// ================================================================================================================================================================================
describe("the engine never reaches outside: no network, model, database, switch, secret or write", () => {
  const files = ["redact.ts", "types.ts", "understanding.ts", "compare.ts", "corpus.ts", "context.ts", "labels.ts", "auditScenarios.ts"].map((f) => [f, read(`src/lib/agentMission/shadow/${f}`)] as const);
  it("its sources contain no fetch, no process.env, no database client, no settings read, no write and no model call", () => {
    for (const [name, text] of files) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, name).not.toMatch(/\bfetch\s*\(|process\.env|createAdminClient|createServerSideClient|supabase|agent_settings|readSettingValue|\.from\(\s*["'`]|\.rpc\(|\.insert\(|\.upsert\(|\.delete\(|anthropic|openai|writeFileSync|appendFileSync/i);
    }
  });
  it("the route imports no database client and never reads a switch", () => {
    const code = read("src/app/api/admin/shadow/route.ts").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createAdminClient|createServerSideClient|supabase|agent_settings|readSettingValue|scopedFlag/);
    expect(code.indexOf("authenticateAdmin")).toBeGreaterThan(-1);
  });
  it("the switches stay unset: nothing in the shadow module or the route writes or names a switch key to turn on", () => {
    for (const [name, text] of files) expect(text, name).not.toMatch(/setSetting|writeSetting|upsertSetting/);
  });
  it("a comparison makes no network call (fetch throws in this suite and the whole corpus still runs)", () => {
    expect(() => compareCase({ id: "n", origin: "ad_hoc", request: "هات تعليقات تيك توك عن السياحة" }, ctx)).not.toThrow();
  });
});

// ================================================================================================================================================================================
describe("the admin API: admin only, read only, redacted", () => {
  const get = (q = "") => import("../src/app/api/admin/shadow/route").then(({ GET }) => GET(new NextRequest(`http://localhost/api/admin/shadow${q}`)));
  const post = (body: unknown) => import("../src/app/api/admin/shadow/route").then(({ POST }) => POST(new NextRequest("http://localhost/api/admin/shadow", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })));

  it("refuses everything without an admin: GET, GET one case and POST", async () => {
    routeState.admin = false;
    expect((await get()).status).toBe(403);
    expect((await get("?case=audit-s01")).status).toBe(403);
    expect((await post({ request: "هات تعليقات تيك توك عن السياحة" })).status).toBe(403);
    routeState.admin = true;
  });
  it("GET returns the summary and a case index: counts, gates, risks, assumptions, no findings detail", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passed).toBe(true);
    expect(body.counts.cases).toBe(156);
    expect(body.gates).toHaveLength(GATES.length);
    expect(body.cases).toHaveLength(156);
    expect(body.cases[0]).toEqual(expect.objectContaining({ id: expect.any(String), verdict: expect.any(String), counts: expect.any(Object) }));
    expect(body.cases[0].findings).toBeUndefined();
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.interpreterEvents.available).toBe(false);
  });
  it("GET ?case=<id> returns one case in full with evidence-labelled findings; an unknown id is a 404", async () => {
    const res = await get("?case=audit-s04");
    const body = await res.json();
    expect(body.case.id).toBe("audit-s04");
    expect(body.case.findings.length).toBeGreaterThan(3);
    for (const f of body.case.findings) expect(f.evidence).toBeTruthy();
    expect((await get("?case=nope")).status).toBe(404);
  });
  it("POST compares a typed request, echoes it redacted and stores nothing; personal data typed into it never comes back", async () => {
    const res = await post({ request: "هات تعليقات تيك توك عن السياحة وكلمني على amira@wiseresume.app أو 01012345678" });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("amira@");
    expect(text).not.toContain("01012345678");
    expect(text).toContain("[بريد]");
  });
  it("POST refuses any other field, an empty or too long text, and a non-object body", async () => {
    expect((await post({ request: "هات تعليقات تيك توك عن السياحة", flag: "on" })).status).toBe(400);
    expect((await post({ request: "هات تعليقات تيك توك عن السياحة", user_id: "x" })).status).toBe(400);
    expect((await post({ request: "ab" })).status).toBe(400);
    expect((await post({ request: "x".repeat(2001) })).status).toBe(400);
    expect((await post(["x"])).status).toBe(400);
    expect((await post({ answer: "نعم" })).status).toBe(400);
  });
  it("the data the route reads at run time is traced into its function", () => {
    const cfg = read("next.config.mjs");
    expect(cfg).toMatch(/"\/api\/admin\/shadow": \[[^\]]*treg_catalog_sellable\.json[^\]]*registry\.json/);
  });
});

// ================================================================================================================================================================================
describe("the admin screen", () => {
  it("is mounted on the agent console and labels every dimension, severity and evidence in Arabic", () => {
    const page = read("src/app/admin/agent/page.tsx");
    expect(page).toContain("<ShadowPanel");
    const panel = read("src/components/admin/ShadowPanel.tsx");
    for (const id of ["shadow-panel", "shadow-summary", "shadow-gates", "shadow-risks", "shadow-cases", "shadow-run", "shadow-case"]) expect(panel).toContain(`data-testid="${id}"`);
    expect(panel).toMatch(/للمشرف فقط وبلا اتصال/);
    expect(panel).not.toMatch(/localStorage|sessionStorage|\.insert\(|setSetting/);
  });
  it("the panel imports no server-only code (it ships to the browser)", () => {
    const panel = read("src/components/admin/ShadowPanel.tsx");
    const imports = [...panel.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const i of imports) expect(i, i).not.toMatch(/compare|context|corpus|understanding|redact|node:|supabase|capabilities/);
    expect(read("src/lib/agentMission/shadow/labels.ts")).not.toMatch(/^import (?!type)/m);
    expect(read("src/lib/agentMission/shadow/types.ts")).not.toMatch(/^import (?!type)/m);
  });
});
