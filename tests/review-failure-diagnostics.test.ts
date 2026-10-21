import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advisoryMaxTokens, callClaudeRowAdvisor } from "../src/lib/server/rowReviewAdvisor";
import { resetProviderKeyCache } from "../src/lib/server/providerKeys";

/** What a failed review proves about itself: the failure code, the stop reason, the real tokens, never row content. */
const rows = [{ index: 0, row: { text: "اتفقت" } }, { index: 1, row: { text: "منشور" } }];
const input = { customerRequest: "مباراة مصر والمغرب", kind: "social-x-posts", rows };

describe("the automatic review records why it failed", () => {
  const originalFetch = globalThis.fetch;
  const saved = { key: process.env.ANTHROPIC_API_KEY, provider: process.env.LLM_PROVIDER, enabled: process.env.LLM_ENABLED, live: process.env.LLM_LIVE };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    delete process.env.LLM_PROVIDER; delete process.env.LLM_ENABLED; delete process.env.LLM_LIVE;
    resetProviderKeyCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["LLM_PROVIDER", saved.provider], ["LLM_ENABLED", saved.enabled], ["LLM_LIVE", saved.live]] as const) {
      if (value === undefined) delete (process.env as any)[name]; else (process.env as any)[name] = value;
    }
    resetProviderKeyCache();
  });

  it("an unreadable reply that was cut at the output limit: bad_reply, the stop reason, the real tokens", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: "text", text: '{"reviews":[{"index":0,"verdict":"match","reasonAr":"' }], stop_reason: "max_tokens", usage: { input_tokens: 2400, output_tokens: 1200 } }),
    }) as any);
    const result = await callClaudeRowAdvisor(input);
    expect(result.failure).toBe("bad_reply");
    expect(result.stopReason).toBe("max_tokens");
    expect(result.usage).toMatchObject({ inputTokens: 2400, outputTokens: 1200 });
    expect(result.detail).toMatch(/^reply_chars=\d+$/);
    expect(result.verdicts.size).toBe(0);
  });

  it("an error from the provider: the http code and the provider's error type, no row content", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 529, json: async () => ({ error: { type: "overloaded_error", message: "Overloaded" } }) }) as any);
    const result = await callClaudeRowAdvisor(input);
    expect(result.failure).toBe("http_529");
    expect(result.detail).toBe("overloaded_error: Overloaded");
    expect(JSON.stringify(result)).not.toContain("اتفقت");
  });

  it("an error whose body cannot be read still gives the code", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error("not json"); } }) as any);
    const result = await callClaudeRowAdvisor(input);
    expect(result.failure).toBe("http_500");
    expect(result.detail).toBeNull();
  });

  it("a good reply carries its stop reason too, and no failure", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: "text", text: '{"reviews":[{"index":0,"verdict":"uncertain","reasonAr":"رد قصير"},{"index":1,"verdict":"match","reasonAr":"يتناول المباراة"}]}' }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 90 } }),
    }) as any);
    const result = await callClaudeRowAdvisor(input);
    expect(result.failure).toBeNull();
    expect(result.stopReason).toBe("end_turn");
    expect(result.verdicts.get(0)?.verdict).toBe("uncertain");
    expect(result.usage?.outputTokens).toBe(90);
  });

  it("the reply has room for every row: a page of 20 rows is no longer cut at 1,200 tokens", async () => {
    expect(advisoryMaxTokens(1)).toBe(1200);
    expect(advisoryMaxTokens(20)).toBeGreaterThanOrEqual(3000);
    expect(advisoryMaxTokens(25)).toBeGreaterThanOrEqual(4000);
    expect(advisoryMaxTokens(1000)).toBe(6000);
    let sent: any = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '{"reviews":[]}' }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }) } as any;
    });
    await callClaudeRowAdvisor({ ...input, kind: "companies", rows: Array.from({ length: 25 }, (_, index) => ({ index, row: { text: `منشور ${index}` } })) });
    expect(sent.max_tokens).toBe(advisoryMaxTokens(25));
    expect(String(sent.messages[0].content)).toContain("at most twelve words");
  });

  it("posts, comments and videos are reviewed on the verdict alone: a small reply room, no reason asked for, and the standard Arabic reason in the verdicts", async () => {
    let sent: any = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '{"reviews":[{"index":0,"verdict":"no_match","reasonAr":"سبب من النموذج"},{"index":1,"verdict":"match"}]}' }], stop_reason: "end_turn", usage: { input_tokens: 700, output_tokens: 40 } }) } as any;
    });
    const result = await callClaudeRowAdvisor(input);
    expect(sent.max_tokens).toBe(advisoryMaxTokens(2, true));
    const prompt = String(sent.messages[0].content);
    expect(prompt).not.toContain("at most twelve words");
    expect(prompt).not.toContain("reasonAr");
    expect(prompt).toContain("Do not explain");
    expect(prompt).toContain('{"reviews":[{"index":0,"verdict":"match"|"no_match"|"uncertain"}]}');
    expect(result.verdicts.get(0)).toEqual({ verdict: "no_match", reasonAr: "غير مطابق لموضوع الطلب" });
    expect(result.verdicts.get(1)).toEqual({ verdict: "match", reasonAr: "مطابق لموضوع الطلب" });
  });
});
