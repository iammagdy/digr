import { describe, it, expect } from "vitest";
import { extractAndFlattenRows } from "../src/functions/shared/multiStepWorker";
import { hasRecognizedProviderResultShape } from "../src/lib/server/tregAdapter";
import { findProviderNextCursor, findProviderResultList } from "../src/lib/server/providerRows";

const comments = [
  { comment_id: "1", text: "حلو", author: "a", likes: 3 },
  { comment_id: "2", text: "ممتاز", author: "b", likes: 1 },
];

describe("provider answers are read whatever envelope they arrive in", () => {
  const shapes: Record<string, any> = {
    "routed service: output.comments": { output: { comments }, raw: {}, _treg: { served_by: "x" } },
    "top-level comments": { comments, cursor: "abc" },
    "recipe rows": { ok: true, rows: comments, usage: {} },
    "aggregator data.comments": { code: 200, data: { comments, cursor: 5, has_more: 1 } },
    "plain array": comments,
    "videos under data": { data: { videos: comments } },
    "a service with its own key name": { status: "ok", threads: comments },
  };

  for (const [name, shape] of Object.entries(shapes)) {
    it(`${name}: two rows, recognized, never one junk envelope row`, () => {
      const rows = extractAndFlattenRows(shape);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.text || row.comment_id)).toBe(true);
      expect(hasRecognizedProviderResultShape(shape)).toBe(true);
    });
  }

  it("a valid empty list is recognized (no data), unlike an answer with no list at all", () => {
    for (const empty of [{ output: { comments: [] }, raw: {} }, { ok: true, rows: [] }, { data: { comments: [] } }, []]) {
      expect(extractAndFlattenRows(empty)).toHaveLength(0);
      expect(hasRecognizedProviderResultShape(empty)).toBe(true);
    }
    expect(hasRecognizedProviderResultShape({ message: "rate limited" })).toBe(false);
    expect(hasRecognizedProviderResultShape(null)).toBe(false);
  });

  it("an aggregator envelope is opened and never billed as a single row", () => {
    const rows = extractAndFlattenRows({ code: 200, data: { comments, cursor: 5, has_more: 1 } });
    expect(rows.map((row) => row.comment_id)).toEqual(["1", "2"]);
  });

  it("the first non-empty list wins over an earlier empty one", () => {
    expect(findProviderResultList({ comments: [], replies: [{ id: 1 }] })?.list).toHaveLength(1);
  });

  it("a single-record answer (a profile) is still one row", () => {
    const rows = extractAndFlattenRows({ data: { user: { uniqueId: "x", followerCount: 5 } } });
    expect(rows).toHaveLength(1);
  });
});

describe("the next page is found through any envelope", () => {
  it("reads cursors from the top level, nested data and pagination", () => {
    expect(findProviderNextCursor({ next_cursor: "n1" })).toBe("n1");
    expect(findProviderNextCursor({ data: { cursor: 20, has_more: 1 } })).toBe("20");
    expect(findProviderNextCursor({ output: { pagination: { next_cursor: "p2" } } })).toBe("p2");
    expect(findProviderNextCursor({ meta: { next_cursor: "m3" } })).toBe("m3");
  });

  it("a cursor next to has_more false is a position, not another page", () => {
    expect(findProviderNextCursor({ data: { cursor: 20, has_more: 0 } })).toBeNull();
    expect(findProviderNextCursor({ cursor: "", comments })).toBeNull();
    expect(findProviderNextCursor("nothing")).toBeNull();
  });
});
