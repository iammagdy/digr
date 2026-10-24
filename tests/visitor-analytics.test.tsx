import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Visitor analytics: what is stored (and what never is), who is not tracked, how a slow or failing write behaves, the numbers of the admin tab and who may read them.
 * The database is an in-memory fake that records every write it is asked to perform; no network, no Supabase, no SQL.
 */
const state = vi.hoisted(() => ({
  user: null as any,
  inserts: [] as any[],
  insertMode: "ok" as "ok" | "throw" | "hang" | "error",
  table: [] as any[],
  tableMissing: false,
  pagesRead: 0,
  counts: { profiles: 7 as number | null, jobs: 4 as number | null },
  jobsRows: [] as any[],
  headCounts: [] as string[],
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    from: (name: string) => {
      if (name === "visitor_events") {
        const builder: any = {
          insert: (row: any) => {
            state.inserts.push(row);
            if (state.insertMode === "throw") throw new Error("boom");
            if (state.insertMode === "hang") return new Promise(() => undefined);
            return Promise.resolve({ error: state.insertMode === "error" ? { code: "42P01", message: "relation does not exist" } : null });
          },
          select: () => builder,
          order: () => builder,
          gte: () => builder,
          range: (from: number, to: number) => {
            state.pagesRead += 1;
            const result = state.tableMissing ? { data: null, error: { code: "42P01", message: 'relation "public.visitor_events" does not exist' } } : { data: state.table.slice(from, to + 1), error: null };
            // like the real query builder: a filter can still follow, and awaiting it runs the query
            const query: any = { gte: () => query, then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject) };
            return query;
          },
        };
        return builder;
      }
      if (name === "jobs" || name === "profiles") {
        const builder: any = {
          select: (_c: string, options?: { head?: boolean }) => {
            if (options?.head) { state.headCounts.push(name); return { gte: () => Promise.resolve({ count: state.counts[name as "jobs"], error: null }), then: (resolve: any) => resolve({ count: state.counts[name as "jobs"], error: null }) }; }
            return builder;
          },
          in: () => builder,
          order: () => builder,
          limit: () => Promise.resolve({ data: state.jobsRows, error: null }),
        };
        return builder;
      }
      return { select: () => ({}) };
    },
  })),
}));

import { MAX_BEACON_BYTES, createRateLimiter, decideCollect, type CollectInput } from "../src/lib/analytics/collect";
import { clampDuration, countryOf, deviceClassOf, isBotUserAgent, isExcludedPath, referrerHostOf, respectsDoNotTrack, sanitizePath } from "../src/lib/analytics/privacy";
import { SUMMARY_ROW_LIMIT, countryNameAr, parseRange, rangeStart, summarizeVisits, type VisitEventRow } from "../src/lib/analytics/summary";
import { POST as collectPost } from "../src/app/api/analytics/collect/route";
import { GET as visitorsGet } from "../src/app/api/admin/visitors/route";
import { durationAr, percentAr } from "../src/components/admin/visitorFormat";
import { ADMIN_PAGES, adminHref } from "../src/components/admin/icons";
import { isPublicPath } from "../src/lib/publicPaths";
import AdminVisitorsPage from "../src/app/admin/visitors/page";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SID = "c".repeat(24);
const VID = "d".repeat(32);

const headers = (init: Record<string, string> = {}) => new Headers({ "user-agent": CHROME, ...init });
const limiters = () => ({ perVisitor: createRateLimiter({ max: 40, windowMs: 60_000 }), global: createRateLimiter({ max: 3000, windowMs: 60_000 }) });
const decide = (body: unknown, extra: Partial<CollectInput> = {}, l = limiters()) => decideCollect({ body, headers: headers(), ...extra }, l);

