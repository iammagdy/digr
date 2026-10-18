/**
 * Offline extraction benchmark: replays saved raw provider rows through the same gate, de-duplication and file
 * normalisation the worker uses, and counts rows kept / rejected / uncertain so an improvement is measurable.
 * Pure and offline: no database, no provider call, no spend.
 */
import ExcelJS from "exceljs";
import { evaluateResearchRowRelevance } from "./researchRelevanceGate";
import { dedupeIdentityFor, dedupeRows, type DedupeKind } from "./rowDedupe";
import { generateExcelReport } from "../../functions/shared/fileGenerators";
import { normalizeSocialRow } from "./socialRows";
import { decisionMakerChargePoints, decisionMakerDeliveredUnits, DECISION_MAKER_UNIT_PRICES_POINTS, type ContactField } from "../../functions/shared/decisionMakerPricing";

export type Expectation = "match" | "uncertain" | "no_match" | "duplicate";
export interface FixtureRow { expect: Expectation; note: string; row: Record<string, any> }
export interface Fixture {
  capability: string;
  endpointId: string;
  labelAr: string;
  entity: "companies" | "posts" | "comments" | "videos" | "people";
  params: Record<string, any>;
  rows: FixtureRow[];
}

export type Outcome = "delivered" | "review" | "rejected" | "duplicate";

export interface BenchmarkResult {
  capability: string;
  labelAr: string;
  rowsIn: number;
  duplicates: number;
  delivered: number;
  review: number;
  rejected: number;
  /** Rows whose outcome equals the expectation, out of all rows */
  agreement: number;
  /** Delivered although expected review / rejected / duplicate: a wrong delivery (and a wrong charge) */
  falseDeliveries: number;
  /** Expected match but not delivered: a lost match */
  lostMatches: number;
  /** Header cells of the delivered Excel that contain Latin letters */
  latinHeaders: string[];
  /** Delivered dates that are not a plain date, and count cells that are not numbers */
  formatIssues: number;
  /** People only: units that would be charged, and rows with nothing chargeable */
  people?: { baseUnits: number; emailUnits: number; phoneUnits: number; chargePoints: number; notChargedRows: number };
}

const OUTCOME_FOR: Record<Expectation, Outcome> = { match: "delivered", uncertain: "review", no_match: "rejected", duplicate: "duplicate" };
const DEDUPE_KIND: Record<Fixture["entity"], DedupeKind> = { companies: "company", people: "person", posts: "social", comments: "social", videos: "social" };
const SOCIAL_KIND: Partial<Record<Fixture["entity"], "posts" | "comments" | "videos">> = { posts: "posts", comments: "comments", videos: "videos" };

/** A fixed clock so recency rules give the same answer every day. */
export const BENCHMARK_NOW = new Date("2026-10-17T00:00:00Z");

export interface BenchmarkOptions {
  /** Override the identity used for de-duplication (used to record the "before" numbers). */
  identityOf?: (row: any) => string | null;
  /** Override the gate (same signature as evaluateResearchRowRelevance). */
  gate?: typeof evaluateResearchRowRelevance;
}

