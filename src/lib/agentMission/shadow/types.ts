import type { ExclusionEntity } from "../customerExclusion";
import type { BriefObjective } from "../researchBrief";
import type { Understood } from "./understanding";

/**
 * PHASE 7 (PR-7.1): THE ADMIN SHADOW COMPARISON. For a stored or typed request it puts what production does TODAY (every Intelligence switch OFF) next to what the PROPOSED behaviour would do (the switches ON), side by side, offline, and says
 * in code what got better, what got worse and what could not be checked. Nothing here calls a provider or a model, reads or writes a switch, or touches a database, a price, a balance or a permission.
 */

/** How well a finding is backed. The view never shows a finding without one of these. */
export type Evidence =
  /** from a stored REAL request, approved plan or fixture (anonymised, committed) */
  | "stored_real"
  /** computed offline by the repository's own pure code (deterministic), on real inputs */
  | "code_computed"
  /** from Diger's own recorded provider calls (the reliability snapshot) or the provider's catalog price */
  | "recorded"
  /** computed on a SYNTHETIC input built for the check */
  | "simulated"
  /** cannot be established offline (a live provider's quality, the legacy model planner's choice, a real customer's outcome) */
  | "unverified";

export type Severity = "regression" | "review" | "improvement" | "same" | "info";
export const SEVERITY_ORDER: ReadonlyArray<Severity> = ["regression", "review", "improvement", "same", "info"];

export type DimensionId = "understanding" | "conditions" | "providers" | "chaining" | "coverage" | "privacy" | "exclusion" | "cost" | "outputs";

export const DIMENSIONS: ReadonlyArray<{ id: DimensionId; labelAr: string }> = [
  { id: "understanding", labelAr: "فهم الطلب بالعربية والتصحيحات" },
  { id: "conditions", labelAr: "المنصة والدولة والتاريخ والحقول المطلوبة" },
  { id: "providers", labelAr: "المصادر المختارة وأهليتها" },
  { id: "chaining", labelAr: "تسلسل المراحل ونطاق الموافقة" },
  { id: "coverage", labelAr: "تغطية الشركات وجهات الاتصال المهنية" },
  { id: "privacy", labelAr: "الخصوصية والصلاحيات" },
  { id: "exclusion", labelAr: "ملف الاستبعاد" },
  { id: "cost", labelAr: "التكلفة التقديرية وسلامة الميزانية" },
  { id: "outputs", labelAr: "المخرجات الناقصة وغير المدعومة وغير المؤكدة" },
];

export interface Finding {
  dimension: DimensionId;
  severity: Severity;
  /** A stable machine code (tests, the accepted-differences list and the admin labels key on it). */
  code: string;
  /** One English sentence for engineers; the admin screen shows the Arabic label of `code`. */
  detail: string;
  evidence: Evidence;
  /** True only when the finding was checked against a labelled expectation or a hard rule (never for a bare «the new reading filled a value»). */
  verified?: boolean;
  baseline?: unknown;
  proposed?: unknown;
}

export interface StoredStage { key: string; parent_key: string | null; endpoint_id: string; planned?: number; gaps?: unknown[] }
/** A historical approved plan (anonymised, committed): what production ran. */
export interface StoredPlan { id: string; stages: StoredStage[]; replies_status?: string | null; delivered?: number[] }

export interface ExclusionFixture {
  fileName: string;
  entities: ExclusionEntity[];
  stage: "companies" | "people";
  /** SYNTHETIC candidate rows (the safe fixture domain `.example`): what a source might return. */
  rows: Array<Record<string, unknown>>;
  /** The rows the matcher is expected to remove (indexes into `rows`); a person's own name must never remove a row. */
  expectExcluded?: number[];
}

export type DiscoveryStatus = "supported" | "partial" | "unsupported" | "blocked" | "needs_clarification";

export interface ShadowCase {
  id: string;
  origin: "audit_scenario" | "stored_mission" | "understanding_baseline" | "exclusion" | "ad_hoc";
  group?: string;
  request: string;
  answer?: string | null;
  /** The chat's validated brief when the case is a multi-turn correction (the router follows it, as in production). */
  brief?: { platforms: string[]; content: string[]; count: number | null; objectives: BriefObjective[] } | null;
  stored?: StoredPlan;
  /** A labelled expectation of what the request MEANS (the fields that matter for the case). Never edited to match the code. */
  expected?: Partial<Record<keyof Understood, unknown>>;
  /** The audit's expected routing: the kind, the stages and the verdict for a customer account and a test account. */
  expectedRouting?: { kind: string; ops: string[]; production: DiscoveryStatus; test: DiscoveryStatus };
  /** A gap already known and recorded elsewhere (the Phase 1 baseline, the Phase 2-4 report): explained, not hidden. */
  knownGap?: string;
  exclusion?: ExclusionFixture;
}

export interface CaseResult {
  id: string;
  origin: ShadowCase["origin"];
  group: string | null;
  /** The request as the admin may read it: redacted. */
  request: string;
  verdict: Severity;
  findings: Finding[];
  baseline: { understanding: Understood; route: string; stored: Array<{ key: string; endpoint: string; operation: string | null; level: string | null }> | null };
  proposed: { understanding: Understood; production: ProposedView; test: ProposedView };
}

export interface ProposedView {
  status: DiscoveryStatus;
  kind: string;
  stages: Array<{ operation: string; platform: string | null; selected: string | null; level: string | null; usdPerRow: number | null; candidates: number }>;
  unsupported: Array<{ operation: string; reason: string }>;
  limitations: string[];
}

export interface Gate { id: string; rule: string; /** The finding codes this gate watches. */ codes: string[]; passed: boolean; failing: Array<{ caseId: string; code: string }> }

export interface Risk { id: string; severity: "high" | "medium" | "low"; textAr: string; text: string; evidence: Evidence }

export interface ShadowReport {
  v: 1;
  offline: true;
  nowMs: number;
  /** What the offline run assumes (so a reader never mistakes it for production). */
  assumptions: string[];
  /** The interpreter events of the audit's PR-1.3 do not exist: said, not invented. */
  interpreterEvents: { available: false; reason: string };
  counts: {
    cases: number;
    byOrigin: Record<string, number>;
    byVerdict: Record<Severity, number>;
    findings: Record<Severity, number>;
    byDimension: Record<DimensionId, Record<Severity, number>>;
    verifiedImprovements: number;
    unlabelledImprovements: number;
    acceptedRegressions: number;
    unacceptedRegressions: number;
  };
  gates: Gate[];
  passed: boolean;
  risks: Risk[];
  cases: CaseResult[];
  digest: string;
}
