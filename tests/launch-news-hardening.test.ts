import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cleanMutants, loadMutant } from "./helpers/mutants";
import { makeSettingsDb } from "./helpers/settingsDb";
import { confirmationFor, isCampaignMarked, runNewsCampaign, safeGreetingName } from "../src/lib/launch/newsCampaign";
import { createNewsCampaignDeps } from "../src/lib/launch/newsCampaignWiring";
import { LAUNCH_LOCK_LEASE_MS, acquireLaunchLock, launchLockKey, releaseLaunchLock } from "../src/lib/launch/launchLock";
import { signUnsubscribeToken, unsubscribeKeyFromEnv, unsubscribeVerifyKeysFromEnv, verifyUnsubscribeToken } from "../src/lib/server/unsubscribeToken";
import { emailFailureReason } from "../src/lib/server/sendPlatformEmail";
import { confirmedAt, makeDeps, makeWorld, optedIn } from "./helpers/newsCampaignFakes";

/**
 * Hardening of the launch announcement after the independent review of PR #425. FAKES only: an in-memory sign-in service, an in-memory
 * `agent_settings` table, a scripted sender. Nothing reaches a network, a real account or a real address; nothing is sent.
 *  1. one real run at a time (the per-recipient claim is not atomic)         2. a delivery whose outcome is uncertain keeps its claim
 *  3. the unsubscribe link answers 503 (retry) when the sign-in service is down, never "invalid link"
 *  4. signing-key rotation does not kill links already mailed                5. a customer-controlled name cannot break a send
 *  6. a campaign called "constructor" is not read through the prototype      7. the settings page cannot undo an unsubscribe from a stale tab
 */
const s = vi.hoisted(() => ({ users: [] as any[], sent: [] as any[], getError: null as null | { status?: number; code?: string; message: string }, updates: [] as any[], audits: [] as any[] }));
(globalThis as any).__settingsDb = makeSettingsDb();

vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (t: string) => (globalThis as any).__settingsDb.from(t),
    auth: { admin: {
      listUsers: async ({ page, perPage }: any) => ({ data: { users: structuredClone(s.users.slice((page - 1) * perPage, page * perPage)) }, error: null }),
      getUserById: async (id: string) => {
        if (s.getError) return { data: { user: null }, error: s.getError };
        const u = s.users.find((x) => x.id === id);
        return u ? { data: { user: structuredClone(u) }, error: null } : { data: { user: null }, error: { status: 404, code: "user_not_found", message: "User not found" } };
      },
      updateUserById: async (id: string, patch: any) => { s.updates.push({ id, patch }); Object.assign(s.users.find((x) => x.id === id), patch); return { data: {}, error: null }; },
    } },
  }),
}));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: async () => ({ ok: true, ctx: { adminId: "admin-1", audit: async (kind: string, label: string) => { s.audits.push({ kind, label }); } } }),
}));
vi.mock("../src/lib/server/sendPlatformEmail", async (orig) => ({
  ...(await orig<typeof import("../src/lib/server/sendPlatformEmail")>()),
  sendPlatformEmail: async (template: string, to: string, vars: any, key: string) => { s.sent.push({ template, to, vars, key }); return { ok: true }; },
}));
afterAll(cleanMutants);

const KEY = "test-only-service-role-key";
const CAMPAIGN = "launch-2026-11";
const ROUTE = "src/app/api/admin/launch-email/route.ts";
const LOCK = "src/lib/launch/launchLock.ts";
const CAMPAIGN_SRC = "src/lib/launch/newsCampaign.ts";
const UNSUB_ROUTE = "src/app/api/email/unsubscribe/route.ts";
const real = (campaign: string, cap: number) => ({ campaign, cap, dryRun: false as const, confirm: confirmationFor(campaign, cap) });
const settings = () => (globalThis as any).__settingsDb as ReturnType<typeof makeSettingsDb>;
const adminCall = (route: any, body: object = real(CAMPAIGN, 5)) => route.POST(new NextRequest("https://diger.test/api/admin/launch-email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const USER = "11111111-2222-4333-8444-555555555555";
const unsubPost = (route: any, token: string) => route.POST(new NextRequest(`https://diger.test/api/email/unsubscribe?t=${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` }, body: "List-Unsubscribe=One-Click" }));

