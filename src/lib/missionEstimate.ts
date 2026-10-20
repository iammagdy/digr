import { toArabicDigits } from "./arabicDigits";
import { DEFAULT_JOB_POINTS_CAP, computePublicCalculatorQuote, getPublicCalculatorOptions } from "./calculatorPricing";
import { DECISION_MAKER_UNIT_PRICES_POINTS, decisionMakerQuotePoints, type ContactField } from "../functions/shared/decisionMakerPricing";
import { DEFAULT_PRICING_SETTINGS } from "../functions/shared/quotes";
import { SOCIAL_PLATFORM_LABEL_AR, type SocialPlatformId } from "./socialTasks";
import { understandMission, understoodLineAr } from "./consultantCopy";
import { volumeForPointsCap } from "./pointsCap";
import { recordsInOneJob, reserveInOneJob } from "./jobSizing";

/**
 * The public estimate: what a request would cost, from the SAME unit prices and reserve formula the quote writer uses
 * (`computePublicCalculatorQuote` and the decision-maker prices). No model, no provider, no database: pure code, so a public
 * page may call it. Every number is computed here; nothing is typed by hand. An open-ended volume («كل التعليقات») has no price
 * until the customer gives a cap.
 */
export type EstimateKind = "comments" | "posts" | "videos" | "companies" | "people";

export interface EstimateInput {
  kind: EstimateKind;
  platform?: SocialPlatformId | null;
  /** Records wanted. */
  volume?: number | null;
  /** The customer's budget in points: it sets the volume the reserve can hold. */
  budgetPoints?: number | null;
  /** «كل التعليقات / كل المنشورات» with no number: needs a cap. */
  openEnded?: boolean;
  /** Decision makers: the contact fields asked for. */
  contactFields?: ContactField[];
  /** The live daily limit as points, when known (the server reads it). */
  dailyCapPoints?: number;
}

export type EstimateResult =
  | {
      status: "ok";
      slug: string;
      unitPricePoints: number;
      volume: number;
      /** What is charged if every record is delivered (never above the reserve). */
      expectedPoints: number;
      /** What is held while the job runs (the buffer is on the hold only). */
      reservePoints: number;
      expectedEgp: number;
      reserveEgp: number;
      creditValueEgp: number;
      /** One job's live limit, in points, and what that limit holds. */
      jobCapPoints: number;
      fitsInOneJob: boolean;
      maxVolumeInOneJob: number;
      jobsNeeded: number;
      notesAr: string[];
    }
  | { status: "needs_cap"; notesAr: string[] }
  | { status: "needs_platform"; notesAr: string[] }
  | { status: "unsupported"; notesAr: string[] };

const SOCIAL_SLUG: Record<string, string> = {
  "comments:youtube": "social-youtube-comments",
  "comments:tiktok": "social-tiktok-comments",
  "comments:facebook": "social-facebook-comments",
  "videos:youtube": "social-youtube-videos",
  "videos:tiktok": "social-tiktok-videos",
  "posts:x": "social-x-posts",
  "posts:facebook": "social-facebook-posts",
};

export function estimateSlug(kind: EstimateKind, platform?: SocialPlatformId | null): string | null {
  if (kind === "companies") return "icypeas-companies-search";
  if (kind === "people") return "professional-people-search";
  if (!platform) return null;
  // «videos» on Facebook are its page posts
  const key = `${kind === "videos" && platform === "facebook" ? "posts" : kind}:${platform}`;
  return SOCIAL_SLUG[key] ?? null;
}

const n = (value: number) => toArabicDigits(Math.max(0, Math.round(value)));
const egp = (points: number, creditValueEgp: number) => Number((points * creditValueEgp).toFixed(2));

