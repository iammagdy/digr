import { AXIS_MIN_MARGIN, AXIS_MIN_SCORE } from "./constants";
import { normalizeAr } from "./registry";

/**
 * The health axes of the report and the DETERMINISTIC placement of a post on one of them: Arabic text normalisation (no diacritics, one alef, one yaa, one taa marbuta),
 * whole-word matching with the usual Arabic prefixes and endings, and a weighted score per axis. No model is involved here.
 *
 * What changed against the owner's hand-made file: matching is by WORD, not by substring («قلب» no longer matches inside «انقلب» or «تقلب»), the word «قلب» does not
 * count near the words of heartburn («حرقان القلب» is digestive), and digestive posts have an axis of their own so they are never filed under the heart.
 */
export interface Axis {
  id: string;
  nameAr: string;
  /** Terms with a weight: 3 = names the axis, 2 = strongly associated, 1 = a weak hint. */
  terms: Array<{ term: string; weight: 1 | 2 | 3; /** the term does not count when one of these words is within three words of it */ notNear?: string[] }>;
}

export const GENERAL_AXIS_ID = "general";

export const HEALTH_AXES: readonly Axis[] = [
  {
    id: "weight_drugs",
    nameAr: "أدوية وحقن التخسيس وبدائل التكميم",
    terms: [
      { term: "حقن التخسيس", weight: 3 }, { term: "حقنه التخسيس", weight: 3 }, { term: "اوزمبيك", weight: 3 }, { term: "مونجارو", weight: 3 }, { term: "ساكسيندا", weight: 3 }, { term: "سيماجلوتيد", weight: 3 }, { term: "تيرزيباتيد", weight: 3 },
      { term: "ويجوفي", weight: 3 }, { term: "ريتاتروتيد", weight: 3 }, { term: "التخسيس", weight: 2 }, { term: "تخسيس", weight: 2 }, { term: "انقاص الوزن", weight: 2 }, { term: "نزول الوزن", weight: 2 }, { term: "حرق الدهون", weight: 1 }, { term: "السمنه", weight: 1 }, { term: "الوزن", weight: 1 }, { term: "ريجيم", weight: 1 },
    ],
  },
  {
    id: "drug_prices",
    nameAr: "أزمة أسعار ونواقص الأدوية والبدائل",
    terms: [
      { term: "نواقص الادويه", weight: 3 }, { term: "نقص الادويه", weight: 3 }, { term: "نواقص الدواء", weight: 3 }, { term: "نقص الدواء", weight: 3 }, { term: "اسعار الادويه", weight: 3 }, { term: "سعر الدواء", weight: 3 }, { term: "اسعار الدواء", weight: 3 }, { term: "تسعير الدواء", weight: 3 },
      { term: "بدائل الدواء", weight: 2 }, { term: "بديل الدواء", weight: 2 }, { term: "هيئه الدواء", weight: 2 }, { term: "شعبه الادويه", weight: 2 }, { term: "زياده الاسعار", weight: 1 }, { term: "الصيدليات", weight: 1 }, { term: "صيدليه", weight: 1 }, { term: "الادويه", weight: 1 },
    ],
  },
  {
    id: "insulin_liver",
    nameAr: "مقاومة الإنسولين والكبد الدهني والتغذية العلاجية",
    terms: [
      { term: "مقاومه الانسولين", weight: 3 }, { term: "الكبد الدهني", weight: 3 }, { term: "الانسولين", weight: 2 }, { term: "السكري", weight: 2 }, { term: "مرض السكر", weight: 2 }, { term: "السكر التراكمي", weight: 3 }, { term: "ارتفاع السكر", weight: 2 }, { term: "التغذيه العلاجيه", weight: 3 },
      { term: "اخصائي تغذيه", weight: 2 }, { term: "اخصائيه تغذيه", weight: 2 }, { term: "الكبد", weight: 1 }, { term: "الدهون", weight: 1 }, { term: "نظام غذائي", weight: 1 }, { term: "السكر", weight: 1 },
    ],
  },
  {
    id: "seasonal_viruses",
    nameAr: "الفيروسات الموسمية ومصل الإنفلونزا وحقنة البرد",
    terms: [
      { term: "مصل الانفلونزا", weight: 3 }, { term: "لقاح الانفلونزا", weight: 3 }, { term: "حقنه البرد", weight: 3 }, { term: "حقن البرد", weight: 3 }, { term: "الانفلونزا", weight: 3 }, { term: "انفلونزا", weight: 3 }, { term: "نزلات البرد", weight: 3 }, { term: "نزله برد", weight: 3 },
      { term: "الفيروسات الموسميه", weight: 3 }, { term: "كورونا", weight: 2 }, { term: "كوفيد", weight: 2 }, { term: "متحورات", weight: 2 }, { term: "متحور", weight: 2 }, { term: "الكحه", weight: 1 }, { term: "الزكام", weight: 2 }, { term: "فيروس", weight: 1 }, { term: "الفيروسات", weight: 1 }, { term: "لقاح", weight: 1 }, { term: "الشتاء", weight: 1 },
    ],
  },
  {
    id: "bariatric_cosmetic",
    nameAr: "جراحات السمنة والتجميل والمراكز الطبية",
    terms: [
      { term: "جراحات السمنه", weight: 3 }, { term: "جراحه السمنه", weight: 3 }, { term: "تكميم المعده", weight: 3 }, { term: "عمليه التكميم", weight: 3 }, { term: "تحويل المسار", weight: 3 }, { term: "منظار المعده", weight: 1 }, { term: "جراحات التجميل", weight: 3 }, { term: "جراحه التجميل", weight: 3 },
      { term: "عمليات التجميل", weight: 3 }, { term: "شفط الدهون", weight: 3 }, { term: "نحت الجسم", weight: 2 }, { term: "المراكز الطبيه", weight: 2 }, { term: "مركز طبي", weight: 1 }, { term: "التجميل", weight: 2 },
    ],
  },
  {
    id: "mental_health",
    nameAr: "الصحة النفسية والاكتئاب والضغوط العصبية",
    terms: [
      { term: "الصحه النفسيه", weight: 3 }, { term: "الاكتئاب", weight: 3 }, { term: "اكتئاب", weight: 3 }, { term: "القلق", weight: 2 }, { term: "نوبات الهلع", weight: 3 }, { term: "الضغوط النفسيه", weight: 3 }, { term: "الضغط العصبي", weight: 3 }, { term: "الضغوط العصبيه", weight: 3 },
      { term: "طبيب نفسي", weight: 3 }, { term: "العلاج النفسي", weight: 3 }, { term: "نفسيه", weight: 1 }, { term: "التوتر", weight: 2 }, { term: "الانتحار", weight: 2 }, { term: "ادمان", weight: 1 },
    ],
  },
  {
    id: "heart",
    nameAr: "أمراض القلب والجلطات",
    terms: [
      { term: "امراض القلب", weight: 3 }, { term: "جلطات القلب", weight: 3 }, { term: "الجلطه القلبيه", weight: 3 }, { term: "النوبه القلبيه", weight: 3 }, { term: "نوبات قلبيه", weight: 3 }, { term: "السكته القلبيه", weight: 3 }, { term: "الذبحه الصدريه", weight: 3 }, { term: "قصور القلب", weight: 3 },
      { term: "عضله القلب", weight: 2 }, { term: "الشرايين التاجيه", weight: 3 }, { term: "قسطره القلب", weight: 3 }, { term: "جلطه", weight: 2 }, { term: "الجلطات", weight: 2 }, { term: "جلطات", weight: 2 }, { term: "السكته الدماغيه", weight: 2 }, { term: "الكوليسترول", weight: 1 }, { term: "ضغط الدم", weight: 1 },
      // the bare word «قلب» is a heart disease word only when it is not heartburn («حرقان القلب») or a stomach word nearby
      { term: "القلب", weight: 2, notNear: ["حرقان", "حرقه", "حموضه", "ارتجاع", "المريء", "المعده", "الهضم", "هضم", "القولون"] },
      { term: "قلب", weight: 2, notNear: ["حرقان", "حرقه", "حموضه", "ارتجاع", "المريء", "المعده", "الهضم", "هضم", "القولون"] },
    ],
  },
  {
    id: "digestive",
    nameAr: "الجهاز الهضمي والمعدة والقولون",
    terms: [
      { term: "الجهاز الهضمي", weight: 3 }, { term: "ارتجاع المريء", weight: 3 }, { term: "ارتجاع", weight: 2 }, { term: "المريء", weight: 2 }, { term: "القولون", weight: 3 }, { term: "القولون العصبي", weight: 3 }, { term: "المعده", weight: 2 }, { term: "قرحه المعده", weight: 3 },
      { term: "حموضه المعده", weight: 3 }, { term: "حرقان المعده", weight: 3 }, { term: "حرقان", weight: 2 }, { term: "حرقه", weight: 1 }, { term: "حموضه", weight: 2 }, { term: "عسر الهضم", weight: 3 }, { term: "الهضم", weight: 2 }, { term: "الامساك", weight: 3 }, { term: "امساك", weight: 3 }, { term: "الاسهال", weight: 2 }, { term: "اسهال", weight: 2 }, { term: "الانتفاخ", weight: 2 }, { term: "الغازات", weight: 1 }, { term: "البواسير", weight: 2 }, { term: "المرارة", weight: 2 },
    ],
  },
];

