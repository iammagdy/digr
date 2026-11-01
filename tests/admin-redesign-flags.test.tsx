import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";

const state = vi.hoisted(() => ({ admin: true as boolean, client: null as any, audits: [] as string[] }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin ? { ok: true, ctx: { adminId: "adm-1", audit: async (_k: string, label: string) => { state.audits.push(label); } } } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/components/admin/AdminShell", () => ({ useAdmin: () => ({ toast: () => undefined }) }));

import { GET as overviewGET, POST as overviewPOST } from "../src/app/api/admin/agent/route";
import AgentPage from "../src/app/admin/agent/page";
import { loadOverview } from "../src/lib/agentMission/adminActions";
import { REDESIGN_TYPES, normalizeRedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { RedesignFlagsSection, createFlagController, decideFlagClick, flagBody } from "../src/components/admin/RedesignFlagsSection";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * AN ADMIN TOGGLE FOR THE REDESIGN FLAGS on the page «الوكيل»: the six types, each with its current mode and three buttons (off / test / on). It uses the EXISTING admin route action `redesign_flag` (same audit row): no new write path, no SQL. Switching a type to «on» needs a confirmation.
 * Admin only: the route answers 403 to anyone else, so the page never receives the flags and shows no section.
 */
const req = (url: string, body?: unknown) => new Request(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never;
let db: MemoryDb;
beforeEach(() => {
  db = createMemoryDb();
  state.client = { from: (t: string) => db.from(t), rpc: async () => ({ data: null, error: null }) };
  state.admin = true; state.audits = [];
});
const ALL_OFF = normalizeRedesignFlags({});
const ARABIC_ONLY = /^[^A-Za-z0-9\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]*$/u;
const visibleText = (html: string): string => html.replace(/<[^>]+>/g, " ");

describe("the overview carries the flags as stored", () => {
  it("every type off when nothing is stored", async () => {
    expect((await loadOverview(state.client)).redesignFlags).toEqual(ALL_OFF);
  });
  it("the stored value, an unknown value read as off", async () => {
    db.seed("agent_settings", [{ key: "redesign_flags", value: { social_posts: "test", social_comments: "on", companies: "maybe" } }]);
    expect((await loadOverview(state.client)).redesignFlags).toEqual({ ...ALL_OFF, social_posts: "test", social_comments: "on" });
  });
});

describe("the section", () => {
  const html = (flags = ALL_OFF, confirming: string | null = null) => renderToStaticMarkup(createElement(RedesignFlagsSection, { flags, confirming: confirming as never, busy: false, onPick: () => undefined, onConfirm: () => undefined, onCancel: () => undefined }));
  it("lists the six types, each with its current mode and the three buttons", () => {
    const out = html({ ...ALL_OFF, social_posts: "test", people: "on" });
    expect(out).toContain('data-testid="redesign-flags"');
    for (const t of REDESIGN_TYPES) {
      expect(out).toContain(`data-testid="redesign-flag-${t}"`);
      for (const m of ["off", "test", "on"]) expect(out).toContain(`data-testid="redesign-flag-${t}-${m}"`);
    }
    const row = (t: string) => out.split(`data-testid="redesign-flag-${t}"`)[1].split("</li>")[0];
    expect(row("social_posts")).toContain("الوضع الحالي: تجريبي");
    expect(row("people")).toContain("الوضع الحالي: تشغيل");
    expect(row("places")).toContain("الوضع الحالي: إيقاف");
    expect(row("social_posts")).toMatch(/data-testid="redesign-flag-social_posts-test"[^>]*aria-pressed="true"/);
  });
  it("Arabic labels, no emoji, no Latin letter and no ASCII digit in what is read", () => {
    const text = visibleText(html({ ...ALL_OFF, social_posts: "on" }, "social_posts"));
    expect(text).toMatch(ARABIC_ONLY);
    for (const line of text.split(/\s{2,}/).filter((l) => l.trim().length > 0)) expect(checkCustomerText(line, { maxChars: 600 }).issues.filter((i) => !/must be Arabic/.test(i)), line).toEqual([]);
  });
  it("asking to switch on shows the confirmation sentence with a confirm and a cancel button", () => {
    const out = html(ALL_OFF, "social_comments");
    expect(out).toContain('data-testid="redesign-flag-confirm"');
    expect(out).toContain('data-testid="redesign-flag-confirm-yes"');
    expect(out).toContain('data-testid="redesign-flag-confirm-no"');
    expect(out).toContain("لكل العملاء");
    expect(html(ALL_OFF, null)).not.toContain('data-testid="redesign-flag-confirm"');
  });
});

describe("what a click does", () => {
  it("«test» and «off» send exactly the route's body at once", () => {
    expect(decideFlagClick("social_posts", "test", "off")).toEqual({ kind: "send", body: { action: "redesign_flag", type: "social_posts", mode: "test" } });
    expect(JSON.stringify(flagBody("social_posts", "test"))).toBe('{"action":"redesign_flag","type":"social_posts","mode":"test"}');
    expect(decideFlagClick("people", "off", "on")).toEqual({ kind: "send", body: { action: "redesign_flag", type: "people", mode: "off" } });
  });
  it("«on» asks for confirmation first; the mode it already has does nothing", () => {
    expect(decideFlagClick("social_posts", "on", "off")).toEqual({ kind: "confirm" });
    expect(decideFlagClick("social_posts", "test", "test")).toEqual({ kind: "noop" });
    expect(decideFlagClick("social_posts", "on", "on")).toEqual({ kind: "noop" });
  });
  it("the controller: test sends once; on sends nothing until confirmed; cancel sends nothing", async () => {
    const sent: unknown[] = [];
    const c = createFlagController({ send: async (b) => { sent.push(b); }, current: () => ALL_OFF });
    await c.pick("social_account", "test");
    expect(sent).toEqual([{ action: "redesign_flag", type: "social_account", mode: "test" }]);
    await c.pick("social_comments", "on");
    expect(sent).toHaveLength(1);
    expect(c.confirming()).toBe("social_comments");
    c.cancel();
    expect(c.confirming()).toBeNull();
    await c.confirm();
    expect(sent).toHaveLength(1);
    await c.pick("social_comments", "on");
    await c.confirm();
    expect(sent[1]).toEqual({ action: "redesign_flag", type: "social_comments", mode: "on" });
    expect(c.confirming()).toBeNull();
  });
  it("the body goes through the EXISTING route: the setting is written and one audit row is made", async () => {
    const r = await overviewPOST(req("http://x/api/admin/agent", flagBody("social_posts", "test")));
    expect(r.status).toBe(200);
    expect(db.rows("agent_settings")[0]).toMatchObject({ key: "redesign_flags", value: { social_posts: "test" } });
    expect(state.audits).toEqual(["مفتاح إعادة التصميم"]);
    expect((await (await overviewGET(req("http://x/api/admin/agent"))).json()).redesignFlags).toMatchObject({ social_posts: "test", people: "off" });
  });
});

describe("admin only", () => {
  it("a non-admin gets 403 from the route, no flags in any answer, and nothing is written", async () => {
    state.admin = false;
    const r = await overviewGET(req("http://x/api/admin/agent"));
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).not.toContain("redesignFlags");
    expect((await overviewPOST(req("http://x/api/admin/agent", flagBody("social_posts", "on")))).status).toBe(403);
    expect(db.rows("agent_settings")).toEqual([]);
    expect(state.audits).toEqual([]);
  });
  it("the page shows no flags section until the admin route has answered with them", () => {
    expect(renderToStaticMarkup(createElement(AgentPage))).not.toContain("redesign-flags");
  });
});
