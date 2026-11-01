import type { EngineSpec, PricedPlan } from "../../../src/lib/agentMission/plan";
import { proveMappedRows } from "../../../src/lib/agentMission/contract";
import { CHILD_RAW_FILTER_KINDS, filterVerdict, findFilterFields, isEnabled, refitFilters, type StageFilter } from "../../../src/lib/agentMission/filters";
import { alternativesOf, nameWords, sourceNameMatches, unresolvedSources } from "../../../src/lib/agentMission/namedSources";
import { onlyTimesAdded, withoutDayCut } from "../../../src/lib/agentMission/dateLoss";
import { dateWindowOf } from "../../../src/lib/agentMission/dateWindow";
import { isListingEndpoint } from "../../../src/lib/agentMission/namedRoutes";
import { looksLikeDateColumn } from "../../../src/lib/agentMission/dateCells";
import { isRelativeAge } from "../../../src/lib/agentMission/relativeDates";
import { placeAskedOfSource } from "../../../src/lib/agentMission/places";
import { buildToolInput, understoodOfStage, type Gap } from "../../../src/lib/agentMission/toolInput";
import { discoverCursor } from "../../../src/lib/agentMission/toolProfile";
import type { CatalogEndpoint, TregCatalog } from "../../../src/lib/treg/catalog";
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
  /** The redesigned mode (S1 item 1.6): the request of each stage is built by code from the tool's own fields and the stage's typed filters. Absent: the model's measured inputs are frozen as they were (the old path, byte for byte). */
  codeBuild?: { nowMs: number };
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
export interface DerivedSpecs {
  specs: Map<string, EngineSpec>;
  filters: Map<string, StageFilter[]>;
  issues: string[];
  /** The named sources (channels, pages, accounts the customer wrote) of a stage that no item of what the agent sampled belongs to: the card says so before approval. */
  unresolved: Map<string, string[]>;
  /** The date columns of a stage in which the source gives only a relative time («قبل ٣ أيام»): the dates are approximate and the card says so. */
  approx: Map<string, string[]>;
  /** The conditions a stage's tool cannot carry, when the request was built by code (S1 items 1.6 and 1.7). */
  gaps: Map<string, Gap[]>;
}

export async function deriveEngineSpecs(plan: PricedPlan, deps: DeriveDeps): Promise<Map<string, EngineSpec>> {
  return (await deriveEngineSpecsChecked(plan, deps)).specs;
}

