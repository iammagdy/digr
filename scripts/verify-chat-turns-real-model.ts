import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { openPlanFactsOf } from "../src/lib/agentMission/openPlanFacts";
import { decideTurn, type OpenRequest } from "../src/lib/agentMission/conversationModel";
import { accountAnswerAr, TRUST_REPLY_AR } from "../src/lib/agentMission/guardRules";

interface ParsedArgs {
  fixturePath: string;
  logPath: string | null;
  runs: number;
}

function parseArgs(args: string[]): ParsedArgs {
  let fixturePath = "tests/fixtures/plan-ready-cfc0.json";
  let logPath: string | null = null;
  let runs = 5;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--fixture" && i + 1 < args.length) {
      fixturePath = args[++i];
    } else if (a.startsWith("--fixture=")) {
      fixturePath = a.slice("--fixture=".length);
    } else if (a === "--log" && i + 1 < args.length) {
      logPath = args[++i];
    } else if (a.startsWith("--log=")) {
      logPath = a.slice("--log=".length);
    } else if (a === "--runs" && i + 1 < args.length) {
      runs = parseInt(args[++i], 10) || 5;
    } else if (a.startsWith("--runs=")) {
      runs = parseInt(a.slice("--runs=".length), 10) || 5;
    }
  }

  return { fixturePath, logPath, runs };
}

interface TurnTestCase {
  id: number;
  name: string;
  text: string;
  isOpenPlan: boolean;
  verify: (decision: any) => { pass: boolean; details: string };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startTime = new Date().toISOString();

  let headSha = "unknown";
  try {
    headSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    // fallback
  }

  const modelId = process.env.LLM_CHAT_MODEL || process.env.LLM_PLANNER_MODEL || "claude-haiku-5-5";

  const resolvedFixture = path.resolve(process.cwd(), args.fixturePath);
  if (!fs.existsSync(resolvedFixture)) {
    console.error(`Fixture not found: ${resolvedFixture}`);
    process.exit(1);
  }

  const fixture = JSON.parse(fs.readFileSync(resolvedFixture, "utf8"));
  const facts = openPlanFactsOf(fixture);
  if (!facts) {
    console.error("Failed to parse openPlanFactsOf from fixture");
    process.exit(1);
  }

  const openPlan: OpenRequest = {
    id: fixture.id ?? "msn_cfc0152ed9b2365172eb",
    state: "plan_ready",
    status: fixture.status ?? "plan_ready",
    requestText: fixture.request_text ?? "",
    questionAr: fixture.question_ar ?? null,
    facts,
  };

