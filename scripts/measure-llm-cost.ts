/**
 * Offline model-cost measurement. Reads the real system prompt and prices it with the model price table. Makes no API
 * call and spends nothing. Run: npx tsx scripts/measure-llm-cost.ts
 */
import { measurePromptCost } from "../src/lib/server/llmTurnCost";
import { buildSystemPromptParts } from "../src/functions/shared/systemPrompt";
import { APPROVED_CAPABILITY_CATALOG, sanitizeCapabilitiesForLlm } from "../src/functions/shared/capabilityRegistry";
import { ACTION_RESULT_JSON_SCHEMA } from "../src/functions/shared/llmClient";
import { estimateScriptAwareTokens, splitStaticPromptSections } from "../src/lib/server/promptTokenBreakdown";

const m = measurePromptCost();
console.log(`capabilities in the prompt: ${m.capabilityCount}`);
console.log(`fixed (cacheable) prompt: ~${m.staticTokens} tokens; per-turn context: ~${m.dynamicTokens} tokens`);
for (const row of m.perTurn) console.log(`${row.scenario}: ${row.usd.toFixed(5)} USD (chars/4)`);
for (const row of m.perTurnConservative) console.log(`${row.scenario}: ${row.usd.toFixed(5)} USD (cautious, chars/2.5)`);
console.log(`target ${m.targetUsd} USD per turn: ${m.status}`);

// Section-by-section (script-aware estimate; Arabic text costs more tokens per character than JSON or English).
const parts = buildSystemPromptParts({ sanitizedCapabilities: sanitizeCapabilitiesForLlm(APPROVED_CAPABILITY_CATALOG), userBalancePoints: 500 });
console.log("\nsection-by-section (cached blocks first):");
console.log(`${String(estimateScriptAwareTokens(JSON.stringify(ACTION_RESULT_JSON_SCHEMA))).padStart(6)}  tool schema`);
for (const section of splitStaticPromptSections(parts.staticText)) console.log(`${String(section.tokens).padStart(6)}  fixed prompt · ${section.name}`);
console.log(`${String(estimateScriptAwareTokens(parts.capabilityText)).padStart(6)}  capability inventory`);
console.log(`${String(estimateScriptAwareTokens(parts.profileText)).padStart(6)}  user profile (cached per user)`);
console.log(`${String(estimateScriptAwareTokens(parts.turnText)).padStart(6)}  per-turn state (never cached)`);
