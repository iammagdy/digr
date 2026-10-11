import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LlmClient,
  sanitizeMessagesForAnthropic,
  getLlmPricingSettings,
  scrubWhiteLabelText,
  getLastLlmFallbackReason,
  getLastLlmFallbackDetail,
  getLlmStatusSnapshot,
  setLastLlmFallbackReason,
  setLastLlmFallbackDetail,
} from "../src/functions/shared/llmClient";
import { ChatHandler } from "../src/functions/shared/chatHandler";

describe("Anthropic Provider Integration & Trust Boundaries", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("1. Provider Configuration & Model Resolution", () => {
    it("defaults to claude-haiku-5-5 when LLM_PROVIDER=anthropic and no model override is provided", () => {
      process.env.LLM_PROVIDER = "anthropic";
      delete process.env.ANTHROPIC_MODEL;
      delete process.env.LLM_MODEL;

      const client = new LlmClient();
      expect(client.getProvider()).toBe("anthropic");
      expect(client.getModel()).toBe("claude-haiku-5-5");
    });

    it("allows ANTHROPIC_MODEL to override the default model", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";

      const client = new LlmClient();
      expect(client.getProvider()).toBe("anthropic");
      expect(client.getModel()).toBe("claude-3-5-haiku-20241022");
    });

    it("falls back to LLM_MODEL if ANTHROPIC_MODEL is not set", () => {
      process.env.LLM_PROVIDER = "anthropic";
      delete process.env.ANTHROPIC_MODEL;
      process.env.LLM_MODEL = "claude-sonnet-custom";

      const client = new LlmClient();
      expect(client.getProvider()).toBe("anthropic");
      expect(client.getModel()).toBe("claude-sonnet-custom");
    });

    it("respects programmatic constructor overrides", () => {
      const client = new LlmClient({
        provider: "anthropic",
        model: "claude-3-haiku-20240307",
      });
      expect(client.getProvider()).toBe("anthropic");
      expect(client.getModel()).toBe("claude-3-haiku-20240307");
    });
  });

  describe("2. Anthropic Message Sanitization", () => {
    it("filters out system messages and preserves user/assistant roles", () => {
      const messages = [
        { role: "system" as const, content: "ignore this" },
        { role: "user" as const, content: "مرحبا" },
        { role: "assistant" as const, content: "أهلاً بك" },
      ];

      const sanitized = sanitizeMessagesForAnthropic(messages);
      expect(sanitized).toHaveLength(2);
      expect(sanitized[0]).toEqual({ role: "user", content: "مرحبا" });
      expect(sanitized[1]).toEqual({ role: "assistant", content: "أهلاً بك" });
    });

    it("merges consecutive messages with the same role", () => {
      const messages = [
        { role: "user" as const, content: "رسالة 1" },
        { role: "user" as const, content: "رسالة 2" },
        { role: "assistant" as const, content: "رد" },
      ];

      const sanitized = sanitizeMessagesForAnthropic(messages);
      expect(sanitized).toHaveLength(2);
      expect(sanitized[0]).toEqual({ role: "user", content: "رسالة 1\n\nرسالة 2" });
      expect(sanitized[1]).toEqual({ role: "assistant", content: "رد" });
    });

    it("ensures conversation starts with user role even if first message was assistant", () => {
      const messages = [
        { role: "assistant" as const, content: "رسالة ترحيبية" },
        { role: "user" as const, content: "استفسار" },
      ];

      const sanitized = sanitizeMessagesForAnthropic(messages);
      expect(sanitized[0].role).toBe("user");
      expect(sanitized[sanitized.length - 1].role).toBe("user");
    });

    it("ensures conversation strictly ends with user role by popping trailing assistant messages (tool_choice requirement)", () => {
      const messages = [
        { role: "user" as const, content: "أريد تحليل حساب" },
        { role: "assistant" as const, content: "جاري التفكير وتحليل طلبك..." },
      ];

      const sanitized = sanitizeMessagesForAnthropic(messages, { ensureUserEnd: true });
      expect(sanitized).toHaveLength(1);
      expect(sanitized[0].role).toBe("user");
      expect(sanitized[0].content).toBe("أريد تحليل حساب");
    });

    it("filters out empty or whitespace-only messages to avoid Anthropic 400 empty content errors", () => {
      const messages = [
        { role: "user" as const, content: "  " },
        { role: "assistant" as const, content: "" },
        { role: "user" as const, content: "سؤال حقيقي" },
      ];

      const sanitized = sanitizeMessagesForAnthropic(messages);
      expect(sanitized).toHaveLength(1);
      expect(sanitized[0].role).toBe("user");
      expect(sanitized[0].content).toBe("سؤال حقيقي");
    });

    it("returns default user message if input messages array is empty or contains only assistant messages", () => {
      const sanitizedEmpty = sanitizeMessagesForAnthropic([]);
      expect(sanitizedEmpty).toHaveLength(1);
      expect(sanitizedEmpty[0].role).toBe("user");

      const sanitizedOnlyAssistant = sanitizeMessagesForAnthropic([
        { role: "assistant" as const, content: "مرحبا" },
      ], { ensureUserEnd: true });
      expect(sanitizedOnlyAssistant).toHaveLength(1);
      expect(sanitizedOnlyAssistant[0].role).toBe("user");
    });
  });

  describe("3. Pricing from Settings", () => {
    it("uses default catalog pricing for claude-haiku-5-5 ($0.80 in / $4.00 out)", () => {
      const pricing = getLlmPricingSettings("anthropic", "claude-haiku-5-5");
      expect(pricing.inputCostPerMillion).toBe(0.80);
      expect(pricing.outputCostPerMillion).toBe(4.00);
    });

    it("accepts custom pricing overrides via parameters", () => {
      const pricing = getLlmPricingSettings("anthropic", "claude-haiku-5-5", {
        inputCostPerMillion: 0.50,
        outputCostPerMillion: 2.00,
      });
      expect(pricing.inputCostPerMillion).toBe(0.50);
      expect(pricing.outputCostPerMillion).toBe(2.00);
    });

    it("accepts environment variable pricing overrides", () => {
      process.env.ANTHROPIC_INPUT_COST_PER_MILLION = "0.75";
      process.env.ANTHROPIC_OUTPUT_COST_PER_MILLION = "3.50";

      const pricing = getLlmPricingSettings("anthropic", "claude-haiku-5-5");
      expect(pricing.inputCostPerMillion).toBe(0.75);
      expect(pricing.outputCostPerMillion).toBe(3.50);
    });
  });

  describe("4. White-Label Scrubbing", () => {
    it("replaces anthropic and claude references with منصة Digr", () => {
      const text = "Powered by Anthropic Claude 3.5 Haiku models for analysis";
      const scrubbed = scrubWhiteLabelText(text);
      expect(scrubbed).not.toContain("Anthropic");
      expect(scrubbed).not.toContain("Claude");
      expect(scrubbed).toContain("منصة Digr");
    });
  });

  describe("5. Mocked Execution & Structured Tool Use", () => {
    it("successfully parses tool_use actionResult for ask_clarification", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key-mock";

      const mockResponse = {
        id: "msg_mock_01",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: "actionResult",
            input: {
              type: "ask_clarification",
              questions: [
                {
                  question: "ما هو الحساب المطلوب تحليله على تيك توك؟",
                  options: ["حساب محدد", "بحث عام"],
                },
              ],
              reasonAr: "تحديد الحساب المطلوب بدقة",
            },
          },
        ],
        model: "claude-haiku-5-5",
        usage: {
          input_tokens: 500,
          output_tokens: 60,
        },
      };

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });
      vi.stubGlobal("fetch", fetchSpy);

      const client = new LlmClient();
      const result = await client.executeTurn({
        messages: [{ role: "user", content: "عاوز بيانات تيك توك" }],
        sanitizedCapabilities: [],
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(init.headers["x-api-key"]).toBe("test-anthropic-key-mock");
      expect(init.headers["anthropic-version"]).toBe("2023-06-01");

      const body = JSON.parse(init.body);
      expect(body.model).toBe("claude-haiku-5-5");
      expect(body.tool_choice).toEqual({ type: "tool", name: "actionResult" });

      expect(result.output.type).toBe("ask_clarification");
      expect(result.inputTokens).toBe(500);
      expect(result.outputTokens).toBe(60);
      // Cost: (500 * 0.80 + 60 * 4.00) / 1,000,000 = (400 + 240) / 1,000,000 = 0.00064
      expect(result.costUsd).toBeCloseTo(0.00064, 6);
    });

    it("successfully parses propose_plan output with correct capabilities", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key-mock";

      const mockResponse = {
        id: "msg_mock_02",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_02",
            name: "actionResult",
            input: {
              type: "propose_plan",
              summaryAr: "استخراج بيانات ملف الحساب @tiktok",
              capabilities: [
                {
                  capabilitySlug: "tiktok-profile",
                  params: { username: "tiktok" },
                  targetVolumeMin: 1,
                  targetVolumeMax: 1,
                },
              ],
              outputFormats: ["xlsx", "pdf", "csv"],
              methodologyNotes: "استخراج رسمي موثق",
            },
          },
        ],
        model: "claude-haiku-5-5",
        usage: {
          input_tokens: 800,
          output_tokens: 120,
        },
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      }));

      const client = new LlmClient();
      const result = await client.executeTurn({
        messages: [{ role: "user", content: "اسحب بيانات @tiktok" }],
        sanitizedCapabilities: [],
      });

      expect(result.output.type).toBe("propose_plan");
      if (result.output.type === "propose_plan") {
        expect(result.output.capabilities[0].capabilitySlug).toBe("tiktok-profile");
        expect(result.output.capabilities[0].params.username).toBe("tiktok");
      }
      expect(result.inputTokens).toBe(800);
      expect(result.outputTokens).toBe(120);
    });
  });

  describe("6. Provider Error Handling (Clean Refusals & No Points Held)", () => {
    it("handles 429 rate limit error gracefully with Arabic refusal and 0 cost", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = "test-key";

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: "Rate limit exceeded" } }),
      }));

      const client = new LlmClient();
      const result = await client.executeTurn({
        messages: [{ role: "user", content: "مرحبا" }],
        sanitizedCapabilities: [],
      });

      expect(result.output.type).toBe("refuse");
      if (result.output.type === "refuse") {
        expect(result.output.reasonAr).toContain("تجاوز حد الطلبات");
      }
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.costUsd).toBe(0);
    });

    it("handles 500 / 503 server error gracefully with Arabic refusal and 0 cost", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = "test-key";

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      }));

      const client = new LlmClient();
      const result = await client.executeTurn({
        messages: [{ role: "user", content: "مرحبا" }],
        sanitizedCapabilities: [],
      });

      expect(result.output.type).toBe("refuse");
      if (result.output.type === "refuse") {
        expect(result.output.reasonAr).toContain("صعوبة مؤقتة");
      }
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.costUsd).toBe(0);
    });

    it("handles 529 overloaded error gracefully with Arabic refusal", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = "test-key";

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 529,
        text: async () => JSON.stringify({ error: { message: "Anthropic is overloaded" } }),
      }));

      const client = new LlmClient();
      const result = await client.executeTurn({
        messages: [{ role: "user", content: "مرحبا" }],
        sanitizedCapabilities: [],
      });

      expect(result.output.type).toBe("refuse");
      if (result.output.type === "refuse") {
        expect(result.output.reasonAr).toContain("ضغطاً كبيراً");
      }
      expect(result.costUsd).toBe(0);
    });

    it("handles timeout abort cleanly with Arabic refusal", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = "test-key";

      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

      const client = new LlmClient();
      const result = await client.executeTurn({
        messages: [{ role: "user", content: "مرحبا" }],
        sanitizedCapabilities: [],
      });

      expect(result.output.type).toBe("refuse");
      if (result.output.type === "refuse") {
        expect(result.output.reasonAr).toContain("وقتاً أطول من المعتاد");
      }
      expect(result.costUsd).toBe(0);
    });

    it("handles missing ANTHROPIC_API_KEY cleanly with Arabic refusal and 0 cost", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      delete process.env.ANTHROPIC_API_KEY;

      const client = new LlmClient();
      const result = await client.executeTurn({
        messages: [{ role: "user", content: "مرحبا" }],
        sanitizedCapabilities: [],
      });

      expect(result.output.type).toBe("refuse");
      if (result.output.type === "refuse") {
        expect(result.output.reasonAr).toContain("غير مهيأة بشكل صحيح");
      }
      expect(result.costUsd).toBe(0);
    });

    it("handles 400 invalid_request_error: parses type and message, records last_fallback_detail without leaking secrets", async () => {
      const secretKey = "sk-ant-api03-TOP-SECRET-KEY-112233";
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = secretKey;
      process.env.ANTHROPIC_MODEL = "claude-haiku-5-5";

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const anthropic400Response = {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "tool_choice: may not be specified when prefilling assistant response",
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: async () => JSON.stringify(anthropic400Response),
        }),
      );

      const client = new LlmClient();
      const result = await client.executeTurn({
        messages: [{ role: "user", content: "مرحبا" }],
        sanitizedCapabilities: [],
      });

      expect(result.output.type).toBe("refuse");
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.costUsd).toBe(0);

      expect(getLastLlmFallbackReason()).toBe("http_400");
      expect(getLastLlmFallbackDetail()).toBe(
        "invalid_request_error: tool_choice: may not be specified when prefilling assistant response",
      );

      const snapshot = getLlmStatusSnapshot();
      expect(snapshot.last_fallback_reason).toBe("http_400");
      expect(snapshot.last_fallback_detail).toBe(
        "invalid_request_error: tool_choice: may not be specified when prefilling assistant response",
      );

      // Verify server log has sanitized reason and detail, and zero secret leak
      const warnCall = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes("[llm:error]"),
      );
      expect(warnCall).toBeDefined();
      const logLine = String(warnCall![0]);
      expect(logLine).toContain("provider=anthropic");
      expect(logLine).toContain("model=claude-haiku-5-5");
      expect(logLine).toContain("reason=http_400");
      expect(logLine).toContain(
        "detail=invalid_request_error: tool_choice: may not be specified when prefilling assistant response",
      );
      expect(logLine).not.toContain(secretKey);
      expect(logLine).not.toContain("TOP-SECRET");
    });

    it("handles 400 billing error with http_400_billing and Arabic refusal", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = "test-key";

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                message: "Your credit balance is too low to access the Anthropic API.",
              },
            }),
        }),
      );

      const client = new LlmClient();
      const result = await client.executeTurn({
        messages: [{ role: "user", content: "مرحبا" }],
        sanitizedCapabilities: [],
      });

      expect(result.output.type).toBe("refuse");
      if (result.output.type === "refuse") {
        expect(result.output.reasonAr).toContain("رصيد المزود غير كافٍ");
      }
      expect(getLastLlmFallbackReason()).toBe("http_400_billing");
      expect(getLastLlmFallbackDetail()).toContain("credit balance is too low");
    });

    it("asserts exact request body shape sent to Anthropic Messages API", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = "test-key-mock";
      process.env.ANTHROPIC_MODEL = "claude-haiku-5-5";

      let capturedBody: any = null;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string, init: any) => {
          capturedBody = JSON.parse(init.body);
          return {
            ok: true,
            json: async () => ({
              id: "msg_123",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: "actionResult",
                  input: {
                    type: "ask_clarification",
                    questionsAr: ["ما هي المنصة؟"],
                    reasonAr: "تحديد المنصة بدقة",
                  },
                },
              ],
              usage: { input_tokens: 100, output_tokens: 50 },
            }),
          };
        }),
      );

      const client = new LlmClient();
      // Pass messages that end with an assistant message (like the thinking placeholder)
      await client.executeTurn({
        messages: [
          { role: "user", content: "أريد بيانات تيك توك" },
          { role: "assistant", content: "جاري التفكير وتحليل طلبك..." },
        ],
        sanitizedCapabilities: [],
      });

      expect(capturedBody).toBeDefined();
      expect(capturedBody.model).toBe("claude-haiku-5-5");
      expect(capturedBody.max_tokens).toBe(1024);
      expect(typeof capturedBody.system).toBe("string");
      expect(capturedBody.system.length).toBeGreaterThan(0);

      // Verify messages strictly ends with a user turn
      expect(Array.isArray(capturedBody.messages)).toBe(true);
      expect(capturedBody.messages.length).toBe(1);
      expect(capturedBody.messages[0].role).toBe("user");
      expect(capturedBody.messages[0].content).toBe("أريد بيانات تيك توك");

      // Verify tools structure
      expect(Array.isArray(capturedBody.tools)).toBe(true);
      expect(capturedBody.tools).toHaveLength(1);
      expect(capturedBody.tools[0].name).toBe("actionResult");
      expect(capturedBody.tools[0].input_schema).toBeDefined();
      expect(capturedBody.tools[0].input_schema.type).toBe("object");

      // Verify tool_choice
      expect(capturedBody.tool_choice).toEqual({
        type: "tool",
        name: "actionResult",
      });
    });
  });

  describe("7. ChatHandler End-to-End Trust Boundary with Anthropic Error", () => {
    it("creates no plan quotes and holds zero points when provider encounters an error", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = "test-key";

      // Mock 500 error from Anthropic
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      }));

      const mockTables: any = {
        createRow: vi.fn().mockResolvedValue({ $id: "mock-id" }),
        getRow: vi.fn().mockResolvedValue({ totalTokens: 0 }),
        listRows: vi.fn().mockResolvedValue({ rows: [] }),
        updateRow: vi.fn().mockResolvedValue({}),
      };

      const handler = new ChatHandler(mockTables);
      const response = await handler.handleUserMessage({
        userId: "user-123",
        conversationId: "conv-123",
        message: "أريد تحليل حساب",
        userBalance: 50,
      });

      // Verification: User sees error in Arabic, no quote created, no points held
      expect(response.outputType).toBe("refuse");
      expect(response.planQuote).toBeUndefined();
      expect(response.tokensUsed.costUsd).toBe(0);
      expect(response.contentAr).toContain("صعوبة مؤقتة");

      // Verify no plans_quotes table was touched to reserve points
      const plansQuotesCalls = mockTables.createRow.mock.calls.filter(
        (call: any[]) => call[0].tableId === "plans_quotes"
      );
      expect(plansQuotesCalls).toHaveLength(0);

      // Verify llm_usage was logged with 0 tokens and 0 cost
      const llmUsageCalls = mockTables.createRow.mock.calls.filter(
        (call: any[]) => call[0].tableId === "llm_usage"
      );
      expect(llmUsageCalls).toHaveLength(1);
      expect(llmUsageCalls[0][0].data.inputTokens).toBe(0);
      expect(llmUsageCalls[0][0].data.outputTokens).toBe(0);
      expect(llmUsageCalls[0][0].data.costUsd).toBe(0);
    });

    it("ChatHandler excludes active thinking placeholder from messagesContext sent to Anthropic", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_LIVE = "true";
      process.env.ANTHROPIC_API_KEY = "test-key-valid";

      let capturedFetchBody: any = null;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string, init: any) => {
          capturedFetchBody = JSON.parse(init.body);
          return {
            ok: true,
            json: async () => ({
              id: "msg_ok",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: "actionResult",
                  input: {
                    type: "ask_clarification",
                    questionsAr: ["ما اسم الحساب؟"],
                    reasonAr: "تحديد الحساب",
                  },
                },
              ],
              usage: { input_tokens: 150, output_tokens: 40 },
            }),
          };
        }),
      );

      const createdRows: any[] = [];
      const mockTables: any = {
        createRow: vi.fn().mockImplementation(async (arg: any) => {
          const row = { $id: "id_" + createdRows.length, ...arg.data };
          createdRows.push(row);
          return row;
        }),
        getRow: vi.fn().mockResolvedValue({ totalTokens: 0 }),
        listRows: vi.fn().mockImplementation(async (arg: any) => {
          if (arg.tableId === "messages") {
            // listRows returns created messages including the thinking placeholder
            return { rows: [...createdRows] };
          }
          return { rows: [] };
        }),
        updateRow: vi.fn().mockResolvedValue({}),
      };

      const handler = new ChatHandler(mockTables);
      await handler.handleUserMessage({
        userId: "user-test",
        conversationId: "conv-test",
        message: "أريد تحليل الحساب @test",
        userBalance: 100,
      });

      // Verify Anthropic was called with messages ending in user turn (no thinking placeholder!)
      expect(capturedFetchBody).toBeDefined();
      const lastMsg =
        capturedFetchBody.messages[capturedFetchBody.messages.length - 1];
      expect(lastMsg.role).toBe("user");
      expect(lastMsg.content).toBe("أريد تحليل الحساب @test");
      expect(
        capturedFetchBody.messages.some((m: any) =>
          m.content.includes("جاري التفكير"),
        ),
      ).toBe(false);
    });
  });
});
