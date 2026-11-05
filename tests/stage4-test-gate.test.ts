import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { isStage4TestViewer, stage4ServedTo, stage4TestUserIds } from "../src/lib/agentMission/stage4/testGate";
import { approvalAvailable, kindFlagOn } from "../src/lib/agentMission/stage4/approvalRoute";
import type { FileVersion } from "../src/lib/agentMission/stage4/versions";
import { solo, type Row, type SchedOpts } from "./helpers/scheduledWorld";
import { addonRowOf, objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";
import * as approvalRouteModule from "../src/app/api/missions/[id]/addon-approval/route";
import * as workflowRoute from "../src/app/api/missions/[id]/workflow/route";
import * as reviewQuoteRoute from "../src/app/api/missions/[id]/review-quote/route";
import * as reviewRequestRoute from "../src/app/api/missions/[id]/review-request/route";
import * as editRequestRoute from "../src/app/api/missions/[id]/edit-request/route";
import * as reviewReportRoute from "../src/app/api/missions/[id]/review-report/route";
import * as versionsRoute from "../src/app/api/missions/[id]/versions/route";

/**
 * STAGE 4 TEST-ACCOUNT GATE (launch round). Stage 4 must be testable on explicitly authorized test accounts WITHOUT exposing financial approval to every customer.
 * Real route handlers, the REAL viewer resolver, a fake sign-in service, the hardened FAKE money core. No network, no provider, no real money.
 * Pinned: «allowlist» serves ONLY a signed-in, non-guest, verified customer whose user id is on the server-only allowlist; nothing a customer can edit is read; a refusal is
 * indistinguishable from the feature being OFF; OFF and «on» behave exactly as before; the allowlist never reaches the browser.
 */
const state = vi.hoisted(() => ({ admin: null as any, users: {} as Record<string, any>, guests: {} as Record<string, any> }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: async () => ({ auth: { getUser: async (token?: string) => { const u = token ? state.users[token] : null; return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "bad token" } }; } } }),
  createAdminClient: () => state.admin,
}));

const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const MISSION = "msn_5851abc92a1e6645a9cd";
const LISTED = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const START = 100_000;
const CONFIRMED = "2026-11-01T00:00:00Z";
const MISSION_ROW = { id: MISSION, user_id: LISTED, status: "completed", plan: { stages: [] }, delivered_units: 60 };
let ONE: Record<string, string>;
beforeAll(() => { ONE = objectsOf(sizedVersion(6, 3) as FileVersion); });
const opts = (more: Partial<SchedOpts> = {}, owner = LISTED): SchedOpts => ({ objects: ONE, balance: START, ...more, seed: [{ ...MISSION_ROW, user_id: owner }, ...(more.seed ?? [])] });
const waiting = (userId = LISTED): Row => ({ ...addonRowOf({ status: "plan_ready", kind: "review", base: 1, cells: 18 }), user_id: userId, request_text: "طلب مراجعة", job_id: null, approved_at: null });
const holdOf = (r: Row): number => r.plan.addon.pricing.holdPoints;

beforeEach(() => {
  state.users = {
    listed: { id: LISTED, email: "t@example.com", email_confirmed_at: CONFIRMED, user_metadata: {} },
    // the SAME kind of account as everyone else but with every flag a customer could write on itself
    forger: { id: OTHER, email: "iam.magdy+9@outlook.com", email_confirmed_at: CONFIRMED, user_metadata: { is_test_account: true, is_test: true, test: true, role: "admin", stage4: true, email_verified: true }, app_metadata: {} },
    listedUnverified: { id: LISTED, email: "t@example.com", email_confirmed_at: null, user_metadata: {} },
  };
});

