import { countAr, type ItemNoun } from "./itemNoun";
import { isEmailColumn, type ContactStep } from "./contactFinders";
import { contactShape } from "./contactShape";
import type { StageCounts } from "./stageUnits";

/**
 * A PEOPLE ROW IS CHARGED ONLY IF IT CARRIES A CONTACT THE CUSTOMER ASKED FOR (DT-20261119-06 PART B, owner decision D-0117).
 *
 * When the customer asked for the contacts of the people (the plan has person-level contact steps: one per asked kind, contactFinders.ts buildContactSteps), a delivered person
 * counts for the CHARGE only if a cell of an asked kind holds a real value. The row is still DELIVERED (file, delivered count and hold are unchanged: «verification decides a cell, never a person»).
 * Nothing is asked → every named person is charged as today. Pure: the runner computes the numbers before the ownership check and hands the lower count to the existing settlement functions (no SQL, no price rule).
 *
 * A cell holds a value when it has the SHAPE of one (contactShape.ts: the same rule the ingest applies before it normalises a native cell: an address, or a phone written with phone characters, 7 to 15 digits, not a date or a labelled id), and
 * (the placeholders code writes, «غير متوفر» and «لم يكتمل البحث», have no such shape). A value a finder returned but that is «غير موثّق» or labelled (a private mailbox, the company's line) still counts: it is delivered.
 * D-0126: the customer pays ONLY for the billable rows, through the existing settlement functions, and never for a padded minimum.
 */
export type ContactKindAsked = "email" | "phone";

const KIND_OF: Record<ContactKindAsked, "work_email" | "phone"> = { email: "work_email", phone: "phone" };

/** Whether a cell is a contact of this kind: by shape (contactShape.ts), never by a word list. */
export function hasContact(kind: ContactKindAsked, value: unknown): boolean {
  return contactShape(kind, value);
}

export interface BillablePlanLike {
  stages: ReadonlyArray<{ key: string; deliver: boolean; columns?: ReadonlyArray<{ key: string; kind?: string; status_of?: string; type_of?: string; computed?: string }> }>;
  contact_steps?: ReadonlyArray<Pick<ContactStep, "stage_key" | "column_key" | "kind" | "level">>;
}

export interface UnbilledPeople {
  /** The people rows that carry none of the asked contacts, per delivered people stage (capped by the rows of the stage in the file). */
  byStage: Record<string, number>;
  total: number;
  /** The kinds the customer asked for, over the stages counted (for the customer's line). */
  kinds: ContactKindAsked[];
}

/**
 * The people rows of each delivered people stage that carry none of the asked contact kinds. `rowsByStage` are the rows the file is built from (the first `planned_rows` of each stage, in file order);
 * `inFile` is the count of each stage's rows in the file: a stage never has more unbilled rows than the file holds. A column counts when it is the step's own column OR another column of the stage
 * marked/keyed as that kind (a native e-mail or phone column of the source), never a status or type column.
 */
export function peopleWithoutRequestedContact(plan: BillablePlanLike, rowsByStage: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>, inFile?: Readonly<Record<string, number>> | null): UnbilledPeople {
  const out: UnbilledPeople = { byStage: {}, total: 0, kinds: [] };
  const kinds = new Set<ContactKindAsked>();
  for (const stage of plan.stages) {
    if (!stage.deliver) continue;
    const steps = (plan.contact_steps ?? []).filter((s) => s.stage_key === stage.key && s.level === undefined);
    if (steps.length === 0) continue;
    const asked = new Set<ContactKindAsked>(steps.map((s) => s.kind as ContactKindAsked));
    const columns: Array<{ kind: ContactKindAsked; key: string }> = [];
    for (const kind of asked) {
      const keys = new Set<string>(steps.filter((s) => s.kind === kind).map((s) => s.column_key));
      for (const c of stage.columns ?? []) {
        if (c.status_of || c.type_of || c.computed) continue;
        if (kind === "email" ? isEmailColumn({ key: c.key, kind: c.kind }) : c.kind === KIND_OF.phone) keys.add(c.key);
      }
      for (const key of keys) columns.push({ kind, key });
      kinds.add(kind);
    }
    const rows = rowsByStage[stage.key] ?? [];
    const without = rows.filter((r) => !columns.some((c) => hasContact(c.kind, r[c.key]))).length;
    const capped = Math.min(without, inFile && typeof inFile[stage.key] === "number" ? Math.max(0, Math.floor(inFile[stage.key])) : without);
    if (capped > 0) { out.byStage[stage.key] = capped; out.total += capped; }
  }
  out.kinds = [...kinds].sort();
  return out;
}

