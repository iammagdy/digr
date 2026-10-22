import { PROVIDER_FACTS, capabilitiesOfProvider, capabilityById } from "../../../multiProvider/catalog";
import { linksFromMarkdown } from "../../../multiProvider/policy";
import type { CapabilityDef, OperationKind } from "../../../multiProvider/types";
import type { AdapterContext, ErrorCode, OperationInputs, OperationOutputs, OperationResult, ProviderAdapter, SearchHit, SupportedOperation } from "../adapterTypes";
import { runRecordedCall, type InterpretedAnswer } from "../httpCall";

/**
 * Context.dev API v1 (https://docs.context.dev). Bearer key from the encrypted provider key store.
 *  search  POST /v1/web/search  { query, numResults 1..100, country, timeoutOpts }       -> results[{url,title,description}], key_metadata.credits_consumed
 *  map     GET  /v1/web/urls    ?domain&maxLinks&urlRegex                               -> urls[{url,title}], key_metadata
 *  scrape  POST /v1/web/scrape  { url, formats:{markdown:true}, timeoutOpts }           -> markdown:{requested,success,data,error_code}, key_metadata
 * Credits are read from key_metadata.credits_consumed on every answer (errors carry it too). A scrape answers 200 with a per-output
 * `success`: a failed output is a FAILED call, mapped by its own error_code (WEBSITE_BLOCKED is a refusal by the site and is never worked around).
 */
const FACTS = PROVIDER_FACTS.contextdev;
const base = () => FACTS.baseUrl as string;
const TIMEOUT = { milliseconds: 20000, behavior: "fail" } as const;

function creditsOf(json: any): number | null {
  const n = Number(json?.key_metadata?.credits_consumed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function hostOf(url: string): string | null {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ""); } catch { return null; }
}

function outputError(output: any): ErrorCode {
  const code = String(output?.error_code ?? "").toUpperCase();
  if (code === "WEBSITE_BLOCKED") return "blocked_site";
  if (code === "WEBSITE_NOT_FOUND") return "not_found";
  if (code === "REQUEST_TIMEOUT" || code === "TIMEOUT") return "timeout";
  if (code === "INPUT_VALIDATION_ERROR" || code === "UNSUPPORTED_CONTENT" || code === "CONTENT_TOO_LARGE") return "bad_request";
  return "server_error";
}

