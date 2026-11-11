import { findTerms, type AskId, type ContentId, type PlatformId, type TermMatch } from "./lexicon";
import { semanticText } from "./normalizeArabic";

/**
 * PR-1.1: a READ of what a request says, built only from the controlled vocabulary of `lexicon.ts` and the normalizer of `normalizeArabic.ts`. Pure, offline, deterministic, no model, no network, no state, and NOT connected to the product (the parser, the
 * chat and the worker do not call it; `flag.ts` is the only door and it is closed by default).
 *
 * THE RULES OF THIS READ
 *   - It never guesses. What the words do not settle stays in `ambiguities` and in `platform.status` (`ambiguous`, `multiple`), never turned into a decision.
 *   - A TOPIC (what the content is about) is kept apart from what is REQUESTED (what is to be collected). Only the words OUTSIDE the topic count as a request for posts, videos, comments or replies: «هات منشورات عن الكومنتات» asks for posts about comments.
 *   - A platform named only INSIDE the topic («منشورات عن تيك توك») is a subject, not a source: it stays ambiguous.
 *   - A bare «x» / «اكس» is the platform only after a platform cue («على X», «منصة X») with content requested and no name cue in front of it; after «مطعم اسمه» it is a name; otherwise it is undecided.
 *   - Messengers and «messages» are not vocabulary at all (see the header of `lexicon.ts`): this read can never express «read a private conversation», and it is never given to, nor read by, the privacy rules of `guardRules.ts`.
 *   - Dates, countries, languages, counts and file formats are NOT read here (PR-1.2 and later).
 */
export type PlatformReading =
  | { status: "none" }
  | { status: "resolved"; id: PlatformId; evidence: "named" | "named_with_cue" | "implied_by_content" }
  | { status: "ambiguous"; candidates: PlatformId[]; reason: "bare_x_without_cue" | "named_only_in_topic" }
  | { status: "multiple"; ids: PlatformId[] };

export interface SemanticInterpretation {
  /** The input exactly as received (never altered; for display and audit). */
  original: string;
  /** The conservative normalized text this read was made from. */
  normalized: string;
  /** The text carries an ask («عايز», «هات», «محتاج», «اجمع», «طلعلي» …). */
  is_request: boolean;
  asks: AskId[];
  platform: PlatformReading;
  /** What is requested, outside the topic. Comments and replies are separate; posts and videos are separate. */
  content: Record<ContentId, boolean>;
  /** The kind of the parent items when the words settle it (posts, videos or tweets); null when none or when they conflict. */
  parent_kind: "posts" | "videos" | "tweets" | null;
  /** The research topic in the customer's own letters, or null when no topic marker settles it. */
  topic: string | null;
  /** Why the topic ended before the end of the text: an output field («والردود»), an exclusion («استبعد …»), a platform introduced as the source («على تيك توك»); null when it ran to the end. */
  topic_cut: "output_field" | "exclusion" | "platform" | null;
  /** What the words leave undecided, as stable codes. */
  ambiguities: string[];
}

const TOPIC_MARKERS: ReadonlySet<string> = new Set(["عن", "حول", "بخصوص", "بشان", "about", "regarding", "concerning"]);
/** «الخاصة بالسياحة» / «المتعلقة بالدوري»: the marker is two words and the second starts with بـ. */
const TOPIC_PHRASE_HEADS: ReadonlySet<string> = new Set(["الخاصه", "الخاصين", "الخاصات", "المتعلقه", "المتعلقين", "المتعلقات"]);
const PREPOSITIONS: ReadonlySet<string> = new Set(["من", "على", "علي", "في", "عبر", "from", "on", "in", "via", "at"]);
const EXCLUSION_CUES: ReadonlySet<string> = new Set(["استبعد", "استبعدي", "بدون", "ماعدا", "except", "without", "exclude"]);
const TRAILING_FILLERS: ReadonlySet<string> = new Set(["بس", "فقط", "كمان", "only"]);
const NAME_CUES: ReadonlySet<string> = new Set(["اسمه", "اسمها", "اسم", "مطعم", "مطاعم", "شركه", "شركات", "محل", "محلات", "ماركه", "براند", "كافيه", "فندق", "عياده", "مستشفي", "named", "called", "restaurant", "company", "shop", "store", "brand", "cafe", "hotel", "clinic"]);
const PLATFORM_CUES: ReadonlySet<string> = new Set(["منصه", "موقع", "تطبيق", "على", "علي", "من", "في", "عبر", "app", "platform", "site", "website", "from", "on", "via", "at", "in"]);

const isArabicToken = (key: string): boolean => /^[ء-ي]+$/.test(key);
const contentId = (m: TermMatch): ContentId | null => (m.entry.category === "content" ? (m.entry.id as ContentId) : null);

