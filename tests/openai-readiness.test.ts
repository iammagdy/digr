import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmClient } from "../src/functions/shared/llmClient";
import { sanitizeCapabilitiesForLlm, type Capability } from "../src/functions/shared/capabilityRegistry";
import { buildSystemPrompt } from "../src/functions/shared/systemPrompt";
import { checkUserDailySpendCap } from "../src/functions/shared/rateLimits";

const actionKeys = [
  "intro", "questions", "questionsAr", "optionsAr", "reasonAr", "summaryAr", "answerAr", "titleAr", "contentAr",
  "unsupportedService", "explanationAr", "closestAlternative", "canRequestFeature", "capabilities", "executionOptions",
  "outputSpecJson", "outputFormats", "methodologyNotes", "rationaleAr", "operations", "target", "action", "parametersJson",
] as const;

function action(type: string, overrides: Record<string, unknown> = {}) {
  return Object.assign({ type, ...Object.fromEntries(actionKeys.map((key) => [key, null])) }, overrides);
}

function responseBody(output: unknown, usage = { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 8 } }) {
  const outputText = JSON.stringify(output);
  return {
    id: "resp_test",
    object: "response",
    created_at: 1_800_000_000,
    status: "completed",
    model: "gpt-6-luna",
    output: [{ id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: outputText, annotations: [] }] }],
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    usage,
  };
}

function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

function openAiOptions() {
  return {
    messages: [{ role: "user" as const, content: "أريد خطة بحث عن حسابات عامة" }],
    sanitizedCapabilities: [{ slug: "tiktok-public-profiles", category: "tiktok", nameAr: "حسابات عامة", descriptionAr: "بيانات عامة", paramsSchema: {}, maxRows: 100 }],
    userProfile: { persona: "researcher", purposes: ["بحث أكاديمي"], topic: "حسابات عامة" },
    conversationId: "conversation_test",
    userId: "user_test",
  };
}

