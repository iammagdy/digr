/**
 * Offline model-cost measurement. Reads the real system prompt and prices it with the model price table. Makes no API
 * call and spends nothing. Run: npx tsx scripts/measure-llm-cost.ts
 */
import { measurePromptCost } from "../src/lib/server/llmTurnCost";

const m = measurePromptCost();
console.log(`capabilities in the prompt: ${m.capabilityCount}`);
console.log(`fixed (cacheable) prompt: ~${m.staticTokens} tokens; per-turn context: ~${m.dynamicTokens} tokens`);
for (const row of m.perTurn) console.log(`${row.scenario}: ${row.usd.toFixed(5)} USD (chars/4)`);
for (const row of m.perTurnConservative) console.log(`${row.scenario}: ${row.usd.toFixed(5)} USD (cautious, chars/2.5)`);
console.log(`target ${m.targetUsd} USD per turn: ${m.status}`);
