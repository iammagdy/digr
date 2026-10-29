import type { CapabilityDef, DataProviderId, OperationKind } from "../../multiProvider/types";

/**
 * The provider adapter interface. One adapter per provider (TREG, Firecrawl, Context.dev). Each adapter has:
 *  - a capability list (from the registry, with its documented price),
 *  - call limits per request and a timeout (from `PROVIDER_FACTS`),
 *  - an error mapping (`ErrorCode`: what a status code or an error body means for the router),
 *  - a cost-recording hook (`CallRecorder`): EVERY call, successful, failed or empty, is recorded in provider_costs through the
 *    approved SQL functions with the provider identifier. The adapter never writes money rows itself.
 */

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type CallStatus = "success" | "failed" | "empty";

/** What went wrong, in the router's terms. `retryable` errors are worth a call on another provider; the rest are not. */
export type ErrorCode =
  | "auth_rejected" // 401 / 403 on the key
  | "insufficient_credits" // 402
  | "rate_limited" // 429
  | "timeout" // 408 or our own timeout
  | "blocked_site" // the target site refused or protects itself: never worked around, and never retried on another provider
  | "not_found" // 404 / the page does not exist
  | "bad_request" // 400 / 422 / a request the provider refuses
  | "server_error" // 5xx
  | "network" // no answer
  | "unexpected_shape" // an answer without the documented fields
  | "cap_reached" // the daily cap of this provider has no room for the call (nothing was sent)
  | "policy_blocked"; // the data policy refused the page (robots, login, social network)

export const RETRYABLE_ON_ANOTHER_PROVIDER: ReadonlySet<ErrorCode> = new Set(["insufficient_credits", "rate_limited", "timeout", "server_error", "network", "auth_rejected"]);

export interface CallRecord {
  provider: DataProviderId;
  capabilityId: string;
  status: CallStatus;
  /** Units the call returned (results, pages, records). */
  units: number;
  /** USD the provider charged (or the best known charge); 0 for a call the provider did not charge. */
  costUsd: number;
  durationMs: number;
  jobId: string | null;
  /** TREG key pool: the pool key that made the call (number and label go to the call log; never the key). Absent while the pool's switch is OFF. */
  keyRef?: { id: string; number: number; label: string; isMain: boolean } | null;
}

export interface Reservation { allowed: boolean; costId: number | null; reason?: "cap" | "error" }

/** The cost-recording hook. Implemented once (`callRecorder.ts`) over the approved reserve and commit functions; tests pass a fake. */
export interface CallRecorder {
  /** Holds the estimated cost against this provider's daily cap BEFORE the call. `allowed: false` means nothing may be sent. */
  reserve(args: { provider: DataProviderId; capabilityId: string; estimatedUsd: number; jobId: string | null }): Promise<Reservation>;
  /** Replaces the estimate with what the call really cost and writes what happened. Called for every reserved call. */
  commit(costId: number | null, record: CallRecord): Promise<void>;
}

export interface AdapterContext {
  apiKey: string;
  fetchFn: FetchFn;
  recorder: CallRecorder;
  jobId: string | null;
  /** Test clock. */
  now?: () => number;
  /** Overrides the provider's call timeout (never above it). */
  timeoutMs?: number;
  /** A call that is known to take longer than the provider's usual timeout (a parser reading 1,000 reviews takes up to 45 s) may raise the ceiling to this. */
  timeoutCapMs?: number;
}

export interface OperationResult<T> {
  ok: boolean;
  status: CallStatus;
  data: T | null;
  units: number;
  credits: number;
  costUsd: number;
  durationMs: number;
  httpStatus: number | null;
  errorCode?: ErrorCode;
  retryable: boolean;
}

export interface SearchHit { url: string; title: string; description: string }
export interface MapResult { urls: string[] }
export interface PageResult { markdown: string; links: string[]; finalUrl: string; statusCode: number | null }
export interface StructuredPageResult { json: unknown; finalUrl: string }

export interface OperationInputs {
  "discover.web_search": { query: string; limit: number; country?: string; excludeDomains?: string[] };
  "site.map": { url: string; search?: string; limit?: number };
  "page.read": { url: string };
  "page.read_structured": { url: string; prompt: string; schema: Record<string, unknown> };
}
export interface OperationOutputs {
  "discover.web_search": SearchHit[];
  "site.map": MapResult;
  "page.read": PageResult;
  "page.read_structured": StructuredPageResult;
}
export type SupportedOperation = keyof OperationInputs;

export interface ProviderAdapter {
  id: DataProviderId;
  capabilities(): CapabilityDef[];
  supports(operation: OperationKind): boolean;
  run<K extends SupportedOperation>(operation: K, input: OperationInputs[K], ctx: AdapterContext): Promise<OperationResult<OperationOutputs[K]>>;
}