function topicSpan(keys: readonly string[], tokens: readonly string[], terms: readonly TermMatch[]): { marker: number; start: number; end: number; firstToken: string | null; cut: SemanticInterpretation["topic_cut"] } | null {
  let marker = -1;
  let start = -1;
  let firstToken: string | null = null;
  for (let i = 0; i < keys.length && marker < 0; i++) {
    if (TOPIC_MARKERS.has(keys[i]) && keys[i + 1] !== "طريق") { marker = i; start = i + 1; }
    else if (TOPIC_PHRASE_HEADS.has(keys[i]) && keys[i + 1] !== undefined && keys[i + 1].startsWith("ب") && keys[i + 1].length > 3) {
      marker = i; start = i + 1; firstToken = tokens[i + 1].slice(1); // «بالسياحه» → «السياحه»
    }
  }
  if (marker < 0 || start >= keys.length) return null;
  let end = keys.length;
  let cut: SemanticInterpretation["topic_cut"] = null;
  const termAt = (j: number) => terms.find((t) => t.start === j);
  for (let j = start + 1; j < keys.length; j++) {
    const t = termAt(j);
    // a platform introduced by a preposition ends the topic («عن السياحة على تيك توك»)
    if (t && t.entry.category === "platform" && PREPOSITIONS.has(keys[j - 1]) && j - 1 > start) { end = j - 1; cut = "platform"; break; }
    // a collecting word joined by «و» (or «مع») starts a new ask, and so does a content word joined that way («عن السياحة والردود»)
    const joined = keys[j].startsWith("و") && keys[j].length > 2 ? findTerms([keys[j].slice(1)]).find((m) => m.start === 0 && (m.entry.category === "content" || (m.entry.category === "ask" && isArabicToken(keys[j])))) : undefined;
    if (joined) { end = j; cut = "output_field"; break; }
    if ((keys[j] === "و" || keys[j] === "مع") && j + 1 < keys.length) {
      const next = termAt(j + 1);
      if (next && (next.entry.category === "content" || (next.entry.category === "ask" && isArabicToken(keys[j + 1])))) { end = j; cut = "output_field"; break; }
    }
    if (EXCLUSION_CUES.has(keys[j])) { end = j; cut = "exclusion"; break; }
  }
  // trailing filler («بس») left in front of a cut
  while (end > start + 1 && TRAILING_FILLERS.has(keys[end - 1])) end -= 1;
  return { marker, start, end, firstToken, cut };
}

export function interpretRequest(raw: unknown): SemanticInterpretation {
  const text = semanticText(raw);
  const { keys, tokens, cased } = text;
  const terms = findTerms(keys);
  const span = topicSpan(keys, tokens, terms);
  const inTopic = (t: TermMatch): boolean => span !== null && t.start >= span.start && t.start < span.end;
  const outside = terms.filter((t) => !inTopic(t));

  const content: Record<ContentId, boolean> = { posts: false, videos: false, comments: false, replies: false, tweets: false };
  for (const t of outside) { const id = contentId(t); if (id) content[id] = true; }
  const anyContent = Object.values(content).some(Boolean);
  const asks = [...new Set(outside.filter((t) => t.entry.category === "ask").map((t) => t.entry.id as AskId))];

  const ambiguities: string[] = [];
  const named = new Set<PlatformId>();
  let bareXCandidate = false;
  for (const t of outside) {
    if (t.entry.category !== "platform") continue;
    if (t.entry.id !== "x_bare") { named.add(t.entry.id as PlatformId); continue; }
    // the bare letter: a name, the platform, or undecided
    const before = keys.slice(Math.max(0, t.start - 3), t.start);
    if (before.some((k) => NAME_CUES.has(k))) { ambiguities.push("platform:x_treated_as_name"); continue; }
    const cue = t.start > 0 && PLATFORM_CUES.has(keys[t.start - 1]);
    if (cue && anyContent) named.add("x");
    else bareXCandidate = true;
  }
  const impliedByContent = new Set<PlatformId>();
  for (const t of outside) if (t.entry.implies) impliedByContent.add(t.entry.implies);

  const allIds = new Set<PlatformId>([...named, ...impliedByContent]);
  let platform: PlatformReading;
  if (allIds.size > 1) {
    platform = { status: "multiple", ids: [...allIds].sort() };
    ambiguities.push("platform:multiple");
  } else if (allIds.size === 1) {
    const id = [...allIds][0];
    const hasNamedWord = outside.some((t) => t.entry.category === "platform" && t.entry.id === id);
    const viaCue = id === "x" && outside.some((t) => t.entry.id === "x_bare");
    platform = { status: "resolved", id, evidence: hasNamedWord && !viaCue ? "named" : viaCue ? "named_with_cue" : "implied_by_content" };
  } else if (bareXCandidate) {
    platform = { status: "ambiguous", candidates: ["x"], reason: "bare_x_without_cue" };
    ambiguities.push("platform:bare_x_without_cue");
  } else {
    // a platform that appears only inside the topic is a subject, not a source
    const inside = [...new Set(terms.filter((t) => inTopic(t) && t.entry.category === "platform" && t.entry.id !== "x_bare").map((t) => t.entry.id as PlatformId))];
    if (inside.length > 0) {
      platform = { status: "ambiguous", candidates: inside.sort(), reason: "named_only_in_topic" };
      ambiguities.push("platform:named_only_in_topic");
    } else platform = { status: "none" };
  }

  let parent_kind: SemanticInterpretation["parent_kind"] = null;
  if (content.tweets) parent_kind = "tweets";
  else if (content.posts && content.videos) ambiguities.push("kind:posts_vs_videos");
  else if (content.posts) parent_kind = "posts";
  else if (content.videos) parent_kind = "videos";

  let topic: string | null = null;
  if (span) {
    const parts = cased.slice(span.start, span.end);
    if (span.firstToken !== null) parts[0] = cased[span.start].slice(1);
    topic = parts.join(" ").trim() || null;
  }

  return { original: text.original, normalized: text.normalized, is_request: asks.length > 0, asks, platform, content, parent_kind, topic, topic_cut: topic === null ? null : span?.cut ?? null, ambiguities };
}
