import { createHash } from "node:crypto";
import type { TregCatalog } from "../../treg/catalog";
import { policyVerdict } from "../../treg/dataPolicy";
import {
  capabilitySelectionOf, chainBindingIssues, discoverCapabilities, limitationLinesAr, researchNeedOf, verifyApprovedScope,
  type CapabilityDiscovery, type CapabilityRegistry,
} from "../capabilities";
import type { RegistryArtifact } from "../capabilities/artifact";
import { levelRank, type VerificationLevel } from "../capabilities/evidence";
import type { RoutingFacts } from "../capabilities/router";
import { exclusionMatcherOf, exclusionSnapshotOf, organisationOfRow, uploadIntentOf } from "../customerExclusion";
import { chargeForDelivered, priceMissionByCode, settlementCharge } from "../price";
import { PROVIDER_LABELS } from "../providerLabels";
import { redactDeep } from "./redact";
import {
  DIMENSIONS, SEVERITY_ORDER,
  type CaseResult, type DimensionId, type Evidence, type ExclusionFixture, type Finding, type Gate, type ProposedView, type Risk, type Severity, type ShadowCase, type ShadowReport,
} from "./types";
import { SHADOW_NOW_MS, understandForShadow, type Understood } from "./understanding";

/**
 * PHASE 7: THE SHADOW ENGINE. `compareCase` runs ONE request through production today and through the proposed behaviour and returns every difference as a typed, evidence-labelled finding; `compareCorpus` rolls many cases into a report with
 * objective gates (audit §10.4). Pure and deterministic: the same case and context give the same bytes. No provider, model, database, switch, price table or balance is touched; money functions are only CALLED (read-only) to estimate.
 *
 * WHAT «TODAY» AND «PROPOSED» MEAN HERE
 *   today    = every Intelligence switch OFF: the words reading without the semantic layer, the chat's fixed pre-model guards, the compiled social path, the legacy planner for everything else (a MODEL: its choice cannot be replayed offline,
 *              so for a request with no stored approved plan the baseline provider choice is «not reproducible», never invented), no exclusion list applied, no enrichment step.
 *   proposed = the switches ON for the account kind: `semantic_normalization_v1`, `capability_discovery_v1` + `registry_router` (+ `web_via_treg`), `customer_exclusion_files_v1`. A customer account uses production-eligible capabilities only; a test account
 *              also uses fixture- and live-verified ones (the controlled-activation path).
 */

export interface ShadowContext {
  catalog: TregCatalog;
  artifact: RegistryArtifact;
  registry: CapabilityRegistry;
  /** The router's facts for an account kind (customer: production-eligible only; test: fixture- or live-verified). */
  facts: (account: "production" | "test") => RoutingFacts;
  nowMs?: number;
}

const PROVIDER_WORD = new RegExp(`(?<![a-z])(?:${PROVIDER_LABELS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-z])`, "i");

const finding = (dimension: DimensionId, severity: Severity, code: string, detail: string, evidence: Evidence, extra: Pick<Finding, "verified" | "baseline" | "proposed"> = {}): Finding => ({ dimension, severity, code, detail, evidence, ...extra });
const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === "" || v === "none" || v === false || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const AR_NUM = /[٠-٩]/g;
const numberOf = (v: unknown): unknown => (typeof v === "string" && /^[٠-٩\d]+$/.test(v) ? Number(v.replace(AR_NUM, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))) : v);

const levelMaps = new WeakMap<RegistryArtifact, Map<string, VerificationLevel>>();
function levelOf(ctx: ShadowContext, id: string, operation: string | null): VerificationLevel | null {
  let m = levelMaps.get(ctx.artifact);
  if (!m) { m = new Map(ctx.artifact.capabilities.map((c) => [`${c.id}#${c.operation}`, c.verification.level] as const)); levelMaps.set(ctx.artifact, m); }
  return operation ? m.get(`${id}#${operation}`) ?? null : null;
}
const capOf = (ctx: ShadowContext, id: string, operation?: string | null) => ctx.registry.all.find((c) => c.id === id && (!operation || c.operation === operation)) ?? ctx.registry.all.find((c) => c.id === id) ?? null;

// ================================================================================================================================================================================
// understanding and conditions: the words reading today vs with the semantic layer
// ================================================================================================================================================================================
const UNDERSTANDING_FIELDS = ["kind", "comments", "replies", "topic", "source_named", "media", "route", "wants_email", "wants_phone", "wants"] as const;
const CONDITION_FIELDS = ["platform", "count", "country", "period", "language", "country_present", "period_present", "language_present"] as const;
type Field = (typeof UNDERSTANDING_FIELDS)[number] | (typeof CONDITION_FIELDS)[number];

function compareField(dimension: "understanding" | "conditions", field: Field, base: Understood, prop: Understood, expected: ShadowCase["expected"], knownGap: string | undefined): Finding | null {
  const b = (base as unknown as Record<string, unknown>)[field];
  const p = (prop as unknown as Record<string, unknown>)[field];
  const hasExpected = expected !== undefined && field in expected;
  const e = hasExpected ? numberOf((expected as Record<string, unknown>)[field]) : undefined;
  if (same(b, p)) {
    if (hasExpected && !same(b, e) && !(isEmpty(b) && isEmpty(e))) return finding(dimension, "review", "expectation_unmet_both", `${field}: neither today's reading nor the semantic layer matches the labelled meaning${knownGap ? ` (known gap: ${knownGap})` : ""}`, "stored_real", { verified: true, baseline: b, proposed: p });
    return null;
  }
  if (hasExpected) {
    if (same(p, e) || (isEmpty(p) && isEmpty(e))) return finding(dimension, "improvement", "corrected_to_expected", `${field}: the semantic layer reads what the customer meant (today's reading differs)`, "stored_real", { verified: true, baseline: b, proposed: p });
    if (same(b, e) || (isEmpty(b) && isEmpty(e))) return finding(dimension, "regression", "now_wrong", `${field}: today's reading was right and the semantic layer breaks it`, "stored_real", { verified: true, baseline: b, proposed: p });
    return finding(dimension, "review", "both_differ_from_expected", `${field}: both readings differ from the labelled meaning, and from each other`, "stored_real", { verified: true, baseline: b, proposed: p });
  }
  if (isEmpty(b) && !isEmpty(p)) return finding(dimension, "improvement", "filled", `${field}: a value the words carry that today's reading left empty (no labelled expectation to confirm it)`, "code_computed", { baseline: b, proposed: p });
  if (!isEmpty(b) && isEmpty(p)) return finding(dimension, "regression", dimension === "conditions" ? "condition_lost" : "understanding_lost", `${field}: a value today's reading found is lost`, "code_computed", { baseline: b, proposed: p });
  return finding(dimension, "review", "value_changed", `${field}: the two readings give different values and there is no labelled expectation`, "code_computed", { baseline: b, proposed: p });
}

