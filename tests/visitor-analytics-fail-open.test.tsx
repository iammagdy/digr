import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The beacon can never break a page or a sign-in: a throwing listener, a throwing sendBeacon / fetch / navigator, blocked session storage, and a beacon of an
 * unauthenticated caller. React's `useEffect` is run at once (there is no DOM in this environment) so the real effect body and its cleanup execute; the auth
 * provider's hooks are stubbed so its real `login` and `register` run. Fake supabase clients only.
 */
const ctl = vi.hoisted(() => ({
  runEffects: true,
  cleanup: undefined as undefined | (() => void),
  setUserCalls: [] as unknown[],
  user: null as any,
  inserts: [] as any[],
}));

vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useEffect: (fn: () => any) => { if (ctl.runEffects) ctl.cleanup = fn(); },
  useState: (initial: any) => [typeof initial === "function" ? initial() : initial, (value: unknown) => { ctl.setUserCalls.push(value); }],
  useCallback: (fn: any) => fn,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/pricing" }));
vi.mock("../src/hooks/useUser", async (orig) => {
  const real = await orig<typeof import("../src/hooks/useUser")>();
  return { ...real, useUser: () => ({ user: null, loading: false }) };
});
const SIGNED_IN = { id: "11111111-1111-4111-8111-111111111111", email: "c@d.co", email_confirmed_at: "2026-10-24T00:00:00Z", app_metadata: {}, user_metadata: { name: "عميل" } };
vi.mock("../src/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: async () => ({ data: { user: SIGNED_IN }, error: null }),
      signUp: async () => ({ data: { user: SIGNED_IN }, error: null }),
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  }),
}));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: ctl.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({ from: () => ({ insert: (row: any) => { ctl.inserts.push(row); return Promise.resolve({ error: null }); } }) })),
}));

import { decideCollect, createRateLimiter } from "../src/lib/analytics/collect";
import { POST as collectPost } from "../src/app/api/analytics/collect/route";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const stub = (opts: { storageThrows?: boolean; listenersThrow?: boolean; removeThrows?: boolean; beaconThrows?: boolean; fetchThrows?: boolean; navigatorGetterThrows?: boolean } = {}) => {
  const fetchCalls: any[] = [];
  const beacons: any[] = [];
  const listener = (kind: "add" | "remove") => () => { if ((kind === "add" && opts.listenersThrow) || (kind === "remove" && opts.removeThrows)) throw new Error(`${kind}EventListener failed`); };
  vi.stubGlobal("window", {
    location: { host: "diger.tech" },
    addEventListener: listener("add"),
    removeEventListener: listener("remove"),
    get sessionStorage() { if (opts.storageThrows) throw new Error("storage is blocked"); return { getItem: () => null, setItem: () => undefined }; },
  });
  vi.stubGlobal("document", { referrer: "", visibilityState: "visible", addEventListener: listener("add"), removeEventListener: listener("remove"), get cookie() { throw new Error("a cookie is never read"); } });
  vi.stubGlobal("navigator", opts.navigatorGetterThrows
    ? { get doNotTrack() { throw new Error("navigator getter"); }, get sendBeacon() { throw new Error("navigator getter"); } }
    : { sendBeacon: (url: string, body: unknown) => { if (opts.beaconThrows) throw new Error("sendBeacon failed"); beacons.push({ url, body }); return true; } });
  vi.stubGlobal("fetch", vi.fn((url: string, init: any) => { fetchCalls.push({ url, init }); if (opts.fetchThrows) throw new Error("fetch failed"); return Promise.resolve(new Response(null, { status: 204 })); }));
  return { fetchCalls, beacons };
};

beforeEach(() => { ctl.runEffects = true; ctl.cleanup = undefined; ctl.setUserCalls.length = 0; ctl.inserts.length = 0; ctl.user = null; });
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const runBeacon = async () => { const { VisitBeacon } = await import("../src/components/analytics/VisitBeacon"); return VisitBeacon(); };

