import { ADDON_APPROVE_MESSAGES_AR, ADDON_KINDS, addonId, checkAddon, readAddonPlan, type AddonKind, type AddonPlan, type AddonPricing } from "../addonSettlement";
import type { RereadRecipe } from "./reread";
import type { ReviewCode } from "./review";

/**
 * STAGE 4 / MONEY PR 7a, PHASE 2A: THE SHAPE OF AN ADD-ON ROW (docs/MONEY-PR-7A.md section 3.0). A paid review, a review fix or an edit of a delivered file is a row of the existing `missions` table: its `plan` JSON carries
 * `addon: { v, kind, of, baseVersion, newVersion, attempt, request, pricing }` (addonSettlement.ts types and checks it: the money side), created as `plan_ready` (priced by code, never planned by the worker).
 * PURE: no database here. Reading the rows of a mission and inserting the new one go through an injected `AddonRowStore` (the wiring phase gives it a Supabase implementation); tests give it a memory one.
 *
 * THE RULES, in code:
 *   - ONE OPEN ADD-ON PER FILE (decision D10): while an add-on of the mission is not ended and not completed, a second one is refused: the versions stay in a line (v2 from v1, v3 from v2) with no merge.
 *   - AN EDIT OR A FIX IS MADE ON THE LATEST VERSION (a review may read any version), and a version that already has a completed edit or fix is not edited again (that would fork the line).
 *   - A SECOND REVIEW OF THE SAME VERSION IS FREE (decision D11): the stored report is shown; no add-on row is made.
 *   - THE ATTEMPT NUMBER counts EVERY add-on row of the mission and base version (the doc counted only ended ones, which would give a review and a later edit of the same version the same id): a double click computes the same
 *     attempt and therefore the same id, and the primary key refuses the second insert.
 */

/** What the customer asked to change, as data BEFORE anything is re-read (the values come from the run). Removing rows is never offered. */
export type EditIntent =
  /** `reread`: the tools that find the value of each row (the card wrote it; the worker only carries it out). */
  | { kind: "add_column"; sheet: string; titleAr: string; /** The rows to fill (their ids). */ rowIds: ReadonlyArray<string>; reread?: RereadRecipe }
  | { kind: "rename_column"; sheet: string; from: string; to: string }
  /** A cell with a `value` is typed by the customer (no provider call); a cell without one is read through the recipe of its column in `reread`. */
  | { kind: "set_cells"; sheet: string; cells: ReadonlyArray<{ rowId: string; column: string; value?: string }>; reread?: Readonly<Record<string, RereadRecipe>> }
  /** `count` rows; `rows` are the rows the customer typed (their values are theirs: no provider call). */
  | { kind: "add_rows"; sheet: string; count: number; rows?: ReadonlyArray<{ id: string; parentId?: string | null; values: Readonly<Record<string, string>> }> };
export type AddonRequest =
  | { kind: "review" }
  /** A review fix: ONE issue of the review of the base version; its cells are recomputed by code from the whole version (never from the report's first 20 ids). `reread`: the recipe of the issue's column. */
  | { kind: "review_fix"; issue: { code: ReviewCode; sheet: string; column: string }; reread?: RereadRecipe }
  | { kind: "edit"; edit: EditIntent };

export const OPEN_STATUSES = ["queued", "planning", "needs_input", "plan_ready", "approved", "executing"] as const;
export const ENDED_STATUSES = ["cancelled", "failed", "unserved"] as const;

export interface AddonRowLike { id: string; status: string; plan: unknown }
/** What a row of `missions` needs to be inserted (the table's own defaults fill the rest). */
export interface AddonRowInsert { id: string; user_id: string; request_text: string; status: "plan_ready"; plan: { addon: AddonPlan } }
export interface AddonRowStore {
  /** Every add-on row (any status) of this delivered mission. */
  listFor(missionId: string): Promise<ReadonlyArray<AddonRowLike>>;
  /** Insert one row. `duplicate: true` = the id already exists (another click got there first). */
  insert(row: AddonRowInsert): Promise<{ ok: true } | { ok: false; duplicate: boolean }>;
  /**
   * Cancel an UNPAID add-on row: ONE compare-and-set that matches only a row that is still `plan_ready` and has no job (nothing held). `true` = this call cancelled it; `false` = it matched nothing (the row is gone, or no longer waiting).
   * It never touches a started row and calls no refund or settlement function: a waiting row holds nothing.
   */
  cancelUnpaid(id: string): Promise<boolean>;
}