const call = async (route: "POST" | "GET", bearer: string | null, body: unknown, rowOwner = LISTED, env: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const row = waiting(rowOwner);
  const { value, out } = await solo(opts({ seed: [row] }, rowOwner), async (c) => {
    state.admin = c;
    const mod = approvalRouteModule;
    const headers: Record<string, string> = { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
    const req = new NextRequest(`https://diger.test/api/missions/${MISSION}/addon-approval`, route === "POST" ? { method: "POST", headers, body: JSON.stringify(body ?? { requestId: row.id, expectedPoints: holdOf(row) }) } : { method: "GET", headers });
    const res = await (route === "POST" ? mod.POST : mod.GET)(req, { params: Promise.resolve({ id: MISSION }) });
    return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
  });
  return { ...value, out, row };
};
const reserves = (out: any) => out.money.ledger.filter((l: any) => l.type === "reserve");
const ENV_TEST = { DIGER_STAGE4_APPROVAL: "allowlist", DIGER_STAGE4_REVIEW: "allowlist", DIGER_STAGE4_EDITS: "allowlist", DIGER_STAGE4_TEST_USER_IDS: LISTED };

describe("the allowlist: user ids only, strict, never «everybody»", () => {
  it("parses UUIDs (any case, comma / space / semicolon), ignores everything else", () => {
    const env = { DIGER_STAGE4_TEST_USER_IDS: ` ${LISTED.toUpperCase()}, not-a-uuid ;${OTHER}\n iam.magdy@outlook.com  *  all ` };
    expect([...stage4TestUserIds(env)].sort()).toEqual([LISTED, OTHER].sort());
  });
  it("unset, empty, whitespace, a wildcard or an e-mail authorizes NOBODY", () => {
    for (const v of [undefined, "", "   ", "*", "all", "true", "on", "iam.magdy+1@outlook.com", "@digr.local"]) {
      expect(stage4TestUserIds({ DIGER_STAGE4_TEST_USER_IDS: v }).size).toBe(0);
      expect(isStage4TestViewer({ userId: LISTED, isGuest: false, emailVerified: true }, { DIGER_STAGE4_TEST_USER_IDS: v })).toBe(false);
    }
  });
  it("a listed id is authorized only when signed in, non-guest and verified", () => {
    const env = { DIGER_STAGE4_TEST_USER_IDS: LISTED };
    expect(isStage4TestViewer({ userId: LISTED, isGuest: false, emailVerified: true }, env)).toBe(true);
    expect(isStage4TestViewer({ userId: LISTED, isGuest: true, emailVerified: true }, env)).toBe(false);
    expect(isStage4TestViewer({ userId: LISTED, isGuest: false, emailVerified: false }, env)).toBe(false);
    expect(isStage4TestViewer({ userId: OTHER, isGuest: false, emailVerified: true }, env)).toBe(false);
    expect(isStage4TestViewer(null, env)).toBe(false);
  });
  it("stage4ServedTo and the approval helpers: off never, on for everyone, test only for the authorized", () => {
    const listed = { userId: LISTED, isGuest: false, emailVerified: true };
    const other = { userId: OTHER, isGuest: false, emailVerified: true };
    const env = (mode: string) => ({ DIGER_STAGE4_APPROVAL: mode, DIGER_STAGE4_TEST_USER_IDS: LISTED });
    expect([stage4ServedTo("DIGER_STAGE4_APPROVAL", listed, env("")), stage4ServedTo("DIGER_STAGE4_APPROVAL", other, env("off"))]).toEqual([false, false]);
    expect([stage4ServedTo("DIGER_STAGE4_APPROVAL", listed, env("on")), stage4ServedTo("DIGER_STAGE4_APPROVAL", other, env("on"))]).toEqual([true, true]);
    expect([stage4ServedTo("DIGER_STAGE4_APPROVAL", listed, env("allowlist")), stage4ServedTo("DIGER_STAGE4_APPROVAL", other, env(" AllowList "))]).toEqual([true, false]);
    // «test» and every other word stay OFF for the site, even for a listed account (the old rule, unchanged)
    for (const v of ["test", "1", "true", "yes", "allow", "allowlist2"]) expect(stage4ServedTo("DIGER_STAGE4_APPROVAL", listed, env(v)), v).toBe(false);
    // the pure helpers: the default (no test account) keeps every non-«on» value OFF, exactly as before this change
    expect(approvalAvailable({ DIGER_STAGE4_APPROVAL: "allowlist" })).toBe(false);
    expect(approvalAvailable({ DIGER_STAGE4_APPROVAL: "test" }, true)).toBe(false);
    expect(approvalAvailable({ DIGER_STAGE4_APPROVAL: "allowlist" }, true)).toBe(true);
    expect(approvalAvailable({ DIGER_STAGE4_APPROVAL: "off" }, true)).toBe(false);
    expect(approvalAvailable({}, true)).toBe(false);
    expect(kindFlagOn("review", { DIGER_STAGE4_REVIEW: "allowlist" })).toBe(false);
    expect(kindFlagOn("review", { DIGER_STAGE4_REVIEW: "test" }, true)).toBe(false);
    expect(kindFlagOn("review", { DIGER_STAGE4_REVIEW: "allowlist" }, true)).toBe(true);
    expect(kindFlagOn("review_fix", { DIGER_STAGE4_REVIEW: "allowlist" }, true)).toBe(false);
  });
});

describe("the approval route: OFF and «on» behave EXACTLY as before", () => {
  it("OFF (unset): a verified customer, even one on the allowlist, gets a plain 404 and NOTHING moves", async () => {
    const r = await call("POST", "listed", undefined, LISTED, { DIGER_STAGE4_TEST_USER_IDS: LISTED });
    expect(r).toMatchObject({ status: 404, body: { success: false, error: "not_found" }, cache: "no-store" });
    expect(r.out.money.calls).toEqual([]);
    expect(reserves(r.out)).toEqual([]);
  });
  it("«on»: any verified customer is served exactly as before (no allowlist needed, none consulted)", async () => {
    const r = await call("POST", "forger", undefined, OTHER, { DIGER_STAGE4_APPROVAL: "on", DIGER_STAGE4_REVIEW: "on", DIGER_STAGE4_EDITS: "on" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, state: "approved" });
    expect(reserves(r.out)).toHaveLength(1);
  });
});

describe("«allowlist» serves ONLY the authorized test account", () => {
  it("the listed, verified customer approves: one hold, never negative", async () => {
    const r = await call("POST", "listed", undefined, LISTED, ENV_TEST);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, state: "approved" });
    expect(reserves(r.out)).toHaveLength(1);
    expect(r.out.money.balance()).toBe(START - holdOf(r.row));
  });
  it("GET tells the listed customer the control is available, and nobody else", async () => {
    expect(await call("GET", "listed", null, LISTED, ENV_TEST)).toMatchObject({ status: 200, body: { success: true, available: true } });
    expect(await call("GET", "forger", null, OTHER, ENV_TEST)).toMatchObject({ status: 404, body: { success: false, error: "not_found" } });
  });
  it("a verified customer NOT on the list, carrying every user-editable flag (is_test_account, role admin, a test-account e-mail, email_verified), gets the SAME 404 as OFF and nothing moves", async () => {
    const off = await call("POST", "forger", undefined, OTHER, {});
    const gated = await call("POST", "forger", undefined, OTHER, ENV_TEST);
    expect(gated.status).toBe(404);
    expect(gated.body).toEqual(off.body);
    expect(gated.cache).toBe(off.cache);
    expect(gated.out.money.calls).toEqual([]);
    expect(reserves(gated.out)).toEqual([]);
    expect(gated.out.money.balance()).toBe(START);
  });
  it("not signed in, a bad token, a guest cookie and a LISTED but e-mail-unverified account all get the same 404 (nothing says a gate exists)", async () => {
    const off = await call("POST", "listed", undefined, LISTED, {});
    for (const bearer of [null, "no-such-token", "listedUnverified"]) {
      const r = await call("POST", bearer, undefined, LISTED, ENV_TEST);
      expect(r.status, String(bearer)).toBe(404);
      expect(r.body, String(bearer)).toEqual(off.body);
      expect(reserves(r.out)).toEqual([]);
    }
  });
  it("an EMPTY or malformed allowlist serves nobody, not even with the flag in «allowlist»", async () => {
    for (const ids of ["", "*", "all", "iam.magdy@outlook.com"]) {
      const r = await call("POST", "listed", undefined, LISTED, { ...ENV_TEST, DIGER_STAGE4_TEST_USER_IDS: ids });
      expect(r.status, ids).toBe(404);
      expect(reserves(r.out)).toEqual([]);
    }
  });
  it("the kind's own flag still applies: approval «allowlist» with the review flag OFF serves nothing, even for the listed", async () => {
    const r = await call("POST", "listed", undefined, LISTED, { ...ENV_TEST, DIGER_STAGE4_REVIEW: "" });
    expect(r.status).toBe(404);
    expect(reserves(r.out)).toEqual([]);
  });
  it("the listed customer cannot approve ANOTHER customer's request (ownership is unchanged by the gate)", async () => {
    const r = await call("POST", "listed", undefined, OTHER, ENV_TEST);
    expect(r.status).toBe(404);
    expect(reserves(r.out)).toEqual([]);
  });
});

