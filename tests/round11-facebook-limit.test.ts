import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { liveFacebookPlan, FB_REQUEST, LIVE_COUNTERS } from "./helpers/facebookLiveShape";
import { AGENT_JOB_POINTS_CAP } from "../src/lib/agentMission/constants";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { customerMissionView, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { repriceStoredPlan } from "../src/lib/agentMission/lifecycle";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { priceBreakdownOf, publicPlanOf, smallerVersionOf, holdLimitOf } from "../src/lib/agentMission/overLimit";
import { smallerVersionForCustomer } from "../src/lib/agentMission/customerActions";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { formatAr } from "../src/lib/arabicDigits";
import { createMemoryDb } from "./helpers/memoryDb";
import { REPLAY_USER } from "./helpers/agentReplay";

/**
 * LIVE ROUND 11 (3 Nov 2026), item 4: Facebook `msn_9d196025e7929324983a`, after the tester chose «fill from other pages». The card said «السعر حتى ٩٬١٢٥ نقطة» and «حجز مؤقت ٢٦٬٦٥٣»: a hold ABOVE the job cap (25,000 points) with an approve button
 * that could only fail («المهمة أكبر من الحد المسموح للحجز الواحد») after the click. The plan of the live run is rebuilt here by the compiler from the real M17 search page and a comments page with the LIVE counters (posts of 15, 1,823 and 58 comments;
 * the 14 comments read at planning say 22 replies), and it reproduces the stored numbers to the point: 4,879 rows, unit 4.750125, maximum charge 23,176, hold 26,653 (read-only SELECT on the mission's plan and price).
 */
const live = liveFacebookPlan();
const plan: PricedPlan = live.plan;

describe("the live plan is reproduced to the point (the breakdown of 9,125 and 26,653 row by row)", () => {
  it("4,879 rows at 4.750125 points: 3 posts, 1,896 comments (15 + 1,823 + 58), 2,980 replies; the hold is 26,653 and is above the 25,000 cap", () => {
    expect(plan.price.deliveredRows).toBe(4879);
    expect(plan.price.unitPricePoints).toBe(4.750125);
    expect(plan.price.maxChargePoints).toBe(23176);
    expect(plan.price.reservePoints).toBe(26653);
    expect(plan.price.overCap).toBe(true);
    expect(plan.price.reservePoints).toBeGreaterThan(AGENT_JOB_POINTS_CAP);
    expect(LIVE_COUNTERS.reduce((a, b) => a + b, 0)).toBe(1896);
  });
  it("the breakdown: counted part 3 + 1,896 + 22 = 1,921 rows = 9,125 points; the replies of comments not read yet 2,958 rows = 14,051 points; together 23,176; the hold is 15% above", () => {
    const b = priceBreakdownOf(plan)!;
    expect(b.posts).toMatchObject({ rows: 3, points: 15 });
    expect(b.comments).toMatchObject({ rows: 1896, points: 9006 });
    expect(b.repliesCounted).toMatchObject({ rows: 22, points: 104 });
    expect(b.repliesOpen).toMatchObject({ rows: 2958, points: 14051 });
    expect(b.counted).toMatchObject({ rows: 1921, points: 9125 });
    expect(b.max).toMatchObject({ rows: 4879, points: 23176 });
    expect(b.reservePoints).toBe(26653);
    expect(b.counted.points + b.repliesOpen.points).toBe(b.max.points);
    // where the money is: the replies' share of the provider cost
    expect(b.repliesShareOfProviderCost).toBeGreaterThan(0.85);
  });
});

describe("a plan above the limit is never shown with an approve button; the card says so and offers a smaller version, a change, or a cancel", () => {
  const pub = publicPlanOf(plan) as Record<string, any>;
  it("the stored public plan says it is over the limit, with the hold and the cap", () => {
    expect(pub.limit).toMatchObject({ over: true, reserve_points: 26653, cap_points: AGENT_JOB_POINTS_CAP });
  });
  it("the smaller version is chosen by code: the most comments per post whose hold fits the cap, and one more does not", () => {
    const s = smallerVersionOf(plan, AGENT_JOB_POINTS_CAP)!;
    expect(s).not.toBeNull();
    expect(s.per_post).toBeGreaterThanOrEqual(1);
    expect(s.plan.price.reservePoints).toBeLessThanOrEqual(AGENT_JOB_POINTS_CAP);
    expect(s.plan.price.overCap).toBe(false);
    const next = smallerVersionOf(plan, AGENT_JOB_POINTS_CAP, { perPost: s.per_post + 1 });
    expect(next === null || next.plan.price.reservePoints > AGENT_JOB_POINTS_CAP).toBe(true);
    expect(pub.limit.smaller).toMatchObject({ per_post: s.per_post, reserve_points: s.plan.price.reservePoints });
  });
  it("the smaller plan is priced again by the same rule: approval reprices it to the same number (never a stored number nobody recomputed)", () => {
    const s = smallerVersionOf(plan, AGENT_JOB_POINTS_CAP)!;
    const again = repriceStoredPlan(s.plan);
    expect(again.reservePoints).toBe(s.plan.price.reservePoints);
    expect(again.unitPricePoints).toBe(s.plan.price.unitPricePoints);
    expect(again.deliveredRows).toBe(s.plan.price.deliveredRows);
    expect(again.overCap).toBe(false);
    // the charge rule never moved: the maximum charge is the rows at the unit price, the hold is 15% above it
    expect(s.plan.price.maxChargePoints).toBe(Math.ceil(s.plan.price.deliveredRows * s.plan.price.unitPricePoints));
  });
  it("the comments of the smaller plan are what the compiler gives for the same number per post (counters known: the sum of min(counter, N))", () => {
    const s = smallerVersionOf(plan, AGENT_JOB_POINTS_CAP)!;
    const n = s.per_post;
    const want = LIVE_COUNTERS.reduce((a, c) => a + Math.min(c, n), 0);
    const comments = s.plan.stages.find((x) => x.key === "comments")!;
    expect(comments.planned_rows).toBe(want);
    expect(comments.per_parent_rows).toBe(n);
    expect(s.plan.compiled!.promises.comments).toMatchObject({ type: "counter", n: want });
    // the compiler's own promise for the same number per post (its stage keeps N x posts as the hold's room; the promise is what the counters allow)
    const asked = liveFacebookPlan({ request: `${FB_REQUEST.replace("مع كل التعليقات والردود.", "")} مع ${n} تعليق من كل منشور ومعها الردود.` });
    expect(asked.promises.comments).toMatchObject({ type: "counter", n: want });
  });
  it("the sentences of the smaller plan say its own numbers (no «كل التعليقات» promise, no stale count), in Arabic digits and clean customer text", () => {
    const s = smallerVersionOf(plan, AGENT_JOB_POINTS_CAP)!;
    const view = customerPlanView(s.plan);
    const text = [view.summary_ar, ...(view.notes_ar ?? [])].join("\n");
    expect(text).not.toContain("١٨٩٦");
    expect(text).not.toMatch(/كل تعليقات/);
    expect(text).toContain(`حتى ${formatAr(s.per_post)} تعليق من كل`);
    expect(checkCustomerText(text, { maxChars: 4000 }).issues).toEqual([]);
  });
  it("a hold the customer's balance cannot cover is a limit too: the smaller version is sized to the balance when it is lower than the cap", () => {
    expect(holdLimitOf(26653, 10_000)).toEqual({ kind: "balance", reserve_points: 26653, limit_points: 10_000 });
    expect(holdLimitOf(26653, null)).toEqual({ kind: "cap", reserve_points: 26653, limit_points: AGENT_JOB_POINTS_CAP });
    expect(holdLimitOf(20_000, 30_000)).toBeNull();
    expect(holdLimitOf(20_000, 15_000)).toEqual({ kind: "balance", reserve_points: 20_000, limit_points: 15_000 });
    const s = smallerVersionOf(plan, 10_000)!;
    expect(s.plan.price.reservePoints).toBeLessThanOrEqual(10_000);
    expect(s.per_post).toBeLessThan(smallerVersionOf(plan, AGENT_JOB_POINTS_CAP)!.per_post);
  });
  it("when even one comment per post does not fit, there is no smaller version (null), and the card offers only the change and the cancel", () => {
    expect(smallerVersionOf(plan, 5)).toBeNull();
  });

  const row = (publicPlan: unknown): MissionRowForCustomer => ({ id: "msn_x", status: "plan_ready", question_ar: null, plan_public: publicPlan, reserved_points: 26653, unit_price_points: 4.750125, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-03T13:34:21Z" });
  const html = (publicPlan: unknown, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AgentMissionCardBody, { view: customerMissionView({ mission: row(publicPlan), events: [] }), isGuest: false, ...extra }));

  it("the card of the live plan: NO approve button; a plain sentence that the plan is above the limit; the smaller version, the change and the cancel by code", () => {
    const out = html(pub);
    expect(out).not.toContain('data-testid="agent-approve"');
    expect(out).toContain('data-testid="agent-over-limit"');
    expect(out).toMatch(/أكبر من الحد المسموح/);
    expect(out).toContain('data-testid="agent-smaller"');
    expect(out).toContain('data-testid="agent-edit"');
    expect(out).toContain('data-testid="agent-cancel"');
    const s = smallerVersionOf(plan, AGENT_JOB_POINTS_CAP)!;
    expect(out).toContain(`${formatAr(s.per_post)} تعليق`);
  });
  it("the over-limit text rows add up: posts, comments, counted replies, replies not counted yet", () => {
    const out = html(pub);
    expect(out).toContain("٣ منشورات");
    expect(out).toMatch(/١٬٨٩٦ تعليقًا|١٨٩٦ تعليقًا/);
    expect(out).toContain("٢٬٩٥٨");
  });
  it("a plan within the limit keeps its approve button (nothing else changed)", () => {
    const s = smallerVersionOf(plan, AGENT_JOB_POINTS_CAP)!;
    const out = html(publicPlanOf(s.plan));
    expect(out).toContain('data-testid="agent-approve"');
    expect(out).not.toContain('data-testid="agent-over-limit"');
  });
  it("the balance on the card: a customer whose balance is below the hold sees no approve button either, with the balance named", () => {
    const s = smallerVersionOf(plan, AGENT_JOB_POINTS_CAP)!;
    const out = html(publicPlanOf(s.plan), { balancePoints: 1000 });
    expect(out).not.toContain('data-testid="agent-approve"');
    expect(out).toContain('data-testid="agent-over-limit"');
    expect(out).toMatch(/رصيدك/);
    expect(html(publicPlanOf(s.plan), { balancePoints: 100_000 })).toContain('data-testid="agent-approve"');
    expect(html(publicPlanOf(s.plan), { balancePoints: null })).toContain('data-testid="agent-approve"');
  });
  it("the plans of the old path (not compiled) and of TikTok and X are not touched: no limit is added to their public plan", () => {
    const old = { ...plan, compiled: undefined } as unknown as PricedPlan;
    expect((publicPlanOf(old) as Record<string, unknown>).limit).toBeUndefined();
    const tiktok = { ...plan, compiled: { ...plan.compiled!, platform: "tiktok" } } as PricedPlan;
    expect((publicPlanOf(tiktok) as Record<string, unknown>).limit).toBeUndefined();
    expect(JSON.stringify(publicPlanOf(tiktok))).toBe(JSON.stringify(customerPlanView(tiktok)));
  });
});

describe("the customer's action «نسخة أصغر» is applied by code on the stored plan, and only while the plan waits", () => {
  const dbWith = (patch: Record<string, unknown> = {}, p: PricedPlan = plan) => {
    const db = createMemoryDb();
    db.seed("missions", [{ id: "msn_small1", user_id: REPLAY_USER, status: "plan_ready", request_text: FB_REQUEST, plan: p, plan_public: publicPlanOf(p), reserved_points: p.price.reservePoints, unit_price_points: p.price.unitPricePoints, ...patch }]);
    db.seed("mission_events", []);
    return { db, client: { from: (t: string) => db.from(t) } as never };
  };
  it("stores the smaller plan with its own card view and price; the mission stays «plan_ready»; a plan event with no digit is written; the new card is within the limit", async () => {
    const { db, client } = dbWith();
    const r = await smallerVersionForCustomer(client, { id: "msn_small1", userId: REPLAY_USER });
    expect(r.ok).toBe(true);
    const row = db.rows("missions")[0];
    expect(row.status).toBe("plan_ready");
    expect((row.plan as PricedPlan).price.reservePoints).toBeLessThanOrEqual(AGENT_JOB_POINTS_CAP);
    expect(row.reserved_points).toBe((row.plan as PricedPlan).price.reservePoints);
    expect((row.plan_public as Record<string, any>).limit).toMatchObject({ over: false });
    expect(repriceStoredPlan(row.plan as PricedPlan).reservePoints).toBe(row.reserved_points);
    expect(db.rows("mission_events").find((e) => e.kind === "plan")!.message_ar).not.toMatch(/[0-9]/);
  });
  it("sized to a lower hold the customer's balance gives (never above the cap; the server recomputes, the client only names its balance)", async () => {
    const { db, client } = dbWith();
    const r = await smallerVersionForCustomer(client, { id: "msn_small1", userId: REPLAY_USER, maxHoldPoints: 10_000 });
    expect(r.ok).toBe(true);
    expect((db.rows("missions")[0].plan as PricedPlan).price.reservePoints).toBeLessThanOrEqual(10_000);
    const big = dbWith();
    const r2 = await smallerVersionForCustomer(big.client, { id: "msn_small1", userId: REPLAY_USER, maxHoldPoints: 10_000_000 });
    expect(r2.ok).toBe(true);
    expect((big.db.rows("missions")[0].plan as PricedPlan).price.reservePoints).toBeLessThanOrEqual(AGENT_JOB_POINTS_CAP);
  });
  it("refused: somebody else's mission (not found), a mission already approved, a plan with no smaller version (nothing changes)", async () => {
    expect(await smallerVersionForCustomer(dbWith().client, { id: "msn_small1", userId: "someone-else" })).toMatchObject({ ok: false, status: 404 });
    const approved = dbWith({ status: "approved" });
    expect(await smallerVersionForCustomer(approved.client, { id: "msn_small1", userId: REPLAY_USER })).toMatchObject({ ok: false, status: 409 });
    const none = dbWith();
    expect(await smallerVersionForCustomer(none.client, { id: "msn_small1", userId: REPLAY_USER, maxHoldPoints: 5 })).toMatchObject({ ok: false, status: 400 });
    expect((none.db.rows("missions")[0].plan as PricedPlan).price.reservePoints).toBe(26653);
  });
});

describe("the Ask that the three live Facebook words describe is the one the compiler read (guard for the helper itself)", () => {
  it("3 posts, a topic, a named page, comments and replies", () => {
    const ask = buildAsk(FB_REQUEST, null, Date.parse("2026-11-03T13:32:00Z"));
    expect(ask.count).toBe(3);
    expect(ask.topic.text).toBe("الذكاء الاصطناعي");
    expect(ask.source.kind).toBe("named");
  });
});
