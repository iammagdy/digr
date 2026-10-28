import type { CallRecorder, FetchFn, AdapterContext } from "../../src/lib/server/multiProvider/adapterTypes";
import { contextDevAdapter } from "../../src/lib/server/multiProvider/adapters/contextdev";
import { firecrawlAdapter } from "../../src/lib/server/multiProvider/adapters/firecrawl";
import { contextDevParse, contextDevPeopleSearch } from "../../src/lib/server/multiProvider/adapters/contextdevParse";
import { PROVIDER_FACTS } from "../../src/lib/multiProvider/catalog";
import { checkPublicReadUrl } from "../../src/lib/multiProvider/policy";
import { digestFields, digestValue } from "../../src/lib/modelPlanner/digest";
import { PARSERS, PARSER_IDS, WEB_SOURCES, type ParserName } from "../../src/lib/agentMission/sources";
import { AGENT_FIRST_ROWS } from "../../src/lib/agentMission/constants";
import type { JobCallBudget } from "../../src/lib/server/callBudget";
import { RAW_PATH } from "./gateway";
import type { AgentStore, CallPhase } from "./types";

/**
 * THE WEB GATEWAY: the agent's way to the page parsers, the web search and page scrape (Firecrawl and Context.dev) and Context.dev's people search. The SAME rules as treg_call, in code, before every call:
 *
 *   1. the source is one of ours (a parser of the documented list, a known web source) and its inputs are valid; the URL is a PUBLIC page (checkPublicReadUrl: a public social page may be read, read only;
 *      a page behind a login, an account area or a private host is refused, as is anything that is not http(s)); a parser also checks the URL shape it accepts;
 *   2. the mission budget: the call's estimated USD is asked of the SAME budget the TREG calls use (planning, or 40% of the approved reserve's value in execution); a call that would pass it is NOT made;
 *   3. the provider's daily cap and the record: the recorder reserves BEFORE the call and commits the ACTUAL charge into provider_costs afterwards (failed and empty calls too);
 *   4. the provider's key comes from the encrypted key store (the site's own resolver), never from the model;
 * and after the call it saves the FULL answer to the private bucket (`{ rows, ... }`), writes a mission_calls row with the actual charge, and returns a SHAPE DIGEST and the FIRST ROWS only.
 * The charge is `key_metadata.credits_consumed` of the answer; when an answer carries none, the documented credit cost is recorded as an ESTIMATE (`cost_basis: "estimated"` in the call row).
 */
export type WebRefusal = "bad_source" | "bad_url" | "bad_input" | "over_budget" | "daily_cap" | "recording_unavailable" | "source_unavailable" | "choose_cheapest";

export type WebCallResult =
  | { ok: true; call_id: string; source: string; rows_in_page: number; next_cursor?: string | null; shape: unknown; first_rows: unknown[]; cost_basis: "reported" | "estimated"; saved: string; note?: string }
  | { ok: false; call_id: string; refused: WebRefusal; message: string }
  | { ok: false; call_id: string; failed: true; message: string };

const REFUSAL_TEXT: Record<WebRefusal, string> = {
  bad_source: "this source is not one of the web sources; use an id exactly as catalog_search returned it",
  bad_url: "this address cannot be read: it must be a PUBLIC page in the shape the source accepts (no login, no account area, no private host)",
  bad_input: "the inputs are missing or invalid for this source",
  over_budget: "the budget for source calls of this mission would be passed by this call, so it was NOT made; work with what is already saved or stop and explain honestly",
  daily_cap: "the provider's daily limit has no room for this call, so it was NOT made; stop and explain honestly",
  recording_unavailable: "the call could not be recorded, so it was NOT made; try once more, then stop and explain honestly",
  source_unavailable: "this source is not available right now (no key is configured for it); choose another source",
  choose_cheapest: "a cheaper source from the last catalog_search has not been tried; use it first, or pass `why` with the reason its sample was unsuitable",
};

export type ProviderKeyFn = (provider: "firecrawl" | "contextdev") => Promise<string | null>;

export interface WebGatewayDeps {
  store: AgentStore;
  missionId: string;
  jobId: string | null;
  phase: CallPhase;
  budget: JobCallBudget;
  recorder: CallRecorder;
  providerKey: ProviderKeyFn;
  fetchFn?: FetchFn;
  /** Shared with the TREG gateway: call ids continue in one sequence per mission. */
  counter: { seq: number };
  now?: () => number;
}

