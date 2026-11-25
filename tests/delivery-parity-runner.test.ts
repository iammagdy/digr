import { describe, it, expect } from "vitest";
import {
  mapFixtureRowsToRecordedRows,
  loadRecordedRows,
  BUILTIN_MSN_F91F_ROWS,
} from "../scripts/full-flow-replay-runner";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { createMemoryStore } from "../agent/src/memoryStore";

describe("DT-20261125-delivery-parity: Runner fixture URL mapping & delivery parity", () => {
  const dummyStage = {
    key: "tweets",
    title_ar: "التغريدات",
    parent_key: null,
    deliver: true,
    planned_rows: 10,
    columns: [
      { key: "text", title_ar: "النص" },
      { key: "url", title_ar: "الرابط" },
      { key: "authorUsername", title_ar: "المؤلف" },
    ],
  };
  const dummyPlan = { stages: [dummyStage] };

  it("M3': duplicated urls -> distinct urls with row id; unique urls unchanged; unparsable/missing -> no url; author derived from url path; ingest keeps distinct items", async () => {
    const fixtureRows = [
      { id: "row_shared_1", text: "Post 1 with shared masked url", url: "https://example.com/authorone/status/masked" },
      { id: "row_shared_2", text: "Post 2 with shared masked url", url: "https://example.com/authorone/status/masked" },
      { id: "row_shared_3", text: "Post 3 with shared masked url", url: "https://example.com/authorone/status/masked" },
      { id: "row_distinct_4", text: "Post 4 with distinct url", url: "https://example.com/authortwo/status/distinct_1" },
      { id: "row_distinct_5", text: "Post 5 with distinct url", url: "https://example.com/authortwo/status/distinct_2" },
      { id: "row_bad_6", text: "Post 6 with unparsable url", url: "not-a-valid-url" },
      { id: "row_missing_7", text: "Post 7 with missing url" },
    ];

    const recorded = mapFixtureRowsToRecordedRows(fixtureRows);
    expect(recorded).toHaveLength(7);

    // Duplicated urls -> distinct urls with the same host and the row id as last segment
    expect(recorded[0].url).toBe("https://example.com/authorone/status/row_shared_1");
    expect(recorded[1].url).toBe("https://example.com/authorone/status/row_shared_2");
    expect(recorded[2].url).toBe("https://example.com/authorone/status/row_shared_3");

    // Author derived from the first path segment of the row's fixture url (authorone)
    expect(recorded[0].authorUsername).toBe("authorone");
    expect(recorded[1].authorUsername).toBe("authorone");
    expect(recorded[2].authorUsername).toBe("authorone");

    // Unique urls stay byte-for-byte
    expect(recorded[3].url).toBe("https://example.com/authortwo/status/distinct_1");
    expect(recorded[4].url).toBe("https://example.com/authortwo/status/distinct_2");
    expect(recorded[3].authorUsername).toBe("authortwo");
    expect(recorded[4].authorUsername).toBe("authortwo");

    // Unparsable / missing url -> no url field and no author derived
    expect(recorded[5].url).toBeUndefined();
    expect("url" in recorded[5]).toBe(false);
    expect(recorded[5].authorUsername).toBeUndefined();
    expect("authorUsername" in recorded[5]).toBe(false);

    expect(recorded[6].url).toBeUndefined();
    expect("url" in recorded[6]).toBe(false);
    expect(recorded[6].authorUsername).toBeUndefined();
    expect("authorUsername" in recorded[6]).toBe(false);

    // Feeding to ingestRows keeps all distinct items (no duplicates_ignored among distinct rows)
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "test_m3");
    const tally = await ingestRows(
      { items, plan: dummyPlan as any, reviewer: undefined, addEvent: async () => {} },
      dummyStage as any,
      recorded,
      { idField: "id" }
    );

    expect(tally.duplicates_ignored).toBe(0);
    expect(tally.saved_now).toBe(7);
    const storedRows = items.acceptedRows("tweets");
    expect(storedRows).toHaveLength(7);
    const storedIds = storedRows.map((r) => r.id).sort();
    expect(storedIds).toEqual([
      "row_bad_6",
      "row_distinct_4",
      "row_distinct_5",
      "row_missing_7",
      "row_shared_1",
      "row_shared_2",
      "row_shared_3",
    ]);
  });

  it("C1: Two fixture rows with the SAME id stay one item after ingest (a real duplicate is still a duplicate)", async () => {
    const fixtureRows = [
      { id: "real_duplicate_id", text: "First copy of tweet", url: "https://example.com/author/status/url_a" },
      { id: "real_duplicate_id", text: "Second copy of same tweet", url: "https://example.com/author/status/url_b" },
    ];

    const recorded = mapFixtureRowsToRecordedRows(fixtureRows);
    expect(recorded).toHaveLength(2);

    const store = createMemoryStore();
    const items = await ItemStore.open(store, "test_c1");
    const tally = await ingestRows(
      { items, plan: dummyPlan as any, reviewer: undefined, addEvent: async () => {} },
      dummyStage as any,
      recorded,
      { idField: "id" }
    );

    expect(tally.duplicates_ignored).toBe(1);
    expect(tally.saved_now).toBe(1);
    const storedRows = items.acceptedRows("tweets");
    expect(storedRows).toHaveLength(1);
    expect(storedRows[0].id).toBe("real_duplicate_id");
  });

  it("C2: Rows whose urls are all distinct keep them byte-for-byte", () => {
    const fixtureRows = [
      { id: "id_101", text: "Text 101", url: "https://example.com/author1/status/101" },
      { id: "id_102", text: "Text 102", url: "https://example.com/author2/status/102" },
      { id: "id_103", text: "Text 103", url: "https://example.com/author3/status/103" },
    ];

    const recorded = mapFixtureRowsToRecordedRows(fixtureRows);
    expect(recorded).toHaveLength(3);
    expect(recorded[0].url).toBe("https://example.com/author1/status/101");
    expect(recorded[1].url).toBe("https://example.com/author2/status/102");
    expect(recorded[2].url).toBe("https://example.com/author3/status/103");
  });

  it("C3: Built-in fixture path (mission without a QA fixture file) gives the same result as on main", () => {
    const replay = loadRecordedRows({
      missionId: "msn_non_existent_fixture_99999",
      providers: "recorded",
      runs: 1,
      maxUsd: 0.5,
      verbose: false,
      prompt: "test",
    });

    expect(replay.probeRows).toEqual(BUILTIN_MSN_F91F_ROWS);
    expect(replay.executionRows).toEqual(BUILTIN_MSN_F91F_ROWS);
    expect(replay.sourceDescription).toContain("Built-in recorded fixture for msn_non_existent_fixture_99999");
  });
});
