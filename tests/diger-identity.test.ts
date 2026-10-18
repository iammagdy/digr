import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { buildSystemPromptParts } from "../src/functions/shared/systemPrompt";
import { APPROVED_CAPABILITY_CATALOG, sanitizeCapabilitiesForLlm } from "../src/functions/shared/capabilityRegistry";
import {
  DIGER_AI_NAME_AR,
  IDENTITY_ANSWER_AR,
  TECHNOLOGY_DEFLECTION_AR,
  identityQuestionKind,
  scrubAssistantIdentity,
} from "../src/lib/assistantIdentity";
import { estimateTurnCostUsd, measurePromptCost, TARGET_TURN_COST_USD } from "../src/lib/server/llmTurnCost";
import { makeTables } from "./helpers/memoryTables";

const VENDOR = /anthropic|claude|openai|chat\s*gpt|\bgpt|gemini|haiku|كلود|انثروبيك|أنثروبيك|اوبن|جي بي تي/i;

describe("13. Diger AI identity", () => {
  it("recognises identity and technology questions, and nothing else", () => {
    for (const q of ["إنت مين؟", "انت مين يا برنس", "من أنت", "عرفني بنفسك", "إنت بوت؟", "are you a robot, who are you"]) {
      expect(identityQuestionKind(q), q).toBe("who");
    }
    for (const q of ["مين عملك؟", "انت شغال على ايه؟", "انت chatgpt؟", "إنت كلود ولا جي بي تي؟", "هل أنت openai", "who made you", "what model are you"]) {
      expect(identityQuestionKind(q), q).toBe("technology");
    }
    for (const q of ["عايز ٣ شركات كهرباء في مصر", "مين اشهر الشركات في السعودية", "هات تعليقات فيديو عن كرة القدم", "ازيك", ""]) {
      expect(identityQuestionKind(q), q).toBeNull();
    }
  });

  it("the fixed answers are Arabic only, polite and name Diger AI, never a vendor", () => {
    for (const answer of [IDENTITY_ANSWER_AR, TECHNOLOGY_DEFLECTION_AR]) {
      expect(answer).toContain(DIGER_AI_NAME_AR);
      expect(answer).toMatch(/الذكاء الاصطناعي/);
      expect(answer).not.toMatch(/[A-Za-z]|\p{Extended_Pictographic}/u);
      expect(answer).not.toMatch(VENDOR);
      expect(answer).not.toMatch(/نموذج لغوي/);
      expect((answer.match(/؟/g) || []).length).toBe(1);
    }
  });

  describe("through the real chat handler (offline)", () => {
    beforeEach(() => clearBriefCacheForTesting());
    afterEach(() => clearBriefCacheForTesting());
    const ask = (message: string) =>
      new ChatHandler(makeTables() as any).handleUserMessage({ userId: `u_${Math.random()}`, message, userBalance: 500, personaProfile: { name: "سلمى" } }) as Promise<any>;

    it("«إنت مين؟» gets the fixed identity answer with no model turn", async () => {
      const res = await ask("إنت مين؟");
      expect(res.outputType).toBe("answer_question");
      expect(res.contentAr).toBe(IDENTITY_ANSWER_AR);
      expect(res.tokensUsed).toEqual({ input: 0, output: 0, costUsd: 0 });
      expect(res.planQuote).toBeUndefined();
    });

    it("a question about the technology never names it", async () => {
      for (const q of ["انت chatgpt ولا claude؟", "مين عملك؟", "انت شغال على ايه؟"]) {
        const res = await ask(q);
        expect(res.contentAr).toBe(TECHNOLOGY_DEFLECTION_AR);
        expect(res.contentAr).not.toMatch(VENDOR);
      }
    });

    it("a research request is not mistaken for an identity question", async () => {
      const res = await ask("عايز ٣ شركات كهرباء في مصر");
      expect(res.outputType).toBe("propose_plan");
    });
  });

  it("model text that names the vendor or talks like a generic chatbot is replaced; useful text stays", () => {
    const text = "As an AI language model, I can help. أنا Claude من Anthropic. سأجهز لك الخطة الآن. بصفتي نموذج لغوي لا أستطيع الجزم.";
    const clean = scrubAssistantIdentity(text);
    expect(clean).not.toMatch(VENDOR);
    expect(clean).not.toMatch(/language model|نموذج لغوي/i);
    expect(clean).toContain("سأجهز لك الخطة الآن.");
    expect(clean).toContain(DIGER_AI_NAME_AR);
    expect(scrubAssistantIdentity("تمام، سأجهز لك الخطة.")).toBe("تمام، سأجهز لك الخطة.");
  });

  it("the handler scrubs the final reply and the prompt states the identity, tone and ban on vendor talk", () => {
    expect(readFileSync("src/functions/shared/chatHandler.ts", "utf8")).toContain("scrubAssistantIdentity(deduplicateIntroText(finalContentAr))");
    const { staticText } = buildSystemPromptParts({ sanitizedCapabilities: [] });
    expect(staticText).toContain('"ديجر الذكي" (Diger AI)');
    expect(staticText).toContain("polite Egyptian Arabic, concise and confident");
    expect(staticText).toContain("no \"as a language model\"");
    expect(staticText).not.toMatch(VENDOR);
  });

  it("the model string is unchanged", () => {
    const client = readFileSync("src/functions/shared/llmClient.ts", "utf8");
    expect(client).toContain('process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5"');
  });
});

describe("13. model cost per turn, measured offline from the real prompt", () => {
  const m = measurePromptCost();

  it("keeps the full capability list in the prompt", () => {
    expect(m.capabilityCount).toBe(sanitizeCapabilitiesForLlm(APPROVED_CAPABILITY_CATALOG).length);
    const { dynamicText } = buildSystemPromptParts({ sanitizedCapabilities: sanitizeCapabilitiesForLlm(APPROVED_CAPABILITY_CATALOG) });
    for (const cap of APPROVED_CAPABILITY_CATALOG) expect(dynamicText).toContain(cap.slug);
  });

  it("a cached turn costs less than the first turn, and caching is what makes the target reachable", () => {
    const [first, typical, plan, long] = m.perTurn;
    expect(first.usd).toBeGreaterThan(typical.usd);
    expect(plan.usd).toBeGreaterThan(typical.usd);
    expect(long.usd).toBeGreaterThan(plan.usd);
    const uncached = estimateTurnCostUsd({ staticTokens: m.staticTokens, dynamicTokens: m.dynamicTokens, historyTokens: 600, outputTokens: 150, cacheHit: false });
    expect(uncached).toBeGreaterThan(TARGET_TURN_COST_USD);
  });

  it("reports the status against the 0.005 USD target on the cautious reading", () => {
    expect(m.targetUsd).toBe(0.005);
    expect(m.perTurnConservative[1].usd).toBeLessThanOrEqual(TARGET_TURN_COST_USD);
    expect(m.status).toBe("met");
  });
});
