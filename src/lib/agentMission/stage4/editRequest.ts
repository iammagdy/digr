import { formatAr } from "../../arabicDigits";
import { MISSION_TABLE } from "../constants";
import { readAddonPlan } from "../addonSettlement";
import { editCard, unitsOfIntent } from "./addonQuote";
import { addonThatStays, canCreateAddon, createAddonRow, isUnpaidAddonRow, listWithRecovery, OPEN_STATUSES, reconcileOpenAddons, type AddonRowLike, type EditIntent } from "./addonRow";
import { cancelUnpaidAddonRow, createSupabaseAddonRowStore } from "./addonRowStore";
import { applyEditCore, EDIT_REJECTION_AR, type EditRequest } from "./editCore";
import type { EditInput } from "./editRequestForm";
import type { EditChangeView, EditQuoteView, EditRequestView, EditSchemaView } from "./editRequestLabels";
import { stage4FlagMode } from "./flags";
import { isRealValue } from "./reread";
import { REVIEW_CODES, reviewFile, type ReviewCode } from "./review";
import { ID_HEADER, PARENT_HEADER, type FileVersion } from "./versions";
import { latestPublishedNumber, readPublishedVersion } from "./versionFile";

/**
 * STAGE B (docs/STAGE-4.md section 8, S4; docs/MONEY-PR-7A.md): THE CUSTOMER'S EDIT REQUEST BEFORE PAYMENT, behind DIGER_STAGE4_EDITS. The customer asks for an edit of the LATEST published version of their own file; this module reads that version (`readPublishedVersion`: owner, published, intact),
 * checks the edit against it with the edit engine's own rules (`applyEditCore`, a dry run: nothing is made), prices it with the existing card (`editCard`; never a number from the browser, never a model), and makes an UNPAID add-on row (`createAddonRow`, stored `plan_ready`) that WAITS for approval,
 * finds it again after a refresh, and cancels it while it is unpaid. Nothing is reserved, charged, released or refunded; no job exists; no provider or model is called; the original version is never written.
 *
 * WHAT IS OFFERED: only edits whose values the CUSTOMER TYPED (rename a column, correct selected cells, add items), because they need no lookup: their provider cost is exactly 0 and the card prices them at the add-on minimum. An item is named by its NUMBER in its sheet; the server finds its id.
 * WHAT IS NOT: anything that needs a NEW LOOKUP (a new column, a correction by search, a fix from a review issue). No recipe is produced from a customer's words and no lookup price is known, so no quote is guessed: the answer is «unsupported», no price, nothing created. Rows are never removed.
 */

/** Only «on» serves the edit request. «test» is NOT served here: telling a test account apart needs the test-account list, which customer-side code must never import (the same rule as the versions list and the review preview). */
export function editsAvailable(env?: Readonly<Record<string, string | undefined>>): boolean {
  return stage4FlagMode("DIGER_STAGE4_EDITS", env) === "on";
}

export const EDIT_LIMITS = { cells: 100, rows: 50, value: 500, name: 120, totalChars: 20_000, columns: 100 } as const;
/** The sentences of the rejections this module adds to the edit engine's own (`EDIT_REJECTION_AR`). */
export const REQUEST_REJECTION_AR = {
  bad_value: "اكتب قيمة حقيقية لكل خانة؛ القيمة الفارغة أو «غير متوفر» لا تُقبل.",
  incomplete_row: "املأ كل أعمدة العنصر الجديد بقيم حقيقية.",
  duplicate_cell: "لا يمكن تصحيح الخانة نفسها مرتين في طلب واحد.",
  no_such_issue: "لم نجد هذه المشكلة في مراجعة هذه النسخة.",
} as const;

type Failure = {
  ok: false;
  status: 404 | 409 | 500 | 503;
  error: "not_found" | "damaged" | "unavailable" | "open_addon" | "not_latest_version" | "already_edited" | "too_large" | "plan_changed" | "unsupported" | "rejected" | "changed";
  /** Present only for «rejected»: one of the whitelisted sentences above. */
  messageAr?: string;
};
const no = (status: Failure["status"], error: Failure["error"], messageAr?: string): Failure => ({ ok: false, status, error, ...(messageAr ? { messageAr } : {}) });

