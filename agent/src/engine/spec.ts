import type { EngineSpec, PricedPlan } from "../../../src/lib/agentMission/plan";
import { proveMappedRows } from "../../../src/lib/agentMission/contract";
import { findFilterFields, refitFilters, type StageFilter } from "../../../src/lib/agentMission/filters";
import type { TregCatalog } from "../../../src/lib/treg/catalog";
import type { SandboxResult } from "../sandbox";
import type { AgentStore, CallRow } from "../types";

/**
 * DERIVING WHAT CODE NEEDS TO EXECUTE A PLAN (the model plans, code executes). At plan time the agent has really done, for each stage: one measuring call (its inputs, its saved page) and one run_code that mapped that
 * page to the stage's columns (its output is the stage's `yield_from` or one of its `measured_by`). Code takes those as the stage's execution recipe, and PROVES it before trusting it: the recorded mapping code is run
 * again, now, on the very page it was written for, and must give exactly the rows the agent saw. A stage whose recipe cannot be proven (a mapping over several pages, a source the catalog does not page, a binding
 * to a parent that cannot be read off the evidence) simply has no `engine`, and the model carries that mission out (through the same item store, with the same checks and the same settlement). Nothing is guessed.
 */
export interface CodeRun { code: string; files: string[] }
export const codeRunPath = (outId: string): string => `out/${outId}.code.json`;

const LIMIT_INPUT = /^(limit|count|page_size|pagesize|per_page|perpage|size|num|max_results|maxresults|max_items|maxitems|n)$/i;
const FILE_ID = /^(call|out)_\d{4,6}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const canon = (v: unknown): string => JSON.stringify(v);

export interface DeriveDeps {
  store: AgentStore;
  missionId: string;
  catalog: TregCatalog;
  calls: CallRow[];
  /** The code the agent ran in this run, by output id (the persisted copy is read when this run did not make the output). */
  codeRuns: ReadonlyMap<string, CodeRun>;
  /** The full inputs of the measuring calls of this run (the call log keeps short values only). */
  callParams: ReadonlyMap<string, Record<string, unknown>>;
  sandbox: (code: string, inputs: Record<string, unknown>) => Promise<SandboxResult>;
}

async function readCodeRun(deps: DeriveDeps, outId: string): Promise<CodeRun | null> {
  const mem = deps.codeRuns.get(outId);
  if (mem) return mem;
  try {
    const raw = await deps.store.getFile(deps.missionId, codeRunPath(outId));
    const o = raw ? (JSON.parse(raw) as Partial<CodeRun>) : null;
    return o && typeof o.code === "string" && Array.isArray(o.files) ? { code: o.code, files: o.files.map(String) } : null;
  } catch { return null; }
}

/** The inputs of a measuring call as recorded: complete only when no value was cut by the call log (a short-value digest). */
function paramsOfCall(deps: DeriveDeps, callId: string): Record<string, unknown> | null {
  const full = deps.callParams.get(callId);
  const source = full ?? deps.calls.find((c) => c.id === `${deps.missionId}:${callId}`)?.params_digest ?? null;
  if (!source) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith("_")) continue;
    // the call log cuts long text: a digest with a value at the cut length cannot be trusted as the real input
    if (!full && typeof v === "string" && v.length >= 80) return null;
    out[k] = v;
  }
  return out;
}

/** What the plan check gets from the proof: the recipes, the filters with their fields found from what the mapping really gives, and the CONTRACT issues (what the engine or the file needs that the mapping does not give): a plan with an issue is refused. */
export interface DerivedSpecs { specs: Map<string, EngineSpec>; filters: Map<string, StageFilter[]>; issues: string[] }

export async function deriveEngineSpecs(plan: PricedPlan, deps: DeriveDeps): Promise<Map<string, EngineSpec>> {
  return (await deriveEngineSpecsChecked(plan, deps)).specs;
}

