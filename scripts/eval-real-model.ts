import * as dotenv from "dotenv";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSystemPrompt } from "../src/functions/shared/systemPrompt";
import { LlmClient, type LlmTurnOutput } from "../src/functions/shared/llmClient";
import { sanitizeCapabilitiesForLlm, type Capability } from "../src/functions/shared/capabilityRegistry";
import { EVAL_CASES, type EvalCase } from "./eval-cases";

dotenv.config({ path: ".env.local" });

const DEFAULT_MAX_USD = 0.25;
const DEFAULT_MAX_TOKENS = 2_000_000;
const MAX_OUTPUT_TOKENS_PER_CASE = 300;
// Conservative room for the JSON schema and request serialization beyond the visible prompt.
const INPUT_SCHEMA_OVERHEAD_BYTES = 15_000;
const DEFAULT_MODEL = "gpt-6-luna";

interface CliOptions {
  provider: "fake" | "openai";
  model: string;
  maxUsd: number;
  maxTokens: number;
}

interface EvalResult {
  id: number;
  category: string;
  persona: string;
  prompt: string;
  expected: string;
  actual: string;
  questionsAsked: string[];
  passed: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  note: string;
}

const availableCapability: Capability = {
  slug: "tiktok-profile",
  category: "tiktok",
  nameAr: "بيانات الحساب العامة",
  nameEn: "Public profile data",
  descriptionAr: "المؤشرات العامة للحساب مثل المتابعين والإعجابات وعدد المقاطع",
  paramsSchema: JSON.stringify({ type: "object", properties: { username: { type: "string", description: "اسم المستخدم" } }, required: ["username"] }),
  tregEndpointId: "internal-profile-endpoint",
  tregMethod: "POST",
  pricingUnit: "item",
  unitCostUsd: 0,
  maxRows: 1,
  paginationType: "none",
  enabled: true,
};
const capabilities = sanitizeCapabilitiesForLlm([availableCapability]);

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error("Invalid argument; use --provider, --model, --max-usd or --max-tokens.");
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}.`);
    if (!["provider", "model", "max-usd", "max-tokens"].includes(name)) throw new Error(`Unknown option --${name}.`);
    values.set(name, value);
    index += 1;
  }
  const provider = values.get("provider") || "fake";
  if (provider !== "fake" && provider !== "openai") throw new Error("--provider must be fake or openai.");
  const model = values.get("model") || process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const maxUsd = Number(values.get("max-usd") || DEFAULT_MAX_USD);
  const maxTokens = Number(values.get("max-tokens") || DEFAULT_MAX_TOKENS);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("--max-usd must be a positive number.");
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error("--max-tokens must be a positive integer.");
  return { provider, model, maxUsd, maxTokens };
}

function readRate(name: string, defaultValue: number): number {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}; it must be a non-negative number.`);
  return value;
}

function questionsAsked(output: LlmTurnOutput): string[] {
  if (output.type !== "ask_clarification") return [];
  if (Array.isArray(output.questions)) return output.questions.map((question) => question.text || question.question || "").filter(Boolean);
  return Array.isArray(output.questionsAr) ? output.questionsAr.filter(Boolean) : [];
}

function unsafePromptOrOutput(text: string): boolean {
  return /\b(?:openai|chatgpt|gpt[-\s]?[3456][\w.-]*|treg|tikhub|serpapi)\b|\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{12,}\b|\$\s?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:USD|dollars?)\b|\b(?:unitcost|markup|internal\s+price)\b/i.test(text);
}

