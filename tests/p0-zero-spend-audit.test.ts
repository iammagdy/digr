import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paramsSignature } from "../agent/src/gateway";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { coreExpandedInputsOf, expandedInputsOf, CORE_QUERY_MAX_TERMS } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { classifyRowDetailed, type RelevanceSpec } from "../src/lib/agentMission/relevance";
import { asksNoRepeat } from "../src/lib/agentMission/noRepeat";

/**
 * ZERO-SPEND FORENSIC AUDIT (15 Nov 2026), after PRs #507–#512. No paid call, no live mission: the evidence is what production already recorded, read with read-only queries.
 *
 * `mission_calls.params_digest` cuts every query at 80 characters, but keeps `__params_sig`, the SHA-256 fingerprint of the call's COMPLETE inputs (agent/src/gateway.ts `paramsSignature`). A query rebuilt by hand is therefore
 * PROVEN when its fingerprint equals the recorded one. The queries below are proven that way; nothing here is a guess about what was sent.
 *
 * Finding (code defect): the CORE query (#508) put the model's variants before the customer's own alternatives and stopped at six terms. In msn_55816a05a6afc274e958 and msn_dae6a9b770b0560709cc six short variants filled the cap and the
 * customer's own «الشائعات» was never searched. Both answered 0 rows. The one relevant tweet production found (1466135018154205187, msn_88a5d0ec135b3cbd962d, stored on its plan) matches «الشائعات» and none of the six.
 * What is NOT proven: that the fixed core would have returned rows. The EXPANDED queries of those missions also carried «الشائعات» (the customer's alternatives are always appended) and also answered 0, with the same account,
 * period and filters as msn_88a5's query that returned that tweet 17 minutes earlier. A boolean OR over a stable index cannot do that; the stored data cannot tell whether the cause is the query's length or complexity, or a
 * provider answering differently over time (no identical query was sent twice with different results).
 */
const TAIL = " from:SaudiMOH since:2021-11-14_22:00:00_UTC until:2026-11-15_22:00:00_UTC -filter:replies";
const P = (query: string) => ({ limit: 20, query, queryType: "Latest" });
const RECORDED = {
  ab60_expanded: { sig: "c1606d1470f1d75bf6405705010f46b7", rows: 20, query: '(شائعة OR شائعات OR "شائعة صحية" OR "تفنيد الشائعات" OR تفنيد OR ينفي OR نفي OR "عار عن الصحة" OR "غير صحيح" OR "لا صحة" OR تصحيح OR "مكافحة الشائعات" OR "احذر الشائعات" OR "المعلومات المغلوطة" OR الشائعات OR "التصدي للشائعات" OR "جهود الوزارة في مكافحة الشائعات")' + TAIL },
  a88_expanded: { sig: "7e395763d9236d4ac3e2b808d4a3396b", rows: 10, query: '(شائعات OR شائعة OR الشائعة OR "تصدي للشائعات" OR "نفي شائعة" OR ينفي OR تنفي OR تكذيب OR "المعلومات المضللة" OR "معلومة مضللة" OR "مكافحة الشائعات" OR "احذروا الشائعات" OR "لا تصدقوا الشائعات" OR الشائعات OR "التصدي للشائعات" OR "جهود الوزارة في مكافحة الشائعات")' + TAIL },
  c5581_core: { sig: "1cee14fc0a2ef35a6fc86d693f52820d", rows: 0, query: '(شائعة OR شائعات OR الشائعة OR "تنفي شائعة" OR "نفي شائعة" OR "تصحيح معلومة")' + TAIL },
  cdae6_core: { sig: "927f3fc25267155f631adf57c9f78bdc", rows: 0, query: '(شائعة OR شائعات OR الشائعة OR تفنيد OR تفند OR "نفي شائعة")' + TAIL },
  newest: { sig: "4a1d936be07a5754df9e4d9239ae613d", rows: 20, query: TAIL.trim() },
};
/** Public tweets of @SaudiMOH stored on the plans of the missions (`plan.stages[].pinned_rows`), the only row texts the database holds. */
const OMICRON = { id: "1466135018154205187", username: "SaudiMOH", posted_at: "2021-12-01T20:00:02.000Z", text: "تم رصد المتحور في المملكة وعدد من دول العالم، ومن المهم جداً أن نأخذ المعلومات من مصادرها الموثوقة وأن نحذر من الشائعات. https://t.co/7XIYxHghkr" };
const CLIP = { id: "2111754500776030669", username: "SaudiMOH", posted_at: "2026-10-18T09:41:22.000Z", text: "رصدت وزارة الصحة مقطعًا متداولًا يُظهر إعداد الطعام باستخدام جهاز طهي كهربائي داخل غرفة مريض بمنشأة صحية خاصة بالرياض؛ واتخذت الإجراءات النظامية بحق المنشأة، وإحالة الشخص المخالف إلى الجهات المختصة. https://t.co/nF4zkCzeff" };

