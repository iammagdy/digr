import { afterEach, describe, expect, it, vi } from "vitest";
import { directEngine, pageOf, type Out } from "./helpers/engineDirect";
import type { MemoryStore } from "../agent/src/memoryStore";
import { replay } from "./helpers/agentReplay";
import { planning } from "./helpers/engineXScenario";
import { tregResult } from "./helpers/agentFakeWorld";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * S1 item 1.3: THE COUNT GUARANTEE AND THE HONEST SHORTFALL (owner decision D6: the customer pays for N, rows beyond N are not delivered). In the redesigned mode the engine keeps reading, page after page, until the approved count N is reached or the source really
 * ends; an EMPTY page that still carries a next-page value is a barren page (two in a row end the read), not the end of the source. A shortfall is stated from the counts and the recorded stop reason, and charged for what was delivered.
 */
afterEach(() => { vi.unstubAllGlobals(); });
const A = "a.search.posts";

describe("the engine keeps reading until the approved count", () => {
  it("a source with 60 rows and an approved 50 delivers exactly 50 (the rest is kept out, never delivered)", async () => {
    const h = directEngine({ [A]: (_p, n): Out => ({ rows: pageOf("a", (n - 1) * 20 + 1, 20), next: n < 3 ? `c${n}` : null }) }, { redesign: true, planned: 50 });
    const { outcome, items } = await h.run();
    expect(items.acceptedRows("posts")).toHaveLength(50);
    expect(outcome.stops.posts).toBe("target_reached");
    expect(items.excludedItems("posts").every((i) => i.reason === "target_reached")).toBe(true);
  });
  it("a source with 30 rows and an approved 50 delivers 30 and the stop reason is the source's end", async () => {
    const h = directEngine({ [A]: (_p, n): Out => ({ rows: pageOf("a", (n - 1) * 20 + 1, n === 1 ? 20 : 10), next: n === 1 ? "c1" : null }) }, { redesign: true, planned: 50 });
    const { outcome, items } = await h.run();
    expect(items.acceptedRows("posts")).toHaveLength(30);
    expect(outcome.stops.posts).toBe("source_exhausted");
  });
  it("an EMPTY page that still carries a next-page value does not end the read: the page after it is read (redesigned mode)", async () => {
    const pages: Out[] = [{ rows: pageOf("a", 1, 20), next: "c1" }, { rows: [], next: "c2", hasMore: null }, { rows: pageOf("a", 21, 20), next: null }];
    const h = directEngine({ [A]: (_p, n): Out => pages[n - 1] ?? { rows: [], next: null } }, { redesign: true, planned: 40 });
    const { items } = await h.run();
    expect(items.acceptedRows("posts")).toHaveLength(40);
    expect(h.calls).toHaveLength(3);
  });
  it("two barren pages in a row still end the read (the guarantee never loops on a source that gives nothing)", async () => {
    const h = directEngine({ [A]: (_p, n): Out => (n === 1 ? { rows: pageOf("a", 1, 20), next: "c1" } : { rows: [], next: `c${n}`, hasMore: null }) }, { redesign: true, planned: 40 });
    const { outcome, items } = await h.run();
    expect(items.acceptedRows("posts")).toHaveLength(20);
    expect(outcome.stops.posts).toBe("no_new_items");
    expect(h.calls.length).toBeLessThanOrEqual(4);
  });
  it("flag off: an empty page ends the read as it always did", async () => {
    const pages: Out[] = [{ rows: pageOf("a", 1, 20), next: "c1" }, { rows: [], next: "c2", hasMore: null }, { rows: pageOf("a", 21, 20), next: null }];
    const h = directEngine({ [A]: (_p, n): Out => pages[n - 1] ?? { rows: [], next: null } }, { redesign: false, planned: 40 });
    const { items } = await h.run();
    expect(items.acceptedRows("posts")).toHaveLength(20);
    expect(h.calls).toHaveLength(2);
  });
});

describe("the shortfall is stated and charged for what was delivered", () => {
  const fifty = (): FakeStep[] => planning().map((st) => st.tool !== "propose_plan" ? st : { tool: "propose_plan", args: (r: unknown) => { const plan = (st.args as (r: unknown) => Record<string, any>)(r); plan.summary_ar = "ستحصل على ٥٠ تغريدة عن محمد صلاح مع نص كل تغريدة ورابطها."; plan.stages[0].expected_rows = 50; return plan; } } as FakeStep);
  const pg = (p: number, total: number) => tregResult({ output: { data: { items: Array.from({ length: Math.min(20, total - p * 20) }, (_, i) => { const n = p * 20 + i; return { id: `18${String(n).padStart(6, "0")}`, text: `محمد صلاح يسجل هدفًا رقم ${n} في المباراة`, url: `https://x.example/u/status/18${String(n).padStart(6, "0")}`, author: `user${n % 40}`, createdAt: "2026-10-20T10:00:00Z" }; }), nextCursor: (p + 1) * 20 < total ? `c${p + 1}` : null } } }, 0.00075);
  it("30 of 50 in raw mode: «٣٠ من ٥٠», the source's end as the reason, and the charge is for the 30 only", async () => {
    const r = await replay({ request: "هات ٥٠ تغريدة عن محمد صلاح", planning: fifty(), execution: () => [], answers: [pg(0, 30), pg(0, 30), pg(1, 30)], deps: (d) => { (d.store as MemoryStore).settings.redesign_flags = { social_posts: "on" }; return d; } });
    expect(r.mission.delivered_units).toBe(30);
    expect(r.finalView.resultLinesAr[0]).toBe("تم تسليم ٣٠ من ٥٠ تغريدة.");
    expect(r.notices[0].facts.shortfallClauseAr).toBe("لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب");
    expect(r.mission.charged_points).toBe(Math.ceil(30 * Number(r.mission.unit_price_points)));
    expect(Number(r.mission.charged_points)).toBeLessThanOrEqual(Number(r.mission.reserved_points));
  });
});
