import { toArabicDigits } from "./arabicDigits";

/**
 * «استكشاف»: before paying for a large or vague job the customer can pay for a small sample of the same plan. The
 * sample is an ordinary quote at a reduced volume, priced by the same code (at least 1 point, never free), approved
 * and settled like any other job. The sample then tells how many records the source really has, so the customer
 * decides the full volume with facts. The model explains; code prices and counts.
 */
export const EXPLORATION_SAMPLE_UNITS = 10;
/** A plan whose reserve reaches this many points is worth a sample first. */
export const EXPLORATION_MIN_QUOTED_POINTS = 150;
/** Large per-record volumes, whatever the price. */
export const EXPLORATION_MIN_UNITS = 200;

export interface ExplorationQuoteLike {
  items?: Array<{ capabilitySlug?: string; params?: Record<string, any> }>;
  targetVolumeMax: number;
  unitPricePoints: number;
  quotedPoints: number;
  pointsCapConstrained?: boolean;
  requestedVolumeMax?: number;
}

const isSocial = (slug?: string) => /^social-/.test(String(slug || ""));
const NAMED_LINK = /^https?:\/\//i;

/** Large or vague social requests: many records, a capped plan, or discovery by keyword, channel or trending. */
export function isExplorationCandidate(quote: ExplorationQuoteLike): boolean {
  const item = quote.items?.[0];
  if (!item || quote.items!.length !== 1 || !isSocial(item.capabilitySlug)) return false;
  const params = item.params || {};
  const discovered = !NAMED_LINK.test(String(params.url || ""));
  const large =
    quote.quotedPoints >= EXPLORATION_MIN_QUOTED_POINTS ||
    quote.targetVolumeMax >= EXPLORATION_MIN_UNITS ||
    Boolean(quote.pointsCapConstrained);
  return large && discovered && quote.targetVolumeMax > EXPLORATION_SAMPLE_UNITS;
}

export interface ExplorationOffer {
  sampleUnits: number;
  /** points held for the sample (with the 15% buffer, at least 1) */
  samplePoints: number;
  /** points the sample will cost if it delivers every record */
  sampleExpectedPoints: number;
  fullUnits: number;
  fullQuotedPoints: number;
}

export function explorationOffer(quote: ExplorationQuoteLike, safetyBuffer = 0.15, minPoints = 1): ExplorationOffer {
  const sampleUnits = Math.min(EXPLORATION_SAMPLE_UNITS, quote.targetVolumeMax);
  const raw = sampleUnits * quote.unitPricePoints;
  return {
    sampleUnits,
    samplePoints: Math.max(minPoints, Math.ceil(raw * (1 + safetyBuffer))),
    sampleExpectedPoints: Math.max(minPoints, Math.ceil(raw)),
    fullUnits: quote.targetVolumeMax,
    fullQuotedPoints: quote.quotedPoints,
  };
}

const n = (value: number) => toArabicDigits(Math.max(0, Math.round(value)));

export function explorationOfferLineAr(offer: ExplorationOffer, unitLabelAr = "سجل"): string {
  return `استكشاف أولًا: قبل الحجم الكامل (${n(offer.fullUnits)} ${unitLabelAr} بحجز ${n(offer.fullQuotedPoints)} نقطة) تقدر تجلب عينة من ${n(offer.sampleUnits)} ${unitLabelAr} فقط بحجز ${n(offer.samplePoints)} نقطة، لنعرف كم فيديو وتعليق متاح فعلًا قبل أن تقرر. لا يُخصم إلا ثمن ما يُسلَّم منها.`;
}

export interface ExplorationSample {
  /** records the sample delivered */
  delivered: number;
  /** records the sample asked for */
  requested: number;
  /** the sample rows (only counts and ids are read) */
  rows: Array<Record<string, any>>;
  fullUnits: number;
  unitPricePoints: number;
}

export interface ExplorationEstimate {
  /** the source returned fewer records than asked, so this is all that exists for this request */
  sourceExhausted: boolean;
  delivered: number;
  distinctVideos: number | null;
  commentsPerVideo: number | null;
  /** estimated comments in `fullUnits` videos, when the sample rows carry comment counts */
  commentsInFullVideos: number | null;
  /** videos needed to reach `fullUnits` comments, from the sample average */
  videosNeededForFullComments: number | null;
  fullExpectedPoints: number;
  fullReservePoints: number;
}

