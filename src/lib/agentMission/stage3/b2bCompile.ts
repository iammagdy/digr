import { normalizeDigits, toArabicDigits } from "../../arabicDigits";
import { countAr, knownItemNoun } from "../itemNoun";
import {
  COMPANY_ACTIVITY_TITLE_AR, COMPANY_EMAIL_TITLE_AR, COMPANY_NAME_TITLE_AR, COMPANY_PHONE_TITLE_AR, DECISION_MAKER_FLAG_TITLE_AR, NOT_AVAILABLE_AR, NOTES_TITLE_AR,
  PERSON_EMAIL_TITLE_AR, PERSON_NAME_TITLE_AR, PERSON_PHONE_TITLE_AR, PERSON_TITLE_TITLE_AR, ROW_NUMBER_TITLE_AR,
} from "../taskContracts";
import { b2bConditionLabelAr, type B2BAsk, type B2BCondition } from "./b2bAsk";
import { B2B_CARDS, b2bCardsFor, type B2BCard, type B2BCarry, type B2BField, type B2BRole } from "./b2bCards";

/**
 * STAGE 3, THE B2B COMPILER (docs/STAGE-3.md, FOUNDATION-PLAN PR 5): the companies and decision-makers request on the same Ask → Tool Cards → compiler shape as social. By code, pure:
 *   - the TOOLS: the companies (or people) tool whose inputs carry the most of the Ask's conditions, then the cheapest; a VERIFIED card only on a customer path (none exists yet);
 *   - the COLUMNS: the owner's reference sheets (taskContracts.ts), with the HQ, the company's general e-mail and HQ phone as columns, a decision maker's e-mail and mobile;
 *   - a condition no chosen tool carries: a MARK column («نعم» / «لا» / «غير معروف» from the row's own value), never a filter and never a silent drop;
 *   - the CHAIN of each contact column: every relevant tool, the search's own field first, then the lookups cheapest first. A cell is «غير متوفر» only when EVERY tool of its chain was
 *     tried and gave nothing; a tool not tried makes the cell «لم يكتمل البحث» and the gap is said;
 *   - EXACT duplicates only are removed (every value identical); nothing else is removed;
 *   - every gap is a line of the file («... وُجد لشركتين من ٥ شركات، وغير متوفر ...»).
 * Wiring it into the planning and the engine is left for the next session (docs/STAGE-3.md), behind `DIGER_STAGE3_COMPANIES`.
 */
export const COMPANY_HQ_TITLE_AR = "المقر الرئيسي";
/** A contact cell whose chain was not tried to its end (a tool refused by the daily cap, the time limit): never «غير متوفر». */
export const B2B_NOT_SEARCHED_AR = "لم يكتمل البحث";
export const MARK_YES_AR = "نعم";
export const MARK_NO_AR = "لا";
export const MARK_UNKNOWN_AR = "غير معروف";

export interface B2BColumn { key: string; titleAr: string; fill: "code" | "source" | "lookup" | "mark" }
export interface B2BMark { condition: B2BCondition; titleAr: string; sheet: "company" }
export type ContactField = "general_email" | "hq_phone" | "email" | "mobile";

export type B2BCompileResult =
  | {
      ok: true;
      companiesCard: string | null;
      peopleCard: string | null;
      columns: { company: B2BColumn[]; person?: B2BColumn[] };
      marks: B2BMark[];
      /** For each contact column: the tools in the order they are tried (endpoint ids). */
      chains: Record<ContactField, string[]>;
      /** Unverified tools that a customer path may not use (admin only). */
      unverified: string[];
    }
  | { ok: false; reason: "no_verified_card"; role: B2BRole; unverified: string[] };

const CARRY_OF: Record<B2BCondition["kind"], B2BCarry> = { size_min: "size", size_max: "size", founded_after: "founded", founded_before: "founded" };

