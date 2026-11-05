import { afterEach, describe, expect, it, vi } from "vitest";
import { customerMissionView, queueLine, type QueueInfo } from "../src/lib/agentMission/customerView";
import { loadCustomerMission } from "../src/lib/agentMission/customerActions";
import { queueLineV2, stage3QueueOn } from "../src/lib/agentMission/stage3/queueView";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { AGENT_HEARTBEAT_TABLE } from "../src/lib/agentMission/constants";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * STAGE 3 S5 (docs/STAGE-3.md): THE QUEUE LINE behind DIGER_STAGE3_QUEUE. Flag off (unset, as in production): `queueLine` of customerView.ts is what the customer reads, unchanged. Flag on: the
 * position, an honest reason and, only when it was MEASURED, the time the request has already waited (from the stored approval time). On the SITE only the value «on» turns the flag on: the
 * site cannot know a test account (the guard tests/admin-calls-log.test.ts keeps that rule out of customer code), so «test» stays off here.
 */
const NOW = Date.parse("2026-11-04T10:00:00Z");
const TIME_WORDS = /دقيق|ساع|ثان|ثوان|يوم|أيام|منذ|بعد قليل|قريب/;
const q = (o: Partial<QueueInfo> = {}): QueueInfo => ({ ahead: 0, running: 0, workerAlive: true, ...o });
afterEach(() => { vi.unstubAllEnvs(); });

describe("the flag on the site", () => {
  it("only «on» turns it on (unset, empty, «test», anything else: off)", () => {
    expect(stage3QueueOn({})).toBe(false);
    expect(stage3QueueOn({ DIGER_STAGE3_QUEUE: "" })).toBe(false);
    expect(stage3QueueOn({ DIGER_STAGE3_QUEUE: "test" })).toBe(false);
    expect(stage3QueueOn({ DIGER_STAGE3_QUEUE: "yes" })).toBe(false);
    expect(stage3QueueOn({ DIGER_STAGE3_QUEUE: "on" })).toBe(true);
    expect(stage3QueueOn({ DIGER_STAGE3_QUEUE: " ON " })).toBe(true);
  });
});

describe("queueLineV2", () => {
  it("nothing ahead and nothing running: no line (the card then says «بدأنا جمع»), the position is 1", () => {
    expect(queueLineV2("approved", q(), null, NOW)).toEqual({ lineAr: null, position: 1 });
  });
  it("not waiting (running, done, planning): no line, no position", () => {
    for (const status of ["executing", "completed", "planning", "plan_ready", "needs_input"]) expect(queueLineV2(status, q({ ahead: 2 }), NOW - 600_000, NOW)).toEqual({ lineAr: null, position: null });
    expect(queueLineV2("approved", null, NOW - 600_000, NOW)).toEqual({ lineAr: null, position: null });
  });
  it("the position and the reason, and the MEASURED wait: «ينتظر طلبك منذ ...» (time already waited, never time left)", () => {
    const l = queueLineV2("approved", q({ ahead: 2, running: 1 }), NOW - 5 * 60_000 - 20_000, NOW);
    expect(l.position).toBe(3);
    expect(l.lineAr).toBe("طلبك رقم ٣ في الدور، لأن قبله طلبين لعملاء آخرين. ينتظر طلبك منذ ٥ دقائق.");
    expect(l.lineAr).not.toMatch(/متبق|خلال|حتى يبدأ|سيبدأ بعد/);
  });
  it("a time that was not measured is never said: no approval time, a queued request (it has no approval yet), or an impossible one", () => {
    const shapes = [q({ ahead: 3, aheadOwn: 1 }), q({ ahead: 1, aheadOwn: 1, runningOwn: 1, running: 1 }), q({ ahead: 2 }), q({ ahead: 4, workerAlive: false })];
    for (const queue of shapes) for (const [status, at] of [["approved", null], ["queued", null], ["approved", NOW + 60_000], ["approved", Number.NaN]] as const) {
      const l = queueLineV2(status, queue, at, NOW);
      expect(l.lineAr, `${status} ${String(at)}`).not.toBeNull();
      expect(l.lineAr!, `${status} ${String(at)}`).not.toMatch(TIME_WORDS);
      expect(checkCustomerText(l.lineAr!).issues).toEqual([]);
    }
  });
  it("the reasons: the customer's own request, other customers', both, the service paused; every line passes the customer-text rules", () => {
    const own = queueLineV2("approved", q({ ahead: 1, aheadOwn: 1, runningOwn: 1, running: 1 }), null, NOW).lineAr!;
    const others = queueLineV2("approved", q({ ahead: 3, aheadOwn: 0 }), null, NOW).lineAr!;
    const both = queueLineV2("approved", q({ ahead: 3, aheadOwn: 1 }), null, NOW).lineAr!;
    const paused = queueLineV2("approved", q({ ahead: 4, workerAlive: false }), null, NOW).lineAr!;
    expect(own).toBe("طلبك رقم ٢ في الدور، لأنه ينتظر انتهاء طلب آخر لك يعمل الآن.");
    expect(others).toBe("طلبك رقم ٤ في الدور، لأن قبله ٣ طلبات لعملاء آخرين.");
    expect(both).toBe("طلبك رقم ٤ في الدور، لأن قبله طلبًا واحدًا لك وطلبين لعملاء آخرين.");
    expect(paused).toBe("الخدمة متوقفة مؤقتًا. طلبك محفوظ وسيبدأ تلقائيًا عند عودتها.");
    for (const t of [own, others, both, paused]) { expect(checkCustomerText(t).issues, t).toEqual([]); expect(t).not.toMatch(/[0-9]/); }
  });
});