export async function runFixture(fixture: Fixture, options: BenchmarkOptions = {}): Promise<BenchmarkResult> {
  const gate = options.gate ?? evaluateResearchRowRelevance;
  const identityOf = options.identityOf ?? dedupeIdentityFor(DEDUPE_KIND[fixture.entity]);
  const seen = new Set<string>();
  const outcomes: Outcome[] = [];
  const delivered: Record<string, any>[] = [];
  const review: Record<string, any>[] = [];

  // Two "pages", the way the worker sees a job, so repeats across pages are caught as well as repeats inside one.
  const half = Math.ceil(fixture.rows.length / 2);
  for (const page of [fixture.rows.slice(0, half), fixture.rows.slice(half)]) {
    for (const item of page) {
      const dedupe = dedupeRows([item.row], identityOf, seen);
      if (dedupe.duplicates > 0) { outcomes.push("duplicate"); continue; }
      const verdict = gate(item.row, { capabilitySlug: fixture.capability, endpointId: fixture.endpointId, params: fixture.params, now: BENCHMARK_NOW });
      if (verdict.decision === "match") { outcomes.push("delivered"); delivered.push(item.row); }
      else if (verdict.decision === "uncertain") { outcomes.push("review"); review.push({ ...item.row, _relevance_reason: verdict.reasonAr }); }
      else outcomes.push("rejected");
    }
  }

  let agreement = 0; let falseDeliveries = 0; let lostMatches = 0;
  fixture.rows.forEach((item, i) => {
    const expected = OUTCOME_FOR[item.expect];
    if (outcomes[i] === expected) agreement += 1;
    if (outcomes[i] === "delivered" && expected !== "delivered") falseDeliveries += 1;
    if (expected === "delivered" && outcomes[i] !== "delivered") lostMatches += 1;
  });

  const { latinHeaders, formatIssues } = await inspectWorkbook(fixture, delivered, review);
  const result: BenchmarkResult = {
    capability: fixture.capability,
    labelAr: fixture.labelAr,
    rowsIn: fixture.rows.length,
    duplicates: outcomes.filter((o) => o === "duplicate").length,
    delivered: delivered.length,
    review: review.length,
    rejected: outcomes.filter((o) => o === "rejected").length,
    agreement,
    falseDeliveries,
    lostMatches,
    latinHeaders,
    formatIssues,
  };
  if (fixture.entity === "people") {
    const fields = (fixture.params.requestedFields || []) as ContactField[];
    const units = decisionMakerDeliveredUnits(delivered, fields);
    result.people = { ...units, chargePoints: decisionMakerChargePoints(units, DECISION_MAKER_UNIT_PRICES_POINTS), notChargedRows: delivered.length - units.baseUnits };
  }
  return result;
}

const LATIN = /[A-Za-z]/;

async function inspectWorkbook(fixture: Fixture, delivered: Record<string, any>[], review: Record<string, any>[]): Promise<{ latinHeaders: string[]; formatIssues: number }> {
  if (delivered.length === 0) return { latinHeaders: [], formatIssues: 0 };
  const social = SOCIAL_KIND[fixture.entity];
  const rows = social ? delivered.map((raw) => normalizeSocialRow(social, raw)) : delivered;
  const payload = {
    metadata: {
      platform: social ? fixture.capability : fixture.entity, ...(social ? { socialKind: social } : {}),
      title: fixture.labelAr, entityType: fixture.entity === "companies" ? "companies" : fixture.entity === "people" ? "people" : undefined,
      jobId: "bench", collectedAt: "2026-10-17T10:00:00.000Z", rowsCount: rows.length, targetRequested: rows.length,
    },
    rows,
    uncertainRows: review,
    profile: null,
  };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await generateExcelReport(payload)) as any);
  const sheet = wb.worksheets[0];
  const headerRowIndex = fixture.entity === "people" ? 4 : 1;
  const headers = (sheet.getRow(headerRowIndex).values as any[]).slice(1).map((v) => String(v ?? ""));
  const latinHeaders = headers.filter((h) => LATIN.test(h));

  let formatIssues = 0;
  const headerOf = (i: number) => headers[i] || "";
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowIndex) return;
    row.eachCell((cell, col) => {
      const header = headerOf(col - 1);
      const value = cell.value;
      if (/تاريخ/.test(header) && typeof value === "string" && value.trim() !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) && !/^[٠-٩\d]{1,4}[/\-][٠-٩\d]{1,2}[/\-][٠-٩\d]{1,4}/.test(value.trim())) formatIssues += 1;
      if (/^عدد |المشاهدات|الإعجابات|الردود|المتابعين|إعادة النشر/.test(header) && typeof value === "string" && value.trim() !== "" && !Number.isFinite(Number(value))) formatIssues += 1;
    });
  });
  return { latinHeaders, formatIssues };
}

export async function runAll(fixtures: Fixture[], options: BenchmarkOptions = {}): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (const fixture of fixtures) results.push(await runFixture(fixture, options));
  return results;
}

export function totals(results: BenchmarkResult[]) {
  const sum = (pick: (r: BenchmarkResult) => number) => results.reduce((a, r) => a + pick(r), 0);
  return { rowsIn: sum((r) => r.rowsIn), delivered: sum((r) => r.delivered), review: sum((r) => r.review), rejected: sum((r) => r.rejected), duplicates: sum((r) => r.duplicates), agreement: sum((r) => r.agreement), falseDeliveries: sum((r) => r.falseDeliveries), lostMatches: sum((r) => r.lostMatches) };
}
