import { createHash } from "node:crypto";
import { SUMMARY_SHEET_AR } from "../../modelPlanner/missionWorkbook";

/**
 * STAGE 4, FILE VERSIONS (docs/STAGE-4.md, FOUNDATION-PLAN PR 6). The delivered file is VERSION 1. A review fix or an edit after delivery makes a NEW version FROM the old one; the old one is
 * kept unchanged (every version is deeply frozen, and its digest is of its content only). Pure: no I/O. Storage is a PROPOSAL in the doc (create-only objects `versions/vNNNN.json` in the
 * mission's folder; no table, no migration). No charge is attached to a version.
 */
export type VersionReason = "delivery" | "edit" | "review_fix";
export interface VersionRow { readonly id: string; readonly parentId: string | null; readonly cells: ReadonlyArray<string> }
export interface VersionSheet { readonly nameAr: string; readonly headers: ReadonlyArray<string>; readonly rows: ReadonlyArray<VersionRow> }
export interface FileVersion {
  readonly v: 1;
  readonly missionId: string;
  readonly version: number;
  readonly parent: number | null;
  readonly reason: VersionReason;
  readonly createdAt: string;
  readonly sheets: ReadonlyArray<VersionSheet>;
  /** sha-256 of the sheets (names, headers, rows): two versions with the same content have the same digest. */
  readonly digest: string;
}

export const ID_HEADER = "المعرّف";
export const PARENT_HEADER = "معرّف الأصل";

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v); }
  return o;
}
const digestOf = (sheets: ReadonlyArray<VersionSheet>): string => createHash("sha256").update(JSON.stringify(sheets.map((s) => ({ n: s.nameAr, h: s.headers, r: s.rows.map((r) => [r.id, r.parentId, r.cells]) })))).digest("hex");

/** A sheet from its rows of text (the header row first), its rows keyed by the file's own id column. */
export function sheetFromCells(nameAr: string, table: ReadonlyArray<ReadonlyArray<string>>): VersionSheet {
  const [head = [], ...body] = table;
  const idAt = head.indexOf(ID_HEADER);
  const parentAt = head.indexOf(PARENT_HEADER);
  const width = head.length;
  return {
    nameAr,
    headers: [...head],
    rows: body.map((r, i) => {
      const cells = Array.from({ length: width }, (_, j) => String(r[j] ?? ""));
      return { id: idAt >= 0 && cells[idAt] !== "" ? cells[idAt] : `row_${i + 1}`, parentId: parentAt >= 0 && cells[parentAt] !== "" ? cells[parentAt] : null, cells };
    }),
  };
}

/** Version 1: the delivered file's data sheets (the summary sheet is rebuilt from the rows, so it is not versioned). */
export function firstVersionFromCells(input: { missionId: string; cells: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>>; createdAt: string }): FileVersion {
  const sheets = Object.entries(input.cells).filter(([name]) => name !== SUMMARY_SHEET_AR).map(([name, table]) => sheetFromCells(name, table));
  return deepFreeze({ v: 1 as const, missionId: input.missionId, version: 1, parent: null, reason: "delivery" as const, createdAt: input.createdAt, sheets, digest: digestOf(sheets) });
}

/**
 * A NEW version from `prev`: `change` receives the old sheets (frozen: a changer that tries to mutate them throws) and returns the new sheets. The old version is not touched.
 */
export function deriveVersion(prev: FileVersion, change: (sheets: ReadonlyArray<VersionSheet>) => ReadonlyArray<VersionSheet>, meta: { reason: Exclude<VersionReason, "delivery">; createdAt: string }): FileVersion {
  const next = change(prev.sheets);
  for (const s of next) for (const r of s.rows) if (typeof r.id !== "string" || r.id === "") throw new Error("a row of a new version has no id");
  const sheets = structuredClone(next) as VersionSheet[];
  return deepFreeze({ v: 1 as const, missionId: prev.missionId, version: prev.version + 1, parent: prev.version, reason: meta.reason, createdAt: meta.createdAt, sheets, digest: digestOf(sheets) });
}

export interface SheetDiff { rowsAdded: number; rowsRemoved: number; rowsChanged: number; cellsChanged: number; cellsAdded: number; columnsAdded: string[]; columnsRemoved: string[] }
export interface VersionDiff {
  rowsAdded: number; rowsRemoved: number; rowsChanged: number; cellsChanged: number; cellsAdded: number;
  columnsAdded: Array<{ sheet: string; titleAr: string }>; columnsRemoved: Array<{ sheet: string; titleAr: string }>;
  sheetsAdded: string[]; sheetsRemoved: string[];
  bySheet: Record<string, SheetDiff>;
}

/** What changed from `a` to `b`: rows matched by id, cells compared under the same header; an added column counts its filled cells as added, not changed. */
export function diffVersions(a: FileVersion, b: FileVersion): VersionDiff {
  const out: VersionDiff = { rowsAdded: 0, rowsRemoved: 0, rowsChanged: 0, cellsChanged: 0, cellsAdded: 0, columnsAdded: [], columnsRemoved: [], sheetsAdded: [], sheetsRemoved: [], bySheet: {} };
  const aBy = new Map(a.sheets.map((s) => [s.nameAr, s]));
  const bBy = new Map(b.sheets.map((s) => [s.nameAr, s]));
  for (const n of bBy.keys()) if (!aBy.has(n)) out.sheetsAdded.push(n);
  for (const n of aBy.keys()) if (!bBy.has(n)) out.sheetsRemoved.push(n);
  for (const [name, sb] of bBy) {
    const sa = aBy.get(name) ?? { nameAr: name, headers: [], rows: [] };
    const d: SheetDiff = { rowsAdded: 0, rowsRemoved: 0, rowsChanged: 0, cellsChanged: 0, cellsAdded: 0, columnsAdded: sb.headers.filter((h) => !sa.headers.includes(h)), columnsRemoved: sa.headers.filter((h) => !sb.headers.includes(h)) };
    const common = sb.headers.filter((h) => sa.headers.includes(h));
    const aRows = new Map(sa.rows.map((r) => [r.id, r]));
    const bIds = new Set(sb.rows.map((r) => r.id));
    for (const r of sb.rows) {
      const old = aRows.get(r.id);
      if (!old) { d.rowsAdded += 1; continue; }
      let changed = 0;
      for (const h of common) if (old.cells[sa.headers.indexOf(h)] !== r.cells[sb.headers.indexOf(h)]) changed += 1;
      for (const h of d.columnsAdded) if ((r.cells[sb.headers.indexOf(h)] ?? "") !== "") d.cellsAdded += 1;
      if (changed > 0) { d.rowsChanged += 1; d.cellsChanged += changed; }
    }
    for (const r of sa.rows) if (!bIds.has(r.id)) d.rowsRemoved += 1;
    out.bySheet[name] = d;
    out.rowsAdded += d.rowsAdded; out.rowsRemoved += d.rowsRemoved; out.rowsChanged += d.rowsChanged; out.cellsChanged += d.cellsChanged; out.cellsAdded += d.cellsAdded;
    out.columnsAdded.push(...d.columnsAdded.map((titleAr) => ({ sheet: name, titleAr })));
    out.columnsRemoved.push(...d.columnsRemoved.map((titleAr) => ({ sheet: name, titleAr })));
  }
  for (const n of out.sheetsRemoved) out.rowsRemoved += aBy.get(n)!.rows.length;
  return out;
}

/** The storage path of a version (proposal: create-only, never overwritten; the newest is the highest number in the listing). */
export const versionPathOf = (version: number): string => `versions/v${String(Math.max(1, Math.floor(version))).padStart(4, "0")}.json`;
