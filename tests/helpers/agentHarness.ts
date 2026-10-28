import { vi } from "vitest";
import { createJobCallBudget } from "../../src/lib/server/callBudget";
import type { CallRecorder } from "../../src/lib/server/multiProvider/adapterTypes";
import type { TregCallOptions, TregCallResult } from "../../src/functions/shared/tregClient";
import { loadTregCatalog, type TregCatalog } from "../../src/lib/treg/catalog";
import type { AccountAccess } from "../../src/lib/treg/dataPolicy";
import { createMemoryStore, newMission, type MemoryStore } from "../../agent/src/memoryStore";
import { createGateway, type Gateway } from "../../agent/src/gateway";
import type { MissionRecord } from "../../agent/src/types";
import { newRunState, type ToolContext } from "../../agent/src/tools";

/** Endpoints of the real catalog snapshot the tests use (no call is ever made to them: the TREG answers below are fake). */
export const POSTS_ENDPOINT = "x.x.search-posts-all"; // per record, required: query
export const COMMENTS_ENDPOINT = "anyapi.instagram.post.comments"; // per call, required: url
export const SENSITIVE_ENDPOINT = "branddev.brand.retrieve-by-email";
export const WRITE_ENDPOINT = "openmart.deny-rules.create";

export const NOT_ADMIN: AccountAccess = { isAdmin: false, verifiedBusiness: false };
export const USER_ID = "00000000-0000-0000-0000-0000000000aa";

export function tregResult(data: unknown, costUsd: number, extra: Partial<TregCallResult> = {}): TregCallResult {
  return { ok: true, httpStatus: 200, tregCallId: `t_${Math.random().toString(36).slice(2, 8)}`, costMicro: Math.round(costUsd * 1_000_000), latencyMs: 12, data, isRouteMaxCost: false, isPlatformBalanceLow: false, ...extra };
}

/** posts: n rows of {id, text, url}. */
export const postsPage = (n: number, offset = 0) => ({ data: Array.from({ length: n }, (_, i) => ({ id: `${9000 + offset + i}`, text: `post ${offset + i}`, url: `https://x.example/p/${9000 + offset + i}` })), next_cursor: "cur1" });
export const commentsPage = (postId: string, n: number) => ({ output: { data: { comments: Array.from({ length: n }, (_, i) => ({ id: `${postId}-c${i}`, text: `comment ${i}` })) } } });

export interface ProviderCostRow { costId: number; reservedUsd: number; committedUsd: number | null; units: number | null; status: string | null; jobId: string | null; capabilityId: string; provider?: string }

/** A fake recorder over an in-memory provider_costs list, with a daily cap like reserve_provider_spend_atomic. */
export function fakeRecorder(options: { dailyCapUsd?: number; failReserve?: boolean } = {}) {
  const rows: ProviderCostRow[] = [];
  const cap = options.dailyCapUsd ?? 0.8;
  const recorder: CallRecorder = {
    async reserve({ estimatedUsd, jobId, capabilityId, provider }) {
      if (options.failReserve) return { allowed: false, costId: null, reason: "error" };
      const spent = rows.reduce((n, r) => n + (r.committedUsd ?? r.reservedUsd), 0);
      if (spent + estimatedUsd > cap) return { allowed: false, costId: null, reason: "cap" };
      const costId = rows.length + 1;
      rows.push({ costId, reservedUsd: estimatedUsd, committedUsd: null, units: null, status: null, jobId, capabilityId, provider });
      return { allowed: true, costId };
    },
    // the web gateway commits through the recorder (the TREG gateway commits through `commit` below): either way the reserved row becomes the real cost
    async commit(costId, record) {
      const row = rows.find((r) => r.costId === costId);
      if (row) { row.committedUsd = record.costUsd; row.units = record.units; row.status = record.status; row.provider = record.provider; row.capabilityId = record.capabilityId; }
    },
  };
  const commit = vi.fn(async (_client: unknown, args: { costId: number | null; costUsd: number; units: number; capabilityId: string; status: string; durationMs: number; jobId: string | null }) => {
    const row = rows.find((r) => r.costId === args.costId);
    if (row) { row.committedUsd = args.costUsd; row.units = args.units; row.status = args.status; }
  });
  return { recorder, rows, commit: commit as unknown as typeof import("../../src/lib/server/tregCallRecord").commitTregSpend };
}

export interface Harness {
  store: MemoryStore;
  mission: MissionRecord;
  gateway: Gateway;
  catalog: TregCatalog;
  call: ReturnType<typeof vi.fn>;
  providerCosts: ProviderCostRow[];
  budget: ReturnType<typeof createJobCallBudget>;
  ctx: ToolContext;
}

/** A gateway + tool context over memory, a fake TREG and a fake recorder. `responses` are handed out in order to the calls the agent makes. */
export function makeHarness(options: { phase?: "planning" | "execution"; budgetUsd?: number; access?: AccountAccess; responses?: Array<TregCallResult | ((o: TregCallOptions) => TregCallResult)>; dailyCapUsd?: number; failReserve?: boolean; mission?: Partial<MissionRecord>; catalog?: TregCatalog; store?: MemoryStore } = {}): Harness {
  const store = options.store ?? createMemoryStore();
  const mission = newMission({ id: "msn_test0001", user_id: USER_ID, request_text: "أريد منشورات وتعليقاتها", status: "planning", job_id: options.phase === "execution" ? "job_quote_test" : null, ...options.mission });
  store.missions.set(mission.id, mission);
  const catalog = options.catalog ?? loadTregCatalog();
  const { recorder, rows, commit } = fakeRecorder({ dailyCapUsd: options.dailyCapUsd, failReserve: options.failReserve });
  const queue = [...(options.responses ?? [])];
  const call = vi.fn(async (o: TregCallOptions) => {
    const next = queue.shift();
    if (!next) throw new Error("the test gave no fake answer for this call");
    return typeof next === "function" ? next(o) : next;
  });
  const budget = createJobCallBudget({ ceilingUsd: options.budgetUsd ?? 0.05, spentUsd: 0 });
  const access = options.access ?? NOT_ADMIN;
  const gateway = createGateway({ store, client: { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) }, missionId: mission.id, userId: USER_ID, jobId: mission.job_id, phase: options.phase ?? "planning", access, catalog, budget, recorder, commit, call, defaultPurpose: mission.request_text, counter: { seq: 0 } });
  const ctx: ToolContext = { phase: options.phase ?? "planning", mission, plan: mission.plan, store, gateway, catalog, access, state: newRunState() };
  return { store, mission, gateway, catalog, call, providerCosts: rows, budget, ctx };
}
