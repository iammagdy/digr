import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tiktokWorld, xWorld } from "./helpers/round11Worlds";
import { MATCH_COUNTS_PREFIX_AR } from "../src/lib/agentMission/foundation/compilePlan";

/**
 * TIKTOK AND X ARE CUSTOMERS' TOOLS (live round 11). The pinned hashes below are of the plan, the customer's plan view and the file (every cell of every sheet) that the stored real pages of TikTok (M12) and X (M14 and msn_50e3b83c44e7ebd7f577) gave on
 * `main` BEFORE round 11 (6197074), produced by tests/helpers/round11Worlds.ts. Round 11 changes exactly two things for them, both asked by the owner, and each is removed below before the hash is compared, so the diff is stated and nothing else moved:
 *   - the TOPIC MARK is always on the parent sheet whenever the Ask has a topic (X had none: its stage gains the column «علاقة النص بالموضوع» and each chosen tweet its value; TikTok's M12 plan already had it);
 *   - a COUNTER THE SOURCE DOES NOT GIVE reads «غير متاح» in the file: on TikTok's stored delivery the 20 reply rows of the comments sheet had an empty «عدد الردود» (the replies tool carries no counter of a reply), which now reads «غير متاح».
 * Every other byte of the plan, the view and the file is what it was.
 */
const sha = (v: unknown): string => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v, null, 1)).digest("hex").slice(0, 16);
const BASE = {
  tiktok: { plan: "64ac1c1f853a75d8", view: "2913468a4b2c2011", cells: "59ba5e3413bfa6d4" },
  // CHANGED (NOV 6 2026 CAMPAIGN, msn_d31f37958788a24ec46d): an X parent is an ORIGINAL post (a tweet that is itself a reply is never chosen, the card counts the ones left out) and, with the replies asked, the tweets are the most engaged
  // («Top»): the M14 page holds 20 tweets of which 9 are originals, so the plan, its view and the file are re-pinned here (before: plan a5d7cb783a72fb6d, view 70e91a16497dd798, cells 1371f3d7a2ac1209)
  x: { plan: "d693a8da6f2521a4", view: "0acbd23faf4cac1e", cells: "c5f472b49aafe654" },
};

// CHANGED (round 14): three more stated diffs, each removed or set apart before the hash is compared. (1) the plan carries `compiled.conditions` (the delivery contract reads which conditions the request set); (2) the FIRST sheet (the summary: its promised number, its limits and its methodology lines) is set apart: round 14 makes
// the promised number the card's on every surface, and the gap lines name the parent; its changes are listed in HANDOFF (round 14), cell by cell; (3) every other sheet is hashed as it was (with the stated round-11 diffs put back). The pinned cell hashes below are of the data sheets only, taken on bc7cdc1.
const withoutConditions = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(withoutConditions);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "conditions").map(([k, x]) => [k, withoutConditions(x)]));
  return v;
};
// CHANGED (round 16): one more stated diff, set apart before the hash is compared: the card's sentence of how many selected items match the customer's conditions (the sentence starts with MATCH_COUNTS_PREFIX_AR and is one string of `notes_ar` in the plan and in the customer's view). The old unmet-conditions sentence is untouched.
const withoutMatchCounts = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.filter((x) => !(typeof x === "string" && x.startsWith(MATCH_COUNTS_PREFIX_AR))).map(withoutMatchCounts);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, withoutMatchCounts(x)]));
  return v;
};
// CHANGED (NOV 7 2026): one more stated diff, set apart before the hash is compared: each public stage carries `links_whole: true` (its sample links are shown whole, sampleLinks.ts). Every other byte of the view is what it was (no link of these plans was longer than 120 characters).
const withoutLinksWhole = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(withoutLinksWhole);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "links_whole").map(([k, x]) => [k, withoutLinksWhole(x)]));
  return v;
};
const dataSheets = (cells: Record<string, string[][]>): Record<string, string[][]> => Object.fromEntries(Object.entries(cells).slice(1));

/** The topic mark taken out: its column entry and its value on every row, anywhere in the document. */
function withoutTopicMark(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !(x && typeof x === "object" && (x as { key?: unknown }).key === "topic_relation")).map(withoutTopicMark);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "topic_relation").map(([k, x]) => [k, withoutTopicMark(x)]));
  return v;
}

