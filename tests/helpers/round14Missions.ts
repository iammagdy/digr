import { NO_ABOUT_OPTIONS_AR } from "../../src/lib/agentMission/foundation/topicChoice";
import { NAMED_SHORTFALL_OPTIONS_AR } from "../../src/lib/agentMission/foundation/namedShortfall";
import type { PricedPlan } from "../../src/lib/agentMission/plan";
import type { MissionReplayInput } from "./missionReplay";

/** The four stored live missions the delivery contract (round 14) and the alternatives (round 16) are replayed on: shared so that both tests replay EXACTLY the same inputs. */

export const M12 = "msn_5851abc92a1e6645a9cd";
export const YT1 = "msn_41a73a6b2c0b4a76ef0a";
export const YT2 = "msn_5d5a9b2a933aeaa47d81";
export const FB = "msn_236f4af6fe4cb890abee";
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

export const MISSIONS: Array<{ id: string; label: string; input: MissionReplayInput }> = [
  { id: M12, label: "TikTok M12 (2 videos, 300 comments, 67 replies)", input: { fixture: M12, request: "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم", answer: NO_ABOUT_OPTIONS_AR.useAsIs, createdAt: "2026-11-02T11:35:00Z", planningAt: "2026-11-02T11:36:00Z", readAt: "2026-11-02T11:40:00Z", platform: "tiktok", edits: { comments: 300, replies: 67 } } },
  { id: YT1, label: "YouTube round 11 (2 videos, 95 comments, 4 replies; Chinese relative dates)", input: { fixture: YT1, request: YT_REQUEST, createdAt: "2026-11-03T13:38:44Z", planningAt: "2026-11-03T13:39:44Z", readAt: "2026-11-03T13:45:00Z", platform: "youtube", occurrence: { kind: "latest" }, replay: { only: TOK, cut80: cutYt }, adjustPlan: pinLiveVideos } },
  { id: YT2, label: "YouTube round 12 (the same request with language_code en)", input: { fixture: YT2, request: YT_REQUEST, createdAt: "2026-11-03T15:44:11Z", planningAt: "2026-11-03T15:51:30Z", readAt: "2026-11-03T15:52:30Z", platform: "youtube", occurrence: { kind: "latest" }, replay: { only: TOK, cut80: cutYt }, adjustPlan: pinLiveVideos } },
  { id: FB, label: "Facebook round 12 (3 posts, 366 comments, 95 replies; fill from other pages)", input: { fixture: FB, request: FB_REQUEST, answer: NAMED_SHORTFALL_OPTIONS_AR.fill, createdAt: "2026-11-03T15:39:39Z", planningAt: "2026-11-03T15:42:00Z", readAt: "2026-11-03T15:46:00Z", platform: "facebook", catalogOnly: true, replay: { cut80: { "justoneapi.x.facebook-search-post-v1": ["cursor"], "scrapecreators.x.v1-facebook-post-comments": ["cursor"], "anyapi.facebook.comment_replies": ["feedbackId", "expansionToken"] } }, transformPlanningPage: restoreLiveWords } },
];

