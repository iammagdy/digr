import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, type ReplayResult } from "./helpers/agentReplay";
import { dispatcher, planFlow, SECTOR_WORLD } from "./helpers/g1World";
import { g1 } from "./helpers/g1World";

beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", ""));
afterEach(() => vi.unstubAllEnvs());

/**
 * DT-20261118-09 FIX1, the proof QA asked for: the two company worlds of the byte-identical tests (g1, g2) and the three of the Stage 3 test (g1, g2, the live words of msn_7539) give the SAME money on this branch as on main
 * cb11ecb1 (the code before DT-09). «The same money» is every NUMBER of what the worlds hand to the money functions and store: the quote's items, prices, holds, reserve, unit price, the settlement, the charge, the release, the
 * rows and points of the mission and of the plan's price; every number, by its path. The text of a summary and the ids and hashes derived from it are strings and are not compared (DT-09 changed a headline, and the quote id and
 * hash hash that headline). The «before» numbers (tests/fixtures/dt09-money-before.json) were written by this very file on `origin/main` cb11ecb1: DT09_WRITE_MONEY_BEFORE=1 npx vitest run tests/dt09-money-unchanged.test.ts
 * A change of any amount, in any of the worlds, fails the test with the paths that moved.
 * LIMITS (Gate 2 r2 P2): the real settlement SQL (settle_job_atomic) is NOT exercised here (the worlds run on the money fake), and a pricing branch these worlds never reach (the legacy price function's reserve margin, the settlement's min()) is not covered by this proof.
 */
// D-0117 CHANGED (DT-20261119-06 PART B, Megz's decision: a delivered person is charged only if a contact the customer asked for reached the file): in the five company worlds the finders find nothing, so the 10 people are delivered but not charged. The fixture was re-written on the PART B branch: the ONLY numbers that moved are `mission.charged` 2,234 -> 745 and `money[3].args.p_new_delivered_units` 15 -> 5 in each of the five worlds (git diff of the fixture shows exactly these 10 lines); every price, hold, reserve, unit and the plan price are unchanged.
const FIXTURE = new URL("./fixtures/dt09-money-before.json", import.meta.url);
const LIVE_7539 = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-05T13:21:11Z"), shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

const TIME_OR_RANDOM = /(_ms|_at|_hash)$|^(at|ts|created|startedAt|beat_at)$|expires|duration|latency/i;
/** every number (and boolean) of a value, by its path; strings are the text and the ids and are left out; clocks are left out */
export function numbersOf(value: unknown, path = "", out: Record<string, number | boolean> = {}): Record<string, number | boolean> {
  if (typeof value === "number" || typeof value === "boolean") { out[path] = value; return out; }
  if (Array.isArray(value)) { value.forEach((v, i) => numbersOf(v, `${path}[${i}]`, out)); return out; }
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!TIME_OR_RANDOM.test(k)) numbersOf(v, path ? `${path}.${k}` : k, out);
  return out;
}
/** what a world hands to the money and stores about it */
export function moneyOf(r: ReplayResult): Record<string, number | boolean> {
  const m = r.mission as unknown as Record<string, unknown>;
  const plan = (m.plan ?? {}) as { price?: unknown; stages?: unknown[] };
  return {
    ...numbersOf({ delivered: m.delivered_units, charged: m.charged_points, reserved: m.reserved_points, unit: m.unit_price_points }, "mission"),
    ...numbersOf(plan.price, "plan.price"),
    ...numbersOf(plan.stages, "plan.stages"),
    ...numbersOf(r.money.calls.map((c: unknown) => { const x = c as { name?: string; args?: unknown }; return { name: x.name, args: x.args }; }), "money"),
    "money.calls": r.money.calls.length,
  };
}
export const moved = (before: Record<string, number | boolean>, now: Record<string, number | boolean>): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(now)])].sort().filter((k) => before[k] !== now[k]).map((k) => `${k}: ${String(before[k])} -> ${String(now[k])}`);

const WORLDS: Record<string, () => Promise<ReplayResult>> = {
  flags_off_g1: () => g1({}),
  flags_off_g2: () => g1({ sector: "petroleum" }),
  stage3_g1: () => replay({ request: SECTOR_WORLD.electromechanical.request, planning: planFlow("electromechanical"), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher({})) }),
  stage3_g2: () => replay({ request: SECTOR_WORLD.petroleum.request, planning: planFlow("petroleum"), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher({ sector: "petroleum" })) }),
  stage3_live_7539: () => replay({ request: LIVE_7539, planning: planFlow("electromechanical"), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher({})) }),
};

describe("every amount, point, hold, charge and release of the company worlds is what main gave", () => {
  const writing = process.env.DT09_WRITE_MONEY_BEFORE === "1";
  const before: Record<string, Record<string, number | boolean>> = !writing && existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : {};
  const collected: Record<string, Record<string, number | boolean>> = {};
  for (const [name, make] of Object.entries(WORLDS)) {
    it(name, async () => {
      const now = moneyOf(await make());
      collected[name] = now;
      if (writing) { writeFileSync(FIXTURE, `${JSON.stringify({ ...(existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : {}), [name]: now }, null, 1)}\n`); return; }
      expect(before[name], `no «before» numbers for ${name}`).toBeDefined();
      expect(Object.keys(now).length, "the world must hand real numbers to the money").toBeGreaterThan(20);
      expect(moved(before[name], now)).toEqual([]);
    }, 60_000);
  }
  it("the comparison itself sees a change of one amount (the mutant of the proof): +1 point on any number fails it, a missing number fails it", () => {
    const a = { "mission.reserved": 2569, "money[0].args.p_items[0].unit": 10.5, "money.calls": 5 };
    expect(moved(a, { ...a })).toEqual([]);
    expect(moved(a, { ...a, "mission.reserved": 2570 })).toEqual(["mission.reserved: 2569 -> 2570"]);
    expect(moved(a, { "mission.reserved": 2569, "money.calls": 5 })).toEqual(["money[0].args.p_items[0].unit: 10.5 -> undefined"]);
  });
});