/** The fields that only exist because of the platform the words were read as (a «tweets» kind comes from an X read, comments and replies from the kind): when the platform itself was verifiably corrected, clearing them is its consequence. */
const PLATFORM_DEPENDENT: ReadonlySet<string> = new Set(["kind", "comments", "replies", "media", "source_named"]);

export function understandingFindings(c: ShadowCase, base: Understood, prop: Understood): Finding[] {
  const out: Finding[] = [];
  for (const f of UNDERSTANDING_FIELDS) { const x = compareField("understanding", f, base, prop, c.expected, c.knownGap); if (x) out.push({ ...x, field: f } as Finding); }
  for (const f of CONDITION_FIELDS) { const x = compareField("conditions", f, base, prop, c.expected, c.knownGap); if (x) out.push({ ...x, field: f } as Finding); }
  const fieldOf = (f: Finding): string => String((f as Finding & { field?: string }).field ?? "");
  // a value cleared together with a verified platform correction is that correction's consequence, not a lost constraint
  const platformFixed = out.some((f) => fieldOf(f) === "platform" && f.code === "corrected_to_expected");
  const platformFilled = out.some((f) => fieldOf(f) === "platform" && (f.code === "filled" || f.code === "corrected_to_expected"));
  const fold = (t: unknown): string => String(t ?? "").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();
  const adjusted = out.map((f): Finding => {
    const field = fieldOf(f);
    if (platformFixed && f.code === "understanding_lost" && PLATFORM_DEPENDENT.has(field)) return { ...f, severity: "improvement", code: "cleared_with_corrected_platform", detail: `${field}: cleared together with the platform it depended on (the platform itself was read wrongly today and is corrected)`, verified: true };
    // the semantic layer takes a date, country or language phrase OUT of the topic: a shorter topic that is contained in today's one
    if (f.code === "value_changed" && field === "topic" && typeof f.baseline === "string" && typeof f.proposed === "string" && fold(f.proposed).length > 0 && fold(f.proposed).length < fold(f.baseline).length && fold(f.baseline).includes(fold(f.proposed))) return { ...f, severity: "improvement", code: "topic_tightened", detail: "topic: a condition phrase (a date, a country, a language or an output word) is no longer part of the topic (no labelled expectation to confirm it)" };
    // the platform is now known, so the request takes the compiled path instead of asking which platform
    if (f.code === "value_changed" && field === "route" && f.proposed === "compiled" && (f.baseline === "platform_question" || f.baseline === "clarify") && platformFilled) return { ...f, severity: "improvement", code: "route_follows_platform", detail: "route: the platform is now read from the words, so the request takes the compiled path instead of asking which platform (no labelled expectation to confirm it)" };
    return f;
  });
  // a KNOWN-GAP case where the layer corrects more fields than it breaks is a recorded partial improvement (the Phase 1 baseline calls it «partial»), not a regression: said as a trade-off to review
  const corrected = adjusted.filter((f) => f.code === "corrected_to_expected").length;
  const broken = adjusted.filter((f) => f.code === "now_wrong").length;
  const tradeOff = c.knownGap !== undefined && broken > 0 && corrected >= broken;
  const finalList = adjusted.map((f) => (tradeOff && f.code === "now_wrong" ? { ...f, severity: "review" as const, code: "partial_trade_off", detail: `${f.detail} — on a recorded known-gap case that is net better (${corrected} corrected, ${broken} now wrong); needs the owner's eye` } : f));
  return finalList.map((f) => { const { field: _field, ...rest } = f as Finding & { field?: string }; return rest as Finding; });
}

// ================================================================================================================================================================================
// the proposed routing
// ================================================================================================================================================================================
export function discover(c: ShadowCase, ctx: ShadowContext, account: "production" | "test"): CapabilityDiscovery {
  const need = researchNeedOf({ request: c.request, ...(c.answer ? { answer: c.answer } : {}), ...(c.brief ? { brief: c.brief as never } : {}), extendedFamilies: true });
  return discoverCapabilities(need, ctx.registry, { routing: ctx.facts(account) });
}

export function viewOf(d: CapabilityDiscovery, ctx: ShadowContext): ProposedView {
  return {
    status: d.status,
    kind: d.need.kind,
    stages: d.stages.map((s) => {
      const sel = s.selected ? s.eligible.find((e) => e.id === s.selected) ?? null : null;
      return { operation: s.stage.operation, platform: s.stage.platform, selected: s.selected, level: s.selected ? levelOf(ctx, s.selected, s.stage.operation) : null, usdPerRow: sel?.usdPerRow ?? null, candidates: s.eligible.length };
    }),
    unsupported: d.unsupported.map((u) => ({ operation: u.operation, reason: u.reason })),
    limitations: [...new Set(d.limitations.map((l) => `${l.code}${l.filter ? `:${l.filter}` : ""}`))],
  };
}

