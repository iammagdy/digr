import { describe, expect, it } from "vitest";
import { isEnabled } from "../src/lib/agentMission/filters";
import { customerPlanView, languageOffLineAr, validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { conditionsOfRequest } from "../src/lib/agentMission/requestConditions";

/**
 * LIVE, NOV 9 2026 (msn_52d5c0924b7dbd5c3235): «سحب تعليقات على ريدت في الفترة من يناير 2023 وحتى يناير 2026 حول حملات الغسل الاخضر للشركات العربية».
 * The plan searched Reddit in English (the topic is discussed there in English), the request's Arabic made «Arabic only» the default, and the card promised 9 rows.
 * The run read 250 items and delivered none: 97 out of the period, 56 not Arabic. Neither filter was counted against the measured page when the plan was priced.
 *
 * The fix: a GUESSED language (the request's script, not the customer's words) stays on only when the measured page shows items in it; and every item filter
 * (language, period, place, media, replies, reposts) is counted against the measured page, so a plan whose page they empty is refused BEFORE the customer approves.
 */
const REQUEST = "سحب تعليقات على ريدت في الفترة من يناير 2023 وحتى يناير 2026 حول حملات الغسل الاخضر للشركات العربية";
const NOW = Date.parse("2026-11-09T15:36:00Z");

const englishPosts = [
  { id: "1h5lf95", title: "Saudi Arabia is investing in green innovation to transform its deserts, but accusations of greenwashing highlight the challenge", text: "", date: "2024-12-03T11:35:20.000Z", url: "https://www.reddit.com/r/climate/comments/1h5lf95/x/" },
  { id: "a2", title: "UAE oil company greenwashing ahead of COP28, critics say", text: "The ads are pure greenwashing by a Gulf oil major.", date: "2023-11-20T10:00:00.000Z", url: "https://www.reddit.com/r/climate/comments/a2/x/" },
  { id: "a3", title: "Greenwashing in Egypt: a company's solar ads", text: "Egypt based company greenwashing its brand.", date: "2025-03-01T10:00:00.000Z", url: "https://www.reddit.com/r/egypt/comments/a3/x/" },
  { id: "a4", title: "Cooking tips for beginners", text: "nothing to do with it", date: "2024-01-01T10:00:00.000Z", url: "https://www.reddit.com/r/cooking/comments/a4/x/" },
];
const oldPosts = englishPosts.map((p, i) => ({ ...p, id: `old${i}`, date: "2019-05-01T10:00:00.000Z" }));
const arabicPost = { id: "ar1", title: "الغسل الأخضر في إعلانات شركات الخليج العربية", text: "شركات سعودية وإماراتية تمارس الغسل الأخضر في إعلاناتها", date: "2024-06-01T10:00:00.000Z", url: "https://www.reddit.com/r/arabs/comments/ar1/x/" };

const lookup = (requestText: string, page: Array<Record<string, unknown>>): PlanLookup => ({
  call: (id: string) => (id === "call_0005" ? { endpointId: "scrapecreators.reddit.search.posts", ok: true, rows: page.length, costUsd: 0.002, params: { query: "greenwashing Saudi Arabia UAE Egypt companies ads" }, durationMs: 1400 } : null),
  evidenceText: (id: string) => (id === "call_0005" ? JSON.stringify(page) : id === "out_0005" ? JSON.stringify(page) : null),
  endpointAllowed: () => true, requestText, now: NOW,
} as unknown as PlanLookup);

const stage = (extra: Record<string, unknown> = {}) => ({
  key: "posts", title_ar: "منشورات عن الغسل الأخضر لشركات عربية", endpoint_id: "scrapecreators.reddit.search.posts", expected_rows: 9, parent_key: null, deliver: true,
  columns: [{ key: "title", title_ar: "العنوان" }, { key: "text", title_ar: "النص" }, { key: "date", title_ar: "التاريخ والوقت" }, { key: "url", title_ar: "الرابط" }],
  measured_by: ["call_0005"], yield_from: "out_0005",
  relevance: { subject_ar: "الغسل الأخضر لشركات أو دول عربية", terms: ["greenwashing", "green washing", "الغسل الأخضر"], context_terms: ["Saudi", "UAE", "Egypt", "Gulf", "Arab", "السعودية", "الإمارات", "مصر", "الخليج", "العربية", "سعودية", "إماراتية"], text_columns: ["title", "text"], min_own_words: 0 },
  // what the planner wrote on Nov 9: the period, and «Arabic only» repeating the request's language
  filters: [{ kind: "period", field: "date", from: "2023-01-01", to: "2026-01-31" }, { kind: "language", lang: "ar" }],
  ...extra,
});
const planOf = (request: string, page: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  validateAndPricePlan({ summary_ar: "سحب منشورات ريدت عن حملات الغسل الأخضر للشركات والدول العربية في الفترة من يناير ٢٠٢٣ حتى يناير ٢٠٢٦.", stages: [stage(extra)] }, lookup(request, page));
const languageOf = (r: ReturnType<typeof validateAndPricePlan>) => (r.ok ? r.plan.stages[0].filters?.find((f) => f.kind === "language") : undefined);

describe("Nov 9: a guessed language is not an ask", () => {
  it("«الشركات العربية» names companies, not a language; «باللغة العربية» and «عربي فقط» do", () => {
    expect(conditionsOfRequest(REQUEST)).not.toContain("language");
    expect(conditionsOfRequest(`${REQUEST} باللغة العربية`)).toContain("language");
    expect(conditionsOfRequest("هات ٥٠ تعليق عربي فقط عن الأكل")).toContain("language");
  });

  it("the live request: the measured Reddit page is English, so the guessed «Arabic only» is left OFF, the card says why, and the plan stands", () => {
    const r = planOf(REQUEST, englishPosts);
    expect(r.ok, r.ok ? "" : (r as { issues: string[] }).issues.join(" | ")).toBe(true);
    if (!r.ok) return;
    const f = languageOf(r)!;
    expect(f).toMatchObject({ kind: "language", lang: "ar" });
    expect(isEnabled(f)).toBe(false);
    expect(r.plan.notes_ar).toContain(languageOffLineAr("ar"));
    const view = customerPlanView(r.plan, { now: NOW });
    expect(view.notes_ar).toContain(languageOffLineAr("ar"));
    expect(view.assumptions_ar ?? []).not.toContain("باللغة العربية فقط.");
    // the customer can still switch it on from the editor
    expect(view.edit!.stages[0].filters.find((x: { kind: string }) => x.kind === "language")).toMatchObject({ enabled: false, lang: "ar" });
    // the card's sample is no longer emptied by a filter that removes every item
    expect(view.stages[0].sample_rows.length).toBeGreaterThan(0);
  });

  it("a measured page with Arabic items on the topic keeps the default on", () => {
    const r = planOf(REQUEST, [...englishPosts, arabicPost]);
    expect(r.ok, r.ok ? "" : (r as { issues: string[] }).issues.join(" | ")).toBe(true);
    expect(isEnabled(languageOf(r)!)).toBe(true);
    expect(r.ok && (r.plan.notes_ar ?? []).includes(languageOffLineAr("ar"))).toBe(false);
  });

  it("a language the customer SAID is kept, and a page with no item in it is refused before the card (no paid run that delivers nothing)", () => {
    const r = planOf(`${REQUEST} باللغة العربية فقط`, englishPosts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join(" | ")).toMatch(/passes the stage's filters \(filter_language: \d+/);
  });
});

describe("Nov 9: the price counts every item filter, the period included", () => {
  it("a measured page entirely outside the promised period is refused before the card", () => {
    const r = planOf(REQUEST, oldPosts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join(" | ")).toMatch(/filter_period: \d+/);
  });

  it("items outside the period lower the yield the price rests on", () => {
    const inPeriod = planOf(REQUEST, englishPosts);
    const mixed = planOf(REQUEST, [...englishPosts, ...oldPosts]);
    expect(inPeriod.ok && mixed.ok).toBe(true);
    if (!inPeriod.ok || !mixed.ok) return;
    expect(mixed.plan.stages[0].sample_matching).toBe(inPeriod.plan.stages[0].sample_matching);
    expect(mixed.plan.stages[0].yield_share!).toBeLessThan(inPeriod.plan.stages[0].yield_share!);
  });
});
