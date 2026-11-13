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
import { createHash } from "node:crypto";
import { PAGE_MIN_TEXT_CHARS, canonicalPageUrl, isPageFieldParser, pageRowsFor, pageTextChars, siteOf, type PageFieldParser } from "../../src/lib/agentMission/pageExtract";

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
export type WebRefusal = "bad_source" | "bad_url" | "bad_input" | "over_budget" | "daily_cap" | "recording_unavailable" | "source_unavailable" | "choose_cheapest" | "parent_not_saved" | "page_failed_before";

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
  parent_not_saved: "this page is not on the site of a company already saved in this mission, nor linked from one of its pages: contact pages are bought only for companies that will be in the file. Save the company first, or skip it",
  page_failed_before: "this page already failed to load in this mission and is not bought again; work with what is saved or skip it",
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
  /**
   * ROUND 60, EXECUTION ONLY: ONE PAID FETCH PER PAGE. When present, the field parsers (`emails`, `phone-numbers`, `links`) of a page are answered by code from the page text bought ONCE
   * (a Context.dev page read at the same one credit), and every later field or scrape of the same page in this mission is answered from it at no charge. Planning never gets it: its call costs
   * are what the plan's price is measured from, and they stay exactly as they were.
   */
  pageReuse?: {
    /** The country of the request («EG»): a national number («01130755305») is read only with it. */
    countryHint: string | null;
    /**
     * The sites of the companies already SAVED in this mission for the detail steps that read their pages (`siteOf` of their website), or null when no detail step reads pages (no gate).
     * An empty set means no company is saved yet: no page is bought.
     */
    parentSites?: () => Promise<ReadonlySet<string> | null>;
  };
}

/** A page bought in this mission (the mission's private folder `pages/`): its text and links, from which every field is read by code. */
export interface CachedPage { v: 1; mission_id: string; canonical_url: string; requested_url: string; final_url: string; call_id: string; endpoint_id: string; fetched_at: string; text_chars: number; markdown: string; links: string[]; methods: string[] }
interface FailedPage { v: 1; canonical_url: string; attempts: Array<{ call_id: string; code: string; transient: boolean; at: string }> }
export const PAGES_DIR = "pages";
/** Live msn_088c: the model read the MASKED e-mails and phones of this reply as missing and bought the page again with a scrape (6 paid calls). The full values are in the saved answer. */
const MASKED_NOTE = "; e-mails and phones in first_rows are masked for this reply only: the FULL values are in the saved answer (run_code on this call id), so the page is never bought again to read them";
export const PAGE_REUSE_ENDPOINT = "page.reuse";
/** A page that failed with a passing error («timeout», «server_error», a call that did not complete) is tried at most this many times in a mission; one that does not exist or blocks us, once. */
export const PAGE_MAX_ATTEMPTS = 2;
const DEFINITIVE_PAGE_ERRORS = new Set(["not_found", "blocked_site", "bad_request", "unexpected_shape"]);
const pageKeyOf = (canonical: string): string => createHash("sha256").update(canonical).digest("hex").slice(0, 32);
const PAGE_FIELD_METHODS = ["emails", "phone-numbers", "links", "scrape"];
/** Kill switch: DIGER_WEB_PAGE_REUSE=0 gives back the old behaviour (every field bought on its own). */
export const pageReuseDisabled = (): boolean => process.env.DIGER_WEB_PAGE_REUSE === "0";

const clip = (s: unknown, n: number): string => String(s ?? "").slice(0, n);
const callIdOf = (n: number) => `call_${String(n).padStart(4, "0")}`;
const spendFieldOf = (phase: CallPhase) => (phase === "planning" ? "planning_treg_usd" : "execution_treg_usd");

