import { describe, expect, it } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";
import { buildSystemPromptParts } from "../src/functions/shared/systemPrompt";
import { ACTION_RESULT_JSON_SCHEMA, DEFAULT_LLM_PRICING } from "../src/functions/shared/llmClient";
import { APPROVED_CAPABILITY_CATALOG, sanitizeCapabilitiesForLlm } from "../src/functions/shared/capabilityRegistry";
import { breakdownRequest, estimateScriptAwareTokens, splitStaticPromptSections } from "../src/lib/server/promptTokenBreakdown";
import { compactHistoryForModel, HISTORY_ASSISTANT_MAX_CHARS } from "../src/functions/shared/turnGuards";

/** Uncached input tokens cost 1x, cached ones 0.1x (reads), output 5x the input price on this model. */
function turnUsd(parts: { cachedTokens: number; uncachedTokens: number; outputTokens: number }): number {
  const p = DEFAULT_LLM_PRICING["claude-haiku-5-5"];
  return ((parts.cachedTokens * 0.1 + parts.uncachedTokens) * p.inputCostPerMillion + parts.outputTokens * p.outputCostPerMillion) / 1_000_000;
}

describe("item 9: section-by-section token estimate of a real model request", () => {
  async function captureRealPlanTurn() {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    // A fully stated request is planned in code (no model call); this measurement needs the model path.
    handler.deterministicPlanning = false;
    const llm = (handler as any).llm;
    const calls: any[] = [];
    const original = llm.executeTurn.bind(llm);
    llm.executeTurn = async (options: any) => { calls.push(options); return original(options); };
    await db.createRow({ tableId: "conversations", rowId: "c1", data: { userId: "u1", title: "x", status: "active", totalTokens: 0 } });
    for (const message of ["مساء الخير", "هات ١٠ تغريدات عن كرة السلة"]) {
      await handler.handleUserMessage({ userId: "u1", conversationId: "c1", message, userBalance: 5000 });
    }
    return calls[calls.length - 1];
  }

  it("prints the breakdown, keeps all 20 capabilities and the identity, and stays under the per-turn target", async () => {
    const options = await captureRealPlanTurn();
    expect(options).toBeDefined();
    const parts = buildSystemPromptParts({
      userProfile: options.userProfile, sanitizedCapabilities: options.sanitizedCapabilities, todayDate: options.todayDate,
      userBalancePoints: options.userBalancePoints, conversationState: options.conversationState, resultColumns: options.resultColumns,
    });
    const schemaJson = JSON.stringify(ACTION_RESULT_JSON_SCHEMA);
    const breakdown = breakdownRequest({
      staticText: parts.staticText, capabilityText: parts.capabilityText, profileText: parts.profileText, turnText: parts.turnText,
      toolSchemaJson: schemaJson, messages: options.messages,
    });
    // eslint-disable-next-line no-console
    console.log(["TOKEN BREAKDOWN (script-aware estimate)", ...breakdown.sections.map((s) => `${String(s.tokens).padStart(6)}  ${s.cached ? "cached  " : "uncached"}  ${s.name}`), `${String(breakdown.total).padStart(6)}  total input`].join("\n"));

    // Nothing lost: every capability stays in the prompt, and so does the fixed identity.
    const capabilities = sanitizeCapabilitiesForLlm(APPROVED_CAPABILITY_CATALOG);
    const inventory = buildSystemPromptParts({ sanitizedCapabilities: capabilities }).capabilityText;
    for (const capability of capabilities) expect(inventory).toContain(`[${capability.slug}]`);
    expect(parts.staticText).toContain('"ديجر الذكي"');
    expect(parts.staticText).toContain("IDENTITY & VOICE");

    const cachedTokens = breakdown.sections.filter((s) => s.cached).reduce((sum, s) => sum + s.tokens, 0);
    const uncachedTokens = breakdown.sections.filter((s) => !s.cached).reduce((sum, s) => sum + s.tokens, 0);
    expect(cachedTokens).toBeGreaterThan(uncachedTokens);
    // Everything that does not change between turns is read from the cache; only the small per-turn state is not.
    const turnOnly = breakdown.sections.find((s) => s.name.startsWith("per-turn state"))!;
    expect(turnOnly.tokens).toBeLessThan(200);
  }, 60000);

  it("before/after estimate on a production-like conversation (calibrated to the live ~16k input tokens)", () => {
    const capabilities = sanitizeCapabilitiesForLlm(APPROVED_CAPABILITY_CATALOG);
    const parts = buildSystemPromptParts({ sanitizedCapabilities: capabilities, userBalancePoints: 500, userProfile: { persona: "researcher" } });
    const tool = estimateScriptAwareTokens(JSON.stringify(ACTION_RESULT_JSON_SCHEMA));
    const staticTokens = estimateScriptAwareTokens(parts.staticText);
    const capabilityTokens = estimateScriptAwareTokens(parts.capabilityText);
    const profileTokens = estimateScriptAwareTokens(parts.profileText);
    const turnTokens = estimateScriptAwareTokens(parts.turnText);
    // Ten recent messages: five customer messages and five assistant replies with their plan summaries.
    const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "ك".repeat(i % 2 === 0 ? 200 : 1800) }));
    const tokensOf = (messages: Array<{ content: string }>) => messages.reduce((sum, m) => sum + estimateScriptAwareTokens(m.content), 0);
    const notes = 276; // brief + compact catalog summary system message
    const outputTokens = 350; // live plan turns: 0.0058-0.0067 USD at ~16k input implies 300-400 output tokens

    const before = turnUsd({ cachedTokens: tool + staticTokens, uncachedTokens: capabilityTokens + profileTokens + turnTokens + tokensOf(history) + notes, outputTokens });
    const afterHistory = compactHistoryForModel(history);
    const after = turnUsd({ cachedTokens: tool + staticTokens + capabilityTokens + profileTokens, uncachedTokens: turnTokens + tokensOf(afterHistory) + notes, outputTokens });
    // Cache restructuring alone (certain, independent of how long live histories are):
    const afterCacheOnly = turnUsd({ cachedTokens: tool + staticTokens + capabilityTokens + profileTokens, uncachedTokens: turnTokens + tokensOf(history) + notes, outputTokens });
    const inputBefore = tool + staticTokens + capabilityTokens + profileTokens + turnTokens + tokensOf(history) + notes;
    // eslint-disable-next-line no-console
    console.log(`BEFORE: ~${inputBefore} input tokens, ${before.toFixed(5)} USD per turn (cache hit)\nAFTER:  ${after.toFixed(5)} USD per turn (cache hit); saved ${(before - after).toFixed(5)} USD\nAFTER (cache blocks only, history not shortened): ${afterCacheOnly.toFixed(5)} USD`);
    expect(inputBefore).toBeGreaterThan(13000);
    expect(inputBefore).toBeLessThan(18000);
    expect(before).toBeGreaterThan(0.0055); // matches the live 0.0058-0.0067 range
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThanOrEqual(0.005);
  });


  it("splits the fixed prompt into named sections that add up", () => {
    const parts = buildSystemPromptParts({ sanitizedCapabilities: [] });
    const sections = splitStaticPromptSections(parts.staticText);
    expect(sections.length).toBeGreaterThan(8);
    const sum = sections.reduce((n, s) => n + s.tokens, 0);
    expect(Math.abs(sum - estimateScriptAwareTokens(parts.staticText))).toBeLessThan(sections.length * 2);
  });

  it("older turns are shortened but the newest message is sent whole", () => {
    const long = "ك".repeat(3000);
    const history = [
      { role: "user", content: "طلب أول" },
      { role: "assistant", content: long },
      { role: "user", content: long },
    ];
    const out = compactHistoryForModel(history);
    expect(out[1].content.length).toBeLessThanOrEqual(HISTORY_ASSISTANT_MAX_CHARS + 1);
    expect(out[1].content.endsWith("…")).toBe(true);
    expect(out[2].content).toBe(long);
    expect(out[0].content).toBe("طلب أول");
  });
});