// ---------------------------------------------------------------------------------------------------------------- the input

/** What the browser may send as `edit`. A review fix names ONE issue of the review of the version (its cells are recomputed by code from the whole version). */
export interface ReviewFixInput { kind: "review_fix"; sheet: string; column: string; code: ReviewCode }
export type ParsedEdit =
  | { ok: true; input: EditInput | ReviewFixInput }
  /** Not an input of this API (malformed, wrong types, over a limit, any extra field): a 400. */
  | { ok: false; bad: true }
  /** Understood, and refused by what it is: removing items is never offered; any other kind is not an edit. */
  | { ok: false; bad: false; messageAr: string };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const exactly = (o: Record<string, unknown>, keys: ReadonlyArray<string>): boolean => Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const name = (v: unknown): v is string => typeof v === "string" && v.length <= EDIT_LIMITS.name;
const value = (v: unknown): v is string => typeof v === "string" && v.length <= EDIT_LIMITS.value;
const BAD: ParsedEdit = { ok: false, bad: true };

/** The edit as the route received it, or why it is not accepted. Strict: every key is named, every type checked, every size limited; an extra field (a price, an id, a recipe) is refused. */
export function parseEditInput(raw: unknown): ParsedEdit {
  if (!isObject(raw) || typeof raw.kind !== "string") return BAD;
  if (raw.kind === "remove_rows" || raw.kind === "delete_rows") return { ok: false, bad: false, messageAr: EDIT_REJECTION_AR.row_removal_not_offered };
  switch (raw.kind) {
    case "rename_column":
      return exactly(raw, ["kind", "sheet", "from", "to"]) && name(raw.sheet) && name(raw.from) && name(raw.to) ? { ok: true, input: { kind: "rename_column", sheet: raw.sheet, from: raw.from, to: raw.to } } : BAD;
    case "add_column":
      return exactly(raw, ["kind", "sheet", "titleAr"]) && name(raw.sheet) && name(raw.titleAr) ? { ok: true, input: { kind: "add_column", sheet: raw.sheet, titleAr: raw.titleAr } } : BAD;
    case "review_fix":
      return exactly(raw, ["kind", "sheet", "column", "code"]) && name(raw.sheet) && name(raw.column) && typeof raw.code === "string" && (REVIEW_CODES as ReadonlyArray<string>).includes(raw.code) ? { ok: true, input: { kind: "review_fix", sheet: raw.sheet, column: raw.column, code: raw.code as ReviewCode } } : BAD;
    case "set_cells": {
      if (!exactly(raw, ["kind", "sheet", "cells"]) || !name(raw.sheet) || !Array.isArray(raw.cells) || raw.cells.length < 1 || raw.cells.length > EDIT_LIMITS.cells) return BAD;
      let chars = 0;
      const cells: Array<{ row: number; column: string; value: string }> = [];
      for (const c of raw.cells) {
        if (!isObject(c) || !exactly(c, ["row", "column", "value"]) || !Number.isInteger(c.row) || !name(c.column) || !value(c.value)) return BAD;
        chars += (c.value as string).length;
        cells.push({ row: c.row as number, column: c.column, value: c.value });
      }
      return chars <= EDIT_LIMITS.totalChars ? { ok: true, input: { kind: "set_cells", sheet: raw.sheet, cells } } : BAD;
    }
    case "add_rows": {
      if (!exactly(raw, ["kind", "sheet", "rows"]) || !name(raw.sheet) || !Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > EDIT_LIMITS.rows) return BAD;
      let chars = 0;
      const rows: Array<{ values: Record<string, string> }> = [];
      for (const r of raw.rows) {
        if (!isObject(r) || !exactly(r, ["values"]) || !isObject(r.values) || Object.keys(r.values).length > EDIT_LIMITS.columns) return BAD;
        const values: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.values)) { if (!name(k) || !value(v)) return BAD; chars += v.length; values[k] = v; }
        rows.push({ values });
      }
      return chars <= EDIT_LIMITS.totalChars ? { ok: true, input: { kind: "add_rows", sheet: raw.sheet, rows } } : BAD;
    }
    default:
      return { ok: false, bad: false, messageAr: EDIT_REJECTION_AR.unknown_edit };
  }
}