  const testCases: TurnTestCase[] = [
    {
      id: 1,
      name: "Price facts question",
      text: "طب التكلفة دي شاملة إيه بالظبط؟",
      isOpenPlan: true,
      verify: (d) => {
        const typeMatch = d.type === "open_request_question";
        const reply = typeof d.reply === "string" ? d.reply : "";
        const containsPriceFacts =
          reply.includes("نقطة") ||
          reply.includes("سعر") ||
          reply.includes("خصم") ||
          reply.includes("٢٠٠") ||
          reply.includes("٤٣٤") ||
          reply.includes("التكلفة");
        return {
          pass: typeMatch && containsPriceFacts,
          details: `type=${d.type}, priceFacts=${containsPriceFacts}`,
        };
      },
    },
    {
      id: 2,
      name: "Columns question",
      text: "إيه الأعمدة اللي هتكون في الملف؟",
      isOpenPlan: true,
      verify: (d) => {
        const typeMatch = d.type === "open_request_question";
        const reply = typeof d.reply === "string" ? d.reply : "";
        const containsColumns =
          reply.includes("العنوان") ||
          reply.includes("الرابط") ||
          reply.includes("النص") ||
          reply.includes("فيديو") ||
          reply.includes("أعمدة") ||
          reply.includes("المشاهدات") ||
          reply.includes("عمود");
        return {
          pass: typeMatch && containsColumns,
          details: `type=${d.type}, columnsNamed=${containsColumns}`,
        };
      },
    },
    {
      id: 3,
      name: "Explicit cancel Arabic",
      text: "طب لو سمحت كنسل الطلب ده خالص",
      isOpenPlan: true,
      verify: (d) => ({
        pass: d.type === "cancel_open_request",
        details: `type=${d.type}`,
      }),
    },
    {
      id: 4,
      name: "Explicit cancel English",
      text: "cancel this request please",
      isOpenPlan: true,
      verify: (d) => ({
        pass: d.type === "cancel_open_request",
        details: `type=${d.type}`,
      }),
    },
    {
      id: 5,
      name: "Flight cancellation data request counter-case",
      text: "عايز تغريدات عن إلغاء الرحلات الجوية وسعر التذاكر في السعودية",
      isOpenPlan: true,
      verify: (d) => ({
        pass: d.type === "data_request",
        details: `type=${d.type}`,
      }),
    },
    {
      id: 6,
      name: "Account question (password)",
      text: "كيف أغير كلمة المرور؟",
      isOpenPlan: true,
      verify: (d) => ({
        pass: d.type === "account_question" && d.reply === accountAnswerAr("password"),
        details: `type=${d.type}, replyMatched=${d.reply === accountAnswerAr("password")}`,
      }),
    },
    {
      id: 7,
      name: "Trust question",
      text: "الموقع ده نصب ولا حقيقي وفلوسي مضمونة؟",
      isOpenPlan: true,
      verify: (d) => ({
        pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR,
        details: `type=${d.type}, replyMatched=${d.reply === TRUST_REPLY_AR}`,
      }),
    },
    {
      id: 8,
      name: "Account counter-case (MOH handle request)",
      text: "عايز تغريدات حساب وزارة الصحة",
      isOpenPlan: true,
      verify: (d) => ({
        pass: d.type === "data_request",
        details: `type=${d.type}`,
      }),
    },
  ];

  const logLines: string[] = [];
  function log(msg: string) {
    console.log(msg);
    logLines.push(msg);
  }

  log(`HEAD_SHA: ${headSha}`);
  log(`LLM_PLANNER_MODEL: ${modelId}`);
  log(`UTC_START: ${startTime}`);
  log(`RUNS: ${args.runs}`);
  log(`FIXTURE: ${args.fixturePath}`);
  log("");

  let allPass = true;

  for (let loop = 1; loop <= args.runs; loop++) {
    log(`--- Loop ${loop}/${args.runs} ---`);
    for (const tc of testCases) {
      const decision = await decideTurn({
        message: tc.text,
        balancePoints: 1000,
        open: tc.isOpenPlan ? openPlan : null,
      });

      const res = tc.verify(decision);
      const statusIcon = res.pass ? "PASS" : "FAIL";
      if (!res.pass) allPass = false;

      log(`[Loop ${loop}/${args.runs} | Turn ${tc.id}/8: ${tc.name}] status=${statusIcon} (${res.details})`);
      if (!res.pass) {
        log(`  > Input: «${tc.text}»`);
        log(`  > Output: type=${decision.type}, source=${decision.source}, guarded=${decision.guarded}`);
        log(`  > Reply: ${decision.reply ? `«${decision.reply.slice(0, 100)}...»` : "null"}`);
      }
    }
    log("");
  }

  const endTime = new Date().toISOString();
  log(`UTC_END: ${endTime}`);
  log(`OVERALL_RESULT: ${allPass ? "PASS (5/5)" : "FAIL"}`);

  if (args.logPath) {
    const resolvedLog = path.resolve(process.cwd(), args.logPath);
    fs.mkdirSync(path.dirname(resolvedLog), { recursive: true });
    fs.writeFileSync(resolvedLog, logLines.join("\n") + "\n", "utf8");
    console.log(`Log written to: ${resolvedLog}`);
  }

  if (!allPass) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error in verify-chat-turns-real-model:", err);
  process.exit(1);
});
