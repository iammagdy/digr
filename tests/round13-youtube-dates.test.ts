import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DECLARED_EXTRA_INPUTS, loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import ExcelJS from "exceljs";
import { buildMissionFiles } from "../agent/src/workbook";
import { APPROX_DATES_NOTE_AR, APPROX_WORD_AR } from "../src/lib/agentMission/relativeDates";
import { buildMethodology } from "../agent/src/methodology";
import { planByCompiler } from "../agent/src/compiled";
import { RAW_PATH } from "../agent/src/gateway";
import type { Gateway } from "../agent/src/gateway";
import { redesignStagesOf } from "../agent/src/redesign";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { APPROX_DATES_KEY, DATE_UNREAD_KEY, approxDayOf, dateUnreadColumnsOf, parseRelativeAge } from "../src/lib/agentMission/relativeDates";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { replayGateway } from "./helpers/replayGateway";

/**
 * ROUND 13 (3 Nov 2026), items 1 and 2: THE YOUTUBE COMMENT DATES AND THE ENGINE REPLAYED ON THE REAL PAGES of msn_41a73a6b2c0b4a76ef0a (live round 11: 2 videos, 95 comments, 4 replies delivered).
 *
 * What is REAL here: the pages (anonymised with anonymise.py), their ids, their counts, their Chinese relative texts («11个月前»: the tool's `language_code` defaults to zh-CN).
 * What is SYNTHETIC here: every ENGLISH relative text («3 days ago», «11 months ago», «1 year ago», «2 weeks ago», «5 hours ago», «... (edited)»). No real page of the comments tool asked with `language_code: "en"` is stored (no such call was ever made): the English forms are written by this test
 * over the real pages, in the shape the catalog's own example gives («1 year ago»). Whether the provider really answers these words for `language_code: "en"` is NOT proven until the live round.
 */