/** Hard rules on what the router selected: a violation is a regression whatever the baseline did («do not silently approve new provider capabilities»). */
export function selectionRuleFindings(d: CapabilityDiscovery, account: "production" | "test", ctx: ShadowContext): Finding[] {
  const out: Finding[] = [];
  const minRank = levelRank(ctx.facts(account).minLevel);
  for (const s of d.stages) {
    if (!s.selected) continue;
    const op = s.stage.operation;
    const cap = capOf(ctx, s.selected, op);
    const level = levelOf(ctx, s.selected, op) ?? "advertised";
    const tag = `${account}:${op}:${s.selected}`;
    if (levelRank(level) < minRank) out.push(finding("providers", "regression", "violation_below_verification", `${tag} is selected at level «${level}», below what a ${account} account may use`, "code_computed", { verified: true, proposed: level }));
    if (level === "broken" || level === "deprecated") out.push(finding("providers", "regression", "violation_broken_selected", `${tag} is selected although its level is «${level}»`, "recorded", { verified: true }));
    if (account === "production" && level !== "production_eligible") out.push(finding("providers", "regression", "violation_unreviewed_for_customer", `${tag} is not on the reviewed production list yet is selected for a customer account`, "code_computed", { verified: true }));
    if (cap && cap.privacy !== "public") out.push(finding("privacy", "regression", "violation_private_capability", `${tag} returns private personal data`, "code_computed", { verified: true }));
    const verdict = policyVerdict(s.selected, { isAdmin: false, verifiedBusiness: false });
    if (!verdict.allowed || verdict.category === "sensitive") out.push(finding("privacy", "regression", "violation_policy_category", `${tag} is «${verdict.category}» and not allowed for an ordinary account`, "code_computed", { verified: true }));
    if (cap && cap.usdPerRow === null) out.push(finding("cost", "regression", "violation_price_unknown", `${tag} is selected with no known price`, "code_computed", { verified: true }));
    const cand = s.eligible.find((e) => e.id === s.selected);
    // (outputs the registry does not know are PROVEN on a sampled page at plan time, and reported below as «unproven»; only known outputs are checked here)
    if (cand && cand.outputsVerified) for (const need of s.stage.requires) if (!cand.outputs.includes(need)) out.push(finding("outputs", "regression", "required_output_missing", `${tag} does not document the required output «${need}»`, "code_computed", { verified: true }));
  }
  return out;
}

export function scopeFindings(d: CapabilityDiscovery, account: "production" | "test", ctx: ShadowContext, verify: typeof verifyApprovedScope = verifyApprovedScope): Finding[] {
  const sel = d.stages.filter((s) => s.selected);
  if (sel.length === 0) return [];
  const out: Finding[] = [];
  const issues = chainBindingIssues(sel);
  if (issues.length > 0) out.push(finding("chaining", "regression", "chain_binding_broken", `${account}: a stage is fed by a field its parent does not give (${issues.join("; ").slice(0, 200)})`, "code_computed", { verified: true }));
  const plan = { stages: sel.map((s) => ({ key: s.stage.key, endpoint_id: s.selected!, parent_key: s.stage.parentKey, params: { q: "x", limit: 20 } })) };
  const approved = { ...plan, capability_selection: capabilitySelectionOf(plan, d) };
  const intact = verify(approved, ctx.catalog);
  if (!(intact.ok && intact.checked)) out.push(finding("chaining", "regression", "approval_record_invalid", `${account}: the plan's own approval record does not verify`, "code_computed", { verified: true }));
  const first = plan.stages[0];
  const swapped = { ...approved, stages: approved.stages.map((s, i) => (i === 0 ? { ...s, endpoint_id: first.endpoint_id === "anyapi.x.search.posts" ? "anyapi.tiktok.search.videos" : "anyapi.x.search.posts" } : s)) };
  const added = { ...approved, stages: [...approved.stages, { key: "shadow_extra", endpoint_id: "anyapi.x.search.posts", parent_key: null, params: {} }] };
  const bigger = { ...approved, stages: approved.stages.map((s) => ({ ...s, params: { ...s.params, limit: 500 } })) };
  const refused = [swapped, added, bigger].map((p) => !verify(p, ctx.catalog).ok);
  if (refused.every(Boolean)) out.push(finding("chaining", "same", "approval_scope_enforced", `${account}: a swapped capability, an added stage and changed parameters after approval are all refused`, "code_computed", { verified: true }));
  else out.push(finding("chaining", "regression", "approval_scope_not_enforced", `${account}: ${["a swapped capability", "an added stage", "changed parameters"].filter((_, i) => !refused[i]).join(", ")} would be accepted after approval`, "code_computed", { verified: true }));
  return out;
}

export function customerTextFindings(d: CapabilityDiscovery): Finding[] {
  const texts = [d.messageAr, d.alternativeAr, ...limitationLinesAr(d)].filter((x): x is string => typeof x === "string");
  const bad = texts.filter((t) => PROVIDER_WORD.test(t) || /\$|USD|دولار|سنت/.test(t));
  return bad.length > 0 ? [finding("privacy", "regression", "customer_text_discloses_internal", `${bad.length} customer-facing sentence(s) name a provider or a price`, "code_computed", { verified: true })] : [];
}

