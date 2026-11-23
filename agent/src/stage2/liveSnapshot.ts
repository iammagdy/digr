import { promisedTotalOf } from "../../../src/lib/agentMission/promisedNumbers";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../../../src/lib/agentMission/repliesCard";
import type { PricedPlan } from "../../../src/lib/agentMission/plan";
import { MARKS_KEY } from "../../../src/lib/agentMission/rawMarks";
import { wordBoundarySheetName } from "../../../src/lib/agentMission/fileNames";
import { SUMMARY_SHEET_AR } from "../../../src/lib/modelPlanner/missionWorkbook";
import { isLanguageColumn, languageLabelAr, languageOfTextAr, textColumnKeyOf } from "../../../src/lib/agentMission/languageLabel";
import { cairoCellDate, cairoText, dateOnlyCellDate, dateOnlyText, isDateValues, parseDateOnly, parseMoment } from "../../../src/lib/agentMission/dateCells";
import { counterAr, type LiveCell, type LiveRow, type LiveSheet, type LiveSnapshot, type LiveStatus } from "../../../src/lib/agentMission/stage2/liveSheet";
import { workLogFromEvents, workLogLine, type WorkLogLine } from "../../../src/lib/agentMission/stage2/workLog";
import type { ItemSnapshot } from "../items/itemStore";
import { COUNTER_UNAVAILABLE_AR, deliveredSheetsOf, displayMissingValue, ID_HEADER_AR, MISSING_LABELS, PARENT_HEADER_AR, type CompanyMailboxes, type SheetLayout } from "../workbook";
import { dateUnreadColumnsOf } from "../../../src/lib/agentMission/relativeDates";
import type { MissionFacts } from "../methodology";
import { computeScopeCounters, scopeLabelAr, type ItemScope, type ScopeCounters, SCOPE_COLUMN_KEY, SCOPE_COLUMN_TITLE_AR } from "../llmPlanner/widening";

type Row = Record<string, unknown>;

export interface LiveSnapshotWithScope extends LiveSnapshot {
  counters: ScopeCounters;
  stop_reason_ar?: string;
  coverage_note_ar?: string;
  readonly rows: LiveRow[];
}

/**
 * STAGE 2, THE LIVE SNAPSHOT (docs/STAGE-2.md). Built by the WORKER from its item log, with the delivery's own steps, so what the customer watches is what the file will hold:
 *   1. THE ROWS: exactly as the finalize step of `runMission.ts` reads them (`withPromiseCaps`, then each stage's first `planned_rows` accepted rows in log order: the log keeps the first
 *      appearance of an id, so an exact duplicate is never shown twice; then `reportedPlan` and, when replies were open, `withRepliesJudged`). A test pins those lines of runMission.ts.
 *   2. THE SHEETS: `deliveredSheetsOf` of `workbook.ts`, the same function `buildMissionFiles` lays its sheets out with (columns, order, replies under their comments, provider addresses out,
 *      and the delivery contract's completion of a missing mark or precision cell).
 *   3. THE CELLS: the value each cell of the file holds (text, number, date, link), by the writer's rules; the sheet names by the file's rule.
 * At completion the snapshot equals the file, sheet by sheet and row by row (tests/stage2-live-equality.test.ts, on stored real missions). Pure: no I/O. The wiring that stores it while
 * the job runs (behind `DIGER_STAGE2_LIVE_SHEET`) is left for the next session (docs/STAGE-2.md).
 */

/** The rows of the delivery and the plan the file is written with, from the item log, as `runMission.ts` reads them at finalize. */
export function deliveryRowsOf(approvedPlan: PricedPlan, snap: Pick<ItemSnapshot, "acceptedRows" | "stage">): { plan: PricedPlan; rowsByStage: Record<string, Row[]>; repliesJudged: boolean } {
  let plan = withPromiseCaps(approvedPlan);
  const rowsByStage: Record<string, Row[]> = {};
  for (const s of plan.stages) rowsByStage[s.key] = snap.acceptedRows(s.key, s.deliver ? s.planned_rows : undefined);

  // STAGE 2 / TREG P4: Scope-separated widening & live sheet parity.
  // Populate scope_label_ar as an explicit cell column in live sheet and delivered workbook.
  let planWithScope = plan;
  for (const s of plan.stages) {
    const rows = rowsByStage[s.key] ?? [];
    const hasScope = rows.some((r) => r.scope !== undefined || r[SCOPE_COLUMN_KEY] !== undefined) || s.columns.some((c) => c.key === SCOPE_COLUMN_KEY);
    if (hasScope) {
      for (const r of rows) {
        if (!r[SCOPE_COLUMN_KEY]) {
          const scope = (r.scope as ItemScope) || "primary_account";
          r.scope = scope;
          r[SCOPE_COLUMN_KEY] = scopeLabelAr(scope);
        }
      }
      if (!s.columns.some((c) => c.key === SCOPE_COLUMN_KEY)) {
        planWithScope = {
          ...planWithScope,
          stages: planWithScope.stages.map((st) =>
            st.key === s.key
              ? { ...st, columns: [...st.columns, { key: SCOPE_COLUMN_KEY, title_ar: SCOPE_COLUMN_TITLE_AR }] }
              : st
          ),
        };
      }
    }
  }
  plan = planWithScope;

  plan = reportedPlan(plan, Object.fromEntries(plan.stages.map((s) => [s.key, rowsByStage[s.key].length])));
  const repliesJudged = plan.stages.some((s) => s.replies_open || s.children_open);
  if (repliesJudged) plan = withRepliesJudged(plan, rowsByStage, (k) => { const st = snap.stage(k).stop; return !st || st === "source_exhausted"; });
  return { plan, rowsByStage, repliesJudged };
}

