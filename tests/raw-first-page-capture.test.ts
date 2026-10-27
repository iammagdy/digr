import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RAW_CAPTURE_ENABLED, RAW_CAPTURE_FLAG, RAW_CAPTURE_MAX_BYTES, buildRawFirstPage, createFirstPageCapture, maskText, rawCaptureEnabled } from "../src/lib/server/rawCapture";
import { executeTregCall } from "../src/functions/shared/tregClient";

describe("the switch: ON by default, one code constant turns it off", () => {
  it("is ON in code, and with no environment variable at all", () => {
    expect(RAW_CAPTURE_ENABLED).toBe(true);
    expect(rawCaptureEnabled({})).toBe(true);
    expect(rawCaptureEnabled({ [RAW_CAPTURE_FLAG]: "" })).toBe(true);
    expect(rawCaptureEnabled({ [RAW_CAPTURE_FLAG]: "on" })).toBe(true);
    expect(rawCaptureEnabled({ [RAW_CAPTURE_FLAG]: "true" })).toBe(true);
  });

  it("the code constant turns it off, whatever the environment says", () => {
    expect(rawCaptureEnabled({}, false)).toBe(false);
    expect(rawCaptureEnabled({ [RAW_CAPTURE_FLAG]: "on" }, false)).toBe(false);
  });

  it("the value «off» of the environment variable also turns it off (never needed)", () => {
    expect(rawCaptureEnabled({ [RAW_CAPTURE_FLAG]: "off" })).toBe(false);
    expect(rawCaptureEnabled({ [RAW_CAPTURE_FLAG]: " OFF " })).toBe(false);
  });
});

describe("masking: emails and phone numbers never reach the stored record", () => {
  it("masks an email down to its first letter and its domain", () => {
    expect(maskText("write to jane.doe@stripe.com today")).toBe("write to j***@stripe.com today");
  });

  it.each(["+20 100 123 4567", "+201001234567 call", "(02) 2508-7419", "0100-123-4567", "+966 55 123 4567"])("masks the phone in «%s»", (text) => {
    const masked = maskText(text);
    expect(masked).toMatch(/\*\*\*\d{2}/);
    expect(masked.replace(/\D/g, "").length).toBeLessThan(text.replace(/\D/g, "").length);
  });

  it("keeps a long id with no separators (a tweet id is not a phone) and short numbers", () => {
    expect(maskText("2101118004087886212")).toBe("2101118004087886212");
    expect(maskText("1792308962")).toBe("1792308962");
    expect(maskText("3 comments, 12 likes")).toBe("3 comments, 12 likes");
  });

  it("a record never carries an email or a phone, whatever the nesting", () => {
    const record = buildRawFirstPage({
      jobId: "job_1", endpointId: "treg.people.search", httpStatus: 200, page: 1,
      body: { output: { data: { items: [{ email: "a.b@corp.com", contact: { phone: "+20 100 123 4567", note: "reach me at x@y.org" } }] } } },
    });
    const text = JSON.stringify(record);
    expect(text).not.toMatch(/a\.b@corp\.com|x@y\.org|100 123 4567/);
    expect(text).toContain("a***@corp.com");
  });
});

describe("size cap and shape", () => {
  it("cuts a long string and keeps the record under the byte cap by shortening lists", () => {
    const body = { output: { data: { tweets: Array.from({ length: 400 }, (_, i) => ({ id: String(i), text: "x".repeat(2000) })) } } };
    const record = buildRawFirstPage({ jobId: "j", endpointId: "anyapi.x.user.posts", httpStatus: 200, page: 1, body });
    const bytes = JSON.stringify(record).length;
    expect(bytes).toBeLessThanOrEqual(RAW_CAPTURE_MAX_BYTES);
    expect(record.truncated).toBe(true);
    const tweets = (record.body as any).output.data.tweets;
    expect(tweets.length).toBeLessThan(400);
    expect(tweets.length).toBeGreaterThanOrEqual(1);
    expect(tweets[0].text.length).toBeLessThanOrEqual(401);
    expect(tweets[0].id).toBe("0");
  });

  it("a small answer is kept whole, untruncated, with its envelope and cursor", () => {
    const body = { output: { data: { nextCursor: "abc", tweets: [{ id: "1", isReply: "False", createdUtc: "1792308962" }] } }, found: true };
    const record = buildRawFirstPage({ jobId: "j", endpointId: "anyapi.x.user.posts", httpStatus: 200, page: 1, body, now: new Date("2026-10-27T10:00:00Z") });
    expect(record.truncated).toBe(false);
    expect(record.body).toEqual(body);
    expect(record.capturedAt).toBe("2026-10-27T10:00:00.000Z");
  });

  it("holds no header, token or key (it is built from the body only)", () => {
    const record = buildRawFirstPage({ jobId: "j", endpointId: "e", httpStatus: 200, page: 1, body: { ok: true } });
    expect(Object.keys(record).sort()).toEqual(["body", "capturedAt", "endpointId", "httpStatus", "jobId", "page", "truncated"]);
  });
});

describe("only the FIRST call of the job is stored", () => {
  it("writes one object in the private bucket and ignores every later call", async () => {
    const uploads: Array<{ path: string; body: Buffer; options: any }> = [];
    const store = { upload: vi.fn(async (path: string, body: any, options?: any) => { uploads.push({ path, body, options }); return { data: { path }, error: null }; }) };
    const capture = createFirstPageCapture(store, "job_quote_abc");
    await capture({ endpointId: "anyapi.x.user.posts", httpStatus: 200, page: 1, body: { a: 1 } });
    await capture({ endpointId: "anyapi.x.user.posts", httpStatus: 200, page: 2, body: { a: 2 } });
    expect(store.upload).toHaveBeenCalledTimes(1);
    expect(uploads[0].path).toBe("job_quote_abc/raw_first_page.json");
    expect(JSON.parse(uploads[0].body.toString("utf-8")).body).toEqual({ a: 1 });
    expect(uploads[0].options).toMatchObject({ contentType: "application/json", upsert: true });
  });
});

describe("the gateway client hands over the raw answer, and a failing capture never changes the call", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ output: { data: { tweets: [{ id: "1" }] } } }), { status: 200, headers: { "x-treg-cost-micro": "500" } })));
    vi.stubEnv("TREG_TOKEN", "not-a-real-token");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("passes endpoint, status, page and the parsed body", async () => {
    const seen: any[] = [];
    const result = await executeTregCall({ endpointId: "anyapi.x.user.posts", method: "POST", params: { handle: "a" }, userId: "u", jobId: "j", page: 3, rawCapture: async (r) => { seen.push(r); } });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ endpointId: "anyapi.x.user.posts", httpStatus: 200, page: 3, body: { output: { data: { tweets: [{ id: "1" }] } } } }]);
  });

  it("a capture that throws changes nothing", async () => {
    const result = await executeTregCall({ endpointId: "anyapi.x.user.posts", method: "POST", params: { handle: "a" }, userId: "u", jobId: "j", rawCapture: async () => { throw new Error("storage down"); } });
    expect(result.ok).toBe(true);
    expect(result.costMicro).toBe(500);
  });

  it("without the hook nothing is captured", async () => {
    const result = await executeTregCall({ endpointId: "anyapi.x.user.posts", method: "POST", params: { handle: "a" }, userId: "u", jobId: "j" });
    expect(result.ok).toBe(true);
  });
});