// ================================================================================================================================================================================
// the baseline: the stored approved plan, compared stage by stage with the router (customer account)
// ================================================================================================================================================================================
export function storedFindings(c: ShadowCase, ctx: ShadowContext, prod: CapabilityDiscovery): { findings: Finding[]; stored: NonNullable<CaseResult["baseline"]["stored"]> } {
  const out: Finding[] = [];
  const stored: NonNullable<CaseResult["baseline"]["stored"]> = [];
  if (!c.stored) return { findings: out, stored };
  const used = new Map<string, number>();
  for (const st of c.stored.stages) {
    const op = capOf(ctx, st.endpoint_id)?.operation ?? null;
    stored.push({ key: st.key, endpoint: st.endpoint_id, operation: op, level: op ? levelOf(ctx, st.endpoint_id, op) : null });
    const candidates = prod.stages.filter((s) => s.stage.operation === op);
    const s = candidates[Math.min(used.get(String(op)) ?? 0, Math.max(0, candidates.length - 1))];
    used.set(String(op), (used.get(String(op)) ?? 0) + 1);
    const lvl = op ? levelOf(ctx, st.endpoint_id, op) : null;
    if (!s) { out.push(finding("providers", "review", "historical_stage_no_proposed_stage", `${st.endpoint_id} (${op ?? "unknown operation"}) has no stage in the proposed chain`, "stored_real", { baseline: st.endpoint_id })); continue; }
    if (s.selected === st.endpoint_id) { out.push(finding("providers", "same", "provider_same", `${st.endpoint_id}: the router chooses the historical source`, "stored_real")); continue; }
    if (s.eligible.some((e) => e.id === st.endpoint_id)) { out.push(finding("providers", "review", "provider_changed_validated", `${st.endpoint_id} is still a validated candidate; the router prefers ${s.selected}`, "stored_real", { baseline: st.endpoint_id, proposed: s.selected })); continue; }
    const reason = s.rejected.find((r) => r.id === st.endpoint_id)?.reason ?? "not_a_candidate";
    if (reason === "broken_or_deprecated") out.push(finding("providers", "improvement", "historical_source_broken_avoided", `${st.endpoint_id} is measured broken (billed calls with no usable rows); the router avoids it`, "recorded", { verified: true, baseline: st.endpoint_id, proposed: s.selected }));
    else if (reason === "below_verification") out.push(finding("providers", "review", "historical_source_below_verification", `${st.endpoint_id} (level «${lvl ?? "?"}») is used historically but is not on the reviewed production list: a customer account would lose it until the owner promotes it with evidence`, "recorded", { baseline: st.endpoint_id, proposed: s.selected }));
    else out.push(finding("providers", "review", `historical_source_not_routable`, `${st.endpoint_id} is not routable (${reason})`, "stored_real", { baseline: st.endpoint_id, proposed: s.selected }));
  }
  // what the customer was served before vs now
  if (prod.status !== "supported") out.push(finding("outputs", "regression", "served_before_unserved_now", `a request that production completed is «${prod.status}» for a customer account under the router`, "stored_real", { verified: true, baseline: "served", proposed: prod.status }));
  // the stage structure
  const baseOps = stored.map((s) => s.operation ?? "?");
  const propOps = prod.stages.filter((s) => s.selected).map((s) => s.stage.operation);
  const lost = baseOps.filter((o) => !propOps.includes(o as never));
  const added = propOps.filter((o) => !baseOps.includes(o));
  if (lost.length > 0) out.push(finding("chaining", "regression", "stage_lost", `stage(s) of the approved plan are not in the proposed chain: ${[...new Set(lost)].join(", ")}`, "stored_real", { verified: true, baseline: baseOps, proposed: propOps }));
  if (added.length > 0) out.push(finding("chaining", "review", "scope_expanded", `the proposed chain adds stage(s) the approved plan did not have: ${[...new Set(added)].join(", ")} (the customer would approve a different scope)`, "stored_real", { baseline: baseOps, proposed: propOps }));
  if (lost.length === 0 && added.length === 0) out.push(finding("chaining", "same", "stage_structure_same", "the proposed chain has the same operations as the approved plan", "stored_real"));
  // coverage of what was asked, from the stored stages' operations
  for (const op of ["company.contacts", "people.discover", "company.enrich"] as const) {
    if (baseOps.includes(op) && !propOps.includes(op)) out.push(finding("coverage", "regression", "coverage_lost", `the approved plan had a ${op} stage; the proposed chain has none`, "stored_real", { verified: true }));
  }
  // cost, apples to apples: the same planned rows through the proposed capability of the same operation
  const baseCost = costOf(ctx, c.stored.stages.map((st) => ({ id: st.endpoint_id, op: capOf(ctx, st.endpoint_id)?.operation ?? null, rows: st.planned ?? 0 })));
  const queues = new Map<string, string[]>();
  for (const s of prod.stages) if (s.selected) queues.set(s.stage.operation, [...(queues.get(s.stage.operation) ?? []), s.selected]);
  const propCost = costOf(ctx, c.stored.stages.map((st) => { const op = capOf(ctx, st.endpoint_id)?.operation ?? null; const q = op ? queues.get(op) : undefined; const id = q && q.length > 0 ? (q.length > 1 ? q.shift()! : q[0]) : null; return { id: id ?? "", op, rows: st.planned ?? 0 }; }));
  out.push(...costFindings(baseCost, propCost));
  return { findings: out, stored };
}

