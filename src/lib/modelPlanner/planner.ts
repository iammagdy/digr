import { toArabicDigits } from "../arabicDigits";
import { PlanIncompleteError } from "../capacityRefusal";
import { loadTregCatalog, type TregCatalog } from "../treg/catalog";
import { categoryOf, NO_SENSITIVE_ACCESS, SENSITIVE_NOT_VERIFIED_AR, type AccountAccess } from "../treg/dataPolicy";
import { PURPOSE_QUESTION_AR } from "../server/sensitiveAccess";
import { runSampleCall, type ExplorationDeps } from "./exploration";
import { MAX_PLANNER_TURNS, MAX_VALIDATION_FAILURES } from "./constants";
import { anthropicToolDefinitions, toolCatalogSearch, toolDescribeEndpoint } from "./tools";
import { addUsage, emptyUsage, plannerCostUsd, type ContentBlock, type PlannerMessage, type PlannerTransport, type PlannerUsage } from "./transport";
import { ParamSchema, ProposePlanSchema, type ValidationIssue } from "./types";
import type { RecipeRecord } from "./recipes";
import { validatePlan, type StepSample, type ValidatedPlan } from "./validate";
import { z } from "zod";

/** The sentence a customer reads when the plan cannot be completed from what they wrote (the owner-approved sentence of Phase 1). */
export const PLAN_INCOMPLETE_AR = new PlanIncompleteError([]).messageAr;
export const PLAN_UNAVAILABLE_AR = "هذه الخدمة غير متاحة حاليًا؛ ولم يُحجز أي رصيد.";

