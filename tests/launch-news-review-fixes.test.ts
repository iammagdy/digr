import { describe, expect, it } from "vitest";
import { LAUNCH_TIME_BUDGET_MS, confirmationFor, newsSkipReason, runNewsCampaign } from "../src/lib/launch/newsCampaign";
import { createNewsCampaignDeps } from "../src/lib/launch/newsCampaignWiring";
import { composeLaunchAnnouncement } from "../src/lib/launch/announcement";
import { renderEmailTemplate as renderEdge } from "../supabase/functions/send-email/templates";
import { renderEmailTemplate as renderApp } from "../src/functions/shared/emailTemplates";
import { renderVarsWithUnsubscribe } from "../supabase/functions/send-email/payload";
import { makeDeps, makeWorld, optedIn } from "./helpers/newsCampaignFakes";

const real = (campaign: string, cap: number, extra: object = {}) => ({ campaign, cap, dryRun: false as const, confirm: confirmationFor(campaign, cap), ...extra });
const five = () => ["a", "b", "c", "d", "e"].map((id) => optedIn(id));
const KEY = "test-only-service-role-key";

/** A fake admin client over an in-memory user list (no network). */
function fakeAdmin(users: any[], hooks: { onGet?: (n: number, id: string) => void } = {}) {
  let gets = 0;
  const updates: any[] = [];
  return {
    updates,
    admin: { auth: { admin: {
      getUserById: async (id: string) => { gets += 1; hooks.onGet?.(gets, id); const u = users.find((x) => x.id === id); return u ? { data: { user: structuredClone(u) }, error: null } : { data: { user: null }, error: { message: "nf" } }; },
      updateUserById: async (id: string, patch: any) => { updates.push({ id, patch }); Object.assign(users.find((x) => x.id === id), patch); return { error: null }; },
      listUsers: async ({ page, perPage }: any) => ({ data: { users: structuredClone(users.slice((page - 1) * perPage, page * perPage)) }, error: null }),
    } } },
  };
}

describe("BLOCKER: the footer unsubscribe link is the per-recipient URL (wiring level, nothing injected by hand)", () => {
  it("runs the real wiring with a capturing sender, renders the captured vars, and the href equals the unsubscribe URL (both template copies)", async () => {
    const users = [optedIn("11111111-2222-4333-8444-555555555555")];
    const { admin } = fakeAdmin(users);
    const captured: any[] = [];
    const deps = createNewsCampaignDeps({
      admin, env: { DIGER_STAGE2_LIVE_SHEET: "on" }, siteUrl: "https://diger.tech", signingKey: KEY,
      send: async (i) => { captured.push(i); return { ok: true }; }, log: () => undefined,
    });
    const r = await runNewsCampaign(deps, real("launch-2026-11", 5));
    expect(r.sent).toBe(1);
    expect(captured).toHaveLength(1);
    const url = captured[0].unsubscribeUrl;
    expect(url).toMatch(/^https:\/\/diger\.tech\/api\/email\/unsubscribe\?t=/);
    for (const render of [renderEdge, renderApp]) {
      const { html } = render("news", captured[0].vars);
      expect(html).toContain(`<a href="${url}" style="color:#66685F;text-decoration:underline">إلغاء الاشتراك من الأخبار</a>`);
      expect(html).not.toContain('href=""');
    }
  });

  it("the Edge Function injects UnsubscribeURL from unsubscribeUrl when the caller sent none (old app + new function, either order)", () => {
    const url = "https://diger.tech/api/email/unsubscribe?t=a.b";
    const vars = composeLaunchAnnouncement({ DIGER_STAGE2_LIVE_SHEET: "on" }, "منى") as unknown as Record<string, string>;
    expect(vars.UnsubscribeURL).toBeUndefined();
    const { html } = renderEdge("news", renderVarsWithUnsubscribe(vars, url));
    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain('href=""');
    // a given value is kept; no URL means the vars are returned untouched
    expect(renderVarsWithUnsubscribe({ UnsubscribeURL: "https://diger.tech/x" }, url).UnsubscribeURL).toBe("https://diger.tech/x");
    expect(renderVarsWithUnsubscribe({ UnsubscribeURL: "" }, url).UnsubscribeURL).toBe(url);
    const same = { Name: "x" };
    expect(renderVarsWithUnsubscribe(same, undefined)).toBe(same);
  });
});

describe("MEDIUM: ambiguous failures count toward the cap", () => {
  it("alternating ambiguous/ok never exceeds the cap", async () => {
    const script = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? { ok: false, reason: "timeout" } : { ok: true }));
    const w = makeWorld(Array.from({ length: 10 }, (_, i) => optedIn(`u${i}`)), script);
    const r = await runNewsCampaign(makeDeps(w), real("c1", 3));
    expect(w.sends).toHaveLength(3); // timeout, ok, timeout: three possible deliveries = the cap
    expect(r.sent).toBe(1);
    expect(r.ambiguous).toBe(2);
    expect(r.stopped).toBe("cap_reached");
  });

  it("a lone ambiguous failure at cap 1 ends the run; definite failures do NOT count", async () => {
    const w = makeWorld(five(), [{ ok: false, reason: "network_error" }]);
    expect((await runNewsCampaign(makeDeps(w), real("c1", 1))).stopped).toBe("cap_reached");
    expect(w.sends).toHaveLength(1);
    const w2 = makeWorld(five(), [{ ok: false, reason: "resend_rejected" }, { ok: true }, { ok: true }]);
    const r2 = await runNewsCampaign(makeDeps(w2), real("c1", 2));
    expect(r2.sent).toBe(2);
    expect(r2.ambiguous).toBe(0);
  });
});

