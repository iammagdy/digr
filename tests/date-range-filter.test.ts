import { describe, expect, it } from "vitest";
import { filterRowsByDateRange } from "../src/lib/server/dateRangeFilter";

describe("filterRowsByDateRange", () => {
  it("keeps only rows with verifiable publication dates inside the inclusive window", () => {
    const result = filterRowsByDateRange(
      [
        { published_at: "2026-09-17T00:00:00Z", id: "start" },
        { created_at: "2026-10-17T23:59:59Z", id: "end" },
        { published_at: "2026-09-16T23:59:59Z", id: "too-old" },
        { published_at: "2026-10-18T00:00:00Z", id: "future" },
        { id: "undated" },
      ],
      "2026-09-17",
      "2026-10-17",
    );

    expect(result.rows.map((row) => row.id)).toEqual(["start", "end"]);
    expect(result.excludedCount).toBe(3);
  });

  it("supports numeric Unix-second timestamps and leaves unbounded requests alone", () => {
    const rows = [{ timestamp: 1792230000 }, { timestamp: 1 }];
    expect(filterRowsByDateRange(rows, "2026-10-17", "2026-10-17").rows).toEqual([rows[0]]);
    expect(filterRowsByDateRange(rows).rows).toEqual(rows);
  });
});
