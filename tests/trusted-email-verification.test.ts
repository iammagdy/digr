import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * SECURITY: only the sign-in service's own e-mail confirmation (`email_confirmed_at`) may authorize approval, payment or a top-up.
 * `user_metadata` is writable by the customer, so a forged `user_metadata.email_verified: true` must never count.
 * Everything here uses fake clients: no network, no points.
 */
const state = vi.hoisted(() => ({
  serviceUser: null as any,          // what the (fake) sign-in service answers for a bearer token
  cookieUser: null as any,           // what the (fake) service answers for the session cookie
  getUserCalls: [] as Array<string | undefined>,
  claimsMode: false,
  adminUsers: {} as Record<string, any>,
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: async () => {
    const auth: any = {
      getUser: async (token?: string) => {
        state.getUserCalls.push(token);
        const user = token ? (token === "good-token" || token === "forged-token" || token === "unverified-token" || token === "guest-flipped-token" ? state.serviceUser?.[token] : null) : state.cookieUser;
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "bad token" } };
      },
    };
    if (state.claimsMode) {
      // what withLocalClaims builds: the locally rebuilt user (metadata only, no trusted confirmation) + the unwrapped service call
      auth.getUserFromService = auth.getUser;
      const real = auth.getUser;
      auth.getUser = async (token?: string) => {
        const r = await real(token);
        return r.data?.user ? { data: { user: { id: r.data.user.id, user_metadata: r.data.user.user_metadata, email_confirmed_at: undefined, __localClaims: true } }, error: null } : r;
      };
    }
    return { auth };
  },
  createAdminClient: () => ({ auth: { admin: { getUserById: async (id: string) => ({ data: { user: state.adminUsers[id] ?? null } }) } } }),
}));

import { resolveMissionViewer } from "../src/lib/server/missionViewer";
import { isEmailConfirmedByAuth, resolveTrustedEmailVerified } from "../src/lib/server/trustedEmailVerification";
import { userFromClaims } from "../src/lib/server/localClaims";
import { approveForCustomer } from "../src/lib/agentMission/customerActions";

const GUEST_ID = "11111111-2222-3333-4444-555555555555";
const req = (opts: { bearer?: string; guestCookie?: string } = {}) =>
  new NextRequest("https://diger.test/api/missions/msn_abcdefgh12/approve", {
    method: "POST",
    headers: { ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}) },
    ...(opts.guestCookie ? {} : {}),
  } as any) as NextRequest;
const withGuestCookie = (value: string) => {
  const r = req();
  r.cookies.set("guest_session_id", value);
  return r;
};

beforeEach(() => {
  state.claimsMode = false;
  state.getUserCalls = [];
  state.cookieUser = null;
  state.adminUsers = {};
  state.serviceUser = {
    "good-token": { id: "u-verified", email: "a@b.c", email_confirmed_at: "2026-11-01T00:00:00Z", user_metadata: {} },
    "unverified-token": { id: "u-unverified", email: "n@b.c", email_confirmed_at: null, user_metadata: {} },
    "forged-token": { id: "u-forged", email: "f@b.c", email_confirmed_at: null, user_metadata: { email_verified: true } },
    // a guest account that rewrote its own metadata to look like a normal customer
    "guest-flipped-token": { id: "u-guest-flipped", email: "guest_x@diger.tech", email_confirmed_at: null, user_metadata: { is_guest: false, email_verified: true } },
  };
});

