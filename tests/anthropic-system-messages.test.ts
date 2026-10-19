import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LlmClient, collectSystemNotesForTurn, sanitizeMessagesForAnthropic } from "../src/functions/shared/llmClient";
import { buildSystemPromptParts } from "../src/functions/shared/systemPrompt";
import { renderCapabilityCards, renderCapabilityExtras, renderFixedCapabilityCards } from "../src/functions/shared/capabilityCards";

const NOTE_A = "[ملخص متطلبات البحث الحالية]: المنصة web، الموضوع كرة السلة";
const NOTE_B = "[ملاحظة الطلب المستقل]: هذا الطلب مستقل عن الطلبات السابقة";

describe("system notes reach the model on the Claude path", () => {
  it("collectSystemNotesForTurn returns every system note in order, with a header, and nothing when there is none", () => {
    expect(collectSystemNotesForTurn([{ role: "user", content: "مرحبا" }, { role: "assistant", content: "أهلاً" }])).toBe("");
    const block = collectSystemNotesForTurn([
      { role: "system", content: NOTE_A },
      { role: "user", content: "هات ١٠ تغريدات" },
      { role: "system", content: NOTE_B },
      { role: "system", content: "   " },
    ]);
    expect(block.startsWith("INTERNAL NOTES FOR THIS TURN")).toBe(true);
    expect(block).toContain(NOTE_A);
    expect(block).toContain(NOTE_B);
    expect(block.indexOf(NOTE_A)).toBeLessThan(block.indexOf(NOTE_B));
    expect(block).not.toContain("هات ١٠ تغريدات");
  });

  it("each note and the whole block are capped", () => {
    const long = "ب".repeat(5000);
    const block = collectSystemNotesForTurn([{ role: "system", content: long }, { role: "system", content: long }, { role: "system", content: long }, { role: "system", content: long }]);
    const body = block.slice(block.indexOf("\n") + 1);
    expect(body.length).toBeLessThanOrEqual(9000);
    expect(body.startsWith("ب".repeat(3000))).toBe(true);
  });

  it("sanitizeMessagesForAnthropic still drops system messages (the notes travel in the system blocks instead)", () => {
    const sanitized = sanitizeMessagesForAnthropic([{ role: "system", content: NOTE_A }, { role: "user", content: "مرحبا" }]);
    expect(sanitized).toEqual([{ role: "user", content: "مرحبا" }]);
  });

  describe("request sent to the model", () => {
    const originalEnv = process.env;
    beforeEach(() => {
      process.env = { ...originalEnv, LLM_PROVIDER: "anthropic", LLM_LIVE: "true", ANTHROPIC_API_KEY: "test-key-notes", ANTHROPIC_MODEL: "claude-haiku-5-5" };
      delete process.env.LLM_ENABLED;
    });
    afterEach(() => {
      process.env = originalEnv;
      vi.unstubAllGlobals();
    });

    it("the notes sit in the uncached per-turn system block; cached blocks and the messages are unchanged", async () => {
      let body: any = null;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
        body = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", name: "actionResult", input: { type: "answer_question", answerAr: "تمام", intent: "chat" } }], usage: { input_tokens: 100, output_tokens: 20 } }) };
      }));
      await new LlmClient().executeTurn({
        messages: [
          { role: "system", content: NOTE_A },
          { role: "user", content: "هات ١٠ تغريدات عن كرة السلة" },
          { role: "system", content: NOTE_B },
        ],
        sanitizedCapabilities: [],
      });
      expect(body.system).toHaveLength(4);
      expect(body.system[3].cache_control).toBeUndefined();
      expect(body.system[3].text).toContain("Available Balance:");
      expect(body.system[3].text).toContain(NOTE_A);
      expect(body.system[3].text).toContain(NOTE_B);
      for (const cached of [body.system[0], body.system[1], body.system[2]]) {
        expect(cached.cache_control).toEqual({ type: "ephemeral" });
        expect(cached.text).not.toContain(NOTE_A);
        expect(cached.text).not.toContain(NOTE_B);
      }
      expect(body.messages).toEqual([{ role: "user", content: "هات ١٠ تغريدات عن كرة السلة" }]);
      expect(body).not.toHaveProperty("temperature");
    });

    it("a reply that arrives but fails validation keeps the real tokens and cost; a provider error carries none", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ content: [{ type: "tool_use", name: "actionResult", input: { type: "not_a_turn_type" } }], usage: { input_tokens: 400, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, output_tokens: 120 } }),
      })));
      const billed: any = await new LlmClient().executeTurn({ messages: [{ role: "user", content: "مرحبا" }], sanitizedCapabilities: [] });
      expect(billed.output.type).toBe("refuse");
      expect(billed.fallbackCode).toBe("schema_invalid");
      expect(billed.inputTokens).toBe(10400);
      expect(billed.outputTokens).toBe(120);
      // 400 uncached + 10000 x 0.1 cached = 1400 weighted input tokens, plus 120 output tokens, at the table's rates.
      expect(billed.costUsd).toBeCloseTo((1400 * 0.8 + 120 * 4.0) / 1_000_000, 8);

      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ error: { type: "api_error", message: "internal" } }) })));
      const failed: any = await new LlmClient().executeTurn({ messages: [{ role: "user", content: "مرحبا" }], sanitizedCapabilities: [] });
      expect(failed.output.type).toBe("refuse");
      expect(failed.fallbackCode).toBe("http_5xx");
      expect(failed.inputTokens).toBe(0);
      expect(failed.outputTokens).toBe(0);
      expect(failed.costUsd).toBe(0);
    });
  });
});

describe("the cacheable capability block is frozen", () => {
  const liveA = [{ slug: "live-endpoint-a", platform: "web", nameAr: "خدمة أ", paramsSchema: { properties: { q: { type: "string" } } }, maxRows: 10 }];
  const liveB = [{ slug: "live-endpoint-b", platform: "web", nameAr: "خدمة ب", paramsSchema: { properties: { topic: { type: "string" } } }, maxRows: 20 }];

  it("capabilityText is byte-identical whatever the live catalog returned; the extras go to the per-turn text", () => {
    const none = buildSystemPromptParts({ sanitizedCapabilities: [] });
    const a = buildSystemPromptParts({ sanitizedCapabilities: liveA });
    const b = buildSystemPromptParts({ sanitizedCapabilities: liveB });
    expect(a.capabilityText).toBe(none.capabilityText);
    expect(b.capabilityText).toBe(none.capabilityText);
    expect(a.capabilityText).not.toContain("live-endpoint-a");
    expect(a.turnText).toContain("[live-endpoint-a] خدمة أ (web) مدخلات: q حتى 10 سجل");
    expect(b.turnText).toContain("[live-endpoint-b]");
    expect(b.turnText).not.toContain("live-endpoint-a");
    expect(none.turnText).not.toContain("ADDITIONAL SERVICES THIS TURN");
    // nothing is lost: the whole dynamic text still lists the extra service
    expect(a.dynamicText).toContain("[live-endpoint-a]");
  });

  it("renderCapabilityCards keeps its behaviour: fixed cards, then the extras", () => {
    expect(renderCapabilityCards(liveA)).toBe(`${renderFixedCapabilityCards()}\n${renderCapabilityExtras(liveA)}`);
    expect(renderCapabilityCards([])).toBe(renderFixedCapabilityCards());
    expect(renderCapabilityExtras([])).toBe("");
  });
});
