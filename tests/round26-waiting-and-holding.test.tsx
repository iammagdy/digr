import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { customerMissionView, type EventForCustomer, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { cardPollDelayMs, CARD_FAST_AFTER_ACTION_MS, workerPollDelayMs, WORKER_BUSY_POLL_MS, WORKER_IDLE_POLL_MS, WORKER_BUSY_WINDOW_MS, holdingLineAr, HOLDING_STILL_AR } from "../src/lib/agentMission/pollDelay";

/**
 * ROUND 26, items 1 and 2.
 * 1. Waiting time: the page asks every 2 to 3 seconds for the first minutes after a customer action or while a mission waits (then slower); the worker takes a mission
 *    quickly after it was queued (a shorter poll right after work arrived; the idle poll is unchanged).
 * 2. Loading and holding: a tapped choice shows its own «جارٍ الإرسال…» and cannot be sent twice; while a mission waits or works the card says what is happening
 *    (the live step) and how long since the last change («منذ ٢٠ ثانية»); after 60 seconds with no change one honest line that we are still working.
 */
const NOW = Date.parse("2026-11-04T12:25:00.000Z");
const row = (status: string, plan_public: any = null): MissionRowForCustomer => ({ id: "msn_w", status, question_ar: null, plan_public, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-04T12:19:32.000Z" });
const ev = (id: number, kind: string, counts: Record<string, number> | null, message_ar = "نص"): EventForCustomer => ({ id, kind, message_ar, counts, created_at: "2026-11-04T12:24:40.000Z" });

describe("ROUND 26 item 1: the page asks fast while the customer waits", () => {
  it("a live mission (waiting, planning, running) is asked every 2 to 3 seconds", () => {
    expect(cardPollDelayMs({ live: true, fastUntil: 0, now: NOW, hidden: false })).toBeLessThanOrEqual(3000);
  });
  it("a question or a plan right after the customer's own tap is asked fast for a few minutes", () => {
    const tapAt = NOW - 10_000;
    expect(cardPollDelayMs({ live: false, fastUntil: tapAt + CARD_FAST_AFTER_ACTION_MS, now: NOW, hidden: false })).toBeLessThanOrEqual(3000);
  });
  it("a question or a plan long after the last tap is asked slowly again", () => {
    expect(cardPollDelayMs({ live: false, fastUntil: NOW - 1, now: NOW, hidden: false })).toBeGreaterThanOrEqual(7000);
  });
  it("a hidden tab is asked slowly even when live", () => {
    expect(cardPollDelayMs({ live: true, fastUntil: 0, now: NOW, hidden: true })).toBeGreaterThanOrEqual(10_000);
  });
});

describe("ROUND 26 item 1: the worker takes a queued mission quickly", () => {
  it("right after it took work the worker polls every 2 seconds; when idle, the usual 5 seconds", () => {
    expect(workerPollDelayMs({ lastTakeAt: NOW - 5_000, now: NOW })).toBe(WORKER_BUSY_POLL_MS);
    expect(WORKER_BUSY_POLL_MS).toBeLessThanOrEqual(2000);
    expect(workerPollDelayMs({ lastTakeAt: null, now: NOW })).toBe(WORKER_IDLE_POLL_MS);
    expect(workerPollDelayMs({ lastTakeAt: NOW - WORKER_BUSY_WINDOW_MS - 1, now: NOW })).toBe(WORKER_IDLE_POLL_MS);
  });
});

describe("ROUND 26 item 2: the holding line", () => {
  it("shows the live step and the time since the last change, in Arabic digits", () => {
    expect(holdingLineAr("نقرأ عينة من المصدر", 20_000)).toBe("نقرأ عينة من المصدر · منذ ٢٠ ثانية");
    expect(holdingLineAr("نجهّز السعر", 125_000)).toContain("نجهّز السعر · منذ دقيقتين");
  });
  it("after 60 seconds with no change: one honest line, that we are still working and nothing is charged", () => {
    expect(holdingLineAr("نجهّز السعر", 60_000)).toContain(HOLDING_STILL_AR);
    expect(HOLDING_STILL_AR).toContain("ما زلنا نعمل على طلبك");
    expect(HOLDING_STILL_AR).toContain("لم يُخصم");
  });
  it("the view carries the time of the last event, so the card can tell when something last changed", () => {
    const v = customerMissionView({ mission: row("queued", { question_options: ["١٠"] }), events: [ev(1, "answer", null)], now: NOW });
    expect(v.lastEventAt).toBe(Date.parse("2026-11-04T12:24:40.000Z"));
  });
  it("the card draws the holding line while the mission waits, with the quiet time it is given", () => {
    const v = customerMissionView({ mission: row("planning"), events: [ev(1, "call", { compiled: 1 }, "قياس داخلي")], callsMade: 1, now: NOW });
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: v, isGuest: false, quietSinceMs: NOW - 20_000, nowMs: NOW }));
    expect(html).toContain('data-testid="agent-holding"');
    expect(html).toContain("منذ ٢٠ ثانية");
  });
  it("after a minute of silence the card says the honest line", () => {
    const v = customerMissionView({ mission: row("planning"), events: [ev(1, "call", { compiled: 1 }, "قياس داخلي")], callsMade: 1, now: NOW });
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: v, isGuest: false, quietSinceMs: NOW - 70_000, nowMs: NOW }));
    expect(html).toContain("ما زلنا نعمل على طلبك");
  });
});

describe("ROUND 26 item 2: a tap never looks ignored and cannot be sent twice", () => {
  const question = customerMissionView({ mission: { ...row("needs_input"), question_ar: "تحب كام تغريدة؟" }, events: [], now: NOW, callsMade: 0 });
  it("while the answer is on its way the tapped choice says «جارٍ الإرسال…» and every choice is disabled", () => {
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: { ...question, phase: "question", questionOptionsAr: ["١٠", "٥٠"] } as any, isGuest: false, busy: true, pendingAction: "answer", pendingText: "١٠" }));
    expect(html).toContain("جارٍ الإرسال");
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("the choices are plain buttons again when nothing is on its way", () => {
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: { ...question, phase: "question", questionOptionsAr: ["١٠", "٥٠"] } as any, isGuest: false }));
    expect(html).not.toContain("جارٍ الإرسال");
  });
});
