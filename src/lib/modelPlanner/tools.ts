import { z } from "zod";
import { catalogSearch, describeEndpoint, type CatalogEndpoint, type CatalogHit, type TregCatalog, loadTregCatalog } from "../treg/catalog";
import { blockedEndpointReason } from "../treg/blockList";
import { categoryOf, policyVerdict, type AccountAccess } from "../treg/dataPolicy";
import { digestFromCatalogExample } from "./digest";
import { SAMPLE_ROWS_REQUESTED } from "./constants";
import { ProposePlanSchema } from "./types";
import { unitCost } from "./pricing";

/** The tools the planning model gets. `catalog_search` and `describe_endpoint` are local (zero cost); `sample_call` is a REAL call under the exploration caps; `propose_plan` ends the loop when it validates. */
export const TOOL_NAMES = ["catalog_search", "describe_endpoint", "sample_call", "propose_plan"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const inlineRefs = (schema: any): any => {
  if (Array.isArray(schema)) return schema.map(inlineRefs);
  if (schema && typeof schema === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === "$schema" || k === "id") continue;
      out[k === "oneOf" ? "anyOf" : k] = inlineRefs(v);
    }
    return out;
  }
  return schema;
};

export function proposePlanJsonSchema(): Record<string, unknown> {
  return inlineRefs(z.toJSONSchema(ProposePlanSchema, { target: "draft-7", io: "input" }));
}

export function anthropicToolDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      name: "catalog_search",
      description: "Search the data catalog (3,000+ endpoints) by platform and English words. Returns up to 10 endpoints with id, what it does, its price unit and its required inputs. Translate the customer's request into English search words; try the platform first (for example platform «tiktok», words [«comments»]).",
      input_schema: { type: "object", properties: { platform: { type: "string", description: "platform name as the catalog writes it (x, tiktok, instagram, facebook, youtube, linkedin, companies, people, web, google…)" }, words: { type: "array", items: { type: "string" }, description: "English words for the capability («comments», «user posts», «search»)" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["words"] },
    },
    {
      name: "describe_endpoint",
      description: "The full description of ONE endpoint: its inputs (type, required, allowed values, maximum), its price unit, how it pages, and a trimmed example of its answer. Call it before you plan or sample an endpoint.",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "sample_call",
      description: "ONE real call of an endpoint with a small page, to see its REAL answer shape (the app pays for it, within a small limit; you do not know the price). Use values the customer gave (quote their words in `quote` for each customer value). Returns the list path, the cursor, the field names with types and three real rows. Use it once per endpoint you intend to plan; never to explore many endpoints.",
      input_schema: { type: "object", properties: { id: { type: "string" }, params: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: {}, source: { type: "string", enum: ["customer_text", "derived", "literal", "prior_step"] }, quote: { type: "string" } }, required: ["name", "source"] } }, limit: { type: "integer", minimum: 1, maximum: SAMPLE_ROWS_REQUESTED } }, required: ["id", "params"] },
    },
    {
      name: "propose_plan",
      description: "Propose the plan: one step (or two: a listing step, then a step run once per listed item). Every parameter has a source: customer_text (with the customer's exact words in `quote`), literal (a fixed choice like a sort order; never an account, link or id) or prior_step. Add a filter only for what the customer asked (an account's own posts, no replies, a period THE CUSTOMER STATED). Never add a period the customer did not state. If a required value is missing from the customer's words, do not call this: answer in Arabic with ONE short question instead.",
      input_schema: proposePlanJsonSchema(),
    },
  ];
}