describe("the beacon effect never throws into React", () => {
  it("addEventListener throwing: the effect and its cleanup return normally, the view was sent and the leave beacon is still sent by the cleanup", async () => {
    const { fetchCalls, beacons } = stub({ listenersThrow: true });
    expect(await runBeacon()).toBeNull();
    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(fetchCalls[0].init.body)).toMatchObject({ k: "view", p: "/pricing" });
    expect(() => ctl.cleanup?.()).not.toThrow();
    expect(beacons).toHaveLength(1);
  });

  it("removeEventListener and sendBeacon throwing inside the cleanup: nothing escapes", async () => {
    stub({ removeThrows: true, beaconThrows: true });
    await runBeacon();
    expect(() => ctl.cleanup?.()).not.toThrow();
  });

  it("session storage blocked: the page still renders, a view is sent with a session id, the same id is used for the leave", async () => {
    const { fetchCalls, beacons } = stub({ storageThrows: true });
    expect(await runBeacon()).toBeNull();
    expect(fetchCalls).toHaveLength(1);
    const sid = JSON.parse(fetchCalls[0].init.body).s;
    expect(sid).toMatch(/^[a-f0-9]{24}$/);
    expect(() => ctl.cleanup?.()).not.toThrow();
    expect(JSON.parse(await (beacons[0].body as Blob).text()).s).toBe(sid);
  });

  it("fetch throwing at once, and a navigator whose properties throw: the effect still returns normally", async () => {
    stub({ fetchThrows: true });
    await expect(runBeacon()).resolves.toBeNull();
    expect(() => ctl.cleanup?.()).not.toThrow();
    stub({ navigatorGetterThrows: true });
    await expect(runBeacon()).resolves.toBeNull();
    expect(() => ctl.cleanup?.()).not.toThrow();
  });

  it("the whole effect body and the cleanup are inside try/catch (static check)", () => {
    const source = readFileSync("src/components/analytics/VisitBeacon.tsx", "utf8");
    const effect = source.slice(source.indexOf("useEffect(() => {"));
    expect(effect.slice(0, effect.indexOf("try {") + 5)).toMatch(/useEffect\(\(\) => \{\s*(\/\/[^\n]*\n\s*)*try \{$/);
    expect((source.match(/catch/g) || []).length).toBeGreaterThanOrEqual(7);
  });
});

describe("analytics can never fail or change a sign-in or a sign-up", () => {
  const provider = async () => {
    ctl.runEffects = false;
    const { AuthProvider } = await import("../src/hooks/useUser");
    const element: any = AuthProvider({ children: null });
    return element.props.value as { login: (email: string, password: string) => Promise<any>; register: (email: string, password: string, name: string) => Promise<void> };
  };

  it("trackAuthEvent itself never throws: a throwing navigator, sendBeacon, fetch and blocked storage", async () => {
    for (const opts of [{ navigatorGetterThrows: true }, { beaconThrows: true, fetchThrows: true }, { storageThrows: true, fetchThrows: true }]) {
      stub(opts);
      const { trackAuthEvent } = await import("../src/lib/analytics/client");
      expect(() => trackAuthEvent("login"), JSON.stringify(opts)).not.toThrow();
      expect(() => trackAuthEvent("signup"), JSON.stringify(opts)).not.toThrow();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("login() still returns the signed-in user when the navigator and sendBeacon throw inside trackAuthEvent", async () => {
    stub({ navigatorGetterThrows: true, beaconThrows: true, fetchThrows: true });
    const { login } = await provider();
    const user = await login("c@d.co", "secret");
    expect(user).toMatchObject({ id: SIGNED_IN.id, email: "c@d.co", name: "عميل" });
    expect(ctl.setUserCalls.at(-1)).toMatchObject({ id: SIGNED_IN.id });
  });

  it("register() still resolves when the beacon throws, and the account is set as before", async () => {
    stub({ navigatorGetterThrows: true });
    const { register } = await provider();
    await expect(register("c@d.co", "secret", "عميل")).resolves.toBeUndefined();
    expect(ctl.setUserCalls.at(-1)).toMatchObject({ id: SIGNED_IN.id });
  });

  it("even if trackAuthEvent itself threw, the call sites are wrapped: login() and register() are unaffected", async () => {
    stub();
    vi.doMock("../src/lib/analytics/client", () => ({ trackAuthEvent: () => { throw new Error("analytics exploded"); } }));
    const { login, register } = await provider();
    await expect(login("c@d.co", "secret")).resolves.toMatchObject({ id: SIGNED_IN.id });
    await expect(register("c@d.co", "secret", "عميل")).resolves.toBeUndefined();
    vi.doUnmock("../src/lib/analytics/client");
    const hook = readFileSync("src/hooks/useUser.tsx", "utf8");
    expect(hook).toContain('try { trackAuthEvent("login"); } catch');
    expect(hook).toContain('try { trackAuthEvent("signup"); } catch');
  });
});

describe("a sign-in or sign-up beacon with no verified account is dropped", () => {
  const limiters = () => ({ perVisitor: createRateLimiter({ max: 40, windowMs: 60_000 }), global: createRateLimiter({ max: 3000, windowMs: 60_000 }) });
  const SID = "c".repeat(24);
  const VID = "d".repeat(32);
  const post = (body: unknown) => collectPost(new NextRequest("http://127.0.0.1:3000/api/analytics/collect", { method: "POST", headers: { "user-agent": CHROME, "content-type": "application/json", host: "diger.tech" }, body: JSON.stringify(body) }));

  it("decideCollect: login and signup with no verified user write no row and set no cookie (the lines are in lib/analytics/collect.ts)", () => {
    for (const kind of ["login", "signup"]) {
      for (const extra of [{}, { verifiedUserId: null }, { verifiedUserId: "" }]) {
        const decision = decideCollect({ body: { k: kind, s: SID, user_id: "11111111-1111-4111-8111-111111111111" }, headers: new Headers({ "user-agent": CHROME }), cookieVisitorId: VID, ...extra }, limiters());
        expect(decision, `${kind} ${JSON.stringify(extra)}`).toEqual({ status: 204, ignored: "unverified" });
        expect(decision.row).toBeUndefined();
        expect(decision.setVisitorId).toBeUndefined();
      }
      // a visitor with no cookie yet is not given one by a beacon that is dropped
      expect(decideCollect({ body: { k: kind, s: SID }, headers: new Headers({ "user-agent": CHROME }) }, limiters()).setVisitorId).toBeUndefined();
    }
    const source = readFileSync("src/lib/analytics/collect.ts", "utf8");
    expect(source).toContain('if (isAuthKind && !input.verifiedUserId) return { status: 204, ignored: "unverified" };');
  });

  it("a verified account is still recorded (the rule drops only the unverified)", () => {
    const decision = decideCollect({ body: { k: "login", s: SID }, headers: new Headers({ "user-agent": CHROME }), cookieVisitorId: VID, verifiedUserId: "11111111-1111-4111-8111-111111111111" }, limiters());
    expect(decision.row).toMatchObject({ kind: "login", user_id: "11111111-1111-4111-8111-111111111111" });
  });

  it("the route: an unauthenticated caller's login or signup beacon writes nothing and sets no cookie", async () => {
    ctl.user = null;
    for (const kind of ["login", "signup"]) {
      const res = await post({ k: kind, s: SID, user_id: "11111111-1111-4111-8111-111111111111" });
      expect(res.status).toBe(204);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctl.inserts).toHaveLength(0);
    // a signed-in customer is recorded
    ctl.user = { id: "22222222-2222-4222-8222-222222222222", email: "c@d.co", app_metadata: {} };
    await post({ k: "login", s: SID });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctl.inserts).toHaveLength(1);
    expect(ctl.inserts[0]).toMatchObject({ kind: "login", user_id: "22222222-2222-4222-8222-222222222222" });
  });
});
