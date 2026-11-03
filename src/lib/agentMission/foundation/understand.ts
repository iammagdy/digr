/**
 * F1, THE UNDERSTAND STEP (docs/FOUNDATION-PLAN.md section 3.1): which channels are «the official channels» of a request is not decidable by code, so a small structured model request FILLS that field of the Ask, and code CHECKS every value against the customer's own words:
 * a name is kept only when every word of it (without «الرسمية / قناة / نادي») is in the request. A name the customer never wrote, a Latin one, an invented one, is dropped; an answer with nothing usable leaves the names code reads from the topic (`officialChannelQueriesOf`).
 * The model decides no row, no count and no money. Pure here: the call itself is agent/src/understandStep.ts.
 */
const norm = (s: string): string => s.replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase().replace(/\s+/g, " ").trim();
const GENERIC = new Set(["الرسميه", "الرسمي", "رسميه", "رسمي", "قناه", "قنوات", "نادي", "ناديي", "الرسميين"]);
const ARABIC = /[؀-ۿ]/;
const MAX_CHANNELS = 3;

/** The channel names the customer's words support, each written as the query the channel search takes («الأهلي» -> «الأهلي الرسمية»). */
export function checkChannelsAgainstWords(names: ReadonlyArray<unknown>, requestText: string): string[] {
  const text = ` ${norm(requestText)} `;
  const out: string[] = [];
  for (const raw of names) {
    const name = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (name === "" || name.length > 60 || !ARABIC.test(name)) continue;
    const words = norm(name).split(" ").filter((w) => w !== "" && !GENERIC.has(w));
    if (words.length === 0) continue;
    // every word is in the customer's request (a word may carry «ال» or a glued «و» there)
    if (!words.every((w) => { const bare = w.replace(/^ال/, ""); return bare.length > 1 && (text.includes(` ${w} `) || text.includes(` ${bare} `) || text.includes(` ال${bare} `) || text.includes(` وال${bare} `) || text.includes(` و${bare} `) || text.includes(` و${w} `)); })) continue;
    const query = /رسمي/.test(norm(name)) ? name : `${name} الرسمية`;
    if (!out.includes(query)) out.push(query);
    if (out.length >= MAX_CHANNELS) break;
  }
  return out;
}

export const UNDERSTAND_SYSTEM = "You read a customer's request written in Arabic and answer with JSON only. No explanation.";
export function understandChannelsPrompt(request: string, topic: string | null): string {
  return `The customer asked for videos from «the official channels». List the names, in Arabic exactly as the customer would write them, of the organisations whose official YouTube channels they mean (for a match between two clubs: both clubs; add the league or federation only if the request names it). Use only names that appear in the request.\n\nRequest: ${request}\nTopic: ${topic ?? ""}\n\nAnswer with JSON only: {"channels": ["name 1", "name 2"]}`;
}
/** The names out of the model's answer: a JSON object with an array `channels` of strings; anything else is null. */
export function parseChannels(text: string | null | undefined): string[] | null {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ""));
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { channels?: unknown };
    return Array.isArray(v.channels) ? v.channels.filter((x): x is string => typeof x === "string").slice(0, 6) : null;
  } catch { return null; }
}
