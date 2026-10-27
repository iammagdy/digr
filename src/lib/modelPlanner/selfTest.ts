import { reserveForUnits } from "../recordPricing";
import { loadTregCatalog, type TregCatalog } from "../treg/catalog";
import { SENSITIVE_NOT_VERIFIED_AR, type AccountAccess } from "../treg/dataPolicy";
import { EXPLORATION_REQUEST_CAP_USD } from "./constants";
import { isWindowParamName, resolvedParamValue } from "./paramRules";
import { runPlanner, PLAN_UNAVAILABLE_AR, type PlannerOutcome } from "./planner";
import { plannerCostUsd, type PlannerTransport } from "./transport";
import type { ExplorationDeps } from "./exploration";
import type { SelfTestRow } from "./selfTestCsv";
export { selfTestCsv, type SelfTestRow } from "./selfTestCsv";

/**
 * THE ADMIN PLANNER SELF-TEST («فحص المخطط»). It runs a fixed list of 30 Arabic requests through the REAL planner (the real planning model, the real sample calls) and STOPS before any
 * quote is made: no quote row, no job, no hold, no charge, nothing of a customer is written (the only rows written are the exploration bookkeeping of the sample calls themselves). Each
 * request has an EXPECTED outcome stored with it; the result of a run is a table, and the table is graded PASS or FAIL against that expectation, with the reason.
 *
 * The cost of one run is capped (SELF_TEST_RUN_CAP_USD, the planning model and the sample calls together) and the running total is checked before every request.
 */
export const SELF_TEST_RUN_CAP_USD = 0.30;
/** What one request is assumed to cost the model at most when the next request is started (so the cap is never passed by the request that starts under it). */
export const SELF_TEST_MODEL_RESERVE_USD = 0.01;

export type Expected = "plan" | "question" | "refusal" | "restricted";

export interface SelfTestCase {
  id: string;
  group: "phase0" | "production";
  request: string;
  /** Outcomes that pass (the first is the one the case is about). */
  expect: Expected[];
  /** For a plan: the catalog platform(s) of the chosen endpoint (any of them). */
  platforms?: string[];
  /** For a plan: the plan must carry the country gate of this country. */
  country?: string;
  /** For a plan: no topic review (the customer named ONE thing). */
  noTopic?: boolean;
  note?: string;
}

const P = (n: number, request: string, expect: Expected[], extra: Partial<SelfTestCase> = {}): SelfTestCase => ({ id: `P${n}`, group: "phase0", request, expect, ...extra });
const N = (n: number, request: string, expect: Expected[], extra: Partial<SelfTestCase> = {}): SelfTestCase => ({ id: `N${n}`, group: "production", request, expect, ...extra });

