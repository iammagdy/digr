import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPoolKey, runPoolHealth, HEALTH_MAX_KEYS_PER_RUN } from "../src/lib/server/tregPoolHealth";
import { buildPoolAlertVars, flushPoolAlerts, poolReasonAr } from "../src/lib/server/tregPoolAlerts";
import { clock, makePoolWorld, teardownPoolWorld, type TregMode } from "./helpers/tregPoolKit";
import { captureConsole } from "./helpers/providerKeyTestKit";

const send = vi.fn(async (..._args: any[]) => ({ ok: true }));
let world: ReturnType<typeof makePoolWorld>;
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => world.db.client }));
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: (...a: any[]) => send(...a) }));

/**
 * The background health check: cheap READ-ONLY TREG calls only, at most one run per 10 minutes whoever calls, a transient answer never marks a key bad, a bad non-active key opens one
 * e-mail, the active key found bad moves the pool on, and the e-mails are short Arabic texts with a number and a label and never a key.
 */
let logs: ReturnType<typeof captureConsole>;
beforeEach(() => { logs = captureConsole(); send.mockClear(); send.mockImplementation(async () => ({ ok: true })); world = makePoolWorld(); vi.stubEnv("ADMIN_ALERT_EMAIL", "owner@example.test"); vi.stubEnv("CRON_SECRET", "cron-test-secret"); });
afterEach(() => { logs.restore(); teardownPoolWorld(); });

const READ_ONLY = /^\/(auth\/me|orgs\/[^/]+\/balance)$/;

describe("checking one key (identity read + balance read, nothing billed)", () => {
  it.each<[string, TregMode, number, string | null, string]>([
    ["a healthy key with balance", "ok", 1_000_000, "connected", "ok"],
    ["a key at or under the minimum balance", "ok", 10_000, "out_of_balance", "balance_low"],
    ["a revoked key", "revoked", 1_000_000, "revoked", "auth_401"],
  ])("%s", async (_n, mode, balance, status, reason) => {
    const k = world.addKey({ tregMode: mode, balanceMicro: balance });
    const r = await checkPoolKey(k.plaintext, { fetchFn: world.treg.fetch as any });
    expect(r).toMatchObject({ status, reason });
    if (mode === "ok") expect(r.balanceMicro).toBe(balance);
    expect(r.email).toBe(mode === "ok" ? k.row.account_email : null);
  });

  it("a timeout or a 5xx is transient: no status at all (and one retry before giving up)", async () => {
    const k = world.addKey();
    world.treg.set(k.plaintext, { meMode: "timeout" });
    expect(await checkPoolKey(k.plaintext, { fetchFn: world.treg.fetch as any })).toMatchObject({ status: null, reason: "transient_timeout" });
    expect(world.treg.requests.filter((q) => q.path === "/auth/me")).toHaveLength(2);
    world.treg.set(k.plaintext, { meMode: "http503" });
    expect(await checkPoolKey(k.plaintext, { fetchFn: world.treg.fetch as any })).toMatchObject({ status: null, reason: "transient_server_error" });
  });

  it("an unexpected 4xx is «error»; an answer with no team id passes the identity read but claims no status (a balance that cannot be read is not «connected»)", async () => {
    const fetch418 = vi.fn(async () => new Response("{}", { status: 418 }));
    expect(await checkPoolKey("testonly-x-0000000000", { fetchFn: fetch418 as any })).toMatchObject({ status: "error", reason: "http_418" });
    const noOrg = vi.fn(async () => new Response(JSON.stringify({ email: "a@b.co" }), { status: 200 }));
    expect(await checkPoolKey("testonly-x-0000000000", { fetchFn: noOrg as any })).toMatchObject({ status: null, reason: "org_unknown", balanceMicro: null, identityOk: true });
  });
});

