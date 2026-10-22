import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCustomerVisibleJobEvent, REVIEW_SAMPLE_EVENT_TYPE } from "../src/lib/reviewCostEvent";
import { resetProviderKeyCache } from "../src/lib/server/providerKeys";
import { reviewSampleEventMessage } from "../src/lib/server/reviewSpendLog";
import {
  callClaudeRowAdvisor, parseAdvisoryReply, replySampleOf, REPLY_SAMPLE_CHARS, REVIEW_FORMAT_STRICT_RULE, reviewSocialRows, SOCIAL_BROAD_TOPIC_RULE,
  SOCIAL_NOT_A_MATCH_RULE, UNREVIEWED_REASON_AR, type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";

const REQUEST_A = "عايز تغريدات عن غلاء الأسعار في مصر\nالدولة المطلوبة: مصر";
const REQUEST_B = "عايز تعليقات عن مباراة الأهلي والزمالك";
const rowsOf = (n: number, text = (i: number) => `منشور رقم ${i} يتكلم عن موضوع معين في البلد`) => Array.from({ length: n }, (_, index) => ({ index, row: { text: text(index) } }));
const compact = (from: number, to: number, verdict = "match") => `{"reviews":[${Array.from({ length: to - from }, (_, i) => `{"index":${from + i},"verdict":"${verdict}"}`).join(",")}]}`;

describe("the sharper match definition in the review instruction", () => {
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

  const promptFor = async (kind: string, customerRequest: string, replyText = compact(0, 2)) => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: replyText }], stop_reason: "end_turn", usage: { input_tokens: 2600, output_tokens: 300 } }) } as any;
    });
    const result = await callClaudeRowAdvisor({ customerRequest, kind, rows: rowsOf(2) });
    return { prompt: String(bodies[0].messages[0].content), result };
  };

  it("a post prompt carries the definition: ABOUT the topic itself, not an ad, a price list, a promotion or a passing mention; borderline is uncertain", async () => {
    const { prompt } = await promptFor("social-x-posts", REQUEST_A);
    expect(prompt).toContain("\"match\" only if the text is itself ABOUT that topic: it discusses, reports, complains about or reacts to the requested topic as its subject.");
    expect(prompt).toContain(SOCIAL_NOT_A_MATCH_RULE);
    expect(SOCIAL_NOT_A_MATCH_RULE).toContain("an advertisement or promotion");
    expect(SOCIAL_NOT_A_MATCH_RULE).toContain("a price list or product or service listing");
    expect(SOCIAL_NOT_A_MATCH_RULE).toContain("a passing mention");
    expect(prompt).toContain(SOCIAL_BROAD_TOPIC_RULE);
    expect(SOCIAL_BROAD_TOPIC_RULE).toContain("broad or abstract");
    expect(SOCIAL_BROAD_TOPIC_RULE).toContain("answer \"uncertain\", never \"match\"");
    expect(prompt).not.toContain("\"match\" only if the text itself is about that topic.");
  });

  it("comments get the same definition", async () => {
    const { prompt } = await promptFor("social-tiktok-comments", REQUEST_B);
    expect(prompt).toContain(SOCIAL_NOT_A_MATCH_RULE);
    expect(prompt).toContain(SOCIAL_BROAD_TOPIC_RULE);
  });

  it("it is generic: the rule text is the same for any request and holds no topic of its own", async () => {
    const a = await promptFor("social-x-posts", REQUEST_A);
    const b = await promptFor("social-x-posts", REQUEST_B);
    const strip = (prompt: string, request: string) => prompt.replace(request.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim(), "REQUEST").split("\nRows:\n")[0];
    expect(strip(a.prompt, REQUEST_A)).toBe(strip(b.prompt, REQUEST_B));
    for (const rule of [SOCIAL_NOT_A_MATCH_RULE, SOCIAL_BROAD_TOPIC_RULE, REVIEW_FORMAT_STRICT_RULE]) {
      expect(rule).not.toMatch(/غلاء|مباراة|الأهلي|الزمالك|football|inflation|egypt|مصر/i);
    }
  });

  it("the strict-format instruction is in every verdict-only prompt (posts, comments, the video list), not in the prompt for companies", async () => {
    for (const kind of ["social-x-posts", "social-tiktok-comments", "social-tiktok-comments-video-list"]) {
      expect((await promptFor(kind, REQUEST_B)).prompt, kind).toContain(REVIEW_FORMAT_STRICT_RULE);
    }
    const companies = (await promptFor("companies", REQUEST_B)).prompt;
    expect(companies).not.toContain(REVIEW_FORMAT_STRICT_RULE);
    expect(companies).not.toContain(SOCIAL_NOT_A_MATCH_RULE);
    expect(REVIEW_FORMAT_STRICT_RULE).toContain("the very first character of your reply is {");
    expect(REVIEW_FORMAT_STRICT_RULE).toContain("exactly two keys, index and verdict");
    expect(REVIEW_FORMAT_STRICT_RULE).toContain("Never write reasoning, analysis, a reason key");
  });

  it("the video-list definition is untouched: it does not get the post rules", async () => {
    const { prompt } = await promptFor("social-tiktok-comments-video-list", REQUEST_B);
    expect(prompt).not.toContain(SOCIAL_NOT_A_MATCH_RULE);
    expect(prompt).not.toContain(SOCIAL_BROAD_TOPIC_RULE);
    expect(prompt).toContain("Each row is a VIDEO found by a topic search");
  });

  it("the extra input per call is small: the three added rules are under 800 characters (about 250 tokens of a 2,600-token call)", () => {
    const added = SOCIAL_NOT_A_MATCH_RULE.length + SOCIAL_BROAD_TOPIC_RULE.length + REVIEW_FORMAT_STRICT_RULE.length;
    expect(added).toBe(779);
    expect(added).toBeLessThan(800);
  });
});