const fx = JSON.parse(readFileSync(new URL("./fixtures/p0-x-account/production-2026-11-15-cd5f.json", import.meta.url), "utf8")) as { request_text: string; created_at: string; source_answer: string };
const xSearch = cardOf("anyapi.x.search.posts")!;
const ask = () => ({ ...buildAsk(fx.request_text, fx.source_answer, Date.parse(fx.created_at)), source: { kind: "named" as const, text: fx.source_answer } });
/** The variants of msn_55816a05a6afc274e958 in the order production used them (its expanded query's recorded prefix and its proven core). */
const VARIANTS_5581 = ["شائعة", "شائعات", "الشائعة", "تنفي شائعة", "نفي شائعة", "عارية من الصحة", "تصحيح معلومة"];
const VARIANTS_DAE6 = ["شائعة", "شائعات", "الشائعة", "تفنيد", "تفند", "نفي شائعة", "الرد على الشائعات"];
/** Does a query's OR group carry this exact term (bare or quoted)? */
const carries = (query: string, term: string) => query.slice(1, query.indexOf(")")).split(" OR ").map((t) => t.replace(/^"|"$/g, "")).includes(term);
/** The words of a text as a search index splits them (letters and digits; the link and punctuation dropped). */
const tokens = (t: string) => t.replace(/https?:\/\/\S+/g, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean);

describe("the recorded queries are proven by their fingerprints (the evidence this audit stands on)", () => {
  it.each(Object.entries(RECORDED))("%s: the rebuilt query has the recorded __params_sig", (_k, r) => {
    expect(paramsSignature(P(r.query))).toBe(r.sig);
  });
  it("identical inputs sent twice answered the same (the only repeats production has): no evidence of an intermittent provider in the stored calls", () => {
    // msn_ab60 call_0001 and call_0003 share c1606d14… (20 and 20 rows); msn_5a1c and msn_69cd share 4a1d936b… (20 and 20 rows)
    expect(RECORDED.ab60_expanded.rows).toBe(20);
    expect(RECORDED.newest.rows).toBe(20);
  });
});

describe("defect: the core query left out the customer's own words (msn_55816a05a6afc274e958, msn_dae6a9b770b0560709cc)", () => {
  it("production's two empty cores never carried «الشائعات», the only query word the one relevant tweet production found contains", () => {
    for (const r of [RECORDED.c5581_core, RECORDED.cdae6_core]) {
      expect(carries(r.query, "الشائعات")).toBe(false);
      expect(r.query.slice(1, r.query.indexOf(")")).split(" OR ").map((t) => t.replace(/^"|"$/g, "")).filter((t) => t.split(" ").every((w) => tokens(OMICRON.text).includes(w)))).toEqual([]);
    }
    expect(tokens(OMICRON.text)).toContain("الشائعات");
    expect(carries(RECORDED.a88_expanded.query, "الشائعات")).toBe(true);
  });
  it.each([["msn_5581", VARIANTS_5581], ["msn_dae6", VARIANTS_DAE6]] as const)("%s: the core now carries the customer's own short alternatives first, every hard condition, at most the cap", (_m, variants) => {
    const a = ask();
    expect(a.topic.alternatives).toEqual(["الشائعات", "التصدي للشائعات", "جهود الوزارة في مكافحة الشائعات"]);
    const expanded = expandedInputsOf(xSearch, a, variants)!;
    const core = String(coreExpandedInputsOf(xSearch, a, variants, expanded.params)!.params.query);
    expect(core.startsWith('(الشائعات OR "التصدي للشائعات" OR شائعة OR شائعات OR ')).toBe(true);
    expect(core.endsWith(TAIL)).toBe(true);
    expect(core.slice(1, core.indexOf(")")).split(" OR ")).toHaveLength(CORE_QUERY_MAX_TERMS);
    // the long alternative (five words) stays out of the core, as before; the expanded query still carries all three
    expect(carries(core, "جهود الوزارة في مكافحة الشائعات")).toBe(false);
    expect(carries(String(expanded.params.query), "جهود الوزارة في مكافحة الشائعات")).toBe(true);
    expect(carries(core, "الشائعات")).toBe(true);
  });
  it("with no alternatives of the customer's (one topic), the core is the model's short variants as before", () => {
    const a = ask();
    const one = { ...a, topic: { ...a.topic, alternatives: [] } };
    const core = String(coreExpandedInputsOf(xSearch, one, VARIANTS_5581, null)!.params.query);
    expect(core).toBe('(شائعة OR شائعات OR الشائعة OR "تنفي شائعة" OR "نفي شائعة" OR "تصحيح معلومة")' + TAIL);
    // that is exactly production's msn_5581 core: the old order, proven by its fingerprint
    expect(paramsSignature(P(core))).toBe(RECORDED.c5581_core.sig);
  });
});

