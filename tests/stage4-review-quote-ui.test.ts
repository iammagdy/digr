import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ReviewQuote, { ReviewQuoteBody } from "../src/components/mission/ReviewQuote";
import { ADDON_CREATE_REFUSALS_AR } from "../src/lib/agentMission/stage4/addonRow";
import { REVIEW_BUTTON_AR, REVIEW_ERRORS_AR, REVIEW_ASKING_AR, reviewQuoteLinesAr, type ReviewQuoteView } from "../src/lib/agentMission/stage4/reviewPreviewLabels";
import { fetchReviewQuote, fetchReviewVersions, reviewQuoteUrl } from "../src/lib/agentMission/stage4/reviewPreviewClient";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * MONEY PR 7c, PHASE 2B-2 TASK 2: THE REVIEW PREVIEW ON THE REQUEST PAGE (docs/MONEY-PR-7A.md section 15). A small section: «مراجعة الملف» asks the server for the quote and shows exactly what the server answered: which version, how many cells, the price in points,
 * and that nothing was charged. The browser computes no price. There is NO approval button. Hidden while the flag is off (the route answers 404). Arabic only, Arabic-Indic numerals, no emoji, no provider, no USD.
 */
const MISSION = "msn_5851abc92a1e6645a9cd";
const versions = [{ version: 1, reason: "delivery" as const }, { version: 2, reason: "edit" as const }];
const offer: ReviewQuoteView = { state: "offer", version: 1, reason: "delivery", cells: 500, points: 100 };
const render = (props: Partial<Parameters<typeof ReviewQuoteBody>[0]> = {}) => renderToStaticMarkup(createElement(ReviewQuoteBody, { versions, selected: 2, onSelect: () => {}, onAsk: () => {}, ...props }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("TEST 15: the Arabic words, numbers and points", () => {
  it("the offer says which version, how many cells, the price in points and that nothing was charged", () => {
    expect(reviewQuoteLinesAr(offer).slice(0, 4)).toEqual(["مراجعة النسخة ١", "عدد الخانات التي ستُراجع: ٥٠٠", "تكلفة المراجعة: ١٠٠ نقطة", "لم يُخصم من رصيدك شيء."]);
    expect(reviewQuoteLinesAr({ ...offer, version: 12, cells: 1_234_567 % 500_000, points: 5000 }).slice(0, 3)).toEqual(["مراجعة النسخة ١٢", "عدد الخانات التي ستُراجع: ٢٣٤٬٥٦٧", "تكلفة المراجعة: ٥٬٠٠٠ نقطة"]);
    expect(reviewQuoteLinesAr({ ...offer, points: 101 })[2]).toBe("تكلفة المراجعة: ١٠١ نقطة");
  });
  it("it says plainly that this is a quote only: no review has started", () => {
    const lines = reviewQuoteLinesAr(offer);
    expect(lines.join(" ")).toMatch(/عرض سعر فقط/);
    expect(lines.join(" ")).toMatch(/لم يُخصم/);
  });
  it("the reuse, blocked, too-large and nothing-to-review states carry no price and never offer to charge", () => {
    for (const q of [{ state: "reuse", version: 2, reason: "edit" }, { state: "blocked", version: 1, reason: "delivery" }, { state: "too_large", version: 1, reason: "delivery", cells: 520_000 }, { state: "nothing_to_review", version: 1, reason: "delivery", cells: 0 }] as ReviewQuoteView[]) {
      const t = reviewQuoteLinesAr(q).join(" ");
      expect(t, q.state).not.toMatch(/نقطة|نقاط|نقطتان|تكلفة المراجعة/);
      expect(t, q.state).toMatch(/لم يُخصم|بلا مقابل/);
    }
    expect(reviewQuoteLinesAr({ state: "reuse", version: 2, reason: "edit" }).join(" ")).toMatch(/من قبل/);
    expect(reviewQuoteLinesAr({ state: "reuse", version: 2, reason: "edit" }).join(" ")).toMatch(/مرة ثانية|مرة أخرى/);
  });
  it("the blocked sentence is the very sentence the add-on rules use", () => {
    expect(reviewQuoteLinesAr({ state: "blocked", version: 1, reason: "delivery" })).toContain(ADDON_CREATE_REFUSALS_AR.open_addon);
  });
  it("every sentence it can show passes the customer-text rules, with no Latin digit, no emoji, no provider name and no USD", () => {
    const all: string[] = [REVIEW_BUTTON_AR, REVIEW_ASKING_AR, ...Object.values(REVIEW_ERRORS_AR)];
    for (const v of [1, 2, 3, 9, 10, 11, 100]) for (const points of [100, 101, 102, 103, 110, 111, 250, 5000]) {
      all.push(...reviewQuoteLinesAr({ state: "offer", version: v, reason: "edit", cells: points * 100, points }));
    }
    for (const q of [{ state: "reuse" }, { state: "blocked" }, { state: "too_large", cells: 1 }, { state: "nothing_to_review", cells: 0 }]) all.push(...reviewQuoteLinesAr({ version: 3, reason: "review_fix", ...q } as ReviewQuoteView));
    for (const s of all) {
      expect(checkCustomerText(s).issues, s).toEqual([]); expect(checkCustomerLabel(s).issues, s).toEqual([]);
      expect(s, s).not.toMatch(/[0-9]/); expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u); expect(s, s).not.toMatch(/USD|\$|openai|anthropic|claude|supabase/i);
    }
  });
});

describe("TEST 16: the section is usable on a phone and has no approval button", () => {
  it("«مراجعة الملف» is the only button: touch-sized, full width on a small screen, labelled, a plain button", () => {
    const html = render();
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toMatch(/<button[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b[^"]*\bsm:w-auto\b/);
    expect(html).toMatch(/focus-visible:outline/);
    expect(html.match(/>مراجعة الملف</g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).not.toMatch(/<a |href=/);
    expect(text(html)).not.toMatch(/[0-9]/);
  });
  it("with two or more published versions a version picker (full width, touch-sized, Arabic titles); with one there is none", () => {
    const html = render();
    expect(html).toMatch(/<select[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b/);
    expect(html).toContain("النسخة ١ — الملف الأصلي");
    expect(html).toContain("النسخة ٢ — بعد التعديل");
    expect(html).toMatch(/<option[^>]*value="2"[^>]*selected|<option[^>]*selected[^>]*value="2"/);
    expect(render({ versions: [versions[0]], selected: 1 })).not.toMatch(/<select/);
  });
  it("a quote is shown in a polite live region, the layout stacks on a phone, and still no second button, no approval, no payment word", () => {
    const html = render({ quote: offer });
    expect(html).toMatch(/aria-live="polite"/);
    expect(html).toMatch(/class="[^"]*\bflex-col\b/);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("مراجعة النسخة ١");
    expect(html).toContain("عدد الخانات التي ستُراجع: ٥٠٠");
    expect(html).toContain("تكلفة المراجعة: ١٠٠ نقطة");
    expect(html).toContain("لم يُخصم من رصيدك شيء.");
    expect(text(html)).not.toMatch(/وافق|موافقة|اعتماد|ادفع|دفع|تأكيد|ابدأ|اطلب المراجعة|احجز|حجز/);
  });
  it("while the server is asked the button says so and cannot be clicked twice; a failure is one Arabic alert", () => {
    const busy = render({ busy: true });
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain("disabled=\"\"");
    expect(busy).toContain(REVIEW_ASKING_AR);
    const failed = render({ error: REVIEW_ERRORS_AR.unavailable });
    expect(failed.match(/role="alert"/g)).toHaveLength(1);
    expect(failed).toContain(REVIEW_ERRORS_AR.unavailable);
  });
});

describe("TEST 14: hidden while the feature is off", () => {
  it("nothing at all with no published version (the route answers 404 with the flag off, so the page gets none), and before anything was fetched", () => {
    expect(renderToStaticMarkup(createElement(ReviewQuoteBody, { versions: [], selected: null, onSelect: () => {}, onAsk: () => {} }))).toBe("");
    expect(renderToStaticMarkup(createElement(ReviewQuote, { missionId: MISSION }))).toBe("");
  });
  it("the list request: a 404, a 401, a 503, a network error or a bad answer is «nothing to show»", async () => {
    for (const make of [() => new Response("{}", { status: 404 }), () => new Response("{}", { status: 401 }), () => new Response("{}", { status: 503 }), () => new Response("not json", { status: 200 }), () => new Response(JSON.stringify({ success: true, versions: "x" }), { status: 200 }), () => new Response(JSON.stringify({ success: true, versions: [] }), { status: 200 })]) {
      expect(await fetchReviewVersions({ missionId: MISSION, fetchFn: (async () => make()) as any, headers: async () => ({}) })).toEqual([]);
    }
    expect(await fetchReviewVersions({ missionId: MISSION, fetchFn: (async () => { throw new TypeError("fetch failed"); }) as any, headers: async () => ({}) })).toEqual([]);
    const ok = await fetchReviewVersions({ missionId: MISSION, fetchFn: (async () => new Response(JSON.stringify({ success: true, versions: [{ version: 2, reason: "edit" }, { version: 1, reason: "delivery" }, { version: 0, reason: "x" }, "junk"] }))) as any, headers: async () => ({ Authorization: "Bearer t" }) });
    expect(ok).toEqual([{ version: 1, reason: "delivery" }, { version: 2, reason: "edit" }]);
  });
});

describe("the click: the browser only asks, and shows what the server answered", () => {
  const answer = (quote: unknown) => (async () => new Response(JSON.stringify({ success: true, quote }), { status: 200 })) as any;
  it("asks the review route of its own mission for that version with the bearer token", async () => {
    const fetchFn = vi.fn(answer(offer));
    const r = await fetchReviewQuote({ missionId: MISSION, version: 1, fetchFn, headers: async () => ({ Authorization: "Bearer t" }) });
    expect(r).toEqual({ ok: true, quote: offer });
    expect(reviewQuoteUrl(MISSION, 1)).toBe(`/api/missions/${MISSION}/review-quote?version=1`);
    expect(reviewQuoteUrl(MISSION)).toBe(`/api/missions/${MISSION}/review-quote`);
    expect((fetchFn.mock.calls[0] as unknown as [string, any])[0]).toBe(reviewQuoteUrl(MISSION, 1));
    expect((fetchFn.mock.calls[0] as unknown as [string, any])[1].headers).toEqual({ Authorization: "Bearer t" });
  });
  it("the price shown is the server's, never computed here: whatever points the server says are the points shown, whatever the cells", async () => {
    const r = await fetchReviewQuote({ missionId: MISSION, version: 1, fetchFn: answer({ state: "offer", version: 1, reason: "delivery", cells: 7, points: 777 }), headers: async () => ({}) });
    expect(r.ok && reviewQuoteLinesAr(r.quote).join(" ")).toContain("تكلفة المراجعة: ٧٧٧ نقطة");
    expect(r.ok && reviewQuoteLinesAr(r.quote).join(" ")).toContain("عدد الخانات التي ستُراجع: ٧");
  });
  it("every failure is a controlled Arabic message with no price: 404, 503, 500, 401, 400, a network error, a malformed or a price-less answer", async () => {
    const cases: Array<[string, () => Promise<Response>, string]> = [
      ["404", async () => new Response("{}", { status: 404 }), REVIEW_ERRORS_AR.not_found],
      ["503", async () => new Response("{}", { status: 503 }), REVIEW_ERRORS_AR.unavailable],
      ["500", async () => new Response("{}", { status: 500 }), REVIEW_ERRORS_AR.damaged],
      ["401", async () => new Response("{}", { status: 401 }), REVIEW_ERRORS_AR.unauthorized],
      ["400", async () => new Response("{}", { status: 400 }), REVIEW_ERRORS_AR.unavailable],
      ["network", async () => { throw new TypeError("fetch failed"); }, REVIEW_ERRORS_AR.network],
      ["not json", async () => new Response("<html>", { status: 200 }), REVIEW_ERRORS_AR.unavailable],
      ["an offer with no price", async () => new Response(JSON.stringify({ success: true, quote: { state: "offer", version: 1, reason: "delivery", cells: 5 } }), { status: 200 }), REVIEW_ERRORS_AR.unavailable],
      ["a price that is not a whole number", async () => new Response(JSON.stringify({ success: true, quote: { state: "offer", version: 1, reason: "delivery", cells: 5, points: 1.5 } }), { status: 200 }), REVIEW_ERRORS_AR.unavailable],
      ["an unknown state", async () => new Response(JSON.stringify({ success: true, quote: { state: "approve", version: 1, reason: "delivery" } }), { status: 200 }), REVIEW_ERRORS_AR.unavailable],
    ];
    for (const [label, fetchFn, message] of cases) {
      expect(await fetchReviewQuote({ missionId: MISSION, version: 1, fetchFn: fetchFn as any, headers: async () => ({}) }), label).toEqual({ ok: false, message });
      expect(checkCustomerText(message).issues, label).toEqual([]);
    }
  });
  it("a version number that is not a positive whole number is refused without a request", async () => {
    const fetchFn = vi.fn();
    for (const v of [0, -1, 1.5, Number.NaN, 10000]) expect(await fetchReviewQuote({ missionId: MISSION, version: v, fetchFn: fetchFn as any, headers: async () => ({}) })).toMatchObject({ ok: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("where it lives, and what the browser code may import", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  it("only the request details page renders it, under the versions list, for a delivered mission", () => {
    const page = read("src/app/dashboard/requests/[id]/page.tsx");
    expect(page).toContain("<ReviewQuote missionId={missionId} />");
    expect(page.indexOf("<ReviewQuote")).toBeGreaterThan(page.indexOf("<VersionList"));
    for (const p of ["src/app/dashboard/chat/page.tsx", "src/components/mission/AgentMissionCard.tsx", "src/components/mission/VersionList.tsx"]) expect(read(p), p).not.toMatch(/ReviewQuote|review-quote/);
  });
  it("the browser code computes no price and imports no money, quote or storage module", () => {
    for (const p of ["src/components/mission/ReviewQuote.tsx", "src/lib/agentMission/stage4/reviewPreviewLabels.ts", "src/lib/agentMission/stage4/reviewPreviewClient.ts"]) {
      const src = read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, p).not.toMatch(/addonQuote|addonSettlement|addonRow|\/quotes|price|reviewCard|\breviewQuote\s*\(|reviewCellsOf|reviewHoldPoints|Math\.ceil|supabase\/server|createAdminClient|service/i);
    }
  });
});
