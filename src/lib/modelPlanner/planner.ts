import { toArabicDigits } from "../arabicDigits";
import { PlanIncompleteError } from "../capacityRefusal";
import { loadTregCatalog, type TregCatalog } from "../treg/catalog";
import { categoryOf, NO_SENSITIVE_ACCESS, SENSITIVE_NOT_VERIFIED_AR, type AccountAccess } from "../treg/dataPolicy";
import { PURPOSE_QUESTION_AR } from "../server/sensitiveAccess";
import { readExplorationSpend, runSampleCall, type ExplorationAttempt, type ExplorationDeps, type SampleStats } from "./exploration";
import { callEstimateUsd, unitCost } from "./pricing";
import { EXPLORATION_DAY_CAP_USD, EXPLORATION_REQUEST_CAP_USD, MAX_PLANNER_TURNS, MODEL_ERROR_RETRIES, PLANNER_MIN_TURN_MS } from "./constants";
import { anthropicToolDefinitions, toolCatalogSearch, toolDescribeEndpoint } from "./tools";
import { addUsage, emptyUsage, plannerCostUsd, type ContentBlock, type PlannerMessage, type PlannerTransport, type PlannerUsage } from "./transport";
import { ParamSchema, ProposePlanSchema, type ValidationIssue } from "./types";
import type { RecipeRecord } from "./recipes";
import { validatePlan, type StepSample, type ValidatedPlan } from "./validate";
import { z } from "zod";
import type { PlannerEvent } from "../missionView";

/** The sentence a customer reads when the plan cannot be completed from what they wrote (the owner-approved sentence of Phase 1). */
export const PLAN_INCOMPLETE_AR = new PlanIncompleteError([]).messageAr;
/** THE refusal sentence, the same everywhere on the model path: said only when nothing in the catalog can serve the request after the alternatives were tried. */
export const PLAN_UNAVAILABLE_AR = "هذه الخدمة غير متاحة حاليًا، ولم يُحجز أي رصيد.";
/** Said by a planning SESSION when the planning model itself kept failing (a real, temporary cause: not «the service is unavailable»). */
export const PLAN_MODEL_HICCUP_AR = "تعذّر تجهيز الخطة الآن لعطل مؤقت في خدمة التجهيز، ولم يُحجز أي رصيد. أعد إرسال الطلب بعد دقائق قليلة.";

export const PLANNER_SYSTEM_PROMPT = `You are the planning engine of Diger, a research-data service for Arabic-speaking customers. The customer wrote an Arabic request for data (posts, comments, profiles, companies, people, reviews, markets…). Your job: find the right endpoint(s) in the data catalog with the tools, learn how the endpoint answers, and propose ONE plan. Code validates and prices your plan; you never state a price, a cost or a point amount.

How to work (you have few turns: call SEVERAL tools in one turn whenever they do not depend on each other)
1. catalog_search (English words, platform first). Each hit lists its inputs, its price unit, its observed success rate and its cost per record; the hits are SORTED by cost per record, cheapest first. Sample the cheapest candidate that suits the request FIRST. Choose a dearer one only after the cheaper one's real rows were shown unsuitable (or it failed), and then say why in whyNotCheapest of propose_plan. Prefer the endpoint that answers the WHOLE request in one step. A MISSION may have up to FOUR steps: a step with no prior_step value is a root (it pages by itself); a step with prior_step values runs once for each row of ONE earlier step (its parent): videos of a channel, then the comments of each video; companies, then the people of each company, then each person's work e-mail and mobile. A request with several independent parts (news, and videos, and their comments) is several steps, some roots. Name each step in titleAr (a short Arabic name: «جمع الشركات»). Set deliver on every step: true when the customer receives its rows (a list of videos the customer wants too), false when the step only feeds the next one. Use describe_endpoint only when a hit's inputs are not enough.
2. sample_call ONCE for the endpoint you will plan, for each step in order (a later step is sampled from the REAL rows of the earlier one: give the parameter source prior_step with fromStep {step, field, endpointId of that earlier step}; if the field is wrong, the answer lists the real fields). The code also samples a later step by itself when you forget. An endpoint priced per call cannot be priced from the catalog's example (it is trimmed to one item): without a real sample the plan is refused. The code itself tries the endpoint's siblings (the same job at other providers) when the call fails, answers nothing, takes too long or does not fit the budget: read «endpointUsed» and «paramsUsed» in the answer and plan with THAT endpoint and those parameter names. Use only values the customer gave, quoting their exact words. Read the real rows it returns.
3. propose_plan. Build the field map from the REAL rows: only columns a reader needs (the text, the author, the date, the counts, the link), each with a short Arabic header and a role when it fits. Dotted paths, exactly as the sample shows them. When the answer is ONE record (a profile, a place, a company), the plan has one row and no paging.
If propose_plan comes back with problems, fix exactly what it says and propose again: every problem is meant to be fixed.

Hard rules
- Never invent a value. Every parameter has a source: customer_text (the value is what the customer wrote; the exact words in \`quote\`), derived (made from the customer's words, for example a translation into the English word the catalog expects; the exact words in \`quote\`; never an account, link or id), literal (a fixed choice such as a sort order; NEVER an account, a link, an id or a period), or prior_step. If the customer did not give a required value (for example «فلان» instead of an account), do not call propose_plan: answer in Arabic with ONE short question.
- The COUNT is the customer's: set volume only from a number in their words (digits, or a number written in words), and put those words in volumeQuote. «كل» (all) or no number at all is NOT a count: do not call propose_plan, answer with ONE short Arabic question asking how many they want. A step run for each row of an earlier step gets perItem (how many rows from each) and a volume no larger than parents x perItem.
- Never add a period (a date range, «this month», «recent») the customer did not state. No period parameter and no date_window filter unless their own words give one.
- Filters only for what the customer asked: the posts of one account (author_equals with the account they wrote; look at the sample rows for replies and reposts and exclude them with exclude_true on a flag field, or exclude_prefix on the text mark a repost starts with), a period they stated. A topic is not a filter: put the topic words in \`topic\` ONLY when the customer asked for rows ABOUT a subject (comments about prices, posts about a topic). A request for one named account, page or link has no topic.
- Do not give up early. Say that the service is not available ONLY when you searched with different word sets (platform names and synonyms), sampled the best candidate, and the code reported that its alternatives failed too. Then answer with ONE short Arabic sentence that the service is «غير متاحة حاليًا». Say nothing about providers, endpoints, ids, prices or USD, and do not use markdown or emoji. Write numbers with Arabic-Indic digits.
- WHICH PLATFORM: when the customer names no platform («بوستات أو فيديوهات عن ترند…»), do not silently narrow to one. Either plan a root step for EVERY platform that fits the request (the catalog search shows them), or choose one and say so in platformChoiceAr: ONE short Arabic sentence with which platform and why (no provider names). A customer who names a platform needs no platformChoiceAr.
- THE OFFICIAL CHANNEL, PAGE OR ACCOUNT («القناة الرسمية لفيفا»، «الصفحة الرسمية لشركة…»): do not ask the customer for a link. Search the catalog for a channel / page / profile search endpoint of that platform, sample it with the organisation's name, pick the official one from the real rows (verified, the name matches, the most followers), plan the next steps with its id, and put it in foundEntities (kindAr «قناة» / «صفحة» / «حساب», nameAr as the row names it, id exactly as it appears in the sample): the card shows it and the customer confirms it by approving. Ask ONE short Arabic question only when the search finds nothing or several equally likely ones.
- Some endpoints return personal data. Offer one only when the catalog shows it to you, and never suggest a price.
- Be brief. Do not explain your steps to the customer.`;