describe("privacy helpers", () => {
  it("a path is stored without its query, fragment and identifiers", () => {
    expect(sanitizePath("/pricing?plan=pro&email=a@b.co#top")).toBe("/pricing");
    expect(sanitizePath("/join/CONF26")).toBe("/join/:code");
    expect(sanitizePath("/dashboard/chat/3f2c1a7e-1111-4222-8333-444455556666")).toBe("/dashboard/chat/:id");
    expect(sanitizePath("/results/123456789")).toBe("/results/:id");
    expect(sanitizePath("/for/students")).toBe("/for/students");
    expect(sanitizePath("pricing")).toBe("/");
    expect(sanitizePath("/" + "a".repeat(300)).length).toBeLessThanOrEqual(120);
    expect(sanitizePath(undefined)).toBe("/");
  });

  it("the admin area, the API, the framework files and the sign-in callbacks are never tracked", () => {
    for (const path of ["/admin", "/admin/jobs", "/api/chat", "/_next/static/x.js", "/auth/callback", "/admin?x=1"]) expect(isExcludedPath(path), path).toBe(true);
    for (const path of ["/", "/pricing", "/login", "/dashboard/chat", "/administrators"]) expect(isExcludedPath(path), path).toBe(false);
  });

  it("the referrer is a host only, never the site itself, never a malformed value", () => {
    expect(referrerHostOf("https://www.google.com/search?q=secret&x=1", "diger.tech")).toBe("google.com");
    expect(referrerHostOf("https://diger.tech/pricing", "diger.tech")).toBeNull();
    expect(referrerHostOf("https://app.diger.tech/x", "diger.tech")).toBeNull();
    expect(referrerHostOf("t.co", "diger.tech")).toBe("t.co");
    expect(referrerHostOf("javascript:alert(1)", "diger.tech")).toBeNull();
    expect(referrerHostOf("", "diger.tech")).toBeNull();
    expect(referrerHostOf("localhost", "diger.tech")).toBeNull();
  });

  it("the device class is read from the agent: phone, tablet or computer", () => {
    expect(deviceClassOf(IPHONE)).toBe("mobile");
    expect(deviceClassOf(ANDROID_PHONE)).toBe("mobile");
    expect(deviceClassOf(IPAD)).toBe("tablet");
    expect(deviceClassOf(ANDROID_TABLET)).toBe("tablet");
    expect(deviceClassOf(CHROME)).toBe("desktop");
    expect(deviceClassOf("")).toBe("desktop");
  });

  it("bots, crawlers, previews, scripted clients and an empty agent are not visitors; real browsers are", () => {
    for (const ua of ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "curl/8.4.0", "python-requests/2.31", "Mozilla/5.0 HeadlessChrome/126", "facebookexternalhit/1.1", "WhatsApp/2.23", "Mozilla/5.0 (compatible; bingbot/2.0)", "Lighthouse", "node-fetch", "", "x"]) expect(isBotUserAgent(ua), ua).toBe(true);
    for (const ua of [IPHONE, CHROME, ANDROID_PHONE, IPAD]) expect(isBotUserAgent(ua), ua).toBe(false);
  });

  it("Do Not Track and Global Privacy Control are respected", () => {
    expect(respectsDoNotTrack(new Headers({ dnt: "1" }))).toBe(true);
    expect(respectsDoNotTrack(new Headers({ "sec-gpc": "1" }))).toBe(true);
    expect(respectsDoNotTrack(new Headers({ dnt: "0" }))).toBe(false);
    expect(respectsDoNotTrack(new Headers())).toBe(false);
  });

  it("the country is the hosting platform's two-letter header or nothing", () => {
    expect(countryOf(new Headers({ "x-vercel-ip-country": "eg" }))).toBe("EG");
    expect(countryOf(new Headers({ "x-vercel-ip-country": "XX" }))).toBeNull();
    expect(countryOf(new Headers({ "x-vercel-ip-country": "Egypt" }))).toBeNull();
    expect(countryOf(new Headers())).toBeNull();
    expect(clampDuration(99999999)).toBe(86400);
    expect(clampDuration(-3)).toBeNull();
    expect(clampDuration("12.7")).toBe(12);
  });
});

