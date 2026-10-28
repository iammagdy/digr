import { CONTEXTDEV_CREDITS_URL, CONTEXTDEV_USD_PER_CREDIT, PROVIDER_FACTS } from "../../../multiProvider/catalog";
import type { CapabilityDef } from "../../../multiProvider/types";
import { CONTEXTDEV_PARSE_CREDITS, CONTEXTDEV_PEOPLE_SEARCH_CREDITS, CONTEXTDEV_PEOPLE_SEARCH_PAGE_ROWS, type ParserSpec } from "../../../agentMission/sources";
import type { AdapterContext, ErrorCode, OperationResult } from "../adapterTypes";
import { runRecordedCall, type InterpretedAnswer } from "../httpCall";

/**
 * Context.dev pre-built parsers and people search, for the AGENT's gateway (agent/src/webGateway.ts). Documented on 2026-10-28:
 *
 *   POST {base}/web/scrape  { url, formats: { parse: true }, parseParams: { type: "prebuilt", parser: "<name>", sort?, limit? }, timeoutOpts }
 *     -> { parsed: { type, requested, success, data, error_code?, message? }, key_metadata: { credits_consumed, credits_remaining }, request_id }
 *   A parse that failed answers HTTP 200 with parsed.success false, data null and an error_code (NOT_FOUND, WEBSITE_BLOCKED, WEBSITE_ACCESS_ERROR, REQUEST_TIMEOUT, INTERNAL_ERROR ...).
 *   POST {base}/people/search { query, mode: "fast", filters?: { countries }, cursor? } -> { results[], next_cursor, key_metadata }
 *
 * The CHARGE of a call is `key_metadata.credits_consumed` when the answer carries it. The documentation states no credit cost per parser (only the 1-credit base scrape), so an answer without it is recorded at the
 * documented base (CONTEXTDEV_PARSE_CREDITS) and marked `estimated`. A failed parse costs nothing, except a target that answered 404, which keeps the base charge (documented on the credits page).
 */
const FACTS = PROVIDER_FACTS.contextdev;
const base = () => FACTS.baseUrl as string;

export const CONTEXTDEV_PARSE_CAPABILITY: CapabilityDef = {
  id: "contextdev.parse", provider: "contextdev", operation: "page.read_structured", unit: "page", unitsPerCall: 1, creditsPerCall: CONTEXTDEV_PARSE_CREDITS,
  costPerCallUsd: Math.round(CONTEXTDEV_PARSE_CREDITS * CONTEXTDEV_USD_PER_CREDIT * 1e9) / 1e9, costPerUnitUsd: Math.round(CONTEXTDEV_PARSE_CREDITS * CONTEXTDEV_USD_PER_CREDIT * 1e9) / 1e9, priceStatus: "VERIFIED",
  priceSources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/scrape/prebuilt-parsers"], fields: ["page_url"],
  reliabilityNote: "A pre-built parser: 1 credit is the documented base scrape; the answer's own credits_consumed replaces it when present.", labelAr: "قارئ جاهز (Context.dev)",
};

export const CONTEXTDEV_PEOPLE_SEARCH_CAPABILITY: CapabilityDef = {
  id: "contextdev.people_search", provider: "contextdev", operation: "people.enrich", unit: "page", unitsPerCall: CONTEXTDEV_PEOPLE_SEARCH_PAGE_ROWS, creditsPerCall: CONTEXTDEV_PEOPLE_SEARCH_CREDITS,
  costPerCallUsd: Math.round(CONTEXTDEV_PEOPLE_SEARCH_CREDITS * CONTEXTDEV_USD_PER_CREDIT * 1e9) / 1e9, costPerUnitUsd: Math.round(CONTEXTDEV_PEOPLE_SEARCH_CREDITS * CONTEXTDEV_USD_PER_CREDIT / CONTEXTDEV_PEOPLE_SEARCH_PAGE_ROWS * 1e9) / 1e9, priceStatus: "VERIFIED",
  priceSources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/people/search", "https://docs.context.dev/api-reference/people/search"], fields: ["decision_maker", "profile_link"],
  reliabilityNote: "People search: 10 credits a page of up to 10 people (fast mode); a page with no match is free. It returns names, roles, companies and public profile links, never an e-mail or a phone.", labelAr: "بحث الأشخاص (Context.dev)",
};

