import { createHash } from "node:crypto";
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

/** An Instagram post's short code (the `/p/<code>/` of its link) is the media id written in base 64: the id is what the committed call index keeps (a link in the index is only ever a number). */
const IG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function instagramMediaIdOf(shortCode: string): string {
  let n = BigInt(0);
  for (const ch of shortCode) { const i = IG_ALPHABET.indexOf(ch); if (i < 0) return ""; n = n * BigInt(64) + BigInt(i); }
  return n.toString();
}
const linkId = (v: unknown): string => {
  const s = String(v);
  const long = s.match(/\d{15,}/g);
  if (long) return long.pop()!;
  const ig = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/.exec(s);
  if (ig) return instagramMediaIdOf(ig[1]);
  // a Facebook post link with no numeric id (a pfbid link): the index keeps a numeric surrogate of its first 24 characters (the call log cuts a link at 80 characters; README of the fixtures)
  const pf = /pfbid[0-9A-Za-z]+/.exec(s);
  return pf ? (BigInt("0x" + createHash("sha256").update(pf[0].slice(0, 24)).digest("hex").slice(0, 16)) % BigInt(9 * 10 ** 17) + BigInt(10 ** 17)).toString() : "";
};
/** The personal inputs of a call (an account handle): the index keeps a placeholder, so the replay compares nothing of their value (a mission reads one account). */
const PERSONAL_INPUTS = new Set(["handle", "username"]);

/** `only`: the replay of an endpoint compares only these inputs (the compiler's own query words differ from the words the model used live; the stored page is served by the other inputs). */
export function inputKey(endpointId: string, params: Record<string, unknown>, only?: ReadonlyArray<string>): string {
  const entries = Object.entries(params)
    .filter(([k, v]) => !k.startsWith("_") && v !== undefined && v !== null && v !== "" && (only === undefined || only.includes(k)))
    .map(([k, v]) => [k, LINK_KEYS.has(k) ? linkId(v) : PERSONAL_INPUTS.has(k) ? "*" : String(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `${endpointId} ${JSON.stringify(entries)}`;
}

export interface ReplayStats {
  served: Array<{ endpointId: string; storedCall: string; servedAs: string; params: Record<string, unknown> }>;
  unserved: Array<{ endpointId: string; params: Record<string, unknown> }>;
}

export interface ReplayStore { putFile: (missionId: string, path: string, content: string, contentType: string) => Promise<unknown> }

/** A gateway over the stored pages of `fixtureMission`; pages are written into `store` under `targetMission` (the engine reads them back from there). */
export interface ReplayOptions {
  firstSeq?: number;
  /** Per endpoint, the only inputs compared (see `inputKey`): written in the test that needs it, so the loosening is visible there. */
  only?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Serve only the stored calls of this phase of the live mission («planning» or «execution»): the same inputs read in the two phases gave DIFFERENT pages (a comments page of the planning read and of the execution read), and the engine must get the execution one. Absent: every phase (as before). */
  phase?: "planning" | "execution";
  /** Per endpoint, the inputs the call log keeps only the first 80 characters of (a paging or reply token: `mission_calls.params` cuts them): both sides are compared on their first 80 characters. Written in the test that needs it. */
  cut80?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** A stored page of ANOTHER mission of the same platform that stands in for a page the live run never read (the compiler's second pool page): written in the test, never implicit. */
  borrow?: ReadonlyArray<{ endpointId: string; fromMission: string; call: string; when: (params: Record<string, unknown>) => boolean }>;
}
export function replayGateway(fixtureMission: string, catalog: TregCatalog, store: ReplayStore, targetMission: string, options: ReplayOptions = {}) {
  const calls = (INDEX.missions[fixtureMission] ?? []).filter((c) => options.phase === undefined || c[1] === options.phase);
  const cut = (endpointId: string, params: Record<string, unknown>): Record<string, unknown> => {
    const names = options.cut80?.[endpointId];
    if (!names) return params;
    return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, names.includes(k) && typeof v === "string" ? v.slice(0, 80) : v]));
  };
  const keyOf = (endpointId: string, params: Record<string, unknown>) => inputKey(endpointId, cut(endpointId, params), options.only?.[endpointId]);
  const byKey = new Map<string, IndexRow>();
  for (const c of calls) if ((c[3] === "ok" || c[3] === "empty") && !byKey.has(keyOf(c[2], c[5]))) byKey.set(keyOf(c[2], c[5]), c);
  const stats: ReplayStats = { served: [], unserved: [] };
  let seq = options.firstSeq ?? 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) {
      const endpointId = String(input.endpoint_id ?? "");
      const params = (input.params ?? {}) as Record<string, unknown>;
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      const lent = options.borrow?.find((b) => b.endpointId === endpointId && b.when(params));
      const stored = lent ? ((INDEX.missions[lent.fromMission] ?? []).find((c) => c[0] === lent.call && c[2] === endpointId) ?? null) : byKey.get(keyOf(endpointId, params));
      const file = stored ? new URL(`../fixtures/live/missions/${lent ? lent.fromMission : fixtureMission}/raw/${stored[0]}.json`, import.meta.url) : null;
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