const SampleInputSchema = z.object({ id: z.string(), params: z.array(ParamSchema).default([]), limit: z.number().int().min(1).max(50).optional() });

export interface PlannerInput {
  transport: PlannerTransport;
  /** The customer's words for this request, oldest first (their own text only). */
  customerMessages: string[];
  /** Earlier turns of the conversation that answered a question of ours (alternating, oldest first), when this request continues one. */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  access: AccountAccess;
  /** The purpose a customer account stated for a sensitive service (the answer to the purpose question). */
  purpose?: string | null;
  today?: Date;
  catalog?: TregCatalog;
  exploration: ExplorationDeps;
  /** Loads the saved recipe whose first endpoint is this one (null when none or when the recipes table is not applied). */
  loadRecipe?: (endpointId: string) => Promise<RecipeRecord | null>;
  /** The measured average cost of a call of a ROUTED endpoint (null when there is no measurement: the price then follows the highest sibling). */
  loadMeasuredAvg?: (endpointId: string) => Promise<number | null>;
  maxTurns?: number;
  /** Told, as it happens, what the planner is doing (the customer's planning steps are built from these; never a separate text). Must not throw; failures are ignored. */
  onEvent?: (event: PlannerEvent) => void;
  /** The turn's own deadline (epoch ms): a further model turn is not started with less than PLANNER_MIN_TURN_MS left, and a model call is cut before it. */
  deadlineAtMs?: number;
  /** What happens when the turns or the model budget are spent without a plan: `refuse` (the old sentence, for callers that want it) or `explain` (what was found and ONE question). */
  exhaustion?: "refuse" | "explain";
  /** A planning budget besides the turns: the planning model's own spend (USD) at which the run stops. */
  budget?: { maxModelUsd?: number };
  /** A planning SESSION retries a model call that failed (a timeout, a provider error) in a later step instead of ending the request, up to MODEL_ERROR_RETRIES times. */
  retryModelErrors?: boolean;
}

export type PlannerResult =
  | { kind: "plan"; plan: ValidatedPlan }
  | { kind: "message"; messageAr: string; reason: "clarification" | "unavailable" | "incomplete" | "restricted" | "no_model" }
  | { kind: "purpose_needed"; messageAr: string };

/** One tool call of the loop, for the owner's diagnosis (internal; the admin self-test shows it, the logs carry its short form). */
export interface PlannerTraceEntry { turn: number; tool: string; summary: string; outcome: string; error?: boolean }

