import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, planningFlow, tregResult, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { readSnapshot } from "../agent/src/items/itemStore";

/**
 * THE REPLAY OF THE LIVE RUN OF 2026-10-29 (msn_169c911fd8a0a5c89cf1, «هات ٣٠٠ تغريدة عن محمد صلاح», 67 delivered): the items the customer's Excel held that did not belong in it, through the same plan (the same terms, context
 * words, exclusions and promises the live card had), the same engine, the same settlement. None of the seven may be delivered; every other tweet is.
 */
const ENDPOINT = "anyapi.x.search.posts";
const TOPIC = "محمد صلاح";
const PER_PAGE = 15;

const good = (n: number) => `${TOPIC} يسجل هدفًا رقم ${n} في مباراة ليفربول الليلة`;
const REFEREE = "الحكم محمد صلاح عبد الفتاح يدير مباراة الأهلي والزمالك في الدوري";
const BAD: Record<number, { text: string; isReply?: boolean; kind: string }> = {
  1: { kind: "ad", text: "ورشة تنمية القدرات اللفظية مع المدرب محمد صلاح، سجل الآن وانضم إلينا" },
  5: { kind: "referee", text: `🔴 عاجل | ${REFEREE}` },
  12: { kind: "referee", text: `  ⚽ ${REFEREE}` },
  18: { kind: "referee", text: `‏1️⃣ ${REFEREE.replace("الحكم ", "الحكم  ")} #الدوري` },
  23: { kind: "reply", text: "‏  @Ahmed1Afify محمد صلاح يستحق الكرة الذهبية مع ليفربول هذا الموسم", isReply: false },
  30: { kind: "coach", text: "المدرب محمد صلاح أبو عمر يقود تدريبات الفريق قبل مباراة الدوري" },
  48: { kind: "names", text: "رجال الأعمال: أحمد عز، محمد صلاح، نجيب ساويرس، هشام طلعت مصطفى، محمد منصور، حسن علام" },
  60: { kind: "duplicate", text: `🔥 ${good(0)} #ليفربول` },
};
const TOTAL = 75;
const GOOD_COUNT = TOTAL - Object.keys(BAD).length;

/** The 75 tweets the live search gave: 67 about the footballer and the 8 that must not be delivered, in a fixed order. */
const tweets = (() => {
  let g = 0;
  return Array.from({ length: TOTAL }, (_, i) => {
    const b = BAD[i];
    const text = b ? b.text : good(g++);
    return { id: `18${String(i).padStart(6, "0")}`, text, url: `https://x.example/u/status/18${String(i).padStart(6, "0")}`, author: `user${i % 40}`, createdAt: "2026-10-20T10:00:00Z", isReply: b?.isReply ?? false, lang: "ar" };
  });
})();
const pageOf = (p: number) => tregResult({ output: { data: { items: tweets.slice(p * PER_PAGE, (p + 1) * PER_PAGE), nextCursor: (p + 1) * PER_PAGE < TOTAL ? `cur_${(p + 1) * PER_PAGE}` : null } } }, 0.00075);

const LIVE_RELEVANCE = {
  subject_ar: "لاعب كرة القدم محمد صلاح", terms: [TOPIC, "Mohamed Salah", "Mo Salah", "محمد_صلاح"], text_columns: ["text"], review: true, min_own_words: 2,
  context_terms: ["ليفربول", "الأهلي", "المنتخب", "الدوري", "هدف", "Liverpool"], exclude_terms: ["الشهيد"],
};

const planning = (relevance: Record<string, unknown> = LIVE_RELEVANCE) => planningFlow({
  progress: "أبحث عن أرخص مصدر مناسب للتغريدات", searchWords: ["tweets", "search"], platform: "x",
  sample: [{ endpoint: ENDPOINT, params: { query: TOPIC, limit: PER_PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" }],
  sampleCode: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt, is_reply: !!t.isReply, lang: t.lang || '' }))",
  plan: (res: Results) => ({
    summary_ar: "ستحصل على تغريدات عربية عن محمد صلاح لاعب كرة القدم، بدون الردود، مع نصها وكاتبها وتاريخها ورابطها.",
    assumptions_ar: ["المقصود: لاعب كرة القدم محمد صلاح.", "لا تُحتسب الردود، وتُستبعد التغريدات التي لا تخص محمد صلاح"],
    stages: [{
      key: "tweets", title_ar: "التغريدات عن محمد صلاح", endpoint_id: ENDPOINT, expected_rows: 300, parent_key: null, deliver: true,
      how_ar: "بحث في تغريدات منصة إكس بالاسم الكامل باللغة العربية، مع استبعاد الردود.",
      columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
      sample_rows: [2, 3, 4].map((n) => ({ id: tweets[n].id, text: tweets[n].text, url: tweets[n].url, author: tweets[n].author, date: "2026-10-20T10:00:00Z" })),
      measured_by: [callIds(res)[0]], relevance, yield_from: firstOutputId(res),
      filters: [{ kind: "exclude_replies" }, { kind: "language", lang: "ar" }],
    }],
  }),
});