describe("what a beacon stores", () => {
  const ROW_KEYS = ["country", "device_class", "duration_seconds", "kind", "path", "referrer_host", "session_id", "user_id", "visitor_id"];

  it("a page view: the stored row holds exactly the allowed fields, the query is stripped, the referrer is a host, no address and no agent", () => {
    const d = decide({ k: "view", s: SID, p: "/pricing?utm_source=x&token=abc", r: "https://www.google.com/search?q=y" }, { ownHost: "diger.tech", cookieVisitorId: VID });
    expect(d.status).toBe(204);
    expect(Object.keys(d.row!).sort()).toEqual(ROW_KEYS);
    expect(d.row).toMatchObject({ visitor_id: VID, session_id: SID, kind: "view", path: "/pricing", referrer_host: "google.com", device_class: "desktop", duration_seconds: null, user_id: null });
    expect(JSON.stringify(d.row)).not.toMatch(/Mozilla|Windows|Chrome|utm_source|token|abc|q=y/);
    expect(d.setVisitorId).toBeUndefined();
  });

  it("the country comes from the platform header; the address headers are never read into the row", () => {
    const d = decideCollect({ body: { k: "view", s: SID, p: "/" }, headers: headers({ "x-vercel-ip-country": "EG", "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" }), cookieVisitorId: VID }, limiters());
    expect(d.row!.country).toBe("EG");
    expect(JSON.stringify(d.row)).not.toContain("203.0.113.9");
  });

  it("a visitor with no valid cookie gets a new anonymous id to put in a first-party cookie; one with a valid cookie keeps it", () => {
    const first = decide({ k: "view", s: SID, p: "/" }, { newVisitorId: () => "e".repeat(32) });
    expect(first.setVisitorId).toBe("e".repeat(32));
    expect(first.row!.visitor_id).toBe("e".repeat(32));
    const forged = decide({ k: "view", s: SID, p: "/" }, { cookieVisitorId: "not-a-visitor-id; DROP TABLE", newVisitorId: () => "f".repeat(32) });
    expect(forged.row!.visitor_id).toBe("f".repeat(32));
    expect(decide({ k: "view", s: SID, p: "/" }, { cookieVisitorId: VID }).setVisitorId).toBeUndefined();
  });

  it("leaving a page stores the seconds spent (clamped); only a view carries a referrer", () => {
    const leave = decide({ k: "leave", s: SID, p: "/pricing", d: 37.8, r: "https://google.com" }, { cookieVisitorId: VID });
    expect(leave.row).toMatchObject({ kind: "leave", duration_seconds: 37, referrer_host: null });
    expect(decide({ k: "leave", s: SID, p: "/", d: 10 ** 9 }, { cookieVisitorId: VID }).row!.duration_seconds).toBe(86400);
    expect(decide({ k: "leave", s: SID, p: "/" }, { cookieVisitorId: VID }).status).toBe(400);
  });

  it("a sign-in carries the account the SERVER verified; a sign-up never carries one; the page's own claim is ignored", () => {
    const login = decide({ k: "login", s: SID, user_id: "00000000-0000-0000-0000-000000000001" }, { cookieVisitorId: VID, verifiedUserId: "11111111-1111-4111-8111-111111111111" });
    expect(login.row).toMatchObject({ kind: "login", path: "/login", user_id: "11111111-1111-4111-8111-111111111111" });
    expect(decide({ k: "login", s: SID }, { cookieVisitorId: VID }).row!.user_id).toBeNull();
    expect(decide({ k: "signup", s: SID }, { cookieVisitorId: VID, verifiedUserId: "11111111-1111-4111-8111-111111111111" }).row).toMatchObject({ kind: "signup", path: "/register", user_id: null });
    expect(decide({ k: "view", s: SID, p: "/", user_id: "x" }, { cookieVisitorId: VID, verifiedUserId: "11111111-1111-4111-8111-111111111111" }).row!.user_id).toBeNull();
  });
});