export async function deriveEngineSpecsChecked(plan: PricedPlan, deps: DeriveDeps): Promise<DerivedSpecs> {
  const specs = new Map<string, EngineSpec>();
  const filtersOut = new Map<string, StageFilter[]>();
  const issues: string[] = [];
  const unresolved = new Map<string, string[]>();
  const approx = new Map<string, string[]>();
  const gapsOut = new Map<string, Gap[]>();
  const mappedRows = new Map<string, Array<Record<string, unknown>>>();
  for (const stage of plan.stages) {
    // every row the agent really saw for this stage (the proven page, the other measuring calls mapped with the same code, the sample rows it listed): what a named source is looked for in
    const seenRows: Array<Record<string, unknown>> = [...stage.sample_rows];
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
      // THE SOURCE'S TIME IS KEPT: a mapping that cuts a timestamp to its day (`.toISOString().slice(0,10)`) is repaired, and the repair is proven on this very page (the same rows, only times added to days)
      let mapCode = run.code;
      let mapped = seenJson as Array<Record<string, unknown>>;
      const uncut = withoutDayCut(run.code);
      if (uncut) {
        const fixed = await deps.sandbox(uncut, { [callId]: pageJson });
        if (fixed.ok && fixed.resultJson !== null) {
          try { const rows = JSON.parse(fixed.resultJson) as unknown; if (Array.isArray(rows) && rows.every(isRecord) && onlyTimesAdded(mapped, rows)) { mapCode = uncut; mapped = rows; } } catch { /* the mapping stays as it was */ }
        }
      }
      const mappedKeys = [...new Set(mapped.flatMap((r) => Object.keys(r)))];
      const fields = findFilterFields({ mappedKeys, columnKeys: stage.columns.map((c) => c.key), textColumns: stage.relevance?.text_columns, columnTitles: Object.fromEntries(stage.columns.map((c) => [c.key, c.title_ar])) });
      const refitAll = refitFilters(stage.filters ?? [], fields, mappedKeys, label);
      // the items of a child stage are raw: the language and the place are not offered on it (the customer's editor shows only what code applies)
      const refit = { ...refitAll, filters: (stage.parent_key === null ? refitAll.filters : refitAll.filters.filter((f) => !CHILD_RAW_FILTER_KINDS.includes(f.kind))).map((f) => (f.kind === "place" && (f.places?.length ?? 0) > 0 ? (placeAskedOfSource(f.places!, params) ? { ...f, by_source: true } : (({ by_source: _drop, ...rest }) => rest)(f)) : f)) };
      const proof = proveMappedRows({ rows: mapped, columnKeys: stage.columns.map((c) => c.key), textColumns: stage.relevance?.text_columns, filters: refit.filters, label });
      // THE PLACE THE CARD PROMISES must be provable on the measured page: at least one of its items carries evidence of it (else the plan promises a place no item of this source can show)
      const placeIssues = refit.filters.filter((f) => isEnabled(f) && f.kind === "place" && (f.places?.length ?? 0) > 0 && !mapped.some((r) => filterVerdict([f], r, { textKey: null, now: 0 }) === null)).map((f) => `${label}: the card promises items in ${(f.values ?? []).join("، ")}, but none of the ${mapped.length} items of the measured page carries evidence of it in a mapped field (${(f.fields ?? []).join(", ") || "none"}); map the country, city, address, website or phone field of every item, or sample a source that gives one`);
      const problems = [...refit.issues, ...proof.issues, ...placeIssues];
      if (problems.length > 0) { contractIssues = problems; continue; }
      seenRows.push(...mapped);
      // every measured page of this stage, mapped with the same code, with the inputs it was read with (a named source may be the one a given page shows)
      const pages: MeasuredPage[] = [{ id: callId, params, rows: mapped }];
      // the other measuring calls of this stage, read with the same mapping (a named source may only show in one of them)
      for (const otherId of stage.measured_by.filter((m) => /^call_\d{4,6}$/.test(m) && m !== callId)) {
        const orow = deps.calls.find((c) => c.id === `${deps.missionId}:${otherId}`);
        if (!orow || orow.endpoint_id !== stage.endpoint_id || orow.status !== "ok") continue;
        try {
          const other = await deps.store.getFile(deps.missionId, `raw/${otherId}.json`);
          if (other === null) continue;
          const again2 = await deps.sandbox(mapCode, { [callId]: JSON.parse(other) });
          if (!again2.ok || again2.resultJson === null) continue;
          const rows2 = JSON.parse(again2.resultJson) as unknown;
          if (Array.isArray(rows2)) {
            seenRows.push(...rows2.filter(isRecord));
            const p2 = paramsOfCall(deps, otherId);
            if (p2) pages.push({ id: otherId, params: p2, rows: rows2.filter(isRecord) });
          }
        } catch { /* a page the mapping cannot read adds nothing */ }
      }
      // A SINGLE RECORDED QUERY CANNOT SERVE SEVERAL NAMED SOURCES: a stage that must give items of three named channels, whose measuring call searched for one of them, would deliver that one only. Such a stage has no recipe: the model
      // searches every named source (one search each) and the same checks keep only the named ones.
      const named = refit.filters.find((f) => isEnabled(f) && f.kind === "account" && (f.values ?? []).length >= 2);
      // the cursor input: the endpoint's own paging list; in the redesigned mode, else the paging input of its inputs that this very page proves (S1 item 1.8)
      const cursorParam = (endpoint.pagination ?? []).find((p) => !LIMIT_INPUT.test(p)) ?? (deps.codeBuild ? discoverCursor(endpoint, pageJson) : null);
      // ...unless every named source was read by a measuring call of its own (its own query, or the source's own listing of its items): the engine then reads each of them in turn, each up to its share
      let sources: EngineSpec["sources"] | undefined;
      const listing = stage.parent_key === null && isListingEndpoint(endpoint);
      if (named && !namedSourcesInQuery(params, named.values ?? [])) {
        const perSource = sourcesFromPages(named, pages, cursorParam, listing);
        if (!perSource) continue;
        sources = perSource;
      } else if (listing && stage.parent_key === null) {
        // ONE named source read by its own listing (a channel's videos): the engine reads it as that source, so items with no author of their own belong to it
        const one = refit.filters.find((f) => isEnabled(f) && f.kind === "account" && (f.values ?? []).length === 1);
        if (one) sources = [{ names: [one.values![0]], params }];
      }
      let binding: EngineSpec["parent_binding"] = null;
      if (stage.parent_key !== null) {
        const parentRows = [...(mappedRows.get(stage.parent_key) ?? []), ...(plan.stages.find((s) => s.key === stage.parent_key)?.sample_rows ?? [])];
        const found = parentBinding(params, parentRows);
        if (!found) continue;
        const fallbacks = bindingFallbacks(endpoint, found, parentRows);
        // EVERY IDENTITY INPUT THE SOURCE TAKES goes in the same call (the id AND the link): the ones the measuring call passed, else the ones the parent's rows can give
        const also = found.also ?? bindingAlso(endpoint, found, parentRows);
        binding = { param: found.param, from: found.from, ...(also.length > 0 ? { also } : {}), ...(fallbacks.length > 0 ? { fallbacks } : {}) };
        delete params[found.param];
        for (const a of also) delete params[a.param];
      }
      // THE REQUEST BUILT BY CODE (S1 item 1.6, only in the redesigned mode): the customer's conditions are written into the tool's own fields; a stage whose inputs are not all real inputs of the endpoint keeps the model's request and is NOT marked as built by code
      let builtBy: "code" | "model" | undefined;
      let stageGaps: Gap[] = [];
      if (deps.codeBuild && !sources) {
        const built = buildToolInput(endpoint, understoodOfStage(stage, deps.codeBuild.nowMs), params);
        builtBy = built.ok ? "code" : "model";
        if (built.ok) { for (const k of Object.keys(params)) delete params[k]; Object.assign(params, built.params); stageGaps = built.gaps; }
      }
      // a source with no next page and a flat price per call is asked for everything its limit allows (a lower limit only makes the one answer smaller)
      const lifted = stage.parent_key === null && !sources ? liftedVolume(endpoint, params) : null;
      if (lifted) params[lifted.param] = lifted.to;
      const window = stage.parent_key === null && !sources ? dateWindowOf(endpoint, params) : null;
      specs.set(stage.key, { endpoint_id: stage.endpoint_id, params, cursor_param: cursorParam, map_code: mapCode, map_file_id: callId, parent_binding: binding, ...(proof.idField !== "id" ? { id_field: proof.idField } : {}), ...(window ? { window } : {}), ...(sources ? { sources } : {}), ...(sources && listing ? { source_listing: true } : {}), ...(builtBy ? { built_by: builtBy } : {}), ...(stageGaps.length > 0 ? { gaps: stageGaps } : {}) });
      if (stageGaps.length > 0) gapsOut.set(stage.key, stageGaps);
      filtersOut.set(stage.key, refit.filters);
      mappedRows.set(stage.key, mapped);
      contractIssues = null;
      break;
    }
    // a mapping that was proven to reproduce what the agent saw but breaks the contract is refused (never silently handed to the model: the customer would approve a card the file cannot match)
    if (contractIssues && !specs.has(stage.key)) issues.push(...contractIssues);
    // THE SOURCE GIVES ONLY A RELATIVE TIME («قبل ٣ أيام») in a date column: the dates of the file are approximate, and the card says so before approval
    const relativeColumns = stage.columns.filter((c) => looksLikeDateColumn(c.title_ar, c.key) && seenRows.some((r) => isRelativeAge(r[c.key]))).map((c) => c.key);
    if (relativeColumns.length > 0) approx.set(stage.key, relativeColumns);
    // THE NAMED SOURCES THE CUSTOMER WROTE must be found in what was sampled: one that no sampled item belongs to is told on the card before approval
    const account = (filtersOut.get(stage.key) ?? stage.filters ?? []).find((f) => isEnabled(f) && f.kind === "account" && (f.values ?? []).length > 0);
    if (account && stage.parent_key === null) {
      const authorFields = [account.field, ...(account.fields ?? [])].filter((k): k is string => typeof k === "string");
      const authors = authorFields.flatMap((field) => seenRows.map((r) => r[field])).filter((v) => v !== undefined && v !== null);
      // a source read by its own listing (a channel's videos) is found by the very call that listed it, though the listing's items name no author
      const listed = isListingEndpoint(endpoint) ? new Set(specs.get(stage.key)?.sources?.flatMap((e) => e.names) ?? []) : new Set<string>();
      const missing = unresolvedSources(account.values ?? [], authors).filter((v) => !listed.has(v));
      if (missing.length > 0) unresolved.set(stage.key, missing);
    }
  }
  return { specs, filters: filtersOut, issues, unresolved, approx, gaps: gapsOut };
}

