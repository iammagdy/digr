import { toArabicDigits } from "../arabicDigits";
import { regionEvidenceWords } from "../regionNames";
import { reviewSocialRows, UNREVIEWED_BY_BUDGET_REASON_AR, type AdvisoryUsage, type RowAdvisorFn, type SocialReviewAttempt, type SocialReviewStop } from "./rowReviewAdvisor";
import { hasRegionEvidence, hasTopicEvidence, isBasketballTopic, normalizeText, sportTermCounts, topicStems } from "./topicMatch";

/**
 * Comments found by a topic search (TikTok, YouTube) are judged at the level of the VIDEO they were written under: a short comment
 * («حلو قوي», «افتح التنزيل عليك الله») says nothing about any topic, but it belongs to the topic when its video does. So the videos are
 * selected first (deterministic evidence in the video's own text, then the automatic review on the list of videos, fail closed, inside
 * the job's review budget), and the comments of the selected videos are delivered. Posts (X) are not judged this way: the post is the unit.
 */

export type VideoEvidence = "match" | "needs_review";

/**
 * Evidence from the video's own text (title or description with its hashtags): a word of the topic or of its family, and, when a country
 * was requested, a word of that country as well (a Spanish club's highlights use the same football words as an Egyptian match).
 * No evidence is not a rejection: the video goes to the review.
 */
export function videoEvidence(videoText: string, request: { query?: string; region?: string }): VideoEvidence {
  const text = String(videoText || "").trim();
  if (!text) return "needs_review";
  const query = String(request.query || "");
  if (isBasketballTopic(query)) {
    // «كرة» is in both sports' names: a basketball video needs a word of the sport itself, and a video that names football more than it
    // names basketball is not evidence (it goes to the review, never straight to delivery).
    const { basketball, football } = sportTermCounts(text);
    if (basketball === 0 || football >= basketball) return "needs_review";
    return regionEvidenceWords(request.region).length === 0 || hasRegionEvidence(request.region, text) ? "match" : "needs_review";
  }
  const stems = topicStems(query);
  if (stems.length === 0 || !hasTopicEvidence(stems, text)) return "needs_review";
  if (regionEvidenceWords(request.region).length === 0) return "match";
  return hasRegionEvidence(request.region, text) ? "match" : "needs_review";
}

/** The video a comment row was written under: its link, else its text. Null when the row says nothing about its video. */
export function videoKeyOfRow(row: Record<string, any>): string | null {
  const url = typeof row.video_url === "string" ? row.video_url.trim() : "";
  if (url) return url;
  const title = typeof row.video_title === "string" ? row.video_title.trim() : "";
  return title ? `title:${normalizeText(title).slice(0, 120)}` : null;
}

export interface VideoEntry {
  key: string;
  title: string;
  channel: string;
  /** Positions (in the worker's list) of the comments written under this video. */
  rowIndexes: number[];
  /** A few of its comments, short, as context for the reviewer when the video has no description. */
  sampleComments: string[];
}

const SAMPLE_COMMENTS = 3;
const COMMENT_CHARS = 70;

export function groupRowsByVideo(rows: Array<{ index: number; row: Record<string, any> }>): { videos: VideoEntry[]; withoutVideo: number[] } {
  const byKey = new Map<string, VideoEntry>();
  const withoutVideo: number[] = [];
  for (const { index, row } of rows) {
    const key = videoKeyOfRow(row);
    if (!key) { withoutVideo.push(index); continue; }
    let entry = byKey.get(key);
    if (!entry) {
      entry = { key, title: typeof row.video_title === "string" ? row.video_title.trim() : "", channel: typeof row.channel_name === "string" ? row.channel_name.trim() : "", rowIndexes: [], sampleComments: [] };
      byKey.set(key, entry);
    }
    entry.rowIndexes.push(index);
    const own = typeof row.text === "string" ? row.text : typeof row.comment_text === "string" ? row.comment_text : "";
    if (entry.sampleComments.length < SAMPLE_COMMENTS && own.trim()) entry.sampleComments.push(own.trim().replace(/\s+/g, " ").slice(0, COMMENT_CHARS));
  }
  return { videos: [...byKey.values()], withoutVideo };
}

export type VideoDecision = "match" | "no_match" | "uncertain";

export interface VideoJudgement {
  decision: VideoDecision;
  reasonAr: string;
  by: "evidence" | "review" | "unreviewed";
  /** Set when the video was left unreviewed only because the review budget was used up (its comments go to the «غير مراجَع» sheet). */
  budget?: boolean;
}

