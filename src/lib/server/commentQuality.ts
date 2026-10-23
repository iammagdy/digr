/**
 * What counts as a usable comment when comments are collected by topic (the videos are found by a search, so the comments are the
 * deliverable and a handful of characters is not one). Pure: the same rule filters the rows the adapter reads and the rows the
 * worker's gate judges. Money is untouched: a dropped comment is simply not a delivered unit.
 */

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
