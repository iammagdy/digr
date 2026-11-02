import { readFileSync, existsSync } from "node:fs";
import { buildShapeDigest } from "../../src/lib/modelPlanner/digest";
import type { TregCatalog } from "../../src/lib/treg/catalog";
import { RAW_PATH } from "../../agent/src/gateway";

/**
 * F7, THE REPLAY GATEWAY: serves the STORED real pages of a mission (tests/fixtures/live/missions, anonymised) to the compiler and the engine, as the real gateway would answer
 * (the same page reader, `buildShapeDigest`, gives the rows, `has_more` and `next_cursor`). A page is served ONLY for the same endpoint and the same inputs as the stored call
 * (tests/fixtures/live/call-index.json); a link input is compared by the numeric id it carries (the stored links are anonymised). Any other call is NOT served: it is recorded
 * in `unserved` and answered as a failed call, so a replay never invents what a source would have said. No network, no paid call.
 */
type IndexRow = [string, string, string, string, number, Record<string, unknown>];
const INDEX = JSON.parse(readFileSync(new URL("../fixtures/live/call-index.json", import.meta.url), "utf8")) as { missions: Record<string, IndexRow[]> };
const LINK_KEYS = new Set(["url", "post", "link", "video_url", "postUrl"]);

export function inputKey(endpointId: string, params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .filter(([k, v]) => !k.startsWith("_") && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, LINK_KEYS.has(k) ? (String(v).match(/\d{15,}/g) ?? [""]).pop()! : String(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `${endpointId} ${JSON.stringify(entries)}`;
}

export interface ReplayStats {
  served: Array<{ endpointId: string; storedCall: string; servedAs: string; params: Record<string, unknown> }>;
  unserved: Array<{ endpointId: string; params: Record<string, unknown> }>;
}

export interface ReplayStore { putFile: (missionId: string, path: string, content: string, contentType: string) => Promise<unknown> }

/** A gateway over the stored pages of `fixtureMission`; pages are written into `store` under `targetMission` (the engine reads them back from there). */
export function replayGateway(fixtureMission: string, catalog: TregCatalog, store: ReplayStore, targetMission: string, options: { firstSeq?: number } = {}) {
  const calls = INDEX.missions[fixtureMission] ?? [];
  const byKey = new Map<string, IndexRow>();
  for (const c of calls) if ((c[3] === "ok" || c[3] === "empty") && !byKey.has(inputKey(c[2], c[5]))) byKey.set(inputKey(c[2], c[5]), c);
  const stats: ReplayStats = { served: [], unserved: [] };
  let seq = options.firstSeq ?? 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) {
      const endpointId = String(input.endpoint_id ?? "");
      const params = (input.params ?? {}) as Record<string, unknown>;
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      const stored = byKey.get(inputKey(endpointId, params));
      const file = stored ? new URL(`../fixtures/live/missions/${fixtureMission}/raw/${stored[0]}.json`, import.meta.url) : null;
      const endpoint = catalog.byId.get(endpointId);
      if (!stored || !file || !existsSync(file) || !endpoint) {
        stats.unserved.push({ endpointId, params: { ...params } });
        return { ok: false as const, call_id: callId, failed: true as const, http_status: 0, message: "no stored page for these inputs (replay)" };
      }
      const body = readFileSync(file, "utf8");
      await store.putFile(targetMission, RAW_PATH(callId), body, "application/json");
      const { reading } = buildShapeDigest(JSON.parse(body), endpoint);
      stats.served.push({ endpointId, storedCall: stored[0], servedAs: callId, params: { ...params } });
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: reading.hasMore ?? null, next_cursor: reading.nextCursor ?? null, shape: null, first_rows: [], warnings: [], saved: callId };
    },
  };
  return { gateway, stats };
}

/** The stored calls of a mission (anonymised call log). */
export const storedCalls = (mission: string): IndexRow[] => INDEX.missions[mission] ?? [];