describe("the search backend does not match on the stored text alone (recorded, unexplained)", () => {
  it("the delivered tweet of msn_ab60 contains NONE of the 17 terms of the query that returned it", () => {
    const terms = RECORDED.ab60_expanded.query.slice(1, RECORDED.ab60_expanded.query.indexOf(")")).split(" OR ").map((t) => t.replace(/^"|"$/g, ""));
    expect(terms).toHaveLength(17);
    const words = tokens(CLIP.text);
    expect(terms.filter((t) => t.split(" ").every((w) => words.includes(w)))).toEqual([]);
  });
});

describe("judged research stages: no deterministic word filter can discard a real rumor correction", () => {
  // the stage relevance production stored on msn_88a5d0ec135b3cbd962d's plan
  const SPEC = { judge: "model", terms: ["الشائعات", "التصدي للشائعات", "جهود الوزارة في مكافحة الشائعات"], review: true, subject_ar: "تغريدات تتناول الشائعات أو التصدي للشائعات أو جهود وزارة الصحة في مكافحة الشائعات الصحية، وتكون صادرة عن حساب وزارة الصحة السعودية نفسه", text_columns: ["text"], min_own_words: 0 } as unknown as RelevanceSpec;
  it.each([
    ["production's relevant tweet (the customer's word)", OMICRON.text],
    ["production's off-topic clip tweet (no query word at all)", CLIP.text],
    ["SYNTHETIC correction that repeats none of the customer's words", "ما يتم تداوله عن نقص أدوية الأطفال في المستشفيات غير دقيق، والمخزون متوفر."],
    ["SYNTHETIC warning in the account's own register", "نهيب بالجميع استقاء المعلومات الصحية من مصادرها الرسمية وعدم تداول الأخبار المغلوطة."],
  ])("%s goes to the meaning review, never decided by words", (_k, text) => {
    expect(classifyRowDetailed(SPEC, { text })).toEqual({ verdict: "review", reason: "uncertain" });
  });
  it("only a row with no text left once links and mentions are dropped is set aside, and it is counted as «no text» (msn_ab60's two rows)", () => {
    expect(classifyRowDetailed(SPEC, { text: "https://t.co/abc @SaudiMOH" })).toEqual({ verdict: "exclude", reason: "no_text" });
    expect(classifyRowDetailed(SPEC, { text: "" })).toEqual({ verdict: "exclude", reason: "no_text" });
  });
});

describe("«من غير تكرار»: present in the owner's follow-up, absent from the first request", () => {
  const FIRST = "أنا محتاجة 400 تغريدة من حساب وزارة الصحة السعودية عن الشائعات أو التصدي للشائعات أو جهود الوزارة في مكافحة الشائعات خلال آخر خمس سنين. ولو العدد المتاح أقل من 400 مفيش مشكلة، بس لازم التغريدات تكون فعلًا من حساب الوزارة وعن الموضوع ده.";
  const FOLLOW_UP = "هات 400 تغريدة تانية عن نفس الموضوع ومن نفس الحساب ومن غير تكرار.";
  it("the follow-up asks for no repeat by the customer's own words, with no summary and no model flag", () => {
    expect(asksNoRepeat([FOLLOW_UP], null)).toBe(true);
  });
  it("the first request (no such words) never records an exclusion, whatever summary the model wrote for it", () => {
    expect(asksNoRepeat([FIRST], null)).toBe(false);
    expect(asksNoRepeat([FIRST], "400 تغريدة من حساب وزارة الصحة السعودية عن الشائعات أو التصدي للشائعات أو جهود الوزارة في مكافحة الشائعات خلال آخر خمس سنوات")).toBe(false);
  });
});