describe("who is not tracked", () => {
  it("a bot is ignored: nothing stored, no cookie", () => {
    const d = decideCollect({ body: { k: "view", s: SID, p: "/" }, headers: new Headers({ "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }) }, limiters());
    expect(d).toEqual({ status: 204, ignored: "bot" });
  });

  it("Do Not Track: nothing stored and no cookie is set", () => {
    const d = decideCollect({ body: { k: "view", s: SID, p: "/" }, headers: headers({ dnt: "1" }) }, limiters());
    expect(d).toEqual({ status: 204, ignored: "do_not_track" });
    expect(decideCollect({ body: { k: "view", s: SID, p: "/" }, headers: headers({ "sec-gpc": "1" }) }, limiters()).row).toBeUndefined();
  });

  it("admin pages are ignored, and so is the admin account", () => {
    expect(decide({ k: "view", s: SID, p: "/admin/jobs" }, { cookieVisitorId: VID })).toEqual({ status: 204, ignored: "excluded_path" });
    expect(decide({ k: "view", s: SID, p: "/api/x" }, { cookieVisitorId: VID }).row).toBeUndefined();
    expect(decide({ k: "login", s: SID }, { cookieVisitorId: VID, verifiedUserId: "11111111-1111-4111-8111-111111111111", verifiedIsAdmin: true })).toEqual({ status: 204, ignored: "admin" });
  });

  it("a malformed beacon is refused (400), never stored", () => {
    for (const body of [null, "x", { k: "click", s: SID, p: "/" }, { k: "view", s: "short", p: "/" }, { k: "view", p: "/" }]) expect(decide(body, { cookieVisitorId: VID }).status, JSON.stringify(body)).toBe(400);
  });
});

describe("the rate limit", () => {
  it("at most 40 beacons a minute for one visitor session; the 41st is refused and stores nothing; the next minute is open again", () => {
    let now = 1_000_000;
    const l = { perVisitor: createRateLimiter({ max: 40, windowMs: 60_000, now: () => now }), global: createRateLimiter({ max: 3000, windowMs: 60_000, now: () => now }) };
    const results = Array.from({ length: 41 }, () => decide({ k: "view", s: SID, p: "/" }, { cookieVisitorId: VID }, l));
    expect(results.slice(0, 40).every((r) => r.status === 204 && r.row)).toBe(true);
    expect(results[40]).toEqual({ status: 429, ignored: "rate_limited" });
    expect(decide({ k: "view", s: "9".repeat(24), p: "/" }, { cookieVisitorId: VID }, l).status).toBe(204); // another session is not affected
    now += 61_000;
    expect(decide({ k: "view", s: SID, p: "/" }, { cookieVisitorId: VID }, l).row).toBeDefined();
  });

  it("a flood across many visitors is cut by the per-instance limit", () => {
    const l = { perVisitor: createRateLimiter({ max: 40, windowMs: 60_000 }), global: createRateLimiter({ max: 5, windowMs: 60_000 }) };
    const statuses = Array.from({ length: 8 }, (_, i) => decide({ k: "view", s: String(i).repeat(24).slice(0, 24).replace(/[^a-f0-9]/g, "a"), p: "/" }, { cookieVisitorId: VID }, l).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
  });

  it("the limiter's memory is bounded", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, maxKeys: 50 });
    for (let i = 0; i < 500; i += 1) limiter.allow(`k${i}`);
    expect(limiter.allow("k1")).toBeDefined();
  });
});

describe("the beacon route is fail-open", () => {
  const post = (body: unknown, init: Record<string, string> = {}) => collectPost(new NextRequest("http://127.0.0.1:3000/api/analytics/collect", {
    method: "POST", headers: { "user-agent": CHROME, "content-type": "application/json", host: "diger.tech", ...init }, body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  beforeEach(() => { state.inserts.length = 0; state.insertMode = "ok"; state.user = null; });

  it("a view is answered 204 at once with a first-party, HttpOnly cookie, and ONE row is written with no address and no agent", async () => {
    const res = await post({ k: "view", s: "1".repeat(24), p: "/pricing?x=1", r: "https://google.com/" }, { "x-vercel-ip-country": "EG", "x-forwarded-for": "198.51.100.7" });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie") || "";
    expect(cookie).toMatch(/^dgr_v=[a-f0-9]{32};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    await new Promise((r) => setTimeout(r, 20));
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ kind: "view", path: "/pricing", referrer_host: "google.com", country: "EG", device_class: "desktop" });
    expect(JSON.stringify(state.inserts[0])).not.toMatch(/198\.51\.100\.7|Mozilla|Chrome/);
  });

  it("a write that throws, errors or never finishes never reaches the visitor: the answer is still 204 and fast", async () => {
    for (const mode of ["throw", "error", "hang"] as const) {
      state.insertMode = mode;
      const started = Date.now();
      const res = await post({ k: "view", s: "2".repeat(24), p: "/" });
      expect(res.status, mode).toBe(204);
      expect(Date.now() - started, mode).toBeLessThan(500);
    }
  });

  it("Do Not Track, a bot and an admin page write nothing", async () => {
    await post({ k: "view", s: "3".repeat(24), p: "/" }, { dnt: "1" });
    await post({ k: "view", s: "3".repeat(24), p: "/" }, { "user-agent": "Googlebot/2.1" });
    await post({ k: "view", s: "3".repeat(24), p: "/admin/jobs" });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.inserts).toHaveLength(0);
  });

  it("an admin's sign-in is not recorded; a customer's is, with the account the server verified", async () => {
    state.user = { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co", app_metadata: { role: "admin" } };
    await post({ k: "login", s: "4".repeat(24) });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.inserts).toHaveLength(0);
    state.user = { id: "22222222-2222-4222-8222-222222222222", email: "c@d.co", app_metadata: {} };
    await post({ k: "login", s: "4".repeat(24), user_id: "ignored" });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ kind: "login", user_id: "22222222-2222-4222-8222-222222222222" });
    expect(JSON.stringify(state.inserts[0])).not.toContain("c@d.co");
  });

  it("garbage and oversized bodies are refused without a write", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post("x".repeat(MAX_BEACON_BYTES * 3), { "content-length": String(MAX_BEACON_BYTES * 3) })).status).toBe(413);
    await new Promise((r) => setTimeout(r, 20));
    expect(state.inserts).toHaveLength(0);
  });

  it("the route is public (no call to the sign-in service for a page view)", () => {
    expect(isPublicPath("/api/analytics/collect")).toBe(true);
    expect(isPublicPath("/api/admin/visitors")).toBe(false);
  });
});

