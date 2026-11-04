import { describe, expect, it } from "vitest";
import { customerMissionView, type EventForCustomer, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import type { PanelStep } from "../src/lib/missionView";

/**
 * ROUND 26, item 3: a step is CHECKED only when it is done AND every step before it is done; the first step that is not done is the current one (working while the mission works).
 * Live: after the customer answered a question, «فهمنا طلبك» stayed unchecked while «لقينا المصادر»، «بنجرب عينة صغيرة» and «بنجهز السعر» were checked. The cause:
 * a question stores its options in plan_public ({question_options}), which counted as a plan, so the planning steps after the first were marked done.
 */
const CREATED = "2026-11-04T12:19:32.000Z";
const NOW = Date.parse("2026-11-04T12:25:00.000Z");

function row(status: string, plan_public: any, extra: Partial<MissionRowForCustomer> = {}): MissionRowForCustomer {
  return { id: "msn_test", status, question_ar: null, plan_public, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: CREATED, ...extra };
}
const ev = (id: number, kind: string, counts: Record<string, number> | null, message_ar = "نص"): EventForCustomer => ({ id, kind, message_ar, counts, created_at: "2026-11-04T12:20:00.000Z" });
const states = (steps: PanelStep[]) => steps.map((s) => s.state);

/** The invariant the owner asked for: no step is done after one that is not. */
function assertChecksInOrder(steps: PanelStep[]) {
  let openSeen = false;
  for (const s of steps) {
    if (s.state !== "done") openSeen = true;
    else expect(openSeen, `step «${s.titleAr}» is checked before an earlier step`).toBe(false);
  }
}

describe("ROUND 26 item 3: the steps panel checks in order", () => {
  it("after an answer (queued, with the question's options stored) nothing is checked", () => {
    const v = customerMissionView({ mission: row("queued", { question_options: ["١٠", "٥٠"] }), events: [ev(1, "system", null), ev(2, "question", null), ev(3, "answer", null)], now: NOW });
    expect(states(v.steps.slice(0, 4))).not.toContain("done");
    expect(v.steps[0].state).toBe("waiting");
    assertChecksInOrder(v.steps);
  });

  it("a question's options are not a plan: the planning steps after the first are not checked", () => {
    const v = customerMissionView({ mission: row("planning", { question_options: ["١٠"] }), events: [ev(1, "system", null), ev(2, "call", { compiled: 0, question: 1 })], callsMade: 1, now: NOW });
    expect(v.steps[2].state).not.toBe("done");
    assertChecksInOrder(v.steps);
  });

  it("while planning, the first unchecked step is the working one", () => {
    const v = customerMissionView({ mission: row("planning", null), events: [ev(1, "system", null), ev(2, "call", { compiled: 1, pool_reads: 1 })], callsMade: 1, now: NOW });
    assertChecksInOrder(v.steps);
    const firstOpen = v.steps.find((s) => s.state !== "done");
    expect(firstOpen?.state).toBe("running");
  });

  it("a later step never shows as checked while an earlier one is open (every combination of the four planning steps)", () => {
    const combos: Array<{ status: string; plan: any; calls: number; events: EventForCustomer[] }> = [
      { status: "queued", plan: null, calls: 0, events: [] },
      { status: "planning", plan: null, calls: 0, events: [ev(1, "system", null)] },
      { status: "planning", plan: null, calls: 2, events: [ev(1, "call", { samples: 2, stages: 2 })] },
      { status: "planning", plan: { question_options: ["x"] }, calls: 1, events: [] },
      { status: "plan_ready", plan: { stages: [{ title_ar: "التغريدات", expected_rows: 10, deliver: true }], price: { max_charge_points: 200, reserve_points: 200 } }, calls: 3, events: [] },
    ];
    for (const c of combos) {
      const v = customerMissionView({ mission: row(c.status, c.plan), events: c.events, callsMade: c.calls, now: NOW });
      assertChecksInOrder(v.steps);
    }
  });

  it("the executing steps follow the same order", () => {
    const plan = { stages: [{ title_ar: "التغريدات", expected_rows: 10, deliver: true, columns: [{ key: "a", title_ar: "النص" }] }], price: { max_charge_points: 200, reserve_points: 200 } };
    const v = customerMissionView({ mission: row("executing", plan, { reserved_points: 200, unit_price_points: 20 }), events: [ev(1, "progress", { stage: 1, saved: 0, found: 0 }, "يجمع")], callsMade: 4, now: NOW });
    assertChecksInOrder(v.steps);
  });
});
