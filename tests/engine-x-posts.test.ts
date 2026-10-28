import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { createCdnStaleStore } from "./helpers/cdnStaleStore";
import { ENDPOINT, PER_PAGE, pages, planning } from "./helpers/engineXScenario";
import { readSnapshot } from "../agent/src/items/itemStore";

describe("X posts: the code engine carries the approved plan out (the model planned, code executes)", () => {
  it("every found item is checked, the pages are read until 300 MATCHING tweets are saved, and the file, the delivered count and the charge are one number", async () => {
    const r = await replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)] });
    // no model session ran: the execution driver was never asked for anything
    expect(r.executionDriver.results).toEqual([]);
    // the plan carries the recipe code proved on the measured page
    expect(r.plannedPlan.stages[0].engine).toMatchObject({ endpoint_id: ENDPOINT, cursor_param: "cursor", parent_binding: null });
    assertReplayInvariants(r, { expectDelivered: 300 });
    // 80% match: 300 matching tweets need 19 pages of 20 (one planning call + 19 reads); the source was NOT read to its end
    expect(r.call.mock.calls.length).toBe(1 + 19);
    // the item store: found = new + duplicates, new = accepted + excluded + pending + unchecked; every found item was checked
    const snap = await readSnapshot(r.store, r.missionId);
    const c = snap.counts("tweets");
    expect(c.found).toBe(19 * PER_PAGE);
    expect(c.found).toBe(c.new + c.duplicates);
    expect(c.new).toBe(c.accepted + c.excluded + c.pending + c.unchecked);
    expect(c).toMatchObject({ accepted: 300, pending: 0, unchecked: 0, duplicates: 0, pages: 19 });
    expect(snap.stage("tweets").stop).toBe("target_reached");
    // delivered = the items in the file = the charge basis
    const wb = await readWorkbook(r);
    expect(wb.getWorksheet("التغريدات")!.rowCount).toBe(301);
    expect(r.mission.delivered_units).toBe(300);
    expect(r.mission.charged_points).toBe(200);
    // the tracker's final number is the file's count, and so is every text
    expect(r.finalView.steps[0]).toMatchObject({ countAr: "٣٠٠ من ٣٠٠ تغريدة", savedN: 300, plannedN: 300 });
    expect(r.finalView.resultLinesAr).toEqual(["تم تسليم ٣٠٠ من ٣٠٠ تغريدة.", "خُصم ٢٠٠ نقطة مقابل ٣٠٠ تغريدة."]);
    expect(r.notices[0].facts).toMatchObject({ delivered: 300, chargedPoints: 200 });
  });

  it("the same mission on a store that serves OVERWRITTEN objects stale (the real storage CDN) delivers the same 300: nothing the engine reads is ever overwritten", async () => {
    const store = createCdnStaleStore({ staleReads: 5 });
    const r = await replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)], makeStore: () => store });
    assertReplayInvariants(r, { expectDelivered: 300 });
    expect(r.finalView.steps[0]).toMatchObject({ countAr: "٣٠٠ من ٣٠٠ تغريدة" });
    // the store HAS overwritten objects (the run state, the review account, the older-reader copies) and HAS served stale reads of them: the item log is not among them
    expect(store.overwrites.length).toBeGreaterThan(0);
    expect(store.overwrites.some((k) => k.includes("/items/"))).toBe(false);
    expect(store.staleServed.some((k) => k.includes("/items/"))).toBe(false);
    expect((await readWorkbook(r)).getWorksheet("التغريدات")!.rowCount).toBe(301);
  });
});