export function createWebGateway(deps: WebGatewayDeps) {
  const fetchFn: FetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));

  const nextId = () => { deps.counter.seq += 1; return callIdOf(deps.counter.seq); };

  async function log(row: { id: string; source: string; params: Record<string, unknown>; status: "ok" | "failed" | "empty" | "refused"; refused?: string; http?: number | null; rows?: number; cost?: number; estimate?: number; storage?: string | null; ms?: number; costId?: number | null }) {
    await deps.store.addCall({
      id: `${deps.missionId}:${row.id}`, mission_id: deps.missionId, phase: deps.phase, endpoint_id: row.source,
      params_digest: Object.fromEntries(Object.entries(row.params).slice(0, 20).map(([k, v]) => [k, typeof v === "string" ? clip(v, 160) : v])),
      status: row.status, refused_reason: row.refused ? row.refused.slice(0, 120) : null, http_status: row.http ?? null, rows_returned: row.rows ?? null,
      // PHASE 2 (task 2.4, audit PR-2.4): the provider_costs row this call reserved and committed, as the TREG gateway records it: a web call is traced to its recorded cost (null when nothing was reserved)
      cost_usd: row.cost ?? 0, estimate_usd: row.estimate ?? 0, provider_cost_id: row.costId ?? null, storage_path: row.storage ?? null, duration_ms: row.ms ?? null,
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
    shape: (result: T) => { saved: unknown; rows: unknown[]; costBasis: "reported" | "estimated"; next_cursor?: string | null; note?: string; failedMessage?: string; /** The rows were read by code from a page: no row is «empty», whatever the page call said. */ emptyIfNoRows?: boolean };
    /** Told what happened, for the page cache: the page bought, or why it failed (a call that did not complete is «thrown»). */
    onOutcome?: (outcome: { ok: true; result: T } | { ok: false; code: string; thrown: boolean }) => Promise<void>;
  }): Promise<WebCallResult> {
    const { id, source, params } = args;
    if (!deps.budget.reserve(args.estimateUsd)) return refuse(id, source, params, "over_budget", deps.phase);
    const key = await deps.providerKey(args.provider).catch(() => null);
    if (!key) { deps.budget.settle(args.estimateUsd, 0); return refuse(id, source, params, "source_unavailable", args.provider); }
    let result: T;
    // the reservation id of THIS call (the adapter reserves through the recorder before it sends): read back so the call row names its provider_costs row; the recorder itself is unchanged
    let costId: number | null = null;
    const recorder: CallRecorder = { reserve: async (a) => { const r = await deps.recorder.reserve(a); if (r.allowed && typeof r.costId === "number") costId = r.costId; return r; }, commit: (id2, record) => deps.recorder.commit(id2, record) };
    try {
      result = await args.run({ apiKey: key, fetchFn, recorder, jobId: deps.jobId, ...(deps.now ? { now: deps.now } : {}) });
    } catch {
      // the call may have gone out: its estimate stays counted
      deps.budget.settle(args.estimateUsd, null);
      await log({ id, source, params, status: "failed", estimate: args.estimateUsd, cost: args.estimateUsd, costId });
      if (args.onOutcome) await args.onOutcome({ ok: false, code: "thrown", thrown: true }).catch(() => undefined);
      return { ok: false, call_id: id, failed: true, message: "the call did not complete; it may be tried once more" };
    }
    if ((result as any).errorCode === "cap_reached") { deps.budget.settle(args.estimateUsd, 0); return refuse(id, source, params, "daily_cap", args.provider); }
    // ROUND 60: a call that got NO answer (a timeout, a dropped connection) may have been billed: the provider said nothing, so the mission's budget keeps its estimate (never assumed free)
    const noAnswer = !result.ok && result.httpStatus === null;
    deps.budget.settle(args.estimateUsd, noAnswer ? null : result.costUsd);
    await deps.store.updateMission(deps.missionId, { [spendFieldOf(deps.phase)]: Number(deps.budget.spentUsd().toFixed(6)) });
    const shaped = args.shape(result);
    let storage: string | null = null;
    if (shaped.saved !== null && shaped.saved !== undefined) {
      try { await deps.store.putFile(deps.missionId, RAW_PATH(id), JSON.stringify(shaped.saved), "application/json"); storage = RAW_PATH(id); } catch { storage = null; }
    }
    const status = !result.ok ? "failed" : shaped.rows.length === 0 && (result.status === "empty" || shaped.emptyIfNoRows) ? "empty" : "ok";
    await log({ id, source, params: { ...params, cost_basis: shaped.costBasis, ...(noAnswer ? { charge_unknown: true } : {}) }, status, http: result.httpStatus, rows: shaped.rows.length, cost: result.costUsd, estimate: args.estimateUsd, storage, ms: result.durationMs, costId });
    if (args.onOutcome) await args.onOutcome(result.ok ? { ok: true, result } : { ok: false, code: String(result.errorCode ?? "unknown"), thrown: false }).catch(() => undefined);
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

  // ------------------------------------------------------------------------------------------- ROUND 60: the mission's page cache
  const reuseOn = Boolean(deps.pageReuse) && deps.phase === "execution" && !pageReuseDisabled();
  const memory = new Map<string, CachedPage>();
  const failures = new Map<string, FailedPage>();
  /** One page at a time: every request for a page waits for the one before it, so two requests at the same moment buy it once. */
  const locks = new Map<string, Promise<unknown>>();
  function withPageLock<T>(canonical: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(canonical) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    locks.set(canonical, next);
    void next.catch(() => undefined).finally(() => { if (locks.get(canonical) === next) locks.delete(canonical); });
    return next;
  }
  /** Pages linked from a page of a saved company: a contact page on another host («rootsegypt.shop/contact-us» from go-natural.shop) is still that company's. */
  const linkedFromParents = new Set<string>();
  /** A field of a page with almost no text, already asked of the provider's own parser once in this run: not bought a third time. */
  const thinTried = new Set<string>();

  /** The page bought in this mission for this address: memory, then its cache file, then (a cache file lost to a restart) the raw answer of the recorded call that bought it. */
  async function cachedPage(canonical: string): Promise<CachedPage | null> {
    const key = pageKeyOf(canonical);
    const hit = memory.get(key);
    if (hit) return hit;
    const file = await deps.store.getFile(deps.missionId, `${PAGES_DIR}/${key}.json`).catch(() => null);
    if (file) {
      try { const p = JSON.parse(file) as CachedPage; if (p && p.canonical_url === canonical && p.mission_id === deps.missionId && typeof p.markdown === "string") { memory.set(key, p); return p; } } catch { /* a broken file is not a page */ }
    }
    const calls = await deps.store.listCalls(deps.missionId).catch(() => []);
    for (const c of calls) {
      const digest = (c.params_digest ?? {}) as Record<string, unknown>;
      if (digest.page_key !== key || c.status === "failed" || c.status === "refused" || !c.storage_path || c.endpoint_id === PAGE_REUSE_ENDPOINT) continue;
      const raw = await deps.store.getFile(deps.missionId, c.storage_path).catch(() => null);
      if (!raw) continue;
      try {
        const saved = JSON.parse(raw) as { page?: { markdown?: string; links?: string[]; final_url?: string }; markdown?: string; links?: string[]; url?: string };
        const markdown = saved.page?.markdown ?? saved.markdown;
        if (typeof markdown !== "string") continue;
        const p: CachedPage = { v: 1, mission_id: deps.missionId, canonical_url: canonical, requested_url: String(digest.url ?? ""), final_url: String(saved.page?.final_url ?? saved.url ?? digest.url ?? ""), call_id: String(c.id).split(":").pop() ?? "", endpoint_id: c.endpoint_id, fetched_at: String((c as { created_at?: string }).created_at ?? ""), text_chars: pageTextChars(markdown), markdown, links: saved.page?.links ?? saved.links ?? [], methods: PAGE_FIELD_METHODS };
        memory.set(key, p);
        return p;
      } catch { /* not a page */ }
    }
    return null;
  }
  async function failedPage(canonical: string): Promise<FailedPage | null> {
    const key = pageKeyOf(canonical);
    if (failures.has(key)) return failures.get(key)!;
    const file = await deps.store.getFile(deps.missionId, `${PAGES_DIR}/${key}.fail.json`).catch(() => null);
    if (!file) return null;
    try { const f = JSON.parse(file) as FailedPage; if (f.canonical_url === canonical) { failures.set(key, f); return f; } } catch { /* none */ }
    return null;
  }
  async function rememberPage(canonical: string, requested: string, callId: string, endpointId: string, page: { markdown: string; links: string[]; finalUrl: string }) {
    const p: CachedPage = { v: 1, mission_id: deps.missionId, canonical_url: canonical, requested_url: requested, final_url: page.finalUrl, call_id: callId, endpoint_id: endpointId, fetched_at: new Date(deps.now ? deps.now() : Date.now()).toISOString(), text_chars: pageTextChars(page.markdown), markdown: page.markdown, links: page.links, methods: PAGE_FIELD_METHODS };
    memory.set(pageKeyOf(canonical), p);
    // the raw answer of the call already holds the page: a lost cache file is rebuilt from it (cachedPage)
    await deps.store.putFile(deps.missionId, `${PAGES_DIR}/${pageKeyOf(canonical)}.json`, JSON.stringify(p), "application/json").catch(() => undefined);
  }
  async function rememberFailure(canonical: string, callId: string, code: string, thrown: boolean) {
    const key = pageKeyOf(canonical);
    const f = (await failedPage(canonical)) ?? { v: 1 as const, canonical_url: canonical, attempts: [] };
    f.attempts.push({ call_id: callId, code, transient: thrown || !DEFINITIVE_PAGE_ERRORS.has(code), at: new Date(deps.now ? deps.now() : Date.now()).toISOString() });
    failures.set(key, f);
    await deps.store.putFile(deps.missionId, `${PAGES_DIR}/${key}.fail.json`, JSON.stringify(f), "application/json").catch(() => undefined);
  }
  /** Whether a page that failed before may be bought once more: a passing error, fewer than PAGE_MAX_ATTEMPTS tries. */
  const mayRetry = (f: FailedPage | null): boolean => !f || (f.attempts.every((a) => a.transient) && f.attempts.length < PAGE_MAX_ATTEMPTS);

  /** PHASE 2: a detail page is bought only for a company already saved (its site, a subdomain of it, or a page linked from one of its pages). Null: allowed. */
  async function parentGate(urlText: string, canonical: string): Promise<string | null> {
    if (!deps.pageReuse?.parentSites) return null;
    const sites = await deps.pageReuse.parentSites().catch(() => new Set<string>());
    if (sites === null) return null;
    const site = siteOf(urlText);
    if (site && [...sites].some((p) => p === site || site.endsWith(`.${p}`) || p.endsWith(`.${site}`))) return null;
    if (linkedFromParents.has(canonical)) return null;
    return sites.size === 0 ? "no_company_saved" : `not_a_saved_company:${site ?? ""}`;
  }
  /** The links of a page of a saved company are that company's pages too. */
  async function noteLinks(page: CachedPage) {
    if (!deps.pageReuse?.parentSites) return;
    const sites = await deps.pageReuse.parentSites().catch(() => null);
    const site = siteOf(page.requested_url) ?? siteOf(page.final_url);
    if (!sites || !site || ![...sites].some((p) => p === site || site.endsWith(`.${p}`) || p.endsWith(`.${site}`))) return;
    for (const l of page.links) { try { const c = canonicalPageUrl(new URL(l, page.final_url || page.requested_url).toString()); if (c) linkedFromParents.add(c); } catch { /* not a link */ } }
  }

  /** A field or a scrape of a page already bought: read by code, recorded at no charge with the call that bought it. */
  async function fromCache(id: string, requestedSource: string, parser: PageFieldParser | "scrape", urlText: string, page: CachedPage): Promise<WebCallResult> {
    const rows = parser === "scrape" ? [{ url: page.final_url, characters: page.markdown.length, links: page.links.length, start: page.markdown.slice(0, 400) }] : pageRowsFor(parser, { markdown: page.markdown, finalUrl: page.final_url || urlText }, deps.pageReuse?.countryHint ?? null);
    const saved = parser === "scrape" ? { rows: [], markdown: page.markdown, links: page.links, url: page.final_url, reused_from: page.call_id } : { parser, url: urlText, rows, reused_from: page.call_id, final_url: page.final_url };
    let storage: string | null = null;
    try { await deps.store.putFile(deps.missionId, RAW_PATH(id), JSON.stringify(saved), "application/json"); storage = RAW_PATH(id); } catch { storage = null; }
    await log({ id, source: PAGE_REUSE_ENDPOINT, params: { parser, url: clip(urlText, 300), page_key: pageKeyOf(page.canonical_url), reused_from: page.call_id, requested: requestedSource }, status: parser === "scrape" || rows.length > 0 ? "ok" : "empty", rows: parser === "scrape" ? 1 : rows.length, cost: 0, estimate: 0, storage });
    await noteLinks(page);
    const list = rows as Array<Record<string, unknown>>;
    return {
      ok: true, call_id: id, source: requestedSource, rows_in_page: list.length,
      shape: { rows_in_page: list.length, rows_path: "rows", fields: digestFields(list.slice(0, 20)) },
      first_rows: list.slice(0, AGENT_FIRST_ROWS).map((r) => digestValue(r)), cost_basis: "reported",
      saved: storage ? `${id} (the full answer is saved as { rows, ... }; give "${id}" to run_code and read inputs.${id}.rows)` : "not saved",
      note: `read by code from the page already bought in this mission (${page.call_id}, ${page.final_url || page.requested_url}): no new charge${parser === "scrape" ? "; the page text and links are saved, process them with run_code" : MASKED_NOTE}`,
    };
  }

  /** One field of a page, bought once: the page text (one credit, the same as a field parser), every field read from it by code, the page kept for every later field of the mission. */
  async function pageField(id: string, source: string, parser: PageFieldParser, urlText: string, canonical: string, params: Record<string, unknown>): Promise<WebCallResult | null> {
    const blocked = await parentGate(urlText, canonical);
    if (blocked) return refuse(id, source, params, "parent_not_saved", blocked);
    const page = await cachedPage(canonical);
    if (page) {
      // a page with almost no text (a page drawn by scripts) was not really read: the provider's own parser may be asked, as before (null: the caller goes on to it)
      if (page.text_chars < PAGE_MIN_TEXT_CHARS && parser !== "links" && !thinTried.has(`${parser}|${canonical}`)) { thinTried.add(`${parser}|${canonical}`); return null; }
      return fromCache(id, source, parser, urlText, page);
    }
    const failed = await failedPage(canonical);
    if (!mayRetry(failed)) return refuse(id, source, params, "page_failed_before", failed!.attempts.map((a) => `${a.call_id}:${a.code}`).join(",").slice(0, 100));
    let bought: { markdown: string; links: string[]; finalUrl: string } | null = null;
    let thinPage = false;
    const work = execute({
      id, source, provider: "contextdev", params: { ...params, page_key: pageKeyOf(canonical), fetched_as: "page", extraction: "code" }, estimateUsd: PROVIDER_FACTS.contextdev.usdPerCredit! * 1,
      run: (ctx) => contextDevAdapter.run("page.read", { url: urlText }, ctx),
      shape: (r) => {
        const pg = r.data as { markdown: string; links: string[]; finalUrl: string } | null;
        if (!r.ok || !pg) return { saved: null, rows: [], costBasis: "reported", failedMessage: `the page could not be read (${r.errorCode ?? "unknown"}); it is not bought again${DEFINITIVE_PAGE_ERRORS.has(String(r.errorCode)) ? "" : " more than once"}` };
        bought = pg;
        const rows = pageRowsFor(parser, { markdown: pg.markdown, finalUrl: pg.finalUrl || urlText }, deps.pageReuse?.countryHint ?? null);
        const thin = pageTextChars(pg.markdown) < PAGE_MIN_TEXT_CHARS;
        thinPage = thin && parser !== "links";
        return { saved: { parser, url: urlText, rows, page: { markdown: pg.markdown, links: pg.links, final_url: pg.finalUrl } }, rows, costBasis: "reported", emptyIfNoRows: true, note: `the page was bought once and its ${parser} read by code; every other field of this page (emails, phone-numbers, links, its text) is now read from it at no charge${MASKED_NOTE}${thin ? `. The page has almost no text (${pageTextChars(pg.markdown)} characters): the provider's own parser was asked for this field` : ""}` };
      },
      onOutcome: async (o) => {
        if (o.ok && bought) { await rememberPage(canonical, urlText, id, source, bought); const p = memory.get(pageKeyOf(canonical)); if (p) await noteLinks(p); }
        else if (!o.ok) await rememberFailure(canonical, id, o.code, o.thrown);
      },
    });
    const answer = await work;
    // A PAGE WITH ALMOST NO TEXT (drawn by scripts) cannot be read by code: the provider's own parser is asked for this field in the same request, as before, so no value is lost silently
    if (thinPage && answer.ok) { thinTried.add(`${parser}|${canonical}`); return null; }
    return answer;
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
      // ROUND 60: a field of a page is read from the page bought once in this mission (execution only)
      const canonical = canonicalPageUrl(urlText);
      if (reuseOn && canonical && isPageFieldParser(name)) {
        const answered = await withPageLock(canonical, () => pageField(id, source, name, urlText, canonical, params));
        if (answered) return answered;
        // a page with almost no text: the provider's own parser, once per field and page
        params.why_paid = "page_text_empty";
      }
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
      // ROUND 60: a page already bought in this mission is given again from what was saved; a page that failed for good is not bought again (execution only)
      const canonical = canonicalPageUrl(urlText);
      const run = async (): Promise<WebCallResult> => {
      if (reuseOn && canonical) {
        const blocked = await parentGate(urlText, canonical);
        if (blocked) return refuse(id, source, params, "parent_not_saved", blocked);
        const page = await cachedPage(canonical);
        if (page) return fromCache(id, source, "scrape", urlText, page);
        const failed = await failedPage(canonical);
        if (!mayRetry(failed)) return refuse(id, source, params, "page_failed_before", failed!.attempts.map((a) => `${a.call_id}:${a.code}`).join(",").slice(0, 100));
        params.page_key = pageKeyOf(canonical);
      }
      let bought: { markdown: string; links: string[]; finalUrl: string } | null = null;
      const work = execute({
        id, source, provider, params, estimateUsd: spec.usdPerCall,
        ...(reuseOn && canonical ? { onOutcome: async (o: { ok: true; result: unknown } | { ok: false; code: string; thrown: boolean }) => {
          if (o.ok && bought) { await rememberPage(canonical, urlText, id, source, bought); const p = memory.get(pageKeyOf(canonical)); if (p) await noteLinks(p); }
          else if (!o.ok) await rememberFailure(canonical, id, o.code, o.thrown);
        } } : {}),
        run: (ctx) => adapter.run("page.read", { url: urlText }, ctx),
        shape: (r) => {
          const page = r.data as { markdown: string; links: string[]; finalUrl: string } | null;
          if (!r.ok || !page) return { saved: null, rows: [], costBasis: "reported" };
          bought = page;
          return { saved: { rows: [], markdown: page.markdown, links: page.links, url: page.finalUrl }, rows: [{ url: page.finalUrl, characters: page.markdown.length, links: page.links.length, start: page.markdown.slice(0, 400) }], costBasis: "reported", note: "the page text and its links are saved: process them with run_code (inputs.<id>.markdown, inputs.<id>.links)" };
        },
      });
      return work;
      };
      return reuseOn && canonical ? withPageLock(canonical, run) : run();
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
