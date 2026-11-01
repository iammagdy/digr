import { describe, expect, it } from "vitest";
import { REASON_TEXT_AR } from "../agent/src/finalize";
import { ALLOWED_REMOVALS_RAW, EXISTING_REMOVAL_REASONS, isAllowedRemovalRaw, rawForbiddenReasons } from "../src/lib/agentMission/rawDelivery";

/**
 * S1 item 0.3: THE RAW-DELIVERY CONTRACT (docs/REDESIGN.md section 5, owner decisions D5, D6). Today an item can leave the file for 23 recorded reasons (agent/src/finalize.ts REASON_TEXT_AR). In raw mode only four removals exist:
 * the same record id twice (`id_duplicate`: counted as a duplicate, never stored), an item whose parent is unknown (`unknown_parent`), an item beyond the volume bought (`target_reached`, the count cap) and the share of a named source
 * (`named_source_share`: stored as `target_reached`). Everything else becomes a MARK column. The behaviour under raw mode is asserted in tests/raw-ingest-social.test.ts (item 1.1); this file pins the inventory and the allowed set.
 */
const PINNED_23 = [
  "no_text", "no_term", "mention_only", "other_person", "name_extended", "other_meaning", "uncertain", "not_reviewed", "review_no", "review_failed",
  "filter_reply", "filter_repost", "filter_language", "filter_period", "filter_account", "filter_place", "filter_government", "filter_media",
  "unknown_parent", "no_verified_contact", "not_a_person", "target_reached", "not_at_company",
];

describe("the removal reasons that exist today are pinned", () => {
  it("finalize.ts knows exactly these 23 codes, and the contract constant lists the same", () => {
    expect(Object.keys(REASON_TEXT_AR).sort()).toEqual([...PINNED_23].sort());
    expect([...EXISTING_REMOVAL_REASONS].sort()).toEqual([...PINNED_23].sort());
    expect(PINNED_23).toHaveLength(23);
  });
});

describe("only four removals are allowed when raw mode is on", () => {
  it("the allowed set is fixed", () => {
    expect([...ALLOWED_REMOVALS_RAW].sort()).toEqual(["id_duplicate", "named_source_share", "target_reached", "unknown_parent"]);
  });
  it("of the 23 stored reasons only unknown_parent and target_reached stay; the other 21 must become marks", () => {
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
