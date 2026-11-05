import { AGENT_BUCKET, MISSION_TABLE } from "../constants";
import { stage4FlagMode } from "./flags";
import { REVIEW_CODES, REVIEW_ISSUE_AR, reviewCellsOf, type ReviewCode } from "./review";
import type { ReviewReportView } from "./reviewReportLabels";
import { ID_HEADER, PARENT_HEADER, type FileVersion } from "./versions";
import { readPublishedVersion } from "./versionFile";

/**
 * STAGE A (docs/STAGE-4.md section 8, S3): THE CUSTOMER'S REVIEW REPORT, behind DIGER_STAGE4_REVIEW. READ-ONLY and server only: it reads the PUBLISHED report `reviews/rNNNN.json` of the customer's own mission (the worker publishes it only after the review was charged and its report stored;
 * a pending report under `addons/` is never read), after `readPublishedVersion` has proved the reviewed version is the customer's own, published and intact. Nothing is written, priced, held or charged, and no add-on row is made: showing a report that already exists is free (decision D11).
 *
 * THE REPORT IS CHECKED, NEVER TRUSTED. It is shown only if it is exactly the review of this version of this mission: the mission id, the version number, the digest of the version AS STORED NOW, the cells and the items of that version, a score that is a whole number from 0 to 100,
 * and issues that name a real code, a real sheet, a real column and real item ids of that sheet. The score must also be one the issues can produce (a score of 100 with a fault, or less than 100 with none, is refused): no score is ever invented or repaired.
 * What the customer receives is a view with the version, the score, the counts and the review's own whitelisted sentence for each issue: never a storage path, an add-on id, an item id or a digest.
 */

/** Only «on» serves the report. «test» is NOT served here: telling a test account apart needs the test-account list, which customer-side code must never import (the same rule as the versions list and the review preview). */
export function reviewReportAvailable(env?: Readonly<Record<string, string | undefined>>): boolean {
  return stage4FlagMode("DIGER_STAGE4_REVIEW", env) === "on";
}

type Failure = { ok: false; status: 404 | 500 | 503; error: "not_found" | "damaged" | "unavailable" };
const no = (status: 404 | 500 | 503, error: Failure["error"]): Failure => ({ ok: false, status, error });

const ISSUE_ROWIDS_MAX = 20;
const ISSUES_MAX = 5_000;
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const objectOf = (version: number): string => `r${String(version).padStart(4, "0")}.json`;
const NAME = /^r(\d{4,})\.json$/;

const readableColumns = (headers: ReadonlyArray<string>): number => headers.filter((h) => h !== ID_HEADER && h !== PARENT_HEADER).length;

/** The score a given number of faulty cells gives (the review's own formula). */
const scoreFor = (cells: number, faults: number): number => (cells === 0 ? 100 : Math.max(0, Math.min(100, Math.floor((100 * (cells - Math.min(faults, cells))) / cells))));

/**
 * The stored report as the customer's view, or null when it is not exactly the review of `version` (see the header). `version` is the published version AS STORED NOW: a report whose digest is another file's, or whose counts are not this file's, is not shown.
 */