describe("a health run over the pool", () => {
  it("records every key's status, balance and e-mail; only read-only endpoints are called; a transient result leaves the status alone", async () => {
    const main = world.addKey({ isMain: true });
    const ok = world.addKey({ balanceMicro: 700_000, status: "unknown" });
    const dead = world.addKey({ tregMode: "revoked" });
    const empty = world.addKey({ balanceMicro: 0 });
    const blip = world.addKey({ status: "connected" });
    world.treg.set(blip.plaintext, { meMode: "http503" });
    const out = await runPoolHealth({ client: world.db.client, pool: world.pool, fetchFn: world.treg.fetch as any, now: clock.now });
    expect(out).toMatchObject({ ok: true, checked: 5, connected: 2, broken: 2, transient: 1 });
    expect(world.db.byId(ok.id)).toMatchObject({ status: "connected", balance_micro: 700_000 });
    expect(world.db.byId(dead.id)?.status).toBe("revoked");
    expect(world.db.byId(empty.id)?.status).toBe("out_of_balance");
    expect(world.db.byId(blip.id)).toMatchObject({ status: "connected", status_reason: "transient_server_error" });
    expect(world.db.byId(main.id)?.status).toBe("connected");
    expect(world.treg.requests.every((q) => READ_ONLY.test(q.path))).toBe(true);
    expect(world.treg.callCount()).toBe(0);
  });

  it("runs while the rollout switch is OFF (the table is useful before it is turned on)", async () => {
    world.addKey({ isMain: true }); const k = world.addKey({ tregMode: "empty" });
    expect(world.db.state.rollout_on).toBe(false);
    const out = await runPoolHealth({ client: world.db.client, pool: world.pool, fetchFn: world.treg.fetch as any, now: clock.now });
    expect(out.checked).toBe(2);
    expect(world.db.byId(k.id)?.status).toBe("connected"); // the fake TREG's /auth/me and balance are fine: «empty» only refuses billed calls
  });

  it("a NON-active key turning bad opens ONE health_broken alert, its repeat opens none; connected again clears it", async () => {
    world.addKey({ isMain: true }); const a = world.addKey(); const b = world.addKey({ tregMode: "revoked" });
    world.switchOn(a.id);
    const run = () => runPoolHealth({ client: world.db.client, pool: world.pool, fetchFn: world.treg.fetch as any, now: clock.now });
    await run(); await run();
    expect(world.db.alerts.filter((x) => x.problem === "health_broken" && x.key_id === b.id)).toHaveLength(1);
    world.treg.set(b.plaintext, { mode: "ok" });
    await run();
    expect(world.db.alerts.find((x) => x.problem === "health_broken")?.cleared).toBe(true);
  });

  it("the ACTIVE key found revoked moves the pool on at once (the failover e-mail, not a health one)", async () => {
    const main = world.addKey({ isMain: true }); const a = world.addKey({ tregMode: "revoked" }); const b = world.addKey();
    world.switchOn(a.id);
    const out = await runPoolHealth({ client: world.db.client, pool: world.pool, fetchFn: world.treg.fetch as any, now: clock.now });
    expect(out.failovers).toBe(1);
    expect(world.db.state.active_key_id).toBe(b.id);
    expect(world.db.alerts.map((x) => x.problem)).toEqual(["failover"]);
    expect(world.db.events.at(-1)).toMatchObject({ kind: "failover", source: "health" });
    expect(main.plaintext).not.toBe(b.plaintext);
  });

  it("100 keys are all checked in one run with bounded concurrency; more than the per-run limit continues in the next run, oldest check first", async () => {
    for (let i = 0; i < 120; i += 1) world.addKey({ balanceMicro: 500_000 });
    let running = 0; let peak = 0;
    const slow = vi.fn(async (input: any, init: any) => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 1)); running -= 1; return world.treg.fetch(input, init); });
    const out = await runPoolHealth({ client: world.db.client, pool: world.pool, fetchFn: slow as any, now: clock.now });
    expect(out.checked).toBe(120);
    expect(peak).toBeLessThanOrEqual(8);
    clock.advance(60_000);
    for (let i = 0; i < 100; i += 1) world.addKey({ balanceMicro: 500_000 });
    const second = await runPoolHealth({ client: world.db.client, pool: world.pool, fetchFn: world.treg.fetch as any, now: clock.now });
    expect(second.checked).toBe(HEALTH_MAX_KEYS_PER_RUN);
    // 220 keys, 200 per run: the 100 never-checked ones first, then the 100 checked longest ago; the 20 left over are the ones checked most recently (the first run's last)
    const secondRunAt = new Date(clock.t).toISOString();
    const notRechecked = world.db.live().filter((k) => k.status_checked_at !== secondRunAt);
    expect(notRechecked).toHaveLength(20);
    expect(notRechecked.every((k) => k.status_checked_at !== null)).toBe(true);
  });

  it("says why nothing ran: SQL 06 not applied, or the Vault key unreadable", async () => {
    world.addKey({ isMain: true });
    world.db.flags.noCheckFn = true;
    expect(await runPoolHealth({ client: world.db.client, pool: world.pool, fetchFn: world.treg.fetch as any })).toMatchObject({ ok: false, problem: "sql_not_ready", checked: 0 });
    world.db.flags.noCheckFn = false; world.db.flags.encMissing = true; world.pool.invalidate();
    const fresh = makePoolWorld(); fresh.db.flags.encMissing = true; fresh.db.addKey({ isMain: true });
    expect(await runPoolHealth({ client: fresh.db.client, pool: fresh.pool, fetchFn: fresh.treg.fetch as any })).toMatchObject({ ok: false, problem: "encryption_unavailable" });
  });
});

