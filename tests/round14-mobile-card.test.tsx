import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * ROUND 14, item 5: THE PLAN CARD AT 390 px. Live: the replies step line («١٧ ردًا بحسب عدّادات التعليقات التي قرأناها، وحتى ٥٦٩ ردًا لتعليقات لم نقرأ عدادها بعد») ran off the right edge with its label broken letter by letter, and the sample table's header «عدد الردود» was cut.
 * Cause (the markup): the value of a step was `shrink-0` beside a label that took the rest, so a long value kept its whole width and squeezed the label to nothing. Now the label and the value stack on a narrow screen (side by side from 640 px) and both wrap inside the card.
 * A browser layout cannot run in this suite; the markup contract is tested here, and the same markup was measured in Chromium at 390 px (see HANDOFF, round 14).
 */
const LONG = "١٧ ردًا بحسب عدّادات التعليقات التي قرأناها، وحتى ٥٦٩ ردًا لتعليقات لم نقرأ عدادها بعد";
const base = customerMissionView({
  mission: { id: "m", status: "plan_ready", question_ar: null, reserved_points: 5749, unit_price_points: 4.5, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-03T15:39:39Z",
    plan_public: { summary_ar: "٣ منشور من فيسبوك عن «الذكاء الاصطناعي»، مع كل تعليقاتها وردودها.", assumptions_ar: [], notes_ar: [],
      stages: [
        { key: "posts", title_ar: "المنشورات", endpoint_id: "e", expected_rows: 3, planned_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }], sample_rows: [] },
        { key: "comments", title_ar: "التعليقات", endpoint_id: "e", expected_rows: 517, planned_rows: 517, parent_key: "posts", deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "replies_count", title_ar: "عدد الردود" }, { key: "likes", title_ar: "الإعجابات" }], sample_rows: [{ text: "تعليق", replies_count: 1, likes: 2 }] },
        { key: "comments_replies", title_ar: "الردود", endpoint_id: "e", expected_rows: 17, planned_rows: 586, parent_key: "comments", deliver: true, columns: [{ key: "text", title_ar: "نص الرد" }], sample_rows: [] },
      ], price: { max_charge_points: 4999, reserve_points: 5749 } } } as never,
  events: [], queue: { ahead: 0, running: 0, workerAlive: true }, now: Date.parse("2026-11-03T15:42:00Z"),
});
const view = { ...base, stages: base.stages.map((s) => (s.n === 3 ? { ...s, rowsAr: LONG } : s)) };
const markup = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
const li = (n: number) => new RegExp(`<li[^>]*data-testid="agent-stage-${n}"[\\s\\S]*?</li>`).exec(markup)![0];

describe("the plan card's step lines wrap inside the card", () => {
  it("the long replies value is in the card, whole", () => { expect(markup).toContain(LONG); });
  it("label and value stack on a narrow screen (flex-col) and sit side by side only from 640 px (sm:flex-row)", () => {
    const body = /data-testid="agent-stage-body-3"/.exec(li(3));
    expect(body).not.toBeNull();
    expect(li(3)).toMatch(/class="[^"]*\bflex-col\b[^"]*\bsm:flex-row\b[^"]*"[^>]*data-testid="agent-stage-body-3"|class="[^"]*\bsm:flex-row\b[^"]*\bflex-col\b[^"]*"[^>]*data-testid="agent-stage-body-3"/);
  });
  it("neither the label nor the value is `shrink-0` (the live defect), both may shrink and break words", () => {
    const row = li(3);
    const valueSpan = /<span[^>]*data-testid="agent-stage-rows-3"[^>]*>/.exec(row)![0];
    expect(valueSpan).not.toContain("shrink-0");
    expect(valueSpan).toContain("min-w-0");
    expect(valueSpan).toContain("break-words");
    const labelSpan = /<span class="[^"]*">المنشورات|<span class="[^"]*">الردود/.exec(row)![0];
    expect(labelSpan).toContain("min-w-0");
    expect(labelSpan).toContain("break-words");
  });
  it("the list item itself cannot widen the card (min-w-0) and the card keeps its own width limits", () => {
    expect(li(1)).toMatch(/<li class="[^"]*\bmin-w-0\b/);
    expect(markup).toMatch(/data-testid="agent-card"[^>]*class="[^"]*\bmin-w-0\b[^"]*\bmax-w-\[640px\]|data-testid="agent-card"[^>]*class="[^"]*\bmax-w-\[640px\][^"]*\bmin-w-0\b/);
  });
  it("the sample table's headers wrap (nothing is cut), each with a minimum width, inside its own scrolling box", () => {
    const head = /<thead>[\s\S]*?<\/thead>/.exec(markup)![0];
    const ths = head.match(/<th(?=[\s>])[^>]*>/g)!;
    expect(ths.length).toBeGreaterThan(1);
    for (const th of ths) { expect(th).toContain("whitespace-normal"); expect(th).toContain("min-w-[88px]"); }
    expect(head).toContain("عدد الردود");
    expect(markup).toContain('data-testid="agent-samples-scroll"');
  });
  it("the customer sentences pass checkCustomerText (Arabic, no provider, no price in dollars)", () => {
    expect(checkCustomerText(LONG, { maxChars: 400 }).issues).toEqual([]);
  });
});
