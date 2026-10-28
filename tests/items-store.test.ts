import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore, loadSegments, readSnapshot, type Op } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { createReviewer, type ReviewCall } from "../agent/src/review";
import { createCdnStaleStore } from "./helpers/cdnStaleStore";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import type { RelevanceSpec } from "../src/lib/agentMission/relevance";

/**
 * THE ONE ITEM STORE, proved on the semantics of the REAL storage, not on a map in memory: an overwritten object is served stale by the CDN (see cdnStaleStore.ts), a new object never is, the listing is exact. The live run of
 * 2026-10-28 (msn_3e6b…: a tracker at 300 of 300, a charge for 192, a file of 77) is replayed below.
 */
const MISSION = "msn_items01";
const SPEC: RelevanceSpec = { subject_ar: "محمد صلاح لاعب كرة القدم", terms: ["محمد صلاح"], text_columns: ["text"], min_own_words: 0 };
const stage = (over: Partial<PricedStage> = {}): PricedStage => ({ key: "tweets", title_ar: "التغريدات", endpoint_id: "e", expected_rows: 300, planned_rows: 300, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص التغريدة" }], sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over }) as PricedStage;
const planOf = (s: PricedStage = stage()): PricedPlan => ({ summary_ar: "x", stages: [s], price: { deliveredRows: s.planned_rows } } as unknown as PricedPlan);
const tweets = (from: number, n: number, about = true) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}`, text: about ? `محمد صلاح يسجل هدفًا رقم ${from + i}` : `أخبار عامة رقم ${from + i}` }));
const deps = (items: ItemStore, plan: PricedPlan, reviewer?: Parameters<typeof ingestRows>[0]["reviewer"]) => ({ items, plan, reviewer, addEvent: async () => {} });

describe("A. the store is append-only: nothing is ever read, extended and overwritten", () => {
  it("every commit is one CREATE-ONLY object under items/; an existing path is never replaced", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);
    await ingestRows(deps(items, planOf()), stage(), tweets(0, 5));
    await ingestRows(deps(items, planOf()), stage(), tweets(5, 5));
    const listed = await store.listFiles(MISSION, "items");
    expect(listed).toHaveLength(2);
    expect(listed.every((f) => /^items\/seg_\d{9}_[a-z0-9]+\.json$/.test(f.name))).toBe(true);
    // a second create-only write to an existing path leaves the first content as it was
    await store.putNew(MISSION, listed[0].name, "SOMETHING ELSE", "application/json");
    expect(await store.getFile(MISSION, listed[0].name)).not.toBe("SOMETHING ELSE");
  });

  it("the counts follow the definitions: found = new + duplicates; new = accepted + excluded + pending + unchecked; saved = accepted", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);
    const plan = planOf(stage({ relevance: SPEC }));
    // 10 about the topic, 4 not, then the same 6 again (duplicates)
    await ingestRows(deps(items, plan), plan.stages[0], [...tweets(0, 10), ...tweets(100, 4, false)]);
    await ingestRows(deps(items, plan), plan.stages[0], tweets(0, 6));
    const c = items.counts("tweets");
    expect(c).toMatchObject({ found: 20, new: 14, duplicates: 6, accepted: 10, excluded: 4, excludedRelevance: 4, pending: 0, unchecked: 0, saved: 10, checked: 14 });
    expect(c.found).toBe(c.new + c.duplicates);
    expect(c.new).toBe(c.accepted + c.excluded + c.pending + c.unchecked);
  });

  it("items the review could not reach stay PENDING (never thrown away) and are asked again; the count identity holds", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);
    // «محمد» alone is a weak term: no context word → uncertain → the model decides
    const spec: RelevanceSpec = { subject_ar: "اللاعب", terms: ["صلاح"], context_terms: ["هدف"], text_columns: ["text"], min_own_words: 0 };
    const plan = planOf(stage({ relevance: spec }));
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, text: `أعتقد أن صلاح لاعب مختلف رقم ${i}` }));
    let calls = 0;
    const call: ReviewCall = async ({ user }) => { calls += 1; const n = (user.match(/^\d+\./gm) ?? []).length; return { text: JSON.stringify(Array(n).fill(1)), usage: { input_tokens: 100, output_tokens: 10 } }; };
    // a review budget too small for any call: the six items wait
    const starved = createReviewer({ call, store, missionId: MISSION, requestText: "صلاح", budgetUsd: 0 });
    await ingestRows(deps(items, plan, starved), plan.stages[0], rows);
    expect(items.counts("tweets")).toMatchObject({ found: 6, new: 6, pending: 6, accepted: 0, unchecked: 0 });
    expect(calls).toBe(0);
    // later, with budget, the same call (no new items) decides them
    const funded = createReviewer({ call, store, missionId: MISSION, requestText: "صلاح", budgetUsd: 1 });
    const again = await ingestRows(deps(items, plan, funded), plan.stages[0], []);
    expect(again.newlyAccepted).toBe(6);
    expect(items.counts("tweets")).toMatchObject({ pending: 0, accepted: 6, acceptedByModel: 6 });
  });
});

describe("B. nothing is lost to concurrent writes, on a store with the real storage's stale reads", () => {
  it("60 batches at once (overlapping items included): every item is saved exactly once, in the log read FRESH from storage", async () => {
    const store = createCdnStaleStore({ staleReads: 20 });
    const items = await ItemStore.open(store, MISSION);
    const plan = planOf(stage({ planned_rows: 1000, expected_rows: 1000 }));
    // batch k holds items 10k .. 10k+14: neighbours overlap by 5
    await Promise.all(Array.from({ length: 60 }, (_, k) => ingestRows(deps(items, plan), plan.stages[0], tweets(k * 10, 15))));
    const expectedIds = new Set(Array.from({ length: 60 * 10 + 5 }, (_, i) => `t${i}`));
    const fresh = await readSnapshot(store, MISSION);
    expect(fresh.counts("tweets")).toMatchObject({ new: expectedIds.size, accepted: expectedIds.size, duplicates: 60 * 15 - expectedIds.size });
    expect(new Set(fresh.acceptedRows("tweets").map((r) => r.id))).toEqual(expectedIds);
    // the memory of the writer and the log agree
    expect(items.counts("tweets")).toEqual(fresh.counts("tweets"));
    expect(store.overwrites.filter((k) => k.includes("/items/"))).toEqual([]);
  });

  it("the OLD design (one object read, extended, overwritten) LOSES items on the same store: this is the defect of the live run", async () => {
    const store = createCdnStaleStore({ staleReads: 3 });
    const path = "rows/tweets.json";
    // exactly the old save: read the saved rows, add the new ones, write the whole object back
    const oldSave = async (batch: Array<{ id: string }>) => {
      const raw = await store.getFile(MISSION, path);
      const existing: Array<{ id: string }> = raw ? JSON.parse(raw) : [];
      const have = new Set(existing.map((r) => r.id));
      for (const r of batch) if (!have.has(r.id)) existing.push(r);
      await store.putFile(MISSION, path, JSON.stringify(existing), "application/json");
    };
    for (let k = 0; k < 6; k += 1) await oldSave(tweets(k * 50, 50));
    const saved = JSON.parse((await store.getFile(MISSION, path))!);
    // six saves of 50 distinct items, one after the other (no concurrency at all): the object does not hold 300
    expect(saved.length).toBeLessThan(300);
    expect(store.staleServed.length).toBeGreaterThan(0);
  });

  it("a second writer (a worker that took the mission over while the first is still finishing) appends under its own name and never over anything; every reader folds the log the same way", async () => {
    const store = createMemoryStore();
    const a = await ItemStore.open(store, MISSION, { writerId: "aaaaaaaa" });
    const b = await ItemStore.open(store, MISSION, { writerId: "bbbbbbbb" });
    const plan = planOf();
    await ingestRows(deps(a, plan), plan.stages[0], tweets(0, 10));
    await ingestRows(deps(b, plan), plan.stages[0], tweets(5, 10));
    const names = (await store.listFiles(MISSION, "items")).map((f) => f.name);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    // the first appearance of an id wins: the same 15 items for every reader, in the same order
    const one = await readSnapshot(store, MISSION);
    const two = await readSnapshot(store, MISSION);
    expect(one.acceptedRows("tweets").map((r) => r.id)).toEqual(two.acceptedRows("tweets").map((r) => r.id));
    expect(new Set(one.acceptedRows("tweets").map((r) => r.id)).size).toBe(15);
  });

  it("an unreadable segment is an ERROR, never a silent gap in the count", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);
    const plan = planOf();
    await ingestRows(deps(items, plan), plan.stages[0], tweets(0, 5));
    const [first] = await store.listFiles(MISSION, "items");
    store.files.set(`${MISSION}/${first.name}`, "{not json");
    await expect(loadSegments(store, MISSION)).rejects.toThrow(/could not be read/);
    await expect(ItemStore.open(store, MISSION)).rejects.toThrow();
  });

  it("a segment that cannot be stored throws and changes nothing: the memory is never ahead of the storage", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);
    const plan = planOf();
    await ingestRows(deps(items, plan), plan.stages[0], tweets(0, 5));
    const real = store.putNew.bind(store);
    store.putNew = async () => { throw new Error("storage is down"); };
    await expect(ingestRows(deps(items, plan), plan.stages[0], tweets(5, 5))).rejects.toThrow(/not stored/);
    expect(items.counts("tweets").accepted).toBe(5);
    store.putNew = real;
    // the same items come again and are saved as new
    await ingestRows(deps(items, plan), plan.stages[0], tweets(5, 5));
    expect(items.counts("tweets")).toMatchObject({ accepted: 10, duplicates: 0 });
  });
});

describe("C. a resumed mission continues from its log", () => {
  it("open() reads every segment: the counts, the source's cursor and the stop reasons are the ones the first run left", async () => {
    const store = createMemoryStore();
    const first = await ItemStore.open(store, MISSION);
    const plan = planOf();
    await ingestRows(deps(first, plan), plan.stages[0], tweets(0, 20), { page: { stream: "root", call_id: "call_0002", cursor_in: null, cursor_next: "cur_20", has_more: true, ended: false, rows_in_page: 20 } });
    await ingestRows(deps(first, plan), plan.stages[0], tweets(20, 20), { page: { stream: "root", call_id: "call_0003", cursor_in: "cur_20", cursor_next: "cur_40", has_more: true, ended: false, rows_in_page: 20 } });
    await first.commit([{ t: "stop", stage: "tweets", reason: "budget" }]);
    const second = await ItemStore.open(store, MISSION);
    expect(second.counts("tweets")).toEqual(first.counts("tweets"));
    expect(second.streamState("tweets", "root")).toMatchObject({ cursor: "cur_40", ended: false, pages: 2, rows: 40 });
    expect(second.stopReason("tweets")).toBe("budget");
    // the next segment continues the numbering (no collision with the first run's)
    await ingestRows(deps(second, plan), plan.stages[0], tweets(40, 5));
    const names = (await store.listFiles(MISSION, "items")).map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(4);
  });

  it("a mission an older worker started (rows in rows/<stage>.json, no log) is imported once", async () => {
    const store = createMemoryStore();
    await store.putFile(MISSION, "rows/tweets.json", JSON.stringify(tweets(0, 7)), "application/json");
    const items = await ItemStore.open(store, MISSION, { legacyStages: ["tweets"] });
    expect(items.counts("tweets")).toMatchObject({ accepted: 7, new: 7 });
    const again = await ItemStore.open(store, MISSION, { legacyStages: ["tweets"] });
    expect(again.counts("tweets").accepted).toBe(7);
    expect(await store.listFiles(MISSION, "items")).toHaveLength(1);
  });
});

describe("D. the live run of 2026-10-28 (msn_3e6b…, test account), replayed: 300 saved, 192 charged, 77 in the file", () => {
  // the save events of the real run: accepted 9, 77, 192, then a fourth save and the closing pass of finish, then the settlement read twice
  it("the old design on a stale-read store ends with FEWER items than were saved; the item store ends with every item and the same number everywhere", async () => {
    // ---- the old design
    const old = createCdnStaleStore({ staleReads: 2 });
    const path = "rows/tweets.json";
    const save = async (batch: Array<{ id: string }>) => {
      const raw = await old.getFile(MISSION, path);
      const existing: Array<{ id: string }> = raw ? JSON.parse(raw) : [];
      const have = new Set(existing.map((r) => r.id));
      for (const r of batch) if (!have.has(r.id)) existing.push(r);
      await old.putFile(MISSION, path, JSON.stringify(existing), "application/json");
      return existing.length;
    };
    const reported = [await save(tweets(0, 9)), await save(tweets(9, 68)), await save(tweets(77, 115)), await save(tweets(192, 108))];
    await save([]); // the closing pass of finish: «save nothing, ask the pending again»
    const settled = JSON.parse((await old.getFile(MISSION, path))!).length;
    // 300 distinct items were handed to the four saves; the object the settlement counts holds fewer (the saves themselves cannot tell: each read an older version and counted from it)
    expect(reported).toHaveLength(4);
    expect(settled).toBeLessThan(300);
    // ---- the item store, the same batches, the same store semantics
    const store = createCdnStaleStore({ staleReads: 2 });
    const items = await ItemStore.open(store, MISSION);
    const plan = planOf();
    const counts: number[] = [];
    for (const b of [tweets(0, 9), tweets(9, 68), tweets(77, 115), tweets(192, 108)]) { await ingestRows(deps(items, plan), plan.stages[0], b); counts.push(items.counts("tweets").accepted); }
    await ingestRows(deps(items, plan), plan.stages[0], []);
    expect(counts).toEqual([9, 77, 192, 300]);
    // the settlement reads the log fresh, twice: both times 300, never 192 and never 77
    for (let read = 0; read < 2; read += 1) expect((await readSnapshot(store, MISSION)).counts("tweets").saved).toBe(300);
    expect((await readSnapshot(store, MISSION)).acceptedRows("tweets", 300)).toHaveLength(300);
  });
});

describe("E. ops are plain data: a segment holds exactly what was committed", () => {
  it("commit appends one segment with the ops in order", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);
    const ops: Op[] = [{ t: "item", stage: "s", id: "a", state: "accepted", by: "rule", row: { id: "a" } }, { t: "dup", stage: "s", n: 2 }];
    await items.commit(ops);
    const [seg] = await loadSegments(store, MISSION);
    expect(seg.ops).toEqual(ops);
    expect(seg.seq).toBe(1);
  });
});