const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const isUrl = (v: unknown): boolean => /^https?:\/\//i.test(text(v).trim());
/** The writer's rule for a column stored as numbers (workbook.ts `numericColumn`): every filled value a plain number (no leading zero, at most 15 digits), never a contact column. */
function numericColumn(values: unknown[], contact: boolean): boolean {
  if (contact) return false;
  const filled = values.map((v) => text(v).trim()).filter((v) => Boolean(v) && v !== COUNTER_UNAVAILABLE_AR);
  return filled.length > 0 && filled.every((v) => /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v));
}
const EMPTY: LiveCell = { k: "empty", v: "" };

/** The cells of one sheet, by the writer's rules (buildMissionFiles): language labels in a new-pipeline file, dates in Cairo time, numbers, links, «نعم» / «لا». */
function sheetRows(
  lay: SheetLayout,
  parentById: Map<string, Row>,
  newPipeline: boolean,
  markMissing: boolean,
  incompleteKeys: ReadonlySet<string>,
): LiveRow[] {
  const columnValues = lay.columns.map((c) => lay.rows.map((r) => c.get(r, parentById.get(text(r.parent_id)) ?? null)));
  const dateAt = lay.columns.map((c, k) => isDateValues(c.title, c.key, columnValues[k]));
  const languageAt = lay.columns.map((c) => isLanguageColumn(c.title, c.key));
  const numericAt = lay.columns.map((c, k) => !dateAt[k] && numericColumn(columnValues[k], Boolean(c.contact)));
  const textKey = newPipeline ? textColumnKeyOf(lay.columns.map((x) => ({ key: x.key ?? "", title: x.title }))) : null;
  const textAt = textKey !== null ? lay.columns.findIndex((x) => x.key === textKey) : -1;
  return lay.rows.map((record) => {
    const parent = parentById.get(text(record.parent_id)) ?? null;
    const cells: LiveCell[] = lay.columns.map((c, k) => {
      const got = c.get(record, parent);
      const labelled = newPipeline && languageAt[k] ? languageLabelAr(got) : got;
      const v = newPipeline && languageAt[k] && (labelled === null || labelled === undefined || (typeof labelled === "string" && labelled.trim() === "")) && textAt >= 0 ? languageOfTextAr(lay.columns[textAt].get(record, parent)) : labelled;
      const keepBlank = (newPipeline && languageAt[k]) || (c.key !== undefined && dateUnreadColumnsOf(record).includes(c.key));
      const shown = displayMissingValue(lay.stage.key, text(record.id), c, v, keepBlank, markMissing, incompleteKeys);
      if (shown === null || shown === undefined || (typeof shown === "string" && shown.trim() === "")) return EMPTY;
      if (dateAt[k]) {
        const day = parseDateOnly(shown);
        if (day) return { k: "date", v: dateOnlyCellDate(day).toISOString(), d: dateOnlyText(day) };
        const moment = parseMoment(shown);
        if (moment) return { k: "date", v: cairoCellDate(moment).toISOString(), d: cairoText(moment) };
      }
      if (typeof shown === "number" && Number.isFinite(shown)) return { k: "number", v: String(shown) };
      if (typeof shown === "boolean") return { k: "text", v: shown ? "نعم" : "لا" };
      const t = text(shown);
      if (MISSING_LABELS.has(t)) return { k: "text", v: t };
      if (numericAt[k]) return { k: "number", v: String(Number(t.trim())) };
      if (isUrl(t)) return { k: "link", v: t.trim() };
      return { k: "text", v: t };
    });
    return { id: text(record.id), parentId: lay.hasParent ? text(record.parent_id) : null, cells };
  });
}

