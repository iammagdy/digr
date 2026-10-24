import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { PLAN_READY_DESKTOP_AR, PLAN_READY_MOBILE_AR } from "../src/lib/consultantCopy";

/**
 * The plan lives in the results panel, never in the chat stream. The chat says one sentence; the panel carries the plan,
 * its editable fields, the price, and the approve button (a bottom sheet on mobile). Every approval guard stays.
 */
const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
const acceptQuote = readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8");

const noop = () => {};
const quote = (extra: Partial<PlanQuoteData> = {}): PlanQuoteData => ({
  quoteId: "q1",
  summaryAr: "جمع تغريدات عن كرة السلة",
  items: [{ capabilitySlug: "social-x-posts", params: { query: "كرة السلة", dateFrom: "2025-01-01", dateTo: "2025-12-31" }, targetVolumeMin: 1, targetVolumeMax: 10 }],
  targetVolumeMax: 10,
  unitPricePoints: 5,
  expectedPoints: 50,
  quotedPoints: 58,
  isAffordable: true,
  userBalance: 500,
  outputFormats: ["xlsx"],
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  status: "quoted",
  ...extra,
});

const render = (q: PlanQuoteData, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PlanQuoteCard, {
    quote: q, onStart: noop, onSaveEdit: async () => {}, isStarting: false, available: 500, creditValue: 0.1, onTopupShort: noop, onRefresh: async () => {}, ...props,
  } as any));

describe("the chat stream", () => {
  it("shows one short sentence for a plan and no plan card", () => {
    // the panel is the second column of an RTL page, so it is on the left; on a phone it is a bottom sheet
    expect(PLAN_READY_DESKTOP_AR).toBe("جهزت لك الخطة، راجعها على اليسار.");
    expect(PLAN_READY_MOBILE_AR).toBe("جهزت لك الخطة، راجعها في النافذة التي ظهرت من الأسفل.");
    const renderNote = page.slice(page.indexOf("const renderNote"), page.indexOf("const runNode") > 0 ? page.indexOf("const latestPlanQuote") : undefined);
    expect(renderNote).toContain("{m.planQuote");
    expect(renderNote).toContain('<span className="lg:hidden">{PLAN_READY_MOBILE_AR}</span><span className="hidden lg:inline">{PLAN_READY_DESKTOP_AR}</span>');
    expect(renderNote).toContain(": customerFacingAssistantCopy(m.content)}");
    expect(renderNote).not.toContain("<PlanQuoteCard");
    expect(renderNote).toContain('data-testid="open-plan-btn"');
  });

  it("the plan card is mounted only inside the panel (planCard builder), once for editing and once read-only", () => {
    expect((page.match(/<PlanQuoteCard/g) || []).length).toBe(1);
    expect(page).toContain("planCard(latestPlanQuote, false)");
    expect(page).toContain("planNode={latestPlanQuote ? planCard(latestPlanQuote, true) : undefined}");
  });
});

describe("the panel", () => {
  it("shows the plan until a run is approved, then the results with the plan as a read-only tab", () => {
    // Same two conditions as before (no open request, or the plan of the rest of a request), now with one more: a plan that can still be
    // approved takes the panel when the open request is finished or failed (tests/plan-card-states.test.tsx pins every case).
    expect(page).toContain("const panelShowsPlan = shouldShowPlanPanel({");
    expect(page).toContain("latestQuote: latestPlanQuote ? { quoteId: latestPlanQuote.quoteId, status: latestPlanQuote.status, expiresAt: latestPlanQuote.expiresAt } : null,");
    expect(page).toContain("activeJob: activeJob ? { jobId: activeJob.jobId, status: activeJob.status } : null,");
    expect(page).toContain("restPlanQuoteId,");
    expect(page).toContain('data-testid="plan-panel"');
    expect(canvas).toContain('{ id: "plan" as const, label: "الخطة" }');
    expect(canvas).toContain('{tab === "plan" && planNode}');
  });

  it("is the same bottom sheet on mobile and the side column on desktop (existing tokens)", () => {
    expect(page).toContain("fixed inset-x-0 bottom-0 z-50 flex h-[85dvh]");
    expect(page).toContain("lg:static");
    expect(page).toContain("lg:w-[460px]");
  });

  it("opens by itself for a new plan, and for a plan already in a restored conversation only while that plan still waits for approval (audit point 19)", () => {
    expect(page).toContain("announcedPlanId");
    const effect = page.slice(page.indexOf("const announcedPlanId"), page.indexOf("// Sync canvasOpen and activeJob"));
    expect(effect).toContain("announcedPlanId.current = latestPlanId;");
    expect(effect).toContain("if (latestPlanId && latestPlanId !== announcedPlanId.current && !activeJob) setCanvasOpen(true);");
    expect(effect).toContain("conversationLoading");
  });
});

describe("the plan in the panel keeps every guard", () => {
  it("an incomplete plan, an expired quote and an inactive quote cannot be approved (client)", () => {
    expect(card).toContain("isQuotePlanComplete(quote.items) && quoteScopeGaps(quote.items).length === 0");
    expect(card).toContain("baseApprovalState.canApprove && planComplete");
    expect(card).toContain("approvalState.canApprove");
    const html = render(quote({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(html).not.toContain("أوافق وابدأ البحث");
    expect(html).toContain("تحديث السعر");
    const inactive = render(quote({ status: "superseded" }));
    expect(inactive).not.toContain("أوافق وابدأ البحث");
    const incomplete = render(quote({ items: [{ capabilitySlug: "social-x-posts", params: {}, targetVolumeMin: 1, targetVolumeMax: 10 }] }));
    expect(incomplete).not.toContain("أوافق وابدأ البحث");
  });

  it("a complete, valid, affordable plan offers the approve button", () => {
    expect(render(quote())).toContain("أوافق وابدأ البحث");
  });

  it("the server still refuses what the client refuses (accept-quote guards)", () => {
    for (const guard of ["expectedPlanHash", "hasExplicitQuoteApproval(body)"]) expect(acceptQuote).toContain(guard);
  });

  it("a locked (approved) plan shows no approve button", () => {
    expect(render(quote(), { locked: true })).not.toContain("أوافق وابدأ البحث");
  });
});

describe("the plan shows what was understood and the period", () => {
  it("renders the understanding sentence and a window with its reason and any corrected date", () => {
    const html = render(quote({
      understoodAr: "فهمت أنك تريد تعليقات عن «كرة السلة» على يوتيوب.",
      window: { labelAr: "من ١١ يونيو ٢٠٢٦ إلى ١٩ يوليو ٢٠٢٦", source: "event", reasonAr: "كأس العالم ٢٠٢٦ جرت من ١١ يونيو ٢٠٢٦ إلى ١٩ يوليو ٢٠٢٦، فاقترحت هذه الفترة وتقدر تعدّلها في الخطة.", noteAr: "شهر سبتمبر ٢٠٢٦ ليس فيه يوم ٣١، فاعتمدت ٣٠ سبتمبر آخر يوم في الشهر." },
    }));
    expect(html).toContain('data-testid="plan-understood"');
    expect(html).toContain("فهمت أنك تريد تعليقات");
    expect(html).toContain('data-testid="plan-window"');
    expect(html).toContain("الفترة الزمنية");
    expect(html).toContain("تقدر تعدّلها في الخطة");
    expect(html).toContain("آخر يوم في الشهر");
  });

  it("a plan without a window shows no window row", () => {
    expect(render(quote())).not.toContain('data-testid="plan-window"');
  });
});
