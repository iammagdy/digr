import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ReviewQuote, { ReviewQuoteBody } from "../src/components/mission/ReviewQuote";
import { REVIEW_CANCELLED_AR, REVIEW_CANCEL_BUTTON_AR, REVIEW_CANCELLING_AR, REVIEW_NEXT_STEP_AR, REVIEW_NOT_HELD_AR, REVIEW_PREPARE_BUTTON_AR, REVIEW_PREPARING_AR, REVIEW_READY_AR, REVIEW_REQUEST_ERRORS_AR, reviewRequestLinesAr, type ReviewRequestView } from "../src/lib/agentMission/stage4/reviewRequestLabels";
import { cancelReviewRequest, fetchReviewRequest, prepareReviewRequest, reviewRequestUrl } from "../src/lib/agentMission/stage4/reviewRequestClient";
import { type ReviewQuoteView } from "../src/lib/agentMission/stage4/reviewPreviewLabels";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * MONEY PR 7d, PHASE 2B-2 TASK 3: THE REVIEW REQUEST ON THE REQUEST PAGE (docs/MONEY-PR-7A.md section 16). After a valid quote the page offers «تجهيز طلب المراجعة»; the request then WAITS: «طلب المراجعة جاهز.», «لم يُحجز أو يُخصم من رصيدك شيء.»,
 * «يمكنك اعتماده في الخطوة التالية.», with a cancel button and NO approval button. The page finds the waiting request again after a refresh. The browser sends only the version (to create) or the request id (to cancel) and shows what the server answered.
 */
