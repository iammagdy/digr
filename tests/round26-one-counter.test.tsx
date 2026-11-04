import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { customerMissionView, type EventForCustomer, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { MissionStepRow } from "../src/components/mission/MissionPlanPanel";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";

/**
 * ROUND 26, item 6: ONE counter and ONE bar on the running card (the top box). The steps panel shows steps with their state only: no count, no second bar,
 * no internal source line («وُجد ١٠ تغريدات في صفحة واحدة من المصدر»). The top sentence follows the state: «نجمع التغريدات (٣ من ١٠)» while collecting,
 * «جمعنا التغريدات، ونجهّز ملفك الآن» once the count is reached; never «بدأنا جمع ... نحو دقيقتين» after collection ended.
 */
const NOW = Date.parse("2026-11-04T12:23:00.000Z");
const plan = {
  summary_ar: "١٠ تغريدات من إكس عن «الذكاء الاصطناعي».",
  stages: [{ key: "s1", title_ar: "التغريدات", expected_rows: 10, deliver: true, columns: [{ key: "text", title_ar: "نص التغريدة" }], sample_rows: [{ text: "مثال" }] }],
  price: { max_charge_points: 200, reserve_points: 200 },
  expected_minutes: 2,
};
function row(status: string, over: Partial<MissionRowForCustomer> = {}): MissionRowForCustomer {
  return { id: "msn_test", status, question_ar: null, plan_public: plan, reserved_points: 200, unit_price_points: 20, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-04T12:19:32.000Z", ...over };
}
const progress = (saved: number, id: number): EventForCustomer => ({ id, kind: "progress", message_ar: "يحفظ الوكيل ما جمعه", counts: { stage: 1, saved, planned: 10 }, created_at: "2026-11-04T12:23:10.000Z" });

describe("ROUND 26 item 6: the top sentence follows the state", () => {
  it("while collecting: «نجمع التغريدات (٣ من ١٠)»", () => {
    const v = customerMissionView({ mission: row("executing"), events: [progress(3, 1)], callsMade: 4, now: NOW });
    expect(v.collectLineAr).toBe("نجمع التغريدات (٣ من ١٠)");
  });
  it("at the count: «جمعنا التغريدات، ونجهّز ملفك الآن»", () => {
    const v = customerMissionView({ mission: row("executing"), events: [progress(10, 1)], callsMade: 4, now: NOW });
    expect(v.collectLineAr).toBe("جمعنا التغريدات، ونجهّز ملفك الآن");
  });
  it("never «بدأنا جمع» or «نحو دقيقتين» in the collecting line", () => {
    const v = customerMissionView({ mission: row("executing"), events: [progress(10, 1)], callsMade: 4, now: NOW });
    expect(v.collectLineAr ?? "").not.toMatch(/بدأنا جمع|دقيقتين/);
  });
  it("the current line of the panel carries no count (one counter only, in the top box)", () => {
    const v = customerMissionView({ mission: row("executing"), events: [progress(3, 1)], callsMade: 4, now: NOW });
    expect(v.currentLineAr).not.toMatch(/[٠-٩]+ من [٠-٩]+/);
  });
});

describe("ROUND 26 item 6: the steps panel draws steps only", () => {
  const withCounts = { id: "stage-1", titleAr: "التغريدات", state: "running" as const, countAr: "٣ تغريدات من ١٠ تغريدات", savedN: 3, plannedN: 10, ratio: 0.3, metricsAr: ["وُجد ١٠ تغريدات في صفحة واحدة من المصدر"], excludedAr: "استُبعد ٢ لأنه لا يخص طلبك" };
  it("a running step renders its title and no count, bar or source line", () => {
    const html = renderToStaticMarkup(<MissionStepRow step={withCounts} />);
    expect(html).toContain("التغريدات");
    expect(html).not.toContain("من ١٠");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("وُجد");
    expect(html).not.toContain("استُبعد");
  });
  it("the whole card shows ONE progress bar", () => {
    const v = customerMissionView({ mission: row("executing"), events: [progress(3, 1)], callsMade: 4, now: NOW });
    const html = renderToStaticMarkup(<AgentMissionCardBody view={v} isGuest={false} />);
    expect((html.match(/role="progressbar"/g) ?? []).length).toBe(1);
    expect(html).not.toContain("وصلنا");
    expect(html).toContain("نجمع التغريدات (٣ من ١٠)");
  });
});