export interface CostSide { totalUsd: number | null; unknown: string[]; weakBasis: boolean; estimate: { reservePoints: number; unitPoints: number; overCap: boolean; chargeOk: boolean } | null }
export function costOf(ctx: ShadowContext, stages: Array<{ id: string; op: string | null; rows: number }>): CostSide {
  let total = 0;
  const unknown: string[] = [];
  let weak = false;
  const inputs: Array<{ rows: number; costPerRowUsd: number; deliver: boolean }> = [];
  for (const s of stages) {
    const cap = s.id ? capOf(ctx, s.id, s.op) : null;
    if (!cap || cap.usdPerRow === null) { unknown.push(s.id || "(no stage)"); continue; }
    if (cap.pricing.basis === "estimated" || cap.pricing.basis === "unknown") weak = true;
    total += cap.usdPerRow * Math.max(0, s.rows);
    if (s.rows > 0 && cap.usdPerRow > 0) inputs.push({ rows: s.rows, costPerRowUsd: cap.usdPerRow, deliver: true });
  }
  let estimate: CostSide["estimate"] = null;
  if (unknown.length === 0 && inputs.length > 0) {
    try {
      const r = priceMissionByCode(inputs);
      const delivered = r.deliveredRows;
      const settled = settlementCharge({ deliveredUnits: delivered, unitPricePoints: r.unitPricePoints, reservedPoints: r.reservePoints });
      estimate = { reservePoints: r.reservePoints, unitPoints: r.unitPricePoints, overCap: r.overCap, chargeOk: settled.chargedPoints <= r.reservePoints && chargeForDelivered(delivered, r.unitPricePoints) >= 0 };
    } catch { estimate = null; }
  }
  return { totalUsd: unknown.length === 0 ? total : null, unknown, weakBasis: weak, estimate };
}

export function costFindings(base: CostSide, prop: CostSide): Finding[] {
  const out: Finding[] = [];
  const evidence: Evidence = base.weakBasis || prop.weakBasis ? "unverified" : "recorded";
  if (base.totalUsd === null || prop.totalUsd === null) {
    out.push(finding("cost", "review", "cost_not_comparable", `an estimate needs a known price for every stage (unknown: ${[...base.unknown, ...prop.unknown].join(", ") || "none"})`, "unverified"));
  } else {
    const pct = base.totalUsd === 0 ? (prop.totalUsd === 0 ? 0 : 100) : ((prop.totalUsd - base.totalUsd) / base.totalUsd) * 100;
    const detail = `estimated provider cost for the same planned rows: ${base.totalUsd.toFixed(5)} → ${prop.totalUsd.toFixed(5)} USD (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%), from catalog prices, not measured`;
    if (pct > 1) out.push(finding("cost", "review", "estimated_cost_higher", detail, evidence, { baseline: base.totalUsd, proposed: prop.totalUsd }));
    else if (pct < -1) out.push(finding("cost", "improvement", "estimated_cost_lower", detail, evidence, { baseline: base.totalUsd, proposed: prop.totalUsd }));
    else out.push(finding("cost", "same", "estimated_cost_same", detail, evidence, { baseline: base.totalUsd, proposed: prop.totalUsd }));
  }
  if (prop.estimate) {
    if (prop.estimate.overCap || !prop.estimate.chargeOk) out.push(finding("cost", "regression", "budget_invariant_broken", "the proposed plan's estimate exceeds the job cap or a charge above its reserve", "code_computed", { verified: true }));
    else out.push(finding("cost", "same", "budget_invariants_hold", `the proposed plan's estimated reserve is ${prop.estimate.reservePoints} points (unit ${prop.estimate.unitPoints}); settlement can never charge above the reserve or the cap`, "code_computed", { verified: true, proposed: prop.estimate.reservePoints }));
    if (base.estimate && prop.estimate.reservePoints > base.estimate.reservePoints) out.push(finding("cost", "review", "estimated_reserve_higher", `the estimated reserve rises from ${base.estimate.reservePoints} to ${prop.estimate.reservePoints} points (the customer would be quoted more)`, evidence, { baseline: base.estimate.reservePoints, proposed: prop.estimate.reservePoints }));
  }
  return out;
}

// ================================================================================================================================================================================
// privacy, coverage, outputs for any request
// ================================================================================================================================================================================
export function privacyFindings(base: Understood, prop: Understood, prod: CapabilityDiscovery, test: CapabilityDiscovery, expected: ShadowCase["expected"]): Finding[] {
  const out: Finding[] = [];
  const refusal = base.prefilter === "privacy_refusal" || base.guard.privateContact || base.guard.privateMessages || base.guard.personalIdentifier;
  if (base.prefilter !== prop.prefilter) out.push(finding("privacy", base.prefilter.startsWith("privacy") ? "regression" : "review", base.prefilter.startsWith("privacy") ? "privacy_refusal_lost" : "prefilter_changed", `the chat's fixed pre-model answer changes from «${base.prefilter}» to «${prop.prefilter}»`, "code_computed", { verified: true, baseline: base.prefilter, proposed: prop.prefilter }));
  else if (expected && "prefilter" in expected && !same(prop.prefilter, expected.prefilter)) out.push(finding("privacy", "review", "expectation_unmet_both", `the chat's pre-filter «${prop.prefilter}» differs from the labelled «${String(expected.prefilter)}»`, "stored_real", { verified: true }));
  if (refusal) {
    for (const [account, d] of [["production", prod], ["test", test]] as const) {
      if (d.status !== "blocked" || d.stages.length > 0) out.push(finding("privacy", "regression", "privacy_not_carried_into_discovery", `${account}: the guard refuses this request but the router returns «${d.status}» with ${d.stages.length} stage(s)`, "code_computed", { verified: true }));
    }
    if (prod.status === "blocked" && test.status === "blocked") out.push(finding("privacy", "same", "privacy_preserved", "the request stays refused before and after, and the router plans nothing for it", "code_computed", { verified: true }));
  } else if (prod.status === "blocked") {
    out.push(finding("privacy", "review", "new_block", "the router blocks a request the chat's guard lets through (a possible unnecessary rejection)", "code_computed", { baseline: base.prefilter, proposed: "blocked" }));
  }
  return out;
}