export function estimateMission(input: EstimateInput): EstimateResult {
  const settings = DEFAULT_PRICING_SETTINGS;
  const slug = estimateSlug(input.kind, input.platform);
  if (!slug) {
    return input.kind === "comments" || input.kind === "posts" || input.kind === "videos"
      ? input.platform
        ? { status: "unsupported", notesAr: [`هذا النوع من البيانات غير متاح حاليًا على ${SOCIAL_PLATFORM_LABEL_AR[input.platform]}.`] }
        : { status: "needs_platform", notesAr: ["اختر المنصة لنحسب لك التكلفة."] }
      : { status: "unsupported", notesAr: ["هذا النوع غير متاح."] };
  }
  if (!getPublicCalculatorOptions().some((option) => option.slug === slug)) {
    return { status: "unsupported", notesAr: ["هذه الخدمة غير متاحة حاليًا."] };
  }

  // The unit price and the one-job limit come from the shared pricing function (the same one the quote writer uses).
  const probe = computePublicCalculatorQuote(slug, 1, 1, undefined, settings, undefined, undefined, input.dailyCapPoints);
  const isPeople = input.kind === "people";
  const fields: ContactField[] = input.contactFields && input.contactFields.length ? input.contactFields : ["work_email", "phone"];
  const perUnit = isPeople
    ? DECISION_MAKER_UNIT_PRICES_POINTS.basePerson + (fields.includes("work_email") ? DECISION_MAKER_UNIT_PRICES_POINTS.workEmail : 0) + (fields.includes("phone") ? DECISION_MAKER_UNIT_PRICES_POINTS.phone : 0)
    : probe.unitPricePoints;
  const jobCapPoints = Math.min(DEFAULT_JOB_POINTS_CAP, typeof input.dailyCapPoints === "number" && input.dailyCapPoints >= 0 ? Math.floor(input.dailyCapPoints) : DEFAULT_JOB_POINTS_CAP);

  let volume = input.volume && input.volume > 0 ? Math.floor(input.volume) : 0;
  if (!volume && input.budgetPoints && input.budgetPoints > 0) volume = volumeForPointsCap(input.budgetPoints, perUnit, settings.safetyBuffer);
  if (!volume) {
    return input.openEnded || input.budgetPoints
      ? { status: "needs_cap", notesAr: ["الطلب المفتوح يحتاج حدًا أقصى: اكتب عدد السجلات أو ميزانيتك بالنقاط."] }
      : { status: "needs_cap", notesAr: ["اكتب عدد السجلات أو ميزانيتك بالنقاط لنحسب لك التكلفة."] };
  }

  const expectedPoints = Math.ceil(volume * perUnit);
  // One shared rule for the one-job size (the quote writer's own: see jobSizing).
  const sizing = { unitPricePoints: perUnit, capPoints: jobCapPoints, safetyBuffer: settings.safetyBuffer, chargeCapped: isPeople };
  const maxVolumeInOneJob = recordsInOneJob(sizing);
  const fitsInOneJob = maxVolumeInOneJob >= volume;
  const unclippedReserve = isPeople
    ? decisionMakerQuotePoints(volume, fields, DECISION_MAKER_UNIT_PRICES_POINTS, settings.safetyBuffer, Number.MAX_SAFE_INTEGER)
    : Math.ceil(volume * perUnit * (1 + settings.safetyBuffer));
  // Inside one job the writer clips a decision-maker hold to the cap; a request that needs several jobs shows the whole hold.
  const reservePoints = fitsInOneJob ? reserveInOneJob(volume, sizing) : unclippedReserve;
  const jobsNeeded = fitsInOneJob ? 1 : maxVolumeInOneJob > 0 ? Math.ceil(volume / maxVolumeInOneJob) : 0;

  const notesAr: string[] = [`السعر تقريبي: يُخصم فقط مقابل السجلات المطابقة التي تصلك فعلًا، والحجز (${n(reservePoints)} نقطة) يشمل احتياطيًا يعود إليك ما لم يُستخدم.`];
  if (!fitsInOneJob) {
    notesAr.push(maxVolumeInOneJob > 0
      ? `الطلب الواحد يتسع حاليًا لحوالي ${n(maxVolumeInOneJob)} سجل (سقف الحجز ${n(jobCapPoints)} نقطة)، فيلزم حوالي ${n(jobsNeeded)} طلبات منفصلة، أو سقف أعلى بعد موافقتنا.`
      : "السجل الواحد أعلى من سقف الحجز الحالي للطلب الواحد.");
  }
  return {
    status: "ok",
    slug,
    unitPricePoints: perUnit,
    volume,
    expectedPoints,
    reservePoints,
    expectedEgp: egp(expectedPoints, settings.creditValueEgp),
    reserveEgp: egp(reservePoints, settings.creditValueEgp),
    creditValueEgp: settings.creditValueEgp,
    jobCapPoints,
    fitsInOneJob,
    maxVolumeInOneJob,
    jobsNeeded,
    notesAr,
  };
}

