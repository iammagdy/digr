import { pointsAr } from "./pointsFormat";
import { toArabicDigits } from "./arabicDigits";
import { fullEstimatePoints, sampleOffer, sampleOfferLineAr, type SampleQuoteLike } from "./sampleFirst";
import { chargeForUnits, reserveForUnits } from "./recordPricing";

/**
 * «استكشاف»: before paying for a large or vague job the customer can pay for a small sample of the same plan. The
 * sample is an ordinary quote at a reduced volume, priced by the same code (at least 1 point, never free), approved
 * and settled like any other job. The sample then tells how many records the source really has, so the customer
 * decides the full volume with facts. The model explains; code prices and counts.
 */
export { SAMPLE_MIN_ESTIMATE_POINTS as EXPLORATION_MIN_ESTIMATE_POINTS } from "./sampleFirst";

export interface ExplorationQuoteLike extends SampleQuoteLike {
  quotedPoints: number;
  pointsCapConstrained?: boolean;
}

/** A job worth a sample first: the estimate of the whole request reaches 1,500 points (see sampleFirst). */
export function isExplorationCandidate(quote: ExplorationQuoteLike): boolean {
  return sampleOffer(quote) !== null;
}

export interface ExplorationOffer {
  sampleUnits: number;
  /** points held for the sample (reserve, with the 15% buffer); about 5% of the estimate, between 100 and 300 */
  samplePoints: number;
  /** points the sample will cost if it delivers every record */
  sampleExpectedPoints: number;
  fullUnits: number;
  fullQuotedPoints: number;
  /** expected points of the whole request, before any cap */
  fullEstimatePoints: number;
}

export function explorationOffer(quote: ExplorationQuoteLike, safetyBuffer = 0.15): ExplorationOffer {
  const offer = sampleOffer(quote, safetyBuffer);
  if (!offer) {
    const units = Math.min(1, quote.targetVolumeMax);
    return { sampleUnits: units, samplePoints: reserveForUnits(units, quote.unitPricePoints, safetyBuffer), sampleExpectedPoints: chargeForUnits(units, quote.unitPricePoints), fullUnits: quote.targetVolumeMax, fullQuotedPoints: quote.quotedPoints, fullEstimatePoints: fullEstimatePoints(quote) };
  }
  return { ...offer, fullQuotedPoints: quote.quotedPoints };
}

const n = (value: number) => toArabicDigits(Math.max(0, Math.round(value)));

export function explorationOfferLineAr(offer: ExplorationOffer, unitLabelAr = "سجل"): string {
  return sampleOfferLineAr(offer, unitLabelAr);
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
    fullExpectedPoints: chargeForUnits(sample.fullUnits, sample.unitPricePoints),
    fullReservePoints: reserveForUnits(sample.fullUnits, sample.unitPricePoints, safetyBuffer),
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
    parts.push(`الحجم الكامل (${n(fullUnits)} ${unitLabelAr}) تكلفته المتوقعة ${pointsAr(estimate.fullExpectedPoints, n)} وحجزه ${pointsAr(estimate.fullReservePoints, n)}، وهذه تقديرات من العينة وليست وعدًا بالعدد.`);
  }
  return parts.join(" ");
}
