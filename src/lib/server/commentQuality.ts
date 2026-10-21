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
