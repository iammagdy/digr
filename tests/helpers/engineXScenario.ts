import { callIds, planningFlow, tregResult, type Results } from "./agentFakeWorld";
import { aboutWords, firstOutputId } from "./agentRelevance";

/** The shared X-posts scenario of the engine tests: a search source paged by a cursor, four of every five tweets about the topic, a plan whose mapping covers every row of the measured page. */
export const ENDPOINT = "anyapi.x.search.posts";
export const TOPIC = "محمد صلاح";
export const PER_PAGE = 20;
export const pad = (n: number) => String(n).padStart(6, "0");
/** A page of the X search: four of every five tweets are about the topic, the fifth is not (a namesake's, an unrelated tweet). */
export const page = (offset: number, next: string | null) => ({ output: { data: { items: Array.from({ length: PER_PAGE }, (_, i) => {
  const n = offset + i;
  const about = n % 5 !== 4;
  return { id: `18${pad(n)}`, text: about ? `${TOPIC} يسجل هدفًا رقم ${n} في المباراة` : `أخبار عامة عن الطقس رقم ${n} اليوم`, url: `https://x.example/u/status/18${pad(n)}`, author: `user${n % 40}`, createdAt: "2026-10-20T10:00:00Z" };
}), nextCursor: next } } });
export const pages = (count: number) => Array.from({ length: count }, (_, p) => tregResult(page(p * PER_PAGE, p + 1 < count ? `cur_${(p + 1) * PER_PAGE}` : null), 0.00075));

export const planning = () => planningFlow({
  progress: "أبحث عن أرخص مصدر مناسب للتغريدات",
  searchWords: ["tweets", "search"], platform: "x",
  sample: [{ endpoint: ENDPOINT, params: { query: TOPIC, limit: PER_PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" }],
  // the mapping covers EVERY row of the page it was measured on: that is what lets code run it on every later page
  sampleCode: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }))",
  plan: (res: Results) => ({
    summary_ar: "ستحصل على ٣٠٠ تغريدة عن محمد صلاح مع نص كل تغريدة ورابطها.",
    stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 300, parent_key: null, deliver: true,
      columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
      sample_rows: [0, 1, 2].map((n) => ({ id: `18${pad(n)}`, text: `${TOPIC} يسجل هدفًا رقم ${n} في المباراة`, url: `https://x.example/u/status/18${pad(n)}`, author: `user${n}`, date: "2026-10-20T10:00:00Z" })), measured_by: [callIds(res)[0]], relevance: aboutWords([TOPIC]), yield_from: firstOutputId(res) }],
  }),
});

