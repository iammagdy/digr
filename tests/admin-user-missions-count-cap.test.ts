import { describe, expect, it } from "vitest";
import { countMissionsByUser } from "../src/lib/server/adminUserMissions";

/** A fake of the API: a query never returns more than 1,000 rows, whatever .limit() asks for (the project's cap), and .range() pages. */
function capped(rows: Array<{ id: string; user_id: string; addon: null }>) {
  return { from: () => ({ select: () => ({ in: (_c: string, ids: string[]) => {
    const mine = rows.filter((r) => ids.includes(r.user_id)).sort((a, b) => (a.id < b.id ? -1 : 1));
    const q: any = {
      _from: 0, _to: 999,
      order: () => q,
      limit: (n: number) => { q._to = Math.min(n, 1000) - 1; return q; },
      range: (a: number, b: number) => { q._from = a; q._to = Math.min(b, a + 999); return q; },
      then: (res: any) => res({ data: mine.slice(q._from, q._to + 1), error: null }),
    };
    return q;
  } }) }) };
}
describe("countMissionsByUser against a 1,000-row API cap", () => {
  it("counts every person on the page even when the page's requests exceed 1,000 rows", async () => {
    const rows = ["a", "b", "c"].flatMap((u) => Array.from({ length: 600 }, (_, i) => ({ id: `${u}${String(i).padStart(4, "0")}`, user_id: u, addon: null })));
    const got = await countMissionsByUser(capped(rows), ["a", "b", "c"]);
    expect([got.get("a"), got.get("b"), got.get("c")]).toEqual([600, 600, 600]);
  });
});