export interface LiveSnapshotInput {
  missionId: string;
  /** The plan as the customer approved it (the mission's stored plan). */
  plan: PricedPlan;
  snap: Pick<ItemSnapshot, "acceptedRows" | "stage" | "lastSeq">;
  status: LiveStatus;
  /** The companies' own mailboxes (runMission.ts `companyMailboxesOf(plan, snap)`), for a companies delivery. */
  companyMailboxes?: CompanyMailboxes;
  /** The run's facts (runMission.ts `missionFactsOf`), as the file is written with them; absent while the job runs (they shape only the summary sheet's lines). */
  facts?: MissionFacts;
  /** The mission's stored live events (the work log is made from their numbers only). */
  events?: ReadonlyArray<{ kind: string; created_at: string; counts?: Record<string, unknown> | null }>;
  nowMs: number;
  /** Stop reason in Arabic (Point 4.2: done live snapshot embeds stop_reason_ar). */
  stopReasonAr?: string;
  /** Coverage note in Arabic (Point 4.2: done live snapshot embeds coverage note). */
  coverageNoteAr?: string;
}

export function buildLiveSnapshot(input: LiveSnapshotInput): LiveSnapshotWithScope {
  const { plan, rowsByStage, repliesJudged } = deliveryRowsOf(input.plan, input.snap);
  const { rowsByStage: laidRows, layouts } = deliveredSheetsOf(plan, rowsByStage, input.facts, input.companyMailboxes, { repliesJudged, approvedPlan: input.plan, now: input.nowMs });
  const newPipeline = Object.values(laidRows).some((rows) => rows.some((r) => r[MARKS_KEY] !== undefined));
  const incompleteList = input.facts?.incompleteCells ?? [];
  const incompleteKeys = new Set(incompleteList.map((x) => `${x.stage}|${x.rowId}|${x.column}`));
  const markMissing = (newPipeline || input.plan.compiled?.by === "compiler" || input.plan.stages.some((s) => s.engine?.built_by === "code"));
  const used = new Set<string>([SUMMARY_SHEET_AR.toLowerCase()]);
  const sheets: LiveSheet[] = layouts.map((lay) => {
    const nameAr = wordBoundarySheetName(lay.stage.title_ar, used, `مرحلة ${lay.stageIndex + 1}`);
    const parentById = new Map((laidRows[lay.stage.parent_key ?? ""] ?? []).map((r) => [text(r.id), r]));
    const headers = [...lay.columns.map((c) => c.title), ID_HEADER_AR, ...(lay.hasParent ? [PARENT_HEADER_AR] : [])];
    return { stageKey: lay.stage.key, nameAr, headers, rows: sheetRows(lay, parentById, newPipeline, markMissing, incompleteKeys) };
  });
  const deliveredByStage = Object.fromEntries(plan.stages.map((s) => [s.key, (rowsByStage[s.key] ?? []).length]));
  const { delivered, promised } = promisedTotalOf(plan, deliveredByStage, repliesJudged);
  const workLog: WorkLogLine[] = input.events ? workLogFromEvents(plan, input.events) : [];
  // LAUNCH ROUND: the DONE snapshot is written only after the file was built and stored and the mission settled (liveWriter.ts `writeDoneSnapshotSafely`): its last line says the file is ready,
  // at the moment it was built. A running snapshot never says so.
  if (input.status === "done" && input.events) { const ready = workLogLine({ code: "file_ready", at: input.nowMs }); if (ready) workLog.push(ready); }
  const promisedOrNull = promised > 0 ? promised : null;

  // Compute live scope breakdown counters across all accepted rows
  const allAccepted = Object.values(rowsByStage).flat();
  const counters = computeScopeCounters(allAccepted);

  const stop_reason_ar: string | undefined = input.stopReasonAr ?? (input.facts as { stopReasonAr?: string } | undefined)?.stopReasonAr;
  const coverage_note_ar: string | undefined = input.coverageNoteAr ?? (input.facts as { coverageNoteAr?: string } | undefined)?.coverageNoteAr;

  const snapshot: LiveSnapshotWithScope = {
    v: 1,
    missionId: input.missionId,
    cursor: `${input.snap.lastSeq}.${workLog.length}.${input.status}`,
    status: input.status,
    delivered,
    promised: promisedOrNull,
    counterAr: counterAr(delivered, promisedOrNull),
    sheets,
    workLog,
    builtAt: input.nowMs,
    counters,
    ...(input.status === "done" && stop_reason_ar ? { stop_reason_ar } : {}),
    ...(input.status === "done" && coverage_note_ar ? { coverage_note_ar } : {}),
    get rows() {
      return this.sheets.flatMap((s) => s.rows);
    },
  };
  return snapshot;
}
