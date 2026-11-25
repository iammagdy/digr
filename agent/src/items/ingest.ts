import { createHash } from "node:crypto";
import { CONTACT_STATUS_UNVERIFIED_AR, SOURCE_PROFILE_KEY, statusKeyOf } from "../../../src/lib/agentMission/contactFinders";
import { TOPIC_RELATION_KEY, topicRelationAr } from "../../../src/lib/agentMission/foundation/topicChoice";
import { classifyRowDetailed, type RelevanceReason, type RuleBasis } from "../../../src/lib/agentMission/relevance";
import { CONTACT_KINDS, isContactSource, verifyContactValue } from "../../../src/lib/agentMission/contacts";
import { contactShape, phoneShape } from "../../../src/lib/agentMission/contactShape";
import { isNamedPerson, isPeopleStage, personVerdict } from "../../../src/lib/agentMission/people";
import type { PricedPlan } from "../../../src/lib/agentMission/plan";
import { canonicalUrlKey, dedupeScope, deriveItemId, isTextItemStage, textDedupeKey, textKeyOf, titleDedupeKey, ROW_KEY_FIELDS } from "../../../src/lib/agentMission/contract";
import { placeCellsAr } from "../../../src/lib/agentMission/places";
import { nameKeysOf, withCleanName, withRealName, withTidyNames } from "../../../src/lib/agentMission/companyNames";
import { entityDoubt, type DoubtInput } from "../../../src/lib/agentMission/entityDoubts";
import { namedSourceOf, SOURCE_KEY } from "../../../src/lib/agentMission/namedSources";
import { looksLikeDateColumn, parseMoment } from "../../../src/lib/agentMission/dateCells";
import { APPROX_DATES_KEY, DATE_UNREAD_KEY, approxColumnsOf, approxDayOf, approxDayOfMs, derivedRelativeDay, parseRelativeAge } from "../../../src/lib/agentMission/relativeDates";
import { CHILD_RAW_FILTER_KINDS, filterVerdict, governmentUnclear, isEnabled } from "../../../src/lib/agentMission/filters";
import { MARKS_KEY, markVerdict } from "../../../src/lib/agentMission/rawMarks";
import type { MissionEventInput } from "../types";
import { formatJudgeRowText, type Reviewer } from "../review";
import type { ItemReason, ItemStore, Op, Row, StageCounts } from "./itemStore";
import { AcceptedCompanies, COMPANY_BRANCH_FIELDS, COMPANY_EVIDENCE_KEY, COMPANY_SOURCE_ID_KEY, COMPANY_UNCERTAIN_KEY, companyEvidenceOf, companyRelationship, storedCompanyEvidence } from "../../../src/lib/agentMission/companyQuality";
import { isCompanyStage } from "../../../src/lib/agentMission/entities";
import { PRIOR_DELIVERY_REASON, type PriorDeliveryMatcher } from "../../../src/lib/agentMission/priorDelivery";
import { CUSTOMER_EXCLUSION_REASON, EXCLUSION_POSSIBLE_MARK, organisationOfRow, type ExclusionMatcher } from "../../../src/lib/agentMission/customerExclusion";
import { loadTregCatalog } from "../../../src/lib/treg/catalog";

type Stage = PricedPlan["stages"][number];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The engine marks a mapped person row with this when the source's own experiences say the person does not work at the parent company now (not a column: ingest reads it and drops it). */
export const NOT_AT_COMPANY_MARK = "__not_at_company";

/** Items the review could not reach (the budget, a failed call): never thrown away, asked again. */
export const PENDING_ITEM_REASONS: ReadonlyArray<ItemReason> = ["not_reviewed", "review_failed"];

export interface IngestDeps {
  items: ItemStore;
  plan: PricedPlan;
  reviewer?: Reviewer;
  addEvent: (event: MissionEventInput) => Promise<void>;
  /**
   * PHASE 5.3: the customer's exclusion list of the APPROVED plan (`plan.customer_exclusion`), loaded from the mission's private copy and checked against the plan's digest. Required whenever the plan carries a mark that applies:
   * a company or people stage is never ingested without it (the batch throws, nothing is saved). Absent with no mark: today's behaviour exactly.
   */
  exclusion?: ExclusionMatcher;
  /**
   * P0 (15 Nov 2026): the items earlier missions of this conversation delivered (the APPROVED plan's `prior_delivery`, loaded from the mission's private copy with its digest). Required whenever the plan carries a mark with items:
   * a top-level stage is never ingested without it (fail closed). A matching row is never delivered, counted or charged (reason `already_delivered`).
   */
  priorDelivered?: PriorDeliveryMatcher;
}