describe("the reply sample: the head of the raw reply, scrubbed of row and request text", () => {
  it("keeps the format, the verdicts and the numbers", () => {
    const reply = compact(0, 3, "no_match");
    expect(replySampleOf(reply, rowsOf(3), REQUEST_A)).toEqual({ head: reply, startsWithJson: true, reasonKeys: 0 });
  });

  it("removes every run of ten characters or more shared with a row's text, and with the customer's request", () => {
    const rows = rowsOf(2, (i) => `هذا منشور فريد رقم ${i} عن سعر الخبز والبنزين في القاهرة`);
    const reply = `Let me think. Row 0 says "هذا منشور فريد رقم 0 عن سعر الخبز" so it is about prices. The customer asked: عايز تغريدات عن غلاء الأسعار. ${compact(0, 2)}`;
    const sample = replySampleOf(reply, rows, REQUEST_A);
    expect(sample.head).not.toContain("هذا منشور فريد");
    expect(sample.head).not.toContain("سعر الخبز");
    expect(sample.head).not.toContain("عايز تغريدات");
    expect(sample.head).toContain("Let me think.");
    expect(sample.head).toContain("so it is about prices.");
    expect(sample.head).toContain('{"reviews":[{"index":0,"verdict":"match"}');
    expect(sample.startsWithJson).toBe(false);
  });

  it("a short word the reply shares with a row is not removed (only runs of ten or more)", () => {
    const sample = replySampleOf("the row says الخبز and match", rowsOf(1, () => "الخبز غالي"), REQUEST_B);
    expect(sample.head).toBe("the row says الخبز and match");
  });

  it("is cut at 500 characters, counts the reason keys the model was told not to write, and an empty reply is an empty head", () => {
    expect(REPLY_SAMPLE_CHARS).toBe(500);
    const long = `{"reviews":[${Array.from({ length: 40 }, (_, i) => `{"index":${i},"verdict":"match","reasonAr":"x"}`).join(",")}]}`;
    const sample = replySampleOf(long, rowsOf(2), REQUEST_A);
    expect(sample.head).toHaveLength(500);
    expect(sample.head).toBe(long.slice(0, 500));
    expect(sample.reasonKeys).toBe(40);
    expect(replySampleOf("", rowsOf(1), REQUEST_A)).toEqual({ head: "", startsWithJson: false, reasonKeys: 0 });
  });

  it("the internal line is one line with numbers and the quoted head only, and the customer never sees it", () => {
    expect(REVIEW_SAMPLE_EVENT_TYPE).toBe("review_sample");
    expect(isCustomerVisibleJobEvent("review_sample")).toBe(false);
    const message = reviewSampleEventMessage({ step: 0, rows: 20, stopReason: "end_turn", tokensIn: 2586, tokensOut: 1962, replyChars: 9120, sample: { head: 'Let me "think"\nfirst {"reviews":[', startsWithJson: false, reasonKeys: 3 } });
    expect(message).toBe('review_sample step=0 rows=20 stop=end_turn in=2586 out=1962 thinking_tokens=none thinking=none reply_chars=9120 starts_json=0 reason_keys=3 head="Let me \\"think\\"\\nfirst {\\"reviews\\":["');
    expect(message.split("\n")).toHaveLength(1);
    expect(reviewSampleEventMessage({ step: 2, rows: 5, stopReason: null, tokensIn: 0, tokensOut: 0, replyChars: null, sample: null })).toBe('review_sample step=2 rows=5 stop=none in=0 out=0 thinking_tokens=none thinking=none reply_chars=none starts_json=none reason_keys=none head=""');
  });
});

