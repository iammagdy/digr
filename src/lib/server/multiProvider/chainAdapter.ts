import { multiProviderEnabled } from "../../multiProvider/flag";
import type { DataProviderId } from "../../multiProvider/types";
import { resolveProviderKey } from "../providerKeys";
import type { ProviderAdapterFn } from "../tregAdapter";
import type { FetchFn } from "./adapterTypes";
import { createCallRecorder } from "./callRecorder";
import { runChainChunk, type ChainDeps } from "./chainRunner";
import { getProviderTransport, getRobotsTransport } from "./fakeTransport";
import { PREVIEW_WORLD_DAILY_CAP_USD } from "../../multiProvider/previewWorld";
import { readJobProviderSpendUsd, resolveProviderDailyCapUsd } from "./providerCaps";
import { appendChunkTrace } from "./traceStore";
import type { RobotsFetch } from "../../multiProvider/policy";

/**
 * The chain as a provider adapter for the worker: same input and output as every other adapter, so the worker's reserve, row gate,
 * files, settlement and release run unchanged around it. It resolves the provider keys from the encrypted store (never an env file in the
 * repo), records every call through the approved SQL functions, and writes the activity lines through the existing job_events table.
 */

export interface ChainAdapterEnv {
  adminClient: any;
  /** The answer of the guarded fake-provider switch (a preview on a test database): the fake world instead of the network. */
  fakeMode: boolean;
  /** The adapter that serves TREG's company directory (the production adapter, or an injected fake in tests). */
  tregFn: ProviderAdapterFn;
}

interface TestTransport { fetchFn?: FetchFn; robotsFetch?: RobotsFetch; keys?: Partial<Record<DataProviderId, string>> }
let testTransport: TestTransport | null = null;
/** Test-only. Ignored in production: the network of a production deployment is never replaced. */
export function setChainTransportForTesting(value: TestTransport | null): void { testTransport = value; }
const testHooksAllowed = () => process.env.NODE_ENV !== "production";

export function createChainAdapter(env: ChainAdapterEnv): ProviderAdapterFn {
  return async (input) => {
    if (!multiProviderEnabled()) {
      return { ok: false, httpStatus: 503, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "", errorCode: "multi_provider_off", errorMessageAr: "هذه الخدمة غير متاحة حاليًا؛ تم استرداد كامل الرصيد المحجوز دون أي خصم." };
    }
    const hooks = testHooksAllowed() ? testTransport : null;
    const keys: Partial<Record<DataProviderId, string>> = { ...(hooks?.keys ?? {}) };
    if (!hooks?.keys) {
      for (const id of ["treg", "firecrawl", "contextdev"] as const) {
        const resolved = await resolveProviderKey(id).catch(() => null);
        // TREG holds and resolves its own key inside its adapter: a non-empty marker only says «present».
        if (resolved?.key) keys[id] = id === "treg" ? "managed" : resolved.key;
        else if (env.fakeMode) keys[id] = "fake-key-for-preview";
      }
    }
    const deps: ChainDeps = {
      providerKeys: keys,
      fetchFn: hooks?.fetchFn ?? getProviderTransport(env.fakeMode),
      robotsFetch: hooks?.robotsFetch ?? getRobotsTransport(env.fakeMode),
      // In the fake world a provider with no limit set gets the small preview limit (the real limit applies when one is set).
      recorder: createCallRecorder(env.adminClient, env.fakeMode ? { capFor: async (provider) => { const set = await resolveProviderDailyCapUsd(env.adminClient, provider).catch(() => 0); return set > 0 ? set : PREVIEW_WORLD_DAILY_CAP_USD; } } : {}),
      tregFn: env.tregFn,
      spentUsdSoFar: () => readJobProviderSpendUsd(env.adminClient, input.jobId),
      step: input.step,
      trace: async (chunk) => { await appendChunkTrace(env.adminClient, { jobId: input.jobId, quoteId: input.quoteId ?? null, chunk }); },
      emit: async (message, units) => {
        try {
          await env.adminClient.from("job_events").insert({ job_id: input.jobId, user_id: input.userId, message, units, event_type: "progress" });
        } catch (e: any) {
          console.warn("[worker:job_events_insert_warning]", e?.message || "");
        }
      },
    };
    return runChainChunk(input, deps);
  };
}
