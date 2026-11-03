import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { NAMED_MISMATCH_MARK_AR, NAMED_SHORTFALL_OPTIONS_AR } from "../src/lib/agentMission/foundation/namedShortfall";
import { violationTextAr } from "../src/lib/agentMission/foundation/deliveryContract";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { replayMission, storedRows, type MissionReplay, type MissionReplayInput } from "./helpers/missionReplay";

/**
 * ROUND 14, PART A: THE DELIVERY CONTRACT ON EVERY STORED LIVE MISSION THAT HAS THE PAGES IT NEEDS. Each mission is replayed end to end (the compiler plans from the stored planning pages, the engine reads the stored execution pages, the real workbook is built as the worker builds it: no network, no model, no paid call)
 * and the four rules (one number, every gap stated, approximate dates marked, marks filled) are checked on the built file. ZERO violations. The missions that are NOT replayed (only planning pages or only some execution pages are stored) are listed with the reason, below.
 */
const M12 = "msn_5851abc92a1e6645a9cd";
const YT1 = "msn_41a73a6b2c0b4a76ef0a";
const YT2 = "msn_5d5a9b2a933aeaa47d81";
const FB = "msn_236f4af6fe4cb890abee";
const YT_REQUEST = "هات فيديوهين على يوتيوب عن نهائي السوبر المصري الأهلي والزمالك من القنوات الرسمية، مع كل التعليقات والردود.";
const FB_REQUEST = "هات منشورات عن الذكاء الاصطناعي من صفحة قناة العربية على فيسبوك آخر ٣ شهور، ٣ منشورات، مع كل التعليقات والردود.";
const TOK = { "tikhub.youtube.video.comments": ["video_id", "continuation_token"], "tikhub.x.youtube-web-search-channel": ["channel_id"] } as const;
const cutYt = { "tikhub.youtube.video.comments": ["continuation_token"], "anyapi.youtube.comment_replies": ["continuationToken"] } as const;

/** The live YouTube plans pinned their two videos on the REAL titles; the stored titles are anonymised (no topic word), so the compiler on them keeps the source's order. The live two are made the pinned rows (as in tests/round13-youtube-dates.test.ts). */
const pinLiveVideos = (plan: PricedPlan) => {
  const stage = plan.stages.find((s) => s.key === "videos")!;
  const pool = [...(stage.pinned_rows ?? []), ...(stage.spare_rows ?? [])];
  const LIVE = ["gCut2DcB9sM", "GIWkArP7RJE"];
  stage.pinned_rows = LIVE.map((id) => pool.find((r) => String(r.id) === id)!);
  stage.spare_rows = pool.filter((r) => !LIVE.includes(String(r.id)));
  for (const st of plan.stages) if (st.parent_key === "videos") st.parent_pins = LIVE;
};

/** The live Facebook plan chose its three posts on the REAL authors and texts; the stored ones are anonymised placeholders, so the compiler on them cannot rank as it did. The three live posts get back the words the ranking read (the topic in the text, the author's name), in the planning pages only. */
const LIVE_POSTS: Record<string, string> = { "1575273671452735": "قناة العربية  Al Arabiya", "1585218656966008": "صباح العربية - Sabah Al Arabiya", "4499696513603664": "HandsomeHeron8119" };
const restoreLiveWords = (_endpoint: string, page: unknown): unknown => {
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    const id = String(r.id ?? r.post_id ?? "");
    if (LIVE_POSTS[id]) {
      if ("text" in r) r.text = "نقاش مفتوح عن الذكاء الاصطناعي وتأثيره"; if ("message" in r) r.message = "نقاش مفتوح عن الذكاء الاصطناعي وتأثيره";
      if ("authorName" in r) r.authorName = LIVE_POSTS[id];
      if (r.author && typeof r.author === "object") (r.author as Record<string, unknown>).name = LIVE_POSTS[id];
    }
    Object.values(r).forEach(walk);
  };
  walk(page);
  return page;
};