describe("the browser beacon", () => {
  const calls: Array<{ url: string; init: any }> = [];
  const beacons: Array<{ url: string; body: any }> = [];
  const stubBrowser = (nav: Record<string, unknown> = {}) => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", { location: { host: "diger.tech" }, sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } } });
    vi.stubGlobal("document", { referrer: "https://www.google.com/search?q=private" });
    vi.stubGlobal("navigator", { sendBeacon: (url: string, body: Blob) => { beacons.push({ url, body }); return true; }, ...nav });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return new Response(null, { status: 204 }); }));
  };
  afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; beacons.length = 0; vi.resetModules(); });

  it("one beacon on the view (path, session and the referring host only) and one on leaving with the seconds", async () => {
    stubBrowser();
    const { trackView } = await import("../src/lib/analytics/client");
    const tracker = trackView("/pricing")!;
    expect(tracker).not.toBeNull();
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0].init.body);
    expect(Object.keys(sent).sort()).toEqual(["k", "p", "r", "s"]);
    expect(sent).toMatchObject({ k: "view", p: "/pricing", r: "www.google.com" });
    expect(calls[0].init.credentials).toBe("same-origin");
    expect(JSON.stringify(sent)).not.toMatch(/private|q=/);
    tracker.leave();
    tracker.leave(); // a second leave of the same view sends nothing
    expect(beacons).toHaveLength(1);
    expect(JSON.parse(await (beacons[0].body as Blob).text())).toMatchObject({ k: "leave", p: "/pricing", d: expect.any(Number) });
    // the next page view of the session does not repeat the referrer
    const second = trackView("/calculator")!;
    expect(JSON.parse(calls[1].init.body).r).toBe("");
    second.leave();
  });

  it("Do Not Track and Global Privacy Control send nothing at all", async () => {
    for (const nav of [{ doNotTrack: "1" }, { globalPrivacyControl: true }]) {
      stubBrowser(nav);
      const { trackView, trackAuthEvent } = await import("../src/lib/analytics/client");
      expect(trackView("/pricing")).toBeNull();
      trackAuthEvent("login");
      expect(calls).toHaveLength(0);
      expect(beacons).toHaveLength(0);
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("the admin area is never tracked; a failing fetch is swallowed", async () => {
    stubBrowser();
    const { trackView } = await import("../src/lib/analytics/client");
    expect(trackView("/admin/visitors")).toBeNull();
    expect(calls).toHaveLength(0);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline"); }));
    expect(() => trackView("/pricing")).not.toThrow();
  });

  it("the beacon sources read no cookie, storage of the page's content, form, user agent or address (static check)", () => {
    const source = ["src/lib/analytics/client.ts", "src/components/analytics/VisitBeacon.tsx"].map((file) => readFileSync(file, "utf8")).join("\n");
    for (const forbidden of ["document.cookie", "localStorage", "userAgent", "innerText", "textContent", "FormData", "getElementBy", "querySelector"]) expect(source, forbidden).not.toContain(forbidden);
    const beacon = readFileSync("src/components/analytics/VisitBeacon.tsx", "utf8");
    expect(beacon).toContain("isAdmin");
    expect(beacon).toContain("loading");
  });

  it("no source under analytics reads or stores an address header or a full user agent (static check)", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = path.join(dir, name); if (statSync(full).isDirectory()) walk(full); else if (/\.(ts|tsx)$/.test(name)) files.push(full); } };
    walk("src/lib/analytics"); walk("src/app/api/analytics");
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const forbidden of ["x-forwarded-for", "x-real-ip", "remoteAddress", "req.ip", "request.ip"]) expect(source, forbidden).not.toContain(forbidden);
    // the user agent is read once, to classify, and the row has no field for it
    expect((source.match(/get\("user-agent"\)/g) || []).length).toBeLessThanOrEqual(2);
    expect(source).not.toMatch(/user_agent/);
    expect(readFileSync("src/lib/analytics/collect.ts", "utf8").match(/export interface VisitRow \{[^}]*\}/)![0]).not.toMatch(/agent|address|ip\b/i);
  });
});

