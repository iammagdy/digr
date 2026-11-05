import { describe, expect, it } from "vitest";
import { QUEUE_REASONS, queueLineAr, queueStateOf } from "../src/lib/agentMission/stage3/queue";
import { EMAIL_WAIT_THRESHOLD_MS, RESEND_MONTHLY_LIMIT, emailDecision, measuredWaitMs, shouldNotifyByEmail, type EmailJobFacts } from "../src/lib/agentMission/stage3/emailTrigger";
import { checkCustomerText } from "../src/lib/agentMission/text";

/** STAGE 3 (docs/STAGE-3.md): the queue message (position, an honest reason, never a time that was not measured) and the e-mail decision (once per job, only after a measured wait over a minute). */
const NOW = Date.parse("2026-11-04T10:00:00Z");
const q = (o: Partial<{ ahead: number; running: number; workerAlive: boolean; aheadOwn: number; runningOwn: number }> = {}) => ({ ahead: 0, running: 0, workerAlive: true, ...o });
const TIME_WORDS = /دقيق|ساع|ثان|ثوان|يوم|أيام|منذ|بعد قليل|قريب/;

describe("the queue", () => {
  it("position, reason code and the measured wait (from the stored time the request entered the queue)", () => {
    expect(queueStateOf({ status: "approved", queue: q({ ahead: 2, running: 1 }), queuedAtMs: NOW - 5 * 60_000, nowMs: NOW })).toMatchObject({ position: 3, reason: "behind_others", measuredWaitMs: 300_000 });
    expect(queueStateOf({ status: "queued", queue: q({ ahead: 1, aheadOwn: 1, runningOwn: 1, running: 1 }), queuedAtMs: null, nowMs: NOW })).toMatchObject({ position: 2, reason: "behind_own", measuredWaitMs: null });
    expect(queueStateOf({ status: "queued", queue: q({ ahead: 3, aheadOwn: 1 }), queuedAtMs: null, nowMs: NOW })!.reason).toBe("behind_both");
    expect(queueStateOf({ status: "approved", queue: q({ workerAlive: false, ahead: 4 }), queuedAtMs: null, nowMs: NOW })!.reason).toBe("service_paused");
    expect(queueStateOf({ status: "approved", queue: q(), queuedAtMs: NOW, nowMs: NOW })!.reason).toBe("starting_now");
    expect(queueStateOf({ status: "executing", queue: q({ ahead: 2 }), queuedAtMs: null, nowMs: NOW })).toBeNull();
  });
  it("a time that was not measured is never said: no minutes, no «soon», no estimate", () => {
    for (const reason of QUEUE_REASONS) {
      const line = queueLineAr({ position: 4, reason, measuredWaitMs: null, ahead: 3, aheadOwn: 1 });
      expect(line, reason).not.toMatch(TIME_WORDS);
      expect(checkCustomerText(line).issues, reason).toEqual([]);
    }
  });
  it("a measured wait is said as time already waited (never a time left)", () => {
    const line = queueLineAr({ position: 3, reason: "behind_others", measuredWaitMs: 5 * 60_000 + 20_000, ahead: 2, aheadOwn: 0 });
    expect(line).toBe("طلبك رقم ٣ في الدور، لأن قبله طلبين لعملاء آخرين. ينتظر طلبك منذ ٥ دقائق.");
    expect(line).not.toMatch(/متبق|خلال|حتى يبدأ|سيبدأ بعد/);
    expect(queueLineAr({ position: 2, reason: "behind_own", measuredWaitMs: 30_000, ahead: 1, aheadOwn: 1 })).toBe("طلبك رقم ٢ في الدور، لأنه ينتظر انتهاء طلب آخر لك يعمل الآن. ينتظر طلبك منذ أقل من دقيقة.");
  });
  it("a negative or impossible stored time is not a measurement", () => {
    expect(queueStateOf({ status: "approved", queue: q({ ahead: 1 }), queuedAtMs: NOW + 60_000, nowMs: NOW })!.measuredWaitMs).toBeNull();
    expect(queueStateOf({ status: "approved", queue: q({ ahead: 1 }), queuedAtMs: Number.NaN, nowMs: NOW })!.measuredWaitMs).toBeNull();
  });
});

describe("the e-mail decision (nothing is sent here)", () => {
  const job = (o: Partial<EmailJobFacts> = {}): EmailJobFacts => ({ status: "completed", approvedAtMs: NOW - 3 * 60_000, finishedAtMs: NOW, alreadyEmailed: false, emailable: true, sentThisMonth: 120, ...o });
  it("a finished job that the customer waited for more than one minute (measured): one e-mail", () => {
    expect(shouldNotifyByEmail(job())).toBe(true);
    expect(emailDecision(job())).toEqual({ send: true, reason: "waited_long", waitMs: 180_000 });
  });
  it("only once per job", () => {
    expect(emailDecision(job({ alreadyEmailed: true }))).toEqual({ send: false, reason: "already_emailed", waitMs: 180_000 });
  });
  it("one minute or less: no e-mail (the customer saw it on the screen)", () => {
    expect(EMAIL_WAIT_THRESHOLD_MS).toBe(60_000);
    expect(shouldNotifyByEmail(job({ approvedAtMs: NOW - 60_000 }))).toBe(false);
    expect(shouldNotifyByEmail(job({ approvedAtMs: NOW - 60_001 }))).toBe(true);
  });
  it("a wait that was not measured (a missing or impossible time) never sends", () => {
    expect(emailDecision(job({ approvedAtMs: null }))).toEqual({ send: false, reason: "wait_not_measured", waitMs: null });
    expect(emailDecision(job({ finishedAtMs: null }))).toEqual({ send: false, reason: "wait_not_measured", waitMs: null });
    expect(measuredWaitMs(job({ approvedAtMs: NOW + 1 }))).toBeNull();
  });
  it("a job still running is not decided yet; an address that cannot receive is never sent to", () => {
    expect(emailDecision(job({ status: "executing" })).reason).toBe("not_finished");
    expect(emailDecision(job({ emailable: false })).reason).toBe("not_emailable");
  });
  it("the Resend monthly limit (50,000): at the limit, or with no count known, nothing is sent", () => {
    expect(RESEND_MONTHLY_LIMIT).toBe(50_000);
    expect(emailDecision(job({ sentThisMonth: 49_999 })).send).toBe(true);
    expect(emailDecision(job({ sentThisMonth: 50_000 })).reason).toBe("monthly_limit");
    expect(emailDecision(job({ sentThisMonth: null })).reason).toBe("quota_unknown");
  });
});