export const isAddonRow = (row: { plan?: unknown } | null | undefined): boolean => readAddonPlan(row?.plan) !== null;

const addonsOf = (rows: ReadonlyArray<AddonRowLike>, of: string): Array<{ row: AddonRowLike; addon: AddonPlan }> =>
  rows.flatMap((row) => { const addon = readAddonPlan(row.plan); return addon && addon.of === of ? [{ row, addon }] : []; });

/** The attempt number of the next add-on on this base version: 1 + every add-on row the mission already has on it (any kind, any status). */
export function nextAttempt(rows: ReadonlyArray<AddonRowLike>, of: string, baseVersion: number): number {
  return 1 + addonsOf(rows, of).filter(({ addon }) => addon.baseVersion === baseVersion).length;
}

export const ADDON_CREATE_REFUSALS_AR = {
  open_addon: "لديك طلب مفتوح على هذا الملف؛ أكمله أو ألغه أولًا.",
  not_latest_version: "اطلب التعديل على أحدث نسخة من الملف.",
  already_edited: "عُدّلت هذه النسخة من قبل؛ اطلب التعديل على النسخة الأحدث.",
  review_exists: "راجعنا هذه النسخة من قبل؛ هذا تقريرها بلا مقابل.",
  too_large: ADDON_APPROVE_MESSAGES_AR.too_large,
  plan_changed: ADDON_APPROVE_MESSAGES_AR.plan_changed,
  bad_request: "تعذّر فهم هذا الطلب.",
  row_removal_not_offered: "حذف عناصر من الملف غير متاح. يبقى ملفك كاملًا، ويمكنك طلب عمود أو تصحيح خانة.",
} as const;
export type AddonCreateRefusal = keyof typeof ADDON_CREATE_REFUSALS_AR;

export type CanCreate = { ok: true; attempt: number } | { ok: false; reason: Exclude<AddonCreateRefusal, "too_large" | "plan_changed" | "bad_request" | "row_removal_not_offered">; existingId?: string };

/** May an add-on of this kind be made now on this base version? Pure over the mission's add-on rows. */
export function canCreateAddon(input: { rows: ReadonlyArray<AddonRowLike>; of: string; kind: AddonKind; baseVersion: number; latestVersion: number }): CanCreate {
  const mine = addonsOf(input.rows, input.of);
  const open = mine.find(({ row }) => (OPEN_STATUSES as ReadonlyArray<string>).includes(row.status));
  if (open) return { ok: false, reason: "open_addon", existingId: open.row.id };
  // an edit or a fix goes on the latest version; a review may read any version that exists
  if (input.baseVersion > input.latestVersion || (input.kind !== "review" && input.baseVersion !== input.latestVersion)) return { ok: false, reason: "not_latest_version" };
  const done = mine.filter(({ row, addon }) => row.status === "completed" && addon.baseVersion === input.baseVersion);
  if (input.kind === "review") { const r = done.find(({ addon }) => addon.kind === "review"); if (r) return { ok: false, reason: "review_exists", existingId: r.row.id }; }
  else if (done.some(({ addon }) => addon.kind !== "review")) return { ok: false, reason: "already_edited" };
  return { ok: true, attempt: nextAttempt(input.rows, input.of, input.baseVersion) };
}

/** The row for a priced add-on, ready to insert. The id is the deterministic one. */
export function buildAddonRow(input: { userId: string; of: string; kind: AddonKind; baseVersion: number; attempt: number; request: AddonRequest; pricing: AddonPricing; requestText: string }): AddonRowInsert {
  const text = input.requestText.trim();
  if (text.length < 3 || text.length > 4000) throw new Error("buildAddonRow: the customer's words must be 3 to 4000 characters");
  if (!ADDON_KINDS.includes(input.kind) || input.request.kind !== input.kind) throw new Error("buildAddonRow: the request does not match the kind");
  const addon: AddonPlan = { v: 1, kind: input.kind, of: input.of, baseVersion: input.baseVersion, newVersion: input.kind === "review" ? null : input.baseVersion + 1, attempt: input.attempt, request: input.request, pricing: input.pricing };
  return { id: addonId(input.of, input.baseVersion, input.attempt), user_id: input.userId, request_text: text, status: "plan_ready", plan: { addon } };
}

