import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { buildUnsubscribeUrl, signUnsubscribeToken, unsubscribeKeyFromEnv, verifyUnsubscribeToken } from "../src/lib/server/unsubscribeToken";

/** FAKE sign-in service: an in-memory users table. No network, no real account. */
const db = vi.hoisted(() => ({ users: new Map<string, any>(), updates: [] as any[], failUpdate: false }));
vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        getUserById: async (id: string) => (db.users.has(id) ? { data: { user: structuredClone(db.users.get(id)) }, error: null } : { data: { user: null }, error: { status: 404, code: "user_not_found", message: "User not found" } }),
        updateUserById: async (id: string, patch: any) => {
          if (db.failUpdate) return { data: null, error: { message: "boom" } };
          db.updates.push({ id, patch });
          db.users.set(id, { ...db.users.get(id), ...patch });
          return { data: { user: db.users.get(id) }, error: null };
        },
      },
    },
  }),
}));

import { GET, POST } from "../src/app/api/email/unsubscribe/route";

const KEY = "test-only-service-role-key";
const USER = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const url = (t: string) => `https://diger.test/api/email/unsubscribe?t=${t}`;
const post = (t: string, body?: string, type = "application/x-www-form-urlencoded", ip = "203.0.113.7") =>
  new NextRequest(url(t), { method: "POST", headers: { "content-type": type, "x-forwarded-for": ip }, body: body ?? "List-Unsubscribe=One-Click" });
const get = (t: string) => new NextRequest(url(t), { method: "GET" });

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", KEY);
  db.users.clear(); db.updates = []; db.failUpdate = false;
  db.users.set(USER, { id: USER, email: "a@example.test", user_metadata: { full_name: "منى", prefs: { notif: { news: true, topup: true, done: false }, theme: "dark" }, other: 1 }, app_metadata: { role: "customer" } });
});

describe("unsubscribe token", () => {
  it("round-trips: the token carries the user id", () => {
    const t = signUnsubscribeToken(USER, KEY);
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyUnsubscribeToken(t, KEY)).toBe(USER);
  });
  it("is keyed by the server secret: another key, a tampered MAC, a tampered id and garbage are all refused", () => {
    const t = signUnsubscribeToken(USER, KEY);
    expect(verifyUnsubscribeToken(t, "another-key")).toBeNull();
    const [id, mac] = t.split(".");
    expect(verifyUnsubscribeToken(`${id}.${mac.slice(0, -2)}AA`, KEY)).toBeNull();
    expect(verifyUnsubscribeToken(`${id}.`, KEY)).toBeNull();
    expect(verifyUnsubscribeToken(`${Buffer.from(OTHER).toString("base64url")}.${mac}`, KEY)).toBeNull(); // wrong user, someone else's MAC
    for (const bad of ["", "x", "a.b.c", ".", "!!.!!", 42, null, undefined, "a".repeat(600)]) expect(verifyUnsubscribeToken(bad as any, KEY), String(bad)).toBeNull();
    expect(verifyUnsubscribeToken(t, "")).toBeNull();
  });
  it("a token for one user never verifies as another user", () => {
    const a = signUnsubscribeToken(USER, KEY), b = signUnsubscribeToken(OTHER, KEY);
    expect(verifyUnsubscribeToken(a, KEY)).toBe(USER);
    expect(verifyUnsubscribeToken(b, KEY)).toBe(OTHER);
    expect(a).not.toBe(b);
  });
  it("compares the MAC in constant time and the key is the existing server secret (no new variable)", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync("src/lib/server/unsubscribeToken.ts", "utf8");
    expect(text).toContain("timingSafeEqual");
    expect(text).not.toMatch(/\bprocess\.env\.(?!SUPABASE_SERVICE_ROLE_KEY)[A-Z_]+/);
    expect(unsubscribeKeyFromEnv({ SUPABASE_SERVICE_ROLE_KEY: " k " })).toBe("k");
    expect(unsubscribeKeyFromEnv({})).toBe("");
  });
  it("refuses to sign without a key or for a malformed id", () => {
    expect(() => signUnsubscribeToken(USER, "")).toThrow();
    expect(() => signUnsubscribeToken("a b", KEY)).toThrow();
  });
  it("buildUnsubscribeUrl: site + route + token, no double slash", () => {
    const u = buildUnsubscribeUrl("https://diger.tech/", USER, KEY);
    expect(u).toBe(`https://diger.tech/api/email/unsubscribe?t=${signUnsubscribeToken(USER, KEY)}`);
    expect(new URL(u).protocol).toBe("https:");
  });
});

