import { toArabicDigits } from "../../arabicDigits";
import type { Ask } from "./ask";
import { insidePeriod, operatorIdOf, type SearchStrategy } from "./compilePlan";
import { topicTierOf } from "./pool";
import { rowIsBy } from "./sourceScope";
import { alternativesAr } from "./topicAlternatives";
import { mapPage, type ToolCard } from "./toolCards";

/**
 * P0 (15 Nov 2026): WHAT WAS ACTUALLY SEARCHED, AND WHAT IT GAVE, when a search plan cannot be made. Three real missions (msn_84d0f3738c87d5ed3aee, msn_7758164aa2b4a840fda5, msn_47c4016d9099f63c2bb5) ended with «بحثنا في المصادر المتاحة فلم نجد
 * ما يطابق طلبك» after ONE improbable exact phrase answered 0 rows twice: a sentence that claims the whole account was searched and nothing exists. The customer now reads the scope that was tested (the source, the platform, the period,
 * the concepts and the strategies), the observed counts, and that it does not prove the source never posted about it. Customer words only: no provider, no price, no identifier spelled in Latin letters. Pure.
 */
export interface SearchScope {
  platform: string | null;
  /** The search carried a named source (by the card's operator): the identifier is kept for the internal record only. */
  sourceId: string | null;
  period: { from: string; to: string } | null;
  topic: string | null;
  alternatives: string[];
  strategies: Array<{ strategy: SearchStrategy; rows: number }>;
  /** Distinct rows the searches returned; of them by the source, inside the period, and naming the topic (each among the previous). */
  read: number;
  bySource: number;
  inPeriod: number;
  about: number;
  /** P0: `about` was counted by the research judgment (meaning), not by the words. */
  judged?: boolean;
}

const PLATFORM_AR: Record<string, string> = { tiktok: "تيك توك", x: "إكس", instagram: "إنستجرام", facebook: "فيسبوك", youtube: "يوتيوب" };
const STRATEGY_AR: Record<SearchStrategy, string> = {
  exact: "بالعبارات كما كتبتها",
  words: "بكلمات الموضوع في أي ترتيب",
  source_items: "منشورات الحساب نفسه في الفترة، ثم فحص كل منشور بالموضوع",
  expanded: "بصيغ أخرى للموضوع ومرادفاته، ثم فحص كل عنصر بأنه عن الموضوع فعلًا",
};

/** The scope of the searches that were read (their pages, deduplicated by id) for the Ask. */
export function searchScopeOf(ask: Ask, card: ToolCard, pages: ReadonlyArray<{ page: unknown; card?: ToolCard }>, strategies: ReadonlyArray<{ strategy: SearchStrategy; rows: number }>, judged?: ReadonlyMap<string, boolean>): SearchScope {
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const p of pages) for (const r of mapPage(p.card ?? card, p.page)) { const id = String(r.id ?? ""); if (id !== "" && seen.has(id)) continue; if (id !== "") seen.add(id); rows.push(r); }
  const sourceId = operatorIdOf(card, ask);
  const bySource = sourceId ? rows.filter((r) => rowIsBy(r, sourceId)) : rows;
  const inPeriod = ask.period ? bySource.filter((r) => insidePeriod(r, ask)) : bySource;
  // P0: a row the research judgment decided counts by its verdict (about the request or not), never by a shared word
  const about = ask.topic.text ? inPeriod.filter((r) => { const v = judged?.get(String(r.id ?? "")); return v !== undefined ? v : topicTierOf(String(r.text ?? ""), ask) > 0; }) : inPeriod;
  return {
    platform: ask.platform, sourceId, period: ask.period ? { from: ask.period.from, to: ask.period.to } : null, topic: ask.topic.text, alternatives: [...(ask.topic.alternatives ?? [])], strategies: [...strategies],
    read: rows.length, bySource: bySource.length, inPeriod: inPeriod.length, about: about.length, ...(judged && judged.size > 0 ? { judged: true } : {}),
  };
}

/** The customer's sentence for a request that ended with no plan after these searches: the tested scope, the counts, no claim that nothing exists, nothing charged. */
export function searchScopeEndAr(s: SearchScope): string {
  const where = s.sourceId ? `داخل الحساب الذي حدّدته على ${PLATFORM_AR[s.platform ?? ""] ?? "المنصة"}` : `على ${PLATFORM_AR[s.platform ?? ""] ?? "المنصة"}`;
  const when = s.period ? ` في الفترة من ${toArabicDigits(s.period.from)} إلى ${toArabicDigits(s.period.to)}` : "";
  const what = s.alternatives.length > 0 ? ` عن أيٍّ من: ${alternativesAr(s.alternatives)}` : s.topic ? ` عن «${s.topic}»` : "";
  const n = s.strategies.length;
  const how = n > 0 ? ` جرّبنا ${n === 1 ? "طريقة واحدة" : n === 2 ? "طريقتين" : `${toArabicDigits(n)} طرق`} للبحث: ${s.strategies.map((x) => STRATEGY_AR[x.strategy]).join("، ثم ")}.` : "";
  const counts = [`عدد ما أرجعه البحث: ${toArabicDigits(s.read)}`];
  if (s.read > 0) {
    if (s.sourceId) counts.push(`منها من الحساب نفسه: ${toArabicDigits(s.bySource)}`);
    if (s.period) counts.push(`داخل الفترة: ${toArabicDigits(s.inPeriod)}`);
    if (s.topic) counts.push(s.judged ? `تتحدث فعلًا عن الموضوع بعد فحص كل منها: ${toArabicDigits(s.about)}` : `تذكر الموضوع: ${toArabicDigits(s.about)}`);
  }
  const notProof = s.sourceId ? "وهذا لا يثبت أن الحساب لم ينشر عن الموضوع" : "وهذا لا يثبت أن المنصة لا تحوي شيئًا عنه";
  return `بحثنا ${where}${when}${what}.${how} ${counts.join("، ")}. لم نجد ما يكفي لخطة، ${notProof}: هو ما أرجعه البحث بهذه الشروط فقط. لم نجهّز سعرًا ولم يُخصم منك شيء، ويمكنك إعادة صياغة الموضوع بكلمات أخرى أو تغيير الفترة.`.replace(/\s+/g, " ");
}
