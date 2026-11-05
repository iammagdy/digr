import { createHash } from "node:crypto";
import { fakeMoneyClient, type LedgerRow } from "./agentMoney";
import { ADDON_SLUG, addonId, type AddonPlan, type AddonPricing } from "../../src/lib/agentMission/addonSettlement";
import { priceMissionByCode } from "../../src/lib/agentMission/price";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../../src/lib/missionPricing";

/**
 * A WORLD FOR THE ADD-ON MONEY TESTS: the hardened money fake (rpc) plus a tiny `missions` and `mission_events` table (from), so the compare-and-set claim of an add-on row can be tested. Any OTHER
 * table throws, and `fetch` is stubbed to throw by the tests that use it: nothing here can reach a provider.
 */
export const USER = "11111111-1111-4111-8111-111111111111";
export const SETTINGS = { ...DEFAULT_MISSION_PRICING_SETTINGS, minChargePoints: 100 };

export interface MissionRow { id: string; user_id: string; status: string; plan: any; job_id?: string | null; quote_id?: string | null; reserved_points?: number | null; unit_price_points?: number | null; lease_until?: string | null; error?: string | null; approved_by?: string | null; worker_id?: string | null; [k: string]: unknown }

export function fakeAddonWorld(options: { balance?: number; cap?: number; /** Share the rows with an agent store (the worker tests): its `missions` map. */ missions?: Map<string, any> } = {}) {
  const money = fakeMoneyClient(options);
  const missions: Map<string, MissionRow> = options.missions ?? new Map<string, MissionRow>();
  const events: Array<Record<string, unknown>> = [];
  const tableCalls: string[] = [];
  const table = (name: string) => {
    tableCalls.push(name);
    if (name === "mission_events") return { insert: async (row: Record<string, unknown>) => { events.push(row); return { error: null }; } };
    // a read-only look at a job (the worker reads its status to tell a released hold from a settled one); nothing else of the money tables is reachable
    if (name === "jobs") return { select: () => ({ eq: (_k: string, id: string) => ({ maybeSingle: async () => { const j = money.jobs.get(id); return { data: j ? { status: j.status, charged_credits: j.charged_credits, reserved_credits: j.reserved_credits } : null, error: null }; } }) }) };
    // the ledger rows of one job, read only (the approval route proves «nothing was held» from it before it clears an approval mark)
    if (name === "credit_ledger") return { select: () => ({ eq: (_k: string, id: string) => Promise.resolve({ data: money.ledger.filter((l) => l.job_id === id).map((l) => ({ id: l.id, delta: l.delta, type: l.type })), error: null }) }) };
    if (name !== "missions") throw new Error(`a table was touched by hand: ${name}`);
    const query = (rows: () => MissionRow[]) => {
      const filters: Array<[string, unknown, boolean]> = [];
      let patch: Record<string, unknown> | null = null;
      // a JSON path (`plan->addon->>of`) reads into the row; `.is(col, null)` also matches a column the row does not have
      const at = (r: MissionRow, k: string): unknown => (k.includes("->") ? k.split(/->>?/).reduce((v: any, key) => (v === null || v === undefined ? v : v[key]), r) : r[k]);
      const run = () => rows().filter((r) => filters.every(([k, v, nullable]) => (nullable ? (at(r, k) ?? null) === v : at(r, k) === v)));
      const api: any = {
        select: (_cols?: string) => api,
        update: (p: Record<string, unknown>) => { patch = p; return api; },
        eq: (k: string, v: unknown) => { filters.push([k, v, false]); return api; },
        is: (k: string, v: unknown) => { filters.push([k, v, true]); return api; },
        maybeSingle: async () => ({ data: run()[0] ? JSON.parse(JSON.stringify(run()[0])) : null, error: null }),
        then: (resolve: (v: any) => void) => {
          // an update(...).eq(...).eq(...).select("id") resolves to the rows it changed
          const hit = run();
          if (patch) for (const r of hit) Object.assign(r, patch);
          // an update(...).select("id") answers the rows it changed; a plain select answers the rows it read
          resolve({ data: patch ? hit.map((r) => ({ id: r.id })) : hit.map((r) => JSON.parse(JSON.stringify(r))), error: null });
        },
      };
      return api;
    };
    return query(() => [...missions.values()]);
  };
  const client = { rpc: money.client.rpc, from: table };
  return { ...money, client, missions, events, tableCalls };
}

