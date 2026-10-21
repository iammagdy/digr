import { describe, expect, it } from "vitest";
import { CONFIRM_PHRASE, STAGES, checkLedger, safetyProblems, stagePassed, Recorder, percentile } from "../scripts/pressure/lib";
import { runStage, main, type Config } from "../scripts/pressure/run";

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

/** A stand-in for the preview and the test database, in memory: the real script runs against it. */
function standIn(options: { doubleReserve?: boolean } = {}) {
  const base = "https://stand-in.vercel.app";
  const db = "https://standin.supabase.co";
  const ledger: any[] = [];
  const jobs = new Map<string, { polls: number; user: string }>();
  const seen: string[] = [];
  let users = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: any, init: any = {}) => {
    const u = String(url);
    seen.push(`${init.method || "GET"} ${u.replace(base, "").replace(db, "DB").split("?")[0]}`);
    const auth = String(init.headers?.authorization || "");
    const user = auth.replace("Bearer ", "");
    if (u.startsWith(`${db}/auth/v1/admin/users`)) return json({ id: `user_${users++}` });
    if (u.startsWith(`${db}/auth/v1/token`)) return json({ access_token: JSON.parse(init.body).email });
    if (u.startsWith(`${base}/api/busy-status`)) return json({ busy: false });
    if (u.startsWith(`${base}/api/wallet/redeem`)) { ledger.push({ id: `top_${user}`, user_id: user, delta: 1000, type: "topup", job_id: null }); return json({ success: true }); }
    if (u.startsWith(`${base}/api/wallet/balance`)) return json({ success: true, balance: 1000 });
    if (u.startsWith(`${base}/api/chat/accept-quote`)) {
      const jobId = `job_${user}`;
      jobs.set(jobId, { polls: 0, user });
      ledger.push({ id: `res_${jobId}`, user_id: user, delta: -300, type: "reserve", job_id: jobId });
      if (options.doubleReserve) ledger.push({ id: `res2_${jobId}`, user_id: user, delta: -300, type: "reserve", job_id: jobId });
      return json({ success: true, jobId });
    }
    if (u.startsWith(`${base}/api/chat`)) {
      const message = JSON.parse(init.body).message as string;
      return json({ success: true, conversationId: `conv_${user}`, ...(message.includes("تعليق") ? { planQuote: { quoteId: `q_${user}`, planHash: "h".repeat(64) } } : {}) });
    }
    if (u.startsWith(`${db}/rest/v1/jobs`)) {
      const id = /id=eq\.([^&]+)/.exec(u)![1];
      const job = jobs.get(id)!;
      job.polls += 1;
      if (job.polls >= 2) ledger.push({ id: `chg_${id}_${job.polls}`, user_id: job.user, delta: -120, type: "charge", job_id: id });
      return json([{ status: job.polls >= 2 ? "completed" : "running", delivered_units: 30 }]);
    }
    if (u.includes("/nudge") || u.includes("/data") || u.includes("/download")) return json({ success: true });
    if (u.startsWith(`${db}/rest/v1/credit_ledger`)) {
      const offset = Number(/offset=(\d+)/.exec(u)![1]);
      const wanted = new Set(decodeURIComponent(/user_id=in\.\(([^)]*)\)/.exec(u)![1]).split(","));
      const relevant = ledger.filter((entry) => true);
      return json(relevant.slice(offset, offset + 1000));
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchImpl, ledger, seen, base, db };
}

describe("the staged script, run against an in-memory stand-in of the preview and the test database", () => {
  const config = (s: ReturnType<typeof standIn>): Config => ({ base: s.base, dbUrl: s.db, anonKey: "anon", serviceKey: "service", promoCode: "PROMO", bypass: undefined, stage: 50, out: "unused.json" });
  const deps = (s: ReturnType<typeof standIn>) => ({ fetch: s.fetchImpl, sleep: async () => undefined, signInPerMinute: 1_000_000, thinkMs: 0, pollMs: 0 });

  it("stage 50: 50 visitors, a quarter start a mission, the ledger is clean and the stage passes", async () => {
    const s = standIn();
    const result = await runStage(config(s), deps(s));
    expect(result.visitors).toBe(50);
    expect(result.jobs).toBe(Math.round(STAGES[50].visitors * STAGES[50].missionShare));
    expect(result.failedVisitors).toBe(0);
    expect(result.summary.chat_turn.count).toBe(50 * STAGES[50].chatTurns);
    expect(result.summary.accept_quote.count).toBe(result.jobs);
    expect(result.summary.results_view.count).toBe(result.jobs);
    expect(result.summary.download_xlsx.count).toBe(result.jobs);
    expect(result.ledger.ok).toBe(true);
    expect(result.verdict.passed).toBe(true);
  });

  it("a second reserve for one job is found and fails the stage", async () => {
    const s = standIn({ doubleReserve: true });
    const result = await runStage(config(s), deps(s));
    expect(result.ledger.ok).toBe(false);
    expect(result.ledger.problems.join(" ")).toContain("2 reserves");
    expect(result.verdict.passed).toBe(false);
  });

  it("never prints or sends a key where it does not belong: the service key goes only to the test database", async () => {
    const s = standIn();
    const sent: Array<{ url: string; auth: string }> = [];
    const wrapped = (async (url: any, init: any = {}) => { sent.push({ url: String(url), auth: String(init.headers?.authorization || "") + String(init.headers?.apikey || "") }); return s.fetchImpl(url, init); }) as typeof fetch;
    await runStage(config(s), { ...deps(s), fetch: wrapped });
    for (const call of sent.filter((entry) => entry.auth.includes("service"))) expect(call.url.startsWith(s.db)).toBe(true);
  });
});
