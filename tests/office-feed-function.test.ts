import { describe, expect, it, vi } from "vitest";
import {
  constantTimeEqual,
  handleOfficeFeedRequest,
  MAX_BODY_BYTES,
  OFFICE_BUCKET,
  OFFICE_OBJECT_PATH,
} from "../supabase/functions/office-feed/handler";
import { uploadFeed } from "../scripts/office-feed-updater.mjs";

const TOKEN = "tok_test_random_9c3f4a1d8b2e7f01";
const SERVICE_KEY = "svc_test_secret_key_never_leaks";
const SUPABASE_URL = "https://mock.supabase.co";

function makeEnv(overrides: Partial<{ feedToken: string; supabaseUrl: string; serviceKey: string }> = {}) {
  return {
    feedToken: TOKEN,
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
    ...overrides,
  };
}

describe("DT-20261120-office feed-function: Case 1 & 6 (valid POST + updater compatibility)", () => {
  it("accepts valid POST with Authorization Bearer + non-JWT apikey header, upserts office-status/status.json with cacheControl 15, and works with scripts/office-feed-updater.mjs unchanged", async () => {
    const storageCalls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const logs: unknown[] = [];

    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const hdrs: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        hdrs[k.toLowerCase()] = v;
      });
      storageCalls.push({
        url,
        method: String(init?.method || "GET"),
        headers: hdrs,
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ Key: `${OFFICE_BUCKET}/${OFFICE_OBJECT_PATH}` }), { status: 200 });
    };

    const feedPayload = {
      version: 1,
      generated_at: "2026-11-20T15:00:00Z",
      open_prs: [{ number: 602, title: "Office page" }],
      bots: { elkebir: { bot: "elkebir", state: "working", task_id: "DT-20261120-office" } },
    };

    let capturedStatus = 0;
    let capturedJson: unknown = null;
    await uploadFeed({
      feedJson: feedPayload,
      uploadUrl: "https://mock.supabase.co/functions/v1/office-feed?bucket=evil&path=other.json",
      uploadKey: TOKEN,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await handleOfficeFeedRequest(
          new Request(input, init),
          makeEnv(),
          { fetcher, log: (...args: unknown[]) => logs.push(args) },
        );
        capturedStatus = res.status;
        capturedJson = await res.clone().json();
        return res;
      }) as typeof fetch,
    });

    expect(capturedStatus).toBe(200);
    expect(capturedJson).toEqual({ ok: true });
    expect(storageCalls).toHaveLength(1);
    expect(storageCalls[0].url).toBe("https://mock.supabase.co/storage/v1/object/office-status/status.json");
    expect(storageCalls[0].method).toBe("POST");
    expect(storageCalls[0].headers["authorization"]).toBe(`Bearer ${SERVICE_KEY}`);
    expect(storageCalls[0].headers["apikey"]).toBe(SERVICE_KEY);
    expect(storageCalls[0].headers["content-type"]).toBe("application/json");
    expect(storageCalls[0].headers["cache-control"]).toBe("max-age=15");
    expect(storageCalls[0].headers["x-upsert"]).toBe("true");
    expect(JSON.parse(storageCalls[0].body)).toEqual(feedPayload);

    const logBlob = JSON.stringify(logs);
    expect(logBlob).not.toContain(TOKEN);
    expect(logBlob).not.toContain(SERVICE_KEY);
    expect(logBlob).not.toContain("DT-20261120-office");
  });

  it("accepts exact 65,536-byte JSON body and fixed bucket/path even when body tries to override bucket/path", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    const prefix = '{"version":1,"bucket":"receipts","path":"hack.json","pad":"';
    const suffix = '"}';
    const exactBody = prefix + "a".repeat(MAX_BODY_BYTES - prefix.length - suffix.length) + suffix;
    expect(Buffer.byteLength(exactBody, "utf8")).toBe(MAX_BODY_BYTES);

    const res = await handleOfficeFeedRequest(
      new Request("https://mock.supabase.co/functions/v1/office-feed?bucket=partials&path=x", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: exactBody,
      }),
      makeEnv(),
      { fetcher, log: () => {} },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(["https://mock.supabase.co/storage/v1/object/office-status/status.json"]);
  });
});

