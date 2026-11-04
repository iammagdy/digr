import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { balanceFailed, balanceLoading, balanceReady, balanceText } from "../src/lib/honestDisplay";

/**
 * ROUND 26, item 9: THE FIRST LOAD OF THE SIGNED-IN SITE.
 * Where the time goes (read from the code, in order): (1) the browser reads the stored session (`getSession`, no request unless the token is old); (2) React renders
 * the user; (3) only then did the balance provider run: it read the session AGAIN, then asked `/api/wallet/balance`, which asks the sign-in service to verify the token
 * and then sums the ledger. So the balance waited for step 2 and for a second session read, one after the other.
 * Now: the balance read starts on mount from the session itself (in parallel with the page), reads the session once, and is shared with the user-change step
 * (no second request for the same account). The header shows neither the signed-out buttons nor a zero before the session or the balance is known.
 */
const UID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

const USER_BASE = { id: UID, $id: UID, email: "maha@example.test", name: "مها السيد", emailVerification: true, labels: [], app_metadata: {}, user_metadata: {}, prefs: {} };
const ctl = vi.hoisted(() => ({ user: null as any, loading: true, balance: { status: "loading", value: null } as any }));
vi.mock("../src/hooks/useUser", () => ({ useUser: () => ({ user: ctl.user, loading: ctl.loading, logout: async () => {} }) }));
vi.mock("../src/hooks/useBalance", () => ({ useBalance: () => ({ balance: ctl.balance, refresh: async () => {} }) }));
vi.mock("../src/hooks/useOnline", () => ({ useOnline: () => true }));
vi.mock("../src/hooks/useNotifications", () => ({ useNotifications: () => ({ items: [], unread: 0, actionableUnread: 0, markAllRead: async () => {}, markRead: async () => {}, reload: async () => {} }) }));
vi.mock("../src/lib/theme", () => ({ useTheme: () => ({ theme: "light", toggleTheme: () => {}, setTheme: () => {} }) }));
vi.mock("../src/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({}), storage: { from: () => ({}) } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/dashboard/chat" }));

import { AppShell } from "../src/components/app/AppShell";
import { readBalanceForSession } from "../src/lib/readBalance";

beforeEach(() => { ctl.user = null; ctl.loading = true; ctl.balance = balanceLoading(); });
const shell = () => renderToStaticMarkup(createElement(AppShell, null, createElement("div", null, "صفحة")));

describe("no signed-out flash for a signed-in customer", () => {
  it("while the session is being read the header draws neither the sign-in button nor the sign-up button", () => {
    const html = shell();
    expect(html).not.toContain("تسجيل الدخول");
    expect(html).not.toContain("إنشاء حساب");
    expect(html).toContain("account-pending");
  });
  it("a visitor (session read, no user) does get the sign-in button", () => {
    ctl.loading = false;
    expect(shell()).toContain("تسجيل الدخول");
  });
  it("the account provider holds `loading` until the stored session has been read, and sets the user and `loading` in the same step", () => {
    const src = readFileSync("src/hooks/useUser.tsx", "utf8");
    expect(src).toMatch(/useState\(true\)/);
    const from = src.indexOf("const readStoredSession");
    const block = src.slice(from, src.indexOf("useEffect(() => {", from));
    expect(block).toMatch(/setUser\(session\?\.user \? mapSupabaseUser\(session\.user\) : null\);[\s\S]*finally \{\s*setLoading\(false\);/);
  });
});

describe("the balance of a signed-in customer", () => {
  it("is a skeleton before it is known: no zero, no wrong number", () => {
    ctl.user = USER_BASE; ctl.loading = false;
    const html = shell();
    expect(html).toContain('data-testid="balance-skeleton"');
    expect(html).not.toContain(">٠<");
  });
  it("shows the number once it is known", () => {
    ctl.user = USER_BASE; ctl.loading = false; ctl.balance = balanceReady(1250);
    const html = shell();
    expect(html).toContain(balanceText(balanceReady(1250)));
    expect(html).not.toContain('data-testid="balance-skeleton"');
  });
});

const session = (id = UID) => ({ access_token: "tok-" + id, user: { id } });
const okResponse = (balance: number) => ({ ok: true, json: async () => ({ success: true, balance }) }) as any;

describe("readBalanceForSession: one session read, the account comes from the session, the source is unchanged", () => {
  it("reads the session once, asks the shared server endpoint with that token and returns the balance for the session's own account", async () => {
    const getSession = vi.fn(async () => ({ data: { session: session() } }));
    const fetchFn = vi.fn(async (..._a: any[]) => okResponse(125));
    const from = vi.fn();
    const read = await readBalanceForSession({ auth: { getSession }, from } as any, fetchFn as any, null);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe("/api/wallet/balance");
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-" + UID);
    expect(from).not.toHaveBeenCalled();
    expect(read).toEqual({ ownerId: UID, balance: balanceReady(125) });
  });
  it("with no stored session and no known user it asks nothing and returns nothing", async () => {
    const fetchFn = vi.fn();
    const read = await readBalanceForSession({ auth: { getSession: async () => ({ data: { session: null } }) }, from: vi.fn() } as any, fetchFn as any, null);
    expect(read).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("the account of the result is the session's account, not a previously known one (an account switch never shows the old balance)", async () => {
    const read = await readBalanceForSession({ auth: { getSession: async () => ({ data: { session: session(OTHER) } }) }, from: vi.fn() } as any, (async () => okResponse(9)) as any, UID);
    expect(read?.ownerId).toBe(OTHER);
  });
  it("when the server endpoint fails the customer's own ledger rows are summed (same rule as before), filtered by the account", async () => {
    const eq = vi.fn(async (..._a: any[]) => ({ data: [{ delta: 100 }, { delta: -30 }], error: null }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const read = await readBalanceForSession({ auth: { getSession: async () => ({ data: { session: session() } }) }, from } as any, (async () => ({ ok: false })) as any, null);
    expect(from).toHaveBeenCalledWith("credit_ledger");
    expect(eq).toHaveBeenCalledWith("user_id", UID);
    expect(read?.balance).toEqual(balanceReady(70));
  });
  it("a failure of both is «failed», never a zero", async () => {
    const eq = vi.fn(async () => ({ data: null, error: { message: "x" } }));
    const from = vi.fn(() => ({ select: () => ({ eq }) }));
    const read = await readBalanceForSession({ auth: { getSession: async () => ({ data: { session: session() } }) }, from } as any, (async () => { throw new Error("net"); }) as any, null);
    expect(read?.balance).toEqual(balanceFailed());
  });
});

describe("the provider starts the read on mount, in parallel with the page", () => {
  const src = readFileSync("src/hooks/useBalance.tsx", "utf8");
  it("does not wait for the user object to be rendered, and shares one read with the user-change step", () => {
    expect(src).toContain("readBalanceForSession");
    expect(src).not.toMatch(/if \(!user\) return;/);
    expect(src).toMatch(/useEffect\(\(\) => \{ void refresh\(\); \}, \[refresh\]\)/);
    expect(src).toContain("inflight");
  });
  it("keeps the cache rule: a cached balance is shown only to its own account", () => {
    expect(src).toContain("balanceForUser(cached, user?.id ?? null)");
  });
});
