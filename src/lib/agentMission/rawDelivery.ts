/**
 * THE RAW-DELIVERY CONTRACT, AS CONSTANTS (docs/REDESIGN.md section 5; owner decisions D5 and D6). In raw mode a delivery is what the source gave, with the smallest possible set of removals; every content rule (language, period, reply,
 * repost, topic, place, account) becomes a MARK column on the row instead of a removal. No runtime code reads these constants to remove anything: they are the single written list the tests hold the code to.
 */
export type RemovalReason = string;

/** The reasons an item can leave the file today (agent/src/finalize.ts REASON_TEXT_AR; pinned by tests/raw-delivery-contract.test.ts). */
export const EXISTING_REMOVAL_REASONS: ReadonlyArray<RemovalReason> = [
  "no_text", "no_term", "mention_only", "other_person", "name_extended", "other_meaning", "uncertain", "not_reviewed", "review_no", "review_failed",
  "filter_reply", "filter_repost", "filter_language", "filter_period", "filter_account", "filter_place", "filter_government", "filter_media",
  "unknown_parent", "no_verified_contact", "not_a_person", "target_reached", "not_at_company",
];

/**
 * The only removals allowed in raw mode: the same record id twice (a duplicate is counted, never stored), an item whose parent is not saved, an item beyond the volume the customer bought (the count cap, D6) and the share of a named source
 * (stored under the reason `target_reached`).
 */
export const ALLOWED_REMOVALS_RAW: ReadonlySet<RemovalReason> = new Set(["id_duplicate", "unknown_parent", "target_reached", "named_source_share"]);

export const isAllowedRemovalRaw = (reason: RemovalReason): boolean => ALLOWED_REMOVALS_RAW.has(reason);

/** The stored reasons that must never appear on an excluded item in raw mode (each becomes a mark). */
export const rawForbiddenReasons = (): RemovalReason[] => EXISTING_REMOVAL_REASONS.filter((r) => !ALLOWED_REMOVALS_RAW.has(r));