// ---------------------------------------------------------------------------------------------------------------- resolving an edit against the version

type Resolved =
  | { kind: "ok"; intent: EditIntent; change: EditChangeView; units: number }
  | { kind: "rejected"; messageAr: string }
  | { kind: "unsupported"; why: "lookup_needed" | "duplicates"; cells?: number };
const rejected = (messageAr: string): Resolved => ({ kind: "rejected", messageAr });
const LOCKED = new Set([ID_HEADER, PARENT_HEADER]);
/** A dry run of the edit engine on the base version: it answers whether the edit is allowed and builds nothing that is kept. */
const dryRun = (base: FileVersion, req: EditRequest): string | null => { const out = applyEditCore(base, req, { createdAt: "1970-01-01T00:00:00.000Z" }); return out.ok ? null : EDIT_REJECTION_AR[out.reason]; };

/** The edit against THIS version: refused by the engine's own rules, unsupported (it needs a lookup), or an intent the worker can carry out with no provider call, with what it changes and its units. */
export function resolveEdit(base: FileVersion, input: EditInput | ReviewFixInput): Resolved {
  const sheet = base.sheets.find((s) => s.nameAr === input.sheet);
  if (!sheet) return rejected(EDIT_REJECTION_AR.unknown_sheet);
  switch (input.kind) {
    case "rename_column": {
      const why = dryRun(base, { kind: "rename_column", sheet: input.sheet, from: input.from, to: input.to });
      if (why) return rejected(why);
      const intent: EditIntent = { kind: "rename_column", sheet: input.sheet, from: input.from, to: input.to.trim() };
      return { kind: "ok", intent, change: { kind: "rename_column", sheet: input.sheet, from: input.from, to: input.to.trim() }, units: unitsOfIntent(intent) };
    }
    case "set_cells": {
      const seen = new Set<string>();
      const cells: Array<{ rowId: string; column: string; value: string }> = [];
      for (const c of input.cells) {
        const row = sheet.rows[c.row - 1];
        if (!row) return rejected(EDIT_REJECTION_AR.unknown_row);
        const typed = c.value.trim();
        if (!isRealValue(typed)) return rejected(REQUEST_REJECTION_AR.bad_value);
        const key = `${row.id}|${c.column}`;
        if (seen.has(key)) return rejected(REQUEST_REJECTION_AR.duplicate_cell);
        seen.add(key);
        cells.push({ rowId: row.id, column: c.column, value: typed });
      }
      const why = dryRun(base, { kind: "set_cells", sheet: input.sheet, cells });
      if (why) return rejected(why);
      const intent: EditIntent = { kind: "set_cells", sheet: input.sheet, cells };
      return { kind: "ok", intent, change: { kind: "set_cells", sheet: input.sheet, cells: cells.length, columns: [...new Set(cells.map((c) => c.column))] }, units: unitsOfIntent(intent) };
    }
    case "add_rows": {
      const readable = sheet.headers.filter((h) => !LOCKED.has(h));
      const rows: Array<{ id: string; parentId: null; values: Record<string, string> }> = [];
      for (const [i, r] of input.rows.entries()) {
        for (const k of Object.keys(r.values)) {
          if (LOCKED.has(k)) return rejected(EDIT_REJECTION_AR.locked_column);
          if (!sheet.headers.includes(k)) return rejected(EDIT_REJECTION_AR.unknown_column);
        }
        const values: Record<string, string> = {};
        for (const h of readable) {
          const v = (r.values[h] ?? "").trim();
          if (!isRealValue(v)) return rejected(REQUEST_REJECTION_AR.incomplete_row);
          values[h] = v;
        }
        // the id is made here, never typed: `add_v<new version>_<n>` is unique because each edit makes a new version (a clash with an existing id is refused by the engine below)
        rows.push({ id: `add_v${base.version + 1}_${i + 1}`, parentId: null, values });
      }
      const why = dryRun(base, { kind: "add_rows", sheet: input.sheet, rows });
      if (why) return rejected(why);
      const intent: EditIntent = { kind: "add_rows", sheet: input.sheet, count: rows.length, rows };
      return { kind: "ok", intent, change: { kind: "add_rows", sheet: input.sheet, rows: rows.length }, units: unitsOfIntent(intent) };
    }
    case "add_column": {
      // a bad title, an existing name: said as such. A good one still needs a lookup of every value, which has no recipe and no price yet.
      const why = dryRun(base, { kind: "add_column", sheet: input.sheet, titleAr: input.titleAr, values: {} });
      return why ? rejected(why) : { kind: "unsupported", why: "lookup_needed" };
    }
    case "review_fix": {
      // the issue is recomputed by code from the WHOLE version (the report keeps only the first 20 ids); a duplicate is never fixed because rows are never removed
      const issue = reviewFile(base, { keepRowIds: Number.POSITIVE_INFINITY }).issues.find((i) => i.code === input.code && i.sheet === input.sheet && i.column === input.column);
      if (!issue) return rejected(REQUEST_REJECTION_AR.no_such_issue);
      return issue.code === "exact_duplicate" ? { kind: "unsupported", why: "duplicates" } : { kind: "unsupported", why: "lookup_needed", cells: issue.count };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------- views

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** What a stored intent changes, only for the intents this module makes (typed values, no lookup); null for anything else. */
function changeOfIntent(e: EditIntent): EditChangeView | null {
  if (e.kind === "rename_column") return { kind: "rename_column", sheet: e.sheet, from: e.from, to: e.to };
  if (e.kind === "set_cells") {
    if (!e.cells.every((c) => typeof c.value === "string" && c.value !== "") || e.reread) return null;
    return { kind: "set_cells", sheet: e.sheet, cells: new Set(e.cells.map((c) => `${c.rowId}|${c.column}`)).size, columns: [...new Set(e.cells.map((c) => c.column))] };
  }
  if (e.kind === "add_rows") return Array.isArray(e.rows) && e.rows.length === e.count && e.count >= 1 ? { kind: "add_rows", sheet: e.sheet, rows: e.count } : null;
  return null;
}

/**
 * The view of a waiting edit request, priced AGAIN by the card from its units (never from a stored points field); null for a row that is not a waiting edit of its own identity that this module could have made. A row whose STORED price no longer equals the code's is shown at the code's price,
 * so the customer can cancel it. Only an UNPAID row is shown (waiting, no job, never put through an approval): the page tells the customer that nothing was held, which it cannot say of a row whose approval was attempted and failed.
 */
function viewOf(row: AddonRowLike): EditRequestView | null {
  const addon = readAddonPlan(row.plan);
  if (!addon || addon.kind !== "edit" || !isUnpaidAddonRow(row) || addon.newVersion !== addon.baseVersion + 1) return null;
  const request = addon.request as { kind?: string; edit?: EditIntent };
  if (request.kind !== "edit" || !request.edit) return null;
  const change = changeOfIntent(request.edit);
  const units = unitsOfIntent(request.edit);
  if (!change || units < 1 || units !== addon.pricing.requested || addon.pricing.costPerRowUsd !== 0) return null;
  const card = editCard({ kind: "edit", units, tools: [] });
  return card.ok ? { id: row.id, version: addon.baseVersion, newVersion: addon.baseVersion + 1, change, units, estimatePoints: card.estimatePoints, holdPoints: card.holdPoints, status: "plan_ready" } : null;
}

const requestTextOf = (version: number): string => `طلب تعديل النسخة ${formatAr(version)} من الملف`;

// ---------------------------------------------------------------------------------------------------------------- the schema

export type EditSchemaResult = { ok: true; schema: EditSchemaView } | Failure;

/** The latest published version of the customer's own mission as the editor needs it: the sheets, their editable columns and how many items each has. No item id, no value, no digest, no path. */
export async function editSchemaFor(client: any, input: { missionId: string; userId: string }): Promise<EditSchemaResult> {
  const latest = await latestPublishedNumber(client, input);
  if (!latest.ok) return latest;
  const read = await readPublishedVersion(client, { ...input, version: latest.latest });
  if (!read.ok) return read;
  return { ok: true, schema: { version: read.version.version, sheets: read.version.sheets.map((s) => ({ name: s.nameAr, columns: s.headers.filter((h) => !LOCKED.has(h)), items: s.rows.length })) } };
}

// ---------------------------------------------------------------------------------------------------------------- the quote

export type EditQuoteResult = { ok: true; quote: EditQuoteView } | Failure;

/** What the customer's edit would cost, read-only: the gates (one open request per file, the latest version only), the engine's rules, then the card. No write of any kind. */
export async function editQuoteFor(client: any, input: { missionId: string; userId: string; version: number; edit: Exclude<ParsedEdit, { ok: false; bad: true }> }): Promise<EditQuoteResult> {
  const read = await readPublishedVersion(client, input);
  if (!read.ok) return read;
  let rows: ReadonlyArray<AddonRowLike>;
  try { rows = await createSupabaseAddonRowStore(client, input.userId).listFor(input.missionId); } catch { return no(503, "unavailable"); }
  const kind = input.edit.ok && input.edit.input.kind === "review_fix" ? "review_fix" : "edit";
  const gate = canCreateAddon({ rows, of: input.missionId, kind, baseVersion: input.version, latestVersion: read.latest });
  const version = input.version;
  if (!gate.ok) return { ok: true, quote: { state: gate.reason === "open_addon" ? "blocked" : gate.reason === "not_latest_version" ? "not_latest" : "already_edited", version } };
  if (!input.edit.ok) return { ok: true, quote: { state: "rejected", version, messageAr: input.edit.messageAr } };
  const r = resolveEdit(read.version, input.edit.input);
  if (r.kind === "rejected") return { ok: true, quote: { state: "rejected", version, messageAr: r.messageAr } };
  if (r.kind === "unsupported") return { ok: true, quote: { state: "unsupported", version, why: r.why, ...(r.cells !== undefined ? { cells: r.cells } : {}) } };
  const card = editCard({ kind: "edit", units: r.units, tools: [] });
  if (!card.ok) return { ok: true, quote: card.reason === "too_large" ? { state: "too_large", version } : { state: "rejected", version, messageAr: EDIT_REJECTION_AR.empty_edit } };
  return { ok: true, quote: { state: "offer", version, newVersion: version + 1, change: r.change, units: r.units, estimatePoints: card.estimatePoints, holdPoints: card.holdPoints } };
}

// ---------------------------------------------------------------------------------------------------------------- create, find, cancel

export type CreateEditRequestResult = { ok: true; created: boolean; request: EditRequestView } | Failure;

/** Make the edit request of the customer's own mission: UNPAID (`plan_ready`), priced by the card, one open per file, the deterministic id; a second ask for the very same edit returns the request that already waits (`created: false`). */
export async function createEditRequest(client: any, input: { missionId: string; userId: string; version: number; edit: Extract<ParsedEdit, { ok: true }> | Exclude<ParsedEdit, { ok: true } | { ok: false; bad: true }> }): Promise<CreateEditRequestResult> {
  const read = await readPublishedVersion(client, input);
  if (!read.ok) return read;
  if (!input.edit.ok) return no(409, "rejected", input.edit.messageAr);
  const resolved = resolveEdit(read.version, input.edit.input);
  if (resolved.kind === "rejected") return no(409, "rejected", resolved.messageAr);
  if (resolved.kind === "unsupported") return no(409, "unsupported");
  const card = editCard({ kind: "edit", units: resolved.units, tools: [] });
  if (!card.ok) return card.reason === "too_large" ? no(409, "too_large") : no(409, "rejected", EDIT_REJECTION_AR.empty_edit);
  const store = createSupabaseAddonRowStore(client, input.userId);
  try {
    const made = await createAddonRow(store, { userId: input.userId, of: input.missionId, kind: "edit", baseVersion: input.version, latestVersion: read.latest, request: { kind: "edit", edit: resolved.intent }, pricing: card.pricing, requestText: requestTextOf(input.version) });
    if (made.ok) {
      const view = viewOf({ ...made.row, job_id: null, approved_at: null });
      return view ? { ok: true, created: true, request: view } : no(409, "plan_changed");
    }
    if (made.reason === "open_addon" && made.existingId) {
      // the same click twice: the request that already waits for THIS very edit is the answer, never a second one
      const open = (await store.listFor(input.missionId)).find((r) => r.id === made.existingId);
      const addon = open ? readAddonPlan(open.plan) : null;
      const view = open ? viewOf(open) : null;
      if (view && addon && addon.baseVersion === input.version && canon((addon.request as { edit?: unknown }).edit) === canon(resolved.intent)) return { ok: true, created: false, request: view };
    }
    return no(409, made.reason === "open_addon" || made.reason === "not_latest_version" || made.reason === "already_edited" || made.reason === "too_large" ? made.reason : "plan_changed");
  } catch {
    return no(503, "unavailable");
  }
}

export type CurrentEditRequestResult = { ok: true; request: EditRequestView | null } | Failure;

/** The waiting edit request of the customer's own mission, if one waits (the page finds it again after a refresh). It creates nothing; if it finds MORE THAN ONE open add-on on the file it runs the same repair every creator runs. A waiting review request is not an edit request. */
export async function currentEditRequest(client: any, input: { missionId: string; userId: string }): Promise<CurrentEditRequestResult> {
  try {
    const { data, error } = await client.from(MISSION_TABLE).select("id,user_id").eq("id", input.missionId).maybeSingle();
    if (error) return no(503, "unavailable");
    if (!data || data.user_id !== input.userId) return no(404, "not_found");
    const store = createSupabaseAddonRowStore(client, input.userId);
    let rows = await listWithRecovery(store, input.missionId);
    const open = rows.filter((r) => (OPEN_STATUSES as ReadonlyArray<string>).includes(r.status) && readAddonPlan(r.plan) !== null);
    if (open.length > 1) {
      let stays: AddonRowLike | null;
      try { stays = (await reconcileOpenAddons(store, input.missionId)).keeper; } catch { stays = addonThatStays(open); }
      rows = stays ? [stays] : [];
    }
    const waiting = rows.filter((r) => (OPEN_STATUSES as ReadonlyArray<string>).includes(r.status)).map(viewOf).find((v) => v !== null) ?? null;
    return { ok: true, request: waiting };
  } catch {
    return no(503, "unavailable");
  }
}

export type CancelEditRequestResult = { ok: true } | Failure;

/**
 * Cancel an UNPAID edit request of the customer's own mission. 404 for a request that is not theirs, does not exist, is not an edit, or belongs to another mission (the same answer). 409 `changed` for a request that is not waiting any more (started, finished, already cancelled), that already
 * holds a job, or that was ever put through an approval; the cancel itself is ONE compare-and-set, so a status that changed between the read and the update changes nothing. No refund or settlement function is called.
 */
export async function cancelEditRequest(client: any, input: { missionId: string; userId: string; requestId: string }): Promise<CancelEditRequestResult> {
  try {
    const { data, error } = await client.from(MISSION_TABLE).select("id,user_id,status,job_id,approved_at,plan").eq("id", input.requestId).maybeSingle();
    if (error) return no(503, "unavailable");
    const addon = data && data.user_id === input.userId ? readAddonPlan(data.plan) : null;
    if (!data || !addon || addon.kind !== "edit" || addon.of !== input.missionId) return no(404, "not_found");
    if (data.status !== "plan_ready" || (data.job_id !== null && data.job_id !== undefined) || (data.approved_at !== null && data.approved_at !== undefined)) return no(409, "changed");
    return (await cancelUnpaidAddonRow(client, { id: input.requestId, userId: input.userId })) ? { ok: true } : no(409, "changed");
  } catch {
    return no(503, "unavailable");
  }
}
