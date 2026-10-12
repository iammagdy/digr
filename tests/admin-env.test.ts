import { describe, expect, it } from "vitest";
import { validateEnvUpdate } from "../src/lib/server/envAdmin";

describe("admin env update validation (providers page)", () => {
  it("only allows the documented variables", () => {
    expect(validateEnvUpdate("APPWRITE_API_KEY", "x".repeat(20))).not.toBeNull();
    expect(validateEnvUpdate("NODE_ENV", "production")).not.toBeNull();
    expect(validateEnvUpdate("LLM_ENABLED", "false")).toBeNull();
  });

  it("validates toggles, providers, models, secrets and the TREG base URL", () => {
    expect(validateEnvUpdate("TREG_LIVE", "yes")).not.toBeNull();
    expect(validateEnvUpdate("LLM_PROVIDER", "gemini")).not.toBeNull();
    expect(validateEnvUpdate("LLM_PROVIDER", "openai")).toBeNull();
    expect(validateEnvUpdate("ANTHROPIC_MODEL", "claude-haiku-5-5")).toBeNull();
    expect(validateEnvUpdate("ANTHROPIC_MODEL", "bad model!")).not.toBeNull();
    expect(validateEnvUpdate("TREG_TOKEN", "short")).not.toBeNull();
    expect(validateEnvUpdate("TREG_TOKEN", "treg_" + "a".repeat(20))).toBeNull();
    expect(validateEnvUpdate("OPENAI_API_KEY", "sk with space 1234")).not.toBeNull();
    expect(validateEnvUpdate("TREG_BASE_URL", "http://treg.to")).not.toBeNull();
    expect(validateEnvUpdate("TREG_BASE_URL", "https://treg.to")).toBeNull();
  });
});
