import { PROVIDER_FACTS, capabilitiesOfProvider, capabilityById } from "../../../multiProvider/catalog";
import type { CapabilityDef, OperationKind } from "../../../multiProvider/types";
import type { AdapterContext, OperationInputs, OperationOutputs, OperationResult, ProviderAdapter, SearchHit, SupportedOperation } from "../adapterTypes";
import { runRecordedCall, type InterpretedAnswer } from "../httpCall";

/**
 * Firecrawl, v2 API (https://docs.firecrawl.dev/api-reference/v2-introduction). Bearer key from the encrypted provider key store.
 *  search  POST /v2/search   { query, limit 1..100, sources:["web"], country, timeout }   -> data.web[{url,title,description}], creditsUsed
 *  map     POST /v2/map      { url, search, limit, sitemap:"include" }                      -> links[{url,title,description}]
 *  scrape  POST /v2/scrape   { url, formats, onlyMainContent:false, timeout, proxy }        -> data.markdown, data.links, data.metadata.statusCode
 * A scrape that the API accepted is HTTP 200 even when the page failed: data.metadata.statusCode is the page's own status, so a page
 * that did not load cleanly (not 2xx or 304) is a FAILED call. The credits of a served scrape are charged either way (the
 * documentation does not say a failed page is free, so it is recorded as charged: the conservative side).
 */
const FACTS = PROVIDER_FACTS.firecrawl;
const base = () => FACTS.baseUrl as string;

const STATUS_OK = (code: unknown) => typeof code === "number" && ((code >= 200 && code < 300) || code === 304);


function webHits(json: any): SearchHit[] {
  const web = Array.isArray(json?.data?.web) ? json.data.web : Array.isArray(json?.data) ? json.data : [];
  const out: SearchHit[] = [];
  for (const item of web) {
    const url = typeof item?.url === "string" ? item.url : "";
    if (!url) continue;
    out.push({ url, title: typeof item?.title === "string" ? item.title : "", description: typeof item?.description === "string" ? item.description : "" });
  }
  return out;
}