const PREFIX = "(?:[وفبكل]|لل)?(?:ال)?";
const SUFFIX = "(?:ه|ها|هم|ان|ات|ين|ون|ي|ا|يه)?";
const compiled = new Map<string, RegExp>();

function termRegex(term: string): RegExp {
  let re = compiled.get(term);
  if (!re) {
    const body = normalizeAr(term).replace(/^ال/u, "").split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    re = new RegExp(`(?<![\\p{L}\\p{N}])${PREFIX}${body}${SUFFIX}(?![\\p{L}\\p{N}])`, "gu");
    compiled.set(term, re);
  }
  return re;
}

/** The words of a text, normalised (links and the digits of a count are not words). */
export function wordsOf(text: string): string[] {
  return normalizeAr(text).replace(/https?:\/\/\S+/g, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function nearBlocked(words: string[], termWords: number, matchStart: number, blockers: string[]): boolean {
  const stems = blockers.map((blocker) => normalizeAr(blocker).replace(/^ال/u, ""));
  const lo = Math.max(0, matchStart - 3);
  const hi = Math.min(words.length, matchStart + termWords + 3);
  for (let i = lo; i < hi; i++) {
    if (i >= matchStart && i < matchStart + termWords) continue;
    const word = words[i].replace(/^(?:[وفبكل]|لل)?(?:ال)?/u, "");
    if (stems.some((stem) => word === stem || word.startsWith(stem))) return true;
  }
  return false;
}

export interface AxisScores {
  scores: Record<string, number>;
  /** Terms that scored, per axis (for the owner's diagnosis, never shown). */
  hits: Record<string, string[]>;
}

/** The weighted score of every axis for a text. Each distinct term counts once per axis (a repeated word does not make an axis win). */
export function scoreAxes(text: string, axes: readonly Axis[] = HEALTH_AXES): AxisScores {
  const normalized = normalizeAr(text).replace(/https?:\/\/\S+/g, " ");
  const words = wordsOf(text);
  const scores: Record<string, number> = {};
  const hits: Record<string, string[]> = {};
  for (const axis of axes) {
    let score = 0;
    for (const { term, weight, notNear } of axis.terms) {
      const re = termRegex(term);
      re.lastIndex = 0;
      let found = false;
      for (let match = re.exec(normalized); match; match = re.exec(normalized)) {
        if (notNear) {
          // position of the match in words: count the words before it
          const before = normalized.slice(0, match.index).split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
          const termWords = normalizeAr(term).split(" ").length;
          if (nearBlocked(words, termWords, before, notNear)) continue;
        }
        found = true;
        break;
      }
      if (found) {
        score += weight;
        (hits[axis.id] ??= []).push(term);
      }
    }
    scores[axis.id] = score;
  }
  return { scores, hits };
}

export interface AxisPlacement {
  axis: string;
  score: number;
  runnerUp: { axis: string; score: number } | null;
  /** True when the rules cannot settle the post: the best score is below the minimum, or the best two axes are too close. */
  ambiguous: boolean;
}

/** The axis a post's own text places it on, by rules alone; `general` when nothing scores. */
export function placeByRules(text: string, axes: readonly Axis[] = HEALTH_AXES): AxisPlacement {
  const { scores } = scoreAxes(text, axes);
  const ranked = axes.map((axis) => ({ axis: axis.id, score: scores[axis.id] ?? 0 })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1] ?? null;
  if (!best || best.score <= 0) return { axis: GENERAL_AXIS_ID, score: 0, runnerUp: null, ambiguous: true };
  const tooLow = best.score < AXIS_MIN_SCORE;
  const tooClose = Boolean(second) && second!.score >= AXIS_MIN_SCORE && best.score - second!.score < AXIS_MIN_MARGIN;
  return { axis: best.axis, score: best.score, runnerUp: second && second.score > 0 ? second : null, ambiguous: tooLow || tooClose };
}

export const axisNameAr = (id: string, axes: readonly Axis[] = HEALTH_AXES): string => (id === GENERAL_AXIS_ID ? GENERAL_AXIS_NAME_AR : axes.find((axis) => axis.id === id)?.nameAr ?? GENERAL_AXIS_NAME_AR);
export const GENERAL_AXIS_NAME_AR = "موضوعات صحية عامة";
