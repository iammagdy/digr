import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ActivityTerminal from "../src/app/dashboard/chat/components/ActivityTerminal";
import RunningIndicator, { RUNNING_LINE_AR } from "../src/app/dashboard/chat/components/RunningIndicator";
import { summarizeActivityCounts } from "../src/lib/activityCounts";

const PAGE_LINE = "الصفحة ١: استلمنا ٥٠ سجل · الجديد ٣ · الإجمالي ٣ · مكرر أو مستبعد ٧ · قيد المراجعة ٤٠ · الوقت المتوقع بحسب زمن الصفحات المسجل: نحو ٣١ ثانية";
const events = [
  { $id: "1", kind: "progress", textAr: "تم اعتماد الخطة وحجز النقاط بنجاح. جاري بدء معالجة الطلب...", createdAt: "2026-10-23T09:24:43Z" },
  { $id: "2", kind: "progress", textAr: PAGE_LINE, count: 3, createdAt: "2026-10-23T09:25:10Z" },
] as any[];

const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ActivityTerminal as any, { events, rowsCollected: 0, requestedRows: 50, reservedPoints: 183, ...props }));
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const cell = (html: string, id: string) => {
  const start = html.indexOf(`data-testid="${id}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</div>", start));
};

describe("activity panel: the time is its own element", () => {
  const html = render({ status: "running" });

  it("every line has a <time> box, left-to-right isolated, fixed width, in Arabic-Indic digits", () => {
    const times = [...html.matchAll(/<time [^>]*data-testid="activity-time"[^>]*>([^<]*)<\/time>/g)];
    expect(times).toHaveLength(2);
    for (const match of times) {
      expect(match[1]).toMatch(/^[٠-٩]{2}:[٠-٩]{2}:[٠-٩]{2}$/);
      expect(match[0]).toContain('dir="ltr"');
      expect(match[0]).toContain("unicode-bidi:isolate");
      expect(match[0]).toContain("w-[3.6rem]");
      expect(match[0]).toContain("shrink-0");
    }
  });

  it("the time is never glued to the text: they are sibling elements and the text box starts with the words", () => {
    expect(html).not.toMatch(/<\/time>[^<\s]/);
    const lines = [...html.matchAll(/<li [^>]*data-testid="activity-event"[^>]*>(.*?)<\/li>/g)];
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const body = line[1];
      expect(body.indexOf("</time>")).toBeLessThan(body.indexOf('data-testid="activity-text"'));
      expect(body).toMatch(/data-testid="activity-text">[^<]*[؀-ۿ]/);
    }
    expect(textOf(html)).not.toMatch(/[٠-٩]:[٠-٩]{2}[ء-ي]/);
  });
});

describe("activity panel: received, under review, accepted", () => {
  const html = render({ status: "running" });

  it("shows the three clear Arabic labels and no «المقبول الفريد»", () => {
    expect(cell(html, "kpi-received")).toContain("استلمنا");
    expect(cell(html, "kpi-under-review")).toContain("قيد المراجعة");
    expect(cell(html, "kpi-accepted")).toContain("المقبول");
    expect(html).not.toContain("المقبول الفريد");
  });

  it("reads the counts from the page lines in Arabic-Indic digits", () => {
    expect(cell(html, "kpi-received")).toContain(">٥٠<");
    expect(cell(html, "kpi-under-review")).toContain(">٤٠<");
    expect(cell(html, "kpi-accepted")).toContain(">٠<");
    expect(html).toContain("مكرر أو مستبعد ٧");
  });

  it("while the review runs the accepted count is a plain count with a note, never a shortfall like «٠ / ٥٠» or a red value", () => {
    const accepted = cell(html, "kpi-accepted");
    expect(accepted).toContain("بعد انتهاء المراجعة");
    expect(textOf(accepted)).not.toContain("/");
    expect(accepted).not.toMatch(/text-bad|text-red/);
    expect(textOf(html)).not.toMatch(/٠\s*\/\s*٥٠/);
  });

  it("without a review under way the note says how many were asked for", () => {
    const done = render({ status: "done", rowsCollected: 3, chargedPoints: 10, events: [{ ...events[0] }] });
    expect(cell(done, "kpi-accepted")).toContain("من ٥٠ مطلوب");
    expect(cell(done, "kpi-received")).toContain("—");
    expect(cell(done, "kpi-points")).toContain("النقاط المخصومة");
  });

  it("sums several page lines and falls back to a dash when no page line was written", () => {
    expect(summarizeActivityCounts([{ textAr: PAGE_LINE }, { textAr: "الصفحة ٢: استلمنا ١٠ سجل · الجديد ٢ · الإجمالي ٥ · مكرر أو مستبعد ٣ · قيد المراجعة ٥" }])).toEqual({ received: 60, underReview: 45, excluded: 10 });
    expect(summarizeActivityCounts([{ textAr: "تم اعتماد الخطة" }])).toEqual({ received: null, underReview: null, excluded: 0 });
    expect(summarizeActivityCounts([{ textAr: "تم تدقيق السجلات واستبعاد ٤ سجل مكرر." }]).excluded).toBe(4);
    expect(summarizeActivityCounts(undefined)).toEqual({ received: null, underReview: null, excluded: 0 });
  });
});

describe("activity panel: the in-progress sign", () => {
  it("is shown at the bottom of the list while the request runs or waits", () => {
    for (const status of ["running", "queued"]) {
      const html = render({ status });
      expect(html).toContain('data-testid="running-indicator"');
      expect(textOf(html)).toContain("جاري العمل على طلبك");
      expect(html.match(/class="run-dot /g)).toHaveLength(3);
      // after the list, not before it
      expect(html.indexOf('data-testid="running-indicator"')).toBeGreaterThan(html.indexOf('data-testid="activity-events"'));
    }
  });

  it("is gone when the request ends, fails or is cancelled", () => {
    for (const status of ["done", "failed", "cancelled"]) {
      const html = render({ status, rowsCollected: 3 });
      expect(html).not.toContain("running-indicator");
      expect(html).not.toContain("run-dot");
      expect(textOf(html)).not.toContain("جاري العمل على طلبك");
    }
  });

  it("is a status region with the dots hidden from screen readers, and its dots stand still with reduced motion", () => {
    const html = renderToStaticMarkup(createElement(RunningIndicator));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
    expect(RUNNING_LINE_AR).toBe("جاري العمل على طلبك");
    const css = readFileSync("src/app/globals.css", "utf8");
    // the last keyframe is the resting state, and the global reduced-motion rule cuts animations to one instant pass
    expect(css).toMatch(/@keyframes run-dots \{.*100% \{ opacity: 1; transform: none \} \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^]*animation-iteration-count: 1 !important/);
  });
});

describe("the chat column keeps only a short status line", () => {
  const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");

  it("no activity list is rendered in the chat: the old timeline component is gone and only the panel lists events", () => {
    expect(page).not.toContain("ActivityTimeline");
    expect(page).not.toContain("activity-events");
    expect(page).toContain('import RunningIndicator from "./components/RunningIndicator"');
    expect(page).toContain('data-testid="chat-run-status"');
    const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
    expect(canvas).toContain("<ActivityTerminal");
  });

  it("the status line shows the in-progress sign while the job runs, a closing word otherwise, and the panel stays one tap away", () => {
    const start = page.indexOf('data-testid="chat-run-status"');
    const block = page.slice(start, page.indexOf("job-progress", start));
    expect(block).toContain("<RunningIndicator />");
    expect(block).toContain('activeJob.status === "running" || activeJob.status === "queued" ?');
    expect(block).toContain("اكتمل طلبك");
    expect(page).toContain("عرض لوحة النشاط والتنفيذ");
    expect(page).toContain("onClick={() => setCanvasOpen(true)}");
  });
});

describe("customer text rules and compact layout", () => {
  const html = render({ status: "running", rowsCollected: 0 });
  const visible = textOf(html);

  it("Arabic only: no Latin letters or digits, no emoji, no provider names, no USD, no internal ids", () => {
    expect(visible).not.toMatch(/[A-Za-z0-9]/);
    expect(visible).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(visible).not.toMatch(/treg|icypeas|tikhub|crawl4ai|anthropic|claude|usd|\$|job_|quote_/i);
  });

  it("the panel cannot scroll sideways: the root and the list shrink, long words break, the list hides overflow-x", () => {
    expect(html).toMatch(/class="flex h-full w-full min-w-0 flex-col overflow-hidden/);
    expect(html).toContain("overflow-y-auto overflow-x-hidden");
    expect(html).toContain("min-w-0 flex-1 break-words");
  });

  it("compact: small header padding, text-xs list with tight line height, one-row summary of four cells", () => {
    expect(html).toContain("px-3 py-2");
    expect(html).toContain("text-xs leading-5");
    expect(html).toContain("grid-cols-4");
    expect(html).not.toContain("space-y-3");
    expect(html).not.toContain("leading-relaxed");
  });
});
