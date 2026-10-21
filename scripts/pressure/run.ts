/**
 * Staged pressure test: N virtual visitors against a PREVIEW deployment (fake provider) and a SEPARATE test database.
 * Run by the owner, never by an agent, never against the live site (docs/PRESSURE_TEST_RUNBOOK.md):
 *
 *   PRESSURE_TEST_CONFIRM=preview-and-test-database \
 *   TEST_SUPABASE_URL=... TEST_SUPABASE_ANON_KEY=... TEST_SUPABASE_SERVICE_ROLE_KEY=... PRESSURE_PROMO_CODE=... \
 *   [PRESSURE_BYPASS_TOKEN=...] npx tsx scripts/pressure/run.ts --stage 50 --base https://<preview>.vercel.app
 *
 * Keys are read from the environment and never printed. Everything a visitor does goes through the same routes and the same direct
 * database reads as the real pages. The money rules are checked on the test database at the end (checkLedger).
 */
import { writeFileSync } from "node:fs";
import { Recorder, STAGES, checkLedger, safetyProblems, stagePassed, type LedgerRow, type StageResult } from "./lib";

const PLAN_REQUEST = "٣٠ تعليق على تيك توك عن كرة القدم خلال الشهر الماضي";
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

export interface Config {
  base: string; dbUrl: string; anonKey: string; serviceKey: string; promoCode: string; bypass: string | undefined; stage: number; out: string;
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const config: Config = {
    base: (arg("base") || "").replace(/\/$/, ""),
    dbUrl: (env.TEST_SUPABASE_URL || "").replace(/\/$/, ""),
    anonKey: env.TEST_SUPABASE_ANON_KEY || "",
    serviceKey: env.TEST_SUPABASE_SERVICE_ROLE_KEY || "",
    promoCode: env.PRESSURE_PROMO_CODE || "",
    bypass: env.PRESSURE_BYPASS_TOKEN || undefined,
    stage: Number(arg("stage") || 0),
    out: arg("out") || `pressure-stage-${arg("stage") || "x"}.json`,
  };
  const problems = safetyProblems({ base: config.base, testDatabaseUrl: config.dbUrl, confirm: env.PRESSURE_TEST_CONFIRM, stage: config.stage, allow500: flag("yes-500") });
  if (!config.anonKey || !config.serviceKey) problems.push("TEST_SUPABASE_ANON_KEY and TEST_SUPABASE_SERVICE_ROLE_KEY must be set (the TEST project's keys)");
  if (!config.promoCode) problems.push("PRESSURE_PROMO_CODE must be set (a promo code created in the TEST project's admin, with enough redemptions)");
  if (problems.length) {
    console.error("NOT STARTED:\n- " + problems.join("\n- "));
    return 2;
  }
  const stage = STAGES[config.stage];
  if (flag("dry-run")) {
    console.log(JSON.stringify({ dryRun: true, base: config.base, stage: config.stage, ...stage }, null, 2));
    return 0;
  }
  const result = await runStage(config, { fetch: globalThis.fetch.bind(globalThis), sleep, signInPerMinute: Number(env.PRESSURE_SIGNIN_PER_MINUTE || 20), thinkMs: 4000, pollMs: 4000 });
  writeFileSync(config.out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ stage: config.stage, visitors: result.visitors, jobs: result.jobs, failedVisitors: result.failedVisitors, ledger: result.ledger.ok ? "ok" : result.ledger.problems.slice(0, 5), chatTurn: result.summary.chat_turn, verdict: result.verdict }, null, 2));
  return result.verdict.passed ? 0 : 1;
}

export interface Deps { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; signInPerMinute: number; thinkMs: number; pollMs: number }