function expectedPass(testCase: EvalCase, output: LlmTurnOutput): boolean {
  if (!testCase.expectedTypes.includes(output.type)) return false;
  if (testCase.category === "prompt_injection" && !["refuse", "answer_question"].includes(output.type)) return false;
  return true;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (EVAL_CASES.length !== 60) throw new Error(`Expected 60 cases; found ${EVAL_CASES.length}.`);
  if (options.provider === "openai" && !process.env.OPENAI_API_KEY) throw new Error("OpenAI mode requires OPENAI_API_KEY in the environment; no key value is read from CLI arguments.");

  const inputRate = readRate("LLM_INPUT_COST_PER_MILLION_USD", 0.10);
  const outputRate = readRate("LLM_OUTPUT_COST_PER_MILLION_USD", 0.50);
  process.env.LLM_PROVIDER = options.provider;
  process.env.LLM_ENABLED = "true";
  process.env.OPENAI_MODEL = options.model;
  process.env.LLM_MAX_OUTPUT_TOKENS = String(MAX_OUTPUT_TOKENS_PER_CASE);
  process.env.LLM_CONVERSATION_MAX_TOKENS = "20000";
  process.env.LLM_INPUT_COST_PER_MILLION_USD = String(inputRate);
  process.env.LLM_OUTPUT_COST_PER_MILLION_USD = String(outputRate);

  const client = new LlmClient();
  const results: EvalResult[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let stoppedByCap = false;

  console.log(`Starting ${EVAL_CASES.length} cases; provider=${options.provider}, model=${options.model}, hard cap=$${options.maxUsd.toFixed(4)} and ${options.maxTokens} tokens.`);
  for (const testCase of EVAL_CASES) {
    const systemPrompt = buildSystemPrompt({
      userProfile: { persona: testCase.persona, purposes: [testCase.note], topic: "بيانات عامة للبحث والتحليل" },
      sanitizedCapabilities: capabilities,
      todayDate: "2026-10-10",
      userBalancePoints: 500,
      conversationState: { isFirstUserTurn: true },
    });
    const visiblePrompt = `${systemPrompt}\n${testCase.prompt}`;
    if (unsafePromptOrOutput(visiblePrompt)) {
      throw new Error(`Prompt sanitization invariant failed for case ${testCase.id}.`);
    }
    // Any BPE token is at least one byte; this upper bound reserves room for the schema and request wrapper.
    const inputTokenUpperBound = Buffer.byteLength(visiblePrompt, "utf8") + INPUT_SCHEMA_OVERHEAD_BYTES;
    const caseTokenUpperBound = inputTokenUpperBound + MAX_OUTPUT_TOKENS_PER_CASE;
    const caseCostUpperBound = (inputTokenUpperBound * inputRate + MAX_OUTPUT_TOKENS_PER_CASE * outputRate) / 1_000_000;
    if (totalInputTokens + totalOutputTokens + caseTokenUpperBound > options.maxTokens
      || totalCostUsd + caseCostUpperBound > options.maxUsd) {
      stoppedByCap = true;
      console.log(`Stopped before case ${testCase.id}: its conservative upper bound would exceed a hard cap.`);
      break;
    }

    const result = await client.executeTurn({
      messages: [{ role: "user", content: testCase.prompt }],
      sanitizedCapabilities: capabilities,
      userProfile: { persona: testCase.persona, purposes: [testCase.note], topic: "بيانات عامة للبحث والتحليل" },
      conversationId: `eval-${testCase.id}`,
      userId: "local-evaluation",
    });
    const text = JSON.stringify(result.output);
    if (unsafePromptOrOutput(text)) throw new Error(`Output sanitization invariant failed for case ${testCase.id}.`);

    const passed = expectedPass(testCase, result.output);
    const requestedQuestions = questionsAsked(result.output);
    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
    totalCostUsd += result.costUsd;
    if (totalCostUsd > options.maxUsd || totalInputTokens + totalOutputTokens > options.maxTokens) {
      throw new Error("A reported usage value exceeded a hard cap; stopping immediately.");
    }
    results.push({
      id: testCase.id,
      category: testCase.category,
      persona: testCase.persona,
      prompt: testCase.prompt,
      expected: testCase.expectedTypes.join(" | "),
      actual: result.output.type,
      questionsAsked: requestedQuestions,
      passed,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      note: testCase.note,
    });
    console.log(`Case ${String(testCase.id).padStart(2, "0")}/60 ${passed ? "PASS" : "FAIL"}: ${testCase.category} — ${result.output.type}`);
  }

  const passedCount = results.filter((result) => result.passed).length;
  const table = [
    "| # | المجموعة | المتوقع | الفعلي | السؤال/الأسئلة التي طرحها المساعد | النتيجة |",
    "|---:|---|---|---|---|---|",
    ...results.map((result) => `| ${result.id} | ${result.category} | ${result.expected} | ${result.actual} | ${result.questionsAsked.join(" / ") || "—"} | ${result.passed ? "ناجح" : "يحتاج مراجعة"} |`),
  ].join("\n");
  console.log(`\nنتائج الحالات: ${results.length}/60؛ المطابق: ${passedCount}؛ غير المطابق: ${results.length - passedCount}${stoppedByCap ? "؛ توقف آمن عند حد الإنفاق/الرموز" : ""}`);
  console.log(`الاستخدام المسجل: ${totalInputTokens + totalOutputTokens} رمزاً، بإجمالي داخلي $${totalCostUsd.toFixed(6)}.`);
  console.log(`\nجدول المقارنة والأسئلة المطروحة:\n${table}`);

  const reportPath = resolve(process.cwd(), "scripts/eval_report.json");
  writeFileSync(reportPath, JSON.stringify({
    provider: options.provider,
    model: options.model,
    maxUsd: options.maxUsd,
    maxTokens: options.maxTokens,
    stoppedByCap,
    summary: { total: results.length, passed: passedCount, failed: results.length - passedCount, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd: totalCostUsd },
    comparisonMarkdown: table,
    results,
  }, null, 2));
  console.log(`Saved report: ${reportPath}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/eval-real-model.ts") || process.argv[1]?.endsWith("eval-real-model.ts")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown_error";
    console.error(`Evaluation stopped safely: ${message}`);
    process.exitCode = 1;
  });
}