beforeEach(() => {
  (globalThis as any).__settingsDb = makeSettingsDb();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", KEY);
  vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "on");
  vi.stubEnv("LAUNCH_EMAIL_ENABLED", "on");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://diger.tech");
  s.users = [optedIn("a"), optedIn("b")]; s.sent = []; s.getError = null; s.updates = []; s.audits = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("1. ONE real run at a time (the claim is a read-then-write, not atomic)", () => {
  it("of several simultaneous acquirers exactly ONE wins", async () => {
    const results = await Promise.all(["h1", "h2", "h3", "h4", "h5"].map((h) => acquireLaunchLock(createFakeAdmin(), CAMPAIGN, h, 1_000_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a held lock is refused, another holder cannot release it, the owner can, then it is free again", async () => {
    const admin = createFakeAdmin();
    expect(await acquireLaunchLock(admin, CAMPAIGN, "run-1", 1_000_000)).toBe(true);
    expect(await acquireLaunchLock(admin, CAMPAIGN, "run-2", 1_000_100)).toBe(false);
    await releaseLaunchLock(admin, CAMPAIGN, "run-2");
    expect(settings().rows.has(launchLockKey(CAMPAIGN)), "someone else's release removed the lock").toBe(true);
    await releaseLaunchLock(admin, CAMPAIGN, "run-1");
    expect(settings().rows.size).toBe(0);
    expect(await acquireLaunchLock(admin, CAMPAIGN, "run-2", 1_000_200)).toBe(true);
  });

  it("a LIVE lease is never taken over; an EXPIRED one is taken over by exactly one of several simultaneous callers", async () => {
    const admin = createFakeAdmin();
    const t0 = 5_000_000;
    expect(await acquireLaunchLock(admin, CAMPAIGN, "crashed", t0)).toBe(true);
    expect(await acquireLaunchLock(admin, CAMPAIGN, "early", t0 + LAUNCH_LOCK_LEASE_MS - 1000), "took over a live lease").toBe(false);
    const late = t0 + LAUNCH_LOCK_LEASE_MS + 1000;
    const results = await Promise.all(["x", "y", "z"].map((h) => acquireLaunchLock(admin, CAMPAIGN, h, late)));
    expect(results.filter(Boolean), "two callers both took over the expired lease").toHaveLength(1);
    expect(settings().rows.get(launchLockKey(CAMPAIGN))!.value.holder).toBe(["x", "y", "z"][results.indexOf(true)]);
  });

  it("any other database answer fails CLOSED (not acquired); a throwing client is not acquired", async () => {
    const admin = createFakeAdmin();
    settings().failAll("XX000");
    expect(await acquireLaunchLock(admin, CAMPAIGN, "r", 1)).toBe(false);
    expect(await acquireLaunchLock({ from: () => { throw new Error("boom"); } }, CAMPAIGN, "r", 1)).toBe(false);
    await expect(releaseLaunchLock({ from: () => { throw new Error("boom"); } }, CAMPAIGN, "r")).resolves.toBeUndefined();
  });

  it("ROUTE: two overlapping real requests mail each person ONCE; the second is refused with 409; the lock is released afterwards", async () => {
    const route = await import("../src/app/api/admin/launch-email/route");
    const [r1, r2] = await Promise.all([adminCall(route), adminCall(route)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(s.sent.map((x) => x.key).sort()).toEqual([`${CAMPAIGN}:a`, `${CAMPAIGN}:b`]);
    expect(settings().rows.size, "the lock was not released").toBe(0);
    expect(s.audits.some((a) => a.label.includes("another run holds the lock"))).toBe(true);
    // and a later run after the first finished is allowed (and finds everyone already marked: nothing more is sent)
    const again = await adminCall(route);
    expect(again.status).toBe(200);
    expect(s.sent).toHaveLength(2);
  });

  it("ROUTE: a dry run neither needs nor takes the lock, so it works while a real run holds it", async () => {
    const route = await import("../src/app/api/admin/launch-email/route");
    expect(await acquireLaunchLock(createFakeAdmin(), CAMPAIGN, "someone", Date.now())).toBe(true);
    const res = await adminCall(route, { campaign: CAMPAIGN, cap: 5 });
    expect(res.status).toBe(200);
    expect((await res.json()).result.mode).toBe("dry_run");
    expect(s.sent).toEqual([]);
  });
});

describe("2. a delivery whose outcome is UNCERTAIN keeps its claim (a later run must never mail the person again)", () => {
  const upstream = (n: unknown, code: unknown = "resend_rejected") => emailFailureReason(502, code, n);

  it("Resend 5xx and 409 behind resend_rejected are uncertain (reported like an unreachable provider); a plain 4xx stays rejected", () => {
    expect(upstream(500)).toBe("resend_unreachable");
    expect(upstream(503)).toBe("resend_unreachable");
    expect(upstream(504)).toBe("resend_unreachable");
    expect(upstream(409)).toBe("resend_unreachable");
    expect(upstream(422)).toBe("resend_rejected");
    expect(upstream(400)).toBe("resend_rejected");
    expect(upstream(429)).toBe("resend_rejected");
    expect(upstream(undefined)).toBe("resend_rejected");
    expect(upstream("503")).toBe("resend_rejected");
    expect(emailFailureReason(502, "resend_unreachable")).toBe("resend_unreachable");
    expect(emailFailureReason(401, undefined)).toBe("unauthorized");
  });

  it("the runner keeps the claim for resend_unreachable, counts it toward the cap, and lists the person on their own", async () => {
    const world = makeWorld(["a", "b", "c"].map((id) => optedIn(id)), [{ ok: false, reason: "resend_unreachable" }]);
    const r = await runNewsCampaign(makeDeps(world), real("c1", 2));
    expect(world.events).not.toContain("unclaim:a");
    expect(r.ambiguous).toBe(1);
    expect(r.ambiguousUserIds).toEqual(["a"]);
    expect(r.failedUserIds).toEqual(["a"]);
    expect(r.sent + r.ambiguous).toBeLessThanOrEqual(2);
    // a LATER run never mails "a" again
    const again = await runNewsCampaign(makeDeps(world), real("c1", 5));
    expect(world.sends.filter((x) => x.userId === "a")).toHaveLength(1);
    expect(again.skipped.already_sent).toBeGreaterThanOrEqual(1);
  });

  it("a definite rejection still removes the claim and is NOT listed as ambiguous", async () => {
    const world = makeWorld([optedIn("a"), optedIn("b")], [{ ok: false, reason: "resend_rejected" }]);
    const r = await runNewsCampaign(makeDeps(world), real("c2", 5));
    expect(world.events).toContain("unclaim:a");
    expect(r.ambiguousUserIds).toEqual([]);
    expect(r.failedUserIds).toEqual(["a"]);
  });
});

describe("3. the unsubscribe link: a sign-in service outage is a retryable 503, never 'invalid link'", () => {
  const seed = () => { s.users = [{ id: USER, email: "a@example.test", user_metadata: { prefs: { notif: { news: true } } }, app_metadata: {} }]; };

  it.each([[500, undefined], [503, undefined], [429, "over_request_rate_limit"], [undefined, undefined]])("auth error status=%s code=%s -> 503, nothing written", async (status, code) => {
    seed();
    s.getError = { status: status as number | undefined, code: code as string | undefined, message: "down" };
    const route = await import("../src/app/api/email/unsubscribe/route");
    const res = await unsubPost(route, signUnsubscribeToken(USER, KEY));
    expect(res.status).toBe(503);
    expect(s.updates).toEqual([]);
  });

  it("a deleted account (404 / user_not_found) answers exactly like a bad token (400)", async () => {
    seed();
    s.getError = { status: 404, code: "user_not_found", message: "nf" };
    const route = await import("../src/app/api/email/unsubscribe/route");
    expect((await unsubPost(route, signUnsubscribeToken(USER, KEY))).status).toBe(400);
    s.getError = { code: "user_not_found", message: "nf" };
    expect((await unsubPost(route, signUnsubscribeToken(USER, KEY))).status).toBe(400);
  });

  it("when the service is up again the same link works and switches only news off", async () => {
    seed();
    const route = await import("../src/app/api/email/unsubscribe/route");
    const res = await unsubPost(route, signUnsubscribeToken(USER, KEY));
    expect(res.status).toBe(200);
    expect(s.users[0].user_metadata.prefs.notif.news).toBe(false);
  });
});

describe("4. signing-key rotation does not kill links already mailed", () => {
  const OLD = "old-service-role-key";
  const NEW = "dedicated-unsubscribe-secret";
  it("with no dedicated secret the service-role key signs and verifies (nothing new to configure)", () => {
    const env = { SUPABASE_SERVICE_ROLE_KEY: OLD };
    expect(unsubscribeKeyFromEnv(env)).toBe(OLD);
    expect(unsubscribeVerifyKeysFromEnv(env)).toEqual([OLD]);
  });
  it("a dedicated secret signs NEW links, and links signed with the service-role key still verify", () => {
    const env = { UNSUBSCRIBE_HMAC_SECRET: NEW, SUPABASE_SERVICE_ROLE_KEY: OLD };
    const oldLink = signUnsubscribeToken(USER, OLD);
    const newLink = signUnsubscribeToken(USER, unsubscribeKeyFromEnv(env));
    expect(verifyUnsubscribeToken(newLink, unsubscribeVerifyKeysFromEnv(env))).toBe(USER);
    expect(verifyUnsubscribeToken(oldLink, unsubscribeVerifyKeysFromEnv(env))).toBe(USER);
  });
  it("after the service-role key is rotated, links signed with its old value verify when that value is kept as the dedicated secret", () => {
    const oldLink = signUnsubscribeToken(USER, OLD);
    const env = { UNSUBSCRIBE_HMAC_SECRET: OLD, SUPABASE_SERVICE_ROLE_KEY: "rotated-new-service-key" };
    expect(verifyUnsubscribeToken(oldLink, unsubscribeVerifyKeysFromEnv(env))).toBe(USER);
  });
  it("a token signed with any other key, a tampered one, and no configured key at all are refused", () => {
    const env = { UNSUBSCRIBE_HMAC_SECRET: NEW, SUPABASE_SERVICE_ROLE_KEY: OLD };
    expect(verifyUnsubscribeToken(signUnsubscribeToken(USER, "someone-elses-key"), unsubscribeVerifyKeysFromEnv(env))).toBeNull();
    const t = signUnsubscribeToken(USER, OLD);
    expect(verifyUnsubscribeToken(t.slice(0, -2) + (t.endsWith("AA") ? "BB" : "AA"), unsubscribeVerifyKeysFromEnv(env))).toBeNull();
    expect(unsubscribeVerifyKeysFromEnv({})).toEqual([]);
    expect(verifyUnsubscribeToken(t, [])).toBeNull();
    expect(verifyUnsubscribeToken(t, "")).toBeNull();
  });
  it("the unsubscribe ROUTE accepts a link signed with the service-role key while a dedicated secret is configured", async () => {
    vi.stubEnv("UNSUBSCRIBE_HMAC_SECRET", NEW);
    s.users = [{ id: USER, email: "a@example.test", user_metadata: { prefs: { notif: { news: true } } }, app_metadata: {} }];
    const route = await import("../src/app/api/email/unsubscribe/route");
    expect((await unsubPost(route, signUnsubscribeToken(USER, KEY))).status).toBe(200);
  });
});

describe("5. a customer-controlled name cannot break a send or burn a claim", () => {
  it("control and bidi-override characters are removed and the name is cut to 80 characters (whole characters, emoji safe)", () => {
    expect(safeGreetingName("منى‮evil\u0000\n\tx")).toBe("منى evil x");
    expect(safeGreetingName("a".repeat(5000))).toHaveLength(80);
    expect(Array.from(safeGreetingName("😀".repeat(200)))).toHaveLength(80);
    expect(safeGreetingName("   ")).toBe("");
    expect(safeGreetingName(undefined as unknown as string)).toBe("");
  });
  it("the runner greets with the cleaned name (a 5,000-character full_name never reaches the sender)", async () => {
    const world = makeWorld([optedIn("a", { user_metadata: { full_name: "n".repeat(5000), prefs: { notif: { news: true } } } })]);
    await runNewsCampaign(makeDeps(world), real("c3", 5));
    expect(world.sends).toHaveLength(1);
    expect(world.sends[0].vars.Name.length).toBeLessThanOrEqual(80);
  });
});

describe("6. a campaign name that exists on Object.prototype is not read as 'already sent'", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf"])("isCampaignMarked: %s on a user with no marks is false", (name) => {
    expect(isCampaignMarked({ id: "x", app_metadata: { campaigns: {} } }, name)).toBe(false);
    expect(isCampaignMarked({ id: "x", app_metadata: {} }, name)).toBe(false);
    expect(isCampaignMarked({ id: "x", app_metadata: { campaigns: { [name]: "2026-11-10T09:00:00Z" } } }, name)).toBe(true);
  });
  it("the production wiring (isSent) agrees", () => {
    const deps = createNewsCampaignDeps({ admin: {}, env: {}, siteUrl: "https://diger.tech", signingKey: KEY, send: async () => ({ ok: true }) });
    expect(deps.isSent({ id: "x", app_metadata: { campaigns: {} } }, "constructor")).toBe(false);
  });
});

describe("7. the settings page cannot undo an unsubscribe from a stale tab", () => {
  it("togglePref reads the CURRENT server-side preferences and writes only the toggled key", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/dashboard/settings/page.tsx", "utf8");
    const toggle = src.slice(src.indexOf("async function togglePref"), src.indexOf("async function deleteAccount"));
    expect(toggle.indexOf("supabase.auth.getUser()")).toBeGreaterThan(-1);
    expect(toggle.indexOf("supabase.auth.getUser()")).toBeLessThan(toggle.indexOf("supabase.auth.updateUser"));
    expect(toggle).toContain("{ ...liveNotif, [id]: next[id] }");
    expect(toggle).not.toContain("notif: next }");
  });
});

describe("MUTATIONS: each fix is what makes its test pass", () => {
  const seed2 = () => { s.users = [optedIn("a"), optedIn("b")]; s.sent = []; (globalThis as any).__settingsDb = makeSettingsDb(); };

  it("route without the lock: two overlapping runs BOTH run (the 409 disappears)", async () => {
    const m = await loadMutant(ROUTE, [{ from: "if (!dryRun && !(await acquireLaunchLock(admin, body.campaign, holder))) {", to: "if (false) {" }]);
    seed2();
    const [r1, r2] = await Promise.all([adminCall(m.module), adminCall(m.module)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
  });

  it("lock that takes over WITHOUT checking the lease: a live run is taken over", async () => {
    const m = await loadMutant<typeof import("../src/lib/launch/launchLock")>(LOCK, [{ from: '.eq("key", key).lt("updated_at", cutoff)', to: '.eq("key", key)' }]);
    const admin = createFakeAdmin();
    const t0 = 7_000_000;
    expect(await m.module.acquireLaunchLock(admin, CAMPAIGN, "live", t0)).toBe(true);
    expect(await m.module.acquireLaunchLock(admin, CAMPAIGN, "intruder", t0 + 1000), "the mutant took over a live lease").toBe(true);
    (globalThis as any).__settingsDb = makeSettingsDb();
    expect(await acquireLaunchLock(createFakeAdmin(), CAMPAIGN, "a", t0)).toBe(true);
    expect(await acquireLaunchLock(createFakeAdmin(), CAMPAIGN, "b", t0 + 1000)).toBe(false);
  });

  it("lock that releases ANY holder's row: another run's lock is removed", async () => {
    const m = await loadMutant<typeof import("../src/lib/launch/launchLock")>(LOCK, [{ from: '.eq("key", launchLockKey(campaign)).eq("value->>holder", holder)', to: '.eq("key", launchLockKey(campaign))' }]);
    const admin = createFakeAdmin();
    await acquireLaunchLock(admin, CAMPAIGN, "owner", 1);
    await m.module.releaseLaunchLock(admin, CAMPAIGN, "stranger");
    expect(settings().rows.size, "the mutant released a lock it does not own").toBe(0);
  });

  it("runner that treats resend_unreachable as definite: the claim is removed and the person can be mailed again", async () => {
    const m = await loadMutant<typeof import("../src/lib/launch/newsCampaign")>(CAMPAIGN_SRC, [{ from: '"function_unavailable", "resend_unreachable"]);', to: '"function_unavailable"]);' }]);
    const world = makeWorld([optedIn("a"), optedIn("b")], [{ ok: false, reason: "resend_unreachable" }]);
    await m.module.runNewsCampaign(makeDeps(world), real("c4", 5));
    expect(world.events, "the mutant unclaimed an uncertain delivery").toContain("unclaim:a");
  });

  it("classifier that ignores the upstream status: a Resend 503 is reported as a definite rejection", async () => {
    const m = await loadMutant<typeof import("../src/lib/server/sendPlatformEmail")>("src/lib/server/sendPlatformEmail.ts", [{ from: '(upstreamStatus >= 500 || upstreamStatus === 409)', to: "false" }]);
    expect(m.module.emailFailureReason(502, "resend_rejected", 503)).toBe("resend_rejected");
    expect(emailFailureReason(502, "resend_rejected", 503)).toBe("resend_unreachable");
  });

  it("unsubscribe route that answers every lookup error as 'invalid link': an outage becomes a permanent-looking 400", async () => {
    const m = await loadMutant(UNSUB_ROUTE, [{ from: "if (notFound || (!error && !user)) return bad();", to: "if (error || !user) return bad();" }]);
    s.users = [{ id: USER, email: "a@example.test", user_metadata: { prefs: { notif: { news: true } } }, app_metadata: {} }];
    s.getError = { status: 503, message: "down" };
    expect((await unsubPost(m.module, signUnsubscribeToken(USER, KEY))).status, "the mutant hid the outage").toBe(400);
  });

  it("verification that tries only the first key: a link signed with the service-role key stops working once a dedicated secret is set", async () => {
    const m = await loadMutant<typeof import("../src/lib/server/unsubscribeToken")>("src/lib/server/unsubscribeToken.ts", [{ from: "for (const key of keys) {", to: "for (const key of keys.slice(0, 1)) {" }]);
    const env = { UNSUBSCRIBE_HMAC_SECRET: "dedicated-unsubscribe-secret", SUPABASE_SERVICE_ROLE_KEY: "old-service-role-key" };
    const oldLink = signUnsubscribeToken(USER, "old-service-role-key");
    expect(m.module.verifyUnsubscribeToken(oldLink, unsubscribeVerifyKeysFromEnv(env)), "the mutant dropped every link mailed before the secret was set").toBeNull();
    expect(verifyUnsubscribeToken(oldLink, unsubscribeVerifyKeysFromEnv(env))).toBe(USER);
  });

  it("route that never releases the lock: the next run is refused until the lease expires", async () => {
    const m = await loadMutant(ROUTE, [{ from: "if (!dryRun) await releaseLaunchLock(admin, body.campaign, holder);", to: "" }]);
    seed2();
    expect((await adminCall(m.module)).status).toBe(200);
    expect(settings().rows.size, "the mutant left the lock behind").toBe(1);
    expect((await adminCall(m.module)).status).toBe(409);
    expect(settings().rows.size).toBe(1);
    seed2();
    expect((await adminCall(await import("../src/app/api/admin/launch-email/route"))).status).toBe(200);
    expect(settings().rows.size).toBe(0);
  });

  it("name that is not cleaned: a 5,000-character name reaches the sender", async () => {
    const m = await loadMutant<typeof import("../src/lib/launch/newsCampaign")>(CAMPAIGN_SRC, [{ from: "deps.compose(safeGreetingName(resolveDisplayName(fresh)))", to: "deps.compose(resolveDisplayName(fresh))" }]);
    const world = makeWorld([optedIn("a", { user_metadata: { full_name: "n".repeat(5000), prefs: { notif: { news: true } } } })]);
    await m.module.runNewsCampaign(makeDeps(world), real("c5", 5));
    expect(world.sends[0].vars.Name.length, "the mutant sent the raw name").toBeGreaterThan(80);
  });

  it("prototype-blind mark check: 'constructor' reads as already sent", async () => {
    const m = await loadMutant<typeof import("../src/lib/launch/newsCampaign")>(CAMPAIGN_SRC, [{ from: "return Boolean(marks && typeof marks === \"object\" && Object.hasOwn(marks, campaign) && marks[campaign]);", to: "return Boolean(marks?.[campaign]);" }]);
    expect(m.module.isCampaignMarked({ id: "x", app_metadata: { campaigns: {} } }, "constructor"), "the mutant reads the prototype").toBe(true);
  });
});

/** the lock only needs `.from()`: the shared fake `agent_settings` table of this test file */
function createFakeAdmin() {
  return { from: (t: string) => settings().from(t) };
}
void confirmedAt;