/** The stage itself. The safety checks are NOT here: `main` runs them before calling this. Tests call it with a stand-in fetch. */
export async function runStage(config: Config, deps: Deps): Promise<StageResult & { jobs: number; verdict: { passed: boolean; reasons: string[] } }> {
  const stage = STAGES[config.stage];
  const { sleep } = deps;
  const recorder = new Recorder();
  const headers = (token?: string, extra: Record<string, string> = {}): Record<string, string> => ({
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(config.bypass ? { "x-vercel-protection-bypass": config.bypass } : {}),
    ...extra,
  });
  const timed = async (step: string, url: string, init: RequestInit): Promise<{ status: number; json: any }> => {
    const started = performance.now();
    try {
      const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(70_000) });
      const json = await res.json().catch(() => null);
      recorder.record(step, res.status, performance.now() - started);
      return { status: res.status, json };
    } catch {
      recorder.record(step, "network_error", performance.now() - started);
      return { status: 0, json: null };
    }
  };

  // 1. Test accounts: created and confirmed with the test project's admin key (never the live project: safetyProblems refused that).
  const users: Array<{ email: string; id: string; token: string }> = [];
  const password = `Pt-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
  const runId = Date.now().toString(36);
  for (let i = 0; i < stage.visitors; i += 1) {
    const email = `pressure-${runId}-${i}@example.test`;
    const created = await timed("setup_create_user", `${config.dbUrl}/auth/v1/admin/users`, { method: "POST", headers: { "content-type": "application/json", apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` }, body: JSON.stringify({ email, password, email_confirm: true }) });
    if (created.status >= 300 || !created.json?.id) continue;
    users.push({ email, id: created.json.id, token: "" });
  }
  // 2. Sign-in, paced: the sign-in service limits sign-ins per address (docs/SUPABASE_FREE_PLAN.md), so the test paces itself.
  const signInPerMinute = deps.signInPerMinute;
  for (const user of users) {
    const res = await timed("setup_sign_in", `${config.dbUrl}/auth/v1/token?grant_type=password`, { method: "POST", headers: { "content-type": "application/json", apikey: config.anonKey }, body: JSON.stringify({ email: user.email, password }) });
    user.token = res.json?.access_token || "";
    await sleep(Math.round(60_000 / signInPerMinute));
  }
  const ready = users.filter((user) => user.token);

  // 3. Visitors, ramped over the stage's seconds.
  let failedVisitors = 0;
  const jobIds: string[] = [];
  const visit = async (user: { token: string }, index: number) => {
    try {
      await timed("busy_status", `${config.base}/api/busy-status`, { headers: headers() });
      await timed("promo_redeem", `${config.base}/api/wallet/redeem`, { method: "POST", headers: headers(user.token), body: JSON.stringify({ code: config.promoCode }) });
      await timed("balance", `${config.base}/api/wallet/balance`, { headers: headers(user.token) });
      let conversationId: string | undefined;
      let quote: { quoteId?: string; planHash?: string } | null = null;
      for (let turn = 0; turn < stage.chatTurns; turn += 1) {
        const message = turn === 0 ? "مرحبا" : PLAN_REQUEST;
        const res = await timed("chat_turn", `${config.base}/api/chat`, { method: "POST", headers: headers(user.token), body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }) });
        conversationId = res.json?.conversationId || conversationId;
        if (res.json?.planQuote?.quoteId) quote = res.json.planQuote;
        await sleep(jitter(deps.thinkMs));
      }
      const mission = index < Math.round(stage.visitors * stage.missionShare);
      if (!mission) return;
      if (!quote?.quoteId) { failedVisitors += 1; return; }
      const accepted = await timed("accept_quote", `${config.base}/api/chat/accept-quote`, { method: "POST", headers: headers(user.token), body: JSON.stringify({ quoteId: quote.quoteId, expectedPlanHash: quote.planHash, explicitApproval: true }) });
      const jobId = accepted.json?.jobId;
      if (!jobId) { failedVisitors += 1; return; }
      jobIds.push(jobId);
      // follows the job like the page: reads the row directly, nudges when it does not move (the tab drives long jobs)
      let status = "queued";
      for (let tick = 0; tick < 100 && !["completed", "failed", "refused"].includes(status); tick += 1) {
        await sleep(jitter(deps.pollMs));
        const row = await timed("job_poll", `${config.dbUrl}/rest/v1/jobs?id=eq.${jobId}&select=status,delivered_units`, { headers: { apikey: config.anonKey, authorization: `Bearer ${user.token}` } });
        status = row.json?.[0]?.status || status;
        if (tick % 4 === 3 && !["completed", "failed", "refused"].includes(status)) await timed("nudge", `${config.base}/api/jobs/${jobId}/nudge`, { method: "POST", headers: headers(user.token), body: "{}" });
      }
      if (status !== "completed") { failedVisitors += 1; return; }
      await timed("results_view", `${config.base}/api/jobs/${jobId}/data`, { headers: headers(user.token) });
      await timed("download_xlsx", `${config.base}/api/jobs/${jobId}/download?format=xlsx`, { headers: headers(user.token) });
    } catch {
      failedVisitors += 1;
    }
  };
  const gap = Math.round((stage.rampSeconds * 1000) / Math.max(1, ready.length));
  await Promise.all(ready.map(async (user, index) => { await sleep(index * gap); await visit(user, index); }));

  // 4. The money rules, on the test database.
  const rows: LedgerRow[] = [];
  const ids = ready.map((user) => user.id);
  for (let at = 0; at < ids.length; at += 50) {
    const slice = ids.slice(at, at + 50);
    for (let page = 0; page < 20; page += 1) {
      const res = await deps.fetch(`${config.dbUrl}/rest/v1/credit_ledger?user_id=in.(${slice.join(",")})&select=id,user_id,delta,type,job_id&order=created_at.asc&limit=1000&offset=${page * 1000}`, { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } });
      const batch = (await res.json().catch(() => [])) as LedgerRow[];
      rows.push(...batch);
      if (batch.length < 1000) break;
    }
  }
  const result: StageResult = { stage: config.stage, summary: recorder.summary(), ledger: checkLedger(rows), failedVisitors, visitors: ready.length };
  return { ...result, jobs: jobIds.length, verdict: stagePassed(result) };
}

if (process.argv[1] && /pressure[\\/]run\.ts$/.test(process.argv[1])) {
  main().then((code) => process.exit(code), () => { console.error("The run stopped on an unexpected error."); process.exit(3); });
}