export interface BilledInput {
  /** The rows in the file, capped at the volume sold (what is charged today). */
  delivered: number;
  /** The unbilled people rows: all, and those inside the estimated group (0 when there is no estimated group). */
  unbilledTotal: number;
  unbilledInGroup: number;
  /** Today's delivered rows per group on the per-stage path (DT-01); null on the one-unit path. */
  stageCounts: StageCounts | null;
}

export interface Billed {
  /** The number handed to the settlement as the delivered units (the job's `delivered_units`): the BILLABLE rows, nothing added. */
  deliveredUnits: number;
  /** The per-stage counts handed to the per-stage settlement; null on the one-unit path. */
  counts: StageCounts | null;
  /** Rows delivered but not charged (delivered − billable): the number of the customer's line. */
  reduced: number;
}

/**
 * The count the settlement charges: the billable rows and no others (Megz D-0126: no minimum padding, a card of 2 rows at 100 points with 1 billable row delivered charges 100). The charge is monotone in the count, so it is never above today's;
 * no billable row → 0 units → nothing is charged and the hold is released whole (the file stays).
 */
export function billedUnits(input: BilledInput): Billed {
  const delivered = Math.max(0, Math.floor(input.delivered));
  const total = Math.max(0, Math.floor(input.unbilledTotal));
  if (!input.stageCounts) {
    const units = delivered - Math.min(total, delivered);
    return { deliveredUnits: units, counts: null, reduced: delivered - units };
  }
  const today = input.stageCounts;
  const inGroup = Math.min(Math.max(0, Math.floor(input.unbilledInGroup)), today.estimated);
  const outside = Math.min(Math.max(0, total - Math.max(0, Math.floor(input.unbilledInGroup))), today.base);
  const est = today.estimated - inGroup;
  const base = today.base - outside;
  return { deliveredUnits: base + est, counts: { base, estimated: est }, reduced: today.base + today.estimated - (base + est) };
}

const PEOPLE_NOUN: ItemNoun = { key: "person", singular: "شخص", dual: "شخصان", dualGen: "شخصين", plural: "أشخاص", tamyiz: "شخصًا", feminine: false };
const kindsPhraseAr = (kinds: ReadonlyArray<ContactKindAsked>, both: string): string => (kinds.length > 1 ? both : kinds[0] === "email" ? "إيميل" : "تليفون");

/** The customer's line after a delivery whose charge was lowered (n = delivered − billable): what was not charged and why; the people stay in the file. */
export function unbilledLineAr(n: number, kinds: ReadonlyArray<ContactKindAsked>): string {
  const c = Math.max(1, Math.floor(n));
  const who = c === 1 ? "له" : c === 2 ? "لهما" : "لهم";
  const stay = c === 1 ? "وهو باقٍ" : c === 2 ? "وهما باقيان" : "وهم باقون";
  return `لم يُحتسب عليك ${countAr(c, PEOPLE_NOUN)} لأنه لم يظهر ${who} ${kindsPhraseAr(kinds, "إيميل ولا تليفون")}، ${stay} في الملف دون مقابل.`;
}

/** The reason stored with the release when a delivered file has no billable row at all (the whole hold returns, the people stay in the file). */
export function noBillableReasonAr(kinds: ReadonlyArray<ContactKindAsked>): string {
  return `لم يظهر لأي شخص ما طلبته من ${kindsPhraseAr(kinds, "إيميل أو تليفون")}، فلم يُخصم شيء وعاد الحجز كاملًا.`;
}
