import { afterAll, describe, expect, it } from "vitest";
import { reviewCard } from "../src/lib/agentMission/stage4/addonQuote";
import type { AddonRowInsert, AddonRowLike, AddonRowStore } from "../src/lib/agentMission/stage4/addonRow";
import { addonRowOf } from "./helpers/reviewQuoteWorld";
import { cleanMutants, loadMutant } from "./helpers/mutants";

/**
 * SAFETY ROUND, MUTATION TESTS for the insert classification (PR C): each test removes ONE protection from a copy of the source (tests/helpers/mutants.ts) and shows the property break. The SQL file has its own mutation evidence on a real local PostgreSQL
 * (docs/STAGE-4-FINANCIAL-SAFETY.md section 5). The real code is never modified.
 */
afterAll(cleanMutants);
const STORE = "src/lib/agentMission/stage4/addonRowStore.ts";
const ROW = "src/lib/agentMission/stage4/addonRow.ts";
const PG_INDEX = { code: "23505", message: 'duplicate key value violates unique constraint "missions_one_open_addon_per_file"' };
const PG_PK = { code: "23505", message: 'duplicate key value violates unique constraint "missions_pkey"' };
const row = (): AddonRowInsert => addonRowOf({ status: "plan_ready", kind: "review", base: 1 }) as unknown as AddonRowInsert;
const clientWith = (error: unknown) => ({ from: () => ({ insert: async () => ({ error }) }) });

describe("MUTATION: the insert classification", () => {
  it("without the index-name rule, a different request blocked by the index is reported as an unknown duplicate (the file's open request would not be looked up)", async () => {
    const m = await loadMutant(STORE, [{ from: 'if (message.includes(`"${OPEN_ADDON_INDEX_NAME}"`)) return { ok: false, duplicate: true, by: "other_open" };', to: "" }]);
    const r = await m.module.createSupabaseAddonRowStore(clientWith(PG_INDEX), "u-1").insert(row());
    expect(r.by).toBe("unknown");
  });
  it("without the primary-key rule, the same request inserted twice is reported as an unknown duplicate", async () => {
    const m = await loadMutant(STORE, [{ from: 'if (message.includes(`"${PK_CONSTRAINT_NAME}"`)) return { ok: false, duplicate: true, by: "same_id" };', to: "" }]);
    expect((await m.module.createSupabaseAddonRowStore(clientWith(PG_PK), "u-1").insert(row())).by).toBe("unknown");
  });
  it("if every error were a duplicate, a permission error would be read as «you have an open request» instead of failing (the unique test is the guard)", async () => {
    const m = await loadMutant(STORE, [{ from: "if (!unique) return { ok: false, duplicate: false };", to: "" }]);
    const r = await m.module.createSupabaseAddonRowStore(clientWith({ code: "42501", message: "permission denied for table missions" }), "u-1").insert(row());
    expect(r.duplicate).toBe(true);
  });
  it("without the `other_open` branch the creation answers with ITS OWN id, a request that was never made", async () => {
    const m = await loadMutant(ROW, [{ from: 'if (inserted.by === "other_open") {', to: "if (false) {" }]);
    const card = reviewCard(1000);
    if (!card.ok) throw new Error("card");
    const other = { id: "msn_otherrequest00000001", status: "executing", plan: addonRowOf({ status: "executing", kind: "edit", base: 2 }).plan, job_id: "job_x", approved_at: "2026-11-04T10:00:00.000Z" } as AddonRowLike;
    let listed = 0;
    const store: AddonRowStore = { listFor: async () => (listed++ === 0 ? [] : [other]), insert: async () => ({ ok: false, duplicate: true, by: "other_open" }), cancelUnpaid: async () => false };
    const out = await m.module.createAddonRow(store, { userId: "u-1", of: "msn_5851abc92a1e6645a9cd", kind: "review", baseVersion: 1, latestVersion: 1, request: { kind: "review" }, pricing: card.pricing, requestText: "طلب مراجعة" });
    expect(out.existingId, "the mutant names a row that does not exist").not.toBe(other.id);
  });
});
