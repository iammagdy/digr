import { afterEach, describe, expect, it } from "vitest";
import { applyEnvUpdates, validateEnvUpdate } from "../src/lib/server/envAdmin";

describe("admin env update validation (providers page)", () => {
  const previousTregLive = process.env.TREG_LIVE;
  const previousTregToken = process.env.TREG_TOKEN;

  afterEach(() => {
    if (previousTregLive === undefined) delete process.env.TREG_LIVE;
    else process.env.TREG_LIVE = previousTregLive;
    if (previousTregToken === undefined) delete process.env.TREG_TOKEN;
    else process.env.TREG_TOKEN = previousTregToken;
  });

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

  it("persists shared non-secret settings through the admin table adapter and never stores provider secrets", async () => {
    let providers: Record<string, unknown> = { LLM_ENABLED: "false", TREG_TOKEN: "old-secret" };
    const tables = {
      getRow: async () => ({ key: "providers", value: providers }),
      updateRow: async ({ data }: { data: Record<string, unknown> }) => { providers = data; },
    };

    const results = await applyEnvUpdates(null, [
      { key: "TREG_LIVE", value: "true" },
      { key: "TREG_TOKEN", value: "new-secret-token" },
    ], tables);

    expect(results).toEqual([{ target: "supabase:settings_private", ok: true, message: "تم حفظ الإعدادات غير الحساسة في Supabase" }]);
    expect(providers).toEqual({ LLM_ENABLED: "false", TREG_LIVE: "true" });
    expect(process.env.TREG_LIVE).toBe("true");
    expect(process.env.TREG_TOKEN).toBe("new-secret-token");
  });
});
