import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isAuthorizedCaller } from "../supabase/functions/send-email/authorize";
import { probeSendEmailFunction } from "../src/lib/server/emailCheck";
import { sendPlatformEmail } from "../src/lib/server/sendPlatformEmail";

const URL_BASE = "https://proj.supabase.co";
const INJECTED = "injected-key-value";
const OTHER = "another-valid-service-key";
const answer = (status: number) => vi.fn(async () => new Response(JSON.stringify({ users: [{ id: "u1", email: "private@example.com" }] }), { status }));

describe("send-email: who may call the function", () => {
  it("the exact match is accepted WITHOUT any verification call", async () => {
    const fetcher = answer(500);
    expect(await isAuthorizedCaller(`Bearer ${INJECTED}`, INJECTED, URL_BASE, fetcher as any)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a different string is accepted only when the admin API answers 200, and the call carries the bearer as apikey and Authorization", async () => {
    const fetcher = answer(200);
    expect(await isAuthorizedCaller(`Bearer ${OTHER}`, INJECTED, `${URL_BASE}/`, fetcher as any)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL_BASE}/auth/v1/admin/users?per_page=1`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ apikey: OTHER, Authorization: `Bearer ${OTHER}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a mismatch with 401, 403, 404 or 500 is rejected", async () => {
    for (const status of [401, 403, 404, 500, 204]) {
      expect(await isAuthorizedCaller(`Bearer ${OTHER}`, INJECTED, URL_BASE, answer(status) as any), String(status)).toBe(false);
    }
  });

  it("a mismatch whose verification times out or fails on the network is rejected", async () => {
    const timeout = vi.fn(async () => { throw new DOMException("The operation timed out", "TimeoutError"); });
    const network = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await isAuthorizedCaller(`Bearer ${OTHER}`, INJECTED, URL_BASE, timeout as any)).toBe(false);
    expect(await isAuthorizedCaller(`Bearer ${OTHER}`, INJECTED, URL_BASE, network as any)).toBe(false);
  });

  it("the verification really stops at the time limit", async () => {
    const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    const started = Date.now();
    expect(await isAuthorizedCaller(`Bearer ${OTHER}`, INJECTED, URL_BASE, hang as any, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("an empty or missing value is rejected and never verified", async () => {
    const fetcher = answer(200);
    expect(await isAuthorizedCaller(`Bearer ${INJECTED}`, "", URL_BASE, fetcher as any)).toBe(false); // the function has no key of its own
    expect(await isAuthorizedCaller("", INJECTED, URL_BASE, fetcher as any)).toBe(false);
    expect(await isAuthorizedCaller("Bearer ", INJECTED, URL_BASE, fetcher as any)).toBe(false);
    expect(await isAuthorizedCaller("Bearer", INJECTED, URL_BASE, fetcher as any)).toBe(false);
    expect(await isAuthorizedCaller(OTHER, INJECTED, URL_BASE, fetcher as any)).toBe(false); // not a Bearer header
    expect(await isAuthorizedCaller(`Bearer ${OTHER}`, INJECTED, "", fetcher as any)).toBe(false); // no project URL to verify against
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("the body of the verification answer is not used, and the key is never logged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await isAuthorizedCaller(`Bearer ${OTHER}`, INJECTED, URL_BASE, answer(401) as any);
    await isAuthorizedCaller(`Bearer ${OTHER}`, INJECTED, URL_BASE, vi.fn(async () => { throw new Error("x"); }) as any);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore(); error.mockRestore(); warn.mockRestore();
    const source = readFileSync("supabase/functions/send-email/authorize.ts", "utf8");
    expect(source).not.toMatch(/console\./);
  });
});

describe("send-email: the entry point uses it and nothing else changed", () => {
  const index = readFileSync("supabase/functions/send-email/index.ts", "utf8");

  it("the handler authorizes through isAuthorizedCaller with the injected key and SUPABASE_URL, and still answers 401", () => {
    expect(index).toContain('import { isAuthorizedCaller } from "./authorize.ts";');
    expect(index).toContain('isAuthorizedCaller(auth, serviceRoleKey, Deno.env.get("SUPABASE_URL") ?? "")');
    expect(index).toContain('return json({ ok: false, error: "unauthorized" }, 401);');
    expect(index).not.toContain("auth !== `Bearer ${serviceRoleKey}`");
  });

  it("the Resend call, the sender and the templates are untouched", () => {
    expect(index).toContain('const FROM = "Diger <noreply@diger.tech>";');
    expect(index).toContain("buildResendHeaders(resendKey, input.idempotencyKey)");
    expect(index).toContain('return json({ ok: false, error: "resend_rejected", status: res.status }, 502);');
  });
});

describe("the app side trims the key it sends", () => {
  it("the e-mail sender sends the key without surrounding whitespace", async () => {
    const seen: string[] = [];
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", URL_BASE);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", `  ${INJECTED}\n`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { seen.push((init.headers as Record<string, string>).Authorization); return new Response("{}", { status: 200 }); }));
    expect((await sendPlatformEmail("welcome", "a@b.test", { Name: "x" })).ok).toBe(true);
    expect(seen).toEqual([`Bearer ${INJECTED}`]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("the card's probe sends the key without surrounding whitespace", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => { seen.push((init.headers as Record<string, string>).Authorization); return new Response(JSON.stringify({ error: "invalid_to" }), { status: 400 }); });
    const state = await probeSendEmailFunction({ NEXT_PUBLIC_SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: ` ${INJECTED} ` }, fetcher as any);
    expect(state).toBe("ready");
    expect(seen).toEqual([`Bearer ${INJECTED}`]);
  });
});
