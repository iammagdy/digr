import { describe, expect, it } from "vitest";
import { hasApprovedTopupTransition } from "../src/lib/topupStatusTransition";

describe("top-up approval transition detection", () => {
  it("refreshes the balance when an existing pending request becomes approved", () => {
    expect(
      hasApprovedTopupTransition([{ $id: "t1", status: "approved" }], new Map([["t1", "pending"]]), null),
    ).toBe(true);
  });

  it("detects approval if the first refreshed list arrives before the pending list", () => {
    expect(
      hasApprovedTopupTransition(
        [{ $id: "t1", status: "approved" }],
        new Map(),
        { $id: "t1", status: "pending" },
      ),
    ).toBe(true);
  });

  it("does not treat an already approved historical request as a new transition", () => {
    expect(
      hasApprovedTopupTransition([{ $id: "t1", status: "approved" }], new Map(), null),
    ).toBe(false);
  });
});
