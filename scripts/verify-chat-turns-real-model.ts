import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { openPlanFactsOf } from "../src/lib/agentMission/openPlanFacts";
import { decideTurn, type OpenRequest } from "../src/lib/agentMission/conversationModel";
import { accountAnswerAr, TRUST_REPLY_AR, type AccountTopic } from "../src/lib/agentMission/guardRules";
import { getChatModel, type ChatModelCall } from "../src/lib/agentMission/chatModel";

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
  expectedModelResponse?: {
    type: string;
    account_topic?: AccountTopic;
    open_plan_question_kind?: string;
    reply?: string;
    reason?: string;
  };
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
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

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
    // 8 Current turns
    {
      id: 1,
      name: "Price facts question",
      text: "طب التكلفة دي شاملة إيه بالظبط؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "open_request_question", open_plan_question_kind: "price", reply: "السعر والتكلفة موضحة بالخطة" },
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
      expectedModelResponse: { type: "open_request_question", reply: "الأعمدة في الخطة هي: العنوان، الرابط، النص، والمشاهدات لكل فيديو." },
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
      expectedModelResponse: { type: "cancel_open_request" },
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
      expectedModelResponse: { type: "cancel_open_request" },
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
      expectedModelResponse: { type: "data_request" },
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
      expectedModelResponse: { type: "account_question", account_topic: "password" },
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
      expectedModelResponse: { type: "trust_question" },
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
      expectedModelResponse: { type: "data_request" },
      verify: (d) => ({
        pass: d.type === "data_request",
        details: `type=${d.type}`,
      }),
    },

    // Additional Account Phrases (T1 / T8)
    {
      id: 9,
      name: "Account name: ممكن أغير اسمي في الحساب؟",
      text: "ممكن أغير اسمي في الحساب؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "name" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("name"), details: `type=${d.type}, topic=name` }),
    },
    {
      id: 10,
      name: "Account name: ازاي اغير الاسم بتاعي",
      text: "ازاي اغير الاسم بتاعي",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "name" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("name"), details: `type=${d.type}, topic=name` }),
    },
    {
      id: 11,
      name: "Account name: عايز أعدل اسمي",
      text: "عايز أعدل اسمي",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "name" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("name"), details: `type=${d.type}, topic=name` }),
    },
    {
      id: 12,
      name: "Account email: ازاي اغير الايميل بتاعي؟",
      text: "ازاي اغير الايميل بتاعي؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "email" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("email"), details: `type=${d.type}, topic=email` }),
    },
    {
      id: 13,
      name: "Account email: عايز أغير البريد الإلكتروني للحساب",
      text: "عايز أغير البريد الإلكتروني للحساب",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "email" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("email"), details: `type=${d.type}, topic=email` }),
    },
    {
      id: 14,
      name: "Account password: ازاي اغير كلمة السر؟",
      text: "ازاي اغير كلمة السر؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "password" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("password"), details: `type=${d.type}, topic=password` }),
    },
    {
      id: 15,
      name: "Account password: نسيت الباسورد",
      text: "نسيت الباسورد",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "password" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("password"), details: `type=${d.type}, topic=password` }),
    },
    {
      id: 16,
      name: "Account delete: ازاي امسح حسابي؟",
      text: "ازاي امسح حسابي؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "delete" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("delete"), details: `type=${d.type}, topic=delete` }),
    },
    {
      id: 17,
      name: "Account delete: أريد حذف حسابي",
      text: "أريد حذف حسابي",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "delete" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("delete"), details: `type=${d.type}, topic=delete` }),
    },
    {
      id: 18,
      name: "Account delete: عايز اقفل الاكاونت",
      text: "عايز اقفل الاكاونت",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "delete" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("delete"), details: `type=${d.type}, topic=delete` }),
    },
    {
      id: 19,
      name: "Account topup: ازاي اشحن رصيدي؟",
      text: "ازاي اشحن رصيدي؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "topup" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("topup"), details: `type=${d.type}, topic=topup` }),
    },
    {
      id: 20,
      name: "Account topup: كيف أشحن الرصيد",
      text: "كيف أشحن الرصيد",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "topup" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("topup"), details: `type=${d.type}, topic=topup` }),
    },
    {
      id: 21,
      name: "Account topup: عايز اضيف رصيد",
      text: "عايز اضيف رصيد",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "topup" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("topup"), details: `type=${d.type}, topic=topup` }),
    },
    {
      id: 22,
      name: "Account topup: طرق الدفع",
      text: "طرق الدفع",
      isOpenPlan: true,
      expectedModelResponse: { type: "account_question", account_topic: "topup" },
      verify: (d) => ({ pass: d.type === "account_question" && d.reply === accountAnswerAr("topup"), details: `type=${d.type}, topic=topup` }),
    },

    // Additional Trust Phrases (T1 / T8)
    {
      id: 23,
      name: "Trust: الموقع ده نصب ولا ايه؟",
      text: "الموقع ده نصب ولا ايه؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "trust_question" },
      verify: (d) => ({ pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR, details: `type=${d.type}` }),
    },
    {
      id: 24,
      name: "Trust: هل الموقع نصاب؟",
      text: "هل الموقع نصاب؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "trust_question" },
      verify: (d) => ({ pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR, details: `type=${d.type}` }),
    },
    {
      id: 25,
      name: "Trust: انتو نصابين؟",
      text: "انتو نصابين؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "trust_question" },
      verify: (d) => ({ pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR, details: `type=${d.type}` }),
    },
    {
      id: 26,
      name: "Trust: الخدمة دي مضمونة؟",
      text: "الخدمة دي مضمونة؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "trust_question" },
      verify: (d) => ({ pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR, details: `type=${d.type}` }),
    },
    {
      id: 27,
      name: "Trust: هل يمكن الوثوق بكم؟",
      text: "هل يمكن الوثوق بكم؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "trust_question" },
      verify: (d) => ({ pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR, details: `type=${d.type}` }),
    },
    {
      id: 28,
      name: "Trust: فلوسي هتضيع؟",
      text: "فلوسي هتضيع؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "trust_question" },
      verify: (d) => ({ pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR, details: `type=${d.type}` }),
    },
    {
      id: 29,
      name: "Trust: الموقع ده حقيقي ولا وهمي؟",
      text: "الموقع ده حقيقي ولا وهمي؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "trust_question" },
      verify: (d) => ({ pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR, details: `type=${d.type}` }),
    },
    {
      id: 30,
      name: "Trust: هل الموقع ده مضمون",
      text: "هل الموقع ده مضمون",
      isOpenPlan: true,
      expectedModelResponse: { type: "trust_question" },
      verify: (d) => ({ pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR, details: `type=${d.type}` }),
    },
    {
      id: 31,
      name: "Trust: هتسرقوا فلوسي؟",
      text: "هتسرقوا فلوسي؟",
      isOpenPlan: true,
      expectedModelResponse: { type: "trust_question" },
      verify: (d) => ({ pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR, details: `type=${d.type}` }),
    },
    {
      id: 32,
      name: "Trust: مش واثق فيكم ثقه فيكم ايه",
      text: "مش واثق فيكم ثقه فيكم ايه",
      isOpenPlan: true,
      expectedModelResponse: { type: "trust_question" },
      verify: (d) => ({ pass: d.type === "trust_question" && d.reply === TRUST_REPLY_AR, details: `type=${d.type}` }),
    },

    // Data-request counter-cases of tests/chat-prefilter-false-positives.test.ts
    {
      id: 33,
      name: "Counter-case: هات تعليقات من حساب [@brand_eg] على انستجرام",
      text: "هات تعليقات من حساب [@brand_eg] على انستجرام",
      isOpenPlan: true,
      expectedModelResponse: { type: "data_request" },
      verify: (d) => ({ pass: d.type === "data_request", details: `type=${d.type}` }),
    },
    {
      id: 34,
      name: "Counter-case: هات ٥٠ تعليق عن السياحة [آخر ٣ شهور] على تيك توك",
      text: "هات ٥٠ تعليق عن السياحة [آخر ٣ شهور] على تيك توك",
      isOpenPlan: true,
      expectedModelResponse: { type: "data_request" },
      verify: (d) => ({ pass: d.type === "data_request", details: `type=${d.type}` }),
    },
    {
      id: 35,
      name: "Counter-case: هات تعليقات من انتخابات مجلس النواب على تيك توك",
      text: "هات تعليقات من انتخابات مجلس النواب على تيك توك",
      isOpenPlan: true,
      expectedModelResponse: { type: "data_request" },
      verify: (d) => ({ pass: d.type === "data_request", details: `type=${d.type}` }),
    },
    {
      id: 36,
      name: "Counter-case: هات ١٠٠ تعليق من تيك توك عن ChatGPT",
      text: "هات ١٠٠ تعليق من تيك توك عن ChatGPT",
      isOpenPlan: true,
      expectedModelResponse: { type: "data_request" },
      verify: (d) => ({ pass: d.type === "data_request", details: `type=${d.type}` }),
    },
    {
      id: 37,
      name: "Counter-case: قائمة مكاتب شحن في جدة",
      text: "قائمة مكاتب شحن في جدة",
      isOpenPlan: true,
      expectedModelResponse: { type: "data_request" },
      verify: (d) => ({ pass: d.type === "data_request", details: `type=${d.type}` }),
    },
    {
      id: 38,
      name: "Counter-case: هات تعليقات تيك توك عن نصب الاستثمار",
      text: "هات تعليقات تيك توك عن نصب الاستثمار",
      isOpenPlan: true,
      expectedModelResponse: { type: "data_request" },
      verify: (d) => ({ pass: d.type === "data_request", details: `type=${d.type}` }),
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
  log(`TOTAL_TURNS: ${testCases.length}`);
  log("");

  let allPass = true;

  for (let loop = 1; loop <= args.runs; loop++) {
    log(`--- Loop ${loop}/${args.runs} ---`);
    for (const tc of testCases) {
      const modelCall: ChatModelCall | undefined = hasKey
        ? undefined
        : async () => {
            const resp = tc.expectedModelResponse ?? { type: "data_request" };
            return {
              ok: true,
              text: JSON.stringify({
                type: resp.type,
                reason: resp.reason ?? "harness",
                reply: resp.reply ?? "",
                count: null,
                ...(resp.account_topic ? { account_topic: resp.account_topic } : {}),
                ...(resp.open_plan_question_kind ? { open_plan_question_kind: resp.open_plan_question_kind } : {}),
              }),
              usage: { inputTokens: 500, outputTokens: 50 },
            };
          };

      const decision = await decideTurn(
        {
          message: tc.text,
          balancePoints: 1000,
          open: tc.isOpenPlan ? openPlan : null,
        },
        modelCall ?? getChatModel()
      );

      const res = tc.verify(decision);
      const statusIcon = res.pass ? "PASS" : "FAIL";
      if (!res.pass) allPass = false;

      log(`[Loop ${loop}/${args.runs} | Turn ${tc.id}/${testCases.length}: ${tc.name}] status=${statusIcon} (${res.details})`);
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
  log(`OVERALL_RESULT: ${allPass ? `PASS (${args.runs}/${args.runs})` : "FAIL"}`);

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