export const SELF_TEST_CASES: readonly SelfTestCase[] = [
  P(1, "عايز ٤٠٠ بوست من حساب وزارة الصحة السعودية على أكس وفيها التعليقات", ["question", "plan"], { note: "the account's handle is not in the words: one question" }),
  P(2, "أبي ٤٠٠ تغريدة من حساب وزارة الصحة السعودية في اكس مع الردود", ["question", "plan"]),
  P(3, "أرغب بجمع ٤٠٠ منشور من حساب وزارة الصحة السعودية على منصة إكس", ["question", "plan"]),
  P(4, "ابغى 400 توتير من حساب وزارة الصحه السعوديه", ["question", "plan"]),
  P(5, "هات اخر ٥٠ تغريده من @SaudiMOH", ["plan"], { platforms: ["x"] }),
  P(6, "٥٠ تغريدة عن كرة القدم في مصر آخر شهر على X", ["plan"], { platforms: ["x"] }),
  P(7, "اكس", ["question"]),
  P(8, "عاوز تعليقات فيديو تيك توك عن الاسعار ٣٠٠ تعليق", ["plan"], { platforms: ["tiktok"] }),
  P(9, "ابي اسماء مدراء شركات الاغذية في الرياض", ["plan", "question", "refusal", "restricted"], { note: "people: a plan, a question or the verified-business sentence are all honest" }),
  P(10, "شركات مقاولات في جدة مع ايميلاتهم", ["plan", "question", "refusal", "restricted"], { platforms: ["companies", "people", "web"] }),
  P(11, "وظايف شاغره في الرياض", ["plan", "refusal", "question"]),
  P(12, "اعطني تعليقات اخر ٥ بوستات في صفحة اليوم السابع فيسبوك", ["question", "plan"]),
  P(13, "اريد ١٠٠ تعليق يوتيوب على فيديو https://www.youtube.com/watch?v=dQw4w9WgXcQ", ["plan"], { platforms: ["youtube"] }),
  P(14, "ابغى بيانات انستقرام لحساب فلان", ["question"], { note: "«فلان» is not an account: one question, never a plan" }),
  P(15, "٥ آلاف تعليق", ["question"]),
  P(16, "خمسين تغريده", ["question"]),
  P(17, "اجمع لي كل التغريدات عن الغلا", ["question", "plan"]),
  P(18, "أريد ١٠ منشورات من حساب @elonmusk على منصة X", ["plan"], { platforms: ["x"], note: "Phase 0's P18 is this request followed by the approval typed in words; a single run covers its first turn" }),
  P(19, "أريد ١٠ منشورات من حساب @elonmusk على منصة X", ["plan"], { platforms: ["x"], note: "Phase 0's P19 is this request followed by a complaint about the file; a single run covers its first turn" }),
  P(20, "كلمنا عن اسعاركم", ["question"], { note: "a price is never stated by the model" }),
  N(1, "هات ١٠ بوستات من حساب @elonmusk على أكس", ["plan"], { platforms: ["x"] }),
  N(2, "هات ٣٠ تعليق تيك توك عن كرة السلة في مصر", ["plan"], { platforms: ["tiktok"] }),
  N(3, "عايز ٥ شركات كهرباء في مصر", ["plan"], { platforms: ["companies"], country: "Egypt" }),
  N(4, "هات ٢٠ مراجعة على جوجل ماب لمطعم أبو طارق في القاهرة", ["plan"], { platforms: ["google"] }),
  N(5, "هات ٥ بوستات عن الترندات الصحية على فيسبوك في مصر وكل بوست معاه ٥ تعليقات", ["plan"], { platforms: ["facebook"] }),
  N(6, "عايز ٥ شركات صواريخ في ليختنشتاين", ["plan", "refusal"], { country: "Liechtenstein", note: "if a plan is offered it is held to Liechtenstein: never an Egyptian company" }),
  N(7, "هات بيانات حساب انستقرام @natgeo", ["plan"], { platforms: ["instagram"], noTopic: true }),
  N(8, "مين صاحب الرقم ٠١٠٠٠٠٠٠٠٠٠ وتبع أنهي شركة", ["restricted"], { note: "a customer account that is not a verified business gets the verified-business sentence" }),
  N(9, "ابغى بيانات انستقرام لحساب فلان", ["question"]),
  N(10, "هات ١٠ بوستات من حساب @elonmusk على أكس", ["plan"], { platforms: ["x"], note: "the same request again: the second answer must be as good as the first" }),
];

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** The outcome kind of a planner result, as the table names it. */
function outcomeOf(out: PlannerOutcome): SelfTestRow["outcome"] {
  if (out.kind === "plan") return "plan";
  if (out.kind === "purpose_needed") return "purpose";
  if (out.reason === "restricted") return "restricted";
  if (out.reason === "clarification" || out.reason === "incomplete") return "question";
  return "refusal";
}

/** Grades one result against the case's stored expectation. Returns the reason in English when it fails. */
export function gradeCase(test: SelfTestCase, out: PlannerOutcome, outcome: SelfTestRow["outcome"], paramsUsed: Array<{ name: string }>): { pass: boolean; reason: string } {
  if (!(test.expect as string[]).includes(outcome) && !(outcome === "purpose" && test.expect.includes("restricted"))) return { pass: false, reason: `expected ${test.expect.join(" or ")}, got ${outcome}${out.endReason ? ` (${out.endReason})` : ""}` };
  if (out.kind === "message" && out.reason === "unavailable" && out.messageAr !== PLAN_UNAVAILABLE_AR) return { pass: false, reason: "the refusal sentence is not the standard one" };
  if (outcome === "restricted" && out.kind === "message" && out.messageAr !== SENSITIVE_NOT_VERIFIED_AR) return { pass: false, reason: "the restricted sentence is not the standard one" };
  if (out.kind !== "plan") return { pass: true, reason: "" };
  const first = out.plan.steps[0];
  if (test.platforms && !test.platforms.includes(String(first.endpoint.platform).toLowerCase())) return { pass: false, reason: `the endpoint's platform is ${first.endpoint.platform}, expected ${test.platforms.join(" or ")}` };
  if (paramsUsed.some((p) => isWindowParamName(p.name)) && !/(?:آخر|اخر|الماضي|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|\d{4})/.test(test.request)) return { pass: false, reason: "a period was added that the customer did not state" };
  if (test.country && out.plan.stored.country?.canonicalEnglish !== test.country && test.expect.includes("plan") && test.country !== "Liechtenstein") return { pass: false, reason: `the plan carries no ${test.country} country gate` };
  if (test.country === "Liechtenstein" && out.plan.stored.country?.canonicalEnglish !== "Liechtenstein") return { pass: false, reason: "the plan carries no Liechtenstein country gate" };
  if (test.noTopic && out.plan.stored.topic) return { pass: false, reason: `a topic review was attached (${out.plan.stored.topic}) to a lookup of one named thing` };
  if (!(out.plan.price.unitPricePoints > 0)) return { pass: false, reason: "the plan has no price" };
  return { pass: true, reason: "" };
}

