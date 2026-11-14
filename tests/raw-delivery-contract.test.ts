import { describe, expect, it } from "vitest";
import { REASON_TEXT_AR } from "../agent/src/finalize";
import { ALLOWED_REMOVALS_RAW, EXISTING_REMOVAL_REASONS, isAllowedRemovalRaw, rawForbiddenReasons } from "../src/lib/agentMission/rawDelivery";

/**
 * S1 item 0.3: THE RAW-DELIVERY CONTRACT (docs/REDESIGN.md section 5, owner decisions D5, D6). Today an item can leave the file for 23 recorded reasons (agent/src/finalize.ts REASON_TEXT_AR). In raw mode only four removals exist:
 * the same record id twice (`id_duplicate`: counted as a duplicate, never stored), an item whose parent is unknown (`unknown_parent`), an item beyond the volume bought (`target_reached`, the count cap) and the share of a named source
 * (`named_source_share`: stored as `target_reached`). Everything else becomes a MARK column. The behaviour under raw mode is asserted in tests/raw-ingest-social.test.ts (item 1.1); this file pins the inventory and the allowed set.
 */
// CHANGED (Phase 5.3, docs/intelligence/PHASE-5-3-AND-6.md): the 24th reason `customer_exclusion` (a company in the customer's own approved exclusion list) is added on purpose, and it is an allowed raw removal:
// the customer's explicit criterion, never a content rule. The inventory stays pinned exactly.
const PINNED_24 = [
  "no_text", "no_term", "mention_only", "other_person", "name_extended", "other_meaning", "uncertain", "not_reviewed", "review_no", "review_failed",
  "filter_reply", "filter_repost", "filter_language", "filter_period", "filter_account", "filter_place", "filter_government", "filter_media",
  "unknown_parent", "no_verified_contact", "not_a_person", "target_reached", "not_at_company", "customer_exclusion",
];

describe("the removal reasons that exist today are pinned", () => {
  it("finalize.ts knows exactly these 24 codes, and the contract constant lists the same", () => {
    expect(Object.keys(REASON_TEXT_AR).sort()).toEqual([...PINNED_24].sort());
    expect([...EXISTING_REMOVAL_REASONS].sort()).toEqual([...PINNED_24].sort());
    expect(PINNED_24).toHaveLength(24);
  });
});

describe("only five removals are allowed when raw mode is on (four, plus the customer's own exclusion list since Phase 5.3)", () => {
  it("the allowed set is fixed", () => {
    expect([...ALLOWED_REMOVALS_RAW].sort()).toEqual(["customer_exclusion", "id_duplicate", "named_source_share", "target_reached", "unknown_parent"]);
  });
  it("of the 24 stored reasons only unknown_parent, target_reached and customer_exclusion stay; the other 21 must become marks", () => {
    expect(isAllowedRemovalRaw("unknown_parent")).toBe(true);
    expect(isAllowedRemovalRaw("target_reached")).toBe(true);
    expect(isAllowedRemovalRaw("id_duplicate")).toBe(true);
    for (const r of ["filter_language", "filter_reply", "filter_period", "no_term", "review_no", "uncertain", "not_a_person"]) expect(isAllowedRemovalRaw(r)).toBe(false);
    const forbidden = rawForbiddenReasons();
    expect(forbidden).toHaveLength(21);
    expect(forbidden).not.toContain("unknown_parent");
    expect(forbidden).not.toContain("target_reached");
  });
});
