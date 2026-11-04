import type { ContactStep } from "../contactFinders";
import { COMPANY_EMAIL_TITLE_AR, COMPANY_PHONE_TITLE_AR, NOT_AVAILABLE_AR } from "../taskContracts";
import { B2B_NOT_SEARCHED_AR, gapLineAr, resolveField, type Attempt, type ColumnGap } from "./b2bCompile";
import { stage3Enabled, stage3FlagMode } from "./flags";

/**
 * STAGE 3, PART B (docs/STAGE-3.md S4, the engine half), pure. The contact steps of the engine (agent/src/engine/contacts.ts) tell `record` of every lookup they make, per row and column; after them
 * `b2bContactCells` writes each contact cell that holds no value by the fallthrough rule of b2bCompile.ts: «غير متوفر» ONLY when every tool of the column's chain ANSWERED with nothing, «لم يكتمل البحث»
 * when any tool of the chain was refused, failed or not tried. A cell that holds a value is never touched, and no row is added or removed: the delivered count (the rows of the file) and the settlement are
 * what they were. `b2bLimitLines` reads the final cells of the rows the file is built from and says each column's gap in the file's «حدود هذا التسليم». All of it only when DIGER_STAGE3_COMPANIES is on.
 */
export type AttemptOutcome = Attempt["outcome"];
export interface AttemptRecord { stage: string; row: string; column: string; endpointId: string; outcome: AttemptOutcome; value?: string }
export interface AttemptLog {
  record: (a: AttemptRecord) => void;
  of: (stage: string, row: string, column: string) => Attempt[];
  /** The cell of a column that got no value: «غير متوفر» when every tool of the chain answered with nothing, else «لم يكتمل البحث». */
  cellFor: (stage: string, row: string, column: string, chain: ReadonlyArray<string>) => string;
}

/** On for this account: the engine records and the cells and lines are written. Reads the flag first. */
export const b2bEngineOn = (isTestAccount: boolean, env?: Readonly<Record<string, string | undefined>>): boolean => stage3Enabled("DIGER_STAGE3_COMPANIES", isTestAccount, env);
/** The flag is set at all («on» or «test»): only then is it worth reading whether the account is a test account. */
export const b2bFlagSet = (env?: Readonly<Record<string, string | undefined>>): boolean => stage3FlagMode("DIGER_STAGE3_COMPANIES", env) !== "off";

export function createAttemptLog(): AttemptLog {
  const byCell = new Map<string, Attempt[]>();
  const key = (stage: string, row: string, column: string): string => JSON.stringify([stage, row, column]);
  return {
    record: (a) => {
      const k = key(a.stage, a.row, a.column);
      const list = byCell.get(k) ?? [];
      list.push(a.outcome === "value" ? { endpointId: a.endpointId, outcome: "value", value: String(a.value ?? "") } : { endpointId: a.endpointId, outcome: a.outcome });
      byCell.set(k, list);
    },
    of: (stage, row, column) => [...(byCell.get(key(stage, row, column)) ?? [])],
    cellFor: (stage, row, column, chain) => (resolveField([...new Set(chain)], byCell.get(key(stage, row, column)) ?? []).kind === "unavailable" ? NOT_AVAILABLE_AR : B2B_NOT_SEARCHED_AR),
  };
}

type Row = Record<string, unknown>;
interface PlanLike { stages: ReadonlyArray<{ key: string; parent_key: string | null; columns: ReadonlyArray<{ key: string; title_ar: string; status_of?: string }> }>; contact_steps?: ReadonlyArray<ContactStep> }
export interface ContactColumn { stage: string; column: string; titleAr: string; chain: string[]; noun: "company" | "person" }

/**
 * THE CONTACT COLUMNS AND THEIR CHAINS: each step's column with its lookups in the step's order (a company's HQ phone: its map searches; every other step: its finders, the compiled chain for a code-built
 * plan), and each of the reference's company contact columns that no step fills (no verified tool for it: its chain is empty, so its cells can only be «لم يكتمل البحث»).
 */