/**
 * PHASE 5.3: the stages the customer's exclusion list is checked on, and how a row names its organisation: a top-level COMPANY stage (the row is the company) or a top-level PEOPLE stage (a people search: the row's employer
 * fields). A child stage is not checked (its parent was); any other stage (posts, comments, places) is not an organisation list. A people stage is told by the same rules as a child people stage (role preference, a people
 * capability, a people noun in the title) or by a people-search endpoint.
 */
const PEOPLE_SEARCH_ENDPOINT = /(?:^|\.)people\.(?:search|find|list)|\.employees\b/i;
export function exclusionStageKind(stage: Stage): "company" | "people" | null {
  if (stage.parent_key !== null) return null;
  if (isPeopleStage({ ...stage, parent_key: "__top" }) || PEOPLE_SEARCH_ENDPOINT.test(String(stage.endpoint_id ?? ""))) return "people";
  return isCompanyStage(stage) ? "company" : null;
}
export const exclusionAppliesToStage = (stage: Stage): boolean => exclusionStageKind(stage) !== null;

/** What one page of a source adds to the log together with its items (one segment, so the cursor and the items can never disagree after a crash). */
export interface PageRecord { stream: string; call_id: string | null; cursor_in: string | null; cursor_next: string | null; has_more: boolean | null; ended: boolean; rows_in_page: number; /** The oldest moment among the page's rows (a stage read in date windows). */ oldest_ms?: number }

export interface IngestOptions {
  page?: PageRecord;
  targetRows?: number;
  /** Keep a progress event out of this call (the engine writes its own, once per page). Default: the event is written. */
  silent?: boolean;
  /** The most items this batch may ADD to the stage (a parent's share: «five comments per post»): a match beyond it is kept, never delivered, like a match beyond the volume bought. */
  acceptCap?: number;
  /** The engine's items are keyed by code: their own `id`, else this field (the recipe's `id_field`; null: a known key field or the fingerprint). Absent (the model's save_rows): an item without an `id` is refused. */
  idField?: string | null;
  /** «Now» for a period counted in days (tests pass a fixed moment). */
  now?: number;
  /** A stage whose customer named SEVERAL sources: every item is marked with the named source it belongs to (read from `fields`), and no source takes more than `perValue` items (an item beyond it is kept, never delivered, like a match beyond the volume bought). */
  /** RAW DELIVERY (S1 item 1.1): the stage runs in the redesigned mode (its flag is active and its request was built by code). Only the same id, an unknown parent, the volume bought and a named source's share remove an item; every content rule becomes a mark on the row. Ignored for a people or company stage. Absent: the old checks. */
  raw?: boolean;
  /** PHASE 5 (`multi_stage_engine`, OFF): the source endpoint and the recorded call that gave this batch, written on every saved row as `_src` / `_call` (internal marks: never a column of the file, never part of an item's id). Absent: no mark. */
  provenance?: { src: string; call: string | null };
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
  const rawMode = options.raw === true && !isContactSource(stage.endpoint_id) && !isPeopleStage(stage);
  // P0 (15 Nov 2026, msn_cd5f32adadefb9bb971f): a research topic judged by the model (`judge: "model"`, set by the compiler) gates the plan's own pinned rows too: the rows a planning sample read are delivered and charged only when the
  // execution's review says they are about the request (three rows that only shared a word with the topic were delivered and charged in full)
  const spec = isChild || (rawMode && stage.relevance?.judge !== "model") ? null : stage.relevance ?? null;
  const judgedMark = spec?.judge === "model" && stage.columns.some((c) => c.key === TOPIC_RELATION_KEY);
  const before = items.counts(key);
  const room = Math.max(0, stage.planned_rows - before.accepted);
  const columnKeys = stage.columns.map((c) => c.key);
  const contactColumns = stage.columns.filter((c) => c.kind !== undefined && CONTACT_KINDS.includes(c.kind));
  const contactStage = isContactSource(stage.endpoint_id);
  const peopleStage = isPeopleStage(stage);
  const companyStage = isCompanyStage(stage);
  const companyIndex = new AcceptedCompanies();
  const companyObservations = new Map<string, Row[]>();
  if (companyStage) {
    for (const item of items.stage(key).items.values()) {
      if (!item.row) continue;
      const sourceId = String(item.row[COMPANY_SOURCE_ID_KEY] ?? item.id);
      const sameId = companyObservations.get(sourceId) ?? [];
      sameId.push(item.row);
      companyObservations.set(sourceId, sameId);
      if (item.state === "accepted") companyIndex.add(storedCompanyEvidence(item.row, stage));
    }
  }
  const parentIds = stage.parent_key !== null ? new Set(items.acceptedIds(stage.parent_key)) : null;
  const tally = { saved_now: 0, duplicates_ignored: 0, duplicate_texts: 0, rejected_missing_id: 0, rejected_unknown_parent: 0, rejected_over_limit: 0, rejected_not_object: 0, rejected_no_verified_contact: 0, rejected_not_a_person: 0, rejected_not_at_company: 0, rejected_by_filter: 0, contact_values_left_empty: 0 };
  const enabledFilters = (stage.filters ?? []).filter(isEnabled).filter((f) => !(isChild && CHILD_RAW_FILTER_KINDS.includes(f.kind)));
  const now = options.now ?? Date.now();
  const placeFilter = enabledFilters.find((f) => f.kind === "place" && f.places && f.places.length > 0);
  const promisedPlace = placeFilter ? { places: placeFilter.places!, fields: placeFilter.fields ?? (placeFilter.field ? [placeFilter.field] : []) } : null;
  // THE SAME TEXT TWICE (a post or a comment): the first is kept, the rest are counted as duplicates. A text of a child stage is unique among the items of its own parent.
  const dedupeText = isTextItemStage(stage) && !isChild && !rawMode;
  const seenTexts = new Set<string>();
  if (dedupeText) {
    const dedupeKey = textKeyOf(stage);
    if (dedupeKey) for (const it of items.stage(key).items.values()) { const k = it.row ? textDedupeKey(it.row[dedupeKey]) : null; if (k) seenTexts.add(`${dedupeScope(it.row?.parent_id === undefined ? null : String(it.row.parent_id))}|${k}`); }
  }
  // Point 3.5: Canonical platform ID deduplication.
  // Scope: parent_id (for child stages) + branch_id (for branch-scoped root stages).
  // Same platform id under a different parent OR a different branch = a different row.
  const seenPlatformIds = new Set<string>();
  const ep = stage.endpoint_id ? loadTregCatalog().byId.get(stage.endpoint_id) : undefined;
  const contractDedupeKey = ep?.adapter_contract?.dedupe_key;
  const platformIdScope = (row: Record<string, unknown>, parentId: string | null): string => {
    const branchId = row.branch_id !== undefined && row.branch_id !== null && String(row.branch_id).trim() !== ""
      ? String(row.branch_id).trim() : null;
    return `${dedupeScope(parentId)}${branchId ? `|b:${branchId}` : ""}`;
  };
  for (const it of items.stage(key).items.values()) {
    if (!it.row) continue;
    const p = it.row.parent_id === undefined ? null : String(it.row.parent_id);
    const pid = contractDedupeKey && it.row[contractDedupeKey] !== undefined && it.row[contractDedupeKey] !== null
      ? String(it.row[contractDedupeKey]).trim()
      : (it.row.id !== undefined && it.row.id !== null && String(it.row.id).trim() !== "" ? String(it.row.id).trim() : null);
    if (pid) seenPlatformIds.add(`${platformIdScope(it.row, p)}|${pid}`);
  }

