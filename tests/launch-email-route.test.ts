import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createNewsCampaignDeps } from "../src/lib/launch/newsCampaignWiring";
import { verifyUnsubscribeToken } from "../src/lib/server/unsubscribeToken";

/** FAKES only: the admin check, the sign-in service's admin API and the sender. Nothing here can reach a network or a real account. */
const w = vi.hoisted(() => ({
  isAdmin: true,
  users: [] as any[],
  audits: [] as any[],
  sent: [] as any[],
  adminCalls: [] as string[],
}));

vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: async () => w.isAdmin
    ? { ok: true, ctx: { adminId: "admin-1", audit: async (kind: string, label: string, target: string) => { w.audits.push({ kind, label, target }); } } }
    : { ok: false, response: NextResponse.json({ error: "ممنوع" }, { status: 403 }) },
}));
vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        listUsers: async ({ page, perPage }: any) => { w.adminCalls.push(`list:${page}:${perPage}`); return { data: { users: structuredClone(w.users.slice((page - 1) * perPage, page * perPage)) }, error: null }; },
        getUserById: async (id: string) => { const u = w.users.find((x) => x.id === id); return u ? { data: { user: structuredClone(u) }, error: null } : { data: { user: null }, error: { message: "nf" } }; },
        updateUserById: async (id: string, patch: any) => { w.adminCalls.push(`update:${id}`); Object.assign(w.users.find((x) => x.id === id), patch); return { data: {}, error: null }; },
      },
    },
  }),
}));
vi.mock("../src/lib/server/sendPlatformEmail", async (orig) => ({
  ...(await orig<typeof import("../src/lib/server/sendPlatformEmail")>()),
  sendPlatformEmail: async (template: string, to: string, vars: any, key: string, opts: any) => { w.sent.push({ template, to, vars, key, opts }); return { ok: true }; },
}));

import { POST } from "../src/app/api/admin/launch-email/route";