function creditsOf(json: any): number | null {
  const n = Number(json?.key_metadata?.credits_consumed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseError(code: unknown): ErrorCode {
  const c = String(code ?? "").toUpperCase();
  if (c === "WEBSITE_BLOCKED") return "blocked_site";
  if (c === "NOT_FOUND" || c === "WEBSITE_NOT_FOUND") return "not_found";
  if (c === "REQUEST_TIMEOUT" || c === "TIMEOUT") return "timeout";
  if (c === "INPUT_VALIDATION_ERROR" || c === "UNSUPPORTED_CONTENT" || c === "CONTENT_TOO_LARGE") return "bad_request";
  return "server_error";
}

const valueAt = (data: any, path: string | null): unknown => (path === null ? data : data && typeof data === "object" ? data[path] : undefined);

export interface ParseOutcome {
  /** The parser's own answer: { type, success, data, error_code?, message? }. */
  parsed: { type?: string; success?: boolean; data?: unknown; error_code?: string; message?: string };
  /** The rows of the answer: the list at the parser's list path, or the one object of a profile / app / video. */
  rows: unknown[];
  requestId: string | null;
  /** `reported`: the answer carried credits_consumed. `estimated`: it did not, and the documented base credit was recorded. */
  costBasis: "reported" | "estimated";
  errorCode?: string;
  message?: string;
}

export async function contextDevParse(input: { spec: ParserSpec; url: string; sort?: string; limit?: number }, ctx: AdapterContext): Promise<OperationResult<ParseOutcome>> {
  const { spec } = input;
  const parseParams: Record<string, unknown> = { type: "prebuilt", parser: spec.name };
  if (spec.params?.includes("sort") && input.sort) parseParams.sort = input.sort;
  if (spec.params?.includes("limit") && Number.isFinite(input.limit)) parseParams.limit = Math.max(1, Math.min(1000, Math.floor(input.limit as number)));
  const timeoutMs = spec.name === "google-maps-reviews" ? 90_000 : 60_000;
  return runRecordedCall<ParseOutcome>({
    ctx: { ...ctx, timeoutMs, timeoutCapMs: Math.max(timeoutMs + 5_000, FACTS.callTimeoutMs) },
    capability: CONTEXTDEV_PARSE_CAPABILITY,
    request: { url: `${base()}/web/scrape`, method: "POST", headers: {}, body: { url: input.url, formats: { parse: true }, parseParams, timeoutOpts: { milliseconds: timeoutMs - 5_000, behavior: "fail" } } },
    interpret: (a): InterpretedAnswer<ParseOutcome> => {
      const parsed = a.json?.parsed;
      const reported = creditsOf(a.json);
      if (!parsed || typeof parsed !== "object") return { status: "failed", data: null, units: 0, credits: reported, errorCode: "unexpected_shape" };
      const requestId = typeof a.json?.request_id === "string" ? a.json.request_id : null;
      if (parsed.success === false) {
        const code = String(parsed.error_code ?? "");
        // a failed parse costs nothing, except a target that answered 404 (the credits page keeps the base charge for it)
        const credits = reported !== null ? reported : code.toUpperCase() === "NOT_FOUND" ? CONTEXTDEV_PARSE_CREDITS : 0;
        return { status: "failed", data: { parsed, rows: [], requestId, costBasis: reported !== null ? "reported" : "estimated", errorCode: code, message: String(parsed.message ?? "").slice(0, 200) }, units: 0, credits, errorCode: parseError(code) };
      }
      const value = valueAt(parsed.data, spec.listPath);
      const rows = spec.listPath === null ? (value && typeof value === "object" ? [value] : []) : Array.isArray(value) ? value : [];
      return { status: rows.length === 0 ? "empty" : "success", data: { parsed, rows, requestId, costBasis: reported !== null ? "reported" : "estimated" }, units: rows.length, credits: reported };
    },
  });
}

export interface PeopleOutcome { rows: unknown[]; nextCursor: string | null; requestId: string | null; costBasis: "reported" | "estimated" }

export async function contextDevPeopleSearch(input: { query: string; country?: string; cursor?: string }, ctx: AdapterContext): Promise<OperationResult<PeopleOutcome>> {
  return runRecordedCall<PeopleOutcome>({
    ctx: { ...ctx, timeoutMs: 40_000, timeoutCapMs: 45_000 },
    capability: CONTEXTDEV_PEOPLE_SEARCH_CAPABILITY,
    request: { url: `${base()}/people/search`, method: "POST", headers: {}, body: { query: input.query.slice(0, 500), mode: "fast", ...(input.country ? { filters: { countries: [input.country.toUpperCase().slice(0, 2)] } } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) } },
    interpret: (a): InterpretedAnswer<PeopleOutcome> => {
      if (!Array.isArray(a.json?.results)) return { status: "failed", data: null, units: 0, credits: creditsOf(a.json), errorCode: "unexpected_shape" };
      const reported = creditsOf(a.json);
      const rows = a.json.results as unknown[];
      // a page with no match is free (documented); a page with people costs the fast-mode page price unless the answer says otherwise
      const credits = reported !== null ? reported : rows.length === 0 ? 0 : CONTEXTDEV_PEOPLE_SEARCH_CREDITS;
      return { status: rows.length === 0 ? "empty" : "success", data: { rows, nextCursor: typeof a.json.next_cursor === "string" ? a.json.next_cursor : null, requestId: typeof a.json?.request_id === "string" ? a.json.request_id : null, costBasis: reported !== null ? "reported" : "estimated" }, units: rows.length, credits };
    },
  });
}