  // Structural link and title deduplication: canonical link and normalized title without publisher suffix
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  for (const it of items.stage(key).items.values()) {
    if (!it.row) continue;
    const p = it.row.parent_id === undefined ? null : String(it.row.parent_id);
    const u = canonicalUrlKey(it.row.canonical_url ?? it.row.url ?? it.row.link);
    if (u) seenUrls.add(`${dedupeScope(p)}|${u}`);
    const hasRowId = ROW_KEY_FIELDS.some((k) => k !== "url" && typeof it.row![k] === "string" && (it.row![k] as string).trim() !== "");
    if (!hasRowId && !u) {
      const t = titleDedupeKey(it.row.title ?? it.row.headline);
      if (t) seenTitles.add(`${dedupeScope(p)}|${t}`);
    }
  }
  // the share of every named source applies to everything that is accepted for the stage, a page read by the engine or a waiting item decided later (a stage with a recipe per source: no source takes more than its share)
  const account = (stage.filters ?? []).find((f) => f.kind === "account" && isEnabled(f) && (f.values ?? []).length > 0);
  const quota = options.sourceQuota ?? (stage.engine?.sources && stage.engine.sources.length > 0 && account ? { fields: [account.field, ...(account.fields ?? [])].filter((k): k is string => typeof k === "string"), values: account.values ?? [], perValue: Math.max(1, Math.ceil(stage.planned_rows / Math.max(1, (account.values ?? []).length))) } : undefined);
  const quotaHave = new Map<string, number>();
  if (quota) for (const r of items.acceptedRows(key)) { const v = r[SOURCE_KEY]; if (typeof v === "string") quotaHave.set(v, (quotaHave.get(v) ?? 0) + 1); }
  const ops: Op[] = [];
  // PHASE 5.3: THE CUSTOMER'S EXCLUSION LIST, on a stage it applies to. A plan that carries the mark is never ingested without the very list it was approved with (fail closed: the batch throws before anything is saved).
  const exclusionMark = plan.customer_exclusion;
  const exclusionKind = exclusionMark?.applies === true ? exclusionStageKind(stage) : null;
  const exclusionHere = exclusionKind !== null;
  if (exclusionHere && (!deps.exclusion || deps.exclusion.digest !== exclusionMark!.digest)) throw new Error("customer_exclusion_unavailable");
  const exclusion = exclusionHere ? deps.exclusion! : null;
  const exclusionNameKeys = exclusion ? nameKeysOf(stage.columns) : [];
  let excludedByList = 0;
  // P0: WHAT WAS DELIVERED BEFORE, never again (the customer asked «من دون تكرار»): a top-level item whose identity is in the approved snapshot is kept out (a child follows its parent, which was checked)
  const priorMark = plan.prior_delivery;
  const priorHere = !isChild && priorMark !== undefined && priorMark.items > 0;
  if (priorHere && !deps.priorDelivered) throw new Error("prior_delivery_unavailable");
  const priorDelivered = priorHere ? deps.priorDelivered! : null;
  let excludedAsDelivered = 0;

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
  const doubtInput: DoubtInput | null = spec?.entity ? { nameKeys: nameKeysOf(stage.columns), descriptionKeys: (spec.text_columns ?? []).filter((k) => /desc|about|summary|bio|overview/i.test(k)), wantedPlaces: promisedPlace?.places ?? [] } : null;
  const doubts = new Map<string, string>();
  for (const raw0 of incoming) {
    if (!isObject(raw0)) { tally.rejected_not_object += 1; continue; }
    // a name that is only a web address is replaced by another name field of the same item (never invented); the id is derived from the item as the source gave it
    const named = isChild ? { item: raw0, debris: false } : withCleanName(withRealName(raw0, stage.columns), stage.columns);
    // THE COMPANY NAME AS THE CUSTOMER READS IT: no stray backslash, quote or trailing separator (companyNames.ts)
    const raw = withTidyNames(named.item, stage.columns, isChild);
    // an item always has an id: its own, the field the recipe chose, a known key field (a platform id, the link), or its fingerprint: the same item read twice is the same id (never rejected for lacking one)
    // (the engine passes the recipe's `idField`, so its items are keyed this way; the model's own save_rows has no such field and keeps refusing an item without an id, which it was told to give)
    const sourceId = options.idField !== undefined ? deriveItemId(raw0, options.idField, parentIds ? String(raw0.parent_id ?? "").trim() || null : null) : String(raw0.id ?? "").trim();
    if (!sourceId) { tally.rejected_missing_id += 1; continue; }
    let id = sourceId;
    let uncertainCompany = false;
    const companyEvidence = companyStage ? companyEvidenceOf(raw, stage) : null;
    if (companyEvidence) {
      const observations = companyObservations.get(sourceId) ?? [];
      const encoded = JSON.stringify(companyEvidence);
      const prior = observations.find((previous) => {
        const evidence = storedCompanyEvidence(previous, stage);
        return JSON.stringify(evidence) === encoded || (evidence.conflict === companyEvidence.conflict && companyRelationship(evidence, companyEvidence) === "same");
      });
      if (prior) id = String(prior.id);
      else if (observations.length > 0) {
        id = `${sourceId}~${createHash("sha256").update(encoded).digest("hex")}`;
        uncertainCompany = observations.some((previous) => companyRelationship(storedCompanyEvidence(previous, stage), companyEvidence) === "uncertain");
      }
    }
    if (items.has(key, id) || seenNow.has(id)) { duplicates += 1; tally.duplicates_ignored += 1; continue; }
    let parentId: string | null = null;
    if (parentIds) {
      parentId = String(raw.parent_id ?? "").trim();
      // an item of a parent that is not saved (yet) is NOT remembered: it may come again once its parent is saved
      if (!parentId || !parentIds.has(parentId)) { tally.rejected_unknown_parent += 1; continue; }
    }
    // Point 3.5: Canonical platform ID deduplication (checked before URL or title fuzzy checks)
    const platformId = contractDedupeKey && raw[contractDedupeKey] !== undefined && raw[contractDedupeKey] !== null
      ? String(raw[contractDedupeKey]).trim()
      : (raw.id !== undefined && raw.id !== null && String(raw.id).trim() !== "" ? String(raw.id).trim() : null);
    if (platformId) {
      const scopedPlatformId = `${platformIdScope(raw, parentId ?? null)}|${platformId}`;
      if (seenPlatformIds.has(scopedPlatformId)) {
        duplicates += 1;
        tally.duplicates_ignored += 1;
        continue;
      }
      seenPlatformIds.add(scopedPlatformId);
    }

    // Structural link deduplication (canonical URL)
    const rawLink = raw.canonical_url ?? raw.url ?? raw.link;
    const uKey = canonicalUrlKey(rawLink);
    if (uKey) {
      const scopedUrl = `${dedupeScope(parentId)}|${uKey}`;
      if (seenUrls.has(scopedUrl)) { duplicates += 1; tally.duplicates_ignored += 1; continue; }
      seenUrls.add(scopedUrl);
    }
    // Structural title deduplication (normalized title ONLY when the row has neither id nor link)
    const hasPlatformId = ROW_KEY_FIELDS.some((k) => k !== "url" && typeof raw[k] === "string" && (raw[k] as string).trim() !== "") || (options.idField !== undefined && options.idField !== null && options.idField !== "_content_id" && typeof raw[options.idField] === "string" && (raw[options.idField] as string).trim() !== "");
    if (!hasPlatformId && !uKey) {
      const rawTitle = raw.title ?? raw.headline;
      const tKey = titleDedupeKey(rawTitle);
      if (tKey) {
        const scopedTitle = `${dedupeScope(parentId)}|${tKey}`;
        if (seenTitles.has(scopedTitle)) { duplicates += 1; tally.duplicates_ignored += 1; tally.duplicate_texts += 1; continue; }
        seenTitles.add(scopedTitle);
      }
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
    // the tokens the stage's replies tool needs from the item's own row (rule 6 of the consolidation): kept on the stored row, never a column of the file
    for (const k of stage.carry_keys ?? []) if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "" && !(k in row)) row[k] = raw[k];
    // the person's professional page read from the source's raw answer (engine/run.ts, DT-20261118-05 item 4a): kept on the stored row for the finders, never a column of the file
    if (typeof raw[SOURCE_PROFILE_KEY] === "string" && raw[SOURCE_PROFILE_KEY] !== "" && !(SOURCE_PROFILE_KEY in row)) row[SOURCE_PROFILE_KEY] = raw[SOURCE_PROFILE_KEY];
    if (companyEvidence) {
      if (id !== sourceId) row[COMPANY_SOURCE_ID_KEY] = sourceId;
      if (uncertainCompany) row[COMPANY_UNCERTAIN_KEY] = "yes";
      for (const field of COMPANY_BRANCH_FIELDS) {
        if (companyEvidence.branches[field] !== undefined && !(field in row)) row[field] = raw[field];
      }
      const sameId = companyObservations.get(sourceId) ?? [];
      sameId.push(row);
      companyObservations.set(sourceId, sameId);
      if (companyEvidence.conflict) { excludedStructural.push({ id, reason: "company_identity_conflict", row }); continue; }
    }
    if (options.provenance) { row._src = options.provenance.src; if (options.provenance.call) row._call = options.provenance.call; }
    // THE PLACE CELLS in Arabic («al qahirah» → «القاهرة»); never empty when the card promised the place
    if (!isChild) placeCellsAr(row, stage.columns, raw, promisedPlace);
    if (companyEvidence && JSON.stringify(companyEvidenceOf(row, stage)) !== JSON.stringify(companyEvidence)) {
      row[COMPANY_EVIDENCE_KEY] = companyEvidence;
    }
    // PHASE 5.3: A COMPANY THE CUSTOMER EXCLUDED (their uploaded list, matched by code on the source's own fields: domain, registration number, full name, distinctive brand words) is kept with its reason, never delivered, never
    // counted and never charged; its id is remembered, so a retried page or another source cannot bring it back under the same id, and a new id meets the same check. A possible match (a shared brand word only) is delivered and marked.
    if (priorDelivered && priorDelivered({ ...raw, id })) { excludedAsDelivered += 1; excludedStructural.push({ id, reason: PRIOR_DELIVERY_REASON, row }); continue; }
    if (exclusion) {
      const verdict = exclusion.check(organisationOfRow(raw, { people: exclusionKind === "people", nameKeys: exclusionNameKeys }));
      if (verdict.kind === "excluded") { excludedByList += 1; excludedStructural.push({ id, reason: CUSTOMER_EXCLUSION_REASON, row }); continue; }
      if (verdict.kind === "possible") row[EXCLUSION_POSSIBLE_MARK] = true;
    }
    // P0 (15 Nov 2026): THE PLAN'S OWN SELECTION RULES HOLD AT EXECUTION. Raw delivery writes most conditions as marks, but a compiled plan CHOSE its top-level items by these rules (compilePlan.ts parentEligible): the exact named account
    // («لا يُسلَّم ولا يُحتسب أي عنصر من حساب آخر»), the period the customer asked, and, on X, original posts only. Once execution reads on past the planning sample, a row the plan would never have chosen is never delivered or charged
    // (msn_dd7c2e9c131b8783bf2e: a fresh read after the count was raised delivered 79 tweets of 38 other accounts).
    if (rawMode && !isChild && plan.compiled?.by === "compiler") {
      const hard = enabledFilters.filter((f) => (f.kind === "account" && f.exact === true) || (f.kind === "period" && plan.compiled?.period_gate === true));
      const why = hard.length > 0 ? filterVerdict(hard, raw, { textKey: textKeyOf(stage, Object.keys(raw)), now, cairoDays: true }) : null;
      const xReply = raw.is_reply === true || raw.is_reply === "true" || raw.is_reply === "True";
      if (why || xReply) { tally.rejected_by_filter += 1; excludedStructural.push({ id, reason: why ?? "filter_reply", row }); continue; }
    }
    // WHAT THE CARD PROMISES, checked here on the mapped item (replies, language, period, account, place): an item a filter rejects is neither delivered nor charged, and is kept with its reason
    if (!rawMode && enabledFilters.length > 0) {
      // THE DAYS OF A PERIOD ARE CAIRO DAYS here too (live finding B: the old reading, UTC days, accepted a tweet of 2026-11-01 00:14 Cairo into an October file and refused the first three hours of 1 October)
      const why = filterVerdict(enabledFilters, raw, { textKey: textKeyOf(stage, Object.keys(raw)), now, cairoDays: true, ...(quota?.defaultSource ? { listing: true } : {}) });
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
    // RAW DELIVERY: what is true of the row is written on it as marks (reply, repost, language, period, named source); nothing is removed for it (rawMarks.ts)
    if (rawMode && !isChild) row[MARKS_KEY] = markVerdict(stage.filters, raw, { textKey: textKeyOf(stage, Object.keys(raw)), now, ...(quota?.defaultSource ? { listing: true } : {}) });
    // A DATE THE SOURCE GIVES ONLY AS A RELATIVE TIME («قبل ٤ أيام», «4 days ago») is written as the approximate day it stands for (from the moment the item was read) and the item is marked, so the file says the date is approximate (relativeDates.ts)
    const approxColumns: string[] = [];
    const unreadColumns: string[] = [];
    for (const c of stage.columns) {
      if (!looksLikeDateColumn(c.title_ar, c.key)) continue;
      const moment = parseMoment(row[c.key]);
      if (moment !== null) {
        // ROUND 38: A DATE THE PLANNER COMPUTED from the item's relative text carries the planner's mark: it is an approximate DAY whatever the gap between planning and this run, never an exact moment (live msn_f6caeacd…: three of five computed dates were delivered as «دقيق»).
        // The day is read from the item's own relative text at this moment when it has one (so the item's date columns name the same day), else it is the day of the computed instant.
        if (approxColumnsOf(raw).includes(c.key)) {
          let day: string | null = null;
          for (const [field, text] of Object.entries(raw)) { if (field === c.key || typeof text !== "string") continue; const age = parseRelativeAge(text, now); if (age) { day = approxDayOf(age); break; } }
          row[c.key] = day ?? approxDayOfMs(moment.getTime());
          approxColumns.push(c.key);
          continue;
        }
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
      // A SOURCE THAT DATES ITS ITEMS ONLY BY A RELATIVE TEXT (YouTube comments, round 13): a text the code cannot read is no date, so the cell stays EMPTY (never the foreign words) and the item is marked, to be counted in the limits of the delivery
      else if (stage.relative_dates === true && typeof row[c.key] === "string" && row[c.key] !== "") { row[c.key] = ""; unreadColumns.push(c.key); }
    }
    if (approxColumns.length > 0) row[APPROX_DATES_KEY] = approxColumns;
    if (unreadColumns.length > 0) row[DATE_UNREAD_KEY] = unreadColumns;
    // CONTACT FIELDS are verified by code: a work e-mail or phone that does not pass is left empty (the CELL). Verification never decides whether a PERSON is delivered: a row that carries a real person's name (people.ts) is delivered with
    // its unverified cells empty (live re-test 2026-10-31, A1 and A2: 31 and 32 named people with job titles were thrown away because the source gave no e-mail or phone). Only a row of a contact source that is NOT a named person (an
    // e-mail finder's row is its address) and has no verified value has nothing to deliver, so it is not delivered (and not charged).
    let verifiedAny = false;
    for (const c of contactColumns) {
      const original = String(raw[c.key] ?? "").trim();
      // THE SHAPE FIRST (contactShape.ts, the rule settlement uses too): a native phone cell that is a date, a labelled id or any text that is not written as a phone is never turned into one by digit-stripping (DT-20261119-06 PART B)
      const verified = c.kind === "work_email" || phoneShape(original) ? verifyContactValue(c.kind!, raw[c.key]) : null;
      // A VALUE THE SOURCE GAVE IS DELIVERED even when the check does not verify it (owner direction 2026-11-01): it is kept as written and the status cell beside it says «غير موثّق»; a masked value (stars) is no value. Empty only when nothing was found.
      const looksLikeValue = contactShape(c.kind === "work_email" ? "email" : "phone", original);
      const kept = verified ?? (looksLikeValue ? original : "");
      row[c.key] = kept;
      // «موثّق» is never written here: a code check says an address or a number is well formed, not that a mailbox exists or a line is live and local. The contact step sends every kept value through a verifier or a validator and writes «موثّق» only on its answer (emailVerification.ts, phoneValidation.ts)
      if (kept) row[statusKeyOf(c.key)] = CONTACT_STATUS_UNVERIFIED_AR;
      if (verified) verifiedAny = true; else if (original && !kept) tally.contact_values_left_empty += 1;
    }
    if (contactStage && contactColumns.length > 0 && !verifiedAny && !isNamedPerson(raw, stage.columns)) { tally.rejected_no_verified_contact += 1; excludedStructural.push({ id, reason: "no_verified_contact", row }); continue; }
    // A PERSON DELIVERED UNDER A COMPANY MUST WORK THERE NOW (companyIdentity.ts): the engine read the source's own experiences for this person and none of the current ones names the parent company (live A1: the people of a company named «mycompany» under «falcon misr»). The
    // person is kept with the reason, not delivered, not counted and not charged; the company's next people take the place.
    if (peopleStage && raw0[NOT_AT_COMPANY_MARK] === true) { tally.rejected_not_at_company += 1; excludedStructural.push({ id, reason: "not_at_company", row }); continue; }
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
    const rawAcceptedIds = (spec as unknown as { accepted_ids?: unknown }).accepted_ids;
    const planningAcceptedIds = new Set<string>(
      Array.isArray(rawAcceptedIds)
        ? rawAcceptedIds.map((x) => String(x ?? "").trim()).filter(Boolean)
        : []
    );
    const isAcceptedAtPlanning = (c: Candidate): boolean =>
      planningAcceptedIds.size > 0 &&
      (planningAcceptedIds.has(c.id) ||
        (c.row.id !== undefined && c.row.id !== null && planningAcceptedIds.has(String(c.row.id).trim())) ||
        planningAcceptedIds.has(deriveItemId(c.row, options.idField ?? null)));
    const verdicts = candidates.map((c) => { const v0 = classifyRowDetailed(spec, c.row); const v = namedSource && v0.verdict === "exclude" && v0.reason === "no_term" ? ({ verdict: "review", reason: "uncertain" } as const) : v0; return { c, v: v.verdict === "match" && (govUnclear.has(c.id) || doubts.has(c.id) || (c.carried && (governmentUnclear(stage.filters, c.row) || typeof c.row._doubt === "string"))) ? ({ verdict: "review", reason: "uncertain" } as const) : v }; });
    const matches = verdicts.filter((x) => x.v.verdict === "match").length;
    let verdictOf = new Map<string, boolean>();
    let modelAccepted = 0;
    for (const x of verdicts) {
      if (x.v.verdict === "review" && isAcceptedAtPlanning(x.c)) {
        verdictOf.set(x.c.id, true);
        modelAccepted += 1;
      }
    }
    const uncertain = verdicts.filter((x) => x.v.verdict === "review" && !verdictOf.has(x.c.id));
    if (uncertain.length > 0 && spec.review !== false && reviewer && matches + modelAccepted < room) {
      const governmentAsked = (stage.filters ?? []).some((f) => f.kind === "exclude_government" && isEnabled(f));
      // a company stage with a promised place: the model check is told the company must really be of that kind and place (a head office abroad, a law firm, a news site, a trade show is not)
      const placeWords = spec.entity && placeFilter ? (placeFilter.values ?? []).join("، ") : "";
      const rawCrit = (spec as { criterion?: { entity?: string; country?: string; topic?: string; brief?: string } | string }).criterion;
      const critSummary = rawCrit && typeof rawCrit === "object"
        ? [
            rawCrit.entity ? `Source/Account: ${rawCrit.entity}` : null,
            rawCrit.country ? `Country: ${rawCrit.country}` : null,
            rawCrit.topic ? `Topic: «${rawCrit.topic}»` : null,
            rawCrit.brief ? `Brief: ${rawCrit.brief}` : null,
          ].filter(Boolean).join(", ")
        : "";
      const baseSubject = critSummary ? `${spec.subject_ar} (${critSummary})` : spec.subject_ar;
      const subject = `${baseSubject}${governmentAsked ? " (ليست جهة حكومية أو عسكرية ولا مركز أبحاث أو معهدًا حكوميًا)" : ""}${placeWords ? ` (شركة حقيقية من هذا النوع مقرها أو نشاطها في ${placeWords}؛ وليست حدثًا أو معرضًا أو مكتب محاماة أو موقعًا إخباريًا أو منتدى أو شركة مقرها في بلد آخر)` : ""}`;
      // THE REVIEW GOES ON, SLICE AFTER SLICE, UNTIL THE ROOM IS FILLED, EVERY WAITING ITEM WAS REVIEWED, OR A STOP WAS RECORDED (audit G13: one slice per pass left paid rows waiting for a later round). Each slice is no more than the room still left can use (x3 for the rows the model says no to, plus 25).
      let at = 0;
      while (at < uncertain.length && matches + modelAccepted < room) {
        const slice = uncertain.slice(at, at + (room - matches - modelAccepted) * 3 + 25);
        at += slice.length;
        const got = await reviewer.review({ subject, rows: slice.map((x) => ({ id: x.c.id, text: formatJudgeRowText(x.c.row, spec.text_columns) })) });
        for (const [id, ok] of got) { verdictOf.set(id, ok); if (ok) modelAccepted += 1; }
        if ((await reviewer.state()).stop) break;
      }
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
  const stageTarget = options.targetRows ?? stage.planned_rows;
  let acceptedNow = 0;
  let modelAccepted = 0;
  for (const c of candidates) {
    const o = outcome.get(c.id)!;
    let state: "accepted" | "excluded" | "pending" | "unchecked" = o.state;
    let reason: ItemReason | undefined = o.reason;
    const evidence = companyStage ? storedCompanyEvidence(c.row, stage) : null;
    const companyDecision = evidence && state === "accepted" ? companyIndex.inspect(evidence) : null;
    if (companyDecision === "duplicate_company" || companyDecision === "company_identity_conflict") {
      state = "excluded";
      reason = companyDecision;
    }
    // a match beyond the volume the customer bought was checked and is not needed: it is kept (never delivered, never charged) with that reason
    if (state === "accepted" && (before.accepted + acceptedNow >= stageTarget || (options.acceptCap !== undefined && acceptedNow >= options.acceptCap))) { state = "excluded"; reason = "target_reached"; tally.rejected_over_limit += 1; }
    // a named source whose share is full: its match is kept, not delivered (the other sources still have room)
    if (state === "accepted" && quota) {
      const src = c.row[SOURCE_KEY];
      if (typeof src === "string") {
        const have = quotaHave.get(src) ?? 0;
        if (have >= quota.perValue) { state = "excluded"; reason = "target_reached"; tally.rejected_over_limit += 1; } else quotaHave.set(src, have + 1);
      }
    }
    const marks = {
      ...(state === "accepted" && judgedMark ? { [TOPIC_RELATION_KEY]: topicRelationAr(2) } : {}),
      ...(state === "accepted" && companyDecision === "possible" ? { [COMPANY_UNCERTAIN_KEY]: "yes" } : {}),
    };
    if (state === "accepted") {
      if (evidence) companyIndex.add(evidence);
      acceptedNow += 1;
      if (o.by === "model") modelAccepted += 1;
    }
    if (state === "excluded" && reason && reason !== "target_reached") left[reason] = (left[reason] ?? 0) + 1;
    if (c.carried) {
      // a carried item is already in the log: only a decision moves it
      if (state === "accepted" || state === "excluded") ops.push({ t: "resolve", stage: key, id: c.id, state, ...(o.by ? { by: o.by } : {}), ...(o.basis ? { basis: o.basis } : {}), ...(reason ? { reason } : {}), ...(Object.keys(marks).length > 0 ? { marks } : {}) });
    } else {
      // a row the review judged about the request says so in its own topic column (the file's mark is the verdict that let it in, never a guess from words)
      const row = Object.keys(marks).length > 0 ? { ...c.row, ...marks } : c.row;
      ops.push({ t: "item", stage: key, id: c.id, state, ...(state === "accepted" && o.by ? { by: o.by } : {}), ...(state === "accepted" && o.basis ? { basis: o.basis } : {}), ...(reason ? { reason } : {}), row });
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
  const stillNeeded = Math.max(0, stageTarget - counts.accepted);
  return {
    ok: true, stage: key, ...tally, ...(excludedByList > 0 ? { rejected_by_customer_exclusion: excludedByList } : {}), ...(excludedAsDelivered > 0 ? { rejected_as_delivered_before: excludedAsDelivered } : {}), counts, newlyAccepted: acceptedNow, total_in_stage: counts.accepted, stage_limit: stage.planned_rows,
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