describe("the cron route: at most one health run per 10 minutes, e-mails sent once", () => {
  const route = async () => (await import("../src/app/api/cron/treg-pool/route")).GET;
  const call = async (secret?: string) => (await route())(new NextRequest("http://localhost/api/cron/treg-pool", { headers: secret ? { authorization: `Bearer ${secret}` } : {} }));

  it("refuses a request without the cron secret and touches nothing", async () => {
    world.addKey({ isMain: true });
    const res = await call();
    expect(res.status).toBe(401);
    expect(world.db.rpcLog).toHaveLength(0);
  });

  it("the first call claims and runs the check; a second one within 10 minutes only sends e-mails; after 10 minutes it runs again", async () => {
    world.addKey({ isMain: true }); world.addKey();
    const first = await (await call("cron-test-secret")).json();
    expect(first).toMatchObject({ success: true, claimed: true, health: { checked: 2 } });
    const calls = () => world.treg.requests.length;
    const before = calls();
    const second = await (await call("cron-test-secret")).json();
    expect(second.claimed).toBe(false);
    expect(calls()).toBe(before);
    clock.advance(10 * 60_000 + 1000);
    const third = await (await call("cron-test-secret")).json();
    expect(third.claimed).toBe(true);
  });

  it("a key found broken becomes ONE e-mail through the existing path, with the Arabic text, to ADMIN_ALERT_EMAIL", async () => {
    world.addKey({ isMain: true }); world.addKey(); const dead = world.addKey({ tregMode: "revoked", label: "اختبار-٤" });
    await call("cron-test-secret");
    clock.advance(10 * 60_000 + 1000);
    await call("cron-test-secret"); // the same problem again: no second e-mail
    expect(send).toHaveBeenCalledTimes(1);
    const [template, to, vars, key] = send.mock.calls[0];
    expect(template).toBe("job-update");
    expect(to).toBe("owner@example.test");
    expect(vars.Subject).toContain("لا يعمل");
    expect(vars.Lead).toContain("اختبار-٤");
    expect(String(key)).toMatch(/^treg-pool-alert:\d+$/);
    expect(JSON.stringify(send.mock.calls)).not.toContain(dead.plaintext);
  });

  it("without ADMIN_ALERT_EMAIL nothing is sent and the alert waits (the cron never throws)", async () => {
    vi.stubEnv("ADMIN_ALERT_EMAIL", "");
    world.addKey({ isMain: true }); world.addKey({ tregMode: "revoked" });
    const res = await call("cron-test-secret");
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(world.db.alerts.every((a) => !a.emailed)).toBe(true);
  });
});

