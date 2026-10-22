import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmClient } from "../src/functions/shared/llmClient";
import { resetProviderKeyCache } from "../src/lib/server/providerKeys";
import {
  callClaudeRowAdvisor, RETRY_MAX_TOKENS, REVIEW_FORMAT_STRICT_RULE, REVIEW_THINKING, reviewSocialRows, reviewThinkingFields, setReviewThinkingForTesting,
  SOCIAL_BROAD_TOPIC_RULE, SOCIAL_NOT_A_MATCH_RULE, VERDICT_ONLY_MAX_TOKENS, type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";
import { reviewSampleEventMessage, reviewThinkingFallbackEventMessage } from "../src/lib/server/reviewSpendLog";

const REQUEST = "عايز تغريدات عن غلاء الأسعار في مصر";
const rowsOf = (n: number) => Array.from({ length: n }, (_, index) => ({ index, row: { text: `منشور رقم ${index} عن موضوع معين في البلد` } }));
const compact = (from: number, to: number, verdict = "match") => `{"reviews":[${Array.from({ length: to - from }, (_, i) => `{"index":${from + i},"verdict":"${verdict}"}`).join(",")}]}`;
const okBody = (text: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 2700, output_tokens: 300, ...extra } });

describe("thinking is off on the model-review calls, in one place", () => {
  const originalFetch = globalThis.fetch;
  const saved = { key: process.env.ANTHROPIC_API_KEY, provider: process.env.LLM_PROVIDER, enabled: process.env.LLM_ENABLED, live: process.env.LLM_LIVE };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    delete process.env.LLM_PROVIDER; delete process.env.LLM_ENABLED; delete process.env.LLM_LIVE;
    resetProviderKeyCache();
    setReviewThinkingForTesting(null);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["LLM_PROVIDER", saved.provider], ["LLM_ENABLED", saved.enabled], ["LLM_LIVE", saved.live]] as const) {
      if (value === undefined) delete (process.env as any)[name]; else (process.env as any)[name] = value;
    }
    resetProviderKeyCache();
    setReviewThinkingForTesting(null);
  });

  /** A fetch stand-in that answers with the given responses in order and records every request body. */
  const stubFetch = (responses: Array<{ status: number; body: any }>) => {
    const bodies: any[] = [];
    let next = 0;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      const response = responses[Math.min(next, responses.length - 1)];
      next += 1;
      return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.body } as any;
    });
    return bodies;
  };

  it("the flag is one constant, off by default, and the field it adds is exactly thinking: {type: disabled}", () => {
    expect(REVIEW_THINKING).toBe("off");
    expect(reviewThinkingFields("off")).toEqual({ thinking: { type: "disabled" } });
    expect(reviewThinkingFields("default")).toEqual({});
    expect(reviewThinkingFields()).toEqual({ thinking: { type: "disabled" } });
  });

  it("a review call sends thinking: {type: disabled}, and changes nothing else of the request (model, room, prompt, no effort, no sampling)", async () => {
    const bodies = stubFetch([{ status: 200, body: okBody(compact(0, 2)) }]);
    const result = await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(2) });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].thinking).toEqual({ type: "disabled" });
    expect(bodies[0].model).toBe("claude-haiku-5-5");
    expect(bodies[0].max_tokens).toBe(VERDICT_ONLY_MAX_TOKENS);
    expect(Object.keys(bodies[0]).sort()).toEqual(["max_tokens", "messages", "model", "thinking"]);
    const prompt = String(bodies[0].messages[0].content);
    expect(prompt).toContain(REVIEW_FORMAT_STRICT_RULE);
    expect(prompt).toContain(SOCIAL_NOT_A_MATCH_RULE);
    expect(prompt).toContain(SOCIAL_BROAD_TOPIC_RULE);
    expect(result.thinkingMode).toBe("off");
    expect(result.verdicts.size).toBe(2);
    expect(result.failure).toBeNull();
  });

  it("the retry of the rows that had no verdict sends it too", async () => {
    const bodies = stubFetch([{ status: 200, body: okBody(compact(0, 2)) }]);
    await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(2), maxTokens: RETRY_MAX_TOKENS });
    expect(bodies[0].max_tokens).toBe(RETRY_MAX_TOKENS);
    expect(bodies[0].thinking).toEqual({ type: "disabled" });
  });

  it("with the flag set to default the parameter is gone and the rest of the request is the same", async () => {
    setReviewThinkingForTesting("default");
    const bodies = stubFetch([{ status: 200, body: okBody(compact(0, 2)) }]);
    const result = await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(2) });
    expect("thinking" in bodies[0]).toBe(false);
    expect(Object.keys(bodies[0]).sort()).toEqual(["max_tokens", "messages", "model"]);
    expect(result.thinkingMode).toBe("default");
    setReviewThinkingForTesting("off");
    const again = stubFetch([{ status: 200, body: okBody(compact(0, 2)) }]);
    await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(2) });
    expect(again[0].thinking).toEqual({ type: "disabled" });
  });

  it("the parameter is sent only by the review advisor: a chat turn through the LlmClient never carries it", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_LIVE = "true";
    resetProviderKeyCache();
    const bodies = stubFetch([{ status: 200, body: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "actionResult", input: { type: "ask_clarification", questions: [{ question: "ما هو المطلوب؟", options: ["أ", "ب"] }], reasonAr: "توضيح" } }], model: "claude-haiku-5-5", usage: { input_tokens: 500, output_tokens: 60 } } }]);
    await new LlmClient().executeTurn({ messages: [{ role: "user", content: "عاوز بيانات" }], sanitizedCapabilities: [] });
    expect(bodies).toHaveLength(1);
    expect("thinking" in bodies[0]).toBe(false);
    expect(JSON.stringify(bodies[0])).not.toContain("disabled");
  });

  it("nothing in the chat, planning or company-review code mentions the flag or the parameter", () => {
    for (const file of ["src/functions/shared/llmClient.ts", "src/functions/shared/chatHandler.ts", "src/app/api/chat/route.ts", "src/lib/server/companyRelevanceReview.ts"]) {
      const source = readFileSync(file, "utf-8");
      expect(source, file).not.toMatch(/REVIEW_THINKING|reviewThinking|thinking:\s*\{/);
    }
  });

  describe("an HTTP 400 on the new parameter: the same request is repeated ONCE without it", () => {
    const rejection = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "thinking: Input should be a valid dictionary" } } };

    it("the first request carries the parameter, the second is the same request without it, the verdicts come from the second, and the code is handed on", async () => {
      const bodies = stubFetch([rejection, { status: 200, body: okBody(compact(0, 3)) }]);
      const result = await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(3) });
      expect(bodies).toHaveLength(2);
      expect(bodies[0].thinking).toEqual({ type: "disabled" });
      const { thinking: _removed, ...first } = bodies[0];
      expect(bodies[1]).toEqual(first);
      expect("thinking" in bodies[1]).toBe(false);
      expect(result.verdicts.size).toBe(3);
      expect(result.failure).toBeNull();
      expect(result.thinkingMode).toBe("fallback");
      expect(result.thinkingFallback).toEqual({ code: "http_400", detail: "invalid_request_error: thinking: Input should be a valid dictionary" });
    });

    it("when the repeated request fails too, there is no third request: the failure is the second answer's, and the rows stay without a verdict", async () => {
      const bodies = stubFetch([rejection, { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "messages: bad" } } }]);
      const result = await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(3) });
      expect(bodies).toHaveLength(2);
      expect(result.failure).toBe("http_400");
      expect(result.detail).toBe("invalid_request_error: messages: bad");
      expect(result.verdicts.size).toBe(0);
      expect(result.thinkingFallback?.code).toBe("http_400");
    });

    it("other statuses do not trigger it (one request): 429 and 500 keep the failure they had", async () => {
      for (const status of [401, 429, 500, 529]) {
        const bodies = stubFetch([{ status, body: { type: "error", error: { type: "api_error", message: "x" } } }]);
        const result = await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(2) });
        expect(bodies, String(status)).toHaveLength(1);
        expect(result.failure).toBe(`http_${status}`);
        expect(result.thinkingFallback).toBeUndefined();
      }
    });

    it("with the flag on default a 400 is not retried (there is no parameter to drop)", async () => {
      setReviewThinkingForTesting("default");
      const bodies = stubFetch([rejection]);
      const result = await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(2) });
      expect(bodies).toHaveLength(1);
      expect(result.failure).toBe("http_400");
      expect(result.thinkingFallback).toBeUndefined();
    });

    it("the internal review_failure line names the code, the provider's short text and the action, on one line", () => {
      expect(reviewThinkingFallbackEventMessage(0, 1, { code: "http_400", detail: "invalid_request_error: thinking: bad" })).toBe('review_failure step=0 call=1 kind=thinking_param_rejected code=http_400 detail="invalid_request_error: thinking: bad" action=repeated_without_thinking_param');
      expect(reviewThinkingFallbackEventMessage(3, 2, { code: "http_400", detail: null })).toBe('review_failure step=3 call=2 kind=thinking_param_rejected code=http_400 detail="" action=repeated_without_thinking_param');
    });
  });

  describe("what the review does with the reply is unchanged", () => {
    const viaFetch = (): RowAdvisorFn => callClaudeRowAdvisor;

    it("a reply cut after 12 of 20 verdicts: the 12 are kept, only the 8 rows without a verdict are asked again (retry-missing-only, with more room), and the parameter is on both calls", async () => {
      const bodies = stubFetch([
        { status: 200, body: { ...okBody(compact(0, 12).slice(0, -2) + ',{"index":12,"verd'), stop_reason: "max_tokens" } },
        { status: 200, body: okBody(compact(12, 20)) },
      ]);
      const outcome = await reviewSocialRows({ advisor: viaFetch(), customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(20), budgetUsd: 0.15, callCostEstimateUsd: 0.0083 });
      expect(bodies).toHaveLength(2);
      expect(bodies.every((body) => body.thinking?.type === "disabled")).toBe(true);
      expect(bodies[1].max_tokens).toBe(RETRY_MAX_TOKENS);
      expect(outcome.verdicts.size).toBe(20);
      expect(outcome.unreviewed).toEqual([]);
      expect(outcome.attempts.map((attempt) => attempt.thinkingMode)).toEqual(["off", "off"]);
    });

    it("fail-closed: a reviewer that answers nothing readable leaves every row without a verdict (held, never matched), after the one retry of those rows", async () => {
      const bodies = stubFetch([{ status: 200, body: okBody("I think rows 0 and 1 are about the topic.") }]);
      const outcome = await reviewSocialRows({ advisor: viaFetch(), customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(20), budgetUsd: 0.15, callCostEstimateUsd: 0.0083 });
      expect(outcome.verdicts.size).toBe(0);
      expect(outcome.unreviewed).toHaveLength(20);
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      expect(bodies.every((body) => body.thinking?.type === "disabled")).toBe(true);
    });

    it("a network failure is still a network failure (one request, the parameter is not blamed)", async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error("socket hang up"); }) as any;
      const result = await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(2) });
      expect(result.failure).toBe("network");
      expect(result.verdicts.size).toBe(0);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("the sample row shows the effect on the next job", () => {
    it("the call's usage keeps the thinking tokens the API reports, and says none when it does not", async () => {
      stubFetch([{ status: 200, body: okBody(compact(0, 2), { output_tokens_details: { thinking_tokens: 1700 } }) }]);
      const withDetail = await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(2) });
      expect(withDetail.usage?.thinkingTokens).toBe(1700);
      expect(withDetail.usage?.outputTokens).toBe(300);
      stubFetch([{ status: 200, body: okBody(compact(0, 2)) }]);
      const without = await callClaudeRowAdvisor({ customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(2) });
      expect(without.usage && "thinkingTokens" in without.usage).toBe(false);
    });

    it("review_sample carries the output tokens, the thinking tokens and the thinking mode", () => {
      expect(reviewSampleEventMessage({ step: 0, rows: 17, stopReason: "end_turn", tokensIn: 2717, tokensOut: 310, thinkingTokens: 0, thinking: "off", replyChars: 578, sample: { head: "{\"reviews\":[", startsWithJson: true, reasonKeys: 0 } }))
        .toBe('review_sample step=0 rows=17 stop=end_turn in=2717 out=310 thinking_tokens=0 thinking=off reply_chars=578 starts_json=1 reason_keys=0 head="{\\"reviews\\":["');
      expect(reviewSampleEventMessage({ step: 0, rows: 17, stopReason: "end_turn", tokensIn: 2717, tokensOut: 1935, thinkingTokens: 1700, thinking: "default", replyChars: 578, sample: null }))
        .toContain("out=1935 thinking_tokens=1700 thinking=default reply_chars=578");
    });
  });
});