describe("a reply that thinks aloud before its verdicts: read, salvaged, and fail-closed unchanged", () => {
  it("words (even with braces) before the JSON do not break the read: every verdict after them counts", () => {
    const reply = `Let me look at each {row} carefully. Row 0 {about prices}: yes.\n${compact(0, 3)}`;
    expect([...parseAdvisoryReply(reply, { verdictOnly: true })].map(([i, v]) => `${i}:${v.verdict}`)).toEqual(["0:match", "1:match", "2:match"]);
  });

  it("words before a reply that is cut off: the complete items still count, the cut one does not", () => {
    const reply = `Thinking first...\n${compact(0, 6, "no_match").slice(0, -40)}`;
    const verdicts = parseAdvisoryReply(reply, { verdictOnly: true });
    expect(verdicts.size).toBeGreaterThanOrEqual(4);
    expect(verdicts.size).toBeLessThan(6);
    for (const [, verdict] of verdicts) expect(verdict.verdict).toBe("no_match");
  });

  it("words only, no verdicts at all: nothing is read (a held row is never a matched row)", () => {
    expect(parseAdvisoryReply("I think the first one is about the topic and the second is an ad.", { verdictOnly: true }).size).toBe(0);
    expect(parseAdvisoryReply("Row 0: {match} Row 1: {no_match}", { verdictOnly: true }).size).toBe(0);
  });

  it("a call whose reply is only reasoning is a bad_reply with no verdict; the rows are held, asked again once (only those), and still held when that fails too", async () => {
    const calls: number[] = [];
    const thinker: RowAdvisorFn = async (input) => {
      calls.push(input.rows.length);
      return { verdicts: new Map(), usage: { inputTokens: 2600, outputTokens: 1800, costUsd: 0.009, model: "claude-haiku-5-5", latencyMs: 8000 }, failure: "bad_reply", stopReason: "end_turn", replyChars: 3000 };
    };
    const outcome = await reviewSocialRows({ advisor: thinker, customerRequest: REQUEST_A, kind: "social-x-posts", rows: rowsOf(20), budgetUsd: 0.15, callCostEstimateUsd: 0.0083 });
    expect(outcome.verdicts.size).toBe(0);
    expect(outcome.unreviewed).toHaveLength(20);
    expect(outcome.unreviewedByCap).toEqual([]);
    expect(calls[0]).toBe(20);
    expect(calls.slice(1).every((size) => size <= 10)).toBe(true);
    expect(UNREVIEWED_REASON_AR).toContain("لم يُحتسب");
  });

  it("the production call keeps partial verdicts of a thinking reply, and records its scrubbed head and shape", async () => {
    const originalFetch = globalThis.fetch;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    resetProviderKeyCache();
    try {
      const rows = rowsOf(6, (i) => `هذا منشور فريد رقم ${i} عن غلاء الأسعار والمعيشة في مصر`);
      const reply = `Row 0 says "هذا منشور فريد رقم 0 عن غلاء" which is about the topic.\n${compact(0, 6).slice(0, -30)}`;
      globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: reply }], stop_reason: "max_tokens", usage: { input_tokens: 2600, output_tokens: 4000 } }) }) as any);
      const result = await callClaudeRowAdvisor({ customerRequest: REQUEST_A, kind: "social-x-posts", rows });
      expect(result.verdicts.size).toBeGreaterThanOrEqual(3);
      expect(result.verdicts.size).toBeLessThan(6);
      expect(result.failure).toBeNull();
      expect(result.stopReason).toBe("max_tokens");
      expect(result.replySample?.startsWithJson).toBe(false);
      expect(result.replySample?.head).not.toContain("هذا منشور فريد");
      expect(result.replySample?.head).toContain("which is about the topic.");
      expect(result.replySample?.head.length).toBeLessThanOrEqual(500);
    } finally {
      globalThis.fetch = originalFetch;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
      resetProviderKeyCache();
    }
  });
});