const clip = (s: unknown, n: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** «0.001 USD per call» for the model (internal: never shown to a customer). */
function costLabel(e: CatalogEndpoint, catalog: TregCatalog): string {
  const c = unitCost(e, catalog);
  if (!c) return "not priced (cannot be sold)";
  return `${c.usd} USD per ${c.unit}${e.kind === "routed" ? " (worst case of the providers behind it)" : ""}`;
}

/** What one record costs from this endpoint, as the planner shows it (USD): a per-record price as is; a per-call price over the rows a call usually returns (its page size, at most 20). Null when it has no usable price. */
export function estimatedCostPerRecordUsd(e: CatalogEndpoint, catalog: TregCatalog): number | null {
  const c = unitCost(e, catalog);
  if (!c) return null;
  if (c.unit === "record") return c.usd;
  const limit = e.inputs.find((i) => ["limit", "count", "page_size", "per_page", "size", "num", "max_results"].includes(i.name))?.maximum ?? 20;
  return c.usd / Math.max(1, Math.min(20, limit));
}

export interface SearchToolResult { hits: Array<Record<string, unknown>>; hidden: number; restrictedTop: boolean }

/** `catalog_search` for one account: an endpoint the account may not use (blocked, or sensitive for an account that is not verified) is never listed. */
export function toolCatalogSearch(input: { platform?: string; words?: string[]; limit?: number }, access: AccountAccess, catalog: TregCatalog = loadTregCatalog()): SearchToolResult {
  const limit = Math.max(1, Math.min(10, Math.floor(input.limit ?? 8)));
  const all: CatalogHit[] = catalogSearch({ platform: input.platform ?? null, words: Array.isArray(input.words) ? input.words.map(String) : [], limit: 50 }, catalog);
  const allowed = all.filter((h) => policyVerdict(h.id, access).allowed && !blockedEndpointReason(h.id));
  const priceable = allowed.filter((h) => { const e = catalog.byId.get(h.id); return e ? unitCost(e, catalog) !== null : false; });
  const top = all[0];
  const restrictedTop = Boolean(top) && (categoryOf(top.id) === "sensitive" && !policyVerdict(top.id, access).allowed);
  const hidden = all.length - allowed.length;
  // The candidates are shown SORTED BY COST PER RECORD, cheapest first (an endpoint priced per call is divided by the rows a call usually returns: its page size, up to 20), each with its rank.
  // Relevance still decides WHICH candidates are listed; cost decides their order. The model samples the cheapest one that suits the request first.
  const listed = priceable.slice(0, limit).map((h) => {
    const e = catalog.byId.get(h.id)!;
    return { hit: h, e, perRecord: estimatedCostPerRecordUsd(e, catalog) };
  }).sort((a, b) => (a.perRecord ?? Number.POSITIVE_INFINITY) - (b.perRecord ?? Number.POSITIVE_INFINITY) || a.hit.id.localeCompare(b.hit.id));
  return {
    restrictedTop,
    hidden,
    hits: listed.map(({ hit: h, e, perRecord }, index) => ({ rank: index + 1, id: h.id, name: clip(h.name, 80), platform: h.platform, capability: h.capability, summary: clip(h.summary, 140), price: costLabel(e, catalog), costPerRecordUsd: perRecord === null ? undefined : Number(perRecord.toFixed(6)), requiredInputs: h.requiredInputs, inputs: e.inputs.slice(0, 10).map((i) => `${i.name}${i.required ? "*" : ""}${i.type ? `:${i.type}` : ""}`), okRate: h.observedOkRate })),
  };
}

export type DescribeToolResult = { ok: true; endpoint: Record<string, unknown> } | { ok: false; reason: "unknown" | "not_allowed"; message: string };

export function toolDescribeEndpoint(input: { id?: string }, access: AccountAccess, catalog: TregCatalog = loadTregCatalog(), recipe?: { slug: string; steps: unknown } | null): DescribeToolResult {
  const id = String(input.id ?? "").trim();
  const e = describeEndpoint(id, catalog);
  if (!e) return { ok: false, reason: "unknown", message: `«${id}» is not an endpoint of the catalog` };
  const verdict = policyVerdict(id, access);
  if (!verdict.allowed || blockedEndpointReason(id, e.scope)) return { ok: false, reason: "not_allowed", message: "this endpoint cannot be used for this customer" };
  const example = digestFromCatalogExample(e);
  return {
    ok: true,
    endpoint: {
      id: e.id, name: clip(e.name, 120), platform: e.platform, capability: e.capability, summary: clip(e.summary, 300), method: e.method, kind: e.kind,
      price: costLabel(e, catalog), billingNote: clip(e.cost?.billing_note, 200),
      inputs: e.inputs.map((i) => ({ name: i.name, type: i.type, required: i.required, enum: i.enum ?? undefined, minimum: i.minimum ?? undefined, maximum: i.maximum ?? undefined, default: i.default ?? undefined, note: clip(i.note, 140) })),
      pagination: e.pagination,
      listPath: e.list_path, cursorPath: e.cursor_path,
      itemFields: e.item_fields ? Object.fromEntries(Object.entries(e.item_fields).slice(0, 40).map(([k, v]) => [k, v.type])) : null,
      exampleRows: example ? example.digest.sampleRows.slice(0, 2) : null,
      observed: e.observed ? { samples: (e.observed as any).samples, okRate: (e.observed as any).ok_rate } : null,
      recipe: recipe ? { note: "a previous plan on this endpoint delivered rows with this field map; reuse it when it fits the request and you may skip sample_call", steps: recipe.steps } : undefined,
      sensitiveCategory: verdict.category === "sensitive" ? "personal data: used only with a stated purpose" : undefined,
    },
  };
}