export function checkReviewReport(parsed: unknown, version: FileVersion): ReviewReportView | null {
  const r = parsed as Record<string, any> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  if (r.v !== 1 || r.missionId !== version.missionId || r.version !== version.version || r.baseDigest !== version.digest) return null;
  if (!isText(r.addonId) || !isText(r.createdAt) || Number.isNaN(Date.parse(r.createdAt))) return null;
  const cells = reviewCellsOf(version);
  const rows = version.sheets.reduce((n, s) => n + s.rows.length, 0);
  if (r.cells !== cells || r.rowsReviewed !== rows) return null;
  if (!Number.isInteger(r.score) || r.score < 0 || r.score > 100) return null;
  if (!Array.isArray(r.issues) || r.issues.length > ISSUES_MAX) return null;
  const seen = new Set<string>();
  const issues: ReviewReportView["issues"] = [];
  let faultsMax = 0;
  let faultsMin = 0;
  for (const i of r.issues) {
    if (!i || typeof i !== "object" || Array.isArray(i) || !(REVIEW_CODES as ReadonlyArray<string>).includes(i.code) || !isText(i.sheet) || !isText(i.column) || !Number.isInteger(i.count) || i.count < 1 || !Array.isArray(i.rowIds)) return null;
    const code = i.code as ReviewCode;
    const sheet = version.sheets.find((s) => s.nameAr === i.sheet);
    if (!sheet) return null;
    // a duplicate is reported against its sheet; every other issue names a readable column of that sheet
    if (code === "exact_duplicate" ? i.column !== sheet.nameAr : !sheet.headers.includes(i.column) || i.column === ID_HEADER || i.column === PARENT_HEADER) return null;
    const ceiling = code === "exact_duplicate" ? Math.max(0, sheet.rows.length - 1) : sheet.rows.length;
    if (i.count > ceiling) return null;
    const key = `${code}\u0000${i.sheet}\u0000${i.column}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const ids = new Set(sheet.rows.map((x) => x.id));
    if (i.rowIds.length < 1 || i.rowIds.length > Math.min(i.count, ISSUE_ROWIDS_MAX) || !i.rowIds.every((x: unknown) => typeof x === "string" && ids.has(x)) || new Set(i.rowIds).size !== i.rowIds.length) return null;
    // a stated gap is said, never counted; a duplicate counts every readable cell of its item; every other fault counts one cell
    const measure = code === "stated_gap" ? 0 : code === "exact_duplicate" ? i.count * readableColumns(sheet.headers) : i.count;
    faultsMax += measure;
    faultsMin = Math.max(faultsMin, measure);
    issues.push({ code, sheet: i.sheet, column: i.column, count: i.count, textAr: REVIEW_ISSUE_AR[code](i.column, i.count) });
  }
  // the faulty cells are at least the biggest single finding and at most all the findings together (they may overlap): the score must lie between the two
  if (r.score > scoreFor(cells, faultsMin) || r.score < scoreFor(cells, faultsMax)) return null;
  return { version: version.version, reason: version.reason, score: r.score, cells, rowsReviewed: rows, reviewedAt: new Date(r.createdAt).toISOString(), issues };
}

type Entry = { name: string; id?: string | null };
/** The published objects of `<mission>/reviews`; a listing that fails is an error, never an empty folder. */
async function listReports(client: any, missionId: string): Promise<{ ok: true; names: string[] } | Failure> {
  try {
    const { data, error } = await client.storage.from(AGENT_BUCKET).list(`${missionId}/reviews`, { limit: 1000, sortBy: { column: "name", order: "asc" } });
    if (error) return no(503, "unavailable");
    return { ok: true, names: ((data ?? []) as Entry[]).filter((o) => Boolean(o.id)).map((o) => o.name) };
  } catch {
    return no(503, "unavailable");
  }
}

export type ReviewedVersionsResult = { ok: true; versions: number[] } | Failure;

/** The versions of the customer's own mission that have a published report, oldest first. Only the names are read: each report is checked when it is asked for. */
export async function listReviewedVersions(client: any, input: { missionId: string; userId: string }): Promise<ReviewedVersionsResult> {
  try {
    const { data, error } = await client.from(MISSION_TABLE).select("id,user_id").eq("id", input.missionId).maybeSingle();
    if (error) return no(503, "unavailable");
    if (!data || data.user_id !== input.userId) return no(404, "not_found");
    const listed = await listReports(client, input.missionId);
    if (!listed.ok) return listed;
    const versions = [...new Set(listed.names.map((n) => Number(NAME.exec(n)?.[1] ?? 0)).filter((n) => n >= 1))].sort((a, b) => a - b);
    return { ok: true, versions };
  } catch {
    return no(503, "unavailable");
  }
}

export type ReviewReportResult = { ok: true; report: ReviewReportView } | Failure;

/**
 * The published report of version `version` of the customer's own mission, checked.
 * 404 «not_found»: the mission is not theirs or does not exist (the same answer), the version is not published, or it has no published report (a pending one is not one).
 * 503 «unavailable»: the storage or the database could not answer (never taken for «missing»).
 * 500 «damaged»: the published version or its report is not exactly what it claims to be (never shown).
 */
export async function readReviewReport(client: any, input: { missionId: string; userId: string; version: number }): Promise<ReviewReportResult> {
  const read = await readPublishedVersion(client, input);
  if (!read.ok) return read;
  const listed = await listReports(client, input.missionId);
  if (!listed.ok) return listed;
  if (!listed.names.includes(objectOf(input.version))) return no(404, "not_found");
  try {
    const { data: blob, error } = await client.storage.from(AGENT_BUCKET).download(`${input.missionId}/reviews/${objectOf(input.version)}`);
    if (error || !blob) return no(503, "unavailable");
    let text: string;
    try { text = await blob.text(); } catch { return no(503, "unavailable"); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return no(500, "damaged"); }
    const report = checkReviewReport(parsed, read.version);
    return report ? { ok: true, report } : no(500, "damaged");
  } catch {
    return no(503, "unavailable");
  }
}