describe("the admin e-mails (Arabic, short, one per key per problem)", () => {
  const row = (over: Record<string, unknown>) => ({ problem: "failover" as const, key_number: 2, key_label: "اختبار-٢", to_key_number: 3, to_key_label: "اختبار-٣", reason: "revoked", created_at: new Date(clock.t).toISOString(), ...over });

  it("failover: the key that stopped, why, and where the platform moved to; no key", () => {
    const v = buildPoolAlertVars(row({}));
    expect(v.Subject).toBe("تنبيه: انتقلت المنصة إلى مفتاح TREG رقم ٣");
    expect(v.Lead).toContain("رقم ٢ (اختبار-٢)");
    expect(v.Lead).toContain("رقم ٣ (اختبار-٣)");
    expect(v.Lead).toContain("أُلغي");
    expect(buildPoolAlertVars(row({ reason: "out_of_balance" })).Lead).toContain("انتهى رصيده");
    expect(v.JobURL).toMatch(/\/admin\/providers$/);
  });

  it("chain reached main, health_broken, main_failed, store_unreadable each have their own short text", () => {
    expect(buildPoolAlertVars(row({ problem: "chain_reached_main", key_number: 1, key_label: "الرئيسي" })).Subject).toBe("تنبيه: المنصة تعمل الآن على المفتاح الرئيسي");
    expect(buildPoolAlertVars(row({ problem: "health_broken", key_number: 4, key_label: "اختبار-٤", reason: "out_of_balance" })).Subject).toBe("تنبيه: مفتاح TREG رقم ٤ لا يعمل");
    expect(buildPoolAlertVars(row({ problem: "main_failed", key_number: 1, key_label: "الرئيسي" })).Subject).toBe("عاجل: المفتاح الرئيسي لـ TREG لا يعمل");
    const store = buildPoolAlertVars(row({ problem: "store_unreadable", key_number: null, key_label: null, reason: "decrypt_failed" }));
    expect(store.Lead).toContain("TREG_TOKEN");
    expect(store.Lead).toContain("لم يُستخدم أي مفتاح اختبار");
    for (const p of ["failover", "chain_reached_main", "health_broken", "main_failed", "store_unreadable"] as const) {
      const v = buildPoolAlertVars(row({ problem: p }));
      expect(`${v.Subject}${v.Lead}${v.DetailOne}${v.DetailTwo}`).not.toMatch(/[A-Za-z0-9]{24,}/); // no key-like string anywhere
    }
    expect(poolReasonAr("auth_403")).toBe("أُلغي أو رفضه المزود");
  });

  it("the outbox: 1,000 failing reports make one row; the e-mail is sent once, retried when sending fails (at most 5 times), and never twice after success", async () => {
    world.addKey({ isMain: true }); const a = world.addKey();
    for (let i = 0; i < 1000; i += 1) world.db.client.rpc("treg_pool_claim_alert", { p_problem: "health_broken", p_key_id: a.id, p_reason: "revoked", p_to_key_id: null });
    await Promise.resolve();
    expect(world.db.alerts).toHaveLength(1);
    send.mockImplementationOnce(async () => ({ ok: false })).mockImplementationOnce(async () => ({ ok: false }));
    const deps = { client: world.db.client, env: { ADMIN_ALERT_EMAIL: "owner@example.test" }, log: () => undefined };
    expect(await flushPoolAlerts(deps)).toMatchObject({ taken: 1, sent: 0, failed: 1 });
    expect(await flushPoolAlerts(deps)).toMatchObject({ taken: 1, sent: 0, failed: 1 });
    expect(await flushPoolAlerts(deps)).toMatchObject({ taken: 1, sent: 1, failed: 0 });
    expect(await flushPoolAlerts(deps)).toMatchObject({ taken: 0 });
    expect(world.db.alerts[0].emailed).toBe(true);
    // a lease keeps two overlapping runs from sending one alert twice
    world.db.alerts.push({ ...world.db.alerts[0], id: 99, emailed: false, attempts: 0, lease: 0, scope: "other" });
    const [x, y] = await Promise.all([flushPoolAlerts(deps), flushPoolAlerts(deps)]);
    expect(x.sent + y.sent).toBe(1);
  });
});
