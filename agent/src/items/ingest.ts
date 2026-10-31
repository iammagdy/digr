import { classifyRowDetailed, type RelevanceReason, type RuleBasis } from "../../../src/lib/agentMission/relevance";
import { CONTACT_KINDS, isContactSource, verifyContactValue } from "../../../src/lib/agentMission/contacts";
import { isNamedPerson, isPeopleStage, personVerdict } from "../../../src/lib/agentMission/people";
import type { PricedPlan } from "../../../src/lib/agentMission/plan";
import { dedupeScope, deriveItemId, isTextItemStage, textDedupeKey, textKeyOf } from "../../../src/lib/agentMission/contract";
import { placeCellsAr } from "../../../src/lib/agentMission/places";
import { nameKeysOf, withCleanName, withRealName } from "../../../src/lib/agentMission/companyNames";
import { entityDoubt, type DoubtInput } from "../../../src/lib/agentMission/entityDoubts";
import { namedSourceOf, SOURCE_KEY } from "../../../src/lib/agentMission/namedSources";
import { looksLikeDateColumn, parseMoment } from "../../../src/lib/agentMission/dateCells";
import { APPROX_DATES_KEY, approxDayOf, derivedRelativeDay, parseRelativeAge } from "../../../src/lib/agentMission/relativeDates";
import { CHILD_RAW_FILTER_KINDS, filterVerdict, governmentUnclear, isEnabled } from "../../../src/lib/agentMission/filters";
import type { MissionEventInput } from "../types";
import type { Reviewer } from "../review";
import type { ItemReason, ItemStore, Op, Row, StageCounts } from "./itemStore";

type Stage = PricedPlan["stages"][number];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Items the review could not reach (the budget, a failed call): never thrown away, asked again. */
export const PENDING_ITEM_REASONS: ReadonlyArray<ItemReason> = ["not_reviewed", "review_failed"];

export interface IngestDeps {
  items: ItemStore;
  plan: PricedPlan;
  reviewer?: Reviewer;
  addEvent: (event: MissionEventInput) => Promise<void>;
}

/** What one page of a source adds to the log together with its items (one segment, so the cursor and the items can never disagree after a crash). */
export interface PageRecord { stream: string; call_id: string | null; cursor_in: string | null; cursor_next: string | null; has_more: boolean | null; ended: boolean; rows_in_page: number; /** The oldest moment among the page's rows (a stage read in date windows). */ oldest_ms?: number }

export interface IngestOptions {
  page?: PageRecord;
  /** Keep a progress event out of this call (the engine writes its own, once per page). Default: the event is written. */
  silent?: boolean;
  /** The most items this batch may ADD to the stage (a parent's share: «five comments per post»): a match beyond it is kept, never delivered, like a match beyond the volume bought. */
  acceptCap?: number;
  /** The engine's items are keyed by code: their own `id`, else this field (the recipe's `id_field`; null: a known key field or the fingerprint). Absent (the model's save_rows): an item without an `id` is refused. */
  idField?: string | null;
  /** «Now» for a period counted in days (tests pass a fixed moment). */
  now?: number;
  /** A stage whose customer named SEVERAL sources: every item is marked with the named source it belongs to (read from `fields`), and no source takes more than `perValue` items (an item beyond it is kept, never delivered, like a match beyond the volume bought). */
  sourceQuota?: { fields: string[]; values: string[]; perValue: number; /** The stream reads ONE named source's own listing: an item that names no author belongs to it (and its author cell, when empty, says so). */ defaultSource?: string };
}

export interface IngestResult extends Record<string, unknown> {
  ok: true;
  stage: string;
  counts: StageCounts;
  newlyAccepted: number;
}

/**
 * THE CHECK AND SAVE OF THE ITEMS OF ONE STAGE (the only way an item enters the store, for the engine and for the model's save_rows alike). One batch is one atomic step: the items are de-duplicated against the store, checked
 * (the rule decides every item it can; the model reviews only what the rule cannot decide, within the review budget; an item the review could not reach stays PENDING and is asked again), and the verdicts are appended to the
 * log as ONE segment together with the page that gave them. The batch cannot lose, double count or half-save an item: if the segment is not stored the batch did not happen, and the same items come again.
 */
export async function ingestRows(deps: IngestDeps, stage: Stage, incoming: unknown[], options: IngestOptions = {}): Promise<IngestResult> {
  return deps.items.exclusive(() => ingestLocked(deps, stage, incoming, options));
}

