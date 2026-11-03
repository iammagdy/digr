import { readFileSync } from "node:fs";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { buildAsk } from "../../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs, type CompileResult } from "../../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../../src/lib/agentMission/foundation/toolCards";
import type { PricedPlan } from "../../src/lib/agentMission/plan";

/**
 * THE FACEBOOK PLAN OF LIVE ROUND 11 (msn_9d196025e7929324983a, the tester chose «fill from other pages»): three posts whose comment counters are 15, 1,823 and 58 (read-only SELECT on the stored plan's pinned rows), and the 14 comments read at planning that say they
 * have 22 replies in all (the stored promise: counted 22 of 14 comments). The structure is the real M17 pages' (the search page, call 4, and a comments page, call 6, anonymised); only the counters are set to the live ones, as the README's precedent allows.
 */
const catalog = loadTregCatalog();
const M17 = "msn_6bb78c15d116268b0b9b";
const read = (call: string) => JSON.parse(readFileSync(new URL(`../fixtures/live/missions/${M17}/raw/${call}.json`, import.meta.url), "utf8"));
export const FB_REQUEST = "هات منشورات عن الذكاء الاصطناعي من صفحة قناة العربية على فيسبوك آخر ٣ شهور، ٣ منشورات، مع كل التعليقات والردود.";
export const LIVE_COUNTERS = [15, 1823, 58];
/** The 14 comments read at planning, split over the three posts' first pages, with the live reply counters (22 in all). */
const REPLY_COUNTERS = [[2, 1, 0, 3, 1], [4, 2, 1, 0, 3], [2, 0, 1, 2]];

export function liveFacebookPlan(over: { request?: string; counters?: number[]; replyCounters?: number[][] } = {}): Extract<CompileResult, { ok: true }> {
  const card = cardOf("justoneapi.x.facebook-search-post-v1")!;
  const ask = buildAsk(over.request ?? FB_REQUEST, "أكمل واستكمل من صفحات أخرى مع علامة «المصدر المسمّى: غير مطابق»", Date.parse("2026-11-03T13:32:00Z"));
  const search = read("call_0004");
  const counters = over.counters ?? LIVE_COUNTERS;
  search.data.results.forEach((r: Record<string, any>, i: number) => { r.comments_count = counters[i] ?? 1; r.message = `شرح الذكاء الاصطناعي ${i}`; });
  const base = read("call_0006");
  const pages = (over.replyCounters ?? REPLY_COUNTERS).map((rc, p) => ({ ...base, comments: rc.map((n, k) => ({ ...base.comments[0], id: `c_${p}_${k}`, reply_count: n })), cursor: null }));
  let at = 0;
  const exposureOf = new Map<string, unknown>();
  const r = compilePlan({
    ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0001", page: search }] }, namedChoice: "fill",
    exposure: (id) => { if (!exposureOf.has(id)) exposureOf.set(id, pages[Math.min(at++, pages.length - 1)]); return { callId: `call_${10 + at}`, page: exposureOf.get(id)!, failed: false }; },
    capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null, catalogOnly: true,
  });
  if (!r.ok) throw new Error(`no plan: ${r.reason}`);
  return r;
}
export const planOf = (r: Extract<CompileResult, { ok: true }>): PricedPlan => r.plan;