/** The wording of a result: «حتى حوالي X نقطة (حوالي Y ج.م)» — approximate, computed, never hand-typed. */
export function estimateSummaryAr(result: Extract<EstimateResult, { status: "ok" }>): string {
  const same = result.expectedPoints === result.reservePoints;
  return same
    ? `حتى حوالي ${n(result.expectedPoints)} نقطة (حوالي ${toArabicDigits(Math.round(result.expectedEgp))} ج.م)`
    : `من حوالي ${n(result.expectedPoints)} إلى ${n(result.reservePoints)} نقطة (حوالي ${toArabicDigits(Math.round(result.expectedEgp))} إلى ${toArabicDigits(Math.round(result.reserveEgp))} ج.م)`;
}

/* ---------------------------------------------------------------- the free-text box (deterministic, no model) */

export interface ParsedEstimateText {
  input: EstimateInput | null;
  /** What was understood, one sentence; null when nothing was. */
  understoodAr: string | null;
  /** What is still needed, in plain words. */
  missingAr: string[];
}

/** Reads a free-text request into an estimate input by code rules only (the same reader the chat uses). */
export function parseEstimateText(text: string, today: Date = new Date()): ParsedEstimateText {
  const body = String(text || "").trim().slice(0, 600);
  if (!body) return { input: null, understoodAr: null, missingAr: ["اكتب طلبك أو اختر من النموذج."] };
  const mission = understandMission(body, { today });
  const missingAr: string[] = [];

  let kind: EstimateKind | null = null;
  if (mission.kind === "companies") kind = "companies";
  else if (mission.kind === "people") kind = "people";
  else if (mission.kind === "social_ranked_comments" || mission.kind === "social_channel_topic" || mission.kind === "social_comments_url") kind = "comments";
  else if (mission.kind === "social_feed") kind = /تعليق|كومنت/.test(body) && !/بوست|منشور|تغريد|تويت/.test(body) ? "comments" : /فيديو|مقطع/.test(body) ? "videos" : "posts";
  if (!kind) return { input: null, understoodAr: null, missingAr: ["لم أفهم نوع البيانات؛ اذكر المنصة ونوع البيانات (تعليقات، منشورات، فيديوهات، شركات)."] };

  if ((kind === "comments" || kind === "posts" || kind === "videos") && !mission.platform) missingAr.push("اذكر المنصة.");
  const openEnded = mission.needsCap && !mission.volume;
  if (!mission.volume && !openEnded && kind !== "people" && kind !== "companies") missingAr.push("اذكر العدد المطلوب أو ميزانيتك بالنقاط.");
  const budget = /(?:ميزاني[ةه]|بحد\s*أقصى|حد\s*أقصى)[^\d٠-٩]{0,12}([\d٠-٩]+)\s*نقط/.exec(body.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))));
  return {
    input: { kind, platform: mission.platform, volume: mission.volume, budgetPoints: budget ? Number(budget[1]) : null, openEnded, contactFields: kind === "people" ? (/إيميل|بريد|email/i.test(body) && !/هاتف|تليفون|رقم/.test(body) ? ["work_email"] : /هاتف|تليفون|رقم/.test(body) && !/إيميل|بريد|email/i.test(body) ? ["phone"] : ["work_email", "phone"]) : undefined },
    understoodAr: understoodLineAr(mission),
    missingAr,
  };
}