interface MeasuredPage { id: string; params: Record<string, unknown>; rows: Array<Record<string, unknown>> }

/** True when none of the rows names its author in any of the fields (a source's own listing gives the items of one source and no author). */
const authorless = (rows: ReadonlyArray<Record<string, unknown>>, fields: ReadonlyArray<string>): boolean => rows.length > 0 && rows.every((r) => fields.every((f) => !String(r[f] ?? "").trim()));

/**
 * THE INPUTS THAT READ EACH NAMED SOURCE. For every source the customer named, the measured page that SHOWS items of it (the one with the most of them): its inputs are that source's first-page inputs. The planner may also DECLARE the call that read a source
 * (`calls`, in the order of the values): trusted when the page's items do not contradict it (a page whose items name an author that is none of the named source is not that source's listing; a page that names no author at all, a source's own listing, is). A page read from
 * a later position (a cursor was set) is never a first page. One page that shows several named sources serves them all (they share one entry); an entry of ONE name reads that source's own listing, so its items with no author belong to it. Null when a named source is read
 * by no measured page: the stage has no recipe, and the model carries it out.
 */
export function sourcesFromPages(named: StageFilter, pages: ReadonlyArray<MeasuredPage>, cursorParam: string | null, listing = false): Array<{ names: string[]; params: Record<string, unknown> }> | null {
  const fields = [named.field, ...(named.fields ?? [])].filter((k): k is string => typeof k === "string");
  const first = (p: MeasuredPage) => !(cursorParam && p.params[cursorParam] !== undefined && p.params[cursorParam] !== "" && p.params[cursorParam] !== null);
  const entries = new Map<string, { names: string[]; params: Record<string, unknown> }>();
  (named.values ?? []).forEach((value, k) => {
    let chosen: MeasuredPage | null = null;
    const declared = named.calls?.[k] ? pages.find((p) => p.id === named.calls![k]) : undefined;
    if (declared && first(declared) && (declared.rows.some((r) => fields.some((f) => sourceNameMatches(value, r[f]))) || (listing && authorless(declared.rows, fields)))) chosen = declared;
    if (!chosen) {
      let bestN = 0;
      for (const p of pages) {
        if (!first(p)) continue;
        const n = p.rows.filter((r) => fields.some((f) => sourceNameMatches(value, r[f]))).length;
        if (n > bestN) { chosen = p; bestN = n; }
      }
    }
    if (!chosen) return;
    const key = canon(chosen.params);
    const entry = entries.get(key);
    if (entry) entry.names.push(value); else entries.set(key, { names: [value], params: chosen.params });
  });
  const served = new Set([...entries.values()].flatMap((e) => e.names));
  return (named.values ?? []).every((v) => served.has(v)) ? [...entries.values()] : null;
}