describe("MEDIUM: wall-clock budget", () => {
  const clocked = (users: any[], sendMs: number) => {
    let t = Date.parse("2026-11-10T09:00:00Z");
    const w = makeWorld(users);
    return { w, advance: (ms: number) => { t += ms; }, deps: (advance: (ms: number) => void) => makeDeps(w, { now: () => t, send: async (i) => { w.sends.push(i as any); w.events.push(`send:${i.userId}`); advance(sendMs); return { ok: true }; } }) };
  };

  it("stops cleanly with time_budget when the (fake) clock runs out; claims already made stay; counts are returned", async () => {
    const c = clocked(five(), 20_000);
    const r = await runNewsCampaign(c.deps(c.advance), real("c1", 5));
    expect(LAUNCH_TIME_BUDGET_MS).toBe(45_000);
    expect(r.stopped).toBe("time_budget");
    expect(r.sent).toBe(3); // t = 0, 20, 40 s are inside the 45 s budget; the fourth would start at 60 s
    expect(c.w.events).not.toContain("claim:d");
    expect((c.w.users[0].app_metadata as any).campaigns.c1).toBeTruthy();
    // a re-run continues where it stopped: the marks make it safe
    const again = await runNewsCampaign(c.deps(c.advance), real("c1", 5));
    expect(again.sentUserIds).toEqual(["d", "e"]);
    expect(c.w.sends.map((s) => s.userId)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("budgetMs is injectable, and a dry run is never cut short (its count must be genuine)", async () => {
    const c = clocked(five(), 20_000);
    const r = await runNewsCampaign(c.deps(c.advance), real("c1", 5, { budgetMs: 10_000 }));
    expect(r.sent).toBe(1);
    expect(r.stopped).toBe("time_budget");
    const c2 = clocked(five(), 0);
    const dry = await runNewsCampaign(makeDeps(c2.w, { now: () => { c2.advance(60_000); return Date.parse("2026-11-10T09:00:00Z") + 1e9; } }), { campaign: "c1", cap: 5 });
    expect(dry.eligible).toBe(5);
    expect(dry.stopped).toBe("end_of_list");
  });

  it("the route declares maxDuration = 60", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/app/api/admin/launch-email/route.ts", "utf8")).toContain("export const maxDuration = 60;");
  });
});

describe("MEDIUM: markSent merges only its own campaign key from the CURRENT app_metadata", () => {
  it("another campaign's mark written between the first read and the write is not lost", async () => {
    const users: any[] = [{ id: "a", email: "a@example.test", app_metadata: { role: "admin", campaigns: { old: "t0" } } }];
    const f = fakeAdmin(users, { onGet: (n) => { if (n === 1) users[0].app_metadata.campaigns = { old: "t0" }; if (n === 2) users[0].app_metadata.campaigns = { old: "t0", other2: "t9" }; } });
    const deps = createNewsCampaignDeps({ admin: f.admin, env: {}, siteUrl: "https://diger.tech", signingKey: KEY, send: async () => ({ ok: true }) });
    // the fake mutates the stored user while the first read happens; the second read sees the newer marks
    expect(await deps.markSent("a", "c1", "t1")).toBe(true);
    expect(f.updates[0].patch.app_metadata).toEqual({ role: "admin", campaigns: { old: "t0", other2: "t9", c1: "t1" } });
  });
});

describe("LOW: a barred account is never mailed", () => {
  const base = optedIn("u");
  const now = () => Date.parse("2026-11-10T09:00:00Z");
  it("banned_until in the future is ineligible; in the past or null is fine; an unreadable value fails closed", () => {
    expect(newsSkipReason({ ...base, banned_until: "2026-12-01T00:00:00Z" }, { now })).toBe("banned");
    expect(newsSkipReason({ ...base, banned_until: "2026-11-01T00:00:00Z" }, { now })).toBeNull();
    expect(newsSkipReason({ ...base, banned_until: null }, { now })).toBeNull();
    expect(newsSkipReason({ ...base }, { now })).toBeNull();
    expect(newsSkipReason({ ...base, banned_until: "garbage" }, { now })).toBe("banned");
  });
  it("is re-checked right before sending (banned after the listing)", async () => {
    const w = makeWorld(five());
    w.beforeReread = (id) => { if (id === "b") w.users.find((u) => u.id === "b")!.banned_until = "2999-01-01T00:00:00Z"; };
    const r = await runNewsCampaign(makeDeps(w), real("c1", 10));
    expect(r.sentUserIds).toEqual(["a", "c", "d", "e"]);
    expect(r.skipped.banned).toBe(1);
  });
});