const KEY = "test-only-service-role-key";
const user = (id: string, over: any = {}) => ({ id, email: `${id}@example.test`, email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: { prefs: { notif: { news: true } } }, app_metadata: {}, ...over });
const call = (body: unknown) => POST(new NextRequest("https://diger.test/api/admin/launch-email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const CONFIRM = "SEND launch-2026-11 5";

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", KEY);
  vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "on");
  vi.stubEnv("LAUNCH_EMAIL_ENABLED", "");
  w.isAdmin = true; w.audits = []; w.sent = []; w.adminCalls = [];
  w.users = [user("a"), user("b"), user("c", { user_metadata: {} }), user("d", { email_confirmed_at: null }), user("iam", { email: "iam.magdy+3@outlook.com" })];
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/launch-email", () => {
  it("refuses a non-admin before anything is read", async () => {
    w.isAdmin = false;
    const res = await call({ campaign: "launch-2026-11", cap: 5 });
    expect(res.status).toBe(403);
    expect(w.adminCalls).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("a DRY RUN is always allowed (LAUNCH_EMAIL_ENABLED unset), returns the genuine eligible count and changes nothing", async () => {
    const res = await call({ campaign: "launch-2026-11", cap: 5 });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result.mode).toBe("dry_run");
    expect(result.eligible).toBe(2); // a, b: c has no opt-in, d is unconfirmed, iam is a test account
    expect(result.wouldSend).toBe(2);
    expect(result.skipped).toEqual({ not_opted_in: 1, unconfirmed: 1, test_account: 1 });
    expect(w.sent).toEqual([]);
    expect(w.adminCalls.every((c) => c.startsWith("list:"))).toBe(true);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ kind: "launch-email", target: "launch-2026-11" });
    expect(w.audits[0].label).toBe("dry_run eligible=2 sent=0 ambiguous=0 failed=0 cap=5 stopped=end_of_list");
  });

  it("an explicit dryRun:true is a dry run too, even with LAUNCH_EMAIL_ENABLED on and a correct confirmation", async () => {
    vi.stubEnv("LAUNCH_EMAIL_ENABLED", "on");
    const res = await call({ campaign: "launch-2026-11", cap: 5, dryRun: true, confirm: CONFIRM });
    expect((await res.json()).result.mode).toBe("dry_run");
    expect(w.sent).toEqual([]);
  });

  it("a REAL send is refused while LAUNCH_EMAIL_ENABLED is not exactly `on` (the second lock), even with the right confirmation", async () => {
    for (const value of ["", "off", "ON", "true", "1", " on", "on "]) {
      vi.stubEnv("LAUNCH_EMAIL_ENABLED", value);
      w.sent = []; w.adminCalls = []; w.audits = [];
      const res = await call({ campaign: "launch-2026-11", cap: 5, dryRun: false, confirm: CONFIRM });
      expect(res.status, JSON.stringify(value)).toBe(403);
      expect(w.sent).toEqual([]);
      expect(w.adminCalls).toEqual([]);
      expect(w.audits[0].label).toContain("LAUNCH_EMAIL_ENABLED is off");
    }
    vi.unstubAllEnvs();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", KEY);
    delete process.env.LAUNCH_EMAIL_ENABLED; // truly unset
    expect((await call({ campaign: "launch-2026-11", cap: 5, dryRun: false, confirm: CONFIRM })).status).toBe(403);
    expect(w.sent).toEqual([]);
  });

  it("with the env lock open, a real send STILL needs the exact confirmation text (the first lock)", async () => {
    vi.stubEnv("LAUNCH_EMAIL_ENABLED", "on");
    for (const confirm of [undefined, "SEND launch-2026-11 4", "send launch-2026-11 5"]) {
      const res = await call({ campaign: "launch-2026-11", cap: 5, dryRun: false, confirm });
      expect(res.status).toBe(400);
      expect((await res.json()).result.refused).toBe("confirm_mismatch");
    }
    expect(w.sent).toEqual([]);
  });

  it("both locks open: sends to the eligible users only, through sendPlatformEmail('news'), with the key and a signed https unsubscribe URL; audit holds counts only", async () => {
    vi.stubEnv("LAUNCH_EMAIL_ENABLED", "on");
    const res = await call({ campaign: "launch-2026-11", cap: 5, dryRun: false, confirm: CONFIRM });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result.sentUserIds).toEqual(["a", "b"]);
    expect(w.sent.map((s) => s.to)).toEqual(["a@example.test", "b@example.test"]);
    for (const s of w.sent) {
      expect(s.template).toBe("news");
      expect(s.key).toBe(`launch-2026-11:${s.to.split("@")[0]}`);
      expect(s.opts.unsubscribeUrl).toMatch(/^https:\/\/diger\.tech\/api\/email\/unsubscribe\?t=/);
      expect(verifyUnsubscribeToken(new URL(s.opts.unsubscribeUrl).searchParams.get("t"), KEY)).toBe(s.to.split("@")[0]);
      expect(s.vars.Subject).toBe("تابع بحثك لحظة بلحظة في ديجر");
    }
    expect(w.users[0].app_metadata.campaigns["launch-2026-11"]).toBeTruthy();
    expect(w.users[2].app_metadata.campaigns).toBeUndefined();
    expect(JSON.stringify(w.audits)).not.toContain("@");
    expect(w.audits[0].label).toBe("send eligible=2 sent=2 ambiguous=0 failed=0 cap=5 stopped=end_of_list");
  });

  it("excludeUserIds and suppressedEmails are honoured and never echoed", async () => {
    const res = await call({ campaign: "launch-2026-11", cap: 5, excludeUserIds: ["a"], suppressedEmails: ["B@example.test"] });
    const { result } = await res.json();
    expect(result.eligible).toBe(0);
    expect(JSON.stringify(result)).not.toContain("example.test");
  });

  it("onlyUserIds (a bounded seed send): only those ids, the test-account rule is lifted for them, every other check still applies; more than 5 ids is refused", async () => {
    vi.stubEnv("LAUNCH_EMAIL_ENABLED", "on");
    const res = await call({ campaign: "launch-2026-11-seed", cap: 5, dryRun: false, confirm: "SEND launch-2026-11-seed 5", onlyUserIds: ["iam", "c", "a"] });
    const { result } = await res.json();
    expect(result.sentUserIds).toEqual(["a", "iam"]); // c never opted in: still refused
    expect(result.skipped.not_opted_in).toBe(1);
    expect(result.skipped.not_selected).toBe(2); // b and d are not on the list
    expect(w.sent.map((s) => s.to).sort()).toEqual(["a@example.test", "iam.magdy+3@outlook.com"]);
    expect((await call({ campaign: "c1", cap: 5, onlyUserIds: ["1", "2", "3", "4", "5", "6"] })).status).toBe(400);
    expect((await call({ campaign: "c1", cap: 5, onlyUserIds: [] })).status).toBe(400);
  });

  it("with nothing live to announce a real send is refused (dry run still reports)", async () => {
    vi.stubEnv("LAUNCH_EMAIL_ENABLED", "on");
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "allowlist");
    const res = await call({ campaign: "launch-2026-11", cap: 5, dryRun: false, confirm: CONFIRM });
    expect((await res.json()).result.refused).toBe("nothing_to_announce");
    expect(w.sent).toEqual([]);
  });

  it("validates the body", async () => {
    expect((await call({ cap: 5 })).status).toBe(400);
    expect((await call({ campaign: "bad name", cap: 5 })).status).toBe(400);
    expect((await call({ campaign: "c1", cap: 0 })).status).toBe(400);
    expect((await call({ campaign: "c1", cap: "5" })).status).toBe(400);
  });

  it("pages through the users 200 at a time", async () => {
    w.users = Array.from({ length: 450 }, (_, i) => user(`u${i}`));
    await call({ campaign: "launch-2026-11", cap: 5 });
    expect(w.adminCalls.filter((c) => c.startsWith("list:"))).toEqual(["list:1:200", "list:2:200", "list:3:200", "list:4:200"]);
  });
});

