import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { cleanMutants, loadMutant } from "./helpers/mutants";
import { confirmationFor, type NewsUser } from "../src/lib/launch/newsCampaign";
import { confirmedAt, makeDeps, makeWorld, optedIn } from "./helpers/newsCampaignFakes";
import { signUnsubscribeToken } from "../src/lib/server/unsubscribeToken";
import { makeSettingsDb } from "./helpers/settingsDb";

/**
 * MUTATION TESTS for the launch announcement. Each removes ONE protection from a COPY of the source (tests/helpers/mutants.ts: the real files are
 * never edited; the copies are deleted afterwards) and shows that the guarantee BREAKS. A mutation that no longer applies fails loudly.
 * Fakes only: no network, no real account, no real address, nothing is sent.
 */
const s = vi.hoisted(() => ({ users: [] as any[], updates: [] as any[], sent: [] as any[] }));
(globalThis as any).__settingsDb = makeSettingsDb();
vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (t: string) => (globalThis as any).__settingsDb.from(t),
    auth: { admin: {
      listUsers: async ({ page, perPage }: any) => ({ data: { users: structuredClone(s.users.slice((page - 1) * perPage, page * perPage)) }, error: null }),
      getUserById: async (id: string) => { const u = s.users.find((x) => x.id === id); return u ? { data: { user: structuredClone(u) }, error: null } : { data: { user: null }, error: { message: "nf" } }; },
      updateUserById: async (id: string, patch: any) => { s.updates.push({ id, patch }); Object.assign(s.users.find((x) => x.id === id), patch); return { error: null }; },
    } },
  }),
}));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: async () => ({ ok: true, ctx: { adminId: "admin-1", audit: async () => undefined } }),
}));
vi.mock("../src/lib/server/sendPlatformEmail", async (orig) => ({
  ...(await orig<typeof import("../src/lib/server/sendPlatformEmail")>()),
  sendPlatformEmail: async (template: string, to: string) => { s.sent.push({ template, to }); return { ok: true }; },
}));
afterAll(cleanMutants);

const CAMPAIGN = "src/lib/launch/newsCampaign.ts";
const TOKEN = "src/lib/server/unsubscribeToken.ts";
const UNSUB_ROUTE = "src/app/api/email/unsubscribe/route.ts";
const ADMIN_ROUTE = "src/app/api/admin/launch-email/route.ts";
const KEY = "test-only-service-role-key";
const five = () => ["a", "b", "c", "d", "e"].map((id) => optedIn(id));
const real = (campaign: string, cap: number) => ({ campaign, cap, dryRun: false as const, confirm: confirmationFor(campaign, cap) });

