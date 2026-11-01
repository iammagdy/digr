import { createMemoryStore } from "../../agent/src/memoryStore";
import { ItemStore } from "../../agent/src/items/itemStore";
import { runEngine, type EngineOutcome } from "../../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../../agent/src/gateway";
import type { EngineSpec, PricedPlan } from "../../src/lib/agentMission/plan";

/**
 * A DIRECT ENGINE HARNESS: the real engine and item store over a hand-made one-stage plan, with a fake gateway that serves scripted pages (and saves each page the way the real gateway does). No planning, no model, no provider.
 */
export const NOW = Date.parse("2026-11-01T12:00:00Z");
export const day = (n: number): string => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);
export const iso = (n: number): string => `${day(n)}T10:00:00Z`;
export type Out = { rows: Array<Record<string, unknown>>; next?: string | null; hasMore?: boolean | null } | "fail" | "refused";
export interface DirectCall { endpoint: string; params: Record<string, unknown> }

export function directEngine(handlers: Record<string, (params: Record<string, unknown>, n: number) => Out>, options: { redesign: boolean; planned: number; primary?: string; alternatives?: EngineSpec["alternatives"]; storeFiles?: ReturnType<typeof createMemoryStore>; maxPagesPerStage?: number }) {
  const store = options.storeFiles ?? createMemoryStore();
  const calls: DirectCall[] = [];
  const counts: Record<string, number> = {};
  let seq = 0;
  const primary = options.primary ?? "a.search.posts";
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      calls.push({ endpoint, params });
      counts[endpoint] = (counts[endpoint] ?? 0) + 1;
      const out = handlers[endpoint](params, counts[endpoint]);
      if (out === "refused") return { ok: false as const, refused: "over_budget", message: "over budget" };
      if (out === "fail") return { ok: false as const, failed: true, http_status: 500, message: "boom" };
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_fb", RAW_PATH(callId), JSON.stringify(out.rows), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: out.rows.length, has_more: out.hasMore !== undefined ? out.hasMore : out.next ? true : false, next_cursor: out.next ?? null, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const spec: EngineSpec = { endpoint_id: primary, params: { query: "x" }, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "page", parent_binding: null, ...(options.alternatives ? { alternatives: options.alternatives } : {}) };
  const stage = { key: "posts", title_ar: "المنشورات", endpoint_id: primary, expected_rows: options.planned, planned_rows: options.planned, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "date", title_ar: "التاريخ" }], sample_rows: [], measured_by: [], filters: [{ kind: "period", field: "date", days: 365 }], engine: spec };
  const plan = { summary_ar: "x", stages: [stage], price: { deliveredRows: options.planned } } as unknown as PricedPlan;
  const run = async (opts: { shouldStop?: () => string | null } = {}): Promise<{ outcome: EngineOutcome; items: ItemStore }> => {
    const items = await ItemStore.open(store, "msn_fb");
    const outcome = await runEngine({ items, store, plan, missionId: "msn_fb", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, now: () => NOW, deadlineMs: NOW + 3_600_000, sleep: async () => undefined, ...(options.maxPagesPerStage ? { maxPagesPerStage: options.maxPagesPerStage } : {}), ...(opts.shouldStop ? { shouldStop: opts.shouldStop } : {}), ...(options.redesign ? { redesignStages: new Set(["posts"]) } : {}) });
    return { outcome, items };
  };
  return { run, calls, store, plan };
}
export const pageOf = (prefix: string, from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${from + i}`, text: `منشور ${prefix}${from + i}`, date: iso(from + i) }));