export function coverageFindings(prop: Understood, prod: CapabilityDiscovery): Finding[] {
  const out: Finding[] = [];
  const n = prod.need;
  const selected = (op: string) => prod.stages.some((s) => s.stage.operation === op && s.selected);
  const asked: Array<[string, boolean, boolean]> = [
    ["websites", n.websites, prod.stages.some((s) => s.stage.operation === "companies.discover" && s.selected && s.stage.requires.includes("website" as never))],
    ["public_contacts", n.contacts.email || n.contacts.phone, selected("company.contacts")],
    ["professionals", n.people, selected("people.discover")],
  ];
  for (const [name, wanted, covered] of asked) {
    if (!wanted) continue;
    if (covered) out.push(finding("coverage", "same", "asked_and_covered", `${name}: asked, and a stage is selected for it`, "code_computed", { verified: true }));
    else if (prod.messageAr || prod.status === "unsupported") out.push(finding("coverage", "review", "asked_not_covered_but_said", `${name}: asked, no capability is selected for a customer account; the customer is told (nothing is dropped silently)`, "code_computed", { verified: true }));
    else out.push(finding("coverage", "regression", "silent_drop", `${name}: asked, not planned and not said`, "code_computed", { verified: true }));
  }
  if (prop.wants_email && !n.contacts.email && n.kind === "companies") out.push(finding("coverage", "review", "contact_words_not_in_need", "the words ask for an e-mail but the router's need does not carry it", "code_computed"));
  return out;
}

export function outputsFindings(prod: CapabilityDiscovery, test: CapabilityDiscovery): Finding[] {
  const out: Finding[] = [];
  for (const [account, d] of [["production", prod], ["test", test]] as const) {
    if (d.status === "unsupported" || d.status === "partial" || d.status === "blocked") {
      if (!d.messageAr) out.push(finding("outputs", "regression", "unsupported_silent", `${account}: «${d.status}» with no sentence for the customer`, "code_computed", { verified: true }));
      else out.push(finding("outputs", "info", `stated_${d.status}`, `${account}: «${d.status}» and the customer is told${d.unsupported.length ? ` (${[...new Set(d.unsupported.map((u) => u.reason))].join(", ")})` : ""}`, "code_computed"));
    }
    for (const l of d.limitations) out.push(finding("outputs", "info", `limitation_${l.code}`, `${account}: ${l.code}${l.filter ? ` (${l.filter})` : ""} on ${l.stageKey}${l.textAr ? ", said to the customer" : ", internal"}`, "code_computed"));
    for (const s of d.stages) {
      const sel = s.selected ? s.eligible.find((e) => e.id === s.selected) : null;
      if (sel && !sel.outputsVerified) out.push(finding("outputs", "review", "outputs_unproven", `${account}: ${s.stage.operation} uses a source whose output fields are documented, not yet proven on a real page`, "unverified"));
    }
  }
  return out;
}

// ================================================================================================================================================================================
// exclusion
// ================================================================================================================================================================================
export function exclusionFindings(c: ShadowCase): Finding[] {
  const fx: ExclusionFixture | undefined = c.exclusion;
  if (!fx) return [];
  const out: Finding[] = [];
  const intent = uploadIntentOf(c.request);
  if (intent === "enrichment") {
    out.push(finding("exclusion", "same", "enrichment_never_applied_as_exclusion", "a request to research the companies IN the file is never applied as an exclusion list (it would remove the very companies asked about), and the customer is told it is not supported", "code_computed", { verified: true }));
    return out;
  }
  const snapshot = exclusionSnapshotOf({ name: fx.fileName, normalizedEntities: fx.entities });
  if (!snapshot) { out.push(finding("exclusion", "review", "exclusion_file_unusable", "the file has no usable organisation; it is not applied and the customer is told", "simulated")); return out; }
  const matcher = exclusionMatcherOf(snapshot);
  const verdicts = fx.rows.map((row) => matcher.check(organisationOfRow(row, { people: fx.stage === "people" })));
  const excluded = verdicts.flatMap((v, i) => (v.kind === "excluded" ? [i] : []));
  const possible = verdicts.flatMap((v, i) => (v.kind === "possible" ? [i] : []));
  out.push(finding("exclusion", "info", "exclusion_off_today", `today (switch off) all ${fx.rows.length} candidate rows would be delivered and the customer is told the file is NOT applied`, "code_computed", { baseline: { delivered: fx.rows.length, excluded: 0 } }));
  if (fx.expectExcluded) {
    const ok = same(excluded, [...fx.expectExcluded].sort((a, b) => a - b));
    out.push(finding("exclusion", ok ? "improvement" : "regression", ok ? "exclusion_matches_expectation" : "exclusion_mismatch", ok ? `the matcher removes exactly the ${excluded.length} listed organisation(s) from ${fx.rows.length} candidate rows (synthetic rows)` : `the matcher removes rows ${JSON.stringify(excluded)} but ${JSON.stringify(fx.expectExcluded)} were expected`, "simulated", { verified: true, baseline: { excluded: 0 }, proposed: { excluded: excluded.length } }));
  } else if (excluded.length > 0) out.push(finding("exclusion", "improvement", "exclusion_applied", `${excluded.length} of ${fx.rows.length} candidate rows are removed (synthetic rows)`, "simulated", { proposed: { excluded: excluded.length } }));
  if (possible.length > 0) out.push(finding("exclusion", "review", "exclusion_possible_delivered", `${possible.length} row(s) only share a brand word with a listed name: delivered and marked, never silently deleted (an owner choice to exclude them too)`, "simulated"));
  // the free re-run carries no file: a documented open risk, pinned by a test on the source
  out.push(finding("exclusion", "review", "exclusion_free_rerun_carries_no_file", "an admin's free re-run creates a new mission with no card message, so the worker finds no list and applies none (and says nothing): never re-run a request that relied on a list until the list is attached to it", "code_computed"));
  return out;
}

// ================================================================================================================================================================================
// one case
// ================================================================================================================================================================================
const worst = (fs: Finding[]): Severity => SEVERITY_ORDER.find((s) => fs.some((f) => f.severity === s)) ?? "same";