describe("DT-20261120-office feed-function: Case 2, 3, 4, 5 (auth, size/JSON/method guards, no leak)", () => {
  it.each([
    { name: "missing Authorization header", auth: undefined, feedToken: TOKEN, expectedStatus: 401 },
    { name: "wrong bearer token", auth: "Bearer wrong_token_value", feedToken: TOKEN, expectedStatus: 401 },
    { name: "non-Bearer scheme", auth: `Basic ${TOKEN}`, feedToken: TOKEN, expectedStatus: 401 },
    { name: "empty bearer token", auth: "Bearer ", feedToken: TOKEN, expectedStatus: 401 },
    { name: "unset OFFICE_FEED_TOKEN", auth: `Bearer ${TOKEN}`, feedToken: "", expectedStatus: 500 },
  ])("auth check: $name -> $expectedStatus and writes nothing", async ({ auth, feedToken, expectedStatus }) => {
    const fetcher = vi.fn();
    const logs: unknown[] = [];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth !== undefined) headers.Authorization = auth;

    const res = await handleOfficeFeedRequest(
      new Request("https://mock.supabase.co/functions/v1/office-feed", {
        method: "POST",
        headers,
        body: JSON.stringify({ version: 1, secretMarker: "BODY_SHOULD_NOT_LEAK" }),
      }),
      makeEnv({ feedToken }),
      { fetcher: fetcher as unknown as typeof fetch, log: (...args: unknown[]) => logs.push(args) },
    );

    expect(res.status).toBe(expectedStatus);
    expect(fetcher).not.toHaveBeenCalled();
    const bodyText = await res.text();
    const leakBlob = bodyText + JSON.stringify(logs);
    expect(leakBlob).not.toContain(TOKEN);
    expect(leakBlob).not.toContain(SERVICE_KEY);
    expect(leakBlob).not.toContain("BODY_SHOULD_NOT_LEAK");
  });

  it.each([
    { name: "GET method", method: "GET", body: undefined, expectedStatus: 405 },
    { name: "PUT method", method: "PUT", body: '{"version":1}', expectedStatus: 405 },
    { name: "DELETE method", method: "DELETE", body: undefined, expectedStatus: 405 },
    { name: "OPTIONS method", method: "OPTIONS", body: undefined, expectedStatus: 405 },
    { name: "body > 65,536 bytes", method: "POST", body: JSON.stringify({ version: 1, pad: "x".repeat(MAX_BODY_BYTES) }), expectedStatus: 413 },
    { name: "invalid JSON", method: "POST", body: "{not-json", expectedStatus: 400 },
    { name: "JSON array", method: "POST", body: '[{"version":1}]', expectedStatus: 400 },
    { name: "version !== 1", method: "POST", body: JSON.stringify({ version: 2 }), expectedStatus: 400 },
    { name: "missing version", method: "POST", body: JSON.stringify({ bots: {} }), expectedStatus: 400 },
  ])("validation check: $name -> $expectedStatus and writes nothing", async ({ method, body, expectedStatus }) => {
    const fetcher = vi.fn();
    const res = await handleOfficeFeedRequest(
      new Request("https://mock.supabase.co/functions/v1/office-feed", {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        ...(body !== undefined ? { body } : {}),
      }),
      makeEnv(),
      { fetcher: fetcher as unknown as typeof fetch, log: () => {} },
    );
    expect(res.status).toBe(expectedStatus);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("constantTimeEqual compares equal and unequal strings accurately", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
    expect(constantTimeEqual("abc123", "abc1234")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(false);
  });

  it("never leaks storage error bodies or keys when storage returns non-2xx", async () => {
    const logs: unknown[] = [];
    const fetcher: typeof fetch = async () =>
      new Response(`upstream failed with ${SERVICE_KEY}`, { status: 500 });

    const res = await handleOfficeFeedRequest(
      new Request("https://mock.supabase.co/functions/v1/office-feed", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, marker: "SENSITIVE_BODY" }),
      }),
      makeEnv(),
      { fetcher, log: (...args: unknown[]) => logs.push(args) },
    );

    expect(res.status).toBe(502);
    const out = (await res.text()) + JSON.stringify(logs);
    expect(out).not.toContain(SERVICE_KEY);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("SENSITIVE_BODY");
  });

});