/** True when the first-page inputs of the recorded query already name every named source (one query serves them all, as «from:a OR from:b» does), or when the inputs carry no free text to name them in. */
export function namedSourcesInQuery(params: Record<string, unknown>, values: ReadonlyArray<string>): boolean {
  const text = Object.values(params).filter((v): v is string => typeof v === "string").join(" ");
  const have = new Set(nameWords(text));
  if (have.size === 0) return true;
  return values.every((v) => alternativesOf(v).some((alt) => { const need = nameWords(alt); return need.length > 0 && need.every((w) => have.has(w)); }));
}

/**
 * A SOURCE THAT HAS NO NEXT PAGE GIVES WHAT ITS LIMIT ALLOWS, so the limit is the volume (live, 2026-10-30: a company search priced per call with up to 100 results included was called with the limit 50 the measuring call used; the engine read that one
 * answer, 18 of its 50 companies passed, and the source had «nothing more»). For an endpoint with no paging input, a numeric limit input whose maximum is above the value of the measuring call, and a PRICE PER CALL (the call costs the same whatever the limit),
 * the first page is asked at the input's maximum. Nothing is lifted for a source with a next page, nor for a per-result price (the cost would follow the limit). Pure.
 */
const VOLUME_INPUT = /^(?:limit|match_limit|count|page_size|pagesize|per_page|perpage|size|num|max_results|maxresults|max_items|maxitems|n)$/i;
export function liftedVolume(endpoint: CatalogEndpoint, params: Record<string, unknown>): { param: string; from: number | null; to: number } | null {
  if ((endpoint.pagination ?? []).some((p) => !LIMIT_INPUT.test(p))) return null;
  if (endpoint.cost?.type !== "per_call") return null;
  const input = endpoint.inputs.find((i) => VOLUME_INPUT.test(i.name) && (i.type === "integer" || i.type === "number") && typeof i.maximum === "number" && i.maximum > 0);
  if (!input) return null;
  const current = Number(params[input.name]);
  const have = Number.isFinite(current) && current > 0 ? current : null;
  return have !== null && have >= (input.maximum as number) ? null : { param: input.name, from: have, to: input.maximum as number };
}