export async function deriveEngineSpecsChecked(plan: PricedPlan, deps: DeriveDeps): Promise<DerivedSpecs> {
  const specs = new Map<string, EngineSpec>();
  const filtersOut = new Map<string, StageFilter[]>();
  const issues: string[] = [];
  const mappedRows = new Map<string, Array<Record<string, unknown>>>();
  for (const stage of plan.stages) {
    let contractIssues: string[] | null = null;
    const endpoint = deps.catalog.byId.get(stage.endpoint_id);
    if (!endpoint) continue;
    // the outputs the stage cites, then every output of this run made from ONE of the stage's measuring calls (the newest first): the mapping the agent ran on the measured page
    const cited = [stage.yield_from, ...stage.measured_by].filter((x): x is string => typeof x === "string" && /^out_\d{4,6}$/.test(x));
    const fromMeasured = [...deps.codeRuns.entries()].filter(([, r]) => r.files.length === 1 && stage.measured_by.includes(r.files[0])).map(([id]) => id).sort().reverse();
    for (const outId of [...new Set([...cited, ...fromMeasured])]) {
      const run = await readCodeRun(deps, outId);
      if (!run || run.files.length !== 1 || !FILE_ID.test(run.files[0]) || !run.files[0].startsWith("call_")) continue;
      const callId = run.files[0];
      const row = deps.calls.find((c) => c.id === `${deps.missionId}:${callId}`);
      if (!row || row.endpoint_id !== stage.endpoint_id || row.status !== "ok" || !stage.measured_by.includes(callId)) continue;
      const params = paramsOfCall(deps, callId);
      if (!params) continue;
      // the proof: the recorded code, run now on the very page it was written for, gives exactly the rows the agent saw
      const [page, seen] = await Promise.all([deps.store.getFile(deps.missionId, `raw/${callId}.json`), deps.store.getFile(deps.missionId, `out/${outId}.json`)]);
      if (page === null || seen === null) continue;
      let pageJson: unknown;
      let seenJson: unknown;
      try { pageJson = JSON.parse(page); seenJson = JSON.parse(seen); } catch { continue; }
      if (!Array.isArray(seenJson) || seenJson.length === 0 || !seenJson.every(isRecord)) continue;
      // the mapping must cover EVERY row of the page the call returned (a mapping of the first few rows, a filter inside the code, would make the engine deliver a fraction of each page): else the model carries this mission out
      if (seenJson.length !== Number(row.rows_returned ?? -1)) continue;
      const again = await deps.sandbox(run.code, { [callId]: pageJson });
      if (!again.ok || again.resultJson === null) continue;
      let againJson: unknown;
      try { againJson = JSON.parse(again.resultJson); } catch { continue; }
      if (canon(againJson) !== canon(seenJson)) continue;
      // THE CONTRACT: the mapped items must give what the engine and the file need (an id or a key to derive one, every column the card promises, every field a promised filter reads). Checked on this very page, before approval.
      const label = `stage «${stage.key}»`;
      const mapped = seenJson as Array<Record<string, unknown>>;
      const mappedKeys = [...new Set(mapped.flatMap((r) => Object.keys(r)))];
      const fields = findFilterFields({ mappedKeys, columnKeys: stage.columns.map((c) => c.key), textColumns: stage.relevance?.text_columns, columnTitles: Object.fromEntries(stage.columns.map((c) => [c.key, c.title_ar])) });
      const refit = refitFilters(stage.filters ?? [], fields, mappedKeys, label);
      const proof = proveMappedRows({ rows: mapped, columnKeys: stage.columns.map((c) => c.key), textColumns: stage.relevance?.text_columns, filters: refit.filters, label });
      const problems = [...refit.issues, ...proof.issues];
      if (problems.length > 0) { contractIssues = problems; continue; }
      const cursorParam = (endpoint.pagination ?? []).find((p) => !LIMIT_INPUT.test(p)) ?? null;
      let binding: EngineSpec["parent_binding"] = null;
      if (stage.parent_key !== null) {
        const parentRows = [...(mappedRows.get(stage.parent_key) ?? []), ...(plan.stages.find((s) => s.key === stage.parent_key)?.sample_rows ?? [])];
        const found = parentBinding(params, parentRows);
        if (!found) continue;
        binding = found;
        delete params[found.param];
      }
      specs.set(stage.key, { endpoint_id: stage.endpoint_id, params, cursor_param: cursorParam, map_code: run.code, map_file_id: callId, parent_binding: binding, ...(proof.idField !== "id" ? { id_field: proof.idField } : {}) });
      filtersOut.set(stage.key, refit.filters);
      mappedRows.set(stage.key, seenJson as Array<Record<string, unknown>>);
      contractIssues = null;
      break;
    }
    // a mapping that was proven to reproduce what the agent saw but breaks the contract is refused (never silently handed to the model: the customer would approve a card the file cannot match)
    if (contractIssues && !specs.has(stage.key)) issues.push(...contractIssues);
  }
  return { specs, filters: filtersOut, issues };
}

/** Which input of the child's measuring call is a field of a parent row (a value that equals the parent's own id, or one of its columns)? Exactly one input may bind, and it must bind to one field: else no recipe. */
export function parentBinding(params: Record<string, unknown>, parentRows: Array<Record<string, unknown>>): { param: string; from: string } | null {
  const found: Array<{ param: string; from: string }> = [];
  for (const [param, value] of Object.entries(params)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    if (LIMIT_INPUT.test(param)) continue;
    const text = String(value);
    if (text.length < 3) continue;
    const fields = new Set<string>();
    for (const row of parentRows) for (const [field, v] of Object.entries(row)) if ((typeof v === "string" || typeof v === "number") && String(v) === text) fields.add(field);
    if (fields.size === 0) continue;
    found.push({ param, from: fields.has("id") ? "id" : [...fields].sort()[0] });
  }
  return found.length === 1 ? found[0] : null;
}