export const firecrawlAdapter: ProviderAdapter = {
  id: "firecrawl",
  capabilities: (): CapabilityDef[] => capabilitiesOfProvider("firecrawl"),
  supports: (operation: OperationKind) => ["discover.web_search", "site.map", "page.read", "page.read_structured"].includes(operation),

  async run<K extends SupportedOperation>(operation: K, input: OperationInputs[K], ctx: AdapterContext): Promise<OperationResult<OperationOutputs[K]>> {
    switch (operation) {
      case "discover.web_search": {
        const i = input as OperationInputs["discover.web_search"];
        const limit = Math.max(1, Math.min(100, Math.floor(i.limit)));
        return runRecordedCall<SearchHit[]>({
          ctx, capability: capabilityById("firecrawl.search") as CapabilityDef,
          request: { url: `${base()}/search`, method: "POST", headers: {}, body: { query: i.query.slice(0, 500), limit, sources: ["web"], ...(i.country ? { country: i.country.toUpperCase() } : {}), ...(i.excludeDomains?.length ? { excludeDomains: i.excludeDomains.slice(0, 100) } : {}), timeout: 20000 } },
          interpret: (a): InterpretedAnswer<SearchHit[]> => {
            if (a.json?.success === false) return { status: "failed", data: null, units: 0, credits: null, errorCode: "unexpected_shape" };
            const hits = webHits(a.json);
            const credits = Number.isInteger(a.json?.creditsUsed) ? a.json.creditsUsed : hits.length === 0 ? 0 : Math.ceil(hits.length / 10) * 2;
            return { status: hits.length === 0 ? "empty" : "success", data: hits, units: hits.length, credits };
          },
        }) as Promise<OperationResult<OperationOutputs[K]>>;
      }
      case "site.map": {
        const i = input as OperationInputs["site.map"];
        return runRecordedCall<{ urls: string[] }>({
          ctx, capability: capabilityById("firecrawl.map") as CapabilityDef,
          request: { url: `${base()}/map`, method: "POST", headers: {}, body: { url: i.url, ...(i.search ? { search: i.search } : {}), limit: Math.max(1, Math.min(200, i.limit ?? 50)), sitemap: "include", includeSubdomains: false, timeout: 20000 } },
          interpret: (a) => {
            const links = Array.isArray(a.json?.links) ? a.json.links : null;
            if (!links) return { status: "failed", data: null, units: 0, credits: null, errorCode: "unexpected_shape" };
            const urls = links.map((l: any) => (typeof l === "string" ? l : l?.url)).filter((u: unknown): u is string => typeof u === "string" && u.length > 0);
            return { status: urls.length === 0 ? "empty" : "success", data: { urls }, units: urls.length, credits: null };
          },
        }) as Promise<OperationResult<OperationOutputs[K]>>;
      }
      case "page.read": {
        const i = input as OperationInputs["page.read"];
        return runRecordedCall<{ markdown: string; links: string[]; finalUrl: string; statusCode: number | null }>({
          ctx, capability: capabilityById("firecrawl.scrape") as CapabilityDef,
          // onlyMainContent is off on purpose: contact details sit in headers and footers, which main-content mode drops.
          request: { url: `${base()}/scrape`, method: "POST", headers: {}, body: { url: i.url, formats: ["markdown", "links"], onlyMainContent: false, timeout: 20000, proxy: "auto" } },
          interpret: (a) => {
            const d = a.json?.data;
            if (a.json?.success === false || !d || typeof d !== "object") return { status: "failed", data: null, units: 0, credits: null, errorCode: "unexpected_shape" };
            const statusCode = typeof d.metadata?.statusCode === "number" ? d.metadata.statusCode : null;
            const markdown = typeof d.markdown === "string" ? d.markdown : "";
            const links = Array.isArray(d.links) ? d.links.filter((l: unknown): l is string => typeof l === "string") : [];
            const page = { markdown, links, finalUrl: typeof d.metadata?.url === "string" ? d.metadata.url : i.url, statusCode };
            if (statusCode !== null && !STATUS_OK(statusCode)) return { status: "failed", data: null, units: 0, credits: 1, errorCode: statusCode === 404 ? "not_found" : statusCode === 401 || statusCode === 403 || statusCode === 429 ? "blocked_site" : "server_error" };
            if (!markdown.trim()) return { status: "empty", data: page, units: 0, credits: null };
            return { status: "success", data: page, units: 1, credits: null };
          },
        }) as Promise<OperationResult<OperationOutputs[K]>>;
      }
      case "page.read_structured": {
        const i = input as OperationInputs["page.read_structured"];
        return runRecordedCall<{ json: unknown; finalUrl: string }>({
          ctx, capability: capabilityById("firecrawl.scrape_json") as CapabilityDef,
          request: { url: `${base()}/scrape`, method: "POST", headers: {}, body: { url: i.url, formats: [{ type: "json", prompt: i.prompt, schema: i.schema }], onlyMainContent: false, timeout: 20000, proxy: "auto" } },
          interpret: (a) => {
            const d = a.json?.data;
            if (a.json?.success === false || !d || typeof d !== "object") return { status: "failed", data: null, units: 0, credits: null, errorCode: "unexpected_shape" };
            const statusCode = typeof d.metadata?.statusCode === "number" ? d.metadata.statusCode : null;
            if (statusCode !== null && !STATUS_OK(statusCode)) return { status: "failed", data: null, units: 0, credits: 1, errorCode: statusCode === 404 ? "not_found" : "blocked_site" };
            const json = d.json ?? null;
            const has = json && typeof json === "object" && Object.keys(json as object).length > 0;
            return { status: has ? "success" : "empty", data: { json, finalUrl: typeof d.metadata?.url === "string" ? d.metadata.url : i.url }, units: has ? 1 : 0, credits: null };
          },
        }) as Promise<OperationResult<OperationOutputs[K]>>;
      }
      default:
        throw new Error(`firecrawl does not support ${String(operation)}`);
    }
  },
};
