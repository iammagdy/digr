import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { discoverCards } from "../src/lib/agentMission/foundation/discovery/deriveCards";
import { fieldNotesAr, recoverFields, sheetWantsOf } from "../src/lib/agentMission/foundation/discovery/fieldRecovery";
import { NO_SENSITIVE_ACCESS } from "../src/lib/treg/dataPolicy";
import { TOOL_CARDS } from "../src/lib/agentMission/foundation/toolCards";
import { buildRequestContract } from "../src/lib/agentMission/requestContract";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { customerMissionView, stagesView } from "../src/lib/agentMission/customerView";
import { promisedRowsOf } from "../src/lib/agentMission/promisedTotal";
import { promisedTotalOf } from "../src/lib/agentMission/promisedNumbers";
import { withPromiseCaps, withRepliesJudged } from "../src/lib/agentMission/repliesCard";
import { counterAr } from "../src/lib/agentMission/stage2/counterWording";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * NOV 6 2026 FIVE-PLATFORM ACCEPTANCE CAMPAIGN, INSTAGRAM (msn_34dcf09434697a62995c, job_quote_23f61141a3992490106b91a818e3a74d, test account, 100 points charged; read-only SELECTs).
 * Request: «اجمع لي منشورين عامين من إنستجرام عن الذكاء الاصطناعي (ريلز لو متاح)، مع تعليقين حقيقيين على كل منشور، والروابط وأسماء الحسابات.»
 *  1. THE FILE CONTRACT: the stored Reels stage's columns were `text, link, views, topic_relation`: no account, no date, no likes, and no sentence said why. Cause: «أسماء الحسابات» (the plural) was not read as the account
 *     (`wants` held nothing), so the round-36 field check never ran, and the Reels tool's card maps none of them.
 *  2. THE DENOMINATOR: delivered 2 reels + 1 comment = 3 of 2 + 4 = 6 asked. The stored PUBLIC plan after the run says comments `expected_rows: 1` (the private plan 4): the end of the run «judged» the open comments stage
 *     down to what the source gave, so the orders page and the details said 3 of 3 while the file's rule says 3 of 6.
 * DATA: the reel rows are shaped like the stored pinned rows (ids and links as stored); `owner` / `taken_at_timestamp` rows are SYNTHETIC (to show the recovery path when a real page carries them).
 */
const catalog = loadTregCatalog();
const AT = Date.parse("2026-11-06T18:52:37Z");
const IG = "اجمع لي منشورين عامين من إنستجرام عن الذكاء الاصطناعي (ريلز لو متاح)، مع تعليقين حقيقيين على كل منشور، والروابط وأسماء الحسابات.";
const derived = discoverCards(catalog, "instagram", NO_SENSITIVE_ACCESS).cards;
/** The cards the planner builds from: the hand-written ones and the ones derived from the catalog (agent/src/compiled.ts). */
const cards = [...TOOL_CARDS, ...derived];
const reelsCard = derived.find((c) => c.endpointId === "scrapecreators.x.v2-instagram-reels-search")!;
const reel = (i: number, extra: Record<string, unknown> = {}) => ({ id: `91000000000000000${i}`, __typename: "XDTGraphVideo", shortcode: `SYN${i}`, url: `https://www.instagram.com/reel/SYN${i}/`, caption: `synthetic: الذكاء الاصطناعي في التعليم ${i}`, product_type: "clips", video_view_count: 100 * i, ...extra });

describe("1. the account the customer named, and the Instagram sheet's standard fields", () => {
  it("«أسماء الحسابات» / «أسماء الصفحات» / «أسماء القنوات» name the account", () => {
    expect(buildRequestContract(IG).wants).toEqual(["author"]);
    expect(buildRequestContract("منشورين من فيسبوك عن القهوة والروابط وأسماء الصفحات").wants).toEqual(["author"]);
    expect(buildRequestContract("فيديوهين من يوتيوب عن القهوة وأسماء القنوات").wants).toEqual(["author"]);
  });

  it("the sheet accounts for the named account AND the platform's standard date and likes (Instagram only)", () => {
    expect(sheetWantsOf(buildAsk(IG, null, AT))).toEqual(["author", "posted_at", "likes"]);
    expect(sheetWantsOf({ platform: "tiktok", wants: ["author"] })).toEqual(["author"]);
  });

  it("a real page that carries the owner and the time: both are RECOVERED from the provider's own keys (a derived card), never guessed; likes are never read from a guessed key", () => {
    const page = { reels: [1, 2, 3].map((i) => reel(i, { owner: { username: `creator_${i}` }, taken_at_timestamp: 1_793_000_000 + i })) };
    const rec = recoverFields(reelsCard, page, sheetWantsOf(buildAsk(IG, null, AT)), AT);
    expect(rec.report.map((r) => [r.key, r.status])).toEqual([["author", "recovered"], ["posted_at", "recovered"], ["likes", "unavailable"]]);
  });

  it("a page with none of them: the plan has the account, date and likes COLUMNS («غير متاح»), and says so before approval; «طلبت» only for what the customer named", () => {
    const ask = buildAsk(IG, null, AT);
    const page = { reels: [1, 2, 3].map((i) => reel(i)) };
    const rec = recoverFields(reelsCard, page, sheetWantsOf(ask), AT);
    expect(rec.report.every((r) => r.status === "unavailable")).toBe(true);
    const notes = fieldNotesAr(rec.report, ask.wants ?? []);
    expect(notes[0]).toMatch(/^طلبت أسماء أصحاب الحسابات/);
    expect(notes[1]).toMatch(/^لا يعيد المصدر المختار التواريخ والإعجابات/);
    expect(notes.join(" ")).not.toMatch(/طلبت التواريخ|طلبت الإعجابات/);
    for (const n of notes) expect(checkCustomerText(n).issues).toEqual([]);
    const r = compilePlan({ ask, pool: { card: rec.card, params: parentInputs(rec.card, ask), pages: [{ callId: "call_0001", page }] }, exposure: () => ({ callId: null, page: null, failed: true }), capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null, catalogOnly: true, cards, reelsProven: true, nowMs: AT });
    if (!r.ok) throw new Error(r.reason);
    const keys = r.plan.stages[0].columns.map((c) => c.key);
    // stored: text, link, views, topic_relation
    for (const k of ["text", "link", "views", "author", "posted_at", "likes"]) expect(keys).toContain(k);
  });
});

