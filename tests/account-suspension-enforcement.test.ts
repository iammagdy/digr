import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * DT-20261118-06 phase 1C (Tier A): the suspension holds ON THE SERVER. A token issued before the ban is still readable locally until it expires (localClaims.ts), so every customer route that
 * starts work, approves, edits a plan, tops up or opens a request asks the sign-in service about the ban, and answers 403 with the customer sentence.
 */
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const state = { bannedUntil: null as string | null };
vi.mock("../src/lib/supabase/server", () => ({
  // the customer's own client: the token is read locally, so the user carries no ban field (as with local claims)
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER_ID, email: "c@example.com", app_metadata: {}, user_metadata: {}, created_at: "2026-11-01T00:00:00Z" } }, error: null }) } })),
  createAdminClient: () => ({ auth: { admin: { getUserById: async () => ({ data: { user: { id: USER_ID, banned_until: state.bannedUntil } }, error: null }) } } }),
}));
vi.mock("../src/lib/server/trustedEmailVerification", () => ({ resolveTrustedEmailVerified: async () => true }));

import { authenticateUser } from "../src/lib/server/userAuth";
import { resolveMissionViewer } from "../src/lib/server/missionViewer";
import { SUSPENDED_AR, forgetSuspension } from "../src/lib/server/accountSuspension";

const req = () => new NextRequest("http://localhost/api/x", { headers: { authorization: "Bearer token" } });
beforeEach(() => { state.bannedUntil = null; forgetSuspension(); });

describe("the shared customer sign-in helpers refuse a suspended account", () => {
  it("authenticateUser: 403 with the customer sentence while banned; the customer as before when not", async () => {
    expect(await authenticateUser(req())).toMatchObject({ ok: true, user: { id: USER_ID } });
    forgetSuspension();
    state.bannedUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const r = await authenticateUser(req());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.response.status).toBe(403); expect(await r.response.json()).toMatchObject({ success: false, suspended: true, error: SUSPENDED_AR }); }
  });
  it("resolveMissionViewer: a suspended customer cannot open, approve or download a request (and is not let in as a guest instead)", async () => {
    state.bannedUntil = new Date(Date.now() + 86_400_000).toISOString();
    const r = await resolveMissionViewer(req());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.response.status).toBe(403); expect((await r.response.json()).error).toBe(SUSPENDED_AR); }
  });
});

describe("the routes that sign the customer in themselves check the ban right after the sign-in", () => {
  it.each([
    "src/app/api/chat/route.ts",
    "src/app/api/chat/accept-quote/route.ts",
    "src/app/api/chat/sample-remainder/route.ts",
    "src/app/api/chat/edit-plan/route.ts",
    "src/app/api/topup/submit/route.ts",
  ])("%s", (file) => {
    const src = readFileSync(file, "utf8");
    const signIn = src.lastIndexOf("auth.getUser(");
    const check = src.indexOf("await isAccountSuspended(() => createAdminClient(), user.id");
    expect(signIn).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(signIn);
    expect(src.indexOf("suspendedResponse(", check)).toBeGreaterThan(check);
  });
});
