import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MissionStepRow } from "../src/components/mission/MissionPlanPanel";
import { customerMissionView, type EventForCustomer } from "../src/lib/agentMission/customerView";
import { remainingFrom, remainingLineAr, trackMission } from "../src/lib/agentMission/tracker";

/**
 * E. THE TRACKER: the final number is the file's, the time left is stable, the bar's accessible value is the count the customer reads.
 */
const at = (hhmmss: string) => `2026-10-28T${hhmmss}Z`;
// the events of the live run of 2026-10-28 (msn_3e6b…, the test account), exactly as stored: collecting events (pages, rows found), the four save events, the result
const E = (id: number, time: string, counts: Record<string, number>, message = "x", kind = "progress"): EventForCustomer => ({ id, kind, message_ar: message, counts, created_at: at(time) });
const INCIDENT: EventForCustomer[] = [
  E(124, "21:50:23.783", { saved: 9, stage: 1, checked: 9, pending: 0, planned: 300, accepted: 9, excluded: 0 }),
  ...[[126, "21:50:31.112", 20, 1], [127, "21:50:33.771", 40, 2], [128, "21:50:36.063", 60, 3], [129, "21:50:38.877", 80, 4], [130, "21:50:41.716", 100, 5], [131, "21:50:44.246", 120, 6], [132, "21:50:46.903", 140, 7], [133, "21:50:49.530", 160, 8]].map(([id, t, rows, pages]) => E(id as number, t as string, { rows: rows as number, pages: pages as number, planned: 300 })),
  E(134, "21:50:55.753", { saved: 77, stage: 1, checked: 79, pending: 0, planned: 300, accepted: 77, excluded: 2 }),
  ...[[136, "21:51:00.410", 180, 9], [137, "21:51:03.275", 200, 10], [138, "21:51:05.961", 220, 11], [139, "21:51:08.496", 240, 12], [140, "21:51:10.712", 260, 13], [141, "21:51:13.044", 280, 14], [142, "21:51:15.971", 300, 15], [143, "21:51:19.868", 320, 16]].map(([id, t, rows, pages]) => E(id as number, t as string, { rows: rows as number, pages: pages as number, planned: 300 })),
  E(148, "21:51:35.283", { saved: 192, stage: 1, checked: 201, pending: 0, planned: 300, accepted: 192, excluded: 9 }),
  ...[[150, "21:51:39.390", 420, 21], [160, "21:52:04.070", 620, 31], [163, "21:52:13.016", 680, 34]].map(([id, t, rows, pages]) => E(id as number, t as string, { rows: rows as number, pages: pages as number, planned: 300 })),
  // the fourth save of the live run: the writer's own memory said 300 saved
  E(164, "21:52:19.078", { saved: 300, stage: 1, checked: 242, pending: 0, planned: 300, accepted: 185, excluded: 10 }),
];
const planPublic = { summary_ar: "أجمع لك حتى ٣٠٠ تغريدة أصلية عن لاعب كرة القدم محمد صلاح.", stages: [{ key: "tweets", title_ar: "تغريدات عن محمد صلاح", expected_rows: 300, deliver: true, columns: [{ key: "text", title_ar: "نص التغريدة" }], sample_rows: [], yield_share: 0.8 }], price: { max_charge_points: 200, reserve_points: 200 } };
const row = (over: Record<string, unknown> = {}) => ({ id: "msn_3e6b", status: "completed", question_ar: null, plan_public: planPublic, reserved_points: 200, unit_price_points: 0.666666, delivered_units: 192, charged_points: 128, summary_ar: null, files: [{ name: "result.xlsx", kind: "xlsx" }], created_at: at("21:48:08.443"), ...over }) as any;

describe("the final number is the count of the file", () => {
  it("the live run's events (the last live number said 300) with the settlement's own result event: the tracker ends on the delivered count and the bar's value is that count", () => {
    const result = E(168, "21:52:26.070", { delivered: 192, stage_1_rows: 192, charged_points: 128 }, "x", "result");
    const live = customerMissionView({ mission: row({ status: "executing", delivered_units: null, charged_points: null }), events: INCIDENT, now: Date.parse(at("21:52:20")) });
    // while it runs the live count is the store's (the last save event)
    expect(live.steps[0]).toMatchObject({ savedN: 300 });
    const done = customerMissionView({ mission: row(), events: [...INCIDENT, result] });
    expect(done.steps[0]).toMatchObject({ countAr: "١٩٢ من ٣٠٠ تغريدة", savedN: 192, plannedN: 300, ratio: 1 });
    expect(done.resultLinesAr[0]).toBe("تم تسليم ١٩٢ من ٣٠٠ تغريدة.");
    // and with the file's own count (77 in the file): the tracker, the lines and the delivered count are all 77
    const file77 = customerMissionView({ mission: row({ delivered_units: 77, charged_points: 52 }), events: [...INCIDENT, E(168, "21:52:26.070", { delivered: 77, stage_1_rows: 77, charged_points: 52 }, "x", "result")] });
    expect(file77.steps[0]).toMatchObject({ countAr: "٧٧ من ٣٠٠ تغريدة", savedN: 77 });
    expect(file77.resultLinesAr).toEqual(["تم تسليم ٧٧ من ٣٠٠ تغريدة.", "خُصم ٥٢ نقطة مقابل ٧٧ تغريدة."]);
  });

  it("an older mission with no per-stage counts in its result event says its delivered count for its one delivered stage", () => {
    const done = customerMissionView({ mission: row({ delivered_units: 250, charged_points: 202 }), events: INCIDENT });
    expect(done.steps[0]).toMatchObject({ countAr: "٢٥٠ من ٣٠٠ تغريدة", savedN: 250 });
  });

  it("trackMission: the final count replaces the last live one (it is never a maximum of the two)", () => {
    const r = trackMission({ stages: [{ n: 1, titleAr: "التغريدات", expectedRows: 300, deliver: true }], events: INCIDENT, finished: true, finalSaved: [192], now: Date.parse(at("21:52:30")) });
    expect(r.stages[0].saved).toBe(192);
    expect(r.ratio).toBe(1);
  });
});

