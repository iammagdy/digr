import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { requestPartsAr } from "../agent/src/llmPlanner/planner";

/**
 * CARD REDESIGN, PHASE 2 (16 Nov 2026): the request line, the newest rows while running, the retry buttons of the endings, the phone's sticky action bar, and the plan's request parts read from the
 * understanding. Display only: no money, no rows, no file.
 */
const T0 = Date.parse("2026-11-16T10:00:00Z");
const row = (status: string) => ({ id: "m1", status, question_ar: null, plan_public: null, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-16T09:59:00Z" }) as never;
const base = customerMissionView({ mission: row("planning"), events: [], queue: { ahead: 0, running: 0, workerAlive: true }, now: T0 });
const card = (over: Record<string, unknown>, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AgentMissionCardBody, { view: { ...base, ...over } as never, isGuest: false, ...props } as never));
const text = (m: string) => m.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the request line", () => {
  it("says the count with the platform, the topic and the period, the same in every state that has them", () => {
    const m = card({ phase: "plan", totalRowsAr: "٣٠ تغريدة", totalRows: 30, requestPartsAr: ["إكس", "لقاح الإنفلونزا", "١٦ أكتوبر – ١٦ نوفمبر ٢٠٢٦"] });
    expect(m).toContain('data-testid="agent-request-line"');
    expect(text(m)).toContain("طلبك: ٣٠ تغريدة · إكس · لقاح الإنفلونزا · ١٦ أكتوبر – ١٦ نوفمبر ٢٠٢٦");
  });
  it("is not drawn when the plan has no parts, and not on the question or the cancelled card", () => {
    expect(card({ phase: "plan", requestPartsAr: [] })).not.toContain("agent-request-line");
    expect(card({ phase: "cancelled", requestPartsAr: ["إكس"] })).not.toContain("agent-request-line");
  });
  // DT-20261118-09 S2: the platform is named in the card only when the customer wrote it
  const SAID = ["٣٠ تغريدة على إكس عن لقاح الإنفلونزا"];
  it("the planner reads the parts from the understanding: platform, topic, period in Arabic digits; a step per parent adds nothing", () => {
    const step = (over: Record<string, unknown>) => ({ key: "t", title_ar: "التغريدات", platform: "x", capability: "x.search.posts", parent: null, deliver: true, count: { total: 30, per_parent: null, all: false }, source: null, topic: "لقاح الإنفلونزا", search_terms: [], period: { from: "2026-10-16", to: "2026-11-16" }, ...over }) as never;
    expect(requestPartsAr([step({})], SAID)).toEqual(["إكس", "لقاح الإنفلونزا", "١٦ أكتوبر – ١٦ نوفمبر ٢٠٢٦"]);
    expect(requestPartsAr([step({ topic: null, period: null })], SAID)).toEqual(["إكس"]);
    expect(requestPartsAr([], SAID)).toEqual([]);
  });
});

describe("the endings offer to start again from the same words", () => {
  const retry = () => undefined;
  it("failed: the primary button and the support link; partial: a text button; cancelled: «ابدأها من جديد»", () => {
    expect(text(card({ phase: "failed", live: false, endLineAr: "لم نجد", resultLinesAr: [] }, { onRetry: retry }))).toContain("عدّل الطلب وجرّب تاني");
    expect(card({ phase: "failed", live: false, resultLinesAr: [] }, { onRetry: retry })).toContain('href="/contact"');
    expect(card({ phase: "partial", live: false, resultLinesAr: ["تم تسليم ١٨ من ٣٠ تغريدة."] }, { onRetry: retry })).toContain('data-testid="agent-retry-partial"');
    expect(card({ phase: "cancelled", live: false }, { onRetry: retry })).toContain("ابدأها من جديد");
  });
  it("without the customer's words there is nothing to start from, so no button", () => {
    expect(card({ phase: "failed", live: false, resultLinesAr: [] })).not.toContain("agent-retry");
    expect(card({ phase: "cancelled", live: false })).not.toContain("ابدأها من جديد");
  });
});

describe("the newest rows while running", () => {
  const live = (promised: number | null) => ({ changed: true, cursor: "c", status: "running", delivered: 2, promised, counterAr: "", workLog: [], retryAfterMs: 1000, truncated: false, sheets: [{ stageKey: "a", nameAr: "x", headers: ["النص", "الحساب"], total: 2 }], window: { stageKey: "a", offset: 0, rows: [{ id: "1", parentId: null, cells: [{ k: "text", v: "تغريدة قديمة عن اللقاح" }, { k: "text", v: "old_user" }] }, { id: "2", parentId: null, cells: [{ k: "text", v: "تغريدة أحدث عن اللقاح" }, { k: "text", v: "new_user" }] }] } }) as never;
  const running = { phase: "running", live: true, savedSoFar: 2, totalRows: 30, totalRowsAr: "٣٠ تغريدة", collectLineAr: "نجمع التغريدات", summaryAr: "ملخص" };
  it("shows at most two real rows, the newest first, one line each, with the account", () => {
    const m = card(running, { live: live(30) });
    expect(m).toContain('data-testid="agent-snippets"');
    expect(m.indexOf("تغريدة أحدث")).toBeLessThan(m.indexOf("تغريدة قديمة"));
    expect(m).toContain("@new_user");
  });
  it("shows none while the promised total is unknown (the card is then exactly today's)", () => {
    expect(card(running, { live: live(null) })).not.toContain("agent-snippets");
    expect(card(running)).not.toContain("agent-snippets");
  });
});

describe("the plan's action bar on a phone", () => {
  it("the approve and edit buttons stick to the bottom of the card on a phone and sit in a row from 640 px", () => {
    const m = card({ phase: "plan", live: false, summaryAr: "٣٠ تغريدة", totalRows: 30, totalRowsAr: "٣٠ تغريدة", priceFacts: [{ labelAr: "السعر حتى", valueAr: "٢٠٠ نقطة" }] });
    expect(m).toMatch(/<div class="[^"]*max-sm:sticky[^"]*max-sm:bottom-0[^"]*sm:flex-row[^"]*" data-testid="agent-actions"/);
  });
});
