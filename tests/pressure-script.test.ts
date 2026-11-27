import { describe, expect, it, vi } from "vitest";
import { CONFIRM_PHRASE, checkLedger, safetyProblems, stagePassed, Recorder, percentile } from "../scripts/pressure/lib";
import { main } from "../scripts/pressure/run";

const good = { base: "https://diger-abc123-iam-magdy.vercel.app", testDatabaseUrl: "https://testprojectref.supabase.co", confirm: CONFIRM_PHRASE, stage: 50, allow500: false };

describe("the pressure test refuses to start unless it is clearly a preview and a test database", () => {
  it("a preview address, a test database, the confirmation phrase and a known stage: nothing blocks it", () => {
    expect(safetyProblems(good)).toEqual([]);
  });
  it("never the live site", () => {
    for (const host of ["https://diger.tech", "https://www.diger.tech", "https://diger.vercel.app", "https://diger-iam-magdy.vercel.app", "https://diger-git-main-iam-magdy.vercel.app"]) {
      expect(safetyProblems({ ...good, base: host }).join(" "), host).toContain("live site");
    }
  });
  it("never a non-preview address, never the live database, never without the phrase, never an unknown stage", () => {
    expect(safetyProblems({ ...good, base: "https://example.com" }).join(" ")).toContain("not a preview");
    expect(safetyProblems({ ...good, base: "not an address" }).length).toBeGreaterThan(0);
    expect(safetyProblems({ ...good, testDatabaseUrl: "https://pfinlfaqwnytesedchik.supabase.co" }).join(" ")).toContain("LIVE database");
    expect(safetyProblems({ ...good, testDatabaseUrl: "https://example.com" }).join(" ")).toContain("not a database address");
    expect(safetyProblems({ ...good, confirm: undefined }).join(" ")).toContain("PRESSURE_TEST_CONFIRM");
    expect(safetyProblems({ ...good, confirm: "yes" }).length).toBeGreaterThan(0);
    expect(safetyProblems({ ...good, stage: 75 }).join(" ")).toContain("unknown stage");
  });
  it("stage 500 needs an explicit second yes", () => {
    expect(safetyProblems({ ...good, stage: 500 }).join(" ")).toContain("--yes-500");
    expect(safetyProblems({ ...good, stage: 500, allow500: true })).toEqual([]);
  });
  it("main() starts nothing and touches no network when a check fails", async () => {
    const before = process.argv;
    process.argv = ["node", "run.ts", "--stage", "50", "--base", "https://diger.tech"];
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any) => { calls.push(String(url)); return new Response("{}"); }) as typeof fetch;
    const errors: string[] = [];
    const log = console.error;
    console.error = (message: string) => { errors.push(String(message)); };
    try {
      const code = await main({ PRESSURE_TEST_CONFIRM: CONFIRM_PHRASE, TEST_SUPABASE_URL: "https://testprojectref.supabase.co", TEST_SUPABASE_ANON_KEY: "a", TEST_SUPABASE_SERVICE_ROLE_KEY: "s", PRESSURE_PROMO_CODE: "P" });
      expect(code).toBe(2);
    } finally { process.argv = before; globalThis.fetch = original; console.error = log; }
    expect(calls).toEqual([]);
    expect(errors.join(" ")).toContain("live site");
    expect(errors.join(" ")).not.toContain("service");
  });
});

describe("the money rules checked on the test database", () => {
  const row = (id: string, type: string, delta: number, job: string | null = "j1", user = "u1") => ({ id, user_id: user, delta, type, job_id: job });
  it("a clean job: one reserve, one release of the difference, one charge under the reserve", () => {
    const findings = checkLedger([row("t", "topup", 500, null), row("res_j1", "reserve", -300), row("rel_j1", "release", 300), row("chg_j1", "charge", -120)]);
    expect(findings).toMatchObject({ ok: true, users: 1, jobs: 1 });
  });
  it("catches a second reserve, a second charge, a charge above the reserve, a charge with no reserve and a negative balance", () => {
    expect(checkLedger([row("a", "reserve", -10), row("b", "reserve", -10)]).problems.join(" ")).toContain("2 reserves");
    expect(checkLedger([row("a", "reserve", -10), row("b", "charge", -5), row("c", "charge", -5)]).problems.join(" ")).toContain("2 charges");
    expect(checkLedger([row("t", "topup", 100, null), row("a", "reserve", -10), row("b", "charge", -11)]).problems.join(" ")).toContain("above the reserve");
    expect(checkLedger([row("b", "charge", -5)]).problems.join(" ")).toContain("no reserve");
    expect(checkLedger([row("a", "reserve", -10)]).problems.join(" ")).toContain("below zero");
  });
});

describe("the verdict of a stage", () => {
  const base = { stage: 50, ledger: { ok: true, problems: [], users: 50, jobs: 12 }, failedVisitors: 0, visitors: 50 };
  const chat = (ok: number, count: number, p95: number) => ({ chat_turn: { count, ok, statuses: {}, p50: 100, p95, max: p95 } });
  it("passes when the money is right, nearly every chat answered and it was not too slow", () => {
    expect(stagePassed({ ...base, summary: chat(150, 150, 3000) }).passed).toBe(true);
  });
  it("fails on a ledger problem, on unanswered chats, on slowness and on visitors who could not finish", () => {
    expect(stagePassed({ ...base, ledger: { ok: false, problems: ["job j: 2 reserves"], users: 1, jobs: 1 }, summary: chat(150, 150, 1) }).reasons.join(" ")).toContain("ledger");
    expect(stagePassed({ ...base, summary: chat(100, 150, 1) }).reasons.join(" ")).toContain("answered");
    expect(stagePassed({ ...base, summary: chat(150, 150, 30_000) }).reasons.join(" ")).toContain("20 s");
    expect(stagePassed({ ...base, failedVisitors: 10, summary: chat(150, 150, 1) }).reasons.join(" ")).toContain("could not finish");
    expect(stagePassed({ ...base, summary: {} }).passed).toBe(false);
  });
  it("percentiles and the recorder", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    const recorder = new Recorder();
    recorder.record("x", 200, 10); recorder.record("x", 429, 30); recorder.record("x", "network_error", 50);
    expect(recorder.summary().x).toMatchObject({ count: 3, ok: 1, statuses: { "200": 1, "429": 1, network_error: 1 } });
  });
});

it("a valid preview cannot start the retired pressure run or send a key", async () => {
  const before = process.argv;
  const request = vi.fn();
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", request);
  process.argv = ["node", "run.ts", "--stage", "50", "--base", good.base];
  try {
    expect(await main({
      PRESSURE_TEST_CONFIRM: CONFIRM_PHRASE,
      TEST_SUPABASE_URL: good.testDatabaseUrl,
      TEST_SUPABASE_ANON_KEY: "example-anon",
      TEST_SUPABASE_SERVICE_ROLE_KEY: "example-service",
      PRESSURE_PROMO_CODE: "example-code",
    })).toBe(2);
    expect(report).toHaveBeenCalledWith(expect.stringContaining("retired chat quote actions"));
    expect(request).not.toHaveBeenCalled();
  } finally {
    process.argv = before;
    report.mockRestore();
    vi.unstubAllGlobals();
  }
});