describe("resolveMissionViewer: only the sign-in service's confirmation counts", () => {
  it("verified user (bearer): verified", async () => {
    const r: any = await resolveMissionViewer(req({ bearer: "good-token" }));
    expect(r.ok).toBe(true);
    expect(r.viewer).toEqual({ userId: "u-verified", isGuest: false, emailVerified: true });
  });

  it("verified user (session cookie): verified", async () => {
    state.cookieUser = { id: "u-cookie", email_confirmed_at: "2026-11-01T00:00:00Z", user_metadata: {} };
    const r: any = await resolveMissionViewer(req());
    expect(r.ok).toBe(true);
    expect(r.viewer).toMatchObject({ userId: "u-cookie", isGuest: false, emailVerified: true });
  });

  it("unverified user (bearer and cookie): not verified", async () => {
    const a: any = await resolveMissionViewer(req({ bearer: "unverified-token" }));
    expect(a.viewer).toMatchObject({ userId: "u-unverified", emailVerified: false });
    state.cookieUser = { id: "u-c2", email_confirmed_at: null, user_metadata: {} };
    const b: any = await resolveMissionViewer(req());
    expect(b.viewer).toMatchObject({ userId: "u-c2", emailVerified: false });
  });

  it("FORGED user_metadata.email_verified (bearer): NOT verified", async () => {
    const r: any = await resolveMissionViewer(req({ bearer: "forged-token" }));
    expect(r.ok).toBe(true);
    expect(r.viewer.emailVerified).toBe(false);
  });

  it("FORGED user_metadata.email_verified (session cookie): NOT verified", async () => {
    state.cookieUser = { id: "u-forged-c", email_confirmed_at: null, user_metadata: { email_verified: true } };
    const r: any = await resolveMissionViewer(req());
    expect(r.viewer.emailVerified).toBe(false);
  });

  it("a guest that flipped its own is_guest flag and forged email_verified is still NOT verified", async () => {
    const r: any = await resolveMissionViewer(req({ bearer: "guest-flipped-token" }));
    expect(r.viewer.emailVerified).toBe(false);
  });

  it("guest cookie of a real guest account: guest, never verified", async () => {
    state.adminUsers[GUEST_ID] = { id: GUEST_ID, user_metadata: { is_guest: true, email_verified: true } };
    const r: any = await resolveMissionViewer(withGuestCookie(`gst_${GUEST_ID}`));
    expect(r).toMatchObject({ ok: true, viewer: { userId: GUEST_ID, isGuest: true, emailVerified: false } });
  });

  it("guest cookie of an account that is not a guest, a malformed cookie, and no credentials: 401", async () => {
    state.adminUsers[GUEST_ID] = { id: GUEST_ID, user_metadata: {} };
    for (const request of [withGuestCookie(`gst_${GUEST_ID}`), withGuestCookie("gst_not-a-uuid"), req(), req({ bearer: "bad-token" })]) {
      const r: any = await resolveMissionViewer(request);
      expect(r.ok).toBe(false);
      expect(r.response.status).toBe(401);
    }
  });

  it("AUTH_LOCAL_CLAIMS path: a locally rebuilt user is verified ONLY if the service confirms it", async () => {
    state.claimsMode = true;
    const good: any = await resolveMissionViewer(req({ bearer: "good-token" }));
    expect(good.viewer.emailVerified).toBe(true); // legitimate customers keep working
    const forged: any = await resolveMissionViewer(req({ bearer: "forged-token" }));
    expect(forged.viewer.emailVerified).toBe(false);
  });
});

describe("the helper never reads user_metadata", () => {
  it("isEmailConfirmedByAuth", () => {
    expect(isEmailConfirmedByAuth({ email_confirmed_at: "2026-11-01T00:00:00Z" })).toBe(true);
    expect(isEmailConfirmedByAuth({ confirmed_at: "2026-11-01T00:00:00Z" })).toBe(true);
    expect(isEmailConfirmedByAuth({ email_confirmed_at: null })).toBe(false);
    expect(isEmailConfirmedByAuth({ email_confirmed_at: undefined, user_metadata: { email_verified: true } } as any)).toBe(false);
    expect(isEmailConfirmedByAuth(null)).toBe(false);
    // a locally rebuilt user never counts without the service's word
    expect(isEmailConfirmedByAuth({ email_confirmed_at: "2026-11-01T00:00:00Z", __localClaims: true })).toBe(false);
  });

  it("a locally rebuilt user with no service answer, an error, or a throw is NOT verified", async () => {
    const local = userFromClaims({ sub: "u1", user_metadata: { email_verified: true } }) as any;
    expect(local.email_confirmed_at).toBeUndefined();
    expect(await resolveTrustedEmailVerified({ auth: {} }, local)).toBe(false);
    expect(await resolveTrustedEmailVerified({ auth: { getUserFromService: async () => ({ data: null, error: { message: "x" } }) } }, local)).toBe(false);
    expect(await resolveTrustedEmailVerified({ auth: { getUserFromService: async () => { throw new Error("down"); } } }, local)).toBe(false);
    expect(await resolveTrustedEmailVerified({ auth: { getUserFromService: async () => ({ data: { user: { email_confirmed_at: "2026-11-01T00:00:00Z" } }, error: null }) } }, local)).toBe(true);
  });
});

describe("approval and ownership: a forged flag cannot approve; unauthorized attempts are refused", () => {
  it("approveForCustomer refuses an unverified or guest viewer before touching anything, whatever the metadata says", async () => {
    const touched: string[] = [];
    const client: any = new Proxy({}, { get: (_t, prop) => { touched.push(String(prop)); return () => { throw new Error("must not be reached"); }; } });
    const forged: any = await resolveMissionViewer(req({ bearer: "forged-token" }));
    const res = await approveForCustomer(client, { id: "msn_abcdefgh12", userId: forged.viewer.userId, isGuest: forged.viewer.isGuest, emailVerified: forged.viewer.emailVerified });
    expect(res).toMatchObject({ ok: false, status: 403 });
    const guest = await approveForCustomer(client, { id: "msn_abcdefgh12", userId: GUEST_ID, isGuest: true, emailVerified: false });
    expect(guest).toMatchObject({ ok: false, status: 401 });
    expect(touched).toEqual([]);
  });
});