async function ingestLocked(deps: IngestDeps, stage: Stage, incoming: unknown[], options: IngestOptions): Promise<IngestResult> {
  const { items, plan, reviewer } = deps;
  const key = stage.key;
  // THE ITEMS OF A CHILD STAGE (the comments of a post, the reviews of a place, the employees of a company) ARE DELIVERED AS THE SOURCE GIVES THEM: no topic check, no language check, no place check and no text de-duplication (two people who wrote the same
  // comment wrote two comments); only the same item id is one item. The relevance and the language rules choose the PARENTS and the top-level items.
  const isChild = stage.parent_key !== null;
  const spec = isChild ? null : stage.relevance ?? null;
  const before = items.counts(key);
  const room = Math.max(0, stage.planned_rows - before.accepted);
  const columnKeys = stage.columns.map((c) => c.key);
  const contactColumns = stage.columns.filter((c) => c.kind !== undefined && CONTACT_KINDS.includes(c.kind));
  const contactStage = isContactSource(stage.endpoint_id);
  const peopleStage = isPeopleStage(stage);
  const parentIds = stage.parent_key !== null ? new Set(items.acceptedIds(stage.parent_key)) : null;
  const tally = { saved_now: 0, duplicates_ignored: 0, duplicate_texts: 0, rejected_missing_id: 0, rejected_unknown_parent: 0, rejected_over_limit: 0, rejected_not_object: 0, rejected_no_verified_contact: 0, rejected_not_a_person: 0, rejected_by_filter: 0, contact_values_left_empty: 0 };
  const enabledFilters = (stage.filters ?? []).filter(isEnabled).filter((f) => !(isChild && CHILD_RAW_FILTER_KINDS.includes(f.kind)));
  const now = options.now ?? Date.now();
  const placeFilter = enabledFilters.find((f) => f.kind === "place" && f.places && f.places.length > 0);
  const promisedPlace = placeFilter ? { places: placeFilter.places!, fields: placeFilter.fields ?? (placeFilter.field ? [placeFilter.field] : []) } : null;
  // THE SAME TEXT TWICE (a post or a comment): the first is kept, the rest are counted as duplicates. A text of a child stage is unique among the items of its own parent.
  const dedupeText = isTextItemStage(stage) && !isChild;
  const seenTexts = new Set<string>();
  if (dedupeText) {
    const dedupeKey = textKeyOf(stage);
    if (dedupeKey) for (const it of items.stage(key).items.values()) { const k = it.row ? textDedupeKey(it.row[dedupeKey]) : null; if (k) seenTexts.add(`${dedupeScope(it.row?.parent_id === undefined ? null : String(it.row.parent_id))}|${k}`); }
  }
  // the share of every named source applies to everything that is accepted for the stage, a page read by the engine or a waiting item decided later (a stage with a recipe per source: no source takes more than its share)
  const account = (stage.filters ?? []).find((f) => f.kind === "account" && isEnabled(f) && (f.values ?? []).length > 0);
  const quota = options.sourceQuota ?? (stage.engine?.sources && stage.engine.sources.length > 0 && account ? { fields: [account.field, ...(account.fields ?? [])].filter((k): k is string => typeof k === "string"), values: account.values ?? [], perValue: Math.max(1, Math.ceil(stage.planned_rows / Math.max(1, (account.values ?? []).length))) } : undefined);
  const quotaHave = new Map<string, number>();
  if (quota) for (const r of items.acceptedRows(key)) { const v = r[SOURCE_KEY]; if (typeof v === "string") quotaHave.set(v, (quotaHave.get(v) ?? 0) + 1); }
  const ops: Op[] = [];

  // items that were waiting (a review the budget or a failure delayed) or never looked at come back first, while matching items are still needed
  const carry: Array<{ id: string; row: Row }> = [];
  if (spec && reviewer && spec.review !== false && room > 0) {
    for (const it of [...items.pendingItems(key), ...items.uncheckedItems(key)]) if (it.row) carry.push({ id: it.id, row: it.row });
  }

  // pass 1: the structure of every incoming item (id, duplicate, parent, columns, contact values)
  const fresh: Array<Record<string, unknown>> = [];
  const seenNow = new Set<string>();
  let duplicates = 0;
  const excludedStructural: Array<{ id: string; reason: ItemReason; row: Row }> = [];
  const govUnclear = new Set<string>();
  // A COMPANY ROW WHOSE OWN TEXT CONTRADICTS WHAT THE CARD PROMISES (a broken spreadsheet line as a name, a head office abroad, a law firm, a news site, a trade show) goes to the model check even when the sector rule accepts it (entityDoubts.ts)
  const doubtInput: DoubtInput | null = spec?.entity ? { nameKeys: nameKeysOf(stage.columns), descriptionKeys: (spec.text_columns ?? []).filter((k) => /desc|about|summary|bio|overview|نبذ|وصف/i.test(`${k} ${stage.columns.find((c) => c.key === k)?.title_ar ?? ""}`)), wantedPlaces: promisedPlace?.places ?? [] } : null;
  const doubts = new Map<string, string>();
  for (const raw0 of incoming) {
    if (!isObject(raw0)) { tally.rejected_not_object += 1; continue; }
    // a name that is only a web address is replaced by another name field of the same item (never invented); the id is derived from the item as the source gave it
    const named = isChild ? { item: raw0, debris: false } : withCleanName(withRealName(raw0, stage.columns), stage.columns);
    const raw = named.item;
    // an item always has an id: its own, the field the recipe chose, a known key field (a platform id, the link), or its fingerprint: the same item read twice is the same id (never rejected for lacking one)
    // (the engine passes the recipe's `idField`, so its items are keyed this way; the model's own save_rows has no such field and keeps refusing an item without an id, which it was told to give)
    const id = options.idField !== undefined ? deriveItemId(raw0, options.idField, parentIds ? String(raw0.parent_id ?? "").trim() || null : null) : String(raw0.id ?? "").trim();
    if (!id) { tally.rejected_missing_id += 1; continue; }
    if (items.has(key, id) || seenNow.has(id)) { duplicates += 1; tally.duplicates_ignored += 1; continue; }
    let parentId: string | null = null;
    if (parentIds) {
      parentId = String(raw.parent_id ?? "").trim();
      // an item of a parent that is not saved (yet) is NOT remembered: it may come again once its parent is saved
      if (!parentId || !parentIds.has(parentId)) { tally.rejected_unknown_parent += 1; continue; }
    }
    if (dedupeText) {
      const textField = textKeyOf(stage, Object.keys(raw));
      const k = textField ? textDedupeKey(raw[textField]) : null;
      if (k) {
        const scoped = `${dedupeScope(parentId)}|${k}`;
        if (seenTexts.has(scoped)) { duplicates += 1; tally.duplicates_ignored += 1; tally.duplicate_texts += 1; continue; }
        seenTexts.add(scoped);
      }
    }
    seenNow.add(id);
    const row: Row = { id, ...(parentId !== null ? { parent_id: parentId } : {}) };
    for (const k of columnKeys) if (k !== "id" && k !== "parent_id") row[k] = raw[k] ?? "";
    // THE PLACE CELLS in Arabic («al qahirah» → «القاهرة»); never empty when the card promised the place
    if (!isChild) placeCellsAr(row, stage.columns, raw, promisedPlace);
    // WHAT THE CARD PROMISES, checked here on the mapped item (replies, language, period, account, place): an item a filter rejects is neither delivered nor charged, and is kept with its reason
    if (enabledFilters.length > 0) {
      const why = filterVerdict(enabledFilters, raw, { textKey: textKeyOf(stage, Object.keys(raw)), now, ...(quota?.defaultSource ? { listing: true } : {}) });
      if (why) { tally.rejected_by_filter += 1; excludedStructural.push({ id, reason: why, row }); continue; }
      if (governmentUnclear(enabledFilters, raw)) govUnclear.add(id);
    }
    const doubt = doubtInput ? (named.debris ? "name_debris" : entityDoubt(raw, doubtInput)) : null;
    if (doubt) { doubts.set(id, doubt); row._doubt = doubt; }
    // THE NAMED SOURCE the item belongs to (a stage naming several): marked on the item, so each source can be held to its own share
    if (quota) {
      const src = namedSourceOf(quota.values, quota.fields, raw) ?? (quota.defaultSource && !quota.fields.some((f) => (typeof raw[f] === "string" || typeof raw[f] === "number") && String(raw[f]).trim()) ? quota.defaultSource : null);
      if (src) {
        row[SOURCE_KEY] = src;
        // the listing of a named source gives no author: the author cell of the file says whose item it is (the name of the source that was asked for, never invented)
        if (quota.defaultSource === src) for (const f of quota.fields) if (columnKeys.includes(f) && !String(row[f] ?? "").trim()) row[f] = src;
      }
    }
    // A DATE THE SOURCE GIVES ONLY AS A RELATIVE TIME («قبل ٤ أيام», «4 days ago») is written as the approximate day it stands for (from the moment the item was read) and the item is marked, so the file says the date is approximate (relativeDates.ts)
    const approxColumns: string[] = [];
    for (const c of stage.columns) {
      if (!looksLikeDateColumn(c.title_ar, c.key)) continue;
      if (parseMoment(row[c.key]) !== null) {
        // A DATE THE SOURCE COMPUTED ITSELF from a relative text it also gives («6 years ago» beside a `publishedTime` of the minute of the call minus six years) is not an exact moment: it is written as the approximate day it stands for (a real timestamp is untouched)
        for (const [field, text] of Object.entries(raw)) {
          if (field === c.key || typeof text !== "string") continue;
          const day = derivedRelativeDay(row[c.key], text, now);
          if (day !== null) { row[c.key] = day; approxColumns.push(c.key); break; }
        }
        continue;
      }
      const age = parseRelativeAge(row[c.key], now);
      if (age) { row[c.key] = approxDayOf(age); approxColumns.push(c.key); }
    }
    if (approxColumns.length > 0) row[APPROX_DATES_KEY] = approxColumns;
    // CONTACT FIELDS are verified by code: a work e-mail or phone that does not pass is left empty (the CELL). Verification never decides whether a PERSON is delivered: a row that carries a real person's name (people.ts) is delivered with
    // its unverified cells empty (live re-test 2026-10-31, A1 and A2: 31 and 32 named people with job titles were thrown away because the source gave no e-mail or phone). Only a row of a contact source that is NOT a named person (an
    // e-mail finder's row is its address) and has no verified value has nothing to deliver, so it is not delivered (and not charged).
    let verifiedAny = false;
    for (const c of contactColumns) {
      const original = String(raw[c.key] ?? "").trim();
      const verified = verifyContactValue(c.kind!, raw[c.key]);
      row[c.key] = verified ?? "";
      if (verified) verifiedAny = true; else if (original) tally.contact_values_left_empty += 1;
    }
    if (contactStage && contactColumns.length > 0 && !verifiedAny && !isNamedPerson(raw, stage.columns)) { tally.rejected_no_verified_contact += 1; excludedStructural.push({ id, reason: "no_verified_contact", row }); continue; }
    // A PERSON ROW MUST BE A PERSON (people.ts): a row of a people stage with no person's name, or whose address is a role or generic mailbox (info@, customer_care@, webmaster@), is a COMPANY e-mail. It is kept with its reason and its address (the company's sheet
    // shows it), and it is not a decision maker, not counted and not charged.
    if (peopleStage && !personVerdict(raw, stage.columns).person) { tally.rejected_not_a_person += 1; excludedStructural.push({ id, reason: "not_a_person", row }); continue; }
    fresh.push(row);
  }
  for (const e of excludedStructural) ops.push({ t: "item", stage: key, id: e.id, state: "excluded", reason: e.reason, row: e.row });

  // pass 2: RELEVANCE. Only items that are about what the customer asked are saved (so only they are delivered and charged).
  type Candidate = { id: string; row: Row; carried: boolean };
  const candidates: Candidate[] = [...carry.filter((c) => !fresh.some((f) => String(f.id) === c.id)).map((c) => ({ id: c.id, row: c.row, carried: true })), ...fresh.map((row) => ({ id: String(row.id), row, carried: false }))];
  const outcome = new Map<string, { state: "accepted" | "excluded" | "pending"; by?: "rule" | "model"; basis?: RuleBasis; reason?: RelevanceReason }>();
  let reviewedNow = 0;
  let reviewStop: "budget" | "failed" | null = null;
  const left: Record<string, number> = {};
  if (spec) {
    // a company that MAY be a public body (a research institute, a university, «national»: government.ts) goes to the model check even when the rule would accept it; the model is told the customer wants no government bodies
    // THE CUSTOMER NAMED THE SOURCE (a channel, a page, an account): an item that passed the source filter is from it, so «the text names none of the topic's words» is not enough to throw it away (a video title in English about an Arabic topic, a
    // post in another dialect): the model judges the topic only, in the item's own language
    const namedSource = enabledFilters.some((f) => f.kind === "account");
    const verdicts = candidates.map((c) => { const v0 = classifyRowDetailed(spec, c.row); const v = namedSource && v0.verdict === "exclude" && v0.reason === "no_term" ? ({ verdict: "review", reason: "uncertain" } as const) : v0; return { c, v: v.verdict === "match" && (govUnclear.has(c.id) || doubts.has(c.id) || (c.carried && (governmentUnclear(stage.filters, c.row) || typeof c.row._doubt === "string"))) ? ({ verdict: "review", reason: "uncertain" } as const) : v }; });
    const matches = verdicts.filter((x) => x.v.verdict === "match").length;
    const uncertain = verdicts.filter((x) => x.v.verdict === "review");
    let verdictOf = new Map<string, boolean>();
    if (uncertain.length > 0 && spec.review !== false && reviewer && matches < room) {
      // no more review than the room left can use (an item beyond the approved volume is never needed); the rest stays pending
      const wanted = uncertain.slice(0, (room - matches) * 3 + 25);
      const governmentAsked = (stage.filters ?? []).some((f) => f.kind === "exclude_government" && isEnabled(f));
      // a company stage with a promised place: the model check is told the company must really be of that kind and place (a head office abroad, a law firm, a news site, a trade show is not)
      const placeWords = spec.entity && placeFilter ? (placeFilter.values ?? []).join("، ") : "";
      const subject = `${spec.subject_ar}${governmentAsked ? " (ليست جهة حكومية أو عسكرية ولا مركز أبحاث أو معهدًا حكوميًا)" : ""}${placeWords ? ` (شركة حقيقية من هذا النوع مقرها أو نشاطها في ${placeWords}؛ وليست حدثًا أو معرضًا أو مكتب محاماة أو موقعًا إخباريًا أو منتدى أو شركة مقرها في بلد آخر)` : ""}`;
      verdictOf = await reviewer.review({ subject, rows: wanted.map((x) => ({ id: x.c.id, text: spec.text_columns.map((k) => String(x.c.row[k] ?? "")).join(" ") })) });
      reviewedNow = verdictOf.size;
      reviewStop = (await reviewer.state()).stop;
    }
    for (const { c, v } of verdicts) {
      if (v.verdict === "match") { outcome.set(c.id, { state: "accepted", by: "rule", basis: (v as { basis?: RuleBasis }).basis }); continue; }
      if (v.verdict === "exclude") { outcome.set(c.id, { state: "excluded", reason: v.reason }); continue; }
      if (verdictOf.get(c.id) === true) { outcome.set(c.id, { state: "accepted", by: "model" }); continue; }
      if (verdictOf.has(c.id)) { outcome.set(c.id, { state: "excluded", reason: "review_no" }); continue; }
      if (spec.review === false) { outcome.set(c.id, { state: "excluded", reason: "uncertain" }); continue; }
      // with a reviewer, an item not reviewed (budget, a failed call, more than the room needs) is PENDING: kept and asked again; with none, it is a final exclusion
      const reason: RelevanceReason = !reviewer ? "not_reviewed" : reviewStop === "failed" ? "review_failed" : "not_reviewed";
      outcome.set(c.id, reviewer ? { state: "pending", reason } : { state: "excluded", reason });
    }
  } else for (const c of candidates) outcome.set(c.id, { state: "accepted", by: "rule" });

  // the verdicts, in order, as ops: the volume the customer bought is never exceeded (a match beyond it is kept UNCHECKED, never delivered)
  let acceptedNow = 0;
  let modelAccepted = 0;
  for (const c of candidates) {
    const o = outcome.get(c.id)!;
    let state: "accepted" | "excluded" | "pending" | "unchecked" = o.state;
    let reason: ItemReason | undefined = o.reason;
    // a match beyond the volume the customer bought was checked and is not needed: it is kept (never delivered, never charged) with that reason
    if (state === "accepted" && (before.accepted + acceptedNow >= stage.planned_rows || (options.acceptCap !== undefined && acceptedNow >= options.acceptCap))) { state = "excluded"; reason = "target_reached"; tally.rejected_over_limit += 1; }
    // a named source whose share is full: its match is kept, not delivered (the other sources still have room)
    if (state === "accepted" && quota) {
      const src = c.row[SOURCE_KEY];
      if (typeof src === "string") {
        const have = quotaHave.get(src) ?? 0;
        if (have >= quota.perValue) { state = "excluded"; reason = "target_reached"; tally.rejected_over_limit += 1; } else quotaHave.set(src, have + 1);
      }
    }
    if (state === "accepted") { acceptedNow += 1; if (o.by === "model") modelAccepted += 1; }
    if (state === "excluded" && reason && reason !== "target_reached") left[reason] = (left[reason] ?? 0) + 1;
    if (c.carried) {
      // a carried item is already in the log: only a decision moves it
      if (state === "accepted" || state === "excluded") ops.push({ t: "resolve", stage: key, id: c.id, state, ...(o.by ? { by: o.by } : {}), ...(o.basis ? { basis: o.basis } : {}), ...(reason ? { reason } : {}) });
    } else {
      ops.push({ t: "item", stage: key, id: c.id, state, ...(state === "accepted" && o.by ? { by: o.by } : {}), ...(state === "accepted" && o.basis ? { basis: o.basis } : {}), ...(reason ? { reason } : {}), row: c.row });
    }
  }
  tally.saved_now = acceptedNow;
  if (duplicates > 0) ops.push({ t: "dup", stage: key, n: duplicates });
  if (options.page) ops.push({ t: "page", stage: key, ...options.page });

  await items.commit(ops);
  const counts = items.counts(key);

  // the live panel ticks from this: the numbers are in `counts` (never in the text), written by code from the item store, not by the model
  if (!options.silent && (tally.saved_now > 0 || fresh.length > 0 || options.page)) {
    await deps.addEvent({ kind: "progress", message_ar: `يحفظ الوكيل ما جمعه لمرحلة «${stage.title_ar}»`, counts: stageEventCounts(plan, key, counts) });
  }
  const stillNeeded = Math.max(0, stage.planned_rows - counts.accepted);
  return {
    ok: true, stage: key, ...tally, counts, newlyAccepted: acceptedNow, total_in_stage: counts.accepted, stage_limit: stage.planned_rows,
    ...(spec ? {
      left_out_not_matching: left, reviewed_by_model: reviewedNow, review_budget_reached: reviewStop === "budget", review_failed: reviewStop === "failed", pending_for_review: counts.pending,
      accepted_by_rule: acceptedNow - modelAccepted,
      still_needed: stillNeeded,
      note: stillNeeded > 0 ? "only rows that MATCH the request are saved, delivered and charged; still_needed matching rows are missing: collect further pages (the source may have more) until still_needed is 0, the source ends, or the budget refuses; then finish and say honestly how many matched" : "the stage has all the matching rows it was sold",
    } : {}),
  };
}