describe("the bar's accessible value is the count shown", () => {
  it("aria-valuenow is the saved count, aria-valuemax the volume bought, aria-valuetext the words on screen", () => {
    const html = renderToStaticMarkup(createElement(MissionStepRow, { step: { id: "stage-1", titleAr: "تغريدات عن محمد صلاح", state: "running", countAr: "١٩٢ من ٣٠٠ تغريدة", savedN: 192, plannedN: 300, ratio: 0.8 } }));
    expect(html).toContain('aria-valuenow="192"');
    expect(html).toContain('aria-valuemax="300"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuetext="١٩٢ من ٣٠٠ تغريدة"');
    expect(html).toContain("١٩٢ من ٣٠٠ تغريدة");
  });
  it("the whole path: the panel's step for a running mission carries the same count in its text and its bar", () => {
    const v = customerMissionView({ mission: row({ status: "executing", delivered_units: null, charged_points: null }), events: INCIDENT, now: Date.parse(at("21:52:20")) });
    const step = v.steps[0];
    expect(step.countAr).toBe("٣٠٠ من ٣٠٠ تغريدة");
    expect(step.savedN).toBe(300);
    expect(step.plannedN).toBe(300);
  });
});

describe("the time left is smoothed and never jumps up and down", () => {
  const base = Date.parse(at("00:00:00"));
  // a source that alternates fast and slow pages: the progress per event is uneven
  const uneven = (n: number) => { const samples: Array<{ at: number; p: number }> = []; let p = 0.12; let t = 45_000; for (let i = 0; i < n; i += 1) { t += i % 2 === 0 ? 2_000 : 9_000; p += i % 2 === 0 ? 0.045 : 0.006; samples.push({ at: base + t, p: Math.min(p, 0.95) }); } return samples; };

  it("one slow page in a steady run does not make the time jump UP: the shown value follows the clock down and may rise by at most a tenth of what the clock left of it", () => {
    const steady = Array.from({ length: 9 }, (_, i) => ({ at: base + 45_000 + i * 5_000, p: 0.2 + i * 0.03 }));
    // the 10th event comes 25 seconds after the 9th (a slow page): the estimate alone would put the time left 13% above what the clock left
    const slow = { at: base + 110_000, p: 0.46 };
    const before = remainingFrom(steady, base, steady[8].at)!;
    const atSlow = remainingFrom([...steady, slow], base, slow.at)!;
    expect(before).not.toBeNull();
    const decayed = before - (slow.at - steady[8].at) / 1000;
    expect(atSlow).toBeLessThanOrEqual(decayed * 1.1 + 0.001);
    // and when the slowness goes on (three events in a row say «longer») the shown time does rise: it is honest, only never jumpy
    const slower = [...steady, slow, { at: base + 135_000, p: 0.465 }, { at: base + 160_000, p: 0.47 }, { at: base + 185_000, p: 0.475 }];
    const later = remainingFrom(slower, base, slower[slower.length - 1].at);
    expect(later === null || later > 0).toBe(true);
  });

  it("replayed event by event over an uneven source, no step rises by more than a tenth (plus a quarter of a minute) of what the clock left of the last shown value", () => {
    const samples = uneven(30);
    const series: Array<number | null> = samples.map((s, i) => remainingFrom(samples.slice(0, i + 1), base, s.at));
    let previous: number | null = null;
    let previousAt = 0;
    for (const [i, v] of series.entries()) {
      if (v !== null && previous !== null) {
        const elapsed = (samples[i].at - previousAt) / 1000;
        expect(v, `event ${i}`).toBeLessThanOrEqual(Math.max(previous - elapsed, 0) * 1.1 + 15 + 0.001);
      }
      if (v !== null) { previous = v; previousAt = samples[i].at; }
    }
  });

  it("a steady source is shown, counts down between events, and the line is whole minutes", () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({ at: base + 45_000 + i * 5_000, p: 0.2 + i * 0.03 }));
    const v = remainingFrom(samples, base, samples[samples.length - 1].at);
    expect(v).not.toBeNull();
    expect(remainingFrom(samples, base, samples[samples.length - 1].at + 10_000)!).toBeCloseTo(v! - 10, 5);
    expect(remainingLineAr(v, 0.5)).toMatch(/^المتبقي نحو /);
  });
});
