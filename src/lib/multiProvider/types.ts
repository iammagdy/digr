/** Data providers of the multi-provider feature. The language model provider is separate (it never collects data). */
export type DataProviderId = "treg" | "firecrawl" | "contextdev";
export const DATA_PROVIDER_IDS: readonly DataProviderId[] = ["treg", "firecrawl", "contextdev"];

/** What one capability does. */
export type OperationKind =
  | "discover.companies" // a list of companies from a directory
  | "discover.web_search" // web results for a query
  | "site.map" // the URLs of one website
  | "page.read" // one public page as text and links
  | "page.read_structured" // one public page as structured fields
  | "people.enrich" // a person's profile from a clue
  | "site.crawl"
  | "agent.run"
  | "extract.run";

/** The fields a capability can return. Only these business fields are ever collected. */
export type DataField = "business_name" | "website" | "country" | "industry" | "description" | "work_email" | "office_phone" | "profile_link" | "decision_maker" | "page_url";

/** VERIFIED: the price comes from the provider's official documentation (the URL is in `priceSources`). UNVERIFIED: it does not; the capability is never sold. */
export type PriceStatus = "VERIFIED" | "UNVERIFIED";

export type CapabilityUnit = "result" | "call" | "page" | "record" | "match";

export interface CapabilityDef {
  /** Internal id (admin only): never shown to a customer. */
  id: string;
  provider: DataProviderId;
  operation: OperationKind;
  unit: CapabilityUnit;
  /** What one billed call covers (for example a search call covers up to 10 results). */
  unitsPerCall: number;
  /** Credits one call costs, for the credit-priced providers. Null for TREG (priced per record in USD). */
  creditsPerCall: number | null;
  /** USD cost of ONE call at the basis of `usdPerCredit` (null when the price is UNVERIFIED). */
  costPerCallUsd: number | null;
  /** USD cost of one unit (call cost / units per call); null when UNVERIFIED. */
  costPerUnitUsd: number | null;
  priceStatus: PriceStatus;
  /** Official pages the price was read from. */
  priceSources: string[];
  fields: DataField[];
  reliabilityNote: string;
  /** Arabic label, admin screens only. */
  labelAr: string;
  /** Why the capability is never sold even though it exists (an unverified price, a data policy rule, an unbounded cost). */
  blockedReason?: "unverified_price" | "data_policy" | "unbounded_cost";
}

export type RequiredField = "work_email" | "office_phone" | "profile_link" | "decision_maker";

/** What the customer asked for, in code terms (built by code from the plan item, never by the model). */
export interface RouteRequest {
  industry?: string;
  country?: string;
  keyword?: string;
  /** Number of verified business rows wanted. */
  count: number;
  requiredFields: RequiredField[];
}

export type StageKind = "discover" | "enrich" | "verify";

export interface RouteStage {
  stage: StageKind;
  /** Capability ids this stage may use, in preference order: the first is the planned one, the rest are fallbacks. */
  capabilityIds: string[];
  /** Hard bound on the billed calls of this stage in one job. */
  maxCalls: number;
}

/** A route is one provider alone or a bounded chain of stages. */
export interface RouteDef {
  id: string;
  kind: "single" | "chain";
  stages: RouteStage[];
  /** Data fields the route can deliver. */
  fields: DataField[];
}