export const contextDevAdapter: ProviderAdapter = {
  id: "contextdev",
  capabilities: (): CapabilityDef[] => capabilitiesOfProvider("contextdev"),
  supports: (operation: OperationKind) => ["discover.web_search", "site.map", "page.read", "page.read_structured"].includes(operation),

  async run<K extends SupportedOperation>(operation: K, input: OperationInputs[K], ctx: AdapterContext): Promise<OperationResult<OperationOutputs[K]>> {
    switch (operation) {
      case "discover.web_search": {
        const i = input as OperationInputs["discover.web_search"];
        // Whole tens: the price is 1 credit per 10 results returned.
        const numResults = Math.max(10, Math.min(100, Math.ceil(i.limit / 10) * 10));
        return runRecordedCall<SearchHit[]>({
          ctx, capability: capabilityById("contextdev.search") as CapabilityDef,
          request: { url: `${base()}/web/search`, method: "POST", headers: {}, body: { query: i.query.slice(0, 500), numResults, ...(i.country ? { country: i.country.toLowerCase().slice(0, 2) } : {}), ...(i.excludeDomains?.length ? { excludeDomains: i.excludeDomains.slice(0, 100) } : {}), timeoutOpts: TIMEOUT } },
          interpret: (a): InterpretedAnswer<SearchHit[]> => {
            if (!Array.isArray(a.json?.results)) return { status: "failed", data: null, units: 0, credits: creditsOf(a.json), errorCode: "unexpected_shape" };
            const hits: SearchHit[] = [];
            for (const r of a.json.results) {
              if (typeof r?.url !== "string" || !r.url) continue;
              hits.push({ url: r.url, title: typeof r.title === "string" ? r.title : "", description: typeof r.description === "string" ? r.description : "" });
            }
            return { status: hits.length === 0 ? "empty" : "success", data: hits, units: hits.length, credits: creditsOf(a.json) ?? (hits.length === 0 ? 0 : Math.ceil(hits.length / 10)) };
          },
        }) as Promise<OperationResult<OperationOutputs[K]>>;
      }
      case "site.map": {
        const i = input as OperationInputs["site.map"];
        const domain = hostOf(i.url);
        if (!domain) return { ok: false, status: "failed", data: null, units: 0, credits: 0, costUsd: 0, durationMs: 0, httpStatus: null, errorCode: "bad_request", retryable: false } as OperationResult<OperationOutputs[K]>;
        const query = new URLSearchParams({ domain, maxLinks: String(Math.max(1, Math.min(200, i.limit ?? 50))), urlRegex: "contact|about|team|leadership" });
        return runRecordedCall<{ urls: string[] }>({
          ctx, capability: capabilityById("contextdev.map") as CapabilityDef,
          request: { url: `${base()}/web/urls?${query.toString()}`, method: "GET", headers: {} },
          interpret: (a) => {
            if (!Array.isArray(a.json?.urls)) return { status: "failed", data: null, units: 0, credits: creditsOf(a.json), errorCode: "unexpected_shape" };
            const urls = a.json.urls.map((u: any) => (typeof u === "string" ? u : u?.url)).filter((u: unknown): u is string => typeof u === "string" && u.length > 0);
            return { status: urls.length === 0 ? "empty" : "success", data: { urls }, units: urls.length, credits: creditsOf(a.json) };
          },
        }) as Promise<OperationResult<OperationOutputs[K]>>;
      }
      case "page.read": {
        const i = input as OperationInputs["page.read"];
        return runRecordedCall<{ markdown: string; links: string[]; finalUrl: string; statusCode: number | null }>({
          ctx, capability: capabilityById("contextdev.scrape") as CapabilityDef,
          request: { url: `${base()}/web/scrape`, method: "POST", headers: {}, body: { url: i.url, formats: { markdown: true }, markdownParams: { includeLinks: true }, timeoutOpts: TIMEOUT } },
          interpret: (a) => {
            const out = a.json?.markdown;
            if (!out || typeof out !== "object") return { status: "failed", data: null, units: 0, credits: creditsOf(a.json), errorCode: "unexpected_shape" };
            if (out.success === false) return { status: "failed", data: null, units: 0, credits: creditsOf(a.json), errorCode: outputError(out) };
            const markdown = typeof out.data === "string" ? out.data : "";
            const page = { markdown, links: linksFromMarkdown(markdown), finalUrl: typeof a.json?.url === "string" ? a.json.url : i.url, statusCode: null };
            return { status: markdown.trim() ? "success" : "empty", data: page, units: markdown.trim() ? 1 : 0, credits: creditsOf(a.json) };
          },
        }) as Promise<OperationResult<OperationOutputs[K]>>;
      }
      case "page.read_structured": {
        const i = input as OperationInputs["page.read_structured"];
        return runRecordedCall<{ json: unknown; finalUrl: string }>({
          ctx, capability: capabilityById("contextdev.scrape_json") as CapabilityDef,
          request: { url: `${base()}/web/scrape`, method: "POST", headers: {}, body: { url: i.url, formats: { json: true }, jsonParams: { schema: i.schema, instructions: i.prompt.slice(0, 2000) }, timeoutOpts: TIMEOUT } },
          interpret: (a) => {
            const out = a.json?.json;
            if (!out || typeof out !== "object") return { status: "failed", data: null, units: 0, credits: creditsOf(a.json), errorCode: "unexpected_shape" };
            if (out.success === false) return { status: "failed", data: null, units: 0, credits: creditsOf(a.json), errorCode: outputError(out) };
            const has = out.data && typeof out.data === "object" && Object.keys(out.data).length > 0;
            return { status: has ? "success" : "empty", data: { json: out.data ?? null, finalUrl: typeof a.json?.url === "string" ? a.json.url : i.url }, units: has ? 1 : 0, credits: creditsOf(a.json) };
          },
        }) as Promise<OperationResult<OperationOutputs[K]>>;
      }
      default:
        throw new Error(`contextdev does not support ${String(operation)}`);
    }
  },
};
