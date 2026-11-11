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
export type FillField = "platform" | "comments" | "replies" | "parentKind" | "topic";
export interface FillReport {
  filled: FillField[];
  tightened: FillField[];
  cleared: FillField[];
  /** Both the parser and the reading have a value and they differ: the parser's is kept. */
  disagreements: FillField[];
}
export const emptyFillReport = (): FillReport => ({ filled: [], tightened: [], cleared: [], disagreements: [] });

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

/** The words after which the request contract's own topic rule stops (the same list as its lookahead): a country, a period, a language, a count, a source are not the topic. */
const TOPIC_STOP: ReadonlySet<string> = new Set(["من", "في", "على", "علي", "آخر", "اخر", "بالعربي", "بالعربية", "مع", "بين", "منذ", "خلال", "in", "on", "from", "with", "between", "during", "since", "last"]);
const cutAtStop = (topic: string): string => {
  const words = topic.split(" ");
  const at = words.findIndex((w, i) => i > 0 && TOPIC_STOP.has(w));
  return (at < 0 ? words : words.slice(0, at)).join(" ");
};

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