describe("createNewsCampaignDeps (production wiring, fake admin client)", () => {
  const mk = (users: any[]) => {
    const updates: any[] = [];
    const admin = {
      auth: { admin: {
        getUserById: async (id: string) => { const u = users.find((x) => x.id === id); return u ? { data: { user: structuredClone(u) }, error: null } : { data: { user: null }, error: { message: "x" } }; },
        updateUserById: async (id: string, patch: any) => { updates.push({ id, patch }); Object.assign(users.find((x) => x.id === id), patch); return { error: null }; },
        listUsers: async () => ({ data: { users: [] }, error: null }),
      } },
    };
    const deps = createNewsCampaignDeps({ admin, env: {}, siteUrl: "https://diger.tech", signingKey: KEY, send: async () => ({ ok: true }) });
    return { deps, updates };
  };

  it("markSent MERGES app_metadata (role and other campaigns stay), never touches user_metadata, and refuses a mark that is already there", async () => {
    const users = [{ id: "a", user_metadata: { keep: 1 }, app_metadata: { role: "admin", campaigns: { old: "t0" } } }];
    const { deps, updates } = mk(users);
    expect(await deps.markSent("a", "c1", "t1")).toBe(true);
    expect(updates[0].patch).toEqual({ app_metadata: { role: "admin", campaigns: { old: "t0", c1: "t1" } } });
    expect(await deps.markSent("a", "c1", "t2")).toBe(false);
    expect(updates).toHaveLength(1);
  });

  it("unmarkSent removes only this campaign's mark", async () => {
    const users = [{ id: "a", app_metadata: { role: "admin", campaigns: { old: "t0", c1: "t1" } } }];
    const { deps, updates } = mk(users);
    await deps.unmarkSent("a", "c1");
    expect(updates[0].patch).toEqual({ app_metadata: { role: "admin", campaigns: { old: "t0" } } });
  });

  it("the unsubscribe URL is signed with the given key", () => {
    const { deps } = mk([]);
    expect(verifyUnsubscribeToken(new URL(deps.unsubscribeUrl("u-1")).searchParams.get("t"), KEY)).toBe("u-1");
  });
});