const DOMAIN_NAMES = /^(?:domain|domains|website|domainOrCompany)$/i;
const NAME_NAMES = /^(?:company|company_name)$/i;
const LINKEDIN_NAMES = /^(?:linkedinURL|company_linkedin_url|company_profile_url)$/i;
const PARENT_DOMAIN_FIELD = /(?:^|_)(?:website|domain|site|url)$/i;
const PARENT_NAME_FIELD = /^(?:name|company_name|title)$/i;
const PARENT_LINKEDIN_FIELD = /linkedin/i;

/**
 * THE PEOPLE OF EVERY COMPANY THAT HAS ANY USABLE INPUT (live: managers were asked for the 11 companies that had a LinkedIn page and for none of the 7 others that had a website). When the child source takes more than one of a company's own fields (its website,
 * its page, its name), the binding the measuring call used comes first and the others follow in a fixed order (website, page, name): a company with no value for the first is read through the next, and a read that failed or gave nothing is retried through the
 * next. Only STRING inputs; only fields the parent's rows really carry. Pure.
 */
export function bindingFallbacks(endpoint: CatalogEndpoint, primary: { param: string; from: string }, parentRows: ReadonlyArray<Record<string, unknown>>): Array<{ param: string; from: string; domain?: true }> {
  const keys = [...new Set(parentRows.flatMap((r) => Object.keys(r)))];
  const hasValue = (k: string): boolean => parentRows.some((r) => typeof r[k] === "string" && String(r[k]).trim() !== "");
  const stringInput = (re: RegExp): string | null => endpoint.inputs.find((i) => re.test(i.name) && (i.type === "string" || i.type === "str") && i.name !== primary.param)?.name ?? null;
  const out: Array<{ param: string; from: string; domain?: true }> = [];
  const domainInput = stringInput(DOMAIN_NAMES);
  const domainField = keys.find((k) => k !== primary.from && PARENT_DOMAIN_FIELD.test(k) && !/linkedin|facebook|twitter|instagram/i.test(k) && hasValue(k));
  if (domainInput && domainField) out.push({ param: domainInput, from: domainField, domain: true });
  const linkedinInput = stringInput(LINKEDIN_NAMES);
  const linkedinField = keys.find((k) => k !== primary.from && PARENT_LINKEDIN_FIELD.test(k) && hasValue(k));
  if (linkedinInput && linkedinField) out.push({ param: linkedinInput, from: linkedinField });
  const nameInput = stringInput(NAME_NAMES);
  const nameField = keys.find((k) => k !== primary.from && PARENT_NAME_FIELD.test(k) && hasValue(k));
  if (nameInput && nameField) out.push({ param: nameInput, from: nameField });
  return out;
}

