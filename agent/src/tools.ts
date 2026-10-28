import { AGENT_INLINE_ROWS_MAX, SANDBOX_INLINE_RESULT_CHARS } from "../../src/lib/agentMission/constants";
import { validateAndPricePlan, type PricedPlan, type RecordedCall } from "../../src/lib/agentMission/plan";
import { checkCustomerText } from "../../src/lib/agentMission/text";
import { blockedEndpointReason } from "../../src/lib/treg/blockList";
import { isSellable, type TregCatalog } from "../../src/lib/treg/catalog";
import { policyVerdict, type AccountAccess } from "../../src/lib/treg/dataPolicy";
import { digestValue } from "../../src/lib/modelPlanner/digest";
import type { Gateway } from "./gateway";
import { runInSandbox, type SandboxResult } from "./sandbox";
import type { AgentStore, CallPhase, MissionRecord } from "./types";

/**
 * The tools the agent has, and the only ones: three gateway tools (catalog_search, describe_endpoint, treg_call), the sandboxed run_code, and the mission tools (report_progress,
 * ask_question, propose_plan, save_rows, finish). Each tool is a plain async function over a `ToolContext`, so the SDK server (sdkRuntime.ts) and the tests use the SAME handlers.
 * Every rule that matters is enforced here in code, not left to the prompt.
 */
export type ParamType = "string" | "number" | "boolean" | "object" | "array" | "string[]";
export interface ParamSpec { type: ParamType; description: string; optional?: boolean }
export interface ToolSpec {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  phases: CallPhase[];
  handler: (args: Record<string, any>) => Promise<Record<string, unknown>>;
}

export interface RunState {
  proposedPlan: PricedPlan | null;
  question: string | null;
  finish: { outcome: "delivered" | "cannot_serve"; summary_ar: string } | null;
  outSeq: number;
  /** Set when the run has reached an end the model must stop at (a plan, a question, finish). */
  terminal: boolean;
}
export const newRunState = (outSeq = 0): RunState => ({ proposedPlan: null, question: null, finish: null, outSeq, terminal: false });

export interface ToolContext {
  phase: CallPhase;
  mission: MissionRecord;
  /** The approved plan (execution phase). */
  plan: PricedPlan | null;
  store: AgentStore;
  gateway: Gateway;
  catalog: TregCatalog;
  access: AccountAccess;
  state: RunState;
  sandbox?: (code: string, inputs: Record<string, unknown>) => Promise<SandboxResult>;
}