/** What of the Ask a tool would have to carry: the sector, the country, the title (decision makers), and each condition. */
function asked(ask: B2BAsk, role: B2BRole): B2BCarry[] {
  const out = new Set<B2BCarry>();
  if (ask.sector.length > 0 && role !== "company.people") out.add("sector");
  if (ask.country) out.add("country");
  if (ask.roles === "decision_makers" && role !== "companies.search") out.add("title");
  if (role === "companies.search") for (const c of ask.conditions) out.add(CARRY_OF[c.kind]);
  return [...out];
}
const carried = (card: B2BCard, wants: B2BCarry[]): number => wants.filter((w) => card.carries.includes(w)).length;
/** The best card of a role: the most conditions carried, then the cheapest (b2bCardsFor sorts by price; the sort is stable). */
function best(role: B2BRole, ask: B2BAsk, opts: CompileOptions): B2BCard | null {
  const wants = asked(ask, role);
  const list = b2bCardsFor(role, opts);
  return [...list].sort((a, b) => carried(b, wants) - carried(a, wants))[0] ?? null;
}
const maps = (card: B2BCard | null, field: B2BField): boolean => Boolean(card && card.reader.kind === "list" && card.reader.fields[field]);
/** A contact column's chain: the chosen search's own field (when it has one), then every lookup of the role, cheapest first. */
function chainOf(source: B2BCard | null, field: B2BField, lookupRole: B2BRole, opts: CompileOptions): string[] {
  return [...(maps(source, field) ? [source!.endpointId] : []), ...b2bCardsFor(lookupRole, opts).map((c) => c.endpointId)];
}

export interface CompileOptions { allowUnverified?: boolean; cards?: ReadonlyArray<B2BCard> }

export function compileB2BPlan(ask: B2BAsk, opts: CompileOptions = {}): B2BCompileResult {
  const unverified = (opts.cards ?? B2B_CARDS).filter((c) => c.status === "unverified").map((c) => c.endpointId);
  const withCompanies = ask.kind !== "people";
  const withPeople = ask.kind !== "companies";
  const companies = withCompanies ? best("companies.search", ask, opts) : null;
  if (withCompanies && !companies) return { ok: false, reason: "no_verified_card", role: "companies.search", unverified };
  const peopleRole: B2BRole = ask.kind === "people" ? "people.search" : "company.people";
  const people = withPeople ? best(peopleRole, ask, opts) : null;
  if (withPeople && !people) return { ok: false, reason: "no_verified_card", role: peopleRole, unverified };
  const marks: B2BMark[] = withCompanies ? ask.conditions.filter((c) => !companies!.carries.includes(CARRY_OF[c.kind])).map((c) => ({ condition: c, titleAr: b2bConditionLabelAr(c), sheet: "company" as const })) : [];
  const col = (key: string, titleAr: string, fill: B2BColumn["fill"]): B2BColumn => ({ key, titleAr, fill });
  const markCols = marks.map((m, i) => col(`__mark_${i}`, m.titleAr, "mark"));
  const company: B2BColumn[] = withCompanies ? [
    col("row_number", ROW_NUMBER_TITLE_AR, "code"), col("name", COMPANY_NAME_TITLE_AR, "source"), col("activity", COMPANY_ACTIVITY_TITLE_AR, "source"), col("website", "الموقع الإلكتروني", "source"),
    col("hq", COMPANY_HQ_TITLE_AR, "source"), col("general_email", COMPANY_EMAIL_TITLE_AR, "lookup"), col("hq_phone", COMPANY_PHONE_TITLE_AR, "lookup"), ...markCols, col("notes", NOTES_TITLE_AR, "code"),
  ] : [];
  const person: B2BColumn[] | undefined = withPeople ? [
    col("row_number", ROW_NUMBER_TITLE_AR, "code"), col("person_name", PERSON_NAME_TITLE_AR, "source"), col("title", PERSON_TITLE_TITLE_AR, "source"),
    ...(ask.kind === "people" ? [col("company", COMPANY_NAME_TITLE_AR, "source")] : []),
    col("decision_maker", DECISION_MAKER_FLAG_TITLE_AR, "code"), col("email", PERSON_EMAIL_TITLE_AR, "lookup"), col("mobile", PERSON_PHONE_TITLE_AR, "lookup"), col("notes", NOTES_TITLE_AR, "code"),
  ] : undefined;
  return {
    ok: true,
    companiesCard: companies?.endpointId ?? null,
    peopleCard: people?.endpointId ?? null,
    columns: { company, ...(person ? { person } : {}) },
    marks,
    chains: {
      general_email: ask.fields.companyEmail ? chainOf(companies, "general_email", "company.emails", opts) : [],
      hq_phone: ask.fields.hqPhone ? chainOf(companies, "hq_phone", "company.phone", opts) : [],
      email: ask.fields.personEmail ? chainOf(people, "email", "person.email", opts) : [],
      mobile: ask.fields.personMobile ? chainOf(people, "mobile", "person.phone", opts) : [],
    },
    unverified,
  };
}