export const VIDEO_ON_TOPIC_REASON_AR = "الفيديو يتناول موضوع طلبك";
export const VIDEO_OFF_TOPIC_REASON_AR = "الفيديو لا يتناول موضوع طلبك";
export const VIDEO_UNREVIEWED_REASON_AR = "تعذّر التحقق الآلي من ملاءمة الفيديو لموضوع الطلب؛ أُحيلت تعليقاته للمراجعة ولم تُحتسب";

export interface VideoJudgementOutcome {
  judgements: Map<string, VideoJudgement>;
  attempts: SocialReviewAttempt[];
  costUsd: number;
  stoppedBy: SocialReviewStop | null;
}

/**
 * Decides every video of a page. Evidence in the video's own text settles it without a call; the others are reviewed in one call
 * per batch inside the budget. A video nobody reviewed (a failed call, the budget, the deadline) is NOT delivered. Never throws.
 */
export async function judgeVideos(input: {
  advisor: RowAdvisorFn;
  customerRequest: string;
  kind: string;
  videos: VideoEntry[];
  request: { query?: string; region?: string };
  budgetUsd: number;
  /** See `reviewSocialRows`: when set, the budget is a ceiling no call may cross. */
  callCostEstimateUsd?: number;
  deadlineMs?: number;
}): Promise<VideoJudgementOutcome> {
  const judgements = new Map<string, VideoJudgement>();
  const toReview: Array<{ index: number; row: Record<string, any>; key: string }> = [];
  input.videos.forEach((video) => {
    if (videoEvidence(video.title, input.request) === "match") {
      judgements.set(video.key, { decision: "match", reasonAr: VIDEO_ON_TOPIC_REASON_AR, by: "evidence" });
      return;
    }
    toReview.push({
      index: toReview.length,
      key: video.key,
      row: { title: video.title, ...(video.channel ? { channel_name: video.channel } : {}), ...(video.sampleComments.length > 0 ? { comments_sample: video.sampleComments.join(" | ") } : {}) },
    });
  });
  if (toReview.length === 0) return { judgements, attempts: [], costUsd: 0, stoppedBy: null };
  const outcome = await reviewSocialRows({
    advisor: input.advisor,
    customerRequest: input.customerRequest,
    kind: input.kind,
    rows: toReview.map(({ index, row }) => ({ index, row })),
    budgetUsd: input.budgetUsd,
    callCostEstimateUsd: input.callCostEstimateUsd,
    deadlineMs: input.deadlineMs,
  });
  const unreviewedByCap = new Set(outcome.unreviewedByCap);
  for (const entry of toReview) {
    const verdict = outcome.verdicts.get(entry.index);
    if (!verdict) {
      const byBudget = unreviewedByCap.has(entry.index);
      judgements.set(entry.key, { decision: "uncertain", reasonAr: byBudget ? UNREVIEWED_BY_BUDGET_REASON_AR : VIDEO_UNREVIEWED_REASON_AR, by: "unreviewed", ...(byBudget ? { budget: true } : {}) });
    }
    else if (verdict.verdict === "match") judgements.set(entry.key, { decision: "match", reasonAr: verdict.reasonAr || VIDEO_ON_TOPIC_REASON_AR, by: "review" });
    else if (verdict.verdict === "no_match") judgements.set(entry.key, { decision: "no_match", reasonAr: verdict.reasonAr || VIDEO_OFF_TOPIC_REASON_AR, by: "review" });
    else judgements.set(entry.key, { decision: "uncertain", reasonAr: verdict.reasonAr || VIDEO_UNREVIEWED_REASON_AR, by: "review" });
  }
  return { judgements, attempts: outcome.attempts, costUsd: outcome.costUsd, stoppedBy: outcome.stoppedBy };
}

/** One line for the activity log: how many videos were selected and why the others were not. Arabic only, Arabic-Indic digits. */
export function videoSelectionEventAr(judgements: Iterable<VideoJudgement>, options: { carried?: boolean } = {}): string {
  let matched = 0, excluded = 0, held = 0;
  let firstOffReason = "";
  for (const judgement of judgements) {
    if (judgement.decision === "match") matched += 1;
    else if (judgement.decision === "no_match") { excluded += 1; firstOffReason ||= judgement.reasonAr; }
    else held += 1;
  }
  const parts = [`اعتمدنا ${toArabicDigits(matched)} فيديو`];
  if (excluded > 0) parts.push(`واستبعدنا ${toArabicDigits(excluded)} لأنها لا تتناول موضوعك${firstOffReason ? ` (${firstOffReason})` : ""}`);
  if (held > 0) parts.push(options.carried ? `وسنقرأ تعليقات ${toArabicDigits(held)} للتحقق من موضوعها` : `وأحلنا ${toArabicDigits(held)} إلى المراجعة لعدم التأكد من موضوعها`);
  return `راجعنا فيديوهات هذه الصفحة: ${parts.join("، ")}.`;
}

export type { AdvisoryUsage };