function mockFetch(implementation: (...args: any[]) => Promise<Response>) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setOpenAiEnv() {
  vi.stubEnv("LLM_ENABLED", "true");
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("OPENAI_API_KEY", "unit-test-only-key");
  vi.stubEnv("OPENAI_MODEL", "gpt-6-luna");
  vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "900");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI go-live readiness (network mocked)", () => {
  it("sends a Responses structured-output request and preserves bounded dependent plan fields and usage", async () => {
    setOpenAiEnv();
    const proposePlan = action("propose_plan", {
      summaryAr: "تحليل حسابات عامة ومحتواها حتى 80 سجلاً",
      capabilities: [
        { stepId: "accounts", capabilitySlug: "tiktok-public-profiles", paramsJson: "{}", targetVolumeMin: 1, targetVolumeMax: 10, dependsOn: null, inputFrom: null, fanOutCap: null, volumeMode: "bounded", windowed: false },
        { stepId: "videos", capabilitySlug: "tiktok-public-videos", paramsJson: "{}", targetVolumeMin: 1, targetVolumeMax: 80, dependsOn: ["accounts"], inputFrom: { stepId: "accounts", field: "username", paramKey: "username" }, fanOutCap: 8, volumeMode: "open_ended", windowed: true },
      ],
      executionOptions: { windowing: "per_month", windowFrom: "2026-01-01", windowTo: "2026-03-31", includeReplies: false, dedupe: true, languageFilter: null, anonymize: true, qualityReport: true },
      outputFormats: ["csv"],
    });
    const fetchMock = mockFetch(async () => response(responseBody({ actionResult: proposePlan })));

    const result = await new LlmClient().executeTurn(openAiOptions());
    expect(result.output.type).toBe("propose_plan");
    if (result.output.type !== "propose_plan") throw new Error("expected plan");
    expect(result.output.capabilities[1].dependsOn).toEqual(["accounts"]);
    expect(result.output.capabilities[1].inputFrom).toEqual({ stepId: "accounts", field: "username", paramKey: "username" });
    expect(result.output.capabilities[1].fanOutCap).toBe(8);
    expect(result.output.capabilities[1].volumeMode).toBe("open_ended");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.costUsd).toBeCloseTo(0.000035, 10);
    expect(result.model).toBe("gpt-6-luna");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    const payload = JSON.parse(String(requestInit.body));
    expect(payload.model).toBe("gpt-6-luna");
    expect(payload.reasoning.effort).toBe("low");
    expect(payload.max_output_tokens).toBe(900);
    expect(payload.text.format.type).toBe("json_schema");
    expect(payload.text.format.strict).toBe(true);
    expect(JSON.stringify(payload.input)).not.toMatch(/unit-test-only-key|openai|chatgpt|gpt-6|treg/i);
  });

  it("fails safely without a key and makes no network request", async () => {
    vi.stubEnv("LLM_ENABLED", "true");
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = mockFetch(async () => response({}));

    const result = await new LlmClient().executeTurn(openAiOptions());
    expect(result.output.type).toBe("refuse");
    expect(JSON.stringify(result.output)).toContain("متوقف مؤقتاً");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("[llm:missing OPENAI_API_KEY]");
  });

  it("records actual usage even when a completed response fails the server output schema", async () => {
    setOpenAiEnv();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(async () => response(responseBody({ actionResult: action("unsupported_action") })));

    const result = await new LlmClient().executeTurn(openAiOptions());
    expect(result.output.type).toBe("refuse");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.costUsd).toBeCloseTo(0.000035, 10);
    expect(warning).toHaveBeenCalledWith("[llm:invalid_json_schema]");
  });

  it("retries once on a temporary upstream failure and does not leak error bodies", async () => {
    setOpenAiEnv();
    const answer = action("answer_question", { answerAr: "يمكنك تصدير النتائج إلى ملف CSV." });
    const fetchMock = mockFetch(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return response({ error: { message: "private upstream body", code: "server_is_overloaded" } }, 503, { "retry-after": "0" });
      }
      return response(responseBody({ actionResult: answer }));
    });

    const result = await new LlmClient().executeTurn(openAiOptions());
    expect(result.output.type).toBe("answer_question");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.output)).not.toContain("private upstream body");
  });

  it("does not retry non-transient quota exhaustion", async () => {
    setOpenAiEnv();
    const fetchMock = mockFetch(async () => response({ error: { message: "billing detail must not leak", code: "insufficient_quota" } }, 429));

    const result = await new LlmClient().executeTurn(openAiOptions());
    expect(result.output.type).toBe("refuse");
    expect(JSON.stringify(result.output)).not.toContain("billing detail");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("meters the dedicated result review before returning a validated suggestion", async () => {
    setOpenAiEnv();
    vi.stubEnv("RESULT_REVIEW_MODEL_ENABLED", "true");
    mockFetch(async () => response(responseBody({
      comparisonAr: "طلبت ١٠ سجلات ووصلت ٨ سجلات.",
      suggestions: [{ type: "anonymize", labelAr: "إخفاء الأسماء", paramsJson: "{\"enabled\":true}" }],
    })));
    const usageRows: Array<Record<string, unknown>> = [];
    const facts = {
      requested: { min: 10, max: 10 }, delivered: 8,
      rowsPerSource: [{ source: "tiktok-profile", count: 8, inferred: false }],
      rowsPerWindow: [], dayByDayCoverage: [], duplicateCount: 0, replyCount: 0, replyShare: 0,
      conversationsWithMultipleItems: 0, languageShares: [], emptyWindows: [], failedWindows: [],
      observedDateRange: { from: null, to: null }, unrelatedShare: null, findings: [], samples: [], severity: "warning" as const,
    };

    const review = await new LlmClient().reviewResult(facts, async (usage) => {
      usageRows.push({ ...usage });
    });
    expect(review?.comparisonAr).toContain("وصلت ٨ سجلات");
    expect(review?.suggestions).toEqual([{ type: "anonymize", labelAr: "إخفاء الأسماء", params: { enabled: true } }]);
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({ model: "gpt-6-luna", inputTokens: 100, outputTokens: 50 });
    expect(usageRows[0].costUsd).toBeCloseTo(0.000035, 10);
  });

  it("does not call the service when the kill switch is off or the provider is invalid", async () => {
    setOpenAiEnv();
    const fetchMock = mockFetch(async () => response({}));
    vi.stubEnv("LLM_ENABLED", "false");
    await new LlmClient().executeTurn(openAiOptions());
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("LLM_ENABLED", "true");
    vi.stubEnv("LLM_PROVIDER", "unexpected");
    await new LlmClient().executeTurn(openAiOptions());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the per-user daily cap from llm_usage rows", async () => {
    vi.stubEnv("LLM_USER_DAILY_SPEND_CAP_USD", "0.10");
    const tables = {
      listRows: vi.fn().mockResolvedValue({
        total: 2,
        rows: [{ costUsd: 0.07 }, { costUsd: 0.04 }],
      }),
    };
    const result = await checkUserDailySpendCap(tables as any, "user_test");
    expect(result.allowed).toBe(false);
    expect(result.type).toBe("user_spend_cap");
    expect(result.statusCode).toBe(429);
    expect(result.reasonAr).not.toMatch(/\$|USD|OpenAI|GPT|TREG/i);
    expect(tables.listRows).toHaveBeenCalledTimes(1);
  });

  it("keeps vendor identifiers, dollar amounts, and credential-like strings out of prompts and capability context", () => {
    const capability: Capability = {
      slug: "treg-secret-search",
      category: "tiktok",
      nameAr: "بحث حسابات OpenAI $3",
      nameEn: "TREG Search",
      descriptionAr: "Call TREG API key=sk-test-value-123456789; USD 2.50",
      paramsSchema: JSON.stringify({ type: "object", properties: { username: { type: "string", description: "اسم المستخدم" }, unitCostUsd: { type: "number" }, accessToken: { type: "string" } } }),
      tregEndpointId: "internal-endpoint-secret",
      tregMethod: "POST",
      pricingUnit: "item",
      unitCostUsd: 0.01,
      maxRows: 100,
      paginationType: "cursor",
      enabled: true,
    };
    const sanitizedCapabilities = sanitizeCapabilitiesForLlm([capability]);
    const prompt = buildSystemPrompt({
      sanitizedCapabilities,
      userProfile: { persona: "researcher", purposes: ["OpenAI report, $20, api_key=sk-private-key-123456789"], topic: "TREG trends for USD 30" },
      userBalancePoints: 15,
    });

    expect(prompt).not.toMatch(/openai|chatgpt|gpt-[3456]|treg|tikhub|serpapi/i);
    expect(prompt).not.toMatch(/\$\s?\d|\b\d+(?:\.\d+)?\s?USD|sk-(?:test|private)-[A-Za-z0-9_-]+/i);
    expect(prompt).not.toMatch(/\b(?:costs?|prices?|markup)\b/i);
    expect(JSON.stringify(sanitizedCapabilities)).not.toMatch(/endpoint|unitCost|accessToken|sk-test|openai|treg/i);
  });
});