/** An edit's pricing inputs, priced by the very function normal missions use (no provider call). */
export function editPricing(requested: number, costPerRowUsd: number): AddonPricing {
  const price = priceMissionByCode([{ rows: requested, costPerRowUsd, deliver: true, codeOnly: true }], { settings: SETTINGS });
  return { requested, costPerRowUsd, settings: SETTINGS, estimatePoints: price.maxChargePoints, holdPoints: price.reservePoints };
}
/** A review's pricing: exact, held as is. */
export function reviewPricing(cells: number): AddonPricing {
  const p = Math.max(100, Math.ceil(cells / 100));
  return { requested: 1, cells, settings: SETTINGS, estimatePoints: p, holdPoints: p };
}

export function addonRowOf(input: { of?: string; baseVersion?: number; attempt?: number; kind?: "review" | "review_fix" | "edit"; pricing?: AddonPricing; status?: string; userId?: string }): MissionRow {
  const of = input.of ?? "msn_5851abc92a1e6645a9cd";
  const baseVersion = input.baseVersion ?? 1;
  const attempt = input.attempt ?? 1;
  const kind = input.kind ?? "edit";
  const pricing = input.pricing ?? (kind === "review" ? reviewPricing(2_500) : editPricing(40, 0.0005));
  const plan: { addon: AddonPlan } = { addon: { v: 1, kind, of, baseVersion, newVersion: kind === "review" ? null : baseVersion + 1, attempt, request: { note: "test" }, pricing } };
  return { id: addonId(of, baseVersion, attempt), user_id: input.userId ?? USER, status: input.status ?? "plan_ready", plan, request_text: "ضيف عمودًا", job_id: null, quote_id: null };
}

export const slugOf = (kind: keyof typeof ADDON_SLUG) => ADDON_SLUG[kind];
export const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The invariant every add-on scenario ends with (docs/MONEY-PR-7A.md section 5): res = -R, rel = +R (one each), at most one chg = -C with 0 < C <= R, the net is -C. */
export function checkAddonLedger(money: { ledger: LedgerRow[] }, jobId: string, expect: { reserved: number; charged: number | "none" }): string[] {
  const problems: string[] = [];
  const of = (p: string) => money.ledger.filter((r) => r.id.startsWith(p) && r.id === `${p}${jobId}`);
  const [res, rel, chg] = [of("res_"), of("rel_"), of("chg_")];
  if (res.length !== 1 || res[0].delta !== -expect.reserved) problems.push(`res: ${JSON.stringify(res)}`);
  if (rel.length !== 1 || rel[0].delta !== expect.reserved) problems.push(`rel: ${JSON.stringify(rel)}`);
  const own = money.ledger.filter((r) => r.job_id === jobId || r.id.endsWith(jobId));
  if (new Set(own.map((r) => r.id)).size !== own.length) problems.push("duplicate ledger id");
  if (expect.charged === "none") { if (chg.length !== 0) problems.push(`chg should be absent: ${JSON.stringify(chg)}`); }
  else {
    if (chg.length !== 1 || chg[0].delta !== -expect.charged) problems.push(`chg: ${JSON.stringify(chg)}`);
    if (!(expect.charged > 0 && expect.charged <= expect.reserved)) problems.push("charge outside 0 < C <= R");
  }
  const net = own.reduce((n, r) => n + r.delta, 0);
  if (net !== (expect.charged === "none" ? 0 : -expect.charged)) problems.push(`net ${net}`);
  return problems;
}