const MISSION = "msn_5851abc92a1e6645a9cd";
const REQUEST_ID = "msn_0123456789abcdef0123";
const versions = [{ version: 1, reason: "delivery" as const }, { version: 2, reason: "edit" as const }];
const offer: ReviewQuoteView = { state: "offer", version: 1, reason: "delivery", cells: 500, points: 100 };
const waiting: ReviewRequestView = { id: REQUEST_ID, version: 1, cells: 500, points: 100, status: "plan_ready" };
const render = (props: Partial<Parameters<typeof ReviewQuoteBody>[0]> = {}) => renderToStaticMarkup(createElement(ReviewQuoteBody, { versions, selected: 1, onSelect: () => {}, onAsk: () => {}, ...props }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const buttonsOf = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

describe("the Arabic words", () => {
  it("the three sentences of the brief, exactly, and the buttons", () => {
    expect(REVIEW_PREPARE_BUTTON_AR).toBe("تجهيز طلب المراجعة");
    expect(REVIEW_READY_AR).toBe("طلب المراجعة جاهز.");
    expect(REVIEW_NOT_HELD_AR).toBe("لم يُحجز أو يُخصم من رصيدك شيء.");
    expect(REVIEW_NEXT_STEP_AR).toBe("يمكنك اعتماده في الخطوة التالية.");
    expect(REVIEW_CANCEL_BUTTON_AR).toBe("إلغاء الطلب");
  });
  it("the waiting lines: ready, the version, the cells, the price from the server, then the two statements, in that order", () => {
    expect(reviewRequestLinesAr(waiting)).toEqual(["طلب المراجعة جاهز.", "مراجعة النسخة ١", "عدد الخانات التي ستُراجع: ٥٠٠", "تكلفة المراجعة: ١٠٠ نقطة", "لم يُحجز أو يُخصم من رصيدك شيء.", "يمكنك اعتماده في الخطوة التالية."]);
    expect(reviewRequestLinesAr({ ...waiting, version: 12, cells: 12_000, points: 120 }).slice(1, 4)).toEqual(["مراجعة النسخة ١٢", "عدد الخانات التي ستُراجع: ١٢٬٠٠٠", "تكلفة المراجعة: ١٢٠ نقطة"]);
  });
  it("every sentence passes the customer-text rules: Arabic only, Arabic-Indic numerals, no emoji, no provider name, no USD", () => {
    const all: string[] = [REVIEW_PREPARE_BUTTON_AR, REVIEW_PREPARING_AR, REVIEW_CANCEL_BUTTON_AR, REVIEW_CANCELLING_AR, REVIEW_CANCELLED_AR, ...Object.values(REVIEW_REQUEST_ERRORS_AR)];
    for (const v of [1, 2, 9, 10, 11, 100]) for (const points of [100, 101, 102, 103, 120, 5000]) all.push(...reviewRequestLinesAr({ id: REQUEST_ID, version: v, cells: points * 100, points, status: "plan_ready" }));
    for (const s of all) {
      expect(checkCustomerText(s).issues, s).toEqual([]); expect(checkCustomerLabel(s).issues, s).toEqual([]);
      expect(s, s).not.toMatch(/[0-9]/); expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u); expect(s, s).not.toMatch(/USD|\$|openai|anthropic|claude|supabase|plan_ready/i);
    }
  });
  it("a cancelled request says that nothing was held or charged", () => {
    expect(REVIEW_CANCELLED_AR).toMatch(/أُلغي/);
    expect(REVIEW_CANCELLED_AR).toMatch(/لم يُحجز أو يُخصم/);
  });
});

describe("TEST 16: the preparation button appears only after a valid quote", () => {
  it("an offer with a handler: «تجهيز طلب المراجعة» after the quote lines; touch-sized, full width on a phone, a plain button", () => {
    const html = render({ quote: offer, onPrepare: () => {} });
    expect(buttonsOf(html)).toEqual(["مراجعة الملف", "تجهيز طلب المراجعة"]);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b[^"]*\bsm:w-auto\b[^"]*"[^>]*>\s*تجهيز طلب المراجعة|<button[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b[^"]*\bsm:w-auto\b[^"]*"[^>]*type="button"[^>]*>\s*تجهيز طلب المراجعة/);
    expect(html.indexOf("تجهيز طلب المراجعة")).toBeGreaterThan(html.indexOf("لم يُخصم من رصيدك شيء."));
    expect(text(html)).not.toMatch(/[0-9]/);
  });
  it("no handler, no quote, or any state but an offer (reuse, blocked, too large, nothing to review): no preparation button", () => {
    expect(buttonsOf(render({ quote: offer }))).toEqual(["مراجعة الملف"]);
    expect(buttonsOf(render({ onPrepare: () => {} }))).toEqual(["مراجعة الملف"]);
    for (const q of [{ state: "reuse", version: 1, reason: "delivery" }, { state: "blocked", version: 1, reason: "delivery" }, { state: "too_large", version: 1, reason: "delivery", cells: 520_000 }, { state: "nothing_to_review", version: 1, reason: "delivery", cells: 0 }] as ReviewQuoteView[])
      expect(buttonsOf(render({ quote: q, onPrepare: () => {} })), q.state).toEqual(["مراجعة الملف"]);
  });
  it("while the request is being made its button says so and is disabled, and so are the other controls (no double click)", () => {
    const html = render({ quote: offer, onPrepare: () => {}, preparing: true });
    expect(html).toContain(REVIEW_PREPARING_AR);
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("TEST 11, 12: the waiting request, with a cancel button and no approval", () => {
  it("shows the ready sentence, the facts, the two statements and the cancel button; the only button is «إلغاء الطلب»", () => {
    const html = render({ waiting, onCancel: () => {} });
    for (const line of reviewRequestLinesAr(waiting)) expect(html).toContain(line);
    expect(buttonsOf(html)).toEqual(["إلغاء الطلب"]);
    const at = reviewRequestLinesAr(waiting).map((l) => html.indexOf(l));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toMatch(/<button[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b[^"]*\bsm:w-auto\b/);
    expect(html).toMatch(/aria-live="polite"/);
  });
  it("there is NO approval button: no button that approves, pays or reserves, even though the text says the next step will", () => {
    for (const html of [render({ waiting, onCancel: () => {} }), render({ quote: offer, onPrepare: () => {} }), render({ waiting, onCancel: () => {}, cancelling: true })])
      for (const label of buttonsOf(html)) expect(label).not.toMatch(/اعتمد|وافق|موافقة|ادفع|دفع|احجز|حجز|تأكيد|ابدأ/);
  });
  it("a waiting request replaces the quote flow (no «مراجعة الملف» button, no picker), and is shown even when the versions list is empty", () => {
    const html = render({ waiting, onCancel: () => {}, quote: offer, onPrepare: () => {} });
    expect(buttonsOf(html)).toEqual(["إلغاء الطلب"]);
    expect(html).not.toMatch(/<select/);
    expect(buttonsOf(render({ versions: [], waiting, onCancel: () => {} }))).toEqual(["إلغاء الطلب"]);
  });
  it("while cancelling the button says so and is disabled; a failure or a notice is one Arabic message", () => {
    const html = render({ waiting, onCancel: () => {}, cancelling: true });
    expect(html).toContain(REVIEW_CANCELLING_AR);
    expect(html).toContain("disabled=\"\"");
    const failed = render({ waiting, onCancel: () => {}, error: REVIEW_REQUEST_ERRORS_AR.changed });
    expect(failed.match(/role="alert"/g)).toHaveLength(1);
    const done = render({ notice: REVIEW_CANCELLED_AR });
    expect(done).toContain(REVIEW_CANCELLED_AR);
    expect(buttonsOf(done)).toEqual(["مراجعة الملف"]);
  });
});

describe("TEST 17: hidden while the feature is off", () => {
  it("nothing at all with no version and no waiting request, and before anything was fetched", () => {
    expect(renderToStaticMarkup(createElement(ReviewQuoteBody, { versions: [], selected: null, onSelect: () => {}, onAsk: () => {} }))).toBe("");
    expect(renderToStaticMarkup(createElement(ReviewQuote, { missionId: MISSION }))).toBe("");
  });
  it("the recovery request: a 404, a 401, a 503, a network error or a malformed answer is «no waiting request» (the section stays hidden or shows the quote flow)", async () => {
    const answers = [() => new Response("{}", { status: 404 }), () => new Response("{}", { status: 401 }), () => new Response("{}", { status: 503 }), () => new Response("not json"), () => new Response(JSON.stringify({ success: true, request: { id: "x" } })), () => new Response(JSON.stringify({ success: true, request: { ...waiting, status: "approved" } })), () => new Response(JSON.stringify({ success: true, request: { ...waiting, points: 1.5 } })), () => new Response(JSON.stringify({ success: true, request: null }))];
    for (const make of answers) expect(await fetchReviewRequest({ missionId: MISSION, fetchFn: (async () => make()) as any, headers: async () => ({}) })).toBeNull();
    expect(await fetchReviewRequest({ missionId: MISSION, fetchFn: (async () => { throw new TypeError("fetch failed"); }) as any, headers: async () => ({}) })).toBeNull();
    const ok = await fetchReviewRequest({ missionId: MISSION, fetchFn: (async () => new Response(JSON.stringify({ success: true, request: waiting }))) as any, headers: async () => ({ Authorization: "Bearer t" }) });
    expect(ok).toEqual(waiting);
    expect(reviewRequestUrl(MISSION)).toBe(`/api/missions/${MISSION}/review-request`);
  });
});

describe("the clicks: the browser sends the version or the request id and nothing else", () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as any;
  const headers = async () => ({ Authorization: "Bearer t" });
  it("prepare: POSTs exactly {action:'create', version} to the request route and returns the server's request (201 created, 200 already waiting)", async () => {
    for (const [status, created] of [[201, true], [200, false]] as const) {
      const fetchFn = answer(status, { success: true, created, request: waiting });
      const r = await prepareReviewRequest({ missionId: MISSION, version: 1, fetchFn, headers });
      expect(r).toEqual({ ok: true, created, request: waiting });
      const [url, init] = fetchFn.mock.calls[0] as [string, any];
      expect(url).toBe(reviewRequestUrl(MISSION));
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ action: "create", version: 1 });
      expect(init.headers).toMatchObject({ Authorization: "Bearer t", "Content-Type": "application/json" });
    }
  });
  it("prepare: the refusals are Arabic messages with no price: another add-on open, already reviewed, too large, nothing to review, not found, damaged, unavailable, signed out, network, an answer that is not a request", async () => {
    const cases: Array<[string, number, unknown, string]> = [
      ["open", 409, { success: false, error: "open_addon" }, REVIEW_REQUEST_ERRORS_AR.open_addon],
      ["reviewed", 409, { success: false, error: "review_exists" }, REVIEW_REQUEST_ERRORS_AR.review_exists],
      ["large", 409, { success: false, error: "too_large" }, REVIEW_REQUEST_ERRORS_AR.too_large],
      ["nothing", 409, { success: false, error: "nothing_to_review" }, REVIEW_REQUEST_ERRORS_AR.nothing_to_review],
      ["unknown 409", 409, { success: false, error: "plan_changed" }, REVIEW_REQUEST_ERRORS_AR.unavailable],
      ["404", 404, {}, REVIEW_REQUEST_ERRORS_AR.not_found],
      ["500", 500, {}, REVIEW_REQUEST_ERRORS_AR.damaged],
      ["503", 503, {}, REVIEW_REQUEST_ERRORS_AR.unavailable],
      ["401", 401, {}, REVIEW_REQUEST_ERRORS_AR.unauthorized],
      ["400", 400, {}, REVIEW_REQUEST_ERRORS_AR.unavailable],
      ["no request", 201, { success: true, created: true }, REVIEW_REQUEST_ERRORS_AR.unavailable],
      ["wrong status", 201, { success: true, created: true, request: { ...waiting, status: "approved" } }, REVIEW_REQUEST_ERRORS_AR.unavailable],
    ];
    for (const [label, status, body, message] of cases) expect(await prepareReviewRequest({ missionId: MISSION, version: 1, fetchFn: answer(status, body), headers }), label).toEqual({ ok: false, message });
    expect(await prepareReviewRequest({ missionId: MISSION, version: 1, fetchFn: (async () => { throw new TypeError("fetch failed"); }) as any, headers })).toEqual({ ok: false, message: REVIEW_REQUEST_ERRORS_AR.network });
  });
  it("prepare: a version that is not a positive whole number is refused without a request", async () => {
    const fetchFn = vi.fn();
    for (const v of [0, -1, 1.5, Number.NaN, 10000]) expect(await prepareReviewRequest({ missionId: MISSION, version: v, fetchFn: fetchFn as any, headers })).toMatchObject({ ok: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("cancel: POSTs exactly {action:'cancel', requestId}; 200 is done; 409 says the status changed; 404, 503 and network have their own messages", async () => {
    const ok = answer(200, { success: true });
    expect(await cancelReviewRequest({ missionId: MISSION, requestId: REQUEST_ID, fetchFn: ok, headers })).toEqual({ ok: true });
    expect(JSON.parse((ok.mock.calls[0] as [string, any])[1].body)).toEqual({ action: "cancel", requestId: REQUEST_ID });
    expect(await cancelReviewRequest({ missionId: MISSION, requestId: REQUEST_ID, fetchFn: answer(409, { success: false, error: "changed" }), headers })).toEqual({ ok: false, message: REVIEW_REQUEST_ERRORS_AR.changed });
    expect(await cancelReviewRequest({ missionId: MISSION, requestId: REQUEST_ID, fetchFn: answer(404, {}), headers })).toEqual({ ok: false, message: REVIEW_REQUEST_ERRORS_AR.not_found });
    expect(await cancelReviewRequest({ missionId: MISSION, requestId: REQUEST_ID, fetchFn: answer(503, {}), headers })).toEqual({ ok: false, message: REVIEW_REQUEST_ERRORS_AR.unavailable });
    expect(await cancelReviewRequest({ missionId: MISSION, requestId: REQUEST_ID, fetchFn: (async () => { throw new TypeError("x"); }) as any, headers })).toEqual({ ok: false, message: REVIEW_REQUEST_ERRORS_AR.network });
  });
  it("cancel: an id that is not a request id is refused without a request", async () => {
    const fetchFn = vi.fn();
    for (const id of ["", "x", "../x", "MSN_ABC", "msn_", "msn_UPPERCASE00000000"]) expect(await cancelReviewRequest({ missionId: MISSION, requestId: id, fetchFn: fetchFn as any, headers })).toMatchObject({ ok: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("where it lives, and what the browser code may import", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  it("the browser code computes no price and imports no money, quote, row or storage module", () => {
    for (const p of ["src/components/mission/ReviewQuote.tsx", "src/lib/agentMission/stage4/reviewRequestLabels.ts", "src/lib/agentMission/stage4/reviewRequestClient.ts"]) {
      const src = read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, p).not.toMatch(/addonQuote|addonSettlement|addonRow|\/quotes|reviewCard|\breviewQuote\s*\(|reviewCellsOf|reviewHoldPoints|Math\.ceil|Math\.max/);
      expect(src, p).not.toMatch(/price|supabase\/server|createAdminClient|service[_-]?role/i);
    }
  });
  it("only the request details page renders the section, still once, under the versions list", () => {
    const page = read("src/app/dashboard/requests/[id]/page.tsx");
    expect(page.match(/<ReviewQuote /g)).toHaveLength(1);
    for (const p of ["src/app/dashboard/chat/page.tsx", "src/components/mission/AgentMissionCard.tsx", "src/components/mission/VersionList.tsx"]) expect(read(p), p).not.toMatch(/ReviewQuote|review-request/);
  });
});