describe("unsubscribe route", () => {
  const token = () => signUnsubscribeToken(USER, KEY);

  it("POST (one-click) sets news=false, keeps every other preference and metadata, and answers 200 JSON", async () => {
    const res = await POST(post(token()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.updates).toHaveLength(1);
    const meta = db.users.get(USER).user_metadata;
    expect(meta.prefs.notif).toEqual({ news: false, topup: true, done: false });
    expect(meta.prefs.theme).toBe("dark");
    expect(meta.full_name).toBe("منى");
    expect(meta.other).toBe(1);
    expect(db.updates[0].patch.app_metadata).toBeUndefined(); // only user_metadata is touched
  });

  it("is idempotent: a second POST is 200 and writes nothing more", async () => {
    await POST(post(token()));
    const res = await POST(post(token()));
    expect(res.status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.users.get(USER).user_metadata.prefs.notif.news).toBe(false);
  });

  it("works for a user who has no prefs at all (the preference object is created)", async () => {
    db.users.set(USER, { id: USER, email: "a@example.test", user_metadata: {} });
    expect((await POST(post(token()))).status).toBe(200);
    expect(db.users.get(USER).user_metadata.prefs.notif).toEqual({ news: false });
  });

  it("a bad, tampered, foreign-key or unknown-account token gets the SAME generic 400 and changes nothing", async () => {
    const unknownUser = signUnsubscribeToken("00000000-0000-4000-8000-000000000000", KEY);
    const tampered = token().slice(0, -3) + "AAA";
    const answers: string[] = [];
    for (const t of ["garbage", tampered, signUnsubscribeToken(USER, "other-key"), unknownUser, "a.b"]) {
      const res = await POST(post(t));
      expect(res.status, t).toBe(400);
      answers.push(JSON.stringify(await res.json()));
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).not.toMatch(/user|account|exist|found|@/i);
    expect(db.updates).toEqual([]);
    expect((await POST(new NextRequest("https://diger.test/api/email/unsubscribe", { method: "POST" }))).status).toBe(400);
  });

  it("a failed save is never reported as success", async () => {
    db.failUpdate = true;
    const res = await POST(post(token()));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("GET shows a confirmation page with a POST form and changes NOTHING (mail scanners prefetch links)", async () => {
    const res = await GET(get(token()));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('<form method="post"');
    expect(html).toContain("إلغاء الاشتراك");
    expect(db.updates).toEqual([]);
    expect(db.users.get(USER).user_metadata.prefs.notif.news).toBe(true);
  });

  it("GET with a bad token shows a generic page and changes nothing", async () => {
    for (const t of ["garbage", signUnsubscribeToken(USER, "other-key"), '"><script>alert(1)</script>']) {
      const res = await GET(get(encodeURIComponent(t)));
      const html = await res.text();
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<script>alert(1)");
    }
    expect(db.updates).toEqual([]);
  });

  it("the confirmation page's form POST (from=page) gets a page back, and unsubscribes", async () => {
    const res = await POST(post(token(), "from=page"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("تم إلغاء الاشتراك");
    expect(db.users.get(USER).user_metadata.prefs.notif.news).toBe(false);
  });

  it("rate-limits one address after 300 POSTs a minute", async () => {
    let last = 200;
    for (let i = 0; i < 305; i++) last = (await POST(post("garbage", undefined, undefined, "198.51.100.9"))).status;
    expect(last).toBe(429);
  });
});
