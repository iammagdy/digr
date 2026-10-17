import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildSystemPromptParts } from "../src/functions/shared/systemPrompt";
import { LlmClient, getLlmPricingSettings } from "../src/functions/shared/llmClient";
import { vi } from "vitest";

describe("system prompt: cacheable fixed rules, no hardcoded name", () => {
  const base = { sanitizedCapabilities: [], todayDate: "2026-10-17" };

  it("the fixed part is byte-identical for different users, balances and capabilities (so it can be cached)", () => {
    const first = buildSystemPromptParts({ ...base, userBalancePoints: 10, userProfile: { displayName: "سلمى", persona: "researcher" } });
    const second = buildSystemPromptParts({ ...base, userBalancePoints: 9999, userProfile: { displayName: "كريم", persona: "student" }, sanitizedCapabilities: [{ slug: "x" }] });
    expect(first.staticText).toBe(second.staticText);
    expect(first.dynamicText).not.toBe(second.dynamicText);
  });

  it("the per-user context lives only in the dynamic part", () => {
    const parts = buildSystemPromptParts({ ...base, userBalancePoints: 250, userProfile: { displayName: "سلمى" } });
    expect(parts.dynamicText).toContain("User Name: سلمى");
    expect(parts.dynamicText).toContain("Available Balance: 250");
    expect(parts.staticText).not.toContain("سلمى");
    expect(parts.staticText).not.toContain("User Name:");
  });

  it("the combined prompt still carries every rule (same content, new order)", () => {
    const prompt = buildSystemPrompt({ ...base });
    for (const needle of ["NO EMOJI", "Natural Research Assistant", "B2B DECISION MAKERS", "SAFETY & PROMPT-INJECTION DEFENSE", "AVAILABLE CATALOG CAPABILITIES"]) {
      expect(prompt).toContain(needle);
    }
  });

  it("never invents a name: an unknown name is empty and the model is told to ask once", () => {
    const parts = buildSystemPromptParts({ ...base });
    expect(parts.dynamicText).toMatch(/User Name:\s*\n/);
    expect(parts.staticText).toContain("ask once, politely, what name they prefer");
    expect(buildSystemPrompt({ ...base })).not.toContain("مجدي");
  });

  it("defaults match the owner decisions: small sample, no default period, data-only Excel", () => {
    const { staticText } = buildSystemPromptParts({ ...base });
    expect(staticText).not.toContain("default to 500 records");
    expect(staticText).not.toContain('default to last 30 days');
    expect(staticText).toContain("small sample of 10 records");
    expect(staticText).toContain("The Excel file carries data only");
    expect(staticText).not.toContain("executive dashboard");
  });

  it("cached prompt tokens are priced (reads 0.1x, writes 1.25x) and counted in the reported input", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_LIVE = "true";
    process.env.ANTHROPIC_API_KEY = "test-key-mock";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "tool_use", name: "actionResult", input: { type: "answer_question", answerAr: "أهلاً", intent: "chat" } }],
        usage: { input_tokens: 1000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000, output_tokens: 100 },
      }),
    }));
    const client = new LlmClient({ provider: "anthropic", isLive: true });
    const result = await client.executeTurn({ messages: [{ role: "user", content: "مرحبا" }], sanitizedCapabilities: [] });
    vi.unstubAllGlobals();
    expect(result.inputTokens).toBe(13000);
    // (1000 + 10000 x 0.1 + 2000 x 1.25) = 4500 weighted input tokens
    const pricing = getLlmPricingSettings("anthropic", result.model);
    expect(result.costUsd).toBeCloseTo((4500 * pricing.inputCostPerMillion + 100 * pricing.outputCostPerMillion) / 1_000_000, 10);
    // Always cheaper than billing every prompt token at the full input price.
    expect(result.costUsd).toBeLessThan((13000 * pricing.inputCostPerMillion + 100 * pricing.outputCostPerMillion) / 1_000_000);
  });
});

describe("social research rules reach the model", () => {
  it("the fixed rules name the verified services, the one-thing-per-plan-item rule and the honest limits", async () => {
    const { buildSystemPromptParts } = await import("../src/functions/shared/systemPrompt");
    const { staticText, dynamicText } = buildSystemPromptParts({ sanitizedCapabilities: [], userBalancePoints: 100 });
    expect(staticText).toContain('"social-..."');
    expect(staticText).toContain("كومنتس");
    expect(staticText).toMatch(/exactly ONE thing to collect/);
    expect(staticText).toMatch(/Trending requests use the country or region/);
    expect(staticText).toMatch(/Never invent a link/);
    // The part that changes every turn holds none of it, so the fixed block stays cacheable.
    expect(dynamicText).not.toContain("SOCIAL RESEARCH");
  });
});
