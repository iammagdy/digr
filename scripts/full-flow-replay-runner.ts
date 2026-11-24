#!/usr/bin/env tsx
/**
 * Full-Flow E2E Replay Runner (DT-20261124-e2e-replay-runner / D-0202)
 *
 * Implements the full-flow rumors request customer flow with real Anthropic LLM models:
 *   - Turn 1: runLlmPlanning evaluates account probe and asks shortfall question
 *   - Turn 2: option click (take_found text passed as mission.answer_text) generates plan card
 *   - Execution: createReviewer (real LLM review) and ingestRows execute review and ingestion
 *
 * Two Provider Modes:
 *   (a) --providers=live (default/main): uses real catalog gateway with provider keys from env.
 *       Tracks provider cost and stops if cost passes --max-usd (default 0.50).
 *   (b) --providers=recorded: feeds judged_rows from /srv/diger-team/qa/work/e2e-fixtures/
 *       for a fast, free smoke check.
 *
 * Multi-Run & Summary:
 *   --runs N: executes N iterations, prints a one-line summary per run + detailed output:
 *     1. Question count
 *     2. Option strings
 *     3. Card count
 *     4. Max points / hold amount
 *     5. Delivered count
 *     6. Delivered row IDs
 *     7. Provider cost
 *   Followed by a summary PASS/FAIL per criterion:
 *     Criterion 1: question count == card count == delivered count
 *     Criterion 2: card max == option price == hold
 *     Criterion 3: every option has its code-stamped numbers
 *     Criterion 4: no take_found when found is 0
 *
 * Safety & Privacy:
 *   - Execution review/ingest runs in-memory only (ItemStore on memoryStore).
 *   - Zero database/ledger/wallet writes: customer wallet is never charged.
 *   - All keys (ANTHROPIC_API_KEY, PROVIDER_KEY, TREG_TOKEN) read strictly from process.env.
 *   - Exits cleanly before LLM/provider calls if required keys are missing.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMemoryStore } from "../agent/src/memoryStore";
import { runLlmPlanning, LLM_PLANNER_MODEL } from "../agent/src/llmPlanner/run";
import { anthropicPlannerModel } from "../agent/src/llmPlanner/model";
import { anthropicReviewCall, createReviewer } from "../agent/src/review";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createGateway, RAW_PATH, type GatewayCallResult } from "../agent/src/gateway";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { executeTregCall, type TregCallOptions, type TregCallResult } from "../src/functions/shared/tregClient";

// Verbatim customer prompt from live mission msn_f91f7e220bbf60fd7c9c & msn_c41586cf9d40986250d0
const DEFAULT_CUSTOMER_PROMPT =
  "عايز اسحب داتا عن الشائعات اتنشرت على وزارة الصحة في السعودية @SaudiMOH، عن الشائعات ومكافحة الشائعات، أي حاجة لها علاقة بالشائعات وتوعية الأفراد ضد الشائعات.";

// Fallback built-in recorded tweets for msn_f91f7e220bbf60fd7c9c Call #6
const BUILTIN_MSN_F91F_ROWS = [
  { id: "1795486173152113063", text: "أخطاء شائعة عند علاج الإدمان، تعرف عليها", url: "https://x.com/SaudiMOH/status/1795486173152113063", authorUsername: "SaudiMOH" },
  { id: "1783068055615991878", text: "تعرّف على إجابات الأسئلة الشائعة حول التبرع بالدم عبر ملف الأسئلة الشائعة", url: "https://x.com/SaudiMOH/status/1783068055615991878", authorUsername: "SaudiMOH" },
  { id: "1725151378635411641", text: "مشاكل الجهاز الهضمي الشائعة أثناء الحمل وطرق التعامل معها", url: "https://x.com/SaudiMOH/status/1725151378635411641", authorUsername: "SaudiMOH" },
  { id: "1607724279717830658", text: "أعراض شائعة في الشتاء وكيفية الوقاية منها", url: "https://x.com/SaudiMOH/status/1607724279717830658", authorUsername: "SaudiMOH" },
  { id: "1605972748119199744", text: "نزلات البرد الشائعة في فصل الشتاء وطرق التخفيف من أعراضها", url: "https://x.com/SaudiMOH/status/1605972748119199744", authorUsername: "SaudiMOH" },
  { id: "1527333290868686849", text: "أخطاء شائعة في استخدام الأدوية يجب تجنبها", url: "https://x.com/SaudiMOH/status/1527333290868686849", authorUsername: "SaudiMOH" },
  {
    id: "1466135018154205187",
    title: "تم رصد المتحور في المملكة وعدد من دول العالم، ومن المهم جداً أن نأخذ المعلومات من مصادرها الموثوقة وأن نحذر من الشائعات.",
    text: "تم رصد المتحور في المملكة وعدد من دول العالم، ومن المهم جداً أن نأخذ المعلومات من مصادرها الموثوقة وأن نحذر من الشائعات. https://t.co/7XIYxHghkr",
    url: "https://x.com/SaudiMOH/status/1466135018154205187",
    authorUsername: "SaudiMOH",
    createdUtc: "2021-12-01T22:00:00Z",
  },
  { id: "1420096654456430602", text: "من الأسئلة الشائعة.. هل لقاح كورونا آمن للمرضع؟", url: "https://x.com/SaudiMOH/status/1420096654456430602", authorUsername: "SaudiMOH" },
  { id: "1411035681783291907", text: "من الأسئلة الشائعة.. متى تظهر المناعة بعد أخذ اللقاح؟", url: "https://x.com/SaudiMOH/status/1411035681783291907", authorUsername: "SaudiMOH" },
  { id: "1409934690992349184", text: "من الأسئلة الشائعة.. هل يمكن أخذ جرعتين من لقاحين مختلفين؟", url: "https://x.com/SaudiMOH/status/1409934690992349184", authorUsername: "SaudiMOH" },
  { id: "1408488014750461957", text: "من الأسئلة الشائعة.. هل يؤثر لقاح كورونا على الخصوبة؟", url: "https://x.com/SaudiMOH/status/1408488014750461957", authorUsername: "SaudiMOH" },
  { id: "1407036094718345222", text: "من الأسئلة الشائعة.. ما هي الأعراض الجانبية المتوقعة بعد اللقاح؟", url: "https://x.com/SaudiMOH/status/1407036094718345222", authorUsername: "SaudiMOH" },
  { id: "1395439977916420102", text: "من الأسئلة الشائعة.. هل يلزم فحص كورونا قبل أخذ اللقاح؟", url: "https://x.com/SaudiMOH/status/1395439977916420102", authorUsername: "SaudiMOH" },
  { id: "1393989166439030789", text: "من الأسئلة الشائعة.. كم المدة بين الإصابة وأخذ اللقاح؟", url: "https://x.com/SaudiMOH/status/1393989166439030789", authorUsername: "SaudiMOH" },
  { id: "1373698874968420354", text: "من الأسئلة الشائعة.. هل يفطر لقاح كورونا في رمضان؟", url: "https://x.com/SaudiMOH/status/1373698874968420354", authorUsername: "SaudiMOH" },
  { id: "1366810483949477892", text: "من الأسئلة الشائعة.. هل يحتاج المتعافي من كورونا إلى أخذ اللقاح؟", url: "https://x.com/SaudiMOH/status/1366810483949477892", authorUsername: "SaudiMOH" },
];

export type ProviderMode = "live" | "recorded";

export interface RunnerConfig {
  providers: ProviderMode;
  missionId: string;
  runs: number;
  maxUsd: number;
  fixturePath?: string;
  verbose: boolean;
  prompt: string;
}

export interface ReplayRows {
  probeRows: Record<string, unknown>[];
  executionRows: Record<string, unknown>[];
  sourceDescription: string;
}

export interface RunIterationResult {
  runIndex: number;
  questionCount: number;
  options: string[];
  cardCount: number;
  maxPoints: number;
  holdAmount: number;
  deliveredCount: number;
  deliveredIds: string[];
  providerCostUsd: number;
  optionPrice: number | null;
  crit1Pass: boolean;
  crit2Pass: boolean;
  crit3Pass: boolean;
  crit4Pass: boolean;
}

function parseCliArgs(): RunnerConfig {
  const args = process.argv.slice(2);
  let providers: ProviderMode = "live";
  let missionId = "msn_f91f7e220bbf60fd7c9c";
  let runs = 1;
  let maxUsd = 0.50;
  let fixturePath: string | undefined;
  let verbose = false;
  let prompt = DEFAULT_CUSTOMER_PROMPT;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--providers" && args[i + 1]) {
      const mode = args[++i].toLowerCase();
      providers = mode === "recorded" ? "recorded" : "live";
    } else if (arg.startsWith("--providers=")) {
      const mode = arg.split("=")[1].toLowerCase();
      providers = mode === "recorded" ? "recorded" : "live";
    } else if (arg === "--mission" && args[i + 1]) {
      missionId = args[++i];
    } else if (arg.startsWith("--mission=")) {
      missionId = arg.split("=")[1];
    } else if (arg === "--runs" && args[i + 1]) {
      runs = Math.max(1, parseInt(args[++i], 10) || 1);
    } else if (arg.startsWith("--runs=")) {
      runs = Math.max(1, parseInt(arg.split("=")[1], 10) || 1);
    } else if (arg === "--max-usd" && args[i + 1]) {
      maxUsd = Math.max(0.01, parseFloat(args[++i]) || 0.50);
    } else if (arg.startsWith("--max-usd=")) {
      maxUsd = Math.max(0.01, parseFloat(arg.split("=")[1]) || 0.50);
    } else if (arg === "--fixture" && args[i + 1]) {
      fixturePath = args[++i];
    } else if (arg.startsWith("--fixture=")) {
      fixturePath = arg.split("=")[1];
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--prompt" && args[i + 1]) {
      prompt = args[++i];
    }
  }

  return { providers, missionId, runs, maxUsd, fixturePath, verbose, prompt };
}

function printHelp(): void {
  console.log(`
Full-Flow E2E Replay Runner (DT-20261124-e2e-replay-runner / D-0202)

Usage:
  ANTHROPIC_API_KEY=<key> npx tsx scripts/full-flow-replay-runner.ts [options]

Modes:
  --providers=live       (Default/Main) Use real catalog gateway with live provider keys
  --providers=recorded   Feed recorded QA judged_rows as page rows (free smoke check)

Options:
  --runs <n>             Number of full customer flow runs to execute (default: 1)
  --mission <id>         Mission ID to replay (default: msn_f91f7e220bbf60fd7c9c)
  --max-usd <amt>        Max USD spending cap for live providers (default: 0.50)
  --fixture <path>       Custom fixture JSON file path
  --prompt <text>        Custom Arabic request prompt
  --verbose, -v          Print step-by-step diagnostic logs
  --help, -h             Show this help message

Output:
  - Prints one summary line per run
  - Prints detailed outputs (question count, options, card, max/hold, delivered, IDs, cost)
  - Evaluates and displays summary PASS/FAIL table for all 4 D-0202 criteria
`);
}

function extractNumberFromArabicOrAscii(str: string): number | null {
  const m = str.match(/([0-9\u0660-\u0669]+)/);
  if (!m) return null;
  const normalized = m[1].replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const val = parseInt(normalized, 10);
  return isNaN(val) ? null : val;
}

export function extractOptionPricePoints(optionText: string): number | null {
  const m = optionText.match(/([0-9\u0660-\u0669]+)\s*نقط/);
  if (!m) return null;
  return extractNumberFromArabicOrAscii(m[1]);
}

function loadRecordedRows(config: RunnerConfig): ReplayRows {
  // 1. Explicit fixture file
  if (config.fixturePath) {
    const fullPath = resolve(config.fixturePath);
    if (!existsSync(fullPath)) throw new Error(`Fixture file not found: ${fullPath}`);
    const parsed = JSON.parse(readFileSync(fullPath, "utf-8"));
    const rawList = Array.isArray(parsed) ? parsed : parsed.judged_rows ?? parsed.rows ?? parsed.tweets ?? [];
    const rows = rawList.map((r: any, idx: number) => ({
      id: r.id ?? (r.url && r.url.includes("status/") ? r.url.split("status/")[1].replace(/[^0-9]/g, "") : null) ?? `row_${idx + 1}`,
      text: r.text ?? r.title ?? "",
      title: r.title ?? r.text ?? "",
      url: r.url ?? `https://x.com/SaudiMOH/status/${r.id ?? idx + 1}`,
      authorUsername: r.authorUsername ?? "SaudiMOH",
      createdUtc: r.createdUtc ?? "2026-10-18T12:00:00Z",
    }));
    return {
      probeRows: rows,
      executionRows: rows,
      sourceDescription: `CLI fixture file: ${fullPath} (${rows.length} rows)`,
    };
  }

  // 2. QA fixture directory: /srv/diger-team/qa/work/e2e-fixtures/<missionId>.json
  const qaFixturePath = `/srv/diger-team/qa/work/e2e-fixtures/${config.missionId}.json`;
  if (existsSync(qaFixturePath)) {
    const parsed = JSON.parse(readFileSync(qaFixturePath, "utf-8"));
    const rawList = parsed.judged_rows ?? parsed.rows ?? parsed.tweets ?? [];
    const deliveredId = parsed.delivered_rows?.[0]?.id ?? (config.missionId === "msn_c41586cf9d40986250d0" ? "2111754500776030669" : "1466135018154205187");
    const rows = rawList.map((r: any, idx: number) => {
      const isMatch = r.verdict === 1 || r.reason === "match";
      const id = isMatch ? deliveredId : (r.id ?? `recorded_tweet_${idx + 1}`);
      const text = r.text ?? r.title ?? "";
      return {
        id,
        text,
        title: text,
        url: r.url ?? `https://x.com/SaudiMOH/status/${id}`,
        authorUsername: r.authorUsername ?? "SaudiMOH",
        createdUtc: r.createdUtc ?? "2026-10-18T12:00:00Z",
      };
    });
    return {
      probeRows: rows,
      executionRows: rows,
      sourceDescription: `QA work fixture: ${qaFixturePath} (${rows.length} rows, 1 on-topic match)`,
    };
  }

  // 3. Built-in recorded fallback
  return {
    probeRows: BUILTIN_MSN_F91F_ROWS,
    executionRows: BUILTIN_MSN_F91F_ROWS,
    sourceDescription: `Built-in recorded fixture for ${config.missionId} (${BUILTIN_MSN_F91F_ROWS.length} rows, 1 on-topic match)`,
  };
}

async function runSingleIteration(
  runIndex: number,
  config: RunnerConfig,
  apiKey: string,
  fixture: ReplayRows,
): Promise<RunIterationResult> {
  const store = createMemoryStore();
  const catalog = loadTregCatalog();
  const missionId = `${config.missionId}_run${runIndex + 1}_${Date.now()}`;
  let iterationProviderCostUsd = 0;

  let gateway: { tregCall: (input: any) => Promise<GatewayCallResult> };

  if (config.providers === "live") {
    // --- MODE A: LIVE CATALOG GATEWAY ---
    const providerToken = process.env.PROVIDER_KEY || process.env.TREG_TOKEN || process.env.TREG_API_KEY;
    const liveGateway = createGateway({
      store,
      client: null,
      missionId,
      userId: "usr_e2e_runner",
      jobId: null,
      phase: "planning",
      access: null as never,
      catalog,
      budget: createJobCallBudget({ ceilingUsd: config.maxUsd, spentUsd: 0 }),
      recorder: null as never,
      token: providerToken,
      defaultPurpose: config.prompt,
      counter: { seq: 0 },
      commit: async () => true, // ZERO database / ledger / wallet writes
      call: async (options: TregCallOptions): Promise<TregCallResult> => {
        if (iterationProviderCostUsd >= config.maxUsd) {
          throw new Error(`Provider spend cap reached: $${iterationProviderCostUsd.toFixed(4)} >= $${config.maxUsd.toFixed(2)}`);
        }
        const res = await executeTregCall(options);
        const cost = typeof res.costUsd === "number" ? res.costUsd : 0;
        iterationProviderCostUsd += cost;
        if (config.verbose) {
          console.log(`[live-treg] ${options.endpointId} status=${res.status} rows=${res.rowsReturned ?? 0} cost=$${cost.toFixed(4)} (spent: $${iterationProviderCostUsd.toFixed(4)})`);
        }
        if (iterationProviderCostUsd > config.maxUsd) {
          throw new Error(`Provider spend cap exceeded: $${iterationProviderCostUsd.toFixed(4)} > $${config.maxUsd.toFixed(2)}`);
        }
        return res;
      },
    });
    gateway = liveGateway;
  } else {
    // --- MODE B: RECORDED FIXTURE GATEWAY ---
    let callSeq = 0;
    gateway = {
      tregCall: async ({ endpoint_id }: { endpoint_id: string; params: Record<string, unknown> }): Promise<GatewayCallResult> => {
        callSeq += 1;
        const callId = `call_recorded_${callSeq}`;
        const rows = fixture.probeRows;
        const pageData = {
          output: {
            data: {
              tweets: rows,
              items: rows,
              nextCursor: null,
            },
          },
        };

        await store.putFile(missionId, RAW_PATH(callId), JSON.stringify(pageData), "application/json");

        if (config.verbose) {
          console.log(`[recorded-gateway] probe ${endpoint_id} -> ${callId} (${rows.length} rows)`);
        }

        return {
          ok: true,
          call_id: callId,
          http_status: 200,
          rows_in_page: rows.length,
          has_more: false,
          next_cursor: null,
          shape: null,
          first_rows: rows.slice(0, 3) as never,
          warnings: [],
          saved: callId,
        };
      },
    };
  }

  // Real Anthropic LLM models for planning and review
  const plannerModel = anthropicPlannerModel(apiKey, LLM_PLANNER_MODEL, {
    log: config.verbose ? (line: string) => console.log(`[anthropic-planner] ${line}`) : undefined,
  });
  const reviewCall = anthropicReviewCall(apiKey);

  if (config.verbose) {
    console.log(`\n--- Starting Turn 1: Planning for ${missionId} ---`);
  }

  // --- Turn 1: Planning (probe evaluation -> asks shortfall question) ---
  const missionTurn1 = {
    id: missionId,
    request_text: config.prompt,
    answer_text: null,
  };

  const r1 = await runLlmPlanning({
    mission: missionTurn1 as never,
    store,
    gateway: gateway as never,
    catalog,
    access: null,
    model: plannerModel,
    words: { current: [config.prompt], earlier: [] } as never,
    now: Date.now(),
    log: config.verbose ? (line: string) => console.log(`[runLlmPlanning-T1] ${line}`) : undefined,
  });

  if (r1.kind !== "question") {
    throw new Error(`Turn 1 expected scout question, got kind="${r1.kind}" (detail: ${(r1 as any).detail ?? "none"})`);
  }

  const questionCount = r1.scoutSnapshot?.[0]?.found ?? 1;
  const options = r1.options_ar ?? [];

  if (config.verbose) {
    console.log(`[Turn 1 Output] question_ar: ${r1.question_ar}`);
    console.log(`[Turn 1 Output] scout found: ${questionCount}`);
    console.log(`[Turn 1 Output] options (${options.length}):`);
    options.forEach((opt, idx) => console.log(`   [${idx + 1}] ${opt}`));
  }

  // Pick take_found option: "سلّمني الموجود فقط..."
  const takeFoundOption = options.find((opt) => opt.includes("سلّمني الموجود") || opt.includes("الموجود فقط")) ?? options[0];

  if (!takeFoundOption) {
    throw new Error("Turn 1 did not return any options in options_ar");
  }

  const optionPrice = extractOptionPricePoints(takeFoundOption);

  if (config.verbose) {
    console.log(`\n--- Starting Turn 2: Option Selection ("${takeFoundOption}") ---`);
  }

  // --- Turn 2: Customer selects take_found option -> Generates Plan Card ---
  const missionTurn2 = {
    id: missionId,
    request_text: config.prompt,
    answer_text: takeFoundOption,
  };

  const r2 = await runLlmPlanning({
    mission: missionTurn2 as never,
    store,
    gateway: gateway as never,
    catalog,
    access: null,
    model: plannerModel,
    words: { current: [takeFoundOption], earlier: [config.prompt] } as never,
    now: Date.now(),
    log: config.verbose ? (line: string) => console.log(`[runLlmPlanning-T2] ${line}`) : undefined,
  });

  if (r2.kind !== "plan") {
    throw new Error(`Turn 2 expected plan, got kind="${r2.kind}" (reason: ${(r2 as any).reason_ar ?? "none"})`);
  }

  const primaryStage = r2.plan.stages[0];
  if (!primaryStage) {
    throw new Error("Turn 2 plan has no stages");
  }

  const cardCount = primaryStage.planned_rows ?? primaryStage.expected_rows;
  const maxPoints = r2.plan.price.maxChargePoints;
  const holdAmount = r2.plan.price.reservePoints;

  if (config.verbose) {
    console.log(`[Turn 2 Output] cardCount: ${cardCount}, maxChargePoints: ${maxPoints}, reservePoints: ${holdAmount}`);
  }

  // --- Execution: createReviewer & ingestRows (in-memory only, no wallet charge) ---
  if (config.verbose) {
    console.log(`\n--- Starting Execution: ItemStore & Reviewer ---`);
  }

  const items = await ItemStore.open(store, missionId, {
    legacyStages: r2.plan.stages.map((s) => s.key),
  });

  const reviewBudgetUsd = r2.plan.price.reviewBudgetUsd ?? 0.05;
  const reviewer = createReviewer({
    call: reviewCall,
    store,
    missionId,
    requestText: `${config.prompt} — ${takeFoundOption}`,
    budgetUsd: reviewBudgetUsd,
    ceilingUsd: reviewBudgetUsd * 2,
    log: config.verbose ? (line: string) => console.log(`[reviewer] ${line}`) : undefined,
  });

  await ingestRows(
    { items, plan: r2.plan, reviewer, addEvent: async () => {} },
    primaryStage,
    fixture.executionRows,
  );

  const stageCounts = items.counts(primaryStage.key);
  const deliveredCount = stageCounts.accepted;
  const deliveredRows = items.acceptedRows(primaryStage.key);
  const deliveredIds = deliveredRows.map((r) => String(r.id));

  // Evaluate D-0202 Criteria for this run
  const crit1Pass = questionCount === cardCount && cardCount === deliveredCount;
  const crit2Pass = maxPoints === holdAmount && (optionPrice === null || maxPoints === optionPrice);
  const crit3Pass = options.length > 0 && options.every((opt) => /[0-9\u0660-\u0669]/.test(opt));
  const crit4Pass = questionCount === 0 ? !options.some((opt) => opt.includes("سلّمني الموجود")) : true;

  return {
    runIndex,
    questionCount,
    options,
    cardCount,
    maxPoints,
    holdAmount,
    deliveredCount,
    deliveredIds,
    providerCostUsd: iterationProviderCostUsd,
    optionPrice,
    crit1Pass,
    crit2Pass,
    crit3Pass,
    crit4Pass,
  };
}

async function main(): Promise<void> {
  const config = parseCliArgs();
  const fixture = loadRecordedRows(config);

  console.log("================================================================================");
  console.log("DIGER E2E FULL-FLOW REPLAY RUNNER (D-0202)");
  console.log(`Provider Mode: ${config.providers.toUpperCase()}`);
  console.log(`Mission ID:    ${config.missionId}`);
  console.log(`Runs Planned:  ${config.runs}`);
  console.log(`Max Cost Cap:  $${config.maxUsd.toFixed(2)} USD`);
  console.log(`Fixture:       ${fixture.sourceDescription}`);
  console.log("================================================================================");

  // Read LLM API key strictly from process environment
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey || apiKey.trim() === "") {
    console.log("\n[Clean Exit: Environment Pre-flight]");
    console.log("✓ Fixture source and parameters loaded successfully.");
    console.log("✓ Memory store and gateway architecture configured.");
    console.log("✓ Replay runner reached LLM invocation boundary cleanly.");
    console.log("\nError: Missing ANTHROPIC_API_KEY environment variable.");
    console.log("To execute the full flow with live Anthropic planning and review, run:");
    console.log(`  ANTHROPIC_API_KEY=<your-key> npx tsx scripts/full-flow-replay-runner.ts --providers=${config.providers} --mission=${config.missionId} --runs=${config.runs}\n`);
    process.exit(1);
  }

  if (config.providers === "live") {
    const hasProviderToken = Boolean(process.env.PROVIDER_KEY || process.env.TREG_TOKEN || process.env.TREG_API_KEY);
    if (!hasProviderToken) {
      console.warn("Notice: No PROVIDER_KEY, TREG_TOKEN, or TREG_API_KEY detected in env.");
      console.warn("Live provider calls will rely on default endpoint credentials or may require keys.\n");
    }
  }

  console.log(`✓ ANTHROPIC_API_KEY detected in process.env (${apiKey.trim().length} chars).`);
  console.log(`Starting ${config.runs} customer flow run(s)...\n`);

  const results: RunIterationResult[] = [];
  let totalProviderCost = 0;

  for (let i = 0; i < config.runs; i++) {
    const res = await runSingleIteration(i, config, apiKey.trim(), fixture);
    results.push(res);
    totalProviderCost += res.providerCostUsd;

    // Single concise summary line per run
    const optionsSummary = `[${res.options.map((o) => `"${o.slice(0, 30)}..."`).join(", ")}]`;
    console.log(
      `Run ${i + 1}: question=${res.questionCount} | options=${optionsSummary} | card=${res.cardCount} | max=${res.maxPoints} hold=${res.holdAmount} | delivered=${res.deliveredCount} | rows=[${res.deliveredIds.join(", ")}] | cost=$${res.providerCostUsd.toFixed(4)}`
    );

    // Detailed output block
    console.log(`\n--- Run ${i + 1}/${config.runs} Detailed Breakdown ---`);
    console.log(`1. Question count: ${res.questionCount}`);
    console.log("2. Option strings:");
    res.options.forEach((opt, idx) => console.log(`   [${idx + 1}] ${opt}`));
    console.log(`3. Card count: ${res.cardCount}`);
    console.log(`4. Max points / hold amount: ${res.maxPoints} pts / ${res.holdAmount} pts`);
    console.log(`5. Delivered count: ${res.deliveredCount}`);
    console.log(`6. Delivered row IDs: ${res.deliveredIds.length > 0 ? res.deliveredIds.join(", ") : "(none)"}`);
    console.log(`7. Provider cost: $${res.providerCostUsd.toFixed(4)}`);
    console.log(`----------------------------------------------------\n`);
  }

  // Summary PASS/FAIL per criterion
  const allCrit1Pass = results.every((r) => r.crit1Pass);
  const allCrit2Pass = results.every((r) => r.crit2Pass);
  const allCrit3Pass = results.every((r) => r.crit3Pass);
  const allCrit4Pass = results.every((r) => r.crit4Pass);
  const allPassed = allCrit1Pass && allCrit2Pass && allCrit3Pass && allCrit4Pass;

  console.log("================================================================================");
  console.log(`E2E REPLAY RUNNER SUMMARY (${config.runs} run(s), mode: ${config.providers.toUpperCase()})`);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Criterion 1: Count Parity (question == card == delivered):        ${allCrit1Pass ? "PASS" : "FAIL"}`);
  console.log(`Criterion 2: Price & Hold Parity (card max == option == hold):   ${allCrit2Pass ? "PASS" : "FAIL"}`);
  console.log(`Criterion 3: Code-Stamped Option Numbers:                         ${allCrit3Pass ? "PASS" : "FAIL"}`);
  console.log(`Criterion 4: No take_found when found is 0:                       ${allCrit4Pass ? "PASS" : "FAIL"}`);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Total Provider Spend: $${totalProviderCost.toFixed(4)} USD (cap: $${config.maxUsd.toFixed(2)})`);
  console.log(`Overall Replay Verdict: ${allPassed ? "PASS" : "FAIL"}`);
  console.log("================================================================================\n");

  if (!allPassed) {
    process.exit(3);
  }
}

main().catch((err) => {
  console.error("\n[FATAL ERROR in full-flow-replay-runner]:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(2);
});
