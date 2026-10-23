import type { DataProviderId, RouteRequest } from "./types";

/**
 * The ROUTING TRACE of a job: what the router decided and why (at the quote), and what each stage then did (per chunk): provider and
 * capability, calls, cost, found / new / duplicate, fallbacks. ADMIN ONLY. It is kept in the private `partials` storage bucket (no customer
 * policy reaches it), never in job_events, because the customer's browser reads job_events directly. Pure types and merging; no server imports.
 */
export type TraceStageName = "discover" | "enrich" | "verify";

export interface PlannedStage {
  stage: TraceStageName;
  provider: DataProviderId | null;
  capabilityId: string | null;
  /** Fractional unit price of the stage in points per delivered row (informational: the job price is the shared rule on the total). */
  unitPricePoints: number;
  maxCalls: number;
  /** Share of what enters the stage that goes on (ASSUMED until measured). */
  expectedYield: number | null;
  /** Provider USD the stage may spend in the whole job (estimate). */
  estimatedJobUsd: number;
}

export interface RoutingDecision {
  at: string;
  routeId: string;
  routeCode: string;
  /** Who chose: the model (a valid choice), code (cheapest allowed), or the only option. */
  source: "model" | "cheapest_allowed" | "only_option";
  /** The model's one-line reason, when it chose and the choice was valid. */
  reason: string | null;
  /** Why code decided instead of the model, when it did. */
  fallbackReason?: "no_chooser" | "model_failed" | "invalid_choice";
  modelCalled: boolean;
  request: RouteRequest;
  count: number;
  unitPricePoints: number;
  reservePoints: number;
  /** The provider-spend budget of the job in USD (estimate + 15%). */
  budgetUsd: number;
  stages: PlannedStage[];
  allowed: Array<{ routeId: string; costPerDeliveredRowUsd: number; unitPricePoints: number; reservePoints: number; count: number }>;
  excluded: Array<{ routeId: string; reason: string; provider?: DataProviderId; capabilityId?: string }>;
}

export interface StageTrace {
  stage: TraceStageName;
  provider: DataProviderId | null;
  capabilityId: string | null;
  calls: number;
  success: number;
  failed: number;
  empty: number;
  costUsd: number;
  durationMs: number;
  /** Discovery: companies found, new, duplicates. Enrichment: companies read. Verify: rows verified / not verified. */
  found: number;
  fresh: number;
  duplicate: number;
  read: number;
  skipped: number;
  verified: number;
  unverified: number;
}

export interface FallbackTrace {
  stage: TraceStageName;
  fromCapabilityId: string;
  /** The next capability tried, or null when none was left. */
  toCapabilityId: string | null;
  reason: string;
}

export interface ChunkTrace {
  step: number;
  at: string;
  stages: StageTrace[];
  fallbacks: FallbackTrace[];
  delivered: number;
  spentBeforeUsd: number;
  costUsd: number;
  /** Why the chain stopped in this chunk, when it did. */
  stoppedBy: "budget" | "no_more_work" | "target_reached" | null;
}

export interface RoutingTrace {
  v: 1;
  jobId: string;
  decision: RoutingDecision | null;
  chunks: ChunkTrace[];
}

export const emptyStageTrace = (stage: TraceStageName, provider: DataProviderId | null, capabilityId: string | null): StageTrace => ({
  stage, provider, capabilityId, calls: 0, success: 0, failed: 0, empty: 0, costUsd: 0, durationMs: 0, found: 0, fresh: 0, duplicate: 0, read: 0, skipped: 0, verified: 0, unverified: 0,
});

/** Collects one chunk's facts as the chain runs. */
export class ChunkTraceCollector {
  private stages = new Map<string, StageTrace>();
  readonly fallbacks: FallbackTrace[] = [];
  private spentBeforeUsd = 0;

  constructor(private readonly step: number, spentBeforeUsd: number) { this.spentBeforeUsd = spentBeforeUsd; }

  stage(stage: TraceStageName, provider: DataProviderId | null, capabilityId: string | null): StageTrace {
    const key = `${stage}|${capabilityId ?? ""}`;
    let entry = this.stages.get(key);
    if (!entry) { entry = emptyStageTrace(stage, provider, capabilityId); this.stages.set(key, entry); }
    return entry;
  }

  call(stage: TraceStageName, provider: DataProviderId, capabilityId: string, result: { status: "success" | "failed" | "empty"; costUsd: number; durationMs: number }): void {
    const s = this.stage(stage, provider, capabilityId);
    s.calls += 1;
    s[result.status] += 1;
    s.costUsd = Math.round((s.costUsd + Math.max(0, result.costUsd || 0)) * 1e9) / 1e9;
    s.durationMs += Math.max(0, result.durationMs || 0);
  }

  fallback(entry: FallbackTrace): void { this.fallbacks.push(entry); }

  finish(args: { at: string; delivered: number; costUsd: number; stoppedBy: ChunkTrace["stoppedBy"] }): ChunkTrace {
    return {
      step: this.step,
      at: args.at,
      stages: [...this.stages.values()],
      fallbacks: this.fallbacks,
      delivered: args.delivered,
      spentBeforeUsd: this.spentBeforeUsd,
      costUsd: Math.round(args.costUsd * 1e6) / 1e6,
      stoppedBy: args.stoppedBy,
    };
  }
}

/** Adds a chunk to the trace. A chunk that is written twice (a retry of the same step) replaces the first, so a retry never double counts. */
export function mergeChunkTrace(trace: RoutingTrace, chunk: ChunkTrace): RoutingTrace {
  const chunks = trace.chunks.filter((c) => c.step !== chunk.step);
  chunks.push(chunk);
  chunks.sort((a, b) => a.step - b.step);
  return { ...trace, chunks };
}

export interface TraceSummary {
  /** One line per (stage, capability) over all chunks. */
  stages: StageTrace[];
  fallbacks: FallbackTrace[];
  totalCalls: number;
  totalCostUsd: number;
  delivered: number;
  stoppedBy: ChunkTrace["stoppedBy"];
}

export function summarizeTrace(trace: RoutingTrace): TraceSummary {
  const merged = new Map<string, StageTrace>();
  for (const chunk of trace.chunks) {
    for (const s of chunk.stages) {
      const key = `${s.stage}|${s.capabilityId ?? ""}`;
      const into = merged.get(key) ?? emptyStageTrace(s.stage, s.provider, s.capabilityId);
      for (const k of ["calls", "success", "failed", "empty", "found", "fresh", "duplicate", "read", "skipped", "verified", "unverified", "durationMs"] as const) into[k] += s[k];
      into.costUsd = Math.round((into.costUsd + s.costUsd) * 1e9) / 1e9;
      merged.set(key, into);
    }
  }
  const stages = [...merged.values()];
  return {
    stages,
    fallbacks: trace.chunks.flatMap((c) => c.fallbacks),
    totalCalls: stages.reduce((a, s) => a + s.calls, 0),
    totalCostUsd: Math.round(stages.reduce((a, s) => a + s.costUsd, 0) * 1e6) / 1e6,
    delivered: trace.chunks.reduce((a, c) => a + c.delivered, 0),
    stoppedBy: [...trace.chunks].reverse().find((c) => c.stoppedBy)?.stoppedBy ?? null,
  };
}

/** Storage paths (private `partials` bucket). The decision is written at the quote, keyed by the quote id; the trace follows the job. */
export const decisionPath = (quoteId: string) => `routing/${quoteId}.json`;
export const tracePath = (jobId: string) => `${jobId}/routing_trace.json`;
