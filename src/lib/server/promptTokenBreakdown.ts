/**
 * Section-by-section token estimate of one model request (offline: no API call, no spend).
 * Arabic letters cost more tokens per character than Latin text or JSON, so the estimate is script-aware:
 * Arabic-script characters at 1 token per 2.2, everything else at 1 per 3.6 (calibrated against the live
 * Anthropic usage rows of plan turns, ~16k input tokens).
 */
export const ARABIC_CHARS_PER_TOKEN = 2.2;
export const OTHER_CHARS_PER_TOKEN = 3.6;

export function estimateScriptAwareTokens(text: string): number {
  if (!text) return 0;
  const arabic = (text.match(/[؀-ۿݐ-ݿ]/g) || []).length;
  return Math.ceil(arabic / ARABIC_CHARS_PER_TOKEN + (text.length - arabic) / OTHER_CHARS_PER_TOKEN);
}

export interface TokenSection { name: string; tokens: number; /** true when this block is read from the prompt cache on a repeat turn */ cached?: boolean }

const HEADING_RE = /^[A-Z][A-Z0-9 &\-/,.'’:+]{6,}$/;

/** Splits the fixed prompt at its ALL-CAPS headings; text before the first heading is «preamble». */
export function splitStaticPromptSections(staticText: string): TokenSection[] {
  const sections: Array<{ name: string; lines: string[] }> = [{ name: "preamble", lines: [] }];
  for (const line of staticText.split("\n")) {
    // A heading is an ALL-CAPS line; a trailing «(v7)» or «(FIXED…)» note is ignored when matching.
    const trimmed = line.trim().replace(/\s*\([^)]*\)\s*:?$/, "");
    if (HEADING_RE.test(trimmed)) sections.push({ name: trimmed.slice(0, 60), lines: [line] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections.map((section) => ({ name: section.name, tokens: estimateScriptAwareTokens(section.lines.join("\n")) }));
}

export interface RequestParts {
  staticText: string;
  capabilityText: string;
  profileText: string;
  turnText: string;
  toolSchemaJson: string;
  messages: Array<{ role: string; content: string }>;
}

/** The request in sending order. Cached blocks are the tool schema and the first three system blocks. */
export function breakdownRequest(parts: RequestParts): { sections: TokenSection[]; total: number } {
  const sections: TokenSection[] = [
    { name: "tool schema (actionResult)", tokens: estimateScriptAwareTokens(parts.toolSchemaJson), cached: true },
    ...splitStaticPromptSections(parts.staticText).map((s) => ({ name: `fixed prompt · ${s.name}`, tokens: s.tokens, cached: true })),
    { name: "capability inventory (all capabilities)", tokens: estimateScriptAwareTokens(parts.capabilityText), cached: true },
    { name: "user profile and persona", tokens: estimateScriptAwareTokens(parts.profileText), cached: true },
    { name: "per-turn state (balance, date, conversation state)", tokens: estimateScriptAwareTokens(parts.turnText), cached: false },
  ];
  const byRole = new Map<string, number>();
  for (const message of parts.messages) byRole.set(message.role, (byRole.get(message.role) || 0) + estimateScriptAwareTokens(message.content));
  for (const [role, tokens] of byRole) sections.push({ name: `conversation messages · ${role}`, tokens, cached: false });
  return { sections, total: sections.reduce((sum, s) => sum + s.tokens, 0) };
}