// ------------------------------------------------------------------------------------------------ marks

const numbersIn = (v: unknown): number[] => (normalizeDigits(String(v ?? "")).replace(/[,٬]/g, "").match(/\d+/g) ?? []).map(Number);
/** A size as a range: «51-200» → [51, 200], «1000+» → [1000, ∞], 120 → [120, 120]. Null when the row has none. */
function sizeRange(v: unknown): [number, number] | null {
  if (typeof v === "number" && Number.isFinite(v)) return [v, v];
  const n = numbersIn(v);
  if (n.length === 0) return null;
  if (n.length === 1) return /\+/.test(String(v)) ? [n[0], Number.POSITIVE_INFINITY] : [n[0], n[0]];
  return [Math.min(n[0], n[1]), Math.max(n[0], n[1])];
}
const yearOf = (v: unknown): number | null => { const y = numbersIn(v).find((n) => n >= 1800 && n <= 2100); return y ?? null; };

/** The mark cell of a condition for a row: «نعم», «لا», or «غير معروف» when the row's own value cannot say. The row is never removed. */
export function markCellAr(c: B2BCondition, row: Record<string, unknown>): string {
  if (c.kind === "size_min" || c.kind === "size_max") {
    const r = sizeRange(row.employees);
    if (!r) return MARK_UNKNOWN_AR;
    if (c.kind === "size_min") return r[0] > c.value ? MARK_YES_AR : r[1] <= c.value ? MARK_NO_AR : MARK_UNKNOWN_AR;
    return r[1] < c.value ? MARK_YES_AR : r[0] >= c.value ? MARK_NO_AR : MARK_UNKNOWN_AR;
  }
  const y = yearOf(row.founded);
  if (y === null) return MARK_UNKNOWN_AR;
  return (c.kind === "founded_after" ? y > c.value : y < c.value) ? MARK_YES_AR : MARK_NO_AR;
}

// ------------------------------------------------------------------------------------------------ exact duplicates