/**
 * THE IDENTITY INPUTS OF A CHILD SOURCE (audit 2026-11 gap G11): the inputs that name WHICH item to read, by its platform id (video_id, post_id, aweme_id, shortcode) or by its link (url, post_url, permalink). A routed source (`treg.tiktok.video.comments`) takes both and matches its providers on the
 * keys it is sent: with the id alone the providers that need the link are dropped. Every identity input the source takes is sent, in the same call (no extra cost), from the parent's own id and link.
 */
const ID_INPUT = /^(?:video_?id|post_?id|aweme_?id|shortcode|media_?id|code|id)$/i;
const URL_INPUT = /^(?:url|post_?url|video_?url|link|permalink)$/i;
const PARENT_ID_FIELD = /^(?:id|video_?id|post_?id|aweme_?id|shortcode)$/i;
const PARENT_LINK_FIELD = /^(?:url|link|permalink|post_?url|video_?url)$/i;
const isIdentityPair = (a: string, b: string): boolean => (ID_INPUT.test(a) && URL_INPUT.test(b)) || (URL_INPUT.test(a) && ID_INPUT.test(b));
const textInput = (endpoint: CatalogEndpoint, re: RegExp): string | null => endpoint.inputs.find((i) => re.test(i.name) && /^(?:str|string|url)$/i.test(String(i.type ?? "string")))?.name ?? null;

/** The other identity inputs of the source (the link beside the id, the id beside the link) with the parent field each takes. Only inputs the source really has and parent fields that carry a value on some row. Pure. */
export function bindingAlso(endpoint: CatalogEndpoint, primary: { param: string; from: string }, parentRows: ReadonlyArray<Record<string, unknown>>): Array<{ param: string; from: string }> {
  const keys = [...new Set(parentRows.flatMap((r) => Object.keys(r)))];
  const hasText = (k: string): boolean => parentRows.some((r) => (typeof r[k] === "string" && String(r[k]).trim() !== "") || typeof r[k] === "number");
  const hasLink = (k: string): boolean => parentRows.some((r) => typeof r[k] === "string" && /^https?:\/\//i.test(String(r[k]).trim()));
  const out: Array<{ param: string; from: string }> = [];
  if (ID_INPUT.test(primary.param)) {
    const urlParam = textInput(endpoint, URL_INPUT);
    const field = keys.find((k) => PARENT_LINK_FIELD.test(k) && k !== primary.from && hasLink(k));
    if (urlParam && urlParam !== primary.param && field) out.push({ param: urlParam, from: field });
  } else if (URL_INPUT.test(primary.param)) {
    const idParam = textInput(endpoint, ID_INPUT);
    const field = keys.find((k) => PARENT_ID_FIELD.test(k) && k !== primary.from && hasText(k));
    if (idParam && idParam !== primary.param && field) out.push({ param: idParam, from: field });
  }
  return out;
}

/** Which input of the child's measuring call is a field of a parent row (a value that equals the parent's own id, or one of its columns)? Exactly one input may bind, and it must bind to one field: else no recipe. An id AND a link that both bind (the routed sources take both) are ONE binding with the link beside it. */
export function parentBinding(params: Record<string, unknown>, parentRows: Array<Record<string, unknown>>): { param: string; from: string; also?: Array<{ param: string; from: string }> } | null {
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
  if (found.length === 1) return found[0];
  if (found.length === 2 && isIdentityPair(found[0].param, found[1].param)) { const [first, second] = ID_INPUT.test(found[0].param) ? [found[0], found[1]] : [found[1], found[0]]; return { ...first, also: [second] }; }
  return null;
}
