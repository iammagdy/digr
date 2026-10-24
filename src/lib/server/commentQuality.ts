/**
 * What counts as a usable comment when comments are collected by topic (the videos are found by a search, so the comments are the
 * deliverable and a handful of characters is not one). Pure: the same rule filters the rows the adapter reads and the rows the
 * worker's gate judges. Money is untouched: a dropped comment is simply not a delivered unit.
 */

import { topicStems } from "./topicMatch";

const URL_RE = /(?:https?:\/\/|www\.)\S+/giu;
const MENTION_RE = /@\S+/gu;

/** The shortest comment that says anything: three letters. «Wr», «ok», «👍» and «..» do not. */
export const MIN_MEANINGFUL_CHARS = 3;

const COMMENT_TEXT_KEYS = ["text", "comment_text", "comment", "content", "message", "commentText"];

export function commentTextOf(row: Record<string, any>): string {
  for (const key of COMMENT_TEXT_KEYS) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** The letters that carry meaning: links, mentions, hashtags, digits, emoji and punctuation do not count. */
export function meaningfulChars(text: string): number {
  const stripped = String(text || "").replace(URL_RE, " ").replace(MENTION_RE, " ");
  let count = 0;
  for (const ch of stripped) if (/\p{L}/u.test(ch)) count += 1;
  return count;
}

export type CommentDrop = "empty" | "too_short" | "link_only";

/** Why a comment is not usable, or null when it is. */
export function commentDropReason(text: string): CommentDrop | null {
  const raw = String(text || "").trim();
  if (!raw) return "empty";
  const letters = meaningfulChars(raw);
  if (letters >= MIN_MEANINGFUL_CHARS) return null;
  return letters === 0 && /(?:https?:\/\/|www\.)\S+/iu.test(raw) ? "link_only" : "too_short";
}

export const isUsableComment = (row: Record<string, any>): boolean => commentDropReason(commentTextOf(row)) === null;

export type CommentLanguage = "ar" | "en" | "other";

/** The language of a comment by its letters: mostly Arabic letters is Arabic, mostly Latin letters is English (the source does not say). */
export function commentLanguageOf(text: string): CommentLanguage {
  let arabic = 0;
  let latin = 0;
  let other = 0;
  for (const ch of String(text || "").replace(URL_RE, " ")) {
    if (/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/u.test(ch)) arabic += 1;
    else if (/[A-Za-z]/.test(ch)) latin += 1;
    else if (/\p{L}/u.test(ch)) other += 1;
  }
  const total = arabic + latin + other;
  if (total === 0) return "other";
  if (arabic / total >= 0.4) return "ar";
  if (latin / total >= 0.6) return "en";
  return "other";
}

export const COMMENT_LANGUAGE_LABEL_AR: Record<CommentLanguage, string> = { ar: "عربي", en: "إنجليزي", other: "لغة أخرى" };

/** An Arabic request is one whose subject is written in Arabic letters: its comments are delivered in Arabic first. */
export function requestWantsArabicComments(params: Record<string, any>): boolean {
  const subject = String(params?.query ?? params?.subject ?? "");
  const arabic = (subject.match(/[؀-ۿ]/gu) || []).length;
  return arabic >= 2;
}

/** The comment's identity for «exact repeat» purposes under one video: the same words, ignoring case, spacing and punctuation. */
export function repeatKey(row: Record<string, any>): string {
  const text = commentTextOf(row).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
  const video = String(row?.video_url ?? "").trim();
  return `${video}|${text}`;
}

/* ------------------------------------------------------------------ generic supplications and reactions */

/**
 * A comment that is only a supplication or blessing («اللهم …», «ما شاء الله», «بارك الله فيك») or «تسلم ايدك» says
 * nothing about the subject of the video, whatever the video is. A topic search must not fill its volume with them, and they must not be a
 * delivered (charged) unit: they are dropped by CODE before any review, with an Arabic reason. A comment that does name the topic is judged
 * by the relevance gate as usual (the gate lets a topical comment through, see researchRelevanceGate).
 *
 * Deliberately narrow: «اللهم» as the first word, or EVERY word of a short comment (at most eight) taken from the list of blessing, supplication
 * and «تسلم ايدك». A plain «شكرا» and the praise words that can describe the subject («حلو», «جامد اوي», «هدف رائع», «مبروك») are NOT on the list: the
 * golden tests deliver short real comments of an on-topic video «whatever they say», and that rule stays. One other word in the comment («ماتش حلو») keeps it. `commentDropReason` is unchanged: this is a second rule.
 */
const GENERIC_WORDS = new Set([
  // blessing and supplication formulas
  "ما", "شاء", "ماشاء", "ماشاءالله", "الله", "لله", "الحمد", "سبحان", "تبارك", "جزاك", "جزاكم", "خيرا", "بارك", "فيك", "فيكم", "يبارك", "يحفظك", "يحفظكم", "حفظك", "حفظكم", "يحفظ",
  "ربنا", "يوفقك", "يوفقكم", "يكرمك", "يرحمه", "يرحمك", "يعافيك", "يا", "رب", "يارب", "امين", "اكبر", "صلي", "علي", "النبي", "محمد", "عليه", "الصلاه", "والسلام", "وسلم", "والله",
  // «تسلم ايدك» and its family
  "تسلم", "ايدك", "ايديك", "الايادي", "ايدكم", "يسلمو", "يسلموا", "يسلم",
  "mashallah", "bless", "god",
]);
const MAX_GENERIC_WORDS = 8;

function normalizeGenericText(text: string): string {
  return String(text || "")
    .replace(URL_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(/[ً-ٰٟـ]/gu, "")
    .replace(/[أإآ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export type GenericComment = "supplication" | "reaction";

export function genericCommentKind(text: string): GenericComment | null {
  const norm = normalizeGenericText(text);
  if (!norm) return null;
  const words = norm.split(" ");
  if (words[0] === "اللهم" || /^و?اللهم$/u.test(words[0])) return "supplication";
  if (words.length > MAX_GENERIC_WORDS) return null;
  return words.every((word) => GENERIC_WORDS.has(word.replace(/^و(?=\p{L}{3,})/u, "")) || GENERIC_WORDS.has(word)) ? "reaction" : null;
}

export const isGenericComment = (text: string): boolean => genericCommentKind(text) !== null;

/** Said in the gate's reason column and in the plan notes: no provider word, no number. */
export const GENERIC_COMMENT_REASON_AR = "تعليق دعاء أو عبارة عامة لا يتناول موضوع البحث";

/* ------------------------------------------------------------------ pleasantries (the Facebook keyword service only) */

/**
 * «بالتوفيق ان شاء الله يا دكتر», «بسم لله ما شاء الله حفظك الله ورعاك», «تحيا مصر تحيا مصر بالتوفيق دائما والله المستعان»: a comment that is only good wishes, blessings, praise, thanks, prayer and
 * forms of address says nothing about the subject of the post, and a customer who asked for what people say about a topic does not want to pay for it.
 * The first rule (every word on a list) missed a comment with one extra word, a typo («دكتر»), a glued formula («شاءالله»), a repeated phrase or a long blessing. This one counts:
 *  1. the text is normalised: emoji, links, mentions, diacritics and tatweel are removed, the alef / ya / ta marbuta spellings are unified, a letter repeated three times or more
 *     becomes one («جدااا»), glued formulas are split («انشاءالله», «بسمالله», «ماشاءالله»), and a phrase repeated in a row is kept once;
 *  2. connecting words («و», «يا», «في», «من», «كل», «انت»…) are neutral: they count for or against nothing;
 *  3. it is a pleasantry when at least one STRONG marker (a wish, a blessing, a prayer, thanks, a cheer) is present, at least 75% of the other words are pleasantry words
 *     (wishes, blessings, praise, thanks, titles) and at most three words are anything else;
 *  4. a comment is NEVER a pleasantry when it carries a content marker: a number, a question (a mark or a question word), a request («ياريت», «لو سمحت», «نرجو»…),
 *     a complaint, a duty or an opinion word («مش», «غير», «ليس», «لازم», «بس», «غالي»…), or a word of the request's own topic. A polite word inside such a comment keeps nothing out.
 * Used by the Facebook keyword service only: the other services keep their own rule (`isGenericComment`) and no relevance is loosened anywhere.
 */
const EMOJI_RE = /[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}⃣]/gu;
const DIGIT_RE = /[0-9٠-٩۰-۹]/u;

/** Words that make a comment a wish, a blessing, a prayer, thanks or a cheer (normalised spellings). At least one is needed. */
const STRONG_WORDS = new Set([
  "توفيق", "التوفيق", "بالتوفيق", "موفق", "موفقه", "موفقين", "نجاح", "النجاح", "بالنجاح", "ناجح", "ناجحه", "سداد", "السداد", "بالسداد", "تسديد", "فلاح", "الفلاح", "تفوق", "التفوق", "بالتفوق", "تميز", "التميز", "بالتميز", "نصر", "التمكين", "تمكين",
  "مبروك", "مبارك", "تهنئه", "تهانينا", "تهاني", "تحياتي", "تحيه", "تحيات", "احترامي", "تقديري", "تقدير", "تمنياتي", "اتمني", "نتمني", "تمني", "نتمناله",
  "شكرا", "شكر", "الشكر", "نشكركم", "نشكرك", "اشكركم", "اشكرك", "ممتن", "ممتنين", "متشكر", "متشكرين", "تسلم", "تسلمي", "ايدك", "ايديك", "ايدكم", "الايادي",
  "الله", "لله", "شاء", "ربنا", "ربي", "يارب", "رب", "العالمين", "المستعان", "الحمد", "سبحان", "تبارك", "بسم", "بارك", "باركك", "يبارك", "جزاك", "جزاكم", "يجزيك", "يوفقك", "يوفقكم", "يحفظك", "يحفظكم", "حفظك", "حفظكم", "حفظه", "يرعاك", "يرعاكم", "رعاك", "رعاكم", "ورعاك", "يكرمك", "يكرمكم", "يسعدك", "يسعدكم", "يعزك", "يعافيك", "يرحمك", "يرحمه", "يهديك", "يديك", "امين", "تحياامصر", "تحيامصر", "ابنحلال", "بخير", "عيد", "رمضان", "عام",
]);
/** Words that dress a wish (praise, titles, modifiers): they count as pleasantry words but never make a comment one on their own. */
const SOFT_WORDS = new Set([
  "دائم", "الدائم", "دايم", "دايما", "دائما", "دوما", "مستمر", "المستمر", "مستمره", "الدائمه", "دائمين", "خير", "خيرا", "الخير", "كريم", "سعيد", "عظيم", "رائع", "ممتاز", "جميل", "مبدع", "محترم", "قدير", "كفو", "حلال", "تستاهل", "يستاهل", "تستاهلي", "يستحق", "تستحق", "حبيبي",
  "صباح", "مساء", "سلام", "السلام", "عليكم", "ورحمه", "وبركاته", "جزيل", "وفقك", "وفقكم", "الرحمن", "الرحيم", "نجاحا", "تحيا", "عاش", "تعيش", "يعيش", "نصرا",
  // titles and words of address
  "دكتور", "دكتر", "دكتوره", "دكاتره", "الدكتور", "الدكتوره", "د", "دكتورنا", "بروفيسور", "باشا", "بيه", "افندم", "فندم", "يافندم", "سعاده", "سياده", "معالي", "معاليه", "فضيله", "حضرتك", "حضرتكم", "سيادتك", "سيادتكم", "سعادتك", "سعادتكم", "معاليك", "سيدي", "سيدتي",
  "الوزير", "وزير", "الوزيره", "الاستاذ", "استاذ", "الاستاذه", "استاذه", "المهندس", "مهندس", "المهندسه", "الشيخ", "شيخ", "الحاج", "حاج", "السيد", "سيد", "السيده", "الاخ", "اخي", "اخ", "الاخت", "اختي", "رئيس", "الرئيس", "المحافظ", "محافظ", "النائب", "نائب", "الفريق", "فريق", "اللواء", "لواء", "العميد", "عميد", "المدير", "مدير", "المديره", "مديره", "الاداره", "فريقنا", "الله",
]);
/** Connecting words: ignored (they neither make a comment a pleasantry nor save it). */
const NEUTRAL_WORDS = new Set(["و", "يا", "ان", "في", "من", "علي", "الي", "عن", "مع", "ده", "دي", "دا", "هو", "هي", "كل", "لك", "لكم", "له", "لها", "بك", "بكم", "فيك", "فيكم", "ليك", "ليكم", "انت", "انتا", "انتي", "انتم", "ما", "ال", "ل", "ب", "ف", "ك", "ثم", "او", "حتي", "كده", "اللي", "الذي", "التي"]);
/** Content markers: a comment with any of these is never a pleasantry. */
const QUESTION_WORDS = new Set(["هل", "ليه", "ليش", "لماذا", "ازاي", "كيف", "متي", "فين", "اين", "ايه", "ماذا", "كام", "مين", "ايش", "امتي", "عشان", "لانه"]);
const REQUEST_WORDS = new Set(["ياريت", "يريت", "ريت", "سمحت", "فضلك", "نرجو", "ارجو", "رجاء", "برجاء", "ارجوكم", "نطلب", "اطلب", "اطلبوا", "مطلوب", "محتاج", "محتاجه", "محتاجين", "عايز", "عاوز", "عايزين", "عاوزين", "نناشد", "اناشد", "ناشد", "ننتظر", "استفسار", "سؤال", "اسال", "نسال", "تفضلوا"]);
const OPINION_WORDS = new Set(["مش", "ليس", "ليست", "لا", "غير", "مفيش", "بدون", "بس", "لكن", "لكنه", "لازم", "يجب", "ينبغي", "ضروري", "ضروريه", "مفروض", "المفروض", "مشكله", "مشاكل", "سيء", "سيئ", "سيي", "غلاء", "فساد", "ظلم", "ظالم", "عدل", "حرام", "معقول", "للاسف", "اسف", "كفايه", "الغاء", "قرار", "رفض", "نرفض", "ارفض", "تاخير", "تأخير", "اهمال", "اهمالكم", "فشل", "كارثه", "كوارث", "استغاثه", "شكوي", "شكاوي", "اشتكي"]);
const MAX_OTHER_WORDS = 3;
const MIN_PLEASANTRY_RATIO = 0.75;

function normalizePleasantryText(text: string): string {
  let norm = String(text || "")
    .replace(URL_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(EMOJI_RE, " ")
    .replace(/[ً-ٰٟـ]/gu, "")
    .replace(/[أإآٱ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(/ؤ/gu, "و")
    .replace(/ئ/gu, "ي")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/(.)\1{2,}/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  // glued and mis-spelled formulas become the formula, with its spaces
  norm = norm
    .replace(/ان\s*شاء\s*الله|انشاء\s*الله|انشالله|انشاالله|ان\s*شالله/gu, " ان شاء الله ")
    .replace(/ما\s*شاء\s*الله|ماشاء\s*الله|ماشالله|ماشاالله|ما\s*شالله/gu, " ما شاء الله ")
    .replace(/بسم\s*الله|بسمالله|بسم\s*لله/gu, " بسم الله ")
    .replace(/الحمد\s*لله|الحمدلله|الحمد\s*الله/gu, " الحمد لله ")
    .replace(/جزاك\s*الله|جزاكم\s*الله|جزاكالله/gu, " جزاك الله ")
    .replace(/تحيا\s*مصر/gu, " تحيامصر ")
    .replace(/ابن\s*(?:ال)?حلال|ولاد\s*(?:ال)?حلال/gu, " ابنحلال ");
  return norm.replace(/\s+/gu, " ").trim();
}

/** A phrase said twice in a row is said once («تحيا مصر تحيا مصر» is one cheer). Runs from phrases of four words down to single words, until nothing repeats. */
function collapseRepeats(tokens: string[]): string[] {
  let out = tokens;
  for (let n = 4; n >= 1; n -= 1) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i + 2 * n <= out.length; i += 1) {
        if (out.slice(i, i + n).join(" ") === out.slice(i + n, i + 2 * n).join(" ")) {
          out = [...out.slice(0, i + n), ...out.slice(i + 2 * n)];
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}

/** The spellings of a word to look up: itself, without a one-letter prefix («وربنا», «لنجاح», «بالتوفيق»), without «ال». */
function lookupForms(token: string): string[] {
  const forms = new Set<string>([token]);
  if (token.length >= 4 && /^[وفبلك]/u.test(token)) forms.add(token.slice(1));
  for (const form of [...forms]) if (form.length >= 4 && form.startsWith("ال")) forms.add(form.slice(2));
  if (token.length >= 5 && /^يا/u.test(token)) forms.add(token.slice(2));
  return [...forms];
}
const inSet = (set: ReadonlySet<string>, token: string): boolean => lookupForms(token).some((form) => set.has(form));

export interface PleasantryOptions {
  /** The request's own topic: a comment that uses one of its words is never a pleasantry. */
  topic?: string;
}

export function isPureWellWish(text: string, options: PleasantryOptions = {}): boolean {
  const raw = String(text || "");
  // content markers that do not need the words
  if (DIGIT_RE.test(raw.replace(URL_RE, " ")) || /[?؟]/u.test(raw)) return false;
  const norm = normalizePleasantryText(raw);
  if (!norm) return false;
  const all = collapseRepeats(norm.split(" "));
  const tokens = all.filter((token) => !inSet(NEUTRAL_WORDS, token));
  if (tokens.length === 0) return false;
  if (tokens.some((token) => inSet(QUESTION_WORDS, token) || inSet(REQUEST_WORDS, token) || inSet(OPINION_WORDS, token))) return false;
  const stems = options.topic ? topicStems(options.topic) : [];
  if (stems.length > 0 && tokens.some((token) => stems.some((stem) => token.includes(stem)))) return false;
  const strong = tokens.filter((token) => inSet(STRONG_WORDS, token)).length;
  const pleasantry = tokens.filter((token) => inSet(STRONG_WORDS, token) || inSet(SOFT_WORDS, token)).length;
  const others = tokens.length - pleasantry;
  return strong >= 1 && others <= MAX_OTHER_WORDS && pleasantry / tokens.length >= MIN_PLEASANTRY_RATIO;
}

/** Said in the gate's reason column and in the stop sentence: no provider word. */
export const WELL_WISH_REASON_AR = "تعليق دعاء أو مجاملة بلا مضمون يتناول موضوع البحث";