export const PLANNER_SYSTEM_PROMPT = `You are the planning engine of Diger, a research-data service for Arabic-speaking customers. The customer wrote an Arabic request for data (posts, comments, profiles, companies, people, reviews, markets…). Your job: find the right endpoint(s) in the data catalog with the tools, learn how the endpoint answers, and propose ONE plan. Code validates and prices your plan; you never state a price, a cost or a point amount.

How to work
1. catalog_search (English words, platform first), then describe_endpoint on the best candidate. Prefer the endpoint that answers the WHOLE request in one step. Two steps only when no endpoint does (a listing step, then a step run once per listed item, for example videos of a topic, then the comments of each video).
2. sample_call ONCE for the endpoint you will plan (at most two sample calls in total). An endpoint priced per call cannot be priced from the catalog's example (it is trimmed to one item): without a real sample the plan is refused. If the sample is refused for budget, end with ONE short Arabic message that it cannot be offered right now. Use only values the customer gave, quoting their exact words. Then read the real rows it returns.
3. propose_plan. Build the field map from the REAL rows: only columns a reader needs (the text, the author, the date, the counts, the link), each with a short Arabic header and a role when it fits. Dotted paths, exactly as the sample shows them.

Hard rules
- Never invent a value. Every parameter has a source: customer_text (the value is what the customer wrote; the exact words in \`quote\`), derived (made from the customer's words, for example a translation into the English word the catalog expects; the exact words in \`quote\`; never an account, link or id), literal (a fixed choice such as a sort order; NEVER an account, a link, an id or a period), or prior_step. If the customer did not give a required value (for example «فلان» instead of an account), do not call propose_plan: answer in Arabic with ONE short question.
- Never add a period (a date range, «this month», «recent») the customer did not state. No period parameter and no date_window filter unless their own words give one.
- Filters only for what the customer asked: the posts of one account (author_equals with the account they wrote; look at the sample rows for replies and reposts and exclude them with exclude_true on a flag field, or exclude_prefix on the text mark a repost starts with), a period they stated. A topic is not a filter: put the topic words in \`topic\`.
- If no endpoint fits, or the data is not offered, answer with ONE short Arabic sentence that the service is «غير متاح حاليًا». Say nothing about providers, endpoints, ids, prices or USD, and do not use markdown or emoji. Write numbers with Arabic-Indic digits.
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
  maxTurns?: number;
  /** The turn's own deadline (epoch ms): a further model turn is not started with less than 12 s left. */
  deadlineAtMs?: number;
}

export type PlannerResult =
  | { kind: "plan"; plan: ValidatedPlan }
  | { kind: "message"; messageAr: string; reason: "clarification" | "unavailable" | "incomplete" | "restricted" | "no_model" }
  | { kind: "purpose_needed"; messageAr: string };

export interface PlannerMeta { turns: number; toolCalls: number; sampleCalls: number; usage: PlannerUsage; modelCostUsd: number; explorationCostUsd: number; failures: ValidationIssue[][] }
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

/**
 * The planning loop: the model calls tools, the app answers with tool_results, until the model proposes a plan that validates, or answers the customer in words.
 * A plan that fails validation goes back as a tool_result ONCE; a second failure ends the turn with ONE Arabic sentence (a clarification when the customer's own input
 * is what is missing, else «غير متاح حاليًا») and nothing is held. Sensitive services never reach an account that may not use them (the tools never show them).
 */
export async function runPlanner(input: PlannerInput): Promise<PlannerOutcome> {
  const catalog = input.catalog ?? loadTregCatalog();
  const providers = providerNamesOf(catalog);
  const access = input.access ?? NO_SENSITIVE_ACCESS;
  const customerText = input.customerMessages.join("\n");
  const samples = new Map<string, StepSample>();
  const recipes = new Map<string, RecipeRecord>();
  const failures: ValidationIssue[][] = [];
  let usage = emptyUsage();
  let toolCalls = 0;
  let sampleCalls = 0;
  let explorationCostUsd = 0;
  let restrictedSeen = false;
  const today = input.today ?? new Date();
  const maxTurns = input.maxTurns ?? MAX_PLANNER_TURNS;
  const tools = anthropicToolDefinitions();

  const first = [`Today is ${today.toISOString().slice(0, 10)}.`, "The customer's request (Arabic):", input.customerMessages[input.customerMessages.length - 1] ?? ""].filter(Boolean).join("\n");
  const messages: PlannerMessage[] = [];
  const history = input.history ?? [];
  if (input.customerMessages.length > 1 || history.length > 0) {
    messages.push({ role: "user", content: [`Today is ${today.toISOString().slice(0, 10)}.`, "The customer's request, in their words (Arabic):", input.customerMessages[0] ?? ""].join("\n") });
    for (const h of history) messages.push({ role: h.role, content: h.text });
    if (history.length === 0 || history[history.length - 1].role === "assistant") messages.push({ role: "user", content: input.customerMessages[input.customerMessages.length - 1] ?? "" });
  } else {
    messages.push({ role: "user", content: first });
  }

  const done = (turns: number, outcome: PlannerResult): PlannerOutcome =>
    ({ ...outcome, turns, toolCalls, sampleCalls, usage, modelCostUsd: plannerCostUsd(usage), explorationCostUsd, failures });

  let turns = 0;
  while (turns < maxTurns) {
    if (input.deadlineAtMs !== undefined && input.deadlineAtMs - Date.now() < 12_000) return done(turns, { kind: "message", messageAr: PLAN_UNAVAILABLE_AR, reason: "no_model" });
    turns += 1;
    let response;
    try {
      response = await input.transport.send({ system: PLANNER_SYSTEM_PROMPT, messages, tools });
    } catch {
      return done(turns, { kind: "message", messageAr: PLAN_UNAVAILABLE_AR, reason: "no_model" });
    }
    usage = addUsage(usage, response.usage);
    const toolUses = response.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });

    if (toolUses.length === 0) {
      // the model answered the customer in words: a clarification or a «not available» sentence, made safe by code
      if (restrictedSeen) return done(turns, { kind: "message", messageAr: SENSITIVE_NOT_VERIFIED_AR, reason: "restricted" });
      const safe = customerSafeArabic(textOf(response.content), providers);
      return done(turns, { kind: "message", messageAr: safe ?? PLAN_UNAVAILABLE_AR, reason: safe ? "clarification" : "unavailable" });
    }

    const results: ContentBlock[] = [];
    let plan: ValidatedPlan | null = null;
    let endNow: PlannerOutcome | null = null;
    for (const use of toolUses) {
      toolCalls += 1;
      let content: unknown;
      let isError = false;
      if (use.name === "catalog_search") {
        const out = toolCatalogSearch(use.input as any, access, catalog);
        if (out.restrictedTop) restrictedSeen = true;
        content = { hits: out.hits, note: out.hits.length === 0 ? "no matching endpoint is available for this customer" : undefined };
      } else if (use.name === "describe_endpoint") {
        const describedId = String((use.input as any)?.id ?? "").trim();
        if (input.loadRecipe && describedId && !recipes.has(describedId)) { const r = await input.loadRecipe(describedId).catch(() => null); if (r) recipes.set(describedId, r); }
        const out = toolDescribeEndpoint(use.input as any, access, catalog, recipes.get(describedId) ?? null);
        if (!out.ok) { isError = true; content = out.message; if (out.reason === "not_allowed" && categoryOf(String((use.input as any)?.id ?? "")) === "sensitive") restrictedSeen = true; }
        else content = out.endpoint;
      } else if (use.name === "sample_call") {
        const parsed = SampleInputSchema.safeParse(use.input);
        if (!parsed.success) { isError = true; content = `invalid sample_call input: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`; }
        else if (sampleCalls >= 2) { isError = true; content = "at most two sample calls per request: plan from what you have, or end with a short Arabic message"; }
        else {
          if (categoryOf(parsed.data.id) === "sensitive" && !access.isAdmin && !access.verifiedBusiness) restrictedSeen = true;
          sampleCalls += 1;
          const out = await runSampleCall(parsed.data as any, { customerText, access, catalog, samples, today }, input.exploration);
          if (out.ok) { explorationCostUsd += out.costUsd; content = out.digest; } else { isError = true; content = out.message; }
        }
      } else if (use.name === "propose_plan") {
        const parsed = ProposePlanSchema.safeParse(use.input);
        if (!parsed.success) {
          isError = true;
          const issues: ValidationIssue[] = parsed.error.issues.slice(0, 6).map((i) => ({ code: "bad_filter" as const, message: `${i.path.join(".")}: ${i.message}` }));
          failures.push(issues);
          content = issues.map((i) => i.message).join("; ");
        } else {
          const verdict = validatePlan(parsed.data, { customerText, access, catalog, samples, recipes, purpose: input.purpose ?? null, today });
          if (verdict.ok) plan = verdict.plan;
          else {
            isError = true;
            failures.push(verdict.issues);
            if (verdict.issues.some((i) => i.code === "not_allowed") && parsed.data.steps.some((s) => categoryOf(s.endpointId) === "sensitive") && !access.isAdmin && !access.verifiedBusiness) {
              endNow = done(turns, { kind: "message", messageAr: SENSITIVE_NOT_VERIFIED_AR, reason: "restricted" });
            } else if (verdict.issues.some((i) => i.code === "sensitive_purpose")) {
              endNow = done(turns, { kind: "purpose_needed", messageAr: PURPOSE_QUESTION_AR });
            } else if (failures.length >= MAX_VALIDATION_FAILURES) {
              const needsInput = verdict.issues.some((i) => CODES_NEEDING_INPUT.has(i.code));
              endNow = done(turns, { kind: "message", messageAr: needsInput ? PLAN_INCOMPLETE_AR : PLAN_UNAVAILABLE_AR, reason: needsInput ? "incomplete" : "unavailable" });
            }
            content = verdict.issues.map((i) => `${i.stepIndex !== undefined ? `step ${i.stepIndex + 1}: ` : ""}${i.message}`).join("\n");
          }
        }
      } else {
        isError = true;
        content = `unknown tool «${use.name}»`;
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content: clipResult(content), ...(isError ? { is_error: true } : {}) });
    }
    if (plan) return done(turns, { kind: "plan", plan });
    if (endNow) return endNow;
    messages.push({ role: "user", content: results });
  }
  return done(turns, { kind: "message", messageAr: restrictedSeen ? SENSITIVE_NOT_VERIFIED_AR : PLAN_UNAVAILABLE_AR, reason: restrictedSeen ? "restricted" : "unavailable" });
}
