import { MODEL_HAIKU } from "../../src/lib/agentMission/constants";
import { normalizeText } from "../../src/lib/agentMission/relevance";
import { llmCostFromUsage } from "./llmCost";
import { createReviewer, type ReviewCall } from "./review";
import type { AgentStore } from "./types";

/**
 * P0 (15 Nov 2026, msn_cd5f32adadefb9bb971f): THE RESEARCH JUDGMENT AT PLANNING.
 *
 * A row a search returned is not a research result. Before a plan is priced, the rows the planning read are judged against the customer's request by the SAME model review that gates execution
 * (review.ts: the same prompt, the same forced 0/1-per-row answer, the same retries). The verdicts decide which rows the plan may choose and what the card says about relevance, so the card can
 * never say «all match your conditions» about rows that are about something else. Nothing is stored: the planning's own cost is returned and added to the mission's planning model cost (never a charge).
 * A row the judge could not answer is absent from the map; the caller then falls back to the word rule for it (and execution judges it again: execution is always the authority).
 */
export const PLANNING_JUDGE_CAP_USD = 0.01;
/** The most rows judged at planning (the two sample pages hold about 40). */
export const PLANNING_JUDGE_MAX_ROWS = 60;

export type PlanningJudge = (input: { subject: string; rows: ReadonlyArray<{ id: string; text: string }> }) => Promise<{ verdicts: Map<string, boolean>; costUsd: number } | null>;

/** An in-memory store for a reviewer that must not write the mission's review account (planning is not execution). */
function memoryStore(): AgentStore {
  const files = new Map<string, string>();
  return {
    getFile: async (_m: string, name: string) => files.get(name) ?? null,
    putFile: async (_m: string, name: string, body: string) => { files.set(name, body); },
    putNew: async (_m: string, name: string, body: string) => { files.set(name, body); },
    listFiles: async (_m: string, prefix: string) => [...files.keys()].filter((k) => k.startsWith(`${prefix}/`)).sort().map((name) => ({ name, size: files.get(name)!.length })),
  } as unknown as AgentStore;
}

export function planningJudge(call: ReviewCall, requestText: string, options: { capUsd?: number; model?: string } = {}): PlanningJudge {
  return async ({ subject, rows }) => {
    const list = rows.filter((r) => r.text.trim() !== "").slice(0, PLANNING_JUDGE_MAX_ROWS);
    if (list.length === 0) return { verdicts: new Map(), costUsd: 0 };
    const cap = options.capUsd ?? PLANNING_JUDGE_CAP_USD;
    const reviewer = createReviewer({ call, store: memoryStore(), missionId: "planning", requestText, budgetUsd: cap, ceilingUsd: cap, ...(options.model ? { model: options.model } : {}) });
    try {
      const verdicts = await reviewer.review({ subject, rows: list.map((r) => ({ id: r.id, text: r.text })) });
      return { verdicts, costUsd: (await reviewer.state()).spentUsd };
    } catch {
      // what was spent before the failure is still a cost of this planning (counted, never lost); no verdict is used
      const spent = await reviewer.state().then((x) => x.spentUsd).catch(() => 0);
      return { verdicts: new Map(), costUsd: spent };
    }
  };
}

/**
 * THE SEARCH VARIANTS OF A TOPIC (recall). A source's search matches words, and a customer writes one way of saying a topic; the posts about it use others («الشائعات», «شائعة», «الإشاعات», «معلومات مغلوطة», «أخبار كاذبة»).
 * The model proposes short search terms a post ABOUT the topic would literally contain; CODE keeps only plain short terms (letters, digits, spaces, «_»/«#» inside a hashtag; no operator, quote, colon or bracket; at most four words and 40 characters),
 * drops the customer's own alternatives (they are always searched first) and duplicates, and keeps at most MAX_TOPIC_VARIANTS. The variants only widen WHAT IS READ: every row is still judged against the customer's request before it can be chosen,
 * delivered or charged, so a wrong variant costs a read, never a wrong delivery.
 */
export const MAX_TOPIC_VARIANTS = 12;
/** The output cap of the variants call (no thinking is asked: review.ts `anthropicReviewCall`). Twelve short Arabic terms in a JSON array fit well inside it. */
export const TOPIC_VARIANTS_MAX_TOKENS = 600;
/** `failed`: the call gave no readable answer (no array, or an answer cut at its cap). Such a result is never kept for the mission, so a later planning run asks again; `costUsd` is still what the call cost. */
export type TopicVariants = (input: { request: string; topic: string; alternatives: ReadonlyArray<string> }) => Promise<{ terms: string[]; costUsd: number; failed?: true } | null>;

const VARIANTS_SYSTEM = `You help search a social platform for posts on a research topic. Platform search matches the exact words written in a post, so the search terms decide what can be found at all. Given the customer's request (and any words the customer suggested) and the topic, list the short search terms that posts ABOUT that topic would literally contain, in the language the posts are written in: the topic's key words alone and in their other grammatical forms (singular, plural, with and without the article), common synonyms, the usual phrasing an author would use when writing about it, and common hashtags (without «#», words joined by «_»). Prefer one- and two-word terms: a long phrase rarely matches. Include every search term the customer suggested. Each term is 1 to 4 words, no operators, no quotes, no names of accounts, no dates. Answer with ONLY a JSON array of at most ${MAX_TOPIC_VARIANTS} strings, most useful first.`;

const TERM_OK = /^[\p{L}\p{N}][\p{L}\p{N}\s_]*$/u;
/** Arabic diacritics and the tatweel: a post is searched without them, so a term the model writes vocalized is kept bare. */
const MARKS = /[\u064B-\u065F\u0670\u0640]/g;
/** The variants code keeps: plain short terms, none equal to an alternative or to another variant (compared in the normalized form). */
export function cleanVariants(raw: unknown, alternatives: ReadonlyArray<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(alternatives.map((a) => normalizeText(a)));
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.replace(MARKS, "").replace(/^#/, "").replace(/\s+/g, " ").trim();
    if (t.length < 2 || t.length > 40 || !TERM_OK.test(t) || t.split(" ").length > 4) continue;
    if (/^(?:or|and|not)$/i.test(t) || /\b(?:OR|AND)\b/.test(t)) continue;
    const k = normalizeText(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_TOPIC_VARIANTS) break;
  }
  return out;
}

export function topicVariants(call: ReviewCall, options: { model?: string } = {}): TopicVariants {
  const model = options.model ?? MODEL_HAIKU;
  return async ({ request, topic, alternatives }) => {
    const user = `The customer's request: «${request.slice(0, 900)}»\nThe topic: «${topic.slice(0, 200)}»${alternatives.length > 0 ? `\nThe customer's own alternatives (already searched): ${alternatives.map((a) => `«${a}»`).join("، ")}` : ""}`;
    const res = await call({ model, system: VARIANTS_SYSTEM, user, maxTokens: TOPIC_VARIANTS_MAX_TOKENS }).catch(() => null);
    if (!res) return null;
    const costUsd = llmCostFromUsage(model, res.usage);
    let parsed = false;
    for (const m of res.text.matchAll(/\[[^\[\]]*\]/g)) {
      try { const raw = JSON.parse(m[0]) as unknown; if (!Array.isArray(raw)) continue; parsed = true; const terms = cleanVariants(raw, alternatives); if (terms.length > 0) return { terms, costUsd }; } catch { /* the next array */ }
    }
    // an answer with no readable array (or cut at its cap) is a failed call, never «this topic has no other wording»
    return parsed && !res.truncated ? { terms: [], costUsd } : { terms: [], costUsd, failed: true };
  };
}
