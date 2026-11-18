import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { backfillChainFinalLines } from "@/lib/server/multiProvider/finalLineBackfill";

function fake(state: any) {
  return {
    from(table: string) {
      let selected = "";
      const filters: Array<[string, unknown]> = [];
      const q: any = { select: (value: string) => { selected = value; state.selects.push(`${table}:${value}`); return q; }, eq: (k: string, v: unknown) => { filters.push([k, v]); return q; }, gte: () => q, order: () => q, limit: async () => ({ data: state.quotesList, error: null }), maybeSingle: async () => ({ data: state.jobs[filters.find(([k]) => k === "id")?.[1] as string] ?? null, error: null }), then: (resolve: any) => { const id = filters.find(([k]) => k === "job_id")?.[1] as string; if (state.eventThrow?.includes(id)) throw new Error("event read failed"); return resolve({ data: state.events[id] ?? [], error: state.eventError?.includes(id) ? new Error("event read failed") : null }); }, insert: (row: any) => { state.inserted.push(row); return Promise.resolve({ error: null }); } };
      return q;
    },
    storage: { from: () => ({ download: async (path: string) => state.files[path] ? { data: new Blob([state.files[path]]), error: null } : { data: null, error: new Error("missing") } }) },
  };
}

describe("backfillChainFinalLines", () => {
  it("selects exact quote/job columns, resolves deterministic ids, and skips non-chain, group, and non-quiet rows", async () => {
    const nowMs = Date.now();
    const quote = (id: string, capabilitySlug: string) => ({ id, user_id: "u", created_at: new Date(nowMs - 600_000).toISOString(), items: [{ capabilitySlug }] });
    const quotesList = [quote("q1", "mp-business-contacts"), quote("q2", "instagram_posts"), { ...quote("q3", "mp-business-contacts"), items: [{ capabilitySlug: "mp-business-contacts", params: { split: { v: 3 } } }] }, quote("q4", "mp-business-contacts")];
    const jobId = (id: string) => `job_quote_${createHash("md5").update(id).digest("hex")}`;
    const state = { quotesList, jobs: { [jobId("q1")]: { id: jobId("q1"), user_id: "u", status: "completed", delivered_units: 3, target_volume_max: 5, updated_at: new Date(nowMs - 181_000).toISOString() }, [jobId("q4")]: { id: jobId("q4"), user_id: "u", status: "completed", delivered_units: 5, target_volume_max: 5, updated_at: new Date(nowMs - 179_000).toISOString() } }, events: {}, eventError: [] as string[], eventThrow: [] as string[], files: {}, inserted: [] as any[], selects: [] as string[] };
    const result = await backfillChainFinalLines(fake(state), { nowMs });
    expect(result).toEqual({ considered: 4, written: 1 });
    expect(state.inserted[0]).toMatchObject({ job_id: jobId("q1"), user_id: "u" });
    expect(state.inserted[0].message).toContain("المسلَّم ٣ من ٥ مطلوب.");
    expect(state.selects).toContain("plans_quotes:id,user_id,items,created_at");
    expect(state.selects).toContain("jobs:id,user_id,status,delivered_units,target_volume_max,updated_at");
  });

  it("uses fallback for malformed file; suppresses duplicates and event-read failures; honors exact quiet boundary", async () => {
    const nowMs = Date.now();
    const ids = ["badjson", "existing", "eventerr", "boundary180", "boundary179", "full"];
    const jobId = (id: string) => `job_quote_${createHash("md5").update(id).digest("hex")}`;
    const quotesList = ids.map((id) => ({ id, user_id: "u", items: [{ capabilitySlug: "mp-business-contacts" }] }));
    const jobs = Object.fromEntries(ids.map((id) => [jobId(id), { id: jobId(id), user_id: "u", status: "completed", delivered_units: id === "full" ? 5 : 3, target_volume_max: 5, updated_at: new Date(nowMs - (id === "boundary180" ? 180_000 : id === "boundary179" ? 179_000 : 181_000)).toISOString() }]));
    const state = { quotesList, jobs, events: { [jobId("existing")]: [{ message: "المسلَّم ٣ من ٥ مطلوب." }] }, eventError: [jobId("eventerr")], eventThrow: [] as string[], files: { [`final_line/${jobId("badjson")}.json`]: "{" }, inserted: [] as any[], selects: [] as string[] };
    const result = await backfillChainFinalLines(fake(state), { nowMs });
    expect(result.written).toBe(3);
    expect(state.inserted.map((row) => row.job_id)).toEqual([jobId("badjson"), jobId("boundary180"), jobId("full")]);
    expect(state.inserted[0].message).toContain("السبب:");
    expect(state.inserted[2].message).toBe("المسلَّم ٥ من ٥ مطلوب.");
  });
});
