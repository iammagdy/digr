import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { dispatcher, planFlow, SECTOR_WORLD } from "./helpers/g1World";

/**
 * STAGE 3, FLAGS UNSET, BYTE FOR BYTE (parts A and B): a whole companies and decision-makers mission, planned by today's model path and carried out by today's engine, gives exactly what it gave
 * BEFORE any Stage 3 planning or engine wiring existed: the plan object, the delivered rows of every stage, every cell of every sheet of the delivered file, the charge and the release.
 * The expected digests were written by this file on the branch commit right before the wiring (`WRITE_STAGE3_FLAGS_OFF=1`): tests/fixtures/stage3-flags-off.json.
 * Worlds (fake, no real provider): the golden G1 and G2 worlds (tests/helpers/g1World.ts, the live shape of a companies mission), and the G1 world asked with the live words of msn_7539ea17512cf58aa0e7.
 * The request words of msn_4969a50fed8c45b37d8f are not in the repo, so it has no world of its own here (docs/STAGE-3.md section 11).
 */
const LIVE_7539 = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار";
const DIGESTS = new URL("./fixtures/stage3-flags-off.json", import.meta.url);
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
/**
 * THE CLOCK OF THE RECORDING. The delivered file's citation line («... تاريخ التسليم: ٥ نوفمبر ٢٠٢٦.», agent/src/methodology.ts) names the Cairo DAY of delivery, which is real data: the digests were
 * recorded on 5 Nov 2026 (commit 7c5832a, 13:21 UTC), so the same world run on any later day differed ONLY in those cells (the plan, rows and money were equal). The worlds now run on a clock that
 * starts at that instant and moves forward with real time (`shouldAdvanceTime`, so nothing waits on a frozen clock); the day is checked, not hidden (see the second test).
 */
const RECORDED_AT = "2026-11-05T13:21:11Z";
const RECORDED_DAY_AR = "تاريخ التسليم: ٥ نوفمبر ٢٠٢٦.";
async function onClock<T>(iso: string, run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso), shouldAdvanceTime: true });
  try { return await run(); } finally { vi.useRealTimers(); }
}
async function cellsOf(r: ReplayResult): Promise<unknown[]> {
  const wb = await readWorkbook(r);
  const cells: unknown[] = [];
  wb.eachSheet((ws) => { const rows: unknown[] = []; ws.eachRow((row) => rows.push((row.values as unknown[]).map((v) => (v instanceof Date ? "<date>" : v)))); cells.push([ws.name, rows]); });
  return cells;
}

const WORLDS: Record<string, () => Promise<ReplayResult>> = {
  g1: () => replay({ request: SECTOR_WORLD.electromechanical.request, planning: planFlow("electromechanical"), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher({})) }),
  g2: () => replay({ request: SECTOR_WORLD.petroleum.request, planning: planFlow("petroleum"), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher({ sector: "petroleum" })) }),
  live_7539_words: () => replay({ request: LIVE_7539, planning: planFlow("electromechanical"), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher({})) }),
};

/** What a mission gave, with the values that differ from run to run on any commit taken out (ids made from the clock, times, the measured milliseconds of a call). */
async function digestOf(r: ReplayResult): Promise<Record<string, string>> {
  const m = r.mission;
  const cells = await cellsOf(r);
  const clean = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === "measured_ms_per_row" ? undefined : x)).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>").replace(/msn_[0-9a-f]{20}/g, "<mission>").replace(/job_[0-9a-f-]+/g, "<job>"));
  const rows: Record<string, unknown> = {};
  for (const st of m.plan?.stages ?? []) rows[st.key] = clean(JSON.parse((await r.store.getFile(r.missionId, `rows/${st.key}.json`)) ?? "null"));
  return {
    plan: sha(clean(r.plannedPlan)),
    status: `${m.status}:${m.delivered_units}:${m.charged_points}:${(m as unknown as Record<string, unknown>).released_points ?? ""}`,
    rows: sha(rows),
    file: sha(clean(cells)),
  };
}

describe("Stage 3 flags unset: today's companies missions give exactly what they gave before the wiring", () => {
  it("the plan object, the delivered rows, every cell of the file and the money of each world equal the digests written before the wiring", async () => {
    vi.stubEnv("DIGER_STAGE3_COMPANIES", "");
    const now: Record<string, Record<string, string>> = {};
    for (const [name, run] of Object.entries(WORLDS)) now[name] = await onClock(RECORDED_AT, async () => digestOf(await run()));
    vi.unstubAllEnvs();
    if (process.env.WRITE_STAGE3_FLAGS_OFF === "1") { writeFileSync(DIGESTS, `${JSON.stringify({ _about: "Written by tests/stage3-flags-off.test.ts (WRITE_STAGE3_FLAGS_OFF=1) on the stage-3 branch before the planning and engine wiring.", worlds: now }, null, 1)}\n`); return; }
    expect(existsSync(DIGESTS)).toBe(true);
    expect(now).toEqual((JSON.parse(readFileSync(DIGESTS, "utf8")) as { worlds: unknown }).worlds);
  }, 120_000);

  it("ROOT CAUSE (regression): on another day ONLY the delivery-day cells of the file differ, and each names that day; the plan, rows and money do not move", async () => {
    vi.stubEnv("DIGER_STAGE3_COMPANIES", "");
    const recorded = await onClock(RECORDED_AT, () => WORLDS.g1());
    const nextDay = await onClock("2026-11-06T10:00:00Z", () => WORLDS.g1());
    vi.unstubAllEnvs();
    const expected = (JSON.parse(readFileSync(DIGESTS, "utf8")) as { worlds: Record<string, Record<string, string>> }).worlds.g1;
    // before the fix the test ran on the real clock: the day after the recording it gave this other file digest (the failure seen on 6 Nov 2026), with plan, rows and status equal
    const before = await digestOf(nextDay);
    expect({ plan: before.plan, rows: before.rows, status: before.status }).toEqual({ plan: expected.plan, rows: expected.rows, status: expected.status });
    expect(before.file).not.toBe(expected.file);
    expect((await digestOf(recorded)).file).toBe(expected.file);
    // every differing cell is a citation cell, and it names the day of ITS run (the date is checked, not normalised away)
    const a = (await cellsOf(recorded)).flatMap((sheet) => ((sheet as [string, unknown[][]])[1]).flat().map(String));
    const b = (await cellsOf(nextDay)).flatMap((sheet) => ((sheet as [string, unknown[][]])[1]).flat().map(String));
    expect(a.length).toBe(b.length);
    const diff = a.map((x, i) => [x, b[i]] as const).filter(([x, y]) => x !== y);
    expect(diff.length).toBeGreaterThan(0);
    for (const [x, y] of diff) {
      expect(x.endsWith(RECORDED_DAY_AR)).toBe(true);
      expect(y.endsWith("تاريخ التسليم: ٦ نوفمبر ٢٠٢٦.")).toBe(true);
      expect(x.replace(RECORDED_DAY_AR, "")).toBe(y.replace("تاريخ التسليم: ٦ نوفمبر ٢٠٢٦.", ""));
    }
  }, 120_000);
});