beforeEach(() => { (globalThis as any).__settingsDb = makeSettingsDb(); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", KEY); s.users = []; s.updates = []; s.sent = []; });

describe("MUTATION: who may be mailed", () => {
  const forged: NewsUser = { id: "f", email: "f@example.test", email_confirmed_at: null, user_metadata: { email_verified: true, prefs: { notif: { news: true } } } };

  it("baseline: the real rule refuses a forged email_verified flag and an undefined preference", async () => {
    const real = await import("../src/lib/launch/newsCampaign");
    expect(real.isEligibleForNews(forged)).toBe(false);
    expect(real.isEligibleForNews({ ...optedIn("x"), user_metadata: {} })).toBe(false);
  });

  it("if user_metadata.email_verified counted as confirmation, a forged flag would be mailed", async () => {
    const m = await loadMutant(CAMPAIGN, [{ from: 'if (!user.email_confirmed_at) return "unconfirmed";', to: 'if (!user.email_confirmed_at && user.user_metadata?.email_verified !== true) return "unconfirmed";' }]);
    expect(m.module.isEligibleForNews(forged), "the mutant mails an unconfirmed address").toBe(true);
  });

  it("if prefs.notif.news === true were not required, a customer who never opted in would be mailed", async () => {
    const m = await loadMutant(CAMPAIGN, [{ from: 'if (user.user_metadata?.prefs?.notif?.news !== true) return "not_opted_in";', to: 'if (user.user_metadata?.prefs?.notif?.news === false) return "not_opted_in";' }]);
    expect(m.module.isEligibleForNews({ ...optedIn("x"), user_metadata: {} }), "the mutant treats silence as consent").toBe(true);
    expect(m.module.isEligibleForNews({ ...optedIn("x"), user_metadata: { prefs: { notif: { news: "true" } } } })).toBe(true);
  });

  it("if guests were not excluded, a guest session account would be mailed", async () => {
    const m = await loadMutant(CAMPAIGN, [{ from: 'if (isGuestAccount(user)) return "guest";', to: "" }]);
    expect(m.module.isEligibleForNews(optedIn("g", { user_metadata: { is_guest: true, prefs: { notif: { news: true } } } }))).toBe(true);
  });
});

describe("MUTATION: the runner's guards", () => {
  it("if the send did not RE-CHECK eligibility, a preference flipped after the listing would still be mailed", async () => {
    const flip = (w: ReturnType<typeof makeWorld>) => { w.beforeReread = (id) => { if (id === "b") w.users.find((u) => u.id === "b")!.user_metadata = { prefs: { notif: { news: false } } }; }; };
    const good = makeWorld(five()); flip(good);
    await (await import("../src/lib/launch/newsCampaign")).runNewsCampaign(makeDeps(good), real("c1", 10));
    expect(good.sends.map((x) => x.userId)).not.toContain("b");

    const m = await loadMutant(CAMPAIGN, [{ from: "const reason = newsSkipReason(fresh, ctx);", to: "const reason = null as any;" }]);
    const bad = makeWorld(five()); flip(bad);
    await m.module.runNewsCampaign(makeDeps(bad), real("c1", 10));
    expect(bad.sends.map((x) => x.userId), "the mutant mails someone who just opted out").toContain("b");
  });

  it("if the dry-run default were flipped, a call that says nothing would SEND", async () => {
    const m = await loadMutant(CAMPAIGN, [{ from: "const dryRun = opts.dryRun !== false;", to: "const dryRun = opts.dryRun === true;" }]);
    const bad = makeWorld(five());
    await m.module.runNewsCampaign(makeDeps(bad), { campaign: "c1", cap: 5, confirm: confirmationFor("c1", 5) });
    expect(bad.sends.length, "the mutant sent from a default call").toBeGreaterThan(0);
    const good = makeWorld(five());
    await (await import("../src/lib/launch/newsCampaign")).runNewsCampaign(makeDeps(good), { campaign: "c1", cap: 5, confirm: confirmationFor("c1", 5) });
    expect(good.sends).toEqual([]);
  });

  it("if the confirmation check were removed, a real send without the exact text would go out", async () => {
    const m = await loadMutant(CAMPAIGN, [{ from: 'if (opts.confirm !== confirmationFor(result.campaign, opts.cap)) return refuse("confirm_mismatch");', to: "" }]);
    const bad = makeWorld(five());
    await m.module.runNewsCampaign(makeDeps(bad), { campaign: "c1", cap: 5, dryRun: false });
    expect(bad.sends.length, "the mutant sent without a confirmation").toBeGreaterThan(0);
  });

  it("if the mark were claimed AFTER the send, a crash between the two would double-send on the next run", async () => {
    const m = await loadMutant(CAMPAIGN, [
      { from: "const claimed = await deps.markSent(fresh.id, result.campaign, new Date(deps.now()).toISOString());", to: "const claimed = true;" },
      { from: "if (outcome.ok) {", to: "await deps.markSent(fresh.id, result.campaign, new Date(deps.now()).toISOString());\n      if (outcome.ok) {" },
    ]);
    const bad = makeWorld(five().slice(0, 2));
    await m.module.runNewsCampaign(makeDeps(bad), real("c1", 5));
    const order = bad.events.filter((e) => e.endsWith(":a") && !e.startsWith("list"));
    expect(order, "the mutant sends first").toEqual(["reread:a", "send:a", "claim:a"]);
    const good = makeWorld(five().slice(0, 2));
    await (await import("../src/lib/launch/newsCampaign")).runNewsCampaign(makeDeps(good), real("c1", 5));
    expect(good.events.filter((e) => e.endsWith(":a") && !e.startsWith("list"))).toEqual(["reread:a", "claim:a", "send:a"]);
  });

  it("if the cap were ignored, a run would mail more than it was allowed", async () => {
    const m = await loadMutant(CAMPAIGN, [{ from: 'if (result.sent + result.ambiguous >= cap) { result.stopped = "cap_reached"; break pages; }\n        continue;', to: "continue;" }]);
    const bad = makeWorld(five());
    await m.module.runNewsCampaign(makeDeps(bad), real("c1", 2));
    expect(bad.sends.length, "the mutant exceeded the cap").toBeGreaterThan(2);
  });

  it("if the hard cap of 500 were not applied, a huge cap would send more than 500", async () => {
    const m = await loadMutant(CAMPAIGN, [{ from: "Math.min(opts.cap, LAUNCH_HARD_CAP)", to: "opts.cap" }]);
    const bad = makeWorld(Array.from({ length: 520 }, (_, i) => optedIn(`m${i}`)));
    const r = await m.module.runNewsCampaign(makeDeps(bad, {}, 200), real("c1", 1000));
    expect(r.sent, "the mutant exceeded the hard cap").toBeGreaterThan(500);
  });

  it("if a definite failure kept its claim, the customer would never be retried", async () => {
    const keep = await loadMutant(CAMPAIGN, [{ from: "if (AMBIGUOUS.has(code)) {", to: "if (true) {" }]);
    const w = makeWorld(five().slice(0, 1), [{ ok: false, reason: "resend_rejected" }]);
    await keep.module.runNewsCampaign(makeDeps(w), real("c1", 5));
    expect(w.events, "the mutant keeps the claim of a mail that was rejected").not.toContain("unclaim:a");
    const good = makeWorld(five().slice(0, 1), [{ ok: false, reason: "resend_rejected" }]);
    await (await import("../src/lib/launch/newsCampaign")).runNewsCampaign(makeDeps(good), real("c1", 5));
    expect(good.events).toContain("unclaim:a");
  });

  it("if the 2-consecutive-failure stop were gone, the run would hammer a failing sender", async () => {
    const failing = Array.from({ length: 5 }, () => ({ ok: false, reason: "resend_rejected" }));
    const m = await loadMutant(CAMPAIGN, [{ from: "const MAX_CONSECUTIVE_FAILURES = 2;", to: "const MAX_CONSECUTIVE_FAILURES = 1000;" }]);
    const bad = makeWorld(five(), failing);
    await m.module.runNewsCampaign(makeDeps(bad), real("c1", 10));
    expect(bad.sends.length, "the mutant kept sending after two failures").toBe(5);
    const good = makeWorld(five(), failing);
    await (await import("../src/lib/launch/newsCampaign")).runNewsCampaign(makeDeps(good), real("c1", 10));
    expect(good.sends).toHaveLength(2);
  });
});

describe("MUTATION: unsubscribe", () => {
  const USER = "11111111-2222-4333-8444-555555555555";
  const seed = () => { s.users = [{ id: USER, email: "a@example.test", user_metadata: { prefs: { notif: { news: true, topup: true } } }, app_metadata: {} }]; };
  const token = () => signUnsubscribeToken(USER, KEY);

  it("baseline: the real GET changes nothing", async () => {
    seed();
    const route = await import("../src/app/api/email/unsubscribe/route");
    await route.GET(new NextRequest(`https://diger.test/api/email/unsubscribe?t=${token()}`));
    expect(s.updates).toEqual([]);
  });

  it("if GET performed the change, a mail scanner prefetching the link would unsubscribe the customer", async () => {
    seed();
    const m = await loadMutant(UNSUB_ROUTE, [{ from: "export async function GET(req: NextRequest) {\n  const token = tokenOf(req);", to: "export async function GET(req: NextRequest) {\n  return POST(req);\n  const token = tokenOf(req);" }]);
    await m.module.GET(new NextRequest(`https://diger.test/api/email/unsubscribe?t=${token()}`));
    expect(s.updates.length, "the mutant's GET unsubscribed").toBe(1);
  });

  it("if the update replaced the metadata instead of merging, the customer's other preferences would be lost", async () => {
    seed();
    const m = await loadMutant(UNSUB_ROUTE, [{ from: "user_metadata: { ...meta, prefs: { ...prefs, notif: { ...notif, news: false } } },", to: "user_metadata: { prefs: { notif: { news: false } } }," }]);
    await m.module.POST(new NextRequest(`https://diger.test/api/email/unsubscribe?t=${token()}`, { method: "POST" }));
    expect(s.users[0].user_metadata.prefs.notif.topup, "the mutant lost topup").toBeUndefined();
    seed();
    const real = await import("../src/app/api/email/unsubscribe/route");
    await real.POST(new NextRequest(`https://diger.test/api/email/unsubscribe?t=${token()}`, { method: "POST" }));
    expect(s.users[0].user_metadata.prefs.notif).toEqual({ news: false, topup: true });
  });

  it("if the token verification accepted a wrong signature, anyone could unsubscribe (or forge for) any account", async () => {
    const m = await loadMutant(TOKEN, [{ from: "if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;", to: "ok = true;" }]);
    const t = token();
    const [id, mac] = t.split(".");
    const forgedMac = `${id}.${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}`;
    expect(m.module.verifyUnsubscribeToken(forgedMac, KEY), "the mutant accepts a wrong signature").toBe(USER);
    const realMod = await import("../src/lib/server/unsubscribeToken");
    expect(realMod.verifyUnsubscribeToken(forgedMac, KEY)).toBeNull();
  });
});

describe("MUTATION: the admin route's second lock", () => {
  const call = (route: any) => route.POST(new NextRequest("https://diger.test/api/admin/launch-email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ campaign: "launch-2026-11", cap: 5, dryRun: false, confirm: confirmationFor("launch-2026-11", 5) }) }));
  const seed = () => { s.users = [{ id: "a", email: "a@example.test", email_confirmed_at: confirmedAt, user_metadata: { prefs: { notif: { news: true } } }, app_metadata: {} }]; };

  it("if the LAUNCH_EMAIL_ENABLED check were removed, a confirmed call would send while the lock is closed", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "on");
    vi.stubEnv("LAUNCH_EMAIL_ENABLED", "");
    seed();
    expect((await call(await import("../src/app/api/admin/launch-email/route"))).status).toBe(403);
    expect(s.sent).toEqual([]);

    const m = await loadMutant(ADMIN_ROUTE, [{ from: 'if (process.env.LAUNCH_EMAIL_ENABLED !== "on") {', to: "if (false) {" }]);
    seed();
    await call(m.module);
    expect(s.sent.length, "the mutant sent with the lock closed").toBe(1);
  });
});

describe("MUTATION: review fixes", () => {
  const WIRING = "src/lib/launch/newsCampaignWiring.ts";
  const PAYLOAD = "supabase/functions/send-email/payload.ts";
  const users = (n: number) => Array.from({ length: n }, (_, i) => optedIn(`u${i}`));
  const adminFor = (list: any[], onGet?: (n: number) => void) => { let n = 0; const updates: any[] = []; return { updates, admin: { auth: { admin: {
    getUserById: async (id: string) => { n += 1; onGet?.(n); const u = list.find((x) => x.id === id); return { data: { user: structuredClone(u) }, error: null }; },
    updateUserById: async (id: string, patch: any) => { updates.push(patch); return { error: null }; },
    listUsers: async ({ page }: any) => ({ data: { users: page === 1 ? structuredClone(list) : [] }, error: null }),
  } } } }; };

  it("if the wiring did not add UnsubscribeURL to the vars, the rendered footer link would be empty", async () => {
    const { renderEmailTemplate } = await import("../supabase/functions/send-email/templates");
    const run = async (mod: any) => {
      const captured: any[] = [];
      const deps = mod.createNewsCampaignDeps({ admin: adminFor([optedIn("u1")]).admin, env: { DIGER_STAGE2_LIVE_SHEET: "on" }, siteUrl: "https://diger.tech", signingKey: KEY, send: async (i: any) => { captured.push(i); return { ok: true }; }, log: () => undefined });
      const camp = await import("../src/lib/launch/newsCampaign");
      await camp.runNewsCampaign(deps, real("c1", 5));
      return renderEmailTemplate("news", captured[0].vars).html;
    };
    expect(await run(await import("../src/lib/launch/newsCampaignWiring"))).not.toContain('href=""');
    const m = await loadMutant(WIRING, [{ from: "send: (i) => input.send({ ...i, vars: { ...i.vars, UnsubscribeURL: i.unsubscribeUrl } }),", to: "send: input.send," }]);
    expect(await run(m.module), "the mutant renders an empty unsubscribe link").toContain('href=""');
  });

  it("if the Edge Function did not inject UnsubscribeURL, an app that sent none would produce an empty footer link", async () => {
    const { renderEmailTemplate } = await import("../supabase/functions/send-email/templates");
    const url = "https://diger.tech/api/email/unsubscribe?t=a.b";
    const m = await loadMutant(PAYLOAD, [{ from: "return { ...vars, UnsubscribeURL: unsubscribeUrl };", to: "return vars;" }]);
    expect(renderEmailTemplate("news", m.module.renderVarsWithUnsubscribe({ Name: "x" }, url)).html).toContain('href=""');
    const realMod = await import("../supabase/functions/send-email/payload");
    expect(renderEmailTemplate("news", realMod.renderVarsWithUnsubscribe({ Name: "x" }, url)).html).toContain(`href="${url}"`);
  });

  it("if ambiguous failures did not count toward the cap, alternating timeout/ok would exceed it", async () => {
    const script = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? { ok: false, reason: "timeout" } : { ok: true }));
    const m = await loadMutant(CAMPAIGN, [{ from: "result.ambiguous += 1;", to: "" }]);
    const bad = makeWorld(users(10), script);
    await m.module.runNewsCampaign(makeDeps(bad), real("c1", 3));
    expect(bad.sends.length, "the mutant exceeded the cap").toBeGreaterThan(3);
  });

  it("if the time budget were not enforced, a run would go on past it (a serverless kill mid-send)", async () => {
    const m = await loadMutant(CAMPAIGN, [{ from: "const outOfTime = () => deps.now() - startedAt >= budget;", to: "const outOfTime = () => false;" }]);
    let t = 0;
    const w = makeWorld(users(5));
    const deps = makeDeps(w, { now: () => t, send: async (i) => { t += 20_000; w.sends.push(i as any); return { ok: true }; } });
    const r = await m.module.runNewsCampaign(deps, real("c1", 5));
    expect(r.stopped, "the mutant never stops for time").not.toBe("time_budget");
    expect(w.sends.length).toBe(5);
  });

  it("if markSent used the first (stale) read, another campaign's mark written in between would be lost", async () => {
    const run = async (mod: any) => {
      const list = [{ id: "a", email: "a@example.test", app_metadata: { campaigns: {} } }];
      const f = adminFor(list, (n) => { if (n === 2) list[0].app_metadata = { campaigns: { other2: "t9" } }; });
      const deps = mod.createNewsCampaignDeps({ admin: f.admin, env: {}, siteUrl: "https://diger.tech", signingKey: KEY, send: async () => ({ ok: true }) });
      await deps.markSent("a", "c1", "t1");
      return f.updates[0].app_metadata.campaigns;
    };
    expect(await run(await import("../src/lib/launch/newsCampaignWiring"))).toEqual({ other2: "t9", c1: "t1" });
    const m = await loadMutant(WIRING, [{ from: "const user = await readUser(admin, userId);\n        if (!user || isCampaignMarked(user, campaign)) return false;", to: "const user = first;" }]);
    expect(await run(m.module), "the mutant drops the newer mark").toEqual({ c1: "t1" });
  });

  it("if banned_until were ignored, a barred account would be mailed", async () => {
    const barred = optedIn("x", { banned_until: "2999-01-01T00:00:00Z" });
    const realMod = await import("../src/lib/launch/newsCampaign");
    expect(realMod.isEligibleForNews(barred)).toBe(false);
    const m = await loadMutant(CAMPAIGN, [{ from: 'if (Number.isNaN(until) || until > (ctx.now ?? Date.now)()) return "banned";', to: "" }]);
    expect(m.module.isEligibleForNews(barred), "the mutant mails a barred account").toBe(true);
  });
});