describe("customerMissionView", () => {
  const mission = (status: string) => ({ id: "msn_q", status, question_ar: null, plan_public: null, reserved_points: 200, unit_price_points: 1, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-04T09:00:00Z" });
  const view = (status: string, queue: QueueInfo, extra: Record<string, unknown> = {}) => customerMissionView({ mission: mission(status), events: [], queue, now: NOW, ...extra });
  const shapes: QueueInfo[] = [q(), q({ ahead: 2, running: 1 }), q({ ahead: 1, aheadOwn: 1, runningOwn: 1, running: 1 }), q({ ahead: 3, aheadOwn: 1 }), q({ ahead: 4, workerAlive: false })];
  it("flag off: the view's queue line and position are exactly today's queueLine for every shape and status", () => {
    for (const status of ["queued", "approved", "executing", "completed"]) for (const queue of shapes) {
      const today = queueLine(status, queue);
      const v = view(status, queue);
      expect([v.queueLineAr, v.queuePosition], `${status}`).toEqual([today.lineAr, today.position]);
    }
  });
  it("flag on (the caller passes the approval time): the new line; with no approval time, the same line without a time word", () => {
    const on = view("approved", q({ ahead: 2 }), { stage3Queue: { approvedAtMs: NOW - 3 * 60_000 } });
    expect(on.queueLineAr).toBe("طلبك رقم ٣ في الدور، لأن قبله طلبين لعملاء آخرين. ينتظر طلبك منذ ٣ دقائق.");
    expect(on.queuePosition).toBe(3);
    const unmeasured = view("approved", q({ ahead: 2 }), { stage3Queue: { approvedAtMs: null } });
    expect(unmeasured.queueLineAr).toBe("طلبك رقم ٣ في الدور، لأن قبله طلبين لعملاء آخرين.");
    expect(unmeasured.queueLineAr).not.toMatch(/منذ|دقيق|ساع/);
  });
});

describe("loadCustomerMission reads the approval time only when the flag is on", () => {
  const select = vi.fn();
  function clientOf() {
    const db = createMemoryDb();
    db.seed("missions", [{ id: "msn_q", user_id: "u-1", status: "approved", question_ar: null, plan_public: null, reserved_points: 200, unit_price_points: 1, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-04T09:00:00Z", approved_at: new Date(NOW - 7 * 60_000).toISOString(), request_text: "x" },
      // one earlier request of another customer waits ahead, and the worker's heartbeat is fresh
      { id: "msn_ahead", user_id: "u-2", status: "approved", created_at: "2026-11-04T08:00:00Z" }]);
    db.seed(AGENT_HEARTBEAT_TABLE, [{ beat_at: new Date(NOW - 5_000).toISOString() }]);
    return { from: (t: string) => { const b = db.from(t); const s = b.select; b.select = (cols?: string, o?: unknown) => { if (t === "missions") select(cols); return s(cols, o); }; return b; }, auth: { admin: { getUserById: async () => ({ data: { user: { email: "a@example.test" } } }) } } };
  }
  it("flag unset: the select is today's (no approved_at) and the line is today's", async () => {
    vi.stubEnv("DIGER_STAGE3_QUEUE", "");
    select.mockClear();
    const r = await loadCustomerMission(clientOf(), { id: "msn_q", userId: "u-1", now: NOW });
    if (!r.ok) throw new Error("not ok");
    expect(select.mock.calls.map((c) => String(c[0])).filter((c) => c.includes("user_id"))[0]).not.toContain("approved_at");
    // today's line (queueLine of customerView.ts), with no position sentence and no time
    expect(r.view.queueLineAr).toBe("طلبك ينتظر دوره؛ قبله ١ من الطلبات الجارية أو المنتظرة، وسيبدأ تلقائيًا عند دوره.");
  });
  it("flag on: approved_at is read and the line carries the measured wait from it", async () => {
    vi.stubEnv("DIGER_STAGE3_QUEUE", "on");
    select.mockClear();
    const c = clientOf();
    const r = await loadCustomerMission(c, { id: "msn_q", userId: "u-1", now: NOW });
    if (!r.ok) throw new Error("not ok");
    expect(select.mock.calls.map((x) => String(x[0])).filter((x) => x.includes("user_id"))[0]).toContain("approved_at");
    expect(r.view.queueLineAr).toBe("طلبك رقم ٢ في الدور، لأن قبله طلبًا واحدًا لعملاء آخرين. ينتظر طلبك منذ ٧ دقائق.");
    expect(r.view.queuePosition).toBe(2);
  });
});
