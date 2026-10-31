import { describe, expect, it } from "vitest";
import { replay } from "./helpers/agentReplay";
import { page as xPage, pad, PER_PAGE, planning as xPlanning } from "./helpers/engineXScenario";
import { tregResult } from "./helpers/agentFakeWorld";
import { zeroDeliveryReasonAr } from "../agent/src/finalize";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { buildMissionNotice } from "../src/lib/agentMission/notices";

/**
 * LIVE RETEST 2026-10-31 16:35 (B3, Instagram posts of a known Egyptian brand): 12 posts read, all 12 left out (7 «from another account», 5 «not in the plan's language»), 0 of 5 delivered, and the customer read only «لم يُسلَّم أي شيء، ولم يُخصم منك شيء.».
 * B2 (Facebook) had a reason only because the MODEL wrote a closing note; a mission the engine carried out with no model note has none, so the reason must come from the RECORDED counts (never from the model, never a guess).
 */
describe("zeroDeliveryReasonAr: why nothing was delivered, from the recorded counts", () => {
  const text = (o: Parameters<typeof zeroDeliveryReasonAr>[0]) => zeroDeliveryReasonAr(o);
  it("B3: seven from another account and five in another language", () => {
    const s = text({ found: 12, excludedByReason: { filter_account: 7, filter_language: 5 }, pending: 0, reviewStop: null });
    expect(s).toContain("حسابات");
    expect(s).toContain("لغة");
    expect(s).toContain("لم يُسلَّم أي شيء، ولم يُخصم منك شيء");
    expect(s).toMatch(/عدّل|تعديل/);
  });
  it("the biggest reason first, at most three, each said once", () => {
    const s = text({ found: 40, excludedByReason: { filter_language: 5, filter_account: 20, filter_period: 10, filter_reply: 3, filter_repost: 2 }, pending: 0, reviewStop: null });
    expect(s.indexOf("حسابات")).toBeLessThan(s.indexOf("الفترة"));
    expect(s.indexOf("الفترة")).toBeLessThan(s.indexOf("لغة"));
    expect(s).not.toContain("ردود");
    expect(s).not.toContain("إعادة نشر");
  });
  it("relevance reasons are one idea: what was found does not match what was asked", () => {
    const s = text({ found: 50, excludedByReason: { no_term: 30, review_no: 15, uncertain: 5 }, pending: 0, reviewStop: null });
    expect(s).toContain("لا يطابق");
    expect(s.match(/لا يطابق/g)).toHaveLength(1);
  });
  it("people who were only mailboxes", () => {
    expect(text({ found: 9, excludedByReason: { not_a_person: 9 }, pending: 0, reviewStop: null })).toContain("عناوين عامة");
  });
  it("the source gave nothing at all", () => {
    const s = text({ found: 0, excludedByReason: {}, pending: 0, reviewStop: null });
    expect(s).toContain("لم يعطِ المصدر أي نتائج");
    expect(s).toContain("لم يُخصم منك شيء");
  });
  it("items still waiting for a review that ran out say that, not «nothing matched»", () => {
    expect(text({ found: 50, excludedByReason: {}, pending: 10, reviewStop: "budget" })).toContain("المراجعة الآلية");
  });
  it("Arabic only, no digit, no provider, no money figure: the same checks every customer sentence passes", () => {
    const cases: Array<Parameters<typeof zeroDeliveryReasonAr>[0]> = [
      { found: 12, excludedByReason: { filter_account: 7, filter_language: 5 }, pending: 0, reviewStop: null },
      { found: 0, excludedByReason: {}, pending: 0, reviewStop: null },
      { found: 9, excludedByReason: { not_a_person: 9, no_verified_contact: 2 }, pending: 0, reviewStop: null },
    ];
    for (const o of cases) {
      const s = text(o);
      expect(checkCustomerText(s, { maxChars: 1100 }).issues, s).toEqual([]);
      expect(s).not.toMatch(/[0-9٠-٩]/);
    }
  });
});

describe("a mission that delivers nothing tells the customer why (replay: every row the source gave is about the weather)", () => {
  const junk = Array.from({ length: 3 }, (_, p) => tregResult({ output: { data: { items: Array.from({ length: PER_PAGE }, (_, i) => ({ id: `99${pad(p * PER_PAGE + i)}`, text: `أخبار الطقس رقم ${p * PER_PAGE + i}`, url: `https://x.example/j/${p}${i}`, author: "u", createdAt: "2026-10-29T10:00:00Z", likeCount: 1, replyCount: 0, retweetCount: 0, isReply: false, isRetweet: false })), next_cursor: p < 2 ? `cur_${(p + 1) * PER_PAGE}` : null } } }, 0.00075));
  async function run() {
    return replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: xPlanning(), execution: () => [], answers: [tregResult(xPage(0, null), 0.00075), ...junk] });
  }
  it("the stored summary and the customer's end line carry the recorded reason; nothing is charged; no number is written in the text", async () => {
    const r = await run();
    expect(r.mission.status).toBe("unserved");
    expect(r.mission.delivered_units).toBe(0);
    expect(r.mission.charged_points).toBe(0);
    expect(r.mission.summary_ar).toContain("قرأنا ما أعطاه المصدر");
    expect(r.mission.summary_ar).toContain("لا يطابق");
    expect(r.mission.summary_ar).toContain("لم يُسلَّم أي شيء، ولم يُخصم منك شيء");
    expect(r.mission.summary_ar).not.toMatch(/[0-9٠-٩]/);
    expect(r.finalView.endLineAr).toContain("لا يطابق");
  });
  it("the notice says a search found nothing that matches (not «no source serves this»: the sources WERE read)", async () => {
    const r = await run();
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0].kind).toBe("unserved");
    expect(r.notices[0].facts.cause).toBe("empty");
    const n = buildMissionNotice("unserved", r.notices[0].facts, "تغريدات عن محمد صلاح");
    expect(n.body).toContain("لم نجد");
    expect(n.body).not.toContain("لا يوجد بين مصادرنا");
  });
});
