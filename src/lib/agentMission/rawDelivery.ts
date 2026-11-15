/**
 * THE RAW-DELIVERY CONTRACT, AS CONSTANTS (docs/REDESIGN.md section 5; owner decisions D5 and D6). In raw mode a delivery is what the source gave, with the smallest possible set of removals; every content rule (language, period, reply,
 * repost, topic, place, account) becomes a MARK column on the row instead of a removal. No runtime code reads these constants to remove anything: they are the single written list the tests hold the code to.
 */
export type RemovalReason = string;

/** The reasons an item can leave the file today (agent/src/finalize.ts REASON_TEXT_AR; pinned by tests/raw-delivery-contract.test.ts). */
export const EXISTING_REMOVAL_REASONS: ReadonlyArray<RemovalReason> = [
  "no_text", "no_term", "mention_only", "other_person", "name_extended", "other_meaning", "uncertain", "not_reviewed", "review_no", "review_failed",
  "filter_reply", "filter_repost", "filter_language", "filter_period", "filter_account", "filter_place", "filter_government", "filter_media",
  "unknown_parent", "no_verified_contact", "not_a_person", "target_reached", "not_at_company", "customer_exclusion", "already_delivered",
];

/**
 * The only removals allowed in raw mode: the same record id twice (a duplicate is counted, never stored), an item whose parent is not saved, an item beyond the volume the customer bought (the count cap, D6) and the share of a named source
 * (stored under the reason `target_reached`).
 */
export const ALLOWED_REMOVALS_RAW: ReadonlySet<RemovalReason> = new Set(["id_duplicate", "unknown_parent", "target_reached", "named_source_share", /** PHASE 5.3: a company in the customer's own approved exclusion list. */ "customer_exclusion", /** P0 (15 Nov 2026): an item an earlier mission of the conversation delivered, when the customer asked not to receive it again. */ "already_delivered"]);

/**
 * P0 (15 Nov 2026, msn_cd5f32adadefb9bb971f / msn_dd7c2e9c131b8783bf2e): THE ONE EXCEPTION TO «CONTENT RULES ARE MARKS», for a plan the COMPILER made (`plan.compiled.by === "compiler"`): the rules the plan itself chose its top-level items by
 * are gates at execution too, because those items are what the customer approved and is charged for. They are: the research topic judged by the model (`review_no`, and `not_reviewed` / `review_failed` stay pending: never delivered,
 * never charged), the exact named account (`filter_account`), the period (`filter_period`) and, on X, original posts only (`filter_reply`). agent/src/items/ingest.ts applies them; tests/p0-research-relevance-cd5f.test.ts pins them.
 * Comments and replies stay raw (delivered as the source gives them, said on the card).
 */
export const COMPILED_PLAN_GATES: ReadonlySet<RemovalReason> = new Set(["review_no", "filter_account", "filter_period", "filter_reply"]);

export const isAllowedRemovalRaw = (reason: RemovalReason): boolean => ALLOWED_REMOVALS_RAW.has(reason);

/** The stored reasons that must never appear on an excluded item in raw mode (each becomes a mark). */
export const rawForbiddenReasons = (): RemovalReason[] => EXISTING_REMOVAL_REASONS.filter((r) => !ALLOWED_REMOVALS_RAW.has(r));
