export const LLM_KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", fake: "" };
export const LLM_MODEL_ENV: Record<string, string> = { anthropic: "ANTHROPIC_MODEL", openai: "OPENAI_MODEL", fake: "LLM_MODEL" };

/** Secrets never leave the server: only «configured» and the last 4 characters are ever returned. */
export function last4(secret: string | undefined): string | null {
  const v = (secret || "").trim();
  return v ? v.slice(-4) : null;
}