const MISSIONS: Array<{ id: string; label: string; input: MissionReplayInput }> = [
  { id: M12, label: "TikTok M12 (2 videos, 300 comments, 67 replies)", input: { fixture: M12, request: "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم", answer: NO_ABOUT_OPTIONS_AR.useAsIs, createdAt: "2026-11-02T11:35:00Z", planningAt: "2026-11-02T11:36:00Z", readAt: "2026-11-02T11:40:00Z", platform: "tiktok", edits: { comments: 300, replies: 67 } } },
  { id: YT1, label: "YouTube round 11 (2 videos, 95 comments, 4 replies; Chinese relative dates)", input: { fixture: YT1, request: YT_REQUEST, createdAt: "2026-11-03T13:38:44Z", planningAt: "2026-11-03T13:39:44Z", readAt: "2026-11-03T13:45:00Z", platform: "youtube", occurrence: { kind: "latest" }, replay: { only: TOK, cut80: cutYt }, adjustPlan: pinLiveVideos } },
  { id: YT2, label: "YouTube round 12 (the same request with language_code en)", input: { fixture: YT2, request: YT_REQUEST, createdAt: "2026-11-03T15:44:11Z", planningAt: "2026-11-03T15:51:30Z", readAt: "2026-11-03T15:52:30Z", platform: "youtube", occurrence: { kind: "latest" }, replay: { only: TOK, cut80: cutYt }, adjustPlan: pinLiveVideos } },
  { id: FB, label: "Facebook round 12 (3 posts, 366 comments, 95 replies; fill from other pages)", input: { fixture: FB, request: FB_REQUEST, answer: NAMED_SHORTFALL_OPTIONS_AR.fill, createdAt: "2026-11-03T15:39:39Z", planningAt: "2026-11-03T15:42:00Z", readAt: "2026-11-03T15:46:00Z", platform: "facebook", catalogOnly: true, replay: { cut80: { "justoneapi.x.facebook-search-post-v1": ["cursor"], "scrapecreators.x.v1-facebook-post-comments": ["cursor"], "anyapi.facebook.comment_replies": ["feedbackId", "expansionToken"] } }, transformPlanningPage: restoreLiveWords } },
];

/** Not replayed, with the reason (their pages are in tests/fixtures/live; a replay needs the stored pages of BOTH phases): */
export const NOT_REPLAYED: Record<string, string> = {
  msn_b060d3347ed7660f972e: "X: one stored execution page of the search; no replies pages (the X replies route is covered by tests/live-g-x-replies-verified.test.ts)",
  msn_50e3b83c44e7ebd7f577: "X: only the 14 replies pages of the pageable route, no search page",
  msn_97cdab58dc82fc2039ed: "Instagram: planning pages and two execution pages; the comments pages of the delivered file are not stored",
  msn_e3e7632e2fb2d42f9c19: "Facebook (older plan shape): 15 execution calls, planning pages incomplete",
  msn_9d196025e7929324983a: "Facebook round 11: the plan was never approved, no execution pages",
};

describe.each(MISSIONS)("the contract on $label", ({ id, input }) => {
  let r: MissionReplay;
  beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(input.readAt)); r = await replayMission(input); }, 240_000);
  afterAll(() => { vi.useRealTimers(); });

  it("the replay served every EXECUTION page from the stored ones (nothing invented); the only planning reads not served are the exposure reads of videos the live plan did not choose (the anonymised titles rank differently: the live videos are pinned)", () => {
    expect(r.unservedExecution).toBe(0);
    for (const u of r.unserved) expect(["VZqp9F8ed2s", "lLAE4Iy-JNI"]).toContain(String(u.params.video_id));
  });
  it("it delivered rows (a replay that delivers nothing proves nothing)", () => {
    const total = Object.values(r.rowsByStage).reduce((n, rows) => n + rows.length, 0);
    expect(total).toBeGreaterThan(0);
  });
  it("the contract ran (it did not fail on this plan)", () => { expect(r.built.contract.error).toBeUndefined(); });
  it("ZERO violations of R1 (one number), R2 (every gap stated), R3 (approximate dates marked), R4 (marks filled)", () => {
    expect(r.built.contract.violations.map(violationTextAr)).toEqual([]);
  });
  it("what was found to be missing is not completed behind the tests' back: the contract completed nothing on this file", () => {
    expect(r.built.contract.completed).toEqual([]);
  });
});

void storedRows;