const COUNT_KEYS = ["comments_count", "comment_count", "commentCount", "comments"];
const VIDEO_KEYS = ["video_id", "videoId", "video_url", "videoUrl", "post_id", "postId", "post_url", "source_id"];

function numericCount(row: Record<string, any>): number | null {
  for (const key of COUNT_KEYS) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string" && /^\d{1,9}$/.test(value.trim())) return Number(value);
  }
  return null;
}

/** All numbers come from the delivered sample; nothing is invented when the sample does not carry the field. */
export function estimateFromSample(sample: ExplorationSample, safetyBuffer = 0.15): ExplorationEstimate {
  const rows = sample.rows;
  const videoIds = new Set<string>();
  for (const row of rows) {
    for (const key of VIDEO_KEYS) {
      if (row[key] !== undefined && row[key] !== null && String(row[key]).trim()) { videoIds.add(String(row[key])); break; }
    }
  }
  const distinctVideos = videoIds.size > 0 ? videoIds.size : null;
  const counts = rows.map(numericCount).filter((c): c is number => c !== null);
  const commentRows = rows.length > 0 && rows.every((r) => numericCount(r) === null) && distinctVideos !== null;

  let commentsPerVideo: number | null = null;
  let commentsInFullVideos: number | null = null;
  let videosNeededForFullComments: number | null = null;
  if (counts.length > 0 && counts.length === rows.length) {
    commentsPerVideo = counts.reduce((a, c) => a + c, 0) / counts.length;
    commentsInFullVideos = Math.round(commentsPerVideo * sample.fullUnits);
  } else if (commentRows && distinctVideos) {
    commentsPerVideo = sample.delivered / distinctVideos;
    videosNeededForFullComments = commentsPerVideo > 0 ? Math.ceil(sample.fullUnits / commentsPerVideo) : null;
  }
  return {
    sourceExhausted: sample.delivered < sample.requested,
    delivered: sample.delivered,
    distinctVideos,
    commentsPerVideo: commentsPerVideo === null ? null : Math.round(commentsPerVideo * 10) / 10,
    commentsInFullVideos,
    videosNeededForFullComments,
    fullExpectedPoints: Math.ceil(sample.fullUnits * sample.unitPricePoints),
    fullReservePoints: Math.ceil(sample.fullUnits * sample.unitPricePoints * (1 + safetyBuffer)),
  };
}

export function explorationResultMessageAr(estimate: ExplorationEstimate, fullUnits: number, unitLabelAr = "سجل"): string {
  const parts: string[] = [`اكتمل الاستكشاف: سُلّم ${n(estimate.delivered)} ${unitLabelAr}.`];
  if (estimate.sourceExhausted) {
    parts.push(`المصدر أعاد أقل من المطلوب، فالمتاح فعليًا لهذا الطلب هو ${n(estimate.delivered)} ${unitLabelAr} فقط، ولا داعي لحجم أكبر.`);
  } else {
    if (estimate.commentsPerVideo !== null && estimate.distinctVideos !== null && estimate.videosNeededForFullComments !== null) {
      parts.push(`متوسط التعليقات في العينة ${n(estimate.commentsPerVideo)} تعليقًا لكل فيديو من ${n(estimate.distinctVideos)} فيديو، فتحتاج غالبًا حوالي ${n(estimate.videosNeededForFullComments)} فيديو للوصول إلى ${n(fullUnits)} تعليق.`);
    } else if (estimate.commentsPerVideo !== null && estimate.commentsInFullVideos !== null) {
      parts.push(`متوسط التعليقات في الفيديو الواحد ${n(estimate.commentsPerVideo)} تعليقًا، فمن ${n(fullUnits)} فيديو تتوقع حوالي ${n(estimate.commentsInFullVideos)} تعليق.`);
    }
    parts.push(`الحجم الكامل (${n(fullUnits)} ${unitLabelAr}) تكلفته المتوقعة ${n(estimate.fullExpectedPoints)} نقطة وحجزه ${n(estimate.fullReservePoints)} نقطة، وهذه تقديرات من العينة وليست وعدًا بالعدد.`);
  }
  return parts.join(" ");
}