const catalog = loadTregCatalog();
const M = "msn_41a73a6b2c0b4a76ef0a";
const TARGET = "msn_r13_yt";
const COMMENTS_ENDPOINT = "tikhub.youtube.video.comments";
// the Cairo moment of the read: the live mission ran at 13:38 UTC on 3 Nov 2026 (every moment of this test is fixed; no test reads the clock)
const READ_AT = "2026-11-03T13:45:00.000Z";
const TYPES_OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" } as RedesignFlags;
const stored = (stage: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M}/rows/${stage}.json`, import.meta.url), "utf8"));
const REQUEST = "هات فيديوهين على يوتيوب عن نهائي السوبر المصري الأهلي والزمالك من القنوات الرسمية، مع كل التعليقات والردود.";

const sentTo = (gateway: ReturnType<typeof replayGateway>["gateway"], rewrite: ((page: Record<string, unknown>, callId: string) => Record<string, unknown>) | null, store: ReturnType<typeof createMemoryStore>) => ({
  async tregCall(input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) {
    const out = (await gateway.tregCall(input)) as { ok?: boolean; call_id?: string };
    if (rewrite && out.ok && String(input.endpoint_id) === COMMENTS_ENDPOINT && out.call_id) {
      const path = `${TARGET}/${RAW_PATH(out.call_id)}`;
      const body = store.files.get(path);
      if (typeof body === "string") store.files.set(path, JSON.stringify(rewrite(JSON.parse(body), out.call_id)));
    }
    return out;
  },
});

interface Run { videos: Array<Record<string, unknown>>; comments: Array<Record<string, unknown>>; replies: Array<Record<string, unknown>>; unserved: Array<{ endpointId: string; params: Record<string, unknown> }>; commentParams: Array<Record<string, unknown>>; stageParams: Record<string, unknown>; plan: import("../src/lib/agentMission/plan").PricedPlan }

/** Plans from the stored planning pages and runs the engine on the stored execution pages (the comments tool is compared by `video_id` and `continuation_token` only: the stored calls were made before `language_code` was sent). `rewrite` changes the comments pages the engine reads (the synthetic English forms). */
async function run(rewrite: ((page: Record<string, unknown>, callId: string) => Record<string, unknown>) | null): Promise<Run> {
  const store = createMemoryStore();
  const only = { "tikhub.x.youtube-web-search-channel": ["channel_id"], [COMMENTS_ENDPOINT]: ["video_id", "continuation_token"] };
  const planning = replayGateway(M, catalog, store, TARGET, { only, phase: "planning" });
  const planned = await planByCompiler({ mission: { id: TARGET, request_text: REQUEST, answer_text: null, created_at: "2026-11-03T13:38:44Z" }, gateway: planning.gateway, store, catalog, nowMs: Date.parse("2026-11-03T13:39:44Z"), occurrence: { kind: "latest" } });
  if (planned.kind !== "plan") throw new Error(`no plan: ${planned.kind}`);
  // THE LIVE CHOICE IS PINNED. The live mission chose its two videos on the REAL titles (stored plan: pinned gCut2DcB9sM and GIWkArP7RJE, SELECT on missions.plan); the stored titles are anonymised («نص_...», no topic word), so the compiler on them keeps the source's order (VZqp9F8ed2s, lLAE4Iy-JNI)
  // and the first two videos would have no stored comments page. The two live videos are among the replay plan's spares: they are made the pinned rows, as the live plan had them. Nothing else of the plan is changed.
  const videosStage = planned.plan.stages.find((s) => s.key === "videos")!;
  const pool = [...(videosStage.pinned_rows ?? []), ...(videosStage.spare_rows ?? [])];
  const LIVE = ["gCut2DcB9sM", "GIWkArP7RJE"];
  videosStage.pinned_rows = LIVE.map((id) => pool.find((r) => String(r.id) === id)!);
  videosStage.spare_rows = pool.filter((r) => !LIVE.includes(String(r.id)));
  for (const st of planned.plan.stages) if (st.parent_key === "videos") st.parent_pins = LIVE;
  // the call log keeps the first 80 characters of a token: the stored calls and the engine's own are compared on them
  const exec = replayGateway(M, catalog, store, TARGET, { firstSeq: 100, phase: "execution", only, cut80: { [COMMENTS_ENDPOINT]: ["continuation_token"], "anyapi.youtube.comment_replies": ["continuationToken"] } });
  const commentParams: Array<Record<string, unknown>> = [];
  const inner = exec.gateway;
  const spy = { async tregCall(input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) { if (String(input.endpoint_id) === COMMENTS_ENDPOINT) commentParams.push({ ...(input.params as Record<string, unknown>) }); return inner.tregCall(input); } };
  const items = await ItemStore.open(store, TARGET);
  const plan = planned.plan;
  await runEngine({ items, store, plan: withPromiseCaps(plan), missionId: TARGET, gateway: sentTo(spy as never, rewrite, store) as unknown as Gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(plan, TYPES_OFF, true, { youtube: "test" }) });
  return { videos: items.acceptedRows("videos"), comments: items.acceptedRows("comments"), replies: items.acceptedRows("comments_replies"), unserved: exec.stats.unserved, commentParams, stageParams: plan.stages.find((s) => s.key === "comments")!.engine!.params, plan };
}

describe("1a. the comments tool is asked in English, with an input the catalog declares", () => {
  it("`language_code` is a declared input of tikhub.youtube.video.comments in the pinned snapshot, so no code declaration is added (nothing in DECLARED_EXTRA_INPUTS for it)", () => {
    expect(catalog.byId.get(COMMENTS_ENDPOINT)!.inputs.some((i) => i.name === "language_code")).toBe(true);
    expect(Object.keys(DECLARED_EXTRA_INPUTS)).not.toContain(COMMENTS_ENDPOINT);
  });
  it("the card sends language_code \"en\" on every call of its stage, and no other fixed input", () => {
    expect(cardOf(COMMENTS_ENDPOINT)!.inputs.fixed).toEqual({ language_code: "en" });
  });
});

describe("1b. an English relative text is read as an approximate Cairo day from the moment of the read", () => {
  const now = Date.parse(READ_AT);
  const dayOf = (text: string) => { const age = parseRelativeAge(text, now); return age ? approxDayOf(age) : null; };
  // SYNTHETIC strings: the English forms are not yet seen on a real page
  it.each([
    ["3 days ago", "2026-10-31"],
    ["11 months ago", "2025-12-03"],
    ["1 year ago", "2025-11-03"],
    ["2 weeks ago", "2026-10-20"],
    ["5 hours ago", "2026-11-03"],
    ["3 days ago (edited)", "2026-10-31"],
    ["11 months ago (edited)", "2025-12-03"],
    ["1 hour ago", "2026-11-03"],
    ["Streamed 2 weeks ago", "2026-10-20"],
  ])("«%s» is the day %s", (text, day) => { expect(dayOf(text)).toBe(day); });
  it.each(["11个月前", "", "(edited)", "last Tuesday", "3 fortnights ago", "ago 3 days", "3 days", "yesterday-ish maybe", "1001 days ago"])("«%s» is not a relative age the code can read", (text) => { expect(dayOf(text)).toBeNull(); });
});

describe("2. the engine replayed on the real pages of msn_41a73a6b2c0b4a76ef0a (real Chinese texts) and, beside it, on the same pages with the English forms written over them", () => {
  let real: Run;
  let english: Run;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(READ_AT));
    real = await run(null);
    // SYNTHETIC: every comment of the comments pages gets one of the English forms in turn, by its place in the page (the real pages hold the Chinese «11个月前»)
    const FORMS = ["3 days ago", "11 months ago", "1 year ago", "2 weeks ago", "5 hours ago", "3 days ago (edited)", "two moons ago", "11个月前"];
    english = await run((page) => {
      const data = page.data as { comments?: Array<Record<string, unknown>> } | undefined;
      (data?.comments ?? []).forEach((c, i) => { c.published_time = FORMS[i % FORMS.length]; });
      return page;
    });
  }, 180_000);
  afterAll(() => { vi.useRealTimers(); });

  it("the replay needs no page the live mission did not read, and every page it read is a stored one", () => {
    expect(real.unserved).toEqual([]);
    expect(english.unserved).toEqual([]);
  });
  it("delivered rows equal the stored rows: the same ids and the same counts (2 videos, 95 comments, 4 replies)", () => {
    expect(real.videos.map((r) => String(r.id)).sort()).toEqual(stored("videos").map((r) => String(r.id)).sort());
    expect(real.comments.map((r) => String(r.id)).sort()).toEqual(stored("comments").map((r) => String(r.id)).sort());
    expect(real.replies.map((r) => String(r.id)).sort()).toEqual(stored("comments_replies").map((r) => String(r.id)).sort());
    expect([real.videos.length, real.comments.length, real.replies.length]).toEqual([2, 95, 4]);
    // each comment is under the same video, each reply under the same comment as in the stored rows
    const parents = (rows: Array<Record<string, unknown>>) => Object.fromEntries(rows.map((r) => [String(r.id), String(r.parent_id)]));
    expect(parents(real.comments)).toEqual(parents(stored("comments")));
    expect(parents(real.replies)).toEqual(parents(stored("comments_replies")));
  });
  it("the English forms change no id and no count", () => {
    expect(english.comments.map((r) => String(r.id))).toEqual(real.comments.map((r) => String(r.id)));
    expect(english.replies.map((r) => String(r.id))).toEqual(real.replies.map((r) => String(r.id)));
  });
  it("the comments tool was asked with language_code \"en\" on every call of the stage (the plan's own inputs)", () => {
    expect(real.stageParams).toEqual({ language_code: "en" });
    expect(real.commentParams.length).toBeGreaterThan(0);
    for (const p of real.commentParams) expect(p.language_code).toBe("en");
  });
  it("REAL Chinese texts: no date is invented, the cell is empty, and every one of the 95 comments is counted as unread", () => {
    for (const r of real.comments) {
      expect(r.posted_at, String(r.id)).toBe("");
      expect(dateUnreadColumnsOf(r), String(r.id)).toEqual(["posted_at"]);
      expect(r[APPROX_DATES_KEY]).toBeUndefined();
    }
    // CHANGED (round 14): the replies come from another tool whose `createdUtc` is an instant the PROVIDER computed from «11 months ago» (the minute of the call minus 11 calendar months): round 13 left it as an exact moment, the live file showed «2025-12-03 17:52:00». It is now the approximate day, marked.
    for (const r of real.replies) { expect(String(r.posted_at)).toBe("2025-12-03"); expect(r[DATE_UNREAD_KEY]).toBeUndefined(); expect(r[APPROX_DATES_KEY]).toEqual(["posted_at"]); }
  });
  it("SYNTHETIC English texts: a readable form is the approximate Cairo day and the row is marked approximate; a form the code cannot read (and the Chinese one) leaves the cell empty and is counted", () => {
    const DAYS: Record<string, string> = { "3 days ago": "2026-10-31", "11 months ago": "2025-12-03", "1 year ago": "2025-11-03", "2 weeks ago": "2026-10-20", "5 hours ago": "2026-11-03", "3 days ago (edited)": "2026-10-31" };
    const FORMS = Object.keys(DAYS);
    // the first page of the first video (the stored call 8, 20 comments) in the order the engine delivers them
    const first = english.comments.slice(0, 16);
    first.forEach((r, i) => {
      const form = ["3 days ago", "11 months ago", "1 year ago", "2 weeks ago", "5 hours ago", "3 days ago (edited)", "two moons ago", "11个月前"][i % 8];
      if (FORMS.includes(form)) { expect(r.posted_at, `${i} ${form}`).toBe(DAYS[form]); expect(r[APPROX_DATES_KEY], `${i}`).toEqual(["posted_at"]); expect(r[DATE_UNREAD_KEY]).toBeUndefined(); }
      else { expect(r.posted_at, `${i} ${form}`).toBe(""); expect(dateUnreadColumnsOf(r), `${i}`).toEqual(["posted_at"]); expect(r[APPROX_DATES_KEY]).toBeUndefined(); }
    });
    expect(english.comments.some((r) => r[APPROX_DATES_KEY] !== undefined)).toBe(true);
    expect(english.comments.some((r) => dateUnreadColumnsOf(r).length > 0)).toBe(true);
  });
  it("«حدود هذا التسليم» counts the comments delivered with no date (Arabic, Arabic-Indic numerals): none for a file whose dates were all read, the unread ones for the others", () => {
    const limitsOf = (r: Run) => buildMethodology({ plan: r.plan, layouts: [], rowsByStage: { videos: r.videos, comments: r.comments, comments_replies: r.replies } }).items.find((i) => i.label === "حدود هذا التسليم")!.values.join("\n");
    const unread = (r: Run) => r.comments.filter((c) => dateUnreadColumnsOf(c).length > 0).length;
    expect(unread(real)).toBe(95);
    expect(limitsOf(real)).toContain("٩٥ من ٩٥");
    expect(limitsOf(real)).toContain("سُلّمت بلا تاريخ");
    expect(limitsOf(real)).not.toMatch(/[0-9]/);
    expect(unread(english)).toBeGreaterThan(0);
    expect(unread(english)).toBeLessThan(95);
    const line = limitsOf(english).split("\n").find((l) => l.includes("سُلّمت بلا تاريخ"))!;
    expect(line).toContain("من ٩٥");
    expect(line).not.toMatch(/[0-9]/);
  });
  it("THE FILE says the date is approximate: the cell of a readable English text carries «تقريبًا» in its format and the note is on the first sheet; an unread one is an empty cell, never the foreign words", async () => {
    const files = await buildMissionFiles(english.plan, { videos: english.videos, comments: english.comments, comments_replies: english.replies });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(files.xlsx as never);
    const text = (c: ExcelJS.Cell) => String(c.value ?? "");
    expect(wb.worksheets.some((w) => w.getRow(1).values && JSON.stringify(w.getSheetValues()).includes(APPROX_DATES_NOTE_AR.slice(0, 30)))).toBe(true);
    const sheet = wb.worksheets.find((w) => { const h: string[] = []; w.getRow(1).eachCell((c) => h.push(text(c))); return h.includes("تاريخ ووقت التعليق"); })!;
    const headers: string[] = [];
    sheet.getRow(1).eachCell((c) => headers.push(text(c)));
    const col = headers.indexOf("تاريخ ووقت التعليق") + 1;
    const cells = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2).getCell(col));
    expect(cells.some((c) => c.value instanceof Date && String(c.numFmt).includes(APPROX_WORD_AR))).toBe(true);
    for (const c of cells) expect(text(c)).not.toMatch(/[　-鿿]|ago/);
    expect(cells.some((c) => c.value === null || c.value === "" || c.value === undefined)).toBe(true);
  });
});