export interface PlannerMeta {
  turns: number; toolCalls: number; sampleCalls: number; usage: PlannerUsage; modelCostUsd: number; explorationCostUsd: number; failures: ValidationIssue[][];
  /** The model's stop reason of each turn («tool_use», «end_turn»…). */
  stopReasons: string[];
  trace: PlannerTraceEntry[];
  attempts: ExplorationAttempt[];
  /** Why the turn ended without a plan, in English (internal): the last thing that went wrong. */
  endReason?: string;
}
export type PlannerOutcome = PlannerResult & PlannerMeta;

const CODES_NEEDING_INPUT = new Set<ValidationIssue["code"]>(["missing_required", "no_provenance", "quote_not_in_customer_text", "invented_value", "id_like_literal"]);

/** A message for the customer made from the model's own words: Arabic only, no markdown, no emoji, no provider or endpoint or USD, Arabic-Indic digits. Null when it cannot be made safe. */
export function customerSafeArabic(text: string, providerNames: ReadonlySet<string>): string | null {
  let t = String(text ?? "").replace(/```[\s\S]*?```/g, " ").replace(/[*_#`>|]+/g, " ").replace(/\p{Extended_Pictographic}/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (/\b[a-z0-9-]+\.[a-z0-9_.-]{2,}\b/i.test(t) || /\bUSD\b|\$|دولار/i.test(t)) return null;
  for (const word of t.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 3)) if (providerNames.has(word.toLowerCase())) return null;
  if (/[A-Za-z]{3,}/.test(t)) return null; // a Latin word of 3+ letters: not an Arabic-only message
  t = toArabicDigits(t);
  if (t.length > 400 || !/[؀-ۿ]/.test(t)) return null;
  return t;
}

function providerNamesOf(catalog: TregCatalog): Set<string> {
  const out = new Set<string>(["treg", "tikhub", "apify", "openai", "anthropic", "claude", "haiku"]);
  for (const e of catalog.endpoints) out.add(String(e.provider || "").toLowerCase());
  return out;
}

const textOf = (blocks: ContentBlock[]) => blocks.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n").trim();
const clipResult = (v: unknown, max = 7000): string => { const s = typeof v === "string" ? v : (JSON.stringify(v) ?? ""); return s.length > max ? `${s.slice(0, max)}…(cut)` : s; };
const clipText = (v: unknown, n: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** A model sentence that says «not available»: it is replaced by THE refusal sentence (one wording everywhere). */
const REFUSAL_LIKE = /غير\s+متاح|لا\s+تتوفر|غير\s+متوفر|لا\s+يمكن\s+(?:توفير|تنفيذ)|لا\s+نستطيع/;
const QUESTION_LIKE = /[؟?]/;


/** What a planning session keeps between steps: everything the loop holds, as plain data. */
export interface PlannerSnapshot {
  v: 1;
  messages: PlannerMessage[];
  turns: number;
  usage: PlannerUsage;
  toolCalls: number;
  sampleCalls: number;
  explorationCostUsd: number;
  madeCalls: number;
  failures: ValidationIssue[][];
  trace: PlannerTraceEntry[];
  attempts: ExplorationAttempt[];
  stopReasons: string[];
  restrictedSeen: boolean;
  nudges: number;
  lastIssues: ValidationIssue[];
  hitsSeen: string[];
  hitInfo: Array<[string, { platform: string; capability: string; perRecord: number | null }]>;
  rephrased: boolean;
  touched: string[];
  samples: Array<[string, StepSample]>;
  recipes: Array<[string, RecipeRecord]>;
  measured: Array<[string, number]>;
  pending: { uses: Array<Extract<ContentBlock, { type: "tool_use" }>>; index: number; results: ContentBlock[] } | null;
  modelErrors?: number;
}

/** A sample's raw answer is kept for the validator's reader check only while it is small; a larger one is dropped from the snapshot (the rows and the digest stay). */
export const SNAPSHOT_BODY_MAX_CHARS = 40_000;
export function trimSamples(entries: Array<[string, StepSample]>): Array<[string, StepSample]> {
  return entries.map(([id, sample]) => {
    let size = 0;
    try { size = JSON.stringify(sample.body ?? null).length; } catch { size = Number.POSITIVE_INFINITY; }
    if (size <= SNAPSHOT_BODY_MAX_CHARS) return [id, sample];
    const { body: _dropped, ...rest } = sample;
    void _dropped;
    return [id, rest as StepSample];
  });
}

/**
 * What the customer is told when the planning BUDGET ran out without a plan: what was found, and ONE question. Never «غير متاحة» and never a provider, endpoint or amount.
 */
export function budgetExplanationAr(attempts: ReadonlyArray<ExplorationAttempt>): string {
  const worked = attempts.some((a) => a.outcome === "ok");
  const overBudget = attempts.some((a) => a.outcome === "over_budget");
  if (worked) return `وجدنا مصادر تُرجِع بيانات لجزء من طلبك، لكن لم نكمل تجهيز خطة كاملة له ضمن ميزانية التجهيز${overBudget ? " (نفدت تجارب العيّنات المسموحة لهذا الطلب)" : ""}. أي جزء تريدنا نبدأ به؟ اكتبه وحده (مثلًا: الشركات فقط، أو الفيديوهات فقط) وسنجهّز خطته فورًا.`;
  return `جرّبنا عدة مصادر لهذا الطلب${overBudget ? "، ونفدت تجارب العيّنات المسموحة له" : ""}، ولم يُرجع أيٌّ منها بيانات مناسبة الآن. هل تريد أن نجرّب صياغة أخرى للطلب أو منصة أخرى؟`;
}
/**
 * The planning loop, as a RUN that can stop between steps and resume from a snapshot (the planning session of the chat: each step is one model call or one tool call, so a mission that needs
 * several samples and model turns is never held inside one HTTP request). `runPlanner` below runs a run to its end in one go (tests, the admin self-test, the retry).
 *
 * The model calls tools, the app answers with tool_results, until the model proposes a plan that validates, or answers the customer in words.
 * A plan that fails validation goes back to the model as a tool_result with the exact reasons on EVERY turn that is left, so it can correct the step. A model that answers «not
 * available» while untried candidates are left is sent back to try them (at most twice). The turn ends without a plan only when the turns, the time or the budget are spent, or
 * the customer's own input is what is missing (then ONE question). Sensitive services never reach an account that may not use them (the tools never show them).
 */
export function createPlannerRun(input: PlannerInput, restore?: PlannerSnapshot) {
  const catalog = input.catalog ?? loadTregCatalog();
  const providers = providerNamesOf(catalog);
  const access = input.access ?? NO_SENSITIVE_ACCESS;
  const customerText = input.customerMessages.join("\n");
  const samples = new Map<string, StepSample>(restore?.samples ?? []);
  const recipes = new Map<string, RecipeRecord>(restore?.recipes ?? []);
  const measured = new Map<string, number>(restore?.measured ?? []);
  const failures: ValidationIssue[][] = restore?.failures ?? [];
  const trace: PlannerTraceEntry[] = restore?.trace ?? [];
  const attempts: ExplorationAttempt[] = restore?.attempts ?? [];
  const stopReasons: string[] = restore?.stopReasons ?? [];
  const stats: SampleStats = { madeCalls: restore?.madeCalls ?? 0 };
  let usage = restore?.usage ?? emptyUsage();
  let toolCalls = restore?.toolCalls ?? 0;
  let sampleCalls = restore?.sampleCalls ?? 0;
  let explorationCostUsd = restore?.explorationCostUsd ?? 0;
  let restrictedSeen = restore?.restrictedSeen ?? false;
  let nudges = restore?.nudges ?? 0;
  let lastIssues: ValidationIssue[] = restore?.lastIssues ?? [];
  const hitsSeen: string[] = [...(restore?.hitsSeen ?? [])];
  const hitInfo = new Map<string, { platform: string; capability: string; perRecord: number | null }>(restore?.hitInfo ?? []);
  let rephrased = restore?.rephrased ?? false;
  const touched = new Set<string>(restore?.touched ?? []);
  const today = input.today ?? new Date();
  const maxTurns = input.maxTurns ?? MAX_PLANNER_TURNS;
  const tools = anthropicToolDefinitions();
  // read at every call: a session gives each step its own deadline
  const exploration = (): ExplorationDeps => ({ ...input.exploration, ...(input.deadlineAtMs !== undefined && input.exploration.deadlineAtMs === undefined ? { deadlineAtMs: input.deadlineAtMs } : {}) });

  const first = [`Today is ${today.toISOString().slice(0, 10)}.`, "The customer's request (Arabic):", input.customerMessages[input.customerMessages.length - 1] ?? ""].filter(Boolean).join("\n");
  const messages: PlannerMessage[] = restore ? restore.messages : [];
  const history = input.history ?? [];
  if (restore) { /* resumed: the conversation with the model is the snapshot's */ } else if (input.customerMessages.length > 1 || history.length > 0) {
    messages.push({ role: "user", content: [`Today is ${today.toISOString().slice(0, 10)}.`, "The customer's request, in their words (Arabic):", input.customerMessages[0] ?? ""].join("\n") });
    for (const h of history) messages.push({ role: h.role, content: h.text });
    if (history.length === 0 || history[history.length - 1].role === "assistant") messages.push({ role: "user", content: input.customerMessages[input.customerMessages.length - 1] ?? "" });
  } else {
    messages.push({ role: "user", content: first });
  }

  const done = (turns: number, outcome: PlannerResult, endReason?: string): PlannerOutcome => {
    if (outcome.kind === "message") emit({ kind: outcome.reason === "clarification" ? "asked" : "stopped" });
    const result: PlannerOutcome = { ...outcome, turns, toolCalls, sampleCalls, usage, modelCostUsd: plannerCostUsd(usage), explorationCostUsd, failures, stopReasons, trace, attempts, ...(endReason ? { endReason } : {}) };
    console.info(JSON.stringify({ tag: "model_planner_trace", kind: outcome.kind, reason: outcome.kind === "message" ? outcome.reason : undefined, endReason, stopReasons, trace: trace.map((t) => `${t.turn}:${t.tool}:${t.error ? "ERR:" : ""}${clipText(t.outcome, 90)}`).slice(0, 24) }));
    return result;
  };

  const emit = (event: Omit<PlannerEvent, "at">) => { try { input.onEvent?.({ ...event, at: Date.now() }); } catch { /* an event never changes the plan */ } };

  type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;
  let turns = restore?.turns ?? 0;
  /** A model turn whose tool calls are being run one at a time (so a step never holds more than one call). */
  let pending: { uses: ToolUse[]; index: number; results: ContentBlock[] } | null = restore?.pending ?? null;
  /** Set by a tool that ends the planning (a plan that validated, a refusal that is final). */
  let finished: PlannerOutcome | null = null;
  let modelErrors = restore?.modelErrors ?? 0;

  const executeTool = async (use: ToolUse, results: ContentBlock[]): Promise<void> => {
    const turnsLeft = maxTurns - turns;
      toolCalls += 1;
      let content: unknown;
      let isError = false;
      let summary = "";
      let outcome = "ok";
      if (use.name === "catalog_search") {
        const out = toolCatalogSearch(use.input as any, access, catalog);
        if (out.restrictedTop) restrictedSeen = true;
        for (const h of out.hits) {
          if (typeof h.id === "string" && !hitsSeen.includes(h.id)) hitsSeen.push(h.id);
          if (typeof h.id === "string") hitInfo.set(h.id, { platform: String(h.platform ?? ""), capability: String(h.capability ?? ""), perRecord: typeof h.costPerRecordUsd === "number" ? h.costPerRecordUsd : null });
        }
        // a saved recipe (a mission that already delivered) is used FIRST: the hits that start one say so, and describe_endpoint shows its steps
        if (input.loadRecipe) {
          await Promise.all(out.hits.slice(0, 5).map(async (h) => {
            const id = String(h.id);
            if (recipes.has(id)) return;
            const rec = await input.loadRecipe!(id).catch(() => null);
            if (rec) for (const rid of new Set([id, ...rec.endpointIds])) recipes.set(rid, rec);
          }));
          for (const h of out.hits) if (recipes.has(String(h.id))) (h as Record<string, unknown>).savedRecipe = "a saved mission starts here: describe_endpoint shows it; reuse it when it fits";
        }
        content = { hits: out.hits, note: out.hits.length === 0 ? "no matching endpoint is available for this customer: try other words (another platform name, a synonym, the capability in English)" : undefined };
        summary = clipText(JSON.stringify({ platform: (use.input as any)?.platform, words: (use.input as any)?.words }), 80);
        outcome = `${out.hits.length} hits`;
        emit({ kind: "searched", n: out.hits.length });
      } else if (use.name === "describe_endpoint") {
        const describedId = String((use.input as any)?.id ?? "").trim();
        touched.add(describedId);
        if (input.loadRecipe && describedId && !recipes.has(describedId)) { const r = await input.loadRecipe(describedId).catch(() => null); if (r) for (const id of new Set([describedId, ...r.endpointIds])) recipes.set(id, r); }
        const out = toolDescribeEndpoint(use.input as any, access, catalog, recipes.get(describedId) ?? null);
        if (!out.ok) { isError = true; content = out.message; outcome = out.reason; if (out.reason === "not_allowed" && categoryOf(String((use.input as any)?.id ?? "")) === "sensitive") restrictedSeen = true; }
        else { content = out.endpoint; outcome = recipes.has(describedId) ? "described (a saved recipe exists)" : "described"; }
        summary = describedId;
      } else if (use.name === "sample_call") {
        const parsed = SampleInputSchema.safeParse(use.input);
        if (!parsed.success) { isError = true; content = `invalid sample_call input: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`; outcome = "bad input"; summary = clipText(JSON.stringify(use.input), 60); }
        else {
          touched.add(parsed.data.id);
          if (categoryOf(parsed.data.id) === "sensitive" && !access.isAdmin && !access.verifiedBusiness) restrictedSeen = true;
          summary = parsed.data.id;
          const out = await runSampleCall(parsed.data as any, { customerText, access, catalog, samples, today, stats }, exploration());
          const made = (out.ok ? out.note.attempts : out.attempts);
          attempts.push(...made);
          sampleCalls += 1;
          explorationCostUsd += out.costUsd;
          for (const a of made) touched.add(a.endpointId);
          const switchedSource = out.ok && out.note.endpointUsed !== parsed.data.id;
          const slow = made.some((a) => a.outcome === "timeout");
          if (slow && !out.ok) emit({ kind: "sample_slow" });
          if (switchedSource || made.length > 1) emit({ kind: "switched" });
          if (out.ok) emit({ kind: "sampled", rows: out.digest.rowsInSample });
          if (out.ok) {
            const pagesMeasured = ((out as any).sample?.pageRows ?? []) as number[];
            content = { endpointUsed: out.note.endpointUsed, ...(pagesMeasured.length > 1 ? { rowsPerPageMeasured: pagesMeasured } : {}), ...(out.note.endpointUsed !== parsed.data.id ? { note: `«${parsed.data.id}» gave no usable answer, so the code used «${out.note.endpointUsed}». Plan with «${out.note.endpointUsed}» and the parameter names in paramsUsed.` } : {}), paramsUsed: out.note.paramsUsed, attempts: made.map((a) => ({ endpoint: a.endpointId, outcome: a.outcome, ...(a.detail ? { detail: a.detail } : {}) })), ...out.digest };
            outcome = `ok via ${out.note.endpointUsed}${made.length > 1 ? ` after ${made.length - 1} failed` : ""}`;
          } else {
            isError = true;
            // the endpoints this one has no catalog sibling for: the candidates of the model's own searches that were not tried and fit the exploration budget left
            let hint = "";
            if (out.kind === "failed") {
              const spentNow = await readExplorationSpend(exploration());
              const budgetLeft = Math.max(0, Math.min((exploration().requestCapUsd ?? EXPLORATION_REQUEST_CAP_USD) - spentNow.request, EXPLORATION_DAY_CAP_USD - spentNow.day));
              const fits = hitsSeen.filter((id) => {
                if (touched.has(id)) return false;
                const e = catalog.byId.get(id);
                const c = e ? unitCost(e, catalog) : null;
                return Boolean(e && c && callEstimateUsd(c, 1) <= budgetLeft + 1e-12);
              }).slice(0, 5);
              if (fits.length > 0) hint = ` Candidates from your searches that were not tried and fit the exploration budget: ${fits.join(", ")}.`;
            }
            content = `${out.message}${hint}`;
            outcome = `${out.kind}: ${clipText(out.message, 100)}`;
          }
        }
      } else if (use.name === "propose_plan") {
        const parsed = ProposePlanSchema.safeParse(use.input);
        summary = clipText((use.input as any)?.steps?.map?.((s: any) => s?.endpointId).join(" > "), 80);
        if (!parsed.success) {
          isError = true;
          const issues: ValidationIssue[] = parsed.error.issues.slice(0, 6).map((i) => ({ code: "bad_filter" as const, message: `${i.path.join(".")}: ${i.message}` }));
          failures.push(issues);
          lastIssues = issues;
          content = issues.map((i) => i.message).join("; ");
          outcome = `bad shape: ${clipText(content, 100)}`;
        } else {
          for (const st of parsed.data.steps) {
            touched.add(st.endpointId);
            if (input.loadRecipe && !recipes.has(st.endpointId)) { const rec = await input.loadRecipe(st.endpointId).catch(() => null); if (rec) for (const rid of new Set([st.endpointId, ...rec.endpointIds])) recipes.set(rid, rec); }
            const e = catalog.byId.get(st.endpointId);
            if (e?.kind === "routed" && input.loadMeasuredAvg && !measured.has(st.endpointId)) { const m = await input.loadMeasuredAvg(st.endpointId).catch(() => null); if (m) measured.set(st.endpointId, m); }
          }
          // LATER STAGES ARE SAMPLED BY CODE from the real rows of the stage before them (provenance prior_step), so the model is never stopped for a sample it could not take
          const autoNotes: string[] = [];
          for (let i = 1; i < parsed.data.steps.length; i += 1) {
            const st = parsed.data.steps[i];
            const refs = st.params.filter((p) => p.source === "prior_step" && p.fromStep);
            if (refs.length === 0 || samples.has(st.endpointId)) continue;
            const e = catalog.byId.get(st.endpointId);
            const c = e ? unitCost(e, catalog) : null;
            if (!e || !c || c.unit !== "call") continue; // a per-record endpoint needs no sample to be priced
            const earlier = refs.map((r) => parsed.data.steps[r.fromStep!.step - 1]);
            if (earlier.some((x) => !x || !samples.has(x.endpointId))) continue;
            const withEndpoint = st.params.map((p) => (p.source === "prior_step" && p.fromStep ? { ...p, fromStep: { ...p.fromStep, endpointId: parsed.data.steps[p.fromStep.step - 1].endpointId } } : p));
            const auto = await runSampleCall({ id: st.endpointId, params: withEndpoint as any }, { customerText, access, catalog, samples, today, stats }, exploration());
            attempts.push(...(auto.ok ? auto.note.attempts : auto.attempts));
            sampleCalls += 1; explorationCostUsd += auto.costUsd;
            if (auto.ok) emit({ kind: "sampled", rows: auto.digest.rowsInSample });
            autoNotes.push(auto.ok ? `step ${i + 1} sampled automatically from the real rows of step ${refs[0].fromStep!.step}` : `automatic sample of step ${i + 1} failed: ${clipText(auto.message, 120)}`);
            trace.push({ turn: turns, tool: "sample_call", summary: `${st.endpointId} (automatic, from step ${refs[0].fromStep!.step})`, outcome: auto.ok ? `ok via ${auto.note.endpointUsed}` : `${auto.kind}: ${clipText(auto.message, 100)}`, ...(auto.ok ? {} : { error: true }) });
          }
          // THE CHEAPEST SUITABLE FIRST: a plan that uses a dearer endpoint of the same job while a cheaper candidate of the same platform and capability was never looked at must say why
          const dearer = parsed.data.steps.flatMap((st, i) => {
            const mine = hitInfo.get(st.endpointId);
            if (!mine || mine.perRecord === null) return [];
            const cheaper = [...hitInfo.entries()].filter(([id, h]) => id !== st.endpointId && !touched.has(id) && h.platform === mine.platform && h.capability === mine.capability && h.perRecord !== null && h.perRecord < mine.perRecord! * 0.8);
            return cheaper.length > 0 ? [{ i, id: cheaper[0][0] }] : [];
          });
          if (dearer.length > 0 && !(parsed.data.whyNotCheapest ?? "").trim()) {
            isError = true;
            const issues: ValidationIssue[] = dearer.map((d) => ({ code: "cheaper_untried" as const, stepIndex: d.i, message: `a cheaper candidate for the same job was never sampled: «${d.id}». Sample the cheapest suitable candidate first. If its rows are unsuitable, or you have a reason to prefer this one, call propose_plan again with whyNotCheapest (one sentence).` }));
            failures.push(issues);
            lastIssues = issues;
            outcome = "refused: cheaper_untried";
            content = issues.map((x) => `step ${(x.stepIndex ?? 0) + 1}: ${x.message}`).join("\n");
            trace.push({ turn: turns, tool: use.name, summary, outcome, error: true });
            results.push({ type: "tool_result", tool_use_id: use.id, content: clipResult(content), is_error: true });
            return;
          }
          void autoNotes;
          const verdict = validatePlan(parsed.data, { customerText, access, catalog, samples, recipes, purpose: input.purpose ?? null, today, measuredAvgCallUsd: (id) => measured.get(id) ?? null });
          if (verdict.ok) { finished = done(turns, { kind: "plan", plan: verdict.plan }); outcome = "plan accepted"; emit({ kind: "planned" }); }
          else {
            emit({ kind: "adjusting" });
            isError = true;
            failures.push(verdict.issues);
            lastIssues = verdict.issues;
            outcome = `refused: ${verdict.issues.map((i) => i.code).join(",")}`;
            if (verdict.issues.some((i) => i.code === "not_allowed") && parsed.data.steps.some((s) => categoryOf(s.endpointId) === "sensitive") && !access.isAdmin && !access.verifiedBusiness) {
              finished = done(turns, { kind: "message", messageAr: SENSITIVE_NOT_VERIFIED_AR, reason: "restricted" }, "a restricted service was proposed");
            } else if (verdict.issues.some((i) => i.code === "sensitive_purpose")) {
              finished = done(turns, { kind: "purpose_needed", messageAr: PURPOSE_QUESTION_AR });
            }
            const lastTurn = turnsLeft < 1 ? " This was your last turn." : turnsLeft === 1 ? " You have ONE turn left: fix everything this message names in one propose_plan." : "";
            content = `${verdict.issues.map((i) => `${i.stepIndex !== undefined ? `step ${i.stepIndex + 1}: ` : ""}${i.message}`).join("\n")}${lastTurn}`;
          }
        }
      } else {
        isError = true;
        content = `unknown tool «${use.name}»`;
        outcome = "unknown tool";
      }
      trace.push({ turn: turns, tool: use.name, summary, outcome, ...(isError ? { error: true } : {}) });
      results.push({ type: "tool_result", tool_use_id: use.id, content: clipResult(content), ...(isError ? { is_error: true } : {}) });
  };

  const modelStep = async (): Promise<PlannerOutcome | null> => {
    if (turns >= maxTurns) return exhausted();
    if (input.budget?.maxModelUsd !== undefined && plannerCostUsd(usage) >= input.budget.maxModelUsd) return exhausted(`the planning model budget (${input.budget.maxModelUsd} USD) was used`);
    const left = input.deadlineAtMs !== undefined ? input.deadlineAtMs - Date.now() : Number.POSITIVE_INFINITY;
    if (left < PLANNER_MIN_TURN_MS) { const why = `no time left for another model turn (${Math.max(0, Math.round(left / 1000))} s left of the turn)`; return input.exhaustion === "explain" ? exhausted(why) : done(turns, { kind: "message", messageAr: PLAN_UNAVAILABLE_AR, reason: "no_model" }, why); }
    turns += 1;
    let response;
    try {
      response = await input.transport.send({ system: PLANNER_SYSTEM_PROMPT, messages, tools, ...(Number.isFinite(left) ? { timeoutMs: Math.max(1_000, left - 3_000) } : {}) });
    } catch (err) {
      const why = `the planning model call failed: ${clipText((err as Error)?.message, 80)}`;
      // a session tries the call again in a later step (a timeout or a provider hiccup is not a reason to end the request)
      if (input.retryModelErrors && modelErrors < MODEL_ERROR_RETRIES) { modelErrors += 1; turns -= 1; trace.push({ turn: turns + 1, tool: "(model call)", summary: "", outcome: why, error: true }); return null; }
      if (input.exhaustion === "explain") return attempts.length > 0 ? exhausted(why) : done(turns, { kind: "message", messageAr: PLAN_MODEL_HICCUP_AR, reason: "no_model" }, why);
      return done(turns, { kind: "message", messageAr: PLAN_UNAVAILABLE_AR, reason: "no_model" }, why);
    }
    usage = addUsage(usage, response.usage);
    stopReasons.push(response.stopReason || "");
    if (turns === 1) emit({ kind: "understood" });
    const toolUses = response.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });
    const turnsLeft = maxTurns - turns;

    if (toolUses.length === 0) {
      // the model answered the customer in words: a question, or a «not available» sentence, made safe by code
      if (restrictedSeen) return done(turns, { kind: "message", messageAr: SENSITIVE_NOT_VERIFIED_AR, reason: "restricted" }, "a restricted service was the best match");
      const text = textOf(response.content);
      const refusal = REFUSAL_LIKE.test(text) && !QUESTION_LIKE.test(text);
      const untried = hitsSeen.filter((id) => !touched.has(id)).slice(0, 5);
      if (refusal && nudges < 2 && turnsLeft >= 1) {
        nudges += 1;
        const why = attempts.length > 0 ? ` Attempts so far: ${attempts.map((a) => `${a.endpointId}=${a.outcome}`).join(", ")}.` : "";
        messages.push({ role: "user", content: `Do not give up yet: nothing here proves the catalog cannot serve this request.${why} ${untried.length > 0 ? `Untried candidates from your searches: ${untried.join(", ")}. ` : "Search the catalog again with other words (other platform names, synonyms, the capability in English). "}Sample the best next candidate and propose a plan, or ask the customer ONE short question when a value is missing. Answer «not available» only when every candidate failed.` });
        trace.push({ turn: turns, tool: "(model text)", summary: clipText(text, 60), outcome: "refusal sent back: candidates remain", error: true });
        return null;
      }
      if (refusal) return done(turns, { kind: "message", messageAr: PLAN_UNAVAILABLE_AR, reason: "unavailable" }, "the model said the service is not available, and the alternatives were tried");
      const safe = customerSafeArabic(text, providers);
      if (!safe) {
        // the model's words fail the customer-text check: it is asked ONCE to rephrase; if they fail again the standard question is asked. It is never turned into a refusal.
        if (!rephrased && turnsLeft >= 1) {
          rephrased = true;
          messages.push({ role: "user", content: "Your message cannot be shown to the customer as written. Rephrase it as ONE short Arabic message: Arabic words only (no English or Latin letters), no markdown, no emoji, no provider, endpoint or technical name, no money amount. If you need a value from the customer, ask for it in one short question." });
          trace.push({ turn: turns, tool: "(model text)", summary: clipText(text, 60), outcome: "customer text failed the check: sent back once to rephrase", error: true });
          return null;
        }
        return done(turns, { kind: "message", messageAr: PLAN_INCOMPLETE_AR, reason: "incomplete" }, "the model's own words could not be shown to a customer, twice: the standard question was asked");
      }
      return done(turns, { kind: "message", messageAr: safe, reason: "clarification" });
    }

    pending = { uses: toolUses, index: 0, results: [] };
    return null;
  };

  /** The turn ends without a plan: the turns, the model budget or the exploration budget are spent. */
  const exhausted = (why?: string): PlannerOutcome => {
    const needsInput = lastIssues.some((i) => CODES_NEEDING_INPUT.has(i.code));
    if (restrictedSeen) return done(turns, { kind: "message", messageAr: SENSITIVE_NOT_VERIFIED_AR, reason: "restricted" }, "a restricted service was the best match");
    const reason = why ?? `the ${maxTurns} turns were used`;
    const detail = `${reason}${lastIssues.length ? `; the last refusal: ${lastIssues.map((i) => i.code).join(",")}` : ""}`;
    if (needsInput) return done(turns, { kind: "message", messageAr: PLAN_INCOMPLETE_AR, reason: "incomplete" }, detail);
    // A planning BUDGET that ran out is not «unavailable»: the customer gets what was found and ONE question (the old refusal stays for callers that ask for it)
    if (input.exhaustion === "explain") return done(turns, { kind: "message", messageAr: budgetExplanationAr(attempts), reason: "incomplete" }, detail);
    return done(turns, { kind: "message", messageAr: PLAN_UNAVAILABLE_AR, reason: "unavailable" }, detail);
  };

  const step = async (): Promise<PlannerOutcome | null> => {
    if (finished) return finished;
    if (pending) {
      const turn = pending;
      await executeTool(turn.uses[turn.index], turn.results);
      turn.index += 1;
      if (finished) return finished;
      if (turn.index >= turn.uses.length) { messages.push({ role: "user", content: turn.results }); pending = null; }
      return null;
    }
    return modelStep();
  };

  /** The next step calls the model or a real source (it can take most of a function invocation): a session starts it only with a fresh budget of time. */
  const nextIsHeavy = (): boolean => !pending || ["sample_call", "propose_plan"].includes(pending.uses[pending.index]?.name ?? "");

  const snapshot = (): PlannerSnapshot => ({
    v: 1, messages, turns, usage, toolCalls, sampleCalls, explorationCostUsd, madeCalls: stats.madeCalls, failures, trace, attempts, stopReasons, restrictedSeen, nudges, lastIssues, hitsSeen,
    hitInfo: [...hitInfo], rephrased, touched: [...touched], samples: trimSamples([...samples]), recipes: [...recipes], measured: [...measured], pending, modelErrors,
  });

  return { step, snapshot, nextIsHeavy, exhaust: exhausted, usage: () => usage, turns: () => turns, modelCostUsd: () => plannerCostUsd(usage), explorationCostUsd: () => explorationCostUsd, attempts: () => attempts, emit };
}

/** Runs a planning loop to its end in one go. */
export async function runPlanner(input: PlannerInput): Promise<PlannerOutcome> {
  const run = createPlannerRun(input);
  for (;;) {
    const out = await run.step();
    if (out) return out;
  }
}