const clip = (s: unknown, n: number): string => String(s ?? "").slice(0, n);
const callIdOf = (n: number) => `call_${String(n).padStart(4, "0")}`;
const spendFieldOf = (phase: CallPhase) => (phase === "planning" ? "planning_treg_usd" : "execution_treg_usd");

export function createWebGateway(deps: WebGatewayDeps) {
  const fetchFn: FetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));

  const nextId = () => { deps.counter.seq += 1; return callIdOf(deps.counter.seq); };

  async function log(row: { id: string; source: string; params: Record<string, unknown>; status: "ok" | "failed" | "empty" | "refused"; refused?: string; http?: number | null; rows?: number; cost?: number; estimate?: number; storage?: string | null; ms?: number }) {
    await deps.store.addCall({
      id: `${deps.missionId}:${row.id}`, mission_id: deps.missionId, phase: deps.phase, endpoint_id: row.source,
      params_digest: Object.fromEntries(Object.entries(row.params).slice(0, 20).map(([k, v]) => [k, typeof v === "string" ? clip(v, 160) : v])),
      status: row.status, refused_reason: row.refused ? row.refused.slice(0, 120) : null, http_status: row.http ?? null, rows_returned: row.rows ?? null,
      cost_usd: row.cost ?? 0, estimate_usd: row.estimate ?? 0, provider_cost_id: null, storage_path: row.storage ?? null, duration_ms: row.ms ?? null,
    });
  }

  const refuse = async (id: string, source: string, params: Record<string, unknown>, code: WebRefusal, detail = ""): Promise<WebCallResult> => {
    await log({ id, source, params, status: "refused", refused: `${code}${detail ? `:${detail}` : ""}` });
    return { ok: false, call_id: id, refused: code, message: REFUSAL_TEXT[code] };
  };

  /** The common part: budget, key, the call itself, the record, the raw answer, the digest. `run` makes the provider call with the context it is given. */
  async function execute<T extends { costUsd: number; ok: boolean; status: string; units: number; durationMs: number; httpStatus: number | null; errorCode?: string; data: any }>(args: {
    id: string; source: string; provider: "firecrawl" | "contextdev"; params: Record<string, unknown>; estimateUsd: number;
    run: (ctx: AdapterContext) => Promise<T>;
    /** Turns the provider's data into what is saved and returned. */
    shape: (result: T) => { saved: unknown; rows: unknown[]; costBasis: "reported" | "estimated"; next_cursor?: string | null; note?: string; failedMessage?: string };
  }): Promise<WebCallResult> {
    const { id, source, params } = args;
    if (!deps.budget.reserve(args.estimateUsd)) return refuse(id, source, params, "over_budget", deps.phase);
    const key = await deps.providerKey(args.provider).catch(() => null);
    if (!key) { deps.budget.settle(args.estimateUsd, 0); return refuse(id, source, params, "source_unavailable", args.provider); }
    let result: T;
    try {
      result = await args.run({ apiKey: key, fetchFn, recorder: deps.recorder, jobId: deps.jobId, ...(deps.now ? { now: deps.now } : {}) });
    } catch {
      // the call may have gone out: its estimate stays counted
      deps.budget.settle(args.estimateUsd, null);
      await log({ id, source, params, status: "failed", estimate: args.estimateUsd, cost: args.estimateUsd });
      return { ok: false, call_id: id, failed: true, message: "the call did not complete; it may be tried once more" };
    }
    if ((result as any).errorCode === "cap_reached") { deps.budget.settle(args.estimateUsd, 0); return refuse(id, source, params, "daily_cap", args.provider); }
    deps.budget.settle(args.estimateUsd, result.costUsd);
    await deps.store.updateMission(deps.missionId, { [spendFieldOf(deps.phase)]: Number(deps.budget.spentUsd().toFixed(6)) });
    const shaped = args.shape(result);
    let storage: string | null = null;
    if (shaped.saved !== null && shaped.saved !== undefined) {
      try { await deps.store.putFile(deps.missionId, RAW_PATH(id), JSON.stringify(shaped.saved), "application/json"); storage = RAW_PATH(id); } catch { storage = null; }
    }
    const status = !result.ok ? "failed" : shaped.rows.length === 0 && result.status === "empty" ? "empty" : "ok";
    await log({ id, source, params: { ...params, cost_basis: shaped.costBasis }, status, http: result.httpStatus, rows: shaped.rows.length, cost: result.costUsd, estimate: args.estimateUsd, storage, ms: result.durationMs });
    if (!result.ok) return { ok: false, call_id: id, failed: true, message: shaped.failedMessage ?? `the source answered with an error (${result.errorCode ?? "unknown"})` };
    const rows = shaped.rows as Array<Record<string, unknown>>;
    return {
      ok: true, call_id: id, source, rows_in_page: rows.length, ...(shaped.next_cursor !== undefined ? { next_cursor: shaped.next_cursor } : {}),
      shape: { rows_in_page: rows.length, rows_path: "rows", fields: digestFields(rows.filter((r) => r && typeof r === "object" && !Array.isArray(r)).slice(0, 20)) },
      first_rows: rows.slice(0, AGENT_FIRST_ROWS).map((r) => digestValue(r)), cost_basis: shaped.costBasis,
      saved: storage ? `${id} (the full answer is saved as { rows, ... }; give "${id}" to run_code and read inputs.${id}.rows)` : "not saved",
      ...(shaped.note ? { note: shaped.note } : {}),
    };
  }

  return {
    /** ONE parser, ONE URL. */
    async parsePage(input: { parser?: unknown; url?: unknown; sort?: unknown; limit?: unknown; why?: unknown }): Promise<WebCallResult> {
      const id = nextId();
      const name = String(input.parser ?? "").trim();
      const params: Record<string, unknown> = { parser: name, url: clip(input.url, 300), ...(input.sort ? { sort: clip(input.sort, 20) } : {}), ...(input.limit ? { limit: Number(input.limit) } : {}), ...(input.why ? { _why: clip(input.why, 300) } : {}) };
      const source = Object.prototype.hasOwnProperty.call(PARSERS, name) ? PARSERS[name as ParserName].id : `contextdev.parse.${clip(name, 40)}`;
      if (!Object.prototype.hasOwnProperty.call(PARSERS, name)) return refuse(id, source, params, "bad_source", name);
      const spec = PARSERS[name as ParserName];
      const urlText = String(input.url ?? "").trim();
      let url: URL;
      try { url = new URL(urlText); } catch { return refuse(id, source, params, "bad_url", "invalid"); }
      const verdict = checkPublicReadUrl(urlText);
      if (!verdict.ok) return refuse(id, source, params, "bad_url", verdict.reason ?? "");
      if (!spec.accepts(url)) return refuse(id, source, params, "bad_url", `accepts: ${spec.urlHint}`.slice(0, 100));
      const sort = spec.params?.includes("sort") && input.sort ? String(input.sort) : undefined;
      if (sort && !["newest", "oldest", "relevant", "highest", "lowest"].includes(sort)) return refuse(id, source, params, "bad_input", "sort");
      const limit = spec.params?.includes("limit") && input.limit !== undefined ? Number(input.limit) : undefined;
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 1000)) return refuse(id, source, params, "bad_input", "limit");
      return execute({
        id, source, provider: "contextdev", params, estimateUsd: PROVIDER_FACTS.contextdev.usdPerCredit! * 1,
        run: (ctx) => contextDevParse({ spec, url: urlText, ...(sort ? { sort } : {}), ...(limit !== undefined ? { limit } : {}) }, ctx),
        shape: (r) => {
          const d = r.data as { rows: unknown[]; parsed: any; costBasis: "reported" | "estimated"; errorCode?: string; message?: string } | null;
          const basis = d?.costBasis ?? "estimated";
          if (!r.ok || !d) return { saved: null, rows: [], costBasis: basis, failedMessage: `the parse failed${d?.errorCode ? ` (${d.errorCode}${d.message ? `: ${d.message}` : ""})` : ""}; a failed parse has no rows${d?.errorCode === "NOT_FOUND" ? " (the page does not exist)" : ""}` };
          return { saved: { parser: name, url: urlText, rows: d.rows, data: d.parsed?.data ?? null }, rows: d.rows, costBasis: basis, ...(basis === "estimated" ? { note: "the provider did not report the charge: the documented base credit is recorded as an estimate" } : {}) };
        },
      });
    },

    /** Web search through Firecrawl or Context.dev. */
    async webSearch(input: { provider?: unknown; query?: unknown; limit?: unknown; country?: unknown; why?: unknown }): Promise<WebCallResult> {
      const id = nextId();
      const provider = input.provider === "firecrawl" ? "firecrawl" : "contextdev";
      const source = `${provider}.search`;
      const query = String(input.query ?? "").trim();
      const limit = Math.max(10, Math.min(30, Math.ceil((Number(input.limit) || 10) / 10) * 10));
      const params: Record<string, unknown> = { query: clip(query, 200), limit, ...(input.country ? { country: clip(input.country, 2) } : {}), ...(input.why ? { _why: clip(input.why, 300) } : {}) };
      if (query.length < 2) return refuse(id, source, params, "bad_input", "query");
      const spec = WEB_SOURCES.find((s) => s.id === source)!;
      const adapter = provider === "firecrawl" ? firecrawlAdapter : contextDevAdapter;
      return execute({
        id, source, provider, params, estimateUsd: spec.usdPerCall * (limit / 10),
        run: (ctx) => adapter.run("discover.web_search", { query, limit, ...(input.country ? { country: String(input.country) } : {}) }, ctx),
        shape: (r) => {
          const hits = Array.isArray(r.data) ? (r.data as unknown[]) : [];
          return { saved: r.ok ? { rows: hits } : null, rows: hits, costBasis: "reported" };
        },
      });
    },

    /** One public page as text and links, through Firecrawl or Context.dev. */
    async webScrape(input: { provider?: unknown; url?: unknown; why?: unknown }): Promise<WebCallResult> {
      const id = nextId();
      const provider = input.provider === "firecrawl" ? "firecrawl" : "contextdev";
      const source = `${provider}.scrape`;
      const urlText = String(input.url ?? "").trim();
      const params: Record<string, unknown> = { url: clip(urlText, 300), ...(input.why ? { _why: clip(input.why, 300) } : {}) };
      const verdict = checkPublicReadUrl(urlText);
      if (!verdict.ok) return refuse(id, source, params, "bad_url", verdict.reason ?? "");
      const spec = WEB_SOURCES.find((s) => s.id === source)!;
      const adapter = provider === "firecrawl" ? firecrawlAdapter : contextDevAdapter;
      return execute({
        id, source, provider, params, estimateUsd: spec.usdPerCall,
        run: (ctx) => adapter.run("page.read", { url: urlText }, ctx),
        shape: (r) => {
          const page = r.data as { markdown: string; links: string[]; finalUrl: string } | null;
          if (!r.ok || !page) return { saved: null, rows: [], costBasis: "reported" };
          return { saved: { rows: [], markdown: page.markdown, links: page.links, url: page.finalUrl }, rows: [{ url: page.finalUrl, characters: page.markdown.length, links: page.links.length, start: page.markdown.slice(0, 400) }], costBasis: "reported", note: "the page text and its links are saved: process them with run_code (inputs.<id>.markdown, inputs.<id>.links)" };
        },
      });
    },

    /** Context.dev people search (names, roles, companies, public profile links; never an e-mail or a phone). */
    async peopleSearch(input: { query?: unknown; country?: unknown; cursor?: unknown; why?: unknown }): Promise<WebCallResult> {
      const id = nextId();
      const source = "contextdev.people.search";
      const query = String(input.query ?? "").trim();
      const params: Record<string, unknown> = { query: clip(query, 300), ...(input.country ? { country: clip(input.country, 2) } : {}), ...(input.cursor ? { cursor: "yes" } : {}), ...(input.why ? { _why: clip(input.why, 300) } : {}) };
      if (query.length < 3 || query.length > 500) return refuse(id, source, params, "bad_input", "query");
      const spec = WEB_SOURCES.find((s) => s.id === source)!;
      return execute({
        id, source, provider: "contextdev", params, estimateUsd: spec.usdPerCall,
        run: (ctx) => contextDevPeopleSearch({ query, ...(input.country ? { country: String(input.country) } : {}), ...(input.cursor ? { cursor: String(input.cursor) } : {}) }, ctx),
        shape: (r) => {
          const d = r.data as { rows: unknown[]; nextCursor: string | null; costBasis: "reported" | "estimated" } | null;
          if (!r.ok || !d) return { saved: null, rows: [], costBasis: "estimated" };
          return { saved: { rows: d.rows, next_cursor: d.nextCursor }, rows: d.rows, costBasis: d.costBasis, next_cursor: d.nextCursor, note: "people only: no e-mail and no phone are returned; use a contact source for those" };
        },
      });
    },
  };
}

export type WebGateway = ReturnType<typeof createWebGateway>;
export { PARSER_IDS };
