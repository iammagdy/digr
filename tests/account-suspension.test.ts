import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * DT-20261118-06 phase 1C (D-0094 point 1, Tier A): an admin suspends or reactivates a customer account. The sign-in service's own ban is set (no new sign-in, no token refresh), the reason goes to
 * the audit log, an admin can never suspend himself or another admin, and the dialog is told how many of the account's requests are still running (the suspension cancels none of them).
 */
const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
type FakeUser = { id: string; banned_until?: string | null; app_metadata?: Record<string, unknown> };
const state: { users: Record<string, FakeUser>; calls: Array<[string, ...unknown[]]>; audits: unknown[][]; missions: Array<{ user_id: string; status: string }>; failGet: boolean } = { users: {}, calls: [], audits: [], missions: [], failGet: false };
const adminClient = () => ({
  auth: {
    admin: {
      getUserById: async (id: string) => {
        state.calls.push(["get", id]);
        if (state.failGet) throw new Error("service down");
        return state.users[id] ? { data: { user: state.users[id] }, error: null } : { data: { user: null }, error: { message: "not found" } };
      },
      updateUserById: async (id: string, attrs: { ban_duration: string; app_metadata: Record<string, unknown> }) => {
        state.calls.push(["update", id, attrs]);
        const until = attrs.ban_duration === "none" ? null : new Date(Date.now() + parseInt(attrs.ban_duration, 10) * 3_600_000).toISOString();
        state.users[id] = { ...state.users[id], banned_until: until, app_metadata: attrs.app_metadata };
        return { data: { user: state.users[id] }, error: null };
      },
    },
  },
  from: () => ({ select: () => ({ eq: (_col: string, v: string) => ({ limit: async () => ({ data: state.missions.filter((m) => m.user_id === v), error: null }) }) }) }),
});
vi.mock("../src/lib/server/adminAuth", () => ({ authenticateAdmin: vi.fn(async () => ({ ok: true, ctx: { adminId: ADMIN_ID, audit: async (...a: unknown[]) => { state.audits.push(a); } } })) }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => adminClient(), createServerSideClient: vi.fn() }));

import { POST, GET } from "../src/app/api/admin/users/[id]/suspend/route";
import { BAN_DURATION, SUSPENDED_AR, SUSPENSION_UNKNOWN_AR, forgetSuspension, isAccountSuspended, isSensitiveMethod, parseSuspendInput, suspensionBlock, suspensionVerdict } from "../src/lib/server/accountSuspension";
import { AUTH_FAILURE_AR, authFailureMessageAr, classifyAuthFailure } from "../src/lib/authHelp";

