import { toArabicDigits } from "../../../arabicDigits";

/**
 * ROUND 33, CATALOG DISCOVERY: THE CHANNEL FROM EVIDENCE. «القناة الرسمية لـ X» names an organisation, not a channel. The channel search returns candidates with a title, a handle and a subscriber text; code decides from THAT evidence, never from the order of the results:
 *  - exactly one candidate carries every word of the name (apart from the words that only say «official» or «channel»): that is the channel;
 *  - none or several do: the customer picks, shown the candidates' own title, handle and subscribers (a question is asked only when the evidence cannot single one out);
 *  - no candidate at all: nothing to ask about (the caller ends honestly).
 * Used only with the discovery switch (a test account); the official-channels flow of every other mission is what it was. Pure.
 */
export interface ChannelCandidate { id: string; title?: string; handle?: string; subscribers?: string }
export type ChannelEvidence = { kind: "one"; channel: ChannelCandidate } | { kind: "ambiguous"; options: ChannelCandidate[] } | { kind: "none" };

const norm = (s: string): string => s.replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase();
const NOISE = new Set(["الرسميه", "الرسمي", "رسمي", "رسميه", "official", "قناه", "channel", "القناه"]);
export const CHANNEL_OPTIONS_MAX = 3;

export function channelEvidenceOf(name: string, rows: ReadonlyArray<ChannelCandidate>): ChannelEvidence {
  const usable = rows.filter((r) => typeof r.id === "string" && r.id !== "");
  if (usable.length === 0) return { kind: "none" };
  const words = norm(name).split(/\s+/).map((w) => w.replace(/^ال/, "")).filter((w) => w.length > 1 && !NOISE.has(w) && !NOISE.has(`ال${w}`));
  const matching = words.length === 0 ? [] : usable.filter((r) => { const hay = norm(`${r.title ?? ""} ${(r.handle ?? "").replace(/^@/, "")}`); return words.every((w) => hay.includes(w)); });
  if (matching.length === 1) return { kind: "one", channel: matching[0] };
  return { kind: "ambiguous", options: (matching.length > 1 ? matching : usable).slice(0, CHANNEL_OPTIONS_MAX) };
}

/** What answers the question for a candidate: its handle (the answer is read as a handle), else its channel id. */
export const channelAnswerOf = (c: ChannelCandidate): string => (c.handle ? (c.handle.startsWith("@") ? c.handle : `@${c.handle}`) : c.id);

const lineOf = (c: ChannelCandidate, i: number): string => `${toArabicDigits(i + 1)}. ${c.title ?? c.handle ?? c.id}${c.handle ? ` (${c.handle.startsWith("@") ? c.handle : `@${c.handle}`})` : ""}${c.subscribers ? ` — ${c.subscribers}` : ""}`;
export const youtubeChannelChoiceQuestionAr = (name: string, options: ReadonlyArray<ChannelCandidate>): string =>
  `لم نستطع أن نحدد من نتائج البحث وحدها القناة الرسمية المقصودة باسم «${name}». هذه أقرب القنوات التي وجدناها:\n${options.map(lineOf).join("\n")}\nاختر القناة التي تقصدها لنقرأ فيديوهاتها.`;
