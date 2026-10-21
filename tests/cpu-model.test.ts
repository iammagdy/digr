import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BASE_PARAMS, CPU_REMAINING_H, DEFAULT_SESSION, OWNER_AVG_INVOCATION_S, SCENARIOS, STRESS_PARAMS, eventCpuHours, fittedOverheadS, missionChunks, rawMsByRoute, recommendHosting, roomCachedInvocations, visitorInvocations, type Counts } from "../scripts/capacity/cpuModel";
import { buildReport, loadMeasurements } from "../scripts/capacity/report";
import { BUSY_POLL_MS } from "../src/hooks/useBusyStatus";

const m = loadMeasurements();
const total = (counts: Counts) => Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);

describe("the CPU model (docs/CPU_MODEL.md)", () => {
  it("the document is exactly what the model prints from the measurements", () => {
    expect(readFileSync("docs/CPU_MODEL.md", "utf8")).toBe(buildReport(m));
  });

  it("the fitted overhead makes the pre-change visitor mix average exactly the owner's 0.108 s per invocation", () => {
    const mix = visitorInvocations("before");
    const raw = rawMsByRoute(m);
    for (const speed of [1, 2, 6]) {
      const overhead = fittedOverheadS(m, speed);
      const seconds = Object.entries(mix).reduce((acc, [route, n]) => acc + (n ?? 0) * (overhead + (raw[route as keyof typeof raw] * speed) / 1000), 0);
      expect(seconds / total(mix)).toBeCloseTo(OWNER_AVG_INVOCATION_S, 6);
    }
  });

  it("the invocation counts come from the code's own constants: the status poll of the page, and the edge cache of the public routes", () => {
    expect(DEFAULT_SESSION.busyPollAvgMs).toBeGreaterThanOrEqual(BUSY_POLL_MS);
    expect(DEFAULT_SESSION.busyPollAvgMs).toBeLessThanOrEqual(BUSY_POLL_MS + 8_000);
    expect(visitorInvocations("before").busy_status).toBeGreaterThan(60);
    expect(visitorInvocations("after").busy_status).toBeUndefined();
    const cached = roomCachedInvocations();
    expect(cached.busy_status).toBeLessThan(5000);
    expect(cached.busy_status!).toBeLessThan(visitorInvocations("before").busy_status! * 500 / 10);
  });

  it("the changes of this work lower the day's CPU in every scenario, and the stress figure stays under the 2-hour line after them", () => {
    for (const scenario of SCENARIOS) {
      for (const params of [BASE_PARAMS, STRESS_PARAMS]) {
        expect(eventCpuHours("after", scenario, m, params), `${scenario.id} ${params.id}`).toBeLessThan(eventCpuHours("before", scenario, m, params));
      }
      expect(eventCpuHours("after", scenario, m, STRESS_PARAMS)).toBeLessThan(2);
    }
  });

  it("more missions never cost less, and a mission has one worker call per 50 rows", () => {
    const [chat, quarter, all] = SCENARIOS.map((s) => eventCpuHours("after", s, m, STRESS_PARAMS));
    expect(chat).toBeLessThan(quarter);
    expect(quarter).toBeLessThan(all);
    expect([1, 50, 51, 100, 104, 173].map(missionChunks)).toEqual([1, 1, 2, 2, 3, 4]);
  });

  it("the decision rule of the brief: under 2 stay, 2 to 3 reduce, above 3 upgrade", () => {
    expect(recommendHosting(1.99).level).toBe("stay");
    expect(recommendHosting(2).level).toBe("reduce");
    expect(recommendHosting(3).level).toBe("reduce");
    expect(recommendHosting(3.01).level).toBe("upgrade");
    expect(CPU_REMAINING_H).toBeCloseTo(3.4167, 3);
  });
});
