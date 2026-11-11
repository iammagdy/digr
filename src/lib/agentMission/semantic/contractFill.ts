import type { SocialPlatform } from "../redesignFlagTypes";
import type { SemanticInterpretation } from "./interpret";
import { normalizeArabic } from "./normalizeArabic";

/**
 * PR-1.2: HOW THE SEMANTIC READING JOINS THE REAL REQUEST CONTRACT (`buildRequestContract`). Pure; no I/O; used only when the server-controlled flag `semantic_normalization_v1` is ON (see `flag.ts`). With the flag OFF none of this runs.
 *
 * THE RULE IS FILL-ONLY. The existing parser stays authoritative: a value it produced is kept. The reading may
 *   - FILL a field the parser left empty (platform, comments, replies, parent kind, topic), only from an UNAMBIGUOUS reading (`resolved`; never `ambiguous`, `multiple`, `none`);
 *   - TIGHTEN a topic the parser over-read: when the parser's topic is the reading's topic followed by an output field or an exclusion («السياحة والردود», «السياحة بس استبعد …»), the instruction is cut off the topic;
 *   - CLEAR one wrong value: an X platform that only a bare «X» gave, when the words name it («مطعم اسمه X»).
 * A disagreement (both have a value, they differ) keeps the parser's value and is reported by field name only (never the customer's words).
 */
export type FillField = "platform" | "comments" | "replies" | "parentKind" | "topic" | "period" | "country" | "language";
export interface FillReport {
  filled: FillField[];
  tightened: FillField[];
  cleared: FillField[];
  /** PR-1.3: the parser's value was DEMONSTRABLY wrong for the words typed (a month range read as its first month, «فمصر» read as no country) and the explicit wording replaced it. Field names only. */
  corrected: FillField[];
  /** Both the parser and the reading have a value and they differ: the parser's is kept. */
  disagreements: FillField[];
}
export const emptyFillReport = (): FillReport => ({ filled: [], tightened: [], cleared: [], corrected: [], disagreements: [] });

/** The platform after the reading: the parser's value, filled, or cleared (a bare «X» that the words show is a name). */
export function platformWithReading(existing: SocialPlatform | null, reading: SemanticInterpretation, report: FillReport): SocialPlatform | null {
  const p = reading.platform;
  if (p.status === "resolved") {
    if (existing === null) { report.filled.push("platform"); return p.id; }
    if (existing !== p.id) report.disagreements.push("platform");
    return existing;
  }
  if (existing === "x" && p.status === "none" && reading.ambiguities.includes("platform:x_treated_as_name")) { report.cleared.push("platform"); return null; }
  return existing;
}

/**
 * CONSOLIDATED MISSION (mt-03, mt-04, mt-06, mt-07): THE CUSTOMER'S ANSWER, READ ON ITS OWN, is their latest word. A platform it names alone («تك توك», «انستاجرام», «لا خليهم تيك توك») fills the request's empty platform or REPLACES the one the request named
 * (a correction is never appended to the old value). «أقصد تيك توك مش يوتيوب» names two: the one after a negation («مش», «بدل», «not», «instead of») is the superseded one, so the other is kept. Anything else (two platforms with no negation, none) changes nothing.
 * Reported by field name only (`filled` or `corrected`).
 */
const NEGATED = /(?:^|\s)(?:مش|مو|ليس|بدل|بدلا\s+من|بدال|not|instead\s+of)\s+(\S+(?:\s+\S+)?)/gi;
export function platformFromAnswer(existing: SocialPlatform | null, answerReading: SemanticInterpretation | null, negatedPlatformsOf: (phrase: string) => SocialPlatform[], answer: string, report: FillReport): SocialPlatform | null {
  if (!answerReading) return existing;
  const p = answerReading.platform;
  let chosen: SocialPlatform | null = null;
  if (p.status === "resolved") chosen = p.id;
  else if (p.status === "multiple") {
    const negated = new Set<SocialPlatform>();
    for (const m of answer.matchAll(NEGATED)) for (const id of negatedPlatformsOf(m[1])) negated.add(id);
    const kept = p.ids.filter((id) => !negated.has(id));
    if (negated.size > 0 && kept.length === 1) chosen = kept[0];
  }
  if (chosen === null || chosen === existing) return existing;
  if (existing === null) report.filled.push("platform");
  else report.corrected.push("platform");
  return chosen;
}

/** The words after which the request contract's own topic rule stops (the same list as its lookahead): a country, a period, a language, a count, a source are not the topic. */
const TOPIC_STOP: ReadonlySet<string> = new Set(["من", "في", "على", "علي", "آخر", "اخر", "بالعربي", "بالعربية", "مع", "بين", "منذ", "خلال", "in", "on", "from", "with", "between", "during", "since", "last"]);
const cutAtStop = (topic: string): string => {
  const words = topic.split(" ");
  const at = words.findIndex((w, i) => i > 0 && TOPIC_STOP.has(w));
  return (at < 0 ? words : words.slice(0, at)).join(" ");
};

/**
 * PR-1.3: a phrase the conditions reader found (a period, a language word, a country with its locative) is never part of the research topic. When the topic ENDS with such a phrase («السياحة الشهر اللي فات», «السياحة بالفرنسي») it is cut off.
 * Compared word by word on the normalized words, so the customer's own spelling in the topic is kept.
 */
export function topicWithoutConditions(topic: string | null, phrases: ReadonlyArray<ReadonlyArray<string>>, report: FillReport): string | null {
  if (topic === null || phrases.length === 0) return topic;
  const words = topic.split(/\s+/).filter(Boolean);
  const normalized = words.map((w) => normalizeArabic(w));
  let cut = words.length;
  for (const phrase of phrases) {
    if (phrase.length === 0) continue;
    for (let at = 1; at + phrase.length <= words.length; at += 1) {
      if (phrase.every((t, o) => normalized[at + o] === t)) { cut = Math.min(cut, at); break; }
    }
  }
  if (cut >= words.length) return topic;
  report.tightened.push("topic");
  return words.slice(0, cut).join(" ");
}

/** The topic after the reading: the parser's, filled when it has none, or tightened when it kept an output field or an exclusion inside it. */
export function topicWithReading(existing: string | null, reading: SemanticInterpretation, report: FillReport): string | null {
  const read = reading.topic === null ? null : cutAtStop(reading.topic).trim();
  if (read === null || read === "") return existing;
  if (existing === null) { report.filled.push("topic"); return read; }
  const have = normalizeArabic(existing);
  const want = normalizeArabic(read);
  if (have === want) return existing;
  if ((reading.topic_cut === "output_field" || reading.topic_cut === "exclusion") && have.startsWith(`${want} `)) { report.tightened.push("topic"); return read; }
  report.disagreements.push("topic");
  return existing;
}