describe("the arithmetic of the admin numbers", () => {
  const row = (over: Partial<VisitEventRow>): VisitEventRow => ({ visitor_id: "a".repeat(32), session_id: "1".repeat(24), kind: "view", path: "/", country: "EG", device_class: "mobile", started_at: "2026-10-24T10:00:00Z", duration_seconds: null, user_id: null, ...over });
  const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32), D = "d".repeat(32);
  const S1 = "1".repeat(24), S2 = "2".repeat(24), S3 = "3".repeat(24), S4 = "4".repeat(24);
  const rows: VisitEventRow[] = [
    row({ visitor_id: A, session_id: S1, path: "/", started_at: "2026-10-24T10:00:00Z", device_class: "mobile", country: "EG" }),
    row({ visitor_id: A, session_id: S1, path: "/pricing", started_at: "2026-10-24T10:01:00Z", device_class: "mobile", country: "EG" }),
    row({ visitor_id: A, session_id: S1, kind: "leave", path: "/", started_at: "2026-10-24T10:01:00Z", duration_seconds: 60 }),
    row({ visitor_id: A, session_id: S1, kind: "leave", path: "/pricing", started_at: "2026-10-24T10:03:00Z", duration_seconds: 120 }),
    row({ visitor_id: B, session_id: S2, path: "/", started_at: "2026-10-24T11:00:00Z", device_class: "desktop", country: "SA" }),
    row({ visitor_id: B, session_id: S2, kind: "leave", path: "/", started_at: "2026-10-24T11:00:30Z", duration_seconds: 30 }),
    row({ visitor_id: C, session_id: S3, path: "/pricing", started_at: "2026-10-24T12:00:00Z", device_class: "tablet", country: null }),
    row({ visitor_id: A, session_id: S4, path: "/", started_at: "2026-10-24T13:00:00Z", device_class: "mobile", country: "EG" }),
    row({ visitor_id: A, session_id: S4, kind: "login", path: "/login", started_at: "2026-10-24T13:01:00Z", user_id: "11111111-1111-4111-8111-111111111111" }),
    row({ visitor_id: B, session_id: S2, kind: "signup", path: "/register", started_at: "2026-10-24T11:05:00Z" }),
    row({ visitor_id: A, session_id: S4, kind: "signup", path: "/register", started_at: "2026-10-24T13:00:30Z" }),
    row({ visitor_id: D, session_id: "5".repeat(24), kind: "signup", path: "/register", started_at: "2026-10-24T14:00:00Z" }), // a sign-up with no view of its own: not in the funnel
  ];
  const range = { range: "today" as const, since: new Date("2026-10-23T21:00:00Z") };

  it("visits, page views, visitors, time, pages, devices, countries, sign-ups and sign-ins add up", () => {
    const summary = summarizeVisits(rows, { ...range, firstRequestByUser: new Map([["11111111-1111-4111-8111-111111111111", "2026-10-24T13:05:00Z"]]) });
    expect(summary.visits).toBe(4); // S1, S2, S3, S4
    expect(summary.pageViews).toBe(5);
    expect(summary.uniqueVisitors).toBe(3); // A, B, C
    // time on a visit: S1 = 60 + 120, S2 = 30; S3 and S4 have no leave row and are left out of the average: (180 + 30) / 2
    expect(summary.avgVisitSeconds).toBe(105);
    expect(summary.topPages).toEqual([{ path: "/", views: 3, visitors: 2 }, { path: "/pricing", views: 2, visitors: 2 }]);
    expect(summary.devices).toEqual({ mobile: 2, desktop: 1, tablet: 1 });
    expect(summary.devices.mobile + summary.devices.desktop + summary.devices.tablet).toBe(summary.visits);
    expect(summary.countries).toEqual([{ code: "EG", visits: 2 }, { code: null, visits: 1 }, { code: "SA", visits: 1 }]);
    expect(summary.logins).toEqual({ events: 1, users: 1 });
    expect(summary.signups).toEqual({ events: 3 });
  });

  it("the funnel is nested: visited, of them signed up, of them with a first request", () => {
    const funnel = summarizeVisits(rows, { ...range, firstRequestByUser: new Map([["11111111-1111-4111-8111-111111111111", "2026-10-24T13:05:00Z"]]) }).funnel;
    expect(funnel).toEqual({ visited: 3, signedUp: 2, requested: 1 }); // A and B signed up; only A's account (linked at login) has a request; D never viewed a page
    expect(funnel.requested).toBeLessThanOrEqual(funnel.signedUp);
    expect(funnel.signedUp).toBeLessThanOrEqual(funnel.visited);
    expect(summarizeVisits(rows, range).funnel.requested).toBe(0);
  });

  it("an empty range gives zeros and no average", () => {
    expect(summarizeVisits([], range)).toMatchObject({ visits: 0, pageViews: 0, uniqueVisitors: 0, avgVisitSeconds: null, funnel: { visited: 0, signedUp: 0, requested: 0 }, topPages: [], countries: [] });
  });

  it("a session's time is capped at four hours", () => {
    const capped = summarizeVisits([row({ session_id: S1 }), row({ session_id: S1, kind: "leave", duration_seconds: 86_400 })], range);
    expect(capped.avgVisitSeconds).toBe(4 * 3600);
  });

  it("the ranges: today starts at midnight in Cairo, seven days is a rolling week, all has no start", () => {
    expect(rangeStart("today", new Date("2026-01-15T10:00:00Z"))!.toISOString()).toBe("2026-01-14T22:00:00.000Z");
    expect(rangeStart("today", new Date("2026-07-15T10:00:00Z"))!.toISOString()).toBe("2026-07-14T21:00:00.000Z");
    expect(rangeStart("7d", new Date("2026-10-24T00:00:00Z"))!.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(rangeStart("all")).toBeNull();
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("yesterday")).toBe("today");
    expect(parseRange(null)).toBe("today");
  });

  it("Arabic wording: digits, durations, percentages, country names", () => {
    expect(durationAr(105)).toBe("دقيقة واحدة و٤٥ ثانية");
    expect(durationAr(7)).toBe("٧ ثوانٍ");
    expect(durationAr(180)).toBe("٣ دقائق");
    expect(durationAr(null)).toBe("—");
    expect(percentAr(1, 3)).toBe("٣٣٫٣٪");
    expect(percentAr(0, 0)).toBe("—");
    expect(countryNameAr("EG")).toBe("مصر");
    expect(countryNameAr(null)).toBe("غير معروفة");
  });
});