export type CreateAddonResult =
  | { ok: true; row: AddonRowInsert }
  | { ok: false; reason: AddonCreateRefusal; messageAr: string; existingId?: string };
const refuse = (reason: AddonCreateRefusal, existingId?: string): CreateAddonResult => ({ ok: false, reason, messageAr: ADDON_CREATE_REFUSALS_AR[reason], ...(existingId ? { existingId } : {}) });

/**
 * Make the add-on row of a priced card. NOTHING is held or charged here and no provider is called: a row that is `plan_ready` costs nothing. Refused before any insert when the rules above say so, when the price is
 * over the limit of an add-on, or when the stored price is not what the code computes. A second click computes the same id; the store reports `duplicate`, and the answer is the open add-on (the first click's row).
 */
export async function createAddonRow(store: AddonRowStore, input: { userId: string; of: string; kind: AddonKind; baseVersion: number; latestVersion: number; request: AddonRequest; pricing: AddonPricing; requestText: string }): Promise<CreateAddonResult> {
  if ((input.request as { kind?: unknown }).kind === "remove_rows" || (input.request as { kind?: unknown }).kind === "delete_rows") return refuse("row_removal_not_offered");
  if (input.request.kind !== input.kind) return refuse("bad_request");
  const rows = await store.listFor(input.of);
  const can = canCreateAddon({ rows, of: input.of, kind: input.kind, baseVersion: input.baseVersion, latestVersion: input.latestVersion });
  if (!can.ok) return refuse(can.reason, can.existingId);
  const row = buildAddonRow({ ...input, attempt: can.attempt });
  const check = checkAddon(row.id, row.plan.addon);
  if (!check.ok) return refuse(check.code === "too_large" ? "too_large" : "plan_changed");
  const inserted = await store.insert(row);
  if (!inserted.ok) {
    // the primary key refused: the same click twice. The first click's row is the answer.
    if (inserted.duplicate) return refuse("open_addon", row.id);
    throw new Error("createAddonRow: the row could not be stored");
  }
  return settleCreation(store, input.of, row);
}

const isOpen = (r: AddonRowLike): boolean => (OPEN_STATUSES as ReadonlyArray<string>).includes(r.status);

/**
 * TWO CREATORS AT THE SAME TIME (docs/MONEY-PR-7A.md section 16.2). `canCreateAddon` is a read followed by an insert, and the primary key only stops two requests with the SAME id (the same version and attempt). A review of version 1 and a review of version 2
 * made from two tabs at the same moment have different ids: both read «nothing is open», both insert, and two open add-ons exist on one file (decision D10 broken). No migration is needed to close this: AFTER its insert the creator reads the open add-ons again.
 * If more than one is open, ONE of them stays: a started row first (it cannot be cancelled), then the lowest id (a rule every creator computes the same way). Every other row is cancelled by `cancelUnpaid` (a compare-and-set that matches only an unpaid `plan_ready` row),
 * and a creator whose own row did not stay is told «open add-on» with the id of the one that did. Whoever commits LAST always sees all the rows, so at the end exactly one is open, in every interleaving (tests/money7a-row-race.test.ts runs them all).
 * Nothing is held at this stage, so a request cancelled here cost nothing; and a creator that read «only mine» before the other inserted was already told yes: its row is the one cancelled, and the page shows the one that stays.
 */
async function settleCreation(store: AddonRowStore, of: string, mine: AddonRowInsert): Promise<CreateAddonResult> {
  const open = addonsOf(await store.listFor(of), of).map(({ row }) => row).filter(isOpen);
  if (open.length <= 1) return open.length === 1 && open[0].id === mine.id ? { ok: true, row: mine } : refuse("open_addon", open[0]?.id);
  const rank = (r: AddonRowLike): number => (r.status === "plan_ready" ? 1 : 0);
  const keeper = [...open].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  for (const r of open) if (r.id !== keeper.id) await store.cancelUnpaid(r.id);
  return keeper.id === mine.id ? { ok: true, row: mine } : refuse("open_addon", keeper.id);
}