export function contactColumnsOf(plan: PlanLike): ContactColumn[] {
  const out: ContactColumn[] = [];
  for (const step of plan.contact_steps ?? []) {
    const stage = plan.stages.find((s) => s.key === step.stage_key);
    if (!stage) continue;
    const chain = (step.level === "company" && step.kind === "phone" ? step.company_phone ?? [] : step.finders).map((f) => f.id);
    const title = stage.columns.find((c) => c.key === step.column_key)?.title_ar ?? (step.kind === "email" ? COMPANY_EMAIL_TITLE_AR : COMPANY_PHONE_TITLE_AR);
    out.push({ stage: stage.key, column: step.column_key, titleAr: title, chain: [...new Set(chain)], noun: step.level === "company" ? "company" : "person" });
  }
  for (const stage of plan.stages) {
    if (stage.parent_key !== null) continue;
    for (const c of stage.columns) {
      if (c.status_of || (c.title_ar !== COMPANY_EMAIL_TITLE_AR && c.title_ar !== COMPANY_PHONE_TITLE_AR)) continue;
      if (out.some((x) => x.stage === stage.key && x.column === c.key)) continue;
      out.push({ stage: stage.key, column: c.key, titleAr: c.title_ar, chain: [], noun: "company" });
    }
  }
  return out;
}

const cellOf = (row: Row, column: string): string => String(row[column] ?? "").trim();
const holdsValue = (v: string): boolean => v !== "" && v !== NOT_AVAILABLE_AR && v !== B2B_NOT_SEARCHED_AR;

/** The cells to write (one entry per row that changes): only cells with no value, by the fallthrough over the recorded attempts. A value is never written from the log (the steps write values). */
export function b2bContactCells(plan: PlanLike, rowsByStage: Readonly<Record<string, ReadonlyArray<Row>>>, log: Pick<AttemptLog, "of">): Array<{ t: "cells"; stage: string; id: string; cells: Record<string, string> }> {
  const byRow = new Map<string, { t: "cells"; stage: string; id: string; cells: Record<string, string> }>();
  for (const col of contactColumnsOf(plan)) {
    for (const row of rowsByStage[col.stage] ?? []) {
      const id = String(row.id ?? "");
      const now = cellOf(row, col.column);
      if (!id || holdsValue(now)) continue;
      const r = resolveField(col.chain, log.of(col.stage, id, col.column));
      if (r.kind === "value") continue;
      const next = r.kind === "unavailable" ? NOT_AVAILABLE_AR : B2B_NOT_SEARCHED_AR;
      if (next === now) continue;
      const k = JSON.stringify([col.stage, id]);
      const op = byRow.get(k) ?? { t: "cells" as const, stage: col.stage, id, cells: {} };
      op.cells[col.column] = next;
      byRow.set(k, op);
    }
  }
  return [...byRow.values()];
}

/** The lines of the file for each contact column, read from the cells of the rows the file is built from (found, «غير متوفر», «لم يكتمل البحث» or still empty) and the length of the column's chain. */
export function b2bLimitLines(plan: PlanLike, rowsByStage: Readonly<Record<string, ReadonlyArray<Row>>>): string[] {
  const lines: string[] = [];
  for (const col of contactColumnsOf(plan)) {
    const rows = rowsByStage[col.stage] ?? [];
    if (rows.length === 0) continue;
    const gap: ColumnGap = { total: rows.length, found: 0, unavailable: 0, incomplete: 0, tools: col.chain.length };
    for (const row of rows) { const v = cellOf(row, col.column); if (holdsValue(v)) gap.found += 1; else if (v === NOT_AVAILABLE_AR) gap.unavailable += 1; else gap.incomplete += 1; }
    lines.push(gapLineAr(col.titleAr, gap, col.noun));
  }
  return lines;
}