describe("the other Stage 4 routes follow the same gate (a customer outside the list cannot even prepare a request nothing can approve)", () => {
  const ROUTES = [
    ["workflow", "GET", workflowRoute], ["review-quote", "GET", reviewQuoteRoute], ["review-request", "GET", reviewRequestRoute], ["edit-request", "GET", editRequestRoute], ["review-report", "GET", reviewReportRoute], ["versions", "GET", versionsRoute],
  ] as const;
  for (const [name, method, routeModule] of ROUTES) {
    it(`${name}: «allowlist» → 404 for a customer not on the list; the listed customer gets past the gate; OFF → 404 for all`, async () => {
      const run = async (bearer: string | null, env: Record<string, string>) => {
        for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
        const { value } = await solo(opts({ seed: [waiting()] }), async (c) => {
          state.admin = c;
          const mod: any = routeModule;
          const req = new NextRequest(`https://diger.test/api/missions/${MISSION}/${name}`, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
          const res: Response = await mod[method](req, { params: Promise.resolve({ id: MISSION }) });
          return res.status;
        });
        vi.unstubAllEnvs();
        return value;
      };
      expect(await run("listed", {})).toBe(404);
      expect(await run("forger", ENV_TEST)).toBe(404);
      expect(await run(null, ENV_TEST)).toBe(404);
      expect(await run("listed", { ...ENV_TEST, DIGER_STAGE4_VERSIONS: "allowlist" })).not.toBe(404);
    });
  }
});

describe("the allowlist never reaches the browser", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
  const files = walk("src");
  it("the variable has no NEXT_PUBLIC_ twin and is read only by testGate.ts", () => {
    const readers = files.filter((f) => readFileSync(f, "utf8").includes("DIGER_STAGE4_TEST_USER_IDS"));
    expect(readers.map((f) => f.replace(/\\/g, "/")).sort()).toEqual(["src/lib/agentMission/stage4/testGate.ts"]);
    expect(files.filter((f) => /NEXT_PUBLIC_[A-Z0-9_]*(STAGE4|TEST_USER)/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
  it("testGate.ts is imported only by API routes and server libraries, never by a client component", () => {
    const importers = files.filter((f) => /stage4\/testGate"/.test(readFileSync(f, "utf8")));
    expect(importers.length).toBeGreaterThan(0);
    for (const f of importers) {
      const text = readFileSync(f, "utf8");
      expect(text.startsWith('"use client"') || text.startsWith("'use client'"), f).toBe(false);
      expect(/^src\/(app\/api\/|lib\/)/.test(f.replace(/\\/g, "/")), f).toBe(true);
    }
  });
  it("no route answer carries the allowlist, a user id of the list, or the word «test account»", async () => {
    const r = await call("POST", "listed", undefined, LISTED, ENV_TEST);
    const g = await call("POST", "forger", undefined, OTHER, ENV_TEST);
    for (const x of [r, g]) {
      const text = JSON.stringify(x.body);
      expect(text).not.toContain(LISTED);
      expect(text).not.toMatch(/test|allow|حساب اختبار/i);
    }
  });
});
