import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { ItemStore, type Op } from "../agent/src/items/itemStore";
import { buildMissionFiles } from "../agent/src/workbook";
import { LIVE_MIN_INTERVAL_MS, createLiveWriter, liveSheetOn, liveSnapshotPath, writeDoneSnapshot } from "../agent/src/stage2/liveWriter";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../src/lib/agentMission/repliesCard";
import type { LiveSnapshot } from "../src/lib/agentMission/stage2/liveSheet";
import { SUMMARY_SHEET_AR } from "../src/lib/modelPlanner/missionWorkbook";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { replayGateway } from "./helpers/replayGateway";
import { cellsOf } from "./helpers/round11Worlds";

/**
 * STAGE 2 S6 (docs/STAGE-2.md): the worker writes the live sheet behind DIGER_STAGE2_LIVE_SHEET: create-only objects, at most one running snapshot per 5 seconds per mission plus one at
 * done; a failed write is logged and ignored; the LAST snapshot equals the file. Stored real rows of M12 (msn_5851abc92a1e6645a9cd), planned on its stored pages.
 */
const catalog = loadTregCatalog();
const M12 = "msn_5851abc92a1e6645a9cd";
const read = (rel: string): any => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M12}/${rel}.json`, import.meta.url), "utf8"));

async function m12Plan() {
  const store = createMemoryStore();
  const { gateway } = replayGateway(M12, catalog, store, "msn_s6");
  const planned = await planByCompiler({ mission: { id: "msn_s6", request_text: "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم", answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-02T11:36:00Z") });
  if (planned.kind !== "plan") throw new Error(planned.kind);
  return planned.plan;
}
const rows = (): Record<string, Array<Record<string, unknown>>> => ({ videos: read("rows/videos"), comments: read("rows/comments"), comments_replies: read("rows/comments_replies") });
const itemOps = (stage: string, list: Array<Record<string, unknown>>): Op[] => list.map((row) => ({ t: "item", stage, id: String(row.id), state: "accepted", by: "rule", row: { ...row } }));

describe("the flag", () => {
  it("unset (today): off, and the account is not even looked up; «test» asks; «on» is on", async () => {
    const isTest = vi.fn(async () => true);
    expect(await liveSheetOn(isTest, {})).toBe(false);
    expect(isTest).not.toHaveBeenCalled();
    expect(await liveSheetOn(isTest, { DIGER_STAGE2_LIVE_SHEET: "test" })).toBe(true);
    expect(await liveSheetOn(async () => false, { DIGER_STAGE2_LIVE_SHEET: "test" })).toBe(false);
    expect(await liveSheetOn(async () => { throw new Error("x"); }, { DIGER_STAGE2_LIVE_SHEET: "test" })).toBe(false);
    expect(await liveSheetOn(async () => false, { DIGER_STAGE2_LIVE_SHEET: "on" })).toBe(true);
  });
  it("runMission.ts writes nothing new unless the flag is on: the engine's events go straight to the store when it is off", () => {
    const src = readFileSync(new URL("../agent/src/runMission.ts", import.meta.url), "utf8");
    expect(src).toContain("const live = (await liveSheetOn(async () => redesignIsTest)) ? createLiveWriter(");
    expect(src).toContain("addEvent: live ? (e) => live.addEvent(e, () => store.addEvent(mission.id, e)) : (e) => store.addEvent(mission.id, e), deadlineMs,");
    expect(src).toContain("if (resultPath !== null && (await liveSheetOn(() => accountIsTest(store, mission.user_id)))) await writeDoneSnapshot(");
  });
});

describe("the running snapshots", () => {
  it("names are create-only and ordered by the item log; the done one sorts after the running one of the same seq", () => {
    expect(liveSnapshotPath(12, "ab12cd34")).toBe("live/snap_000000012_ab12cd34.json");
    expect(liveSnapshotPath(12, "ab12cd34", true)).toBe("live/snap_000000012_ab12cd34_done.json");
    expect([liveSnapshotPath(12, "ab12cd34", true), liveSnapshotPath(12, "ab12cd34"), liveSnapshotPath(9, "ab12cd34")].sort()).toEqual([liveSnapshotPath(9, "ab12cd34"), liveSnapshotPath(12, "ab12cd34"), liveSnapshotPath(12, "ab12cd34", true)]);
  });
  it("at most one per 5 seconds: ten events in one second write one snapshot; after 5 seconds and new items, a second; the events themselves are all stored", async () => {
    const plan = await m12Plan();
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_s6w");
    let clock = 1_000_000;
    const w = createLiveWriter({ store, missionId: "msn_s6w", plan, items, writerId: "w1", now: () => clock });
    const r = rows();
    await items.commit(itemOps("videos", r.videos));
    for (let i = 0; i < 10; i += 1) { await w.addEvent({ kind: "progress", message_ar: "x", counts: { stage: 1, saved: 2, planned: 2 } }, () => store.addEvent("msn_s6w", { kind: "progress", message_ar: "x" })); clock += 100; }
    await w.flush();
    expect(w.written()).toBe(1);
    expect(store.events.filter((e) => e.mission_id === "msn_s6w")).toHaveLength(10);
    clock += LIVE_MIN_INTERVAL_MS;
    await items.commit(itemOps("comments", r.comments.slice(0, 20)));
    await w.addEvent({ kind: "progress", message_ar: "x", counts: { stage: 2, saved: 20, planned: 40 } }, () => store.addEvent("msn_s6w", { kind: "progress", message_ar: "x" }));
    await w.flush();
    expect(w.written()).toBe(2);
    const names = (await store.listFiles("msn_s6w", "live")).map((f) => f.name);
    expect(names).toHaveLength(2);
    const last = JSON.parse((await store.getFile("msn_s6w", names[names.length - 1]))!) as LiveSnapshot;
    expect(last.status).toBe("running");
    expect(last.workLog.map((l) => l.code)).toContain("items_saved");
  });
  it("a write that fails is logged and ignored: the event is stored and the run goes on", async () => {
    const plan = await m12Plan();
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_s6f");
    await items.commit(itemOps("videos", rows().videos));
    const lines: string[] = [];
    const failing = { putNew: async () => { throw new Error("storage down"); } };
    const w = createLiveWriter({ store: failing, missionId: "msn_s6f", plan, items, writerId: "w1", log: (l) => lines.push(l) });
    await expect(w.addEvent({ kind: "progress", message_ar: "x" }, () => store.addEvent("msn_s6f", { kind: "progress", message_ar: "x" }))).resolves.toBeUndefined();
    await w.flush();
    expect(w.written()).toBe(0);
    expect(store.events.filter((e) => e.mission_id === "msn_s6f")).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("live_snapshot_not_written msn_s6f"))).toBe(true);
    expect(await writeDoneSnapshot({ store: failing, missionId: "msn_s6f", plan, snap: items.snapshotOfMemory(), writerId: "w1", nowMs: 0, log: (l) => lines.push(l) })).toBe(false);
  });
});

describe("the LAST snapshot equals the file", () => {
  it("M12: after the run, the done snapshot read back from storage has the file's sheets, headers, rows and cells", async () => {
    const approved = await m12Plan();
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_s6d");
    const r = rows();
    for (const key of ["videos", "comments", "comments_replies"]) for (let i = 0; i < r[key].length; i += 25) await items.commit(itemOps(key, r[key].slice(i, i + 25)));
    for (const key of ["videos", "comments", "comments_replies"]) await items.commit([{ t: "stop", stage: key, reason: "source_exhausted" }]);
    const snap = items.snapshotOfMemory();
    // the file, the way settleExecution builds it
    let plan = withPromiseCaps(approved);
    const rowsByStage: Record<string, Array<Record<string, unknown>>> = {};
    for (const s of plan.stages) rowsByStage[s.key] = snap.acceptedRows(s.key, s.planned_rows);
    plan = reportedPlan(plan, Object.fromEntries(plan.stages.map((s) => [s.key, rowsByStage[s.key].length])));
    const open = plan.stages.some((s) => s.replies_open || s.children_open);
    if (open) plan = withRepliesJudged(plan, rowsByStage, (k) => { const st = snap.stage(k).stop; return !st || st === "source_exhausted"; });
    const file = await cellsOf((await buildMissionFiles(plan, rowsByStage, undefined, undefined, { ...(open ? { repliesJudged: true } : {}), approvedPlan: approved })).xlsx);
    expect(await writeDoneSnapshot({ store, missionId: "msn_s6d", plan: approved, snap, writerId: "w1", nowMs: Date.now() })).toBe(true);
    const names = (await store.listFiles("msn_s6d", "live")).map((f) => f.name);
    const last = JSON.parse((await store.getFile("msn_s6d", names[names.length - 1]))!) as LiveSnapshot;
    expect(last.status).toBe("done");
    const trim = (c: string[]) => { const x = [...c]; while (x.length && x[x.length - 1] === "") x.pop(); return x; };
    expect(last.sheets.map((s) => s.nameAr)).toEqual(Object.keys(file).filter((n) => n !== SUMMARY_SHEET_AR));
    for (const sheet of last.sheets) {
      const [head, ...body] = file[sheet.nameAr];
      expect(sheet.headers).toEqual(trim(head));
      expect(sheet.rows.map((row) => trim([...row.cells.map((c) => c.v), row.id, ...(row.parentId !== null ? [row.parentId] : [])]))).toEqual(body.map(trim));
    }
  });
});