describe("TikTok: the plan and the customer's view are byte for byte what they were; the file differs in one stated cell kind only", () => {
  it("plan and view", async () => {
    const w = await tiktokWorld();
    expect(sha(withoutMatchCounts(withoutConditions(w.plan)))).toBe(BASE.tiktok.plan);
    expect(sha(withoutLinksWhole(withoutMatchCounts(w.view)))).toBe(BASE.tiktok.view);
  }, 120_000);
  it("the file: the only change is «عدد الردود» of the reply rows (20 cells, empty -> «غير متاح»); with those put back the file is the old one", async () => {
    const w = await tiktokWorld();
    let changed = 0;
    const back: Record<string, string[][]> = {};
    for (const [name, rows] of Object.entries(w.cells)) {
      const at = rows[0].indexOf("عدد الردود");
      back[name] = rows.map((r, i) => (i > 0 && at >= 0 && r[at] === "غير متاح" ? (changed += 1, r.map((c, j) => (j === at ? "" : c))) : r));
    }
    // CHANGED (round 14): the delivery contract (R4) fills a mark cell the request set (here the country «مصر») that the source left blank with «غير متاح من المصدر»: 2 cells of the videos sheet, put back before the hash
    let country = 0;
    for (const name of Object.keys(back)) back[name] = back[name].map((r, i) => (i > 0 ? r.map((c) => (c === "غير متاح من المصدر" ? (country += 1, "") : c)) : r));
    expect(country).toBe(2);
    expect(changed).toBe(20);
    expect(Object.entries(w.cells).filter(([, rows]) => rows[0].includes("عدد الردود")).map(([n]) => n)).toEqual(["التعليقات"]);
    expect(sha(dataSheets(back))).toBe(BASE.tiktok.cells);
  }, 120_000);
});

describe("X: the plan, the view and the file are what they were, plus the topic mark", () => {
  it("with the topic mark taken out, the plan and the view are the old ones; the mark itself is there on every chosen tweet", async () => {
    const w = await xWorld();
    expect(sha(withoutTopicMark(withoutMatchCounts(withoutConditions(w.plan))))).toBe(BASE.x.plan);
    expect(sha(withoutLinksWhole(withoutTopicMark(withoutMatchCounts(w.view))))).toBe(BASE.x.view);
    const pinned = (w.plan.stages[0].pinned_rows ?? []) as Array<Record<string, unknown>>;
    expect(pinned.length).toBeGreaterThan(0);
    for (const r of pinned) expect(typeof r.topic_relation).toBe("string");
    for (const r of pinned) expect(r.is_reply).not.toBe(true);
    expect(w.plan.stages[0].columns.map((c) => c.key)).toContain("topic_relation");
  }, 120_000);
  it("the file: the tweets sheet has one more column, «علاقة النص بالموضوع»; with it taken out the file is the old one (no counter was missing, so no «غير متاح»)", async () => {
    const w = await xWorld();
    const back: Record<string, string[][]> = {};
    // CHANGED (round 27): one more stated diff, taken out before the hash: the replies sheet keeps its counter column «عدد الردود». The workbook used to merge a column into another when their values were the same on 80% of the rows (here the replies' counter and their likes were both «2»); a counter is never merged now (live: «الحفظ» was missing from one TikTok file).
    const counterSheets: string[] = [];
    for (const [name, rows] of Object.entries(w.cells)) {
      const drop = ["علاقة النص بالموضوع", ...(name === "الردود" ? ["عدد الردود"] : [])].map((h) => rows[0].indexOf(h)).filter((at) => at >= 0);
      if (name === "الردود" && rows[0].includes("عدد الردود")) counterSheets.push(name);
      back[name] = drop.length === 0 ? rows : rows.map((r) => r.filter((_, j) => !drop.includes(j)));
    }
    expect(counterSheets).toEqual(["الردود"]);
    expect(JSON.stringify(w.cells)).not.toContain("غير متاح");
    expect(Object.entries(w.cells).filter(([, rows]) => rows[0].includes("علاقة النص بالموضوع")).map(([n]) => n)).toEqual(["التغريدات"]);
    expect(sha(dataSheets(back))).toBe(BASE.x.cells);
  }, 120_000);
});
