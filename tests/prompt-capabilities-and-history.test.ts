import { describe, expect, it } from "vitest";
import { buildSystemPromptParts } from "../src/functions/shared/systemPrompt";
import { APPROVED_CAPABILITY_CATALOG, sanitizeCapabilitiesForLlm } from "../src/functions/shared/capabilityRegistry";
import { compactHistoryForModel, HISTORY_ASSISTANT_MAX_CHARS } from "../src/functions/shared/turnGuards";

describe("the model request keeps every capability and the identity; older turns are shortened", () => {
  it("keeps all capabilities and the identity in the prompt", () => {
    const capabilities = sanitizeCapabilitiesForLlm(APPROVED_CAPABILITY_CATALOG);
    const parts = buildSystemPromptParts({ sanitizedCapabilities: capabilities });
    for (const capability of capabilities) expect(parts.capabilityText).toContain(`[${capability.slug}]`);
    expect(parts.staticText).toContain('"ديجر الذكي"');
    expect(parts.staticText).toContain("IDENTITY & VOICE");
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