describe("2. ONE truthful denominator: 3 delivered of 6 asked, on the file, the chat, the orders page and the details", () => {
  /** The stored plan's shape: 2 reels (exact) and an OPEN comments stage, 2 asked per reel (4). */
  const approved = (): PricedPlan => {
    const ask = buildAsk(IG, null, AT);
    const page = { reels: [1, 2].map((i) => reel(i)) };
    const r = compilePlan({ ask, pool: { card: reelsCard, params: parentInputs(reelsCard, ask), pages: [{ callId: "call_0001", page }] }, exposure: () => ({ callId: null, page: null, failed: true }), capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null, catalogOnly: true, cards, reelsProven: true, nowMs: AT });
    if (!r.ok) throw new Error(r.reason);
    return r.plan;
  };

  it("the compiled comments stage is the customer's «2 for each reel»: open (no counter), marked as ASKED, 4 rows", () => {
    const c = approved().stages.find((s) => s.key === "comments")!;
    expect(c.children_open).toBe(true);
    expect(c.per_parent_asked).toBe(true);
    expect(c.per_parent_rows).toBe(2);
    expect(c.planned_rows).toBe(4);
  });

  it("before approval: the card says 4 comments and a total of 6 (not «كل التعليقات», not 2)", () => {
    const pub = customerPlanView(approved());
    expect(stagesView(pub).total).toBe(6);
    expect(promisedRowsOf(pub.stages as never, 0, true)).toBe(6);
  });

  it("THE FAILURE SHAPE after the run (2 reels, 1 comment, the source ended): every surface says 3 of 6", () => {
    const plan0 = withPromiseCaps(approved());
    const rowsByStage = { posts: [{ id: "a" }, { id: "b" }], comments: [{ id: "c1", parent_id: "a" }] } as Record<string, Array<Record<string, unknown>>>;
    const judged = withRepliesJudged(plan0, rowsByStage, () => true);
    // stored public plan after the run: comments expected_rows 1 → «3 of 3». Now the customer's 4 stays.
    expect(judged.stages.find((s) => s.key === "comments")!.planned_rows).toBe(4);
    const deliveredByStage = { posts: 2, comments: 1 };
    const file = promisedTotalOf(judged, deliveredByStage, true);
    expect(file).toEqual({ delivered: 3, promised: 6 });
    const pub = customerPlanView(judged);
    expect(promisedRowsOf(pub.stages as never, 0, true)).toBe(6);
    const view = customerMissionView({ mission: { id: "msn_x", status: "completed", question_ar: null, plan_public: pub as never, reserved_points: 200, unit_price_points: null, delivered_units: 3, charged_points: 100, summary_ar: null, files: null, created_at: new Date(AT).toISOString() }, events: [] });
    const line = view.resultLinesAr.find((l) => /^تم تسليم/.test(l))!;
    expect(line).toMatch(/٣ .*من ٦/);
    expect(line).not.toMatch(/من ٣/);
    expect(counterAr(file.delivered, file.promised)).toMatch(/^٣ من ٦/);
  });

  it("an open stage the customer did NOT number («كل التعليقات», no counter) keeps the earlier rule: judged to what the source gave", () => {
    const plan0 = withPromiseCaps(approved());
    const unasked = { ...plan0, stages: plan0.stages.map((s) => (s.key === "comments" ? { ...s, per_parent_asked: undefined } : s)) };
    const judged = withRepliesJudged(unasked, { posts: [{ id: "a" }, { id: "b" }], comments: [{ id: "c1" }] }, () => true);
    expect(judged.stages.find((s) => s.key === "comments")!.planned_rows).toBe(1);
  });
});
