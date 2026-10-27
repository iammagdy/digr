import { describe, expect, it } from "vitest";
import {
  CALL_CAP_NOTE_AR, DIRECTORY_NO_PROGRESS_PAGES, MAX_CONSECUTIVE_EMPTY_PAGES_LARGE, MAX_CONSECUTIVE_EMPTY_PAGES_SMALL, NO_PROGRESS_PAGES, evaluateProviderCallCap,
} from "../src/lib/server/providerCallCaps";

/**
 * The yield watchdog: a job stops after TWO consecutive provider pages that add no accepted row (it was three for a large job and five for «nothing delivered yet»).
 * 22 Oct 2026: 175 pages, 0 rows, 0.866 USD. The worker-level replay of that job is in tests/replay-harness.test.ts.
 */
describe("the stop rule: two pages in a row that add nothing", () => {
  it("the constants", () => {
    expect(MAX_CONSECUTIVE_EMPTY_PAGES_SMALL).toBe(2);
    expect(MAX_CONSECUTIVE_EMPTY_PAGES_LARGE).toBe(2);
    expect(NO_PROGRESS_PAGES).toBe(2);
    expect(DIRECTORY_NO_PROGRESS_PAGES).toBe(2);
  });

  for (const [label, targetMax, pageSize, kind] of [["a small feed job", 5, 10, "feed"], ["a large feed job", 400, 50, "feed"], ["a large directory job", 200, 20, "directory"]] as const) {
    describe(label, () => {
      const call = (pagesDone: number, acceptedThisPage: number, priorBatchUnits: Array<number | null>, deliveredTotal = 0) =>
        evaluateProviderCallCap({ pagesDone, acceptedThisPage, priorBatchUnits, targetMax, pageSize, kind, deliveredTotal });

      it("one empty page does not stop it", () => {
        expect(call(1, 0, [])).toBeNull();
        expect(call(2, 0, [3], 3)).toBeNull();
      });

      it("the second empty page in a row stops it, with rows delivered before or not", () => {
        expect(call(2, 0, [0])).not.toBeNull();
        expect(call(3, 0, [4, 0], 4)).toBe("empty_pages");
      });

      it("nothing delivered after two pages stops it even when the earlier page cannot be read back", () => {
        expect(call(2, 0, [null])).toBe("no_progress");
      });

      it("a page with a new row restarts the count", () => {
        expect(call(3, 0, [0, 2], 2)).toBeNull();
        expect(call(4, 0, [0, 2, 0], 2)).toBe("empty_pages");
      });
    });
  }
});

describe("what the customer reads when the watchdog stops the job", () => {
  for (const reason of ["empty_pages", "no_progress"] as const) {
    it(`${reason}: Arabic only, two pages in a row, what is charged`, () => {
      const note = CALL_CAP_NOTE_AR[reason];
      expect(note).toContain("صفحتين متتاليتين");
      expect(note).not.toMatch(/[A-Za-z0-9]|\$|USD|دولار|استرداد/);
      expect(note).not.toMatch(/\p{Extended_Pictographic}/u);
    });
  }
  it("when nothing was delivered the whole hold is released and the sentence says so (the worker replay asserts the release)", () => {
    expect(CALL_CAP_NOTE_AR.no_progress).toContain("لم يُحتسب عليك إلا ما سُلّم");
  });
});
