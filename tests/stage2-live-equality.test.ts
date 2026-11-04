import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { ItemStore, type Op } from "../agent/src/items/itemStore";
import { buildMissionFiles } from "../agent/src/workbook";
import { buildLiveSnapshot, deliveryRowsOf } from "../agent/src/stage2/liveSnapshot";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../src/lib/agentMission/repliesCard";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { SUMMARY_SHEET_AR } from "../src/lib/modelPlanner/missionWorkbook";
import type { LiveSnapshot } from "../src/lib/agentMission/stage2/liveSheet";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { replayGateway } from "./helpers/replayGateway";
import { cellsOf } from "./helpers/round11Worlds";

/**
 * STAGE 2 (docs/STAGE-2.md), THE EQUALITY CONTRACT: at completion, the rows the customer watched in the live sheet ARE the rows of the file: the same sheets, the same headers, the same rows
 * in the same order, the same cells, the same de-duplication. The live snapshot is built from the ITEM LOG of a simulated run (the stored rows written batch by batch, with exact duplicates
 * and left-out items mixed in); the file is built the way runMission.ts builds it at finalize. Stored real missions (anonymised): M12 msn_5851abc92a1e6645a9cd (TikTok: videos, comments,
 * replies), msn_97cdab58dc82fc2039ed (Instagram rows of live round 11, planned on the pages of M16 msn_e3e7632e2fb2d42f9c19), M14 msn_b060d3347ed7660f972e (X: tweets).
 */