const norm = (v: unknown): unknown => (typeof v === "string" ? v.trim() : Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, norm(x)])) : v);
/** Removes a row only when another row before it has EXACTLY the same values (strings compared without their outer spaces). No fuzzy matching: a different spelling stays. */
export function removeExactDuplicates<R extends Record<string, unknown>>(rows: ReadonlyArray<R>): { rows: R[]; removed: number } {
  const seen = new Set<string>();
  const out: R[] = [];
  for (const r of rows) { const k = JSON.stringify(norm(r)); if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return { rows: out, removed: rows.length - out.length };
}

// ------------------------------------------------------------------------------------------------ the fallthrough

/** One tool's answer for one row's contact column. `refused`: the call was not made (the daily cap, the budget, the time limit): not a try. */
export type Attempt = { endpointId: string; outcome: "value"; value: string } | { endpointId: string; outcome: "empty" | "failed" | "refused" };
export type FieldResolution = { kind: "value"; value: string; by: string } | { kind: "unavailable"; tried: string[] } | { kind: "incomplete"; missing: string[] };

/** The cell of one row: the value of the earliest tool of the chain that gave one; «غير متوفر» only when every tool was tried (answered empty or failed); else incomplete. */
export function resolveField(chain: ReadonlyArray<string>, attempts: ReadonlyArray<Attempt>): FieldResolution {
  for (const id of chain) { const a = attempts.find((x) => x.endpointId === id && x.outcome === "value"); if (a && a.outcome === "value" && a.value.trim() !== "") return { kind: "value", value: a.value.trim(), by: id }; }
  const tried = (id: string): boolean => attempts.some((x) => x.endpointId === id && (x.outcome === "empty" || x.outcome === "failed"));
  const missing = chain.filter((id) => !tried(id));
  return chain.length > 0 && missing.length === 0 ? { kind: "unavailable", tried: [...chain] } : { kind: "incomplete", missing };
}

export interface ColumnGap { total: number; found: number; unavailable: number; incomplete: number; tools: number }
/** A whole column: every row's cell and the column's gap (said in the file). */
export function fillColumn(rowIds: ReadonlyArray<string>, chain: ReadonlyArray<string>, attempts: Readonly<Record<string, ReadonlyArray<Attempt>>>): { cells: Record<string, string>; resolutions: Record<string, FieldResolution>; gap: ColumnGap } {
  const cells: Record<string, string> = {};
  const resolutions: Record<string, FieldResolution> = {};
  const gap: ColumnGap = { total: rowIds.length, found: 0, unavailable: 0, incomplete: 0, tools: chain.length };
  for (const id of rowIds) {
    const r = resolveField(chain, attempts[id] ?? []);
    resolutions[id] = r;
    if (r.kind === "value") { cells[id] = r.value; gap.found += 1; }
    else if (r.kind === "unavailable") { cells[id] = NOT_AVAILABLE_AR; gap.unavailable += 1; }
    else { cells[id] = B2B_NOT_SEARCHED_AR; gap.incomplete += 1; }
  }
  return { cells, resolutions, gap };
}

const NOUN = { company: knownItemNoun("شركة")!, person: knownItemNoun("شخص")! };
const toCount = (n: number, noun: "company" | "person"): string => { const t = countAr(n, NOUN[noun]); return /^[٠-٩]/.test(t) ? `لـ ${t}` : `ل${t}`; };
const sourcesAr = (n: number): string => (n === 1 ? "مصدر واحد" : n === 2 ? "مصدرين" : n >= 3 && n <= 10 ? `${toArabicDigits(n)} مصادر` : `${toArabicDigits(n)} مصدرًا`);

/** The file's line for a column's gap (no provider name: only how many sources were tried). */
export function gapLineAr(columnTitleAr: string, gap: ColumnGap, noun: "company" | "person"): string {
  const all = noun === "company" ? "الشركات" : "الأشخاص";
  if (gap.total === 0) return `${columnTitleAr}: لا يوجد ما يُبحث له.`;
  if (gap.found === gap.total) return `${columnTitleAr}: وُجد لكل ${all} (${countAr(gap.total, NOUN[noun])}).`;
  const parts = [gap.found === 0 ? `${columnTitleAr}: لم يوجد لأي ${NOUN[noun].singular} من ${countAr(gap.total, NOUN[noun])}` : `${columnTitleAr}: وُجد ${toCount(gap.found, noun)} من ${countAr(gap.total, NOUN[noun])}`];
  if (gap.unavailable > 0) parts.push(`وغير متوفر ${toCount(gap.unavailable, noun)} بعد تجربة ${sourcesAr(gap.tools)}`);
  if (gap.incomplete > 0) parts.push(`ولم يكتمل البحث ${toCount(gap.incomplete, noun)}`);
  return `${parts.join("، ")}.`;
}