export function compareCase(c: ShadowCase, ctx: ShadowContext): CaseResult {
  const nowMs = ctx.nowMs ?? SHADOW_NOW_MS;
  const base = understandForShadow(c.request, c.answer ?? null, { semantic: false, nowMs });
  const prop = understandForShadow(c.request, c.answer ?? null, { semantic: true, nowMs });
  const findings: Finding[] = [...understandingFindings(c, base, prop)];
  let prod: CapabilityDiscovery;
  let test: CapabilityDiscovery;
  try {
    prod = discover(c, ctx, "production");
    test = discover(c, ctx, "test");
  } catch (e) {
    findings.push(finding("providers", "regression", "shadow_engine_error", `the router threw: ${String((e as Error)?.message ?? e).slice(0, 160)}`, "code_computed", { verified: true }));
    const empty: ProposedView = { status: "unsupported", kind: "unknown", stages: [], unsupported: [], limitations: [] };
    return redactDeep({ id: c.id, origin: c.origin, group: c.group ?? null, request: c.request, verdict: "regression" as const, findings, baseline: { understanding: base, route: base.route, stored: null }, proposed: { understanding: prop, production: empty, test: empty } });
  }
  findings.push(...privacyFindings(base, prop, prod, test, c.expected));
  findings.push(...selectionRuleFindings(prod, "production", ctx), ...selectionRuleFindings(test, "test", ctx));
  findings.push(...scopeFindings(prod, "production", ctx), ...scopeFindings(test, "test", ctx));
  findings.push(...customerTextFindings(prod), ...customerTextFindings(test));
  findings.push(...coverageFindings(prop, prod));
  findings.push(...outputsFindings(prod, test));
  const stored = storedFindings(c, ctx, prod);
  findings.push(...stored.findings);
  if (!c.stored && prod.stages.length > 0) {
    // no approved plan to compare with: the legacy planner is a MODEL, its choice cannot be replayed offline
    const compiled = base.route === "compiled";
    findings.push(finding("providers", "info", "baseline_not_reproducible", compiled ? "today the compiled social path chooses its own verified cards; the router's verdict is recorded against it and never blocks it" : "today the legacy planner (a model) chooses the sources; its choice cannot be replayed offline, so no provider comparison is made", compiled ? "code_computed" : "unverified"));
    if (!compiled && prod.status !== "supported") findings.push(finding("outputs", "review", "legacy_served_gated_by_router", `today the legacy planner may serve this request; for a customer account the router says «${prod.status}»: switching the router on for customers would gate it until its family is promoted with evidence`, "unverified", { baseline: "legacy planner (unverified)", proposed: prod.status }));
    if (compiled && prod.status !== "supported") findings.push(finding("outputs", "review", "router_verdict_differs_from_compiled_path", `the compiled social path serves this request today; the router says «${prod.status}» for a customer account (recorded, never blocking)`, "code_computed"));
  }
  // the audit's expected routing, when the case carries one
  if (c.expectedRouting) {
    const e = c.expectedRouting;
    const ops = prod.stages.map((s) => s.stage.operation);
    const ok = prod.need.kind === e.kind && same(ops, e.ops) && prod.status === e.production && test.status === e.test;
    findings.push(ok
      ? finding("providers", "same", "routing_as_audited", `kind «${e.kind}», stages ${e.ops.join(" → ") || "(none)"}, customer «${e.production}», test «${e.test}»${c.knownGap ? ` (known gap: ${c.knownGap})` : ""}`, "stored_real", { verified: true })
      : finding("providers", "regression", "routing_differs_from_audit", `expected kind «${e.kind}» / ${e.ops.join(" → ") || "(none)"} / customer «${e.production}» / test «${e.test}»; got «${prod.need.kind}» / ${ops.join(" → ") || "(none)"} / «${prod.status}» / «${test.status}»`, "stored_real", { verified: true, baseline: e, proposed: { kind: prod.need.kind, ops, production: prod.status, test: test.status } }));
  }
  findings.push(...exclusionFindings(c));
  const result: CaseResult = {
    id: c.id, origin: c.origin, group: c.group ?? null, request: c.request, verdict: worst(findings), findings,
    baseline: { understanding: base, route: base.route, stored: c.stored ? stored.stored : null },
    proposed: { understanding: prop, production: viewOf(prod, ctx), test: viewOf(test, ctx) },
  };
  return redactDeep(result);
}

// ================================================================================================================================================================================
// the corpus: gates, risks, accepted differences
// ================================================================================================================================================================================
/** A regression that was looked at, explained and accepted (reviewed data: a new regression is never added here by the engine). `case` may be «*» for a whole code. */
export interface AcceptedDifference { case: string; code: string; why: string }

/** Every code the engine can report as a REGRESSION. A test keeps this equal to the union of the gates' codes and to what the source emits, so no regression can escape a gate. */
export const REGRESSION_CODES: ReadonlyArray<string> = [
  "understanding_lost", "condition_lost", "now_wrong", "stage_lost", "coverage_lost", "silent_drop",
  "served_before_unserved_now", "unsupported_silent", "routing_differs_from_audit", "shadow_engine_error",
  "privacy_refusal_lost", "privacy_not_carried_into_discovery", "violation_private_capability", "violation_policy_category", "customer_text_discloses_internal",
  "violation_below_verification", "violation_unreviewed_for_customer", "violation_broken_selected", "violation_price_unknown", "required_output_missing",
  "chain_binding_broken", "approval_record_invalid", "approval_scope_not_enforced", "budget_invariant_broken", "exclusion_mismatch",
];