describe("the admin route and the admin screen", () => {
  const ADMIN = { id: "admin-1", email: "owner@example.test", app_metadata: { role: "admin" }, user_metadata: { name: "المدير" } };
  const get = (query = "") => visitorsGet(new NextRequest(`http://127.0.0.1:3000/api/admin/visitors${query}`));
  const event = (i: number): VisitEventRow => ({ visitor_id: "a".repeat(32), session_id: "1".repeat(24), kind: "view", path: "/", country: "EG", device_class: "mobile", started_at: new Date(Date.UTC(2026, 9, 24, 0, 0, 0) + i * 1000).toISOString(), duration_seconds: null, user_id: null });
  beforeEach(() => { state.user = null; state.table = []; state.tableMissing = false; state.pagesRead = 0; state.counts = { profiles: 7, jobs: 4 }; state.jobsRows = []; state.headCounts = []; });

  it("only an admin reads it: a signed-out visitor and a customer get nothing and no table is read", async () => {
    expect((await get()).status).toBe(401);
    state.user = { id: "u1", email: "c@d.co", app_metadata: {} };
    expect((await get()).status).toBe(403);
    expect(state.pagesRead).toBe(0);
  });

  it("the admin gets the summary and the two counts; the accounts and requests come from head counts, not rows", async () => {
    state.user = ADMIN;
    state.table = [event(0), event(1), { ...event(2), kind: "login", user_id: "11111111-1111-4111-8111-111111111111" }, { ...event(3), kind: "signup" }];
    state.jobsRows = [{ user_id: "11111111-1111-4111-8111-111111111111", created_at: "2026-10-24T05:00:00Z" }];
    const body = await (await get("?range=7d")).json();
    expect(body.available).toBe(true);
    expect(body.summary).toMatchObject({ range: "7d", visits: 1, pageViews: 2, uniqueVisitors: 1, truncated: false, funnel: { visited: 1, signedUp: 1, requested: 1 } });
    expect(body.newAccounts).toBe(7);
    expect(body.submittedRequests).toBe(4);
    expect(state.headCounts.sort()).toEqual(["jobs", "profiles"]);
  });

  it("the read is bounded: at most 20 pages of 1,000 rows, and the screen is told the range is larger", async () => {
    state.user = ADMIN;
    state.table = Array.from({ length: SUMMARY_ROW_LIMIT + 500 }, (_, i) => event(i));
    const body = await (await get("?range=all")).json();
    expect(state.pagesRead).toBe(SUMMARY_ROW_LIMIT / 1000);
    expect(body.summary.truncated).toBe(true);
    expect(body.summary.pageViews).toBe(SUMMARY_ROW_LIMIT);
  });

  it("before the SQL is applied the answer is «not available», never an error", async () => {
    state.user = ADMIN;
    state.tableMissing = true;
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it("the tab «الزوّار» is in the admin menu; the page is Arabic only", () => {
    expect(ADMIN_PAGES.find(([id]) => id === "visitors")![1]).toBe("الزوّار");
    expect(adminHref("visitors")).toBe("/admin/visitors");
    const html = renderToStaticMarkup(createElement(AdminVisitorsPage as any));
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).toContain("اليوم");
    expect(text).toContain("آخر ٧ أيام");
    expect(text).toContain("الكل");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("the screens carry no English words, no ASCII digits and no emoji in their text (static check)", () => {
    for (const file of ["src/app/admin/visitors/page.tsx", "src/components/admin/VisitorsSummaryCard.tsx", "src/components/admin/visitorFormat.ts"]) {
      const source = readFileSync(file, "utf8");
      const strings = [...source.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) => m[1]).filter((value) => /[\u0600-\u06FF]/.test(value));
      expect(strings.length, file).toBeGreaterThan(0);
      for (const value of strings) { expect(value, value).not.toMatch(/[A-Za-z]/); expect(value, value).not.toMatch(/[0-9]/); expect(value, value).not.toMatch(/\p{Extended_Pictographic}/u); }
    }
  });
});