const FILE_ID = /^(call|out)_\d{4,6}$/;
const pathOfFile = (id: string) => (id.startsWith("call_") ? `raw/${id}.json` : `out/${id}.json`);
const ROWS_PATH = (stageKey: string) => `rows/${stageKey}.json`;
const outId = (n: number) => `out_${String(n).padStart(4, "0")}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const err = (error: string, extra: Record<string, unknown> = {}) => ({ ok: false, error, ...extra });

function previewOf(value: unknown): unknown {
  if (Array.isArray(value)) return { type: "array", length: value.length, first_items: value.slice(0, 5).map((v) => digestValue(v)) };
  if (isObject(value)) return { type: "object", keys: Object.keys(value).slice(0, 30), sample: digestValue(value) };
  return value;
}

/** Unique final rows of the delivered stages that were saved (each already linked to a real parent row by save_rows), never above the approved volume. */
export async function countDeliveredRows(store: AgentStore, missionId: string, plan: PricedPlan): Promise<{ delivered: number; perStage: Record<string, number> }> {
  const perStage: Record<string, number> = {};
  let delivered = 0;
  for (const stage of plan.stages) {
    const raw = await store.getFile(missionId, ROWS_PATH(stage.key));
    const rows = raw ? (JSON.parse(raw) as unknown[]) : [];
    perStage[stage.key] = rows.length;
    if (stage.deliver) delivered += rows.length;
  }
  return { delivered: Math.min(delivered, plan.price.deliveredRows), perStage };
}

export function buildTools(ctx: ToolContext): ToolSpec[] {
  const { store, mission, gateway, state } = ctx;
  const runSandbox = ctx.sandbox ?? ((code: string, inputs: Record<string, unknown>) => runInSandbox(code, inputs));

  const loadFileIds = async (ids: string[]): Promise<{ ok: true; inputs: Record<string, unknown> } | { ok: false; error: string }> => {
    const inputs: Record<string, unknown> = {};
    for (const id of ids) {
      if (!FILE_ID.test(id)) return { ok: false, error: `«${id}» is not a file id of this mission (call_0001, out_0001 ...)` };
      const text = await store.getFile(mission.id, pathOfFile(id));
      if (text === null) return { ok: false, error: `«${id}» does not exist in this mission` };
      try { inputs[id] = JSON.parse(text); } catch { return { ok: false, error: `«${id}» is not valid JSON` }; }
    }
    return { ok: true, inputs };
  };

  const tools: ToolSpec[] = [
    {
      name: "catalog_search",
      description: "Search the catalog of data sources by platform and English words (translate the customer's words). Returns candidates sorted by cost per record, cheapest first, with their required inputs. Use the ids exactly as returned.",
      phases: ["planning", "execution"],
      params: {
        words: { type: "string[]", description: "English keywords, e.g. [\"tweets\", \"search\"]" },
        platform: { type: "string", description: "Platform filter, e.g. \"x\" or \"youtube\"", optional: true },
        limit: { type: "number", description: "At most this many candidates (1 to 10)", optional: true },
      },
      handler: async (a) => ({ ok: true, ...gateway.catalogSearch({ words: Array.isArray(a.words) ? a.words.map(String) : [], platform: a.platform ? String(a.platform) : undefined, limit: Number(a.limit) || undefined }) }),
    },
    {
      name: "describe_endpoint",
      description: "The full description of one catalog endpoint: inputs (required, limits, enums), how its answer is paged, its fields, a trimmed example and how it is priced. Read it before calling an endpoint.",
      phases: ["planning", "execution"],
      params: { id: { type: "string", description: "Endpoint id exactly as catalog_search returned it" } },
      handler: async (a) => gateway.describeEndpoint({ id: String(a.id ?? "") }),
    },
    {
      name: "treg_call",
      description: "Make ONE real call to a catalog endpoint. The full answer is saved (its call id is returned) and you get a shape digest and the first rows only. Code refuses calls that are blocked, sensitive, over the mission's budget or over the provider's daily limit; a refused call costs nothing. Process the saved page with run_code.",
      phases: ["planning", "execution"],
      params: {
        endpoint_id: { type: "string", description: "Endpoint id exactly as catalog_search returned it" },
        params: { type: "object", description: "The endpoint's inputs as an object, e.g. {\"query\": \"...\", \"limit\": 20}. Page with the cursor input the description names." },
        purpose: { type: "string", description: "Only for a personal-data lookup: why the customer needs it", optional: true },
      },
      handler: async (a) => ({ ...(await gateway.tregCall({ endpoint_id: a.endpoint_id, params: a.params, purpose: a.purpose })) }),
    },
    {
      name: "run_code",
      description: "Run JavaScript in an isolated sandbox on files of THIS mission (saved pages call_0001..., earlier outputs out_0001...). No network, no environment, no secrets, a time limit and a memory limit. Your code is the body of a function: the files arrive as the object `inputs` (inputs.call_0001 is the parsed page) and you `return` a JSON-serialisable value (rows, counts, ids). The returned value is saved as a new output file (id returned) that you can pass to later run_code calls or to save_rows.",
      phases: ["planning", "execution"],
      params: {
        code: { type: "string", description: "Function body. Example: const rows = inputs.call_0001.data.items; return rows.map(r => ({id: String(r.id), text: r.text}));" },
        files: { type: "string[]", description: "Ids of the files to load into `inputs`, e.g. [\"call_0001\"]" },
      },
      handler: async (a) => {
        const code = String(a.code ?? "");
        if (!code.trim()) return err("code is empty");
        const files = Array.isArray(a.files) ? a.files.map(String) : [];
        if (files.length > 30) return err("at most 30 files per run");
        const loaded = await loadFileIds(files);
        if (!loaded.ok) return err(loaded.error);
        const result = await runSandbox(code, loaded.inputs);
        if (!result.ok) return err(result.error, { logs: result.logs.slice(0, 20) });
        if (result.resultJson === null) return { ok: true, output_id: null, note: "the code returned nothing (return a value)", logs: result.logs.slice(0, 20) };
        state.outSeq += 1;
        const id = outId(state.outSeq);
        await store.putFile(mission.id, `out/${id}.json`, result.resultJson, "application/json");
        const value = JSON.parse(result.resultJson) as unknown;
        const inline = result.resultJson.length <= SANDBOX_INLINE_RESULT_CHARS;
        return { ok: true, output_id: id, size_chars: result.resultJson.length, ...(inline ? { result: value } : { preview: previewOf(value), note: "the result is large: only a preview is shown; the whole output is saved under output_id" }), logs: result.logs.slice(0, 20) };
      },
    },
    {
      name: "report_progress",
      description: "Tell the customer's live panel what you are doing: ONE short line in Arabic (Arabic-Indic digits, no provider names, no endpoint ids, no dollar amounts) and optional counts. Call it at every real step.",
      phases: ["planning", "execution"],
      params: {
        message_ar: { type: "string", description: "One Arabic line" },
        counts: { type: "object", description: "Optional numbers, e.g. {\"pages\": 3, \"rows\": 120}", optional: true },
      },
      handler: async (a) => {
        const checked = checkCustomerText(a.message_ar, { maxChars: 240 });
        if (checked.issues.length) return err(`rephrase the line: ${checked.issues.join("; ")}`);
        const counts: Record<string, number> = {};
        if (isObject(a.counts)) for (const [k, v] of Object.entries(a.counts).slice(0, 10)) if (typeof v === "number" && Number.isFinite(v)) counts[k.slice(0, 40)] = v;
        await store.addEvent(mission.id, { kind: "progress", message_ar: checked.text, counts });
        return { ok: true };
      },
    },
    {
      name: "ask_question",
      description: "When something ESSENTIAL to the mission is missing and cannot be found in the catalog or the data, ask the customer ONE question in Arabic and stop. Use it at most once, and only in the planning phase.",
      phases: ["planning"],
      params: { question_ar: { type: "string", description: "One Arabic question" } },
      handler: async (a) => {
        if (state.question !== null) return err("you already asked your one question");
        const checked = checkCustomerText(a.question_ar, { maxChars: 300 });
        if (checked.issues.length) return err(`rephrase the question: ${checked.issues.join("; ")}`);
        state.question = checked.text;
        state.terminal = true;
        await store.addEvent(mission.id, { kind: "question", message_ar: checked.text });
        return { ok: true, note: "the question was shown to the customer; stop now" };
      },
    },
    {
      name: "propose_plan",
      description: "Propose the plan: 1 to 4 stages (a stage runs once per row of its parent stage), the rows each is expected to give, the columns of each stage's rows (Arabic titles), 1 to 3 sample rows you really saw, and the ids of the saved calls that measured each stage (measured_by). You never state a price: the site computes it from the measured charges. Rejected plans come back with the exact issues to fix.",
      phases: ["planning"],
      params: {
        summary_ar: { type: "string", description: "Two or three Arabic sentences: what the customer will get and how the files link" },
        stages: { type: "array", description: "[{key, title_ar, endpoint_id, expected_rows, parent_key|null, per_parent_rows (if parent), deliver, columns:[{key,title_ar}], sample_rows:[{...}], measured_by:[call ids], how_ar?}]" },
      },
      handler: async (a) => {
        const stagesIn: any[] = Array.isArray(a.stages) ? a.stages : [];
        const ids = new Set<string>();
        for (const s of stagesIn) if (s && Array.isArray(s.measured_by)) for (const id of s.measured_by) ids.add(String(id));
        const calls = await store.listCalls(mission.id);
        const evidence = new Map<string, string | null>();
        for (const id of ids) evidence.set(id, FILE_ID.test(id) ? await store.getFile(mission.id, pathOfFile(id)) : null);
        const lookup = {
          call: (id: string): RecordedCall | null => {
            const row = calls.find((c) => c.id === `${mission.id}:${id}`);
            return row ? { id, endpointId: row.endpoint_id, ok: row.status === "ok", costUsd: Number(row.cost_usd) || 0, rows: Number(row.rows_returned) || 0 } : null;
          },
          evidenceText: (id: string) => evidence.get(id) ?? null,
          endpointAllowed: (endpointId: string) => isSellable(endpointId, ctx.catalog) && !blockedEndpointReason(endpointId) && policyVerdict(endpointId, ctx.access).allowed,
        };
        const checked = validateAndPricePlan({ summary_ar: a.summary_ar, stages: stagesIn }, lookup);
        if (!checked.ok) return err("the plan was not accepted; fix these and propose again", { issues: checked.issues.slice(0, 12) });
        state.proposedPlan = checked.plan;
        state.terminal = true;
        await store.updateMission(mission.id, { plan: checked.plan as any });
        return { ok: true, note: "the plan was recorded; the site computes the price and shows it to the customer. Stop now." };
      },
    },
    {
      name: "save_rows",
      description: "Save FINAL rows of one stage of the approved plan. Each row needs a stable `id` and, for a stage with a parent, the `parent_id` of a row of the parent stage that is ALREADY saved (save parents first). Give rows from a run_code output (from_output) or inline (at most 200). Duplicates (same id) are ignored; rows beyond the stage's approved volume are refused.",
      phases: ["execution"],
      params: {
        stage_key: { type: "string", description: "The key of the stage in the approved plan" },
        from_output: { type: "string", description: "An output id from run_code holding an array of rows", optional: true },
        rows: { type: "array", description: "Rows inline (small sets only)", optional: true },
      },
      handler: async (a) => {
        const plan = ctx.plan;
        if (!plan) return err("there is no approved plan");
        const stage = plan.stages.find((s) => s.key === String(a.stage_key ?? ""));
        if (!stage) return err(`unknown stage; the stages are: ${plan.stages.map((s) => s.key).join(", ")}`);
        let incoming: unknown[];
        if (a.from_output) {
          const id = String(a.from_output);
          if (!/^out_\d{4,6}$/.test(id)) return err("from_output must be an output id returned by run_code");
          const text = await store.getFile(mission.id, `out/${id}.json`);
          if (text === null) return err(`«${id}» does not exist in this mission`);
          const parsed = JSON.parse(text) as unknown;
          if (!Array.isArray(parsed)) return err("the output is not an array of rows");
          incoming = parsed;
        } else if (Array.isArray(a.rows)) {
          if (a.rows.length > AGENT_INLINE_ROWS_MAX) return err(`at most ${AGENT_INLINE_ROWS_MAX} rows inline; put larger sets in a run_code output and use from_output`);
          incoming = a.rows;
        } else return err("give from_output or rows");

        const existingRaw = await store.getFile(mission.id, ROWS_PATH(stage.key));
        const existing: Array<Record<string, unknown>> = existingRaw ? JSON.parse(existingRaw) : [];
        const have = new Set(existing.map((r) => String(r.id)));
        let parentIds: Set<string> | null = null;
        if (stage.parent_key !== null) {
          const parentRaw = await store.getFile(mission.id, ROWS_PATH(stage.parent_key));
          parentIds = new Set((parentRaw ? (JSON.parse(parentRaw) as Array<Record<string, unknown>>) : []).map((r) => String(r.id)));
        }
        const columnKeys = stage.columns.map((c) => c.key);
        const tally = { saved_now: 0, duplicates_ignored: 0, rejected_missing_id: 0, rejected_unknown_parent: 0, rejected_over_limit: 0, rejected_not_object: 0 };
        for (const raw of incoming) {
          if (!isObject(raw)) { tally.rejected_not_object += 1; continue; }
          const id = String(raw.id ?? "").trim();
          if (!id) { tally.rejected_missing_id += 1; continue; }
          if (have.has(id)) { tally.duplicates_ignored += 1; continue; }
          let parentId: string | null = null;
          if (parentIds) {
            parentId = String(raw.parent_id ?? "").trim();
            if (!parentId || !parentIds.has(parentId)) { tally.rejected_unknown_parent += 1; continue; }
          }
          if (existing.length >= stage.planned_rows) { tally.rejected_over_limit += 1; continue; }
          const row: Record<string, unknown> = { id, ...(parentId !== null ? { parent_id: parentId } : {}) };
          for (const k of columnKeys) if (k !== "id" && k !== "parent_id") row[k] = raw[k] ?? "";
          existing.push(row);
          have.add(id);
          tally.saved_now += 1;
        }
        await store.putFile(mission.id, ROWS_PATH(stage.key), JSON.stringify(existing), "application/json");
        return { ok: true, stage: stage.key, ...tally, total_in_stage: existing.length, stage_limit: stage.planned_rows };
      },
    },
    {
      name: "finish",
      description: "End the mission. outcome \"delivered\": everything you could save is saved (execution phase). outcome \"cannot_serve\": the sources cannot serve this honestly. summary_ar is what the customer reads: Arabic, Arabic-Indic digits, honest about what was and was not delivered, no provider names or technical ids.",
      phases: ["planning", "execution"],
      params: {
        outcome: { type: "string", description: "\"delivered\" or \"cannot_serve\"" },
        summary_ar: { type: "string", description: "The Arabic summary" },
      },
      handler: async (a) => {
        const outcome = String(a.outcome ?? "");
        if (outcome !== "delivered" && outcome !== "cannot_serve") return err("outcome must be \"delivered\" or \"cannot_serve\"");
        if (ctx.phase === "planning" && outcome !== "cannot_serve") return err("while planning, finish only to say the mission cannot be served; otherwise call propose_plan");
        const checked = checkCustomerText(a.summary_ar, { maxChars: 800 });
        if (checked.issues.length) return err(`rephrase the summary: ${checked.issues.join("; ")}`);
        state.finish = { outcome, summary_ar: checked.text };
        state.terminal = true;
        return { ok: true, note: "recorded; stop now" };
      },
    },
  ];
  return tools.filter((t) => t.phases.includes(ctx.phase));
}

export const TOOL_NAMES = ["catalog_search", "describe_endpoint", "treg_call", "run_code", "report_progress", "ask_question", "propose_plan", "save_rows", "finish"] as const;