const catalog = loadTregCatalog();
type Row = Record<string, unknown>;
const read = (m: string, rel: string): any => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${m}/${rel}.json`, import.meta.url), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };

/** A run, simulated on the item log: each stage's rows in batches of `batch`, parents first, an exact duplicate of an earlier row in every batch, and one left-out item per batch. */
async function runLog(rowsByStage: Record<string, Row[]>, order: string[], batch = 7): Promise<{ log: ItemStore; snapshots: Array<() => ReturnType<ItemStore["snapshotOfMemory"]>> }> {
  const store = createMemoryStore();
  const log = await ItemStore.open(store, "msn_live_eq");
  const snapshots: Array<() => ReturnType<ItemStore["snapshotOfMemory"]>> = [];
  for (const key of order) {
    const rows = rowsByStage[key] ?? [];
    for (let i = 0; i < rows.length; i += batch) {
      const part = rows.slice(i, i + batch);
      const ops: Op[] = part.map((row) => ({ t: "item", stage: key, id: String(row.id), state: "accepted", by: "rule", row: { ...row } }));
      // an exact duplicate (the same id again): the log keeps the first appearance
      if (i > 0) ops.push({ t: "item", stage: key, id: String(rows[0].id), state: "accepted", by: "rule", row: { ...rows[0], text: "نسخة مكررة لا تظهر" } }, { t: "dup", stage: key, n: 1 });
      ops.push({ t: "item", stage: key, id: `left_out_${key}_${i}`, state: "excluded", reason: "target_reached", row: { id: `left_out_${key}_${i}` } });
      await log.commit(ops);
      snapshots.push(() => log.snapshotOfMemory());
    }
    await log.commit([{ t: "stop", stage: key, reason: "source_exhausted" }]);
  }
  return { log, snapshots };
}

/** The file, built the way runMission.ts builds it at finalize (written here on its own, not through the live builder). */
async function fileOf(approved: PricedPlan, log: ItemStore): Promise<Record<string, string[][]>> {
  const snap = log.snapshotOfMemory();
  let plan = withPromiseCaps(approved);
  const rowsByStage: Record<string, Row[]> = {};
  for (const s of plan.stages) rowsByStage[s.key] = snap.acceptedRows(s.key, s.planned_rows);
  plan = reportedPlan(plan, Object.fromEntries(plan.stages.map((s) => [s.key, rowsByStage[s.key].length])));
  const openKeys = new Set(plan.stages.filter((s) => s.replies_open || s.children_open).map((s) => s.key));
  if (openKeys.size > 0) plan = withRepliesJudged(plan, rowsByStage, (k) => { const st = snap.stage(k).stop; return !st || st === "source_exhausted"; });
  const built = await buildMissionFiles(plan, rowsByStage, undefined, undefined, { ...(openKeys.size > 0 ? { repliesJudged: true } : {}), approvedPlan: approved });
  return cellsOf(built.xlsx);
}

const trimEnd = (cells: string[]): string[] => { const c = [...cells]; while (c.length > 0 && c[c.length - 1] === "") c.pop(); return c; };

function expectEqual(live: LiveSnapshot, file: Record<string, string[][]>): void {
  const fileSheets = Object.keys(file).filter((n) => n !== SUMMARY_SHEET_AR);
  expect(live.sheets.map((s) => s.nameAr)).toEqual(fileSheets);
  for (const sheet of live.sheets) {
    const [head, ...body] = file[sheet.nameAr];
    expect(sheet.headers, sheet.nameAr).toEqual(trimEnd(head));
    expect(sheet.rows.length, sheet.nameAr).toBe(body.length);
    const idAt = sheet.headers.indexOf("المعرّف");
    expect(sheet.rows.map((r) => r.id)).toEqual(body.map((r) => r[idAt]));
    sheet.rows.forEach((r, i) => {
      const liveCells = trimEnd([...r.cells.map((c) => c.v), r.id, ...(r.parentId !== null ? [r.parentId] : [])]);
      expect(liveCells, `${sheet.nameAr} row ${i + 1}`).toEqual(trimEnd(body[i]));
    });
    // no id twice in a sheet (the log's de-duplication is the file's)
    expect(new Set(sheet.rows.map((r) => r.id)).size).toBe(sheet.rows.length);
  }
  const fileDelivered = live.sheets.reduce((n, s) => n + s.rows.length, 0);
  expect(live.delivered).toBe(fileDelivered);
}

async function m12(): Promise<{ plan: PricedPlan; rows: Record<string, Row[]> }> {
  const M12 = "msn_5851abc92a1e6645a9cd";
  const store = createMemoryStore();
  const { gateway } = replayGateway(M12, catalog, store, "msn_live_tt");
  const planned = await planByCompiler({ mission: { id: "msn_live_tt", request_text: "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم", answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-02T11:36:00Z") });
  if (planned.kind !== "plan") throw new Error(planned.kind);
  return { plan: planned.plan, rows: { videos: read(M12, "rows/videos"), comments: read(M12, "rows/comments"), comments_replies: read(M12, "rows/comments_replies") } };
}
async function instagram(): Promise<{ plan: PricedPlan; rows: Record<string, Row[]> }> {
  const M16 = "msn_e3e7632e2fb2d42f9c19";
  const R11 = "msn_97cdab58dc82fc2039ed";
  const store = createMemoryStore();
  const { gateway } = replayGateway(M16, catalog, store, "msn_live_ig");
  const planned = await planByCompiler({ mission: { id: "msn_live_ig", request_text: fixture.missions.find((m) => m.id === M16)!.request, answer_text: null, created_at: "2026-11-03T13:34:59Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-03T13:35:20Z") });
  if (planned.kind !== "plan") throw new Error(planned.kind);
  return { plan: planned.plan, rows: { posts: read(R11, "rows/posts"), comments: read(R11, "rows/comments"), comments_replies: read(R11, "rows/comments_replies") } };
}
function x(): { plan: PricedPlan; rows: Record<string, Row[]> } {
  const M14 = "msn_b060d3347ed7660f972e";
  const request = "هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود";
  const card = cardOf("anyapi.x.search.posts")!;
  const ask = buildAsk(request, null, Date.parse("2026-11-03T08:31:29Z"));
  const r = compilePlan({ ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0003", page: read(M14, "raw/call_0003") }] }, exposure: () => undefined, capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null, catalogOnly: true });
  if (!r.ok) throw new Error(r.reason);
  return { plan: r.plan as PricedPlan, rows: { tweets: read(M14, "rows/tweets") } };
}

describe("at completion the live sheet equals the file (stored real missions)", () => {
  it("M12 TikTok: videos, then comments with their replies under each (the thread sheet); the 20-per-video cap and the de-duplication are the file's", async () => {
    const { plan, rows } = await m12();
    const { log } = await runLog(rows, ["videos", "comments", "comments_replies"]);
    const live = buildLiveSnapshot({ missionId: "msn_live_tt", plan, snap: log.snapshotOfMemory(), status: "done", nowMs: 0 });
    expectEqual(live, await fileOf(plan, log));
    expect(live.sheets.map((s) => s.rows.length)).toEqual([2, expect.any(Number)]);
    expect(live.sheets[1].rows.filter((r) => r.cells.some((c) => c.v === "رد")).length).toBeGreaterThan(0);
    expect(live.counterAr).toMatch(/^[٠-٩٬]+ من [٠-٩٬]+$/);
  });
  it("Instagram (live round 11 rows, M16 plan): 2 posts, 30 comments and 9 replies; «غير متاح» counters are the file's", async () => {
    const { plan, rows } = await instagram();
    const { log } = await runLog(rows, ["posts", "comments", "comments_replies"], 4);
    const live = buildLiveSnapshot({ missionId: "msn_live_ig", plan, snap: log.snapshotOfMemory(), status: "done", nowMs: 0 });
    expectEqual(live, await fileOf(plan, log));
    expect(live.sheets[1].rows.some((r) => r.cells.some((c) => c.v === "غير متاح"))).toBe(true);
  });
  it("M14 X: 20 tweets, dates in Cairo time, the same order", async () => {
    const { plan, rows } = x();
    const { log } = await runLog(rows, ["tweets"], 6);
    const live = buildLiveSnapshot({ missionId: "msn_live_x", plan, snap: log.snapshotOfMemory(), status: "done", nowMs: 0 });
    expectEqual(live, await fileOf(plan, log));
    expect(live.sheets[0].rows).toHaveLength(20);
    const dated = live.sheets[0].rows[0].cells.find((c) => c.k === "date");
    expect(dated?.d).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("while the job runs", () => {
  it("every row shown mid-run is in the final file, in the same relative order, and the counter never goes down", async () => {
    const { plan, rows } = await m12();
    const { log, snapshots } = await runLog(rows, ["videos", "comments", "comments_replies"], 25);
    const final = buildLiveSnapshot({ missionId: "m", plan, snap: log.snapshotOfMemory(), status: "done", nowMs: 0 });
    const finalIds = final.sheets.map((s) => s.rows.map((r) => r.id));
    let last = 0;
    for (const at of snapshots) {
      const mid = buildLiveSnapshot({ missionId: "m", plan, snap: at(), status: "running", nowMs: 0 });
      expect(mid.delivered).toBeGreaterThanOrEqual(last);
      last = mid.delivered;
      mid.sheets.forEach((s, i) => {
        const ids = s.rows.map((r) => r.id);
        const positions = ids.map((id) => finalIds[i].indexOf(id));
        expect(positions.every((p) => p >= 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      });
    }
  });
  it("the cursor changes when the log grows and is stable when it does not", async () => {
    const { plan, rows } = x();
    const { log } = await runLog(rows, ["tweets"], 10);
    const a = buildLiveSnapshot({ missionId: "m", plan, snap: log.snapshotOfMemory(), status: "running", nowMs: 0 });
    const b = buildLiveSnapshot({ missionId: "m", plan, snap: log.snapshotOfMemory(), status: "running", nowMs: 5 });
    expect(a.cursor).toBe(b.cursor);
    await log.commit([{ t: "dup", stage: "tweets", n: 1 }]);
    expect(buildLiveSnapshot({ missionId: "m", plan, snap: log.snapshotOfMemory(), status: "running", nowMs: 0 }).cursor).not.toBe(a.cursor);
    expect(buildLiveSnapshot({ missionId: "m", plan, snap: log.snapshotOfMemory(), status: "done", nowMs: 0 }).cursor).not.toBe(a.cursor);
  });
});

describe("the live builder reads the rows the way runMission.ts does (a pin: change one, change the other)", () => {
  it("runMission.ts still reads the rows with these exact lines", () => {
    const src = readFileSync(new URL("../agent/src/runMission.ts", import.meta.url), "utf8");
    for (const line of [
      "plan = withPromiseCaps(plan);",
      "for (const s of plan.stages) rowsByStage[s.key] = snap.acceptedRows(s.key, s.planned_rows);",
      "plan = reportedPlan(plan, Object.fromEntries(plan.stages.map((s) => [s.key, rowsByStage[s.key].length])));",
      "const openKeys = new Set(plan.stages.filter((s) => s.replies_open || s.children_open).map((s) => s.key));",
      "if (hadOpenReplies) plan = withRepliesJudged(plan, rowsByStage, (k) => { const st = snap.stage(k).stop; return !st || st === \"source_exhausted\"; });",
      "const built = await buildMissionFiles(plan, rowsByStage,",
    ]) expect(src.includes(line), line).toBe(true);
    const live = readFileSync(new URL("../agent/src/stage2/liveSnapshot.ts", import.meta.url), "utf8");
    expect(live).toContain("rowsByStage[s.key] = snap.acceptedRows(s.key, s.planned_rows);");
    expect(live).toContain("deliveredSheetsOf(plan, rowsByStage, input.facts, input.companyMailboxes,");
    const wb = readFileSync(new URL("../agent/src/workbook.ts", import.meta.url), "utf8");
    expect(wb).toContain("= deliveredSheetsOf(plan, rowsIn, facts, companyMailboxes, options);");
  });
  it("deliveryRowsOf caps each stage at its planned rows, in log order", async () => {
    const { plan, rows } = await m12();
    const { log } = await runLog(rows, ["videos", "comments", "comments_replies"]);
    const d = deliveryRowsOf(plan, log.snapshotOfMemory());
    for (const s of d.plan.stages) expect(d.rowsByStage[s.key].length).toBeLessThanOrEqual(withPromiseCaps(plan).stages.find((x) => x.key === s.key)!.planned_rows);
    expect(d.rowsByStage.videos.map((r) => r.id)).toEqual(rows.videos.map((r) => r.id));
  });
});