/**
 * ASKS THE PENDING ITEMS OF A STAGE AGAIN until none is left, the volume bought is reached, or a round makes no progress (the review budget is spent, the model could not be reached). An item the review could not reach is never
 * thrown away and a mission never ends while items wait and the review still has budget.
 */
export async function drainPending(deps: IngestDeps, stage: Stage): Promise<void> {
  if (!stage.relevance || !deps.reviewer) return;
  for (let round = 0; round < 40; round += 1) {
    const before = deps.items.counts(stage.key);
    if (before.pending === 0 || before.accepted >= stage.planned_rows) return;
    await ingestRows(deps, stage, [], { silent: round > 0 });
    const after = deps.items.counts(stage.key);
    if (after.pending >= before.pending && after.accepted === before.accepted) return;
  }
}

/** The counts of the «saved» event of the live panel, every number read from the item store: the stage, what is saved, the volume bought and (for a stage with a relevance rule) what was checked, accepted, left out and is waiting. */
export function stageEventCounts(plan: PricedPlan, stageKey: string, c: StageCounts): Record<string, number> {
  const stage = plan.stages.find((s) => s.key === stageKey)!;
  return {
    stage: plan.stages.indexOf(stage) + 1, saved: c.saved, planned: stage.planned_rows,
    ...(stage.relevance ? { checked: c.checked, accepted: c.accepted, excluded: c.excludedRelevance, pending: c.pending } : {}),
  };
}

/** The two lines of the live panel after a batch: the source read so far (pages, items found: only ever growing) and what is saved. */
export async function emitStageProgress(deps: Pick<IngestDeps, "plan" | "addEvent" | "items">, stage: Stage, options: { collecting: boolean }): Promise<void> {
  const c = deps.items.counts(stage.key);
  if (options.collecting && c.pages > 0) await deps.addEvent({ kind: "progress", message_ar: "يجمع الوكيل الصفحات من المصدر صفحة بعد صفحة", counts: { pages: c.pages, rows: c.found, planned: stage.planned_rows } });
  await deps.addEvent({ kind: "progress", message_ar: `يحفظ الوكيل ما جمعه لمرحلة «${stage.title_ar}»`, counts: stageEventCounts(deps.plan, stage.key, c) });
}