const run = (relevance?: Record<string, unknown>) => replay({
  request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: planning(relevance), execution: () => [],
  answers: [pageOf(0), ...Array.from({ length: TOTAL / PER_PAGE }, (_, p) => pageOf(p))],
});

describe("the 75 tweets of the live run: the 8 that do not belong are not delivered, the 67 are", () => {
  it("the same plan as the live card (no competing meanings listed): the namesakes, the reply, the advert, the list and the repeat are all kept out", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: GOOD_COUNT, expectStatus: "partial" });
    expect(r.mission.delivered_units).toBe(67);
    const wb = await readWorkbook(r);
    const sheet = wb.getWorksheet("التغريدات عن محمد صلاح")!;
    const delivered: string[] = [];
    sheet.eachRow((row, n) => { if (n > 1) delivered.push(String(row.getCell(1).value)); });
    expect(delivered).toHaveLength(67);
    for (const [i, b] of Object.entries(BAD)) expect(delivered, `${i}: ${b.kind}`).not.toContain(b.text);
    // none of the seven is in the file in any decoration
    expect(delivered.some((t) => /عبد الفتاح|أبو عمر|Ahmed1Afify|ورشة|رجال الأعمال/.test(t))).toBe(false);
    expect(delivered.every((t) => t.includes(TOPIC) && t.includes("ليفربول"))).toBe(true);
    // every good tweet is there, once
    expect(new Set(delivered).size).toBe(67);
    // the check counted each of them by its reason
    const snap = await readSnapshot(r.store, r.missionId);
    const c = snap.counts("tweets");
    // (the three referee tweets are ONE tweet in different decoration: the first is left out as another person's name, the other two are repeats of it; the fourth repeat is the good tweet with an emoji and a hashtag)
    expect(c.excludedByReason.name_extended).toBe(2);
    expect(c.excludedByReason.filter_reply).toBe(1);
    expect(c.duplicates).toBe(3);
    // the advert and the list were not accepted: no reviewer was reachable, so they were never delivered
    expect((c.excludedByReason.not_reviewed ?? 0) + (c.excludedByReason.uncertain ?? 0) + c.pending).toBe(2);
    // the money core is the one of the rule: ceil(67 / 300 x the card price), the hold released
    expect(r.mission.charged_points).toBe(Math.ceil(67 * r.plannedPlan.price.unitPricePoints));
    expect(Number(r.mission.charged_points)).toBeLessThan(Number(r.mission.reserved_points));
  });

  it("the same with the other meanings LISTED by the plan (a title and the words of each meaning): the same 67", async () => {
    const r = await run({ ...LIVE_RELEVANCE, competing_meanings: [
      { meaning_ar: "الحكم محمد صلاح عبد الفتاح", extensions: ["عبد الفتاح"], titles: ["حكم", "الخبير التحكيمي"] },
      { meaning_ar: "المدرب محمد صلاح أبو عمر", extensions: ["أبو عمر"], titles: ["مدرب"] },
    ] });
    assertReplayInvariants(r, { expectDelivered: GOOD_COUNT, expectStatus: "partial" });
    // the card says which meanings are left out, in the plan's own words
    expect(r.planView.assumptionsAr.join(" ")).toContain("لا يُحتسب ما يخص: الحكم محمد صلاح عبد الفتاح، المدرب محمد صلاح أبو عمر.");
    // the title next to the name now also excludes the advert's trainer («المدرب محمد صلاح») by rule (not only by the check)
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("tweets").excludedByReason.name_extended).toBe(3);
  });
});