const post = (id: string, body: unknown) => POST(new NextRequest(`http://localhost/api/admin/users/${id}/suspend`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const get = (id: string) => GET(new NextRequest(`http://localhost/api/admin/users/${id}/suspend`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  state.users = { [USER_ID]: { id: USER_ID, banned_until: null, app_metadata: { provider: "email" } }, [ADMIN_ID]: { id: ADMIN_ID, app_metadata: { role: "admin" } }, [OTHER_ADMIN]: { id: OTHER_ADMIN, app_metadata: { role: "admin" } } };
  state.calls = []; state.audits = []; state.missions = []; state.failGet = false;
  forgetSuspension();
});

describe("the admin dialog's request", () => {
  it("needs a reason of 3 characters or more, a known action and, to suspend, a known duration", () => {
    expect(parseSuspendInput({ action: "suspend", duration: "7d", reason: "x" })).toEqual({ ok: false, errorAr: "اكتب سبب الإجراء (٣ أحرف على الأقل)." });
    expect(parseSuspendInput({ action: "suspend", duration: "1y", reason: "spam orders" })).toEqual({ ok: false, errorAr: "اختر مدة الإيقاف." });
    expect(parseSuspendInput({ action: "delete", reason: "spam orders" })).toEqual({ ok: false, errorAr: "إجراء غير معروف." });
    expect(parseSuspendInput({ action: "reactivate", reason: "تمت المراجعة" })).toEqual({ ok: true, input: { action: "reactivate", reason: "تمت المراجعة" } });
    expect(BAN_DURATION).toEqual({ "7d": "168h", "30d": "720h", indefinite: "876000h" });
  });
});

describe("POST /api/admin/users/[id]/suspend", () => {
  it("suspends: the sign-in service's ban is set for the chosen duration, the account's own data is kept, and the reason goes to the audit log", async () => {
    const res = await post(USER_ID, { action: "suspend", duration: "7d", reason: "طلبات مزيفة" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, suspended: true });
    const update = state.calls.find((c) => c[0] === "update")!;
    expect(update[1]).toBe(USER_ID);
    expect(update[2]).toMatchObject({ ban_duration: "168h", app_metadata: { provider: "email", suspended: { by: ADMIN_ID, duration: "7d" } } });
    expect(state.audits).toEqual([["setting", "إيقاف حساب (7d): طلبات مزيفة", USER_ID, { targetType: "user", targetId: USER_ID }]]);
  });
  it("reactivates: the ban is lifted and the reactivation is in the audit log", async () => {
    await post(USER_ID, { action: "suspend", duration: "indefinite", reason: "مراجعة" });
    const res = await post(USER_ID, { action: "reactivate", reason: "تمت المراجعة" });
    expect(await res.json()).toMatchObject({ success: true, suspended: false, bannedUntil: null });
    expect(state.calls.filter((c) => c[0] === "update").map((c) => (c[2] as { ban_duration: string }).ban_duration)).toEqual(["876000h", "none"]);
    expect(state.audits.map((a) => a[1])).toEqual(["إيقاف حساب (indefinite): مراجعة", "إعادة تفعيل حساب: تمت المراجعة"]);
  });
  it("never suspends the admin's own account, nor another admin, and writes nothing", async () => {
    const self = await post(ADMIN_ID, { action: "suspend", duration: "7d", reason: "اختبار" });
    expect(self.status).toBe(400);
    expect((await self.json()).error).toBe("لا يمكنك إيقاف حسابك أنت.");
    const other = await post(OTHER_ADMIN, { action: "suspend", duration: "7d", reason: "اختبار" });
    expect(other.status).toBe(400);
    expect((await other.json()).error).toBe("لا يمكن إيقاف حساب مسؤول.");
    expect(state.calls.some((c) => c[0] === "update")).toBe(false);
    expect(state.audits).toEqual([]);
  });
  it("refuses a bad id and a missing reason before asking the sign-in service", async () => {
    expect((await post("not-an-id", { action: "suspend", duration: "7d", reason: "اختبار" })).status).toBe(400);
    expect((await post(USER_ID, { action: "suspend", duration: "7d" })).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
});

describe("GET /api/admin/users/[id]/suspend (what the dialog shows)", () => {
  it("says whether the account is suspended and whether it is the admin's own; it never reads the requests table (the add-on fence)", async () => {
    expect(await (await get(USER_ID)).json()).toEqual({ success: true, suspended: false, bannedUntil: null, self: false });
    await post(USER_ID, { action: "suspend", duration: "30d", reason: "طلبات مزيفة" });
    expect(await (await get(USER_ID)).json()).toMatchObject({ success: true, suspended: true });
    expect((await (await get(ADMIN_ID)).json()).self).toBe(true);
  });
});

describe("isAccountSuspended: the sign-in service's word, briefly remembered", () => {
  it("a future ban is suspended, a past one is not; one call per account within 30 seconds; a suspension through the route is seen at once", async () => {
    expect(await isAccountSuspended(adminClient as never, USER_ID)).toBe(false);
    expect(await isAccountSuspended(adminClient as never, USER_ID)).toBe(false);
    expect(state.calls.filter((c) => c[0] === "get")).toHaveLength(1);
    await post(USER_ID, { action: "suspend", duration: "30d", reason: "طلبات مزيفة" });
    expect(await isAccountSuspended(adminClient as never, USER_ID)).toBe(true);
    expect(await isAccountSuspended(adminClient as never, USER_ID, { banned_until: new Date(Date.now() - 60_000).toISOString() }, Date.now() + 40 * 86_400_000)).toBe(false);
  });
  it("the memory lasts 30 seconds, no longer: a ban set by ANOTHER instance is seen after 30 s (a warm instance must not trust an old «not suspended»)", async () => {
    const t0 = Date.now();
    expect(await isAccountSuspended(adminClient as never, USER_ID, null, t0)).toBe(false);
    state.users[USER_ID] = { ...state.users[USER_ID], banned_until: new Date(t0 + 3_600_000).toISOString() }; // set elsewhere: this instance's cache is not cleared
    expect(await isAccountSuspended(adminClient as never, USER_ID, null, t0 + 29_000)).toBe(false);
    expect(await isAccountSuspended(adminClient as never, USER_ID, null, t0 + 31_000)).toBe(true);
  });
  it("a user object that already carries a future ban answers without a call; for a READ a service outage never locks a customer out", async () => {
    expect(await isAccountSuspended(adminClient as never, USER_ID, { banned_until: new Date(Date.now() + 3_600_000).toISOString() })).toBe(true);
    expect(state.calls).toEqual([]);
    state.failGet = true;
    expect(await isAccountSuspended(adminClient as never, USER_ID)).toBe(false);
  });
});

describe("what the customer reads", () => {
  it("the sign-in page says the account is suspended (the service answers «user_banned»), never «wrong password»; the sentence is clean customer text", () => {
    const banned = { status: 400, code: "user_banned", message: "User is banned" };
    expect(classifyAuthFailure(banned)).toBe("suspended");
    expect(authFailureMessageAr(banned, "fallback")).toBe(SUSPENDED_AR);
    expect(AUTH_FAILURE_AR.suspended).toBe(SUSPENDED_AR);
    expect(checkCustomerText(SUSPENDED_AR, {}).issues).toEqual([]);
  });
});

// Gate 1: a lookup the sign-in service answers with an error is NOT remembered (it was cached as «not suspended» for 30 s); the sentence says nothing untrue for an indefinite ban
describe("Gate 1 P2: no caching of a failed lookup; the sentence stays true for every duration", () => {
  it("an {error} answer is not cached: the next request asks again and sees the ban", async () => {
    let calls = 0;
    let answer: { data: { user: { id: string; banned_until: string | null } | null }; error: unknown } = { data: { user: null }, error: { message: "service unavailable" } };
    const admin = () => ({ auth: { admin: { getUserById: async () => { calls += 1; return answer; } } } }) as never;
    const uid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    expect(await isAccountSuspended(admin, uid)).toBe(false);
    answer = { data: { user: { id: uid, banned_until: "2099-01-01T00:00:00Z" } }, error: null };
    expect(await isAccountSuspended(admin, uid)).toBe(true);
    expect(calls).toBe(2);
  });
  it("the customer sentence does not say «مؤقتًا» (an indefinite suspension is not temporary)", () => {
    expect(SUSPENDED_AR).toBe("تم إيقاف هذا الحساب. للاستفسار تواصل مع الدعم.");
  });
});


// QA FAIL at 6af74613 (fix push): a suspension must hold for every action that spends points or changes data, even when the ban cannot be read from the token or the memory is stale
describe("sensitive actions: a FRESH lookup, and the guard FAILS CLOSED", () => {
  const outage = (kind: "throw" | "error" | "nouser") => () => ({ auth: { admin: { getUserById: async () => { if (kind === "throw") throw new Error("service down"); return kind === "error" ? { data: { user: null }, error: { message: "service unavailable" } } : { data: { user: null }, error: null }; } } } }) as never;
  it("an outage of the sign-in service (error answer, thrown error, no user) is «unknown», never «active»", async () => {
    for (const kind of ["throw", "error", "nouser"] as const) expect(await suspensionVerdict(outage(kind), USER_ID, null, { fresh: true })).toBe("unknown");
    expect(await suspensionVerdict(adminClient as never, USER_ID, null, { fresh: true })).toBe("active");
    state.users[USER_ID] = { ...state.users[USER_ID], banned_until: new Date(Date.now() + 3_600_000).toISOString() };
    expect(await suspensionVerdict(adminClient as never, USER_ID, null, { fresh: true })).toBe("suspended");
  });
  it("suspensionBlock: an active account passes (null); a suspended one is 403 with the suspended sentence", async () => {
    expect(await suspensionBlock(adminClient as never, { id: USER_ID })).toBeNull();
    state.users[USER_ID] = { ...state.users[USER_ID], banned_until: new Date(Date.now() + 3_600_000).toISOString() };
    const res = await suspensionBlock(adminClient as never, { id: USER_ID }, { requestId: "r1" });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ success: false, requestId: "r1", error: SUSPENDED_AR, suspended: true });
  });
  it.each(["throw", "error", "nouser"] as const)("suspensionBlock when the ban cannot be established (%s): a retryable 503 with its own sentence, never the suspended one, and nothing passes", async (kind) => {
    const res = await suspensionBlock(outage(kind), { id: USER_ID });
    expect(res?.status).toBe(503);
    expect(res?.headers.get("retry-after")).toBe("5");
    const body = await res?.json();
    expect(body).toMatchObject({ success: false, retryable: true, error: SUSPENSION_UNKNOWN_AR });
    expect(body.suspended).toBeUndefined();
    expect(SUSPENSION_UNKNOWN_AR).not.toBe(SUSPENDED_AR);
    expect(checkCustomerText(SUSPENSION_UNKNOWN_AR, {}).issues).toEqual([]);
  });
  it("a sensitive action never trusts the memory: an «active» answer remembered earlier does not hide a ban set meanwhile (another instance's suspension)", async () => {
    expect(await isAccountSuspended(adminClient as never, USER_ID)).toBe(false); // the memory now says «active» for 30 s
    state.users[USER_ID] = { ...state.users[USER_ID], banned_until: new Date(Date.now() + 3_600_000).toISOString() }; // suspended by another instance: this memory is not cleared
    expect(await isAccountSuspended(adminClient as never, USER_ID)).toBe(false); // a read may still use it
    expect((await suspensionBlock(adminClient as never, { id: USER_ID }))?.status).toBe(403); // an action may not
  });
  it("an unknown answer is not remembered: the next sensitive call asks again and the ban is seen", async () => {
    expect((await suspensionBlock(outage("error"), { id: USER_ID }))?.status).toBe(503);
    state.users[USER_ID] = { ...state.users[USER_ID], banned_until: new Date(Date.now() + 3_600_000).toISOString() };
    expect((await suspensionBlock(adminClient as never, { id: USER_ID }))?.status).toBe(403);
  });
  it("a request that changes something is sensitive; a read is not", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(isSensitiveMethod(m)).toBe(true);
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) expect(isSensitiveMethod(m)).toBe(false);
  });
});
