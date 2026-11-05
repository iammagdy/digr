import { addonId } from "../../src/lib/agentMission/addonSettlement";
import { editCard, reviewCard } from "../../src/lib/agentMission/stage4/addonQuote";
import { firstVersionFromCells, versionPathOf, type FileVersion } from "../../src/lib/agentMission/stage4/versions";

/**
 * A FAKE WORLD FOR THE REVIEW-PRICE PREVIEW (MONEY PR 7c, PHASE 2B-2 TASK 2): the `missions` table (the delivered mission and its add-on rows) and a bucket of named objects, both answering only what the preview reads. Every write, every rpc, every upload,
 * every signed link is COUNTED: a preview must make none. A mission query is answered by its `.eq` filters, the JSON path `plan->addon->>of` included. No network, no storage, no database.
 */
export const MISSION = "msn_5851abc92a1e6645a9cd";
export const OTHER_MISSION = "msn_aaaaaaaaaaaaaaaaaaaa";
export const ME = "u-1";

export interface AddonSeed { status: string; kind?: "review" | "edit" | "review_fix"; base?: number; of?: string; user?: string; attempt?: number; /** A review's readable cell count (default 1,000). The approval guard compares it with the published file's. */ cells?: number }
/** A well-formed add-on row (its plan passes `readAddonPlan`) of the given status. */
export function addonRowOf(seed: AddonSeed): { id: string; user_id: string; status: string; plan: unknown } {
  const kind = seed.kind ?? "review";
  const base = seed.base ?? 1;
  const of = seed.of ?? MISSION;
  const attempt = seed.attempt ?? 1;
  const card = kind === "review" ? reviewCard(seed.cells ?? 1000) : editCard({ kind, units: 10, tools: [{ catalogPerRowUsd: 0.001 }] });
  if (!card.ok) throw new Error("the fixture card was refused");
  return {
    id: addonId(of, base, attempt),
    user_id: seed.user ?? ME,
    status: seed.status,
    plan: { addon: { v: 1, kind, of, baseVersion: base, newVersion: kind === "review" ? null : base + 1, attempt, request: kind === "review" ? { kind: "review" } : { kind: "edit" }, pricing: card.pricing } },
  };
}

export interface Opts { listError?: boolean; downloadError?: boolean; addonQueryError?: boolean; addons?: Array<ReturnType<typeof addonRowOf>>; missionError?: boolean }

export function previewClient(objects: Record<string, string>, opts: Opts = {}) {
  const writes: string[] = [];
  const calls: string[] = [];
  const base = [
    { id: MISSION, user_id: ME, status: "completed", plan: { stages: [] }, delivered_units: 60 },
    { id: OTHER_MISSION, user_id: "u-2", status: "completed", plan: { stages: [] }, delivered_units: 1 },
    ...(opts.addons ?? []),
  ];
  const valueAt = (row: any, col: string): unknown => col.split(/->>?/).reduce((v: any, k) => (v === null || v === undefined ? v : v[k]), row);
  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    const rows = () => (table === "missions" ? base : []).filter((r) => filters.every(([c, v]) => valueAt(r, c) === v));
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
      limit: () => b,
      maybeSingle: async () => {
        if (opts.missionError) return { data: null, error: { message: "database is down" } };
        return { data: rows()[0] ?? null, error: null };
      },
      then: (resolve: any, reject: any) => Promise.resolve(opts.addonQueryError ? { data: null, error: { message: "database is down" } } : { data: rows(), error: null }).then(resolve, reject),
    };
    for (const w of ["insert", "update", "upsert", "delete"]) b[w] = (..._a: unknown[]) => { writes.push(`${w} ${table}`); return b; };
    return b;
  }
  const bucket = {
    list: async (dir: string) => {
      calls.push(`list ${dir}`);
      if (opts.listError) return { data: null, error: { message: "storage is down" } };
      return { data: [...new Set(Object.keys(objects).filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split("/")[0]))].map((name) => ({ name, id: Object.keys(objects).includes(`${dir}/${name}`) ? `id_${name}` : null })), error: null };
    },
    download: async (p: string) => {
      calls.push(`download ${p}`);
      if (opts.downloadError) return { data: null, error: { message: "rate limited", statusCode: "429" } };
      return objects[p] === undefined ? { data: null, error: { message: "Object not found", statusCode: "404" } } : { data: new Blob([objects[p]]), error: null };
    },
    upload: async (p: string) => { writes.push(`upload ${p}`); return { data: {}, error: null }; },
    remove: async (p: string) => { writes.push(`remove ${p}`); return { data: {}, error: null }; },
    createSignedUrl: async (p: string) => { writes.push(`signed ${p}`); return { data: { signedUrl: `https://storage.example/${p}` }, error: null }; },
  };
  return { from: (t: string) => builder(t), storage: { from: () => bucket }, rpc: async (name: string) => { writes.push(`rpc ${name}`); return { data: null, error: null }; }, auth: { admin: { getUserById: async () => ({ data: { user: null } }) } }, writes, calls };
}

/** A delivered version of `rows` x `cols` readable cells (plus the id column): every cell is a short text. */
export function sizedVersion(rows: number, cols: number, missionId = MISSION): FileVersion {
  const head = ["المعرّف", ...Array.from({ length: cols }, (_, i) => `عمود ${i + 1}`)];
  const body = Array.from({ length: rows }, (_, r) => [`row_${r + 1}`, ...Array.from({ length: cols }, () => "")]);
  return firstVersionFromCells({ missionId, cells: { "الورقة": [head, ...body] }, createdAt: "2026-11-02T12:00:00.000Z" });
}
export const objectsOf = (...versions: FileVersion[]): Record<string, string> => Object.fromEntries(versions.map((v) => [`${v.missionId}/${versionPathOf(v.version)}`, JSON.stringify(v)]));