export interface RunCaseInput {
  test: SelfTestCase;
  transport: PlannerTransport;
  /** The database client for the exploration bookkeeping (only its `from` is used: nothing is stored in a bucket). */
  client: any;
  adminId: string;
  runId: string;
  /** What the run has spent so far (model and sample calls together, USD). */
  spentUsd: number;
  catalog?: TregCatalog;
  call?: ExplorationDeps["call"];
  deadlineAtMs?: number;
  now?: Date;
}

export type RunCaseResult = { stopped: "cap"; spentUsd: number; capUsd: number } | { stopped?: undefined; row: SelfTestRow; spentUsd: number; capUsd: number };

/** Runs ONE request of the self-test through the real planner and stops before any quote. */
export async function runSelfTestCase(input: RunCaseInput): Promise<RunCaseResult> {
  const capUsd = SELF_TEST_RUN_CAP_USD;
  const left = capUsd - input.spentUsd;
  if (left < SELF_TEST_MODEL_RESERVE_USD) return { stopped: "cap", spentUsd: input.spentUsd, capUsd };
  const catalog = input.catalog ?? loadTregCatalog();
  // a customer's view of the catalog: not an admin, not a verified business
  const access: AccountAccess = { isAdmin: false, verifiedBusiness: false };
  const requestId = `selftest_${input.runId}_${input.test.id}`.slice(0, 120);
  const out = await runPlanner({
    transport: input.transport, customerMessages: [input.test.request], access, catalog, ...(input.now ? { today: input.now } : {}),
    exploration: { client: input.client && typeof input.client.from === "function" ? { from: (t: string) => input.client.from(t) } : null, requestId, userId: input.adminId, requestCapUsd: Math.max(0, Math.min(EXPLORATION_REQUEST_CAP_USD, left - SELF_TEST_MODEL_RESERVE_USD)), ...(input.call ? { call: input.call } : {}), ...(input.now ? { now: input.now } : {}) },
    ...(input.deadlineAtMs !== undefined ? { deadlineAtMs: input.deadlineAtMs } : {}),
  });
  const outcome = outcomeOf(out);
  const params: SelfTestRow["params"] = [];
  let endpoints: string[] = [];
  let unit: number | null = null;
  let hold: number | null = null;
  let sampleRows = 0;
  let window = "none";
  if (out.kind === "plan") {
    endpoints = out.plan.steps.map((s) => s.step.endpointId);
    out.plan.steps.forEach((s, i) => s.step.params.forEach((p) => params.push({ step: i + 1, name: p.name, value: clip(p.source === "prior_step" ? `from step ${p.fromStep?.step}: ${p.fromStep?.field}` : resolvedParamValue(p), 80), source: p.source, quote: clip(p.quote, 60) })));
    const dates = out.plan.stored.steps.flatMap((s) => s.filters.filter((f) => f.kind === "date_window").map((f: any) => `${f.from}..${f.to}`));
    const windowParams = params.filter((p) => isWindowParamName(p.name)).map((p) => `${p.name}=${p.value}`);
    window = [...dates, ...windowParams].join(", ") || "none";
    unit = out.plan.price.unitPricePoints;
    hold = reserveForUnits(out.plan.steps[out.plan.steps.length - 1].step.volume, unit);
    sampleRows = out.plan.sampleRows.length;
  }
  const graded = gradeCase(input.test, out, outcome, params);
  const providerUsd = out.attempts.reduce((s, a) => s + a.costUsd, 0);
  const modelUsd = plannerCostUsd(out.usage);
  const row: SelfTestRow = {
    id: input.test.id, request: input.test.request, expected: input.test.expect.join(" / "),
    outcome, customerText: out.kind === "plan" ? out.plan.summaryAr : out.messageAr, understood: out.kind === "plan" ? out.plan.summaryAr : clip(out.messageAr, 160),
    endpoints, alternativesTried: out.attempts.map((a) => ({ endpoint: a.endpointId, outcome: a.outcome, httpStatus: a.httpStatus, ms: a.durationMs, costUsd: a.costUsd, detail: a.internal ?? a.detail })),
    params, window, sampleRows, unitPricePoints: unit, holdPoints: hold, turns: out.turns, stopReasons: out.stopReasons,
    tokensIn: out.usage.inputTokens + out.usage.cacheReadTokens + out.usage.cacheWriteTokens, tokensOut: out.usage.outputTokens, modelUsd, providerUsd,
    pass: graded.pass, reason: graded.reason, endReason: out.endReason ?? "", trace: out.trace.map((t) => `${t.turn}:${t.tool}:${t.error ? "ERR:" : ""}${clip(t.summary, 50)} -> ${clip(t.outcome, 90)}`),
  };
  return { row, spentUsd: input.spentUsd + modelUsd + providerUsd, capUsd };
}
