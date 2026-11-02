import type { CatalogEndpoint } from "../treg/catalog";

/**
 * THE REAL PAGE LIMIT OF A TOOL, FROM ITS OWN CATALOG SCHEMA (S2 item 3; docs/S1-LIVE-FINDINGS.md, «Live run of 2026-11-02», L0.3). The size of the planner's sample (`limit: 20`) is the planner's choice, never the tool's limit: the cap on what one call gives is
 * what the endpoint states for its size input (its `maximum`, or «at most N» in its own description), else the default it states. Pure: nothing is called and nothing is guessed beyond the words of the schema.
 */
const SIZE_INPUT = /^(?:limit|count|page_size|pagesize|per_page|perpage|size|num|max_results|maxresults|max_items|maxitems|n)$/i;
const NUMBER = (t: string | undefined): number | null => { if (!t) return null; const n = Number(t.replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; };

export interface PageLimit {
  /** The size input of the endpoint (`limit`, `count`…). */
  param: string;
  /** The most one call gives, as the schema states it; null when it states none. */
  max: number | null;
  /** The size one call gives when the input is not sent, as the schema states it; null when it states none. */
  default: number | null;
}

export function pageLimitOf(endpoint: Pick<CatalogEndpoint, "inputs" | "summary">): PageLimit | null {
  const input = endpoint.inputs.find((i) => SIZE_INPUT.test(i.name) && (i.type === "integer" || i.type === "number"));
  if (!input) return null;
  const text = [endpoint.summary ?? "", input.note ?? ""].join(" ");
  // the sentence of the endpoint that talks about this input: «`limit` how many comments (default 50, at most 500; …)»
  const about = new RegExp(`\`?\\b${input.name}\\b\`?[^.]*`, "i").exec(text)?.[0] ?? "";
  const max = (typeof input.maximum === "number" && input.maximum > 0 ? input.maximum : null) ?? NUMBER(/\bat most (\d[\d,]*)/i.exec(about)?.[1]) ?? NUMBER(/\bmax(?:imum)?(?: of)? (\d[\d,]*)/i.exec(about)?.[1]);
  const def = (typeof input.default === "number" && input.default > 0 ? input.default : null) ?? NUMBER(/\bdefault (?:of )?(\d[\d,]*)/i.exec(`${input.note ?? ""} ${about}`)?.[1]);
  return { param: input.name, max, default: def };
}

/**
 * WHAT ONE CALL OF A SOURCE WITH NO NEXT PAGE GIVES for a parent: its stated maximum, else its stated default; null for a source that pages (`cursorParam` set). A source with no size input of its own gives what its page gives, and a page nobody sized is measured by the sample
 * (`sampleRows`). The sample's size is NEVER the cap of a source that has a size input.
 */
export function pageCapOfSource(endpoint: Pick<CatalogEndpoint, "inputs" | "summary">, cursorParam: string | null, sampleRows: number | null): number | null {
  if (cursorParam !== null) return null;
  const limit = pageLimitOf(endpoint);
  if (!limit) return sampleRows !== null && sampleRows > 0 ? sampleRows : null;
  return limit.max ?? limit.default ?? (sampleRows !== null && sampleRows > 0 ? sampleRows : null);
}