export const GATES: ReadonlyArray<{ id: string; rule: string; codes: string[] }> = [
  { id: "G1_no_lost_constraints", rule: "every constraint, stage or asked item today's behaviour carries is still carried (audit §10.4: zero lost constraints)", codes: ["understanding_lost", "condition_lost", "now_wrong", "stage_lost", "coverage_lost", "silent_drop"] },
  { id: "G2_no_new_rejections", rule: "nothing production completes becomes unserved or silently unanswered", codes: ["served_before_unserved_now", "unsupported_silent", "routing_differs_from_audit", "shadow_engine_error"] },
  { id: "G3_privacy_and_authorization", rule: "every privacy refusal holds before and after; no private, sensitive or blocked capability is ever selected; customer text names no provider or price", codes: ["privacy_refusal_lost", "privacy_not_carried_into_discovery", "violation_private_capability", "violation_policy_category", "customer_text_discloses_internal"] },
  { id: "G4_no_silent_capability_approval", rule: "a customer account is only ever routed to a reviewed production capability; a test account never to a broken one or one below its tier; every selected capability has a known price and the required outputs", codes: ["violation_below_verification", "violation_unreviewed_for_customer", "violation_broken_selected", "violation_price_unknown", "required_output_missing"] },
  { id: "G5_approval_scope_enforced", rule: "the approved scope is enforced: chains are bound by documented fields and a swapped capability, an added stage or changed parameters are refused", codes: ["chain_binding_broken", "approval_record_invalid", "approval_scope_not_enforced"] },
  { id: "G6_budget_safety", rule: "the estimated reserve stays under the job cap and a settlement charge can never exceed its reserve", codes: ["budget_invariant_broken"] },
  { id: "G7_exclusion_correct", rule: "a listed organisation is removed, a person's own name never removes a row, an enrichment request is never applied as an exclusion", codes: ["exclusion_mismatch"] },
];

/** The gates over a set of case results: each gate fails on an unaccepted regression whose code it watches, and a regression whose code NO gate watches fails a catch-all gate (belt and braces: the codes of `REGRESSION_CODES` are all watched). */
export function gatesOf(results: ReadonlyArray<CaseResult>, isAccepted: (caseId: string, code: string) => boolean): Gate[] {
  const gates: Gate[] = GATES.map((g) => {
    const failing = results.flatMap((r) => r.findings.filter((f) => f.severity === "regression" && g.codes.includes(f.code) && !isAccepted(r.id, f.code)).map((f) => ({ caseId: r.id, code: f.code })));
    return { ...g, passed: failing.length === 0, failing };
  });
  const watched = new Set(GATES.flatMap((g) => g.codes));
  const unwatched = results.flatMap((r) => r.findings.filter((f) => f.severity === "regression" && !watched.has(f.code) && !isAccepted(r.id, f.code)).map((f) => ({ caseId: r.id, code: f.code })));
  if (unwatched.length > 0) gates.push({ id: "G0_other_regressions", rule: "no other regression", codes: [...new Set(unwatched.map((u) => u.code))], passed: false, failing: unwatched });
  return gates;
}

const emptyBySeverity = (): Record<Severity, number> => ({ regression: 0, review: 0, improvement: 0, same: 0, info: 0 });

export function compareCorpus(cases: ReadonlyArray<ShadowCase>, ctx: ShadowContext, accepted: ReadonlyArray<AcceptedDifference> = [], extraRisks: ReadonlyArray<Risk> = []): ShadowReport {
  const results = cases.map((c) => compareCase(c, ctx)).sort((a, b) => a.id.localeCompare(b.id));
  const isAccepted = (id: string, code: string) => accepted.some((a) => (a.case === id || a.case === "*") && a.code === code);
  const counts: ShadowReport["counts"] = {
    cases: results.length, byOrigin: {}, byVerdict: emptyBySeverity(), findings: emptyBySeverity(),
    byDimension: Object.fromEntries(DIMENSIONS.map((d) => [d.id, emptyBySeverity()])) as Record<DimensionId, Record<Severity, number>>,
    verifiedImprovements: 0, unlabelledImprovements: 0, acceptedRegressions: 0, unacceptedRegressions: 0,
  };
  for (const r of results) {
    counts.byOrigin[r.origin] = (counts.byOrigin[r.origin] ?? 0) + 1;
    counts.byVerdict[r.verdict] += 1;
    for (const f of r.findings) {
      counts.findings[f.severity] += 1;
      counts.byDimension[f.dimension][f.severity] += 1;
      if (f.severity === "improvement") { if (f.verified) counts.verifiedImprovements += 1; else counts.unlabelledImprovements += 1; }
      if (f.severity === "regression") { if (isAccepted(r.id, f.code)) counts.acceptedRegressions += 1; else counts.unacceptedRegressions += 1; }
    }
  }
  const gates = gatesOf(results, isAccepted);
  const body = {
    v: 1 as const, offline: true as const, nowMs: ctx.nowMs ?? SHADOW_NOW_MS,
    assumptions: [
      "Offline and deterministic: no provider, no model, no database and no switch is touched; nothing here is a live result.",
      "«Today» = every Intelligence switch OFF. The legacy planner is a model and is not replayed: without a stored approved plan no provider baseline exists.",
      "A customer account may use production-eligible capabilities only; a test account also fixture- and live-verified ones.",
      "Web providers are assumed to have a key and a $1 daily cap (the worker's key and cap facts are not read).",
      "Prices are the catalog's or Diger's recorded figures (an estimate, not a measurement); every USD or point figure is admin-only.",
    ],
    interpreterEvents: { available: false as const, reason: "No code path stores interpreter events: the audit's model interpreter (PR-1.3) was not built, and the semantic layer (semantic_normalization_v1) is a deterministic reading that records nothing. The «understanding» columns compare the words reading with and without that layer." },
    counts, gates, passed: gates.every((g) => g.passed), risks: [...extraRisks], cases: results,
  };
  // redacted first, digested after: the digest is a hash (a long token), never itself redacted
  const redacted = redactDeep(body);
  return { ...redacted, digest: createHash("sha256").update(JSON.stringify(redacted)).digest("hex") };
}
