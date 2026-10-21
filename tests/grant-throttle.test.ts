import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rpcCalls: 0, rpcResult: { data: { success: true, points: 50, balance: 50 }, error: null as any } as any, user: { id: "11111111-1111-1111-1111-111111111111", email: "a@x.test", app_metadata: {}, user_metadata: {} } }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async () => { state.rpcCalls += 1; return state.rpcResult; }),
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [{ delta: 50 }], error: null }) }) }),
  })),
}));

import { DEVICE_COOKIE, GRANT_THROTTLED_AR, GRANTS_PER_DEVICE_PER_DAY_DEFAULT, GRANTS_PER_IP_PER_HOUR_DEFAULT, grantAllowed, grantLimits, recordGrant, resetGrantThrottleForTesting } from "../src/lib/server/grantThrottle";
import { resetPromoAttemptsForTesting } from "../src/lib/server/promoCodes";
import { POST as redeem } from "../src/app/api/wallet/redeem/route";

beforeEach(() => { resetGrantThrottleForTesting(); resetPromoAttemptsForTesting(); state.rpcCalls = 0; state.rpcResult = { data: { success: true, points: 50, balance: 50 }, error: null }; });

describe("the free-points grant is limited per address and per device, and a conference room behind one address is never refused", () => {
  it("defaults: 900 an hour per address (above a 500-person room), 5 a day per device; bad values fall back", () => {
    expect(GRANTS_PER_IP_PER_HOUR_DEFAULT).toBeGreaterThan(500);
    expect(grantLimits({})).toEqual({ perIpPerHour: 900, perDevicePerDay: 5 });
    expect(grantLimits({ PROMO_GRANTS_PER_IP_PER_HOUR: "1500", PROMO_GRANTS_PER_DEVICE_PER_DAY: "3" })).toEqual({ perIpPerHour: 1500, perDevicePerDay: 3 });
    expect(grantLimits({ PROMO_GRANTS_PER_IP_PER_HOUR: "0", PROMO_GRANTS_PER_DEVICE_PER_DAY: "abc" })).toEqual({ perIpPerHour: 900, perDevicePerDay: 5 });
  });

  it("500 different phones on one address are all allowed; the 901st grant in the hour is not; the hour passes and it is allowed again", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 500; i += 1) {
      expect(grantAllowed({ ip: "venue", deviceId: `dev${i}` }, t0 + i).allowed).toBe(true);
      recordGrant({ ip: "venue", deviceId: `dev${i}` }, t0 + i);
    }
    for (let i = 500; i < GRANTS_PER_IP_PER_HOUR_DEFAULT; i += 1) recordGrant({ ip: "venue", deviceId: `dev${i}` }, t0 + i);
    expect(grantAllowed({ ip: "venue", deviceId: "new" }, t0 + 1000)).toEqual({ allowed: false, why: "ip" });
    expect(grantAllowed({ ip: "venue", deviceId: "new" }, t0 + 60 * 60 * 1000 + 2000).allowed).toBe(true);
    expect(grantAllowed({ ip: "elsewhere", deviceId: "new" }, t0 + 1000).allowed).toBe(true);
  });

  it("one device: the sixth grant in a day is refused, another device and the next day are not", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < GRANTS_PER_DEVICE_PER_DAY_DEFAULT; i += 1) { expect(grantAllowed({ ip: "a", deviceId: "phone" }, t0 + i).allowed).toBe(true); recordGrant({ ip: "a", deviceId: "phone" }, t0 + i); }
    expect(grantAllowed({ ip: "b", deviceId: "phone" }, t0 + 10)).toEqual({ allowed: false, why: "device" });
    expect(grantAllowed({ ip: "b", deviceId: "other" }, t0 + 10).allowed).toBe(true);
    expect(grantAllowed({ ip: "b", deviceId: "phone" }, t0 + 24 * 60 * 60 * 1000 + 20).allowed).toBe(true);
  });

  it("the sentence for a refusal is plain Arabic with no digits", () => {
    expect(GRANT_THROTTLED_AR).not.toMatch(/[A-Za-z0-9]/);
    expect(GRANT_THROTTLED_AR).toContain("المنظمين");
  });
});

describe("the redeem route", () => {
  const call = (cookie?: string, ip = "9.9.9.9") => redeem(new NextRequest("http://x/api/wallet/redeem", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie: `${DEVICE_COOKIE}=${cookie}` } : {}) }, body: JSON.stringify({ code: "CONF26" }) }));

  it("a first grant sets a device cookie (httpOnly) and counts; the points path is unchanged (the database function is called once)", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(state.rpcCalls).toBe(1);
    const cookie = res.headers.get("set-cookie") || "";
    expect(cookie).toContain(`${DEVICE_COOKIE}=`);
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("the sixth grant from one device is refused with 429 BEFORE the database function is called, with the plain sentence", async () => {
    const device = "d".repeat(24);
    for (let i = 0; i < 5; i += 1) expect((await call(device, `10.0.0.${i}`)).status).toBe(200);
    expect(state.rpcCalls).toBe(5);
    const refused = await call(device, "10.0.1.1");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ success: false, reason: "too_many_signups_here", messageAr: GRANT_THROTTLED_AR });
    expect(state.rpcCalls).toBe(5);
  });

  it("a refused code does not count as a grant, and a forged or short device cookie is ignored", async () => {
    state.rpcResult = { data: { success: false, error: "already_redeemed" }, error: null };
    const device = "e".repeat(24);
    for (let i = 0; i < 7; i += 1) await call(device, `10.0.2.${i}`);
    state.rpcResult = { data: { success: true, points: 50, balance: 50 }, error: null };
    state.user = { ...state.user, id: "22222222-2222-2222-2222-222222222222" };
    expect((await call(device, "10.0.3.1")).status).toBe(200);
    resetGrantThrottleForTesting();
    expect((await call("short", "10.0.3.2")).headers.get("set-cookie") || "").toContain(`${DEVICE_COOKIE}=`);
  });

  it("no money value is read or written by the throttle", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/server/grantThrottle.ts", "utf8");
    expect(source).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|credit_ledger|points\s*[:=]/);
  });
});
