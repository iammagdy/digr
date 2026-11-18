import { describe, expect, it } from "vitest";
import { backfillChainFinalLines } from "@/lib/server/multiProvider/finalLineBackfill";

function fake(state: any) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const q: any = { select: () => q, eq: (k: string, v: unknown) => { filters.push([k, v]); return q; }, gte: () => q, order: () => q, limit: async () => ({ data: state.jobs, error: null }), maybeSingle: async () => ({ data: state.quotes[filters.find(([k]) => k === "id")?.[1] as string] ?? null, error: null }), then: (resolve: any) => resolve({ data: state.events[filters.find(([k]) => k === "job_id")?.[1] as string] ?? [], error: null }), insert: (row: any) => { state.inserted.push(row); return Promise.resolve({ error: null }); } };
      return q;
    },
    storage: { from: () => ({ download: async (path: string) => state.files[path] ? { data: new Blob([state.files[path]]), error: null } : { data: null, error: new Error("missing") } }) },
  };
}

describe("backfillChainFinalLines", () => {
  it("writes a checked count line for quiet ordinary jobs and skips existing lines and group quotes", async () => {
    const state = { jobs: [{ id: "j1", quote_id: "q1", delivered_units: 3, target_volume_max: 5 }, { id: "j2", quote_id: "q2", delivered_units: 5, target_volume_max: 5 }, { id: "j3", quote_id: "q3", delivered_units: 1, target_volume_max: 2 }], quotes: { q1: { items: [] }, q2: { items: [] }, q3: { items: [{ params: { split: { v: 3 } } }] } }, events: { j2: [{ message: "المسلَّم موجود" }] }, files: {}, inserted: [] as any[] };
    const result = await backfillChainFinalLines(fake(state), { nowMs: Date.now() });
    expect(result).toEqual({ considered: 3, written: 1 });
    expect(state.inserted[0].message).toContain("المسلَّم ٣ من ٥ مطلوب.");
  });
});
