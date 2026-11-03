import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { buildMissionFiles } from "../agent/src/workbook";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../src/lib/agentMission/repliesCard";
import { replayGateway } from "./helpers/replayGateway";
import { cellsOf } from "./helpers/round11Worlds";

/**
 * ROUND 12, item 2: WHICH FIELD PRODUCED THE «0» IN «عدد الردود» OF THE INSTAGRAM FILE OF LIVE ROUND 11 (msn_97cdab58dc82fc2039ed), on the REAL pages and rows of that mission (the owner's admin ZIP, anonymised).
 * Findings (read in the stored pages and rows, and by rebuilding the file from the real rows with the code of #357, before #358):
 *   - the live comments tool (`anyapi.instagram.post.comments`, calls 3 to 6: 16 + 11 + 17 + 13 = 57 comment rows) answers `replies: null` on EVERY comment row: the source gave no counter and no 0;
 *   - the delivered rows (`rows/comments.json`, 30 comments) hold `replies_count: ""` on all 30: no 0 was stored either; the file BUILT from those rows by the code before #358 had an EMPTY «عدد الردود» on every comment (the 0 in «الإعجابات» is the likes: 17 of the 30 comments have 0 likes);
 *   - the only 0 that was made from the missing counter was the planning sentence «٠ ردًا بحسب عدّادات ٢٧ تعليقًا» (`Number(null)` is 0), which #358 closed with the file's «غير متاح».
 * So the 0 the reviewer read was not in a counter field of the source or of the stored rows. These tests pin the facts on the real data, and that the file of #358 says «غير متاح» on every one of the 30 comments.
 */
const catalog = loadTregCatalog();
const M = "msn_97cdab58dc82fc2039ed";
const read = (rel: string) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M}/${rel}.json`, import.meta.url), "utf8"));
const comments = cardOf("anyapi.instagram.post.comments")!;

describe("the live comments pages", () => {
  it("57 comment rows in four real pages, every one with `replies: null` (the source gives no reply counter)", () => {
    const pages = [3, 4, 5, 6].map((n) => read(`raw/call_000${n}`).output.data.comments as Array<Record<string, unknown>>);
    expect(pages.map((p) => p.length)).toEqual([16, 11, 17, 13]);
    for (const row of pages.flat()) { expect("replies" in row).toBe(true); expect(row.replies).toBeNull(); }
  });
  it("the card maps them with no counter at all (no 0, nothing)", () => {
    for (const n of [3, 4, 5, 6]) for (const r of mapPage(comments, read(`raw/call_000${n}`))) expect(r.replies_count ?? null).toBeNull();
  });
});

describe("the delivered rows and the file built from them", () => {
  it("the stored rows hold an empty counter on all 30 comments and 9 replies; 17 of the 30 comments have 0 likes (the zeros of the file are the likes)", () => {
    const rows = read("rows/comments") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.replies_count === "")).toBe(true);
    expect(rows.filter((r) => String(r.likes) === "0")).toHaveLength(17);
    expect(read("rows/comments_replies")).toHaveLength(9);
  });
  it("the file of the current code: «عدد الردود» says «غير متاح» on all 30 comments, and the likes column still says its own numbers", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
    const M16 = "msn_e3e7632e2fb2d42f9c19";
    const store = createMemoryStore();
    const { gateway } = replayGateway(M16, catalog, store, "msn_r12_ig");
    const out = await planByCompiler({ mission: { id: "msn_r12_ig", request_text: fixture.missions.find((m) => m.id === M16)!.request, answer_text: null, created_at: "2026-11-03T13:34:59Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-03T13:35:20Z") });
    if (out.kind !== "plan") throw new Error(out.kind);
    const rows: Record<string, Array<Record<string, unknown>>> = { posts: read("rows/posts"), comments: read("rows/comments"), comments_replies: read("rows/comments_replies") };
    const plan = withRepliesJudged(reportedPlan(withPromiseCaps(out.plan), Object.fromEntries(out.plan.stages.map((s) => [s.key, rows[s.key].length]))), rows, () => true);
    const built = await buildMissionFiles(plan, rows, undefined, undefined, { repliesJudged: true });
    const sheets = await cellsOf(built.xlsx);
    const name = Object.keys(sheets).find((n) => /تعليق/.test(n))!;
    const [head, ...body] = sheets[name];
    const kind = head.indexOf("نوع التعليق"), replyAt = head.indexOf("عدد الردود"), likesAt = head.indexOf("الإعجابات");
    const commentRows = body.filter((r) => r[kind] === "تعليق");
    expect(commentRows).toHaveLength(30);
    for (const r of commentRows) expect(r[replyAt]).toBe("غير متاح");
    expect(commentRows.filter((r) => r[likesAt] === "0")).toHaveLength(17);
    expect(body.filter((r) => r[kind] === "رد")).toHaveLength(9);
  }, 60_000);
});
