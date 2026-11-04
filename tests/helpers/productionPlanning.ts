import { readFileSync, existsSync } from "node:fs";
import { vi } from "vitest";
import { createFakeDriver } from "../../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../../agent/src/memoryStore";
import { createSupabaseStore } from "../../agent/src/supabaseStore";
import { runPlanning, type RunnerDeps } from "../../agent/src/runMission";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { setModelPlanningForTests } from "../../src/lib/agentMission/testSeam";
import type { PricedPlan } from "../../src/lib/agentMission/plan";
import { NOT_ADMIN, fakeRecorder, tregResult } from "./agentHarness";
import { fakeMoneyClient } from "./agentMoney";
import { fakeRestClient } from "./fakeRestClient";
import { inputKey, storedCalls, type ReplayOptions } from "./replayGateway";

/**
 * ROUND 19: THE PRODUCTION PLANNING RUN OVER STORED LIVE PAGES (item 2 of the brief). `runPlanning` itself (the worker's own entry: the social gate, understand, Ask, the count questions, the pool and exposure reads through the REAL gateway and its caps, compile, price,
 * the plan written through the REAL store writer `createSupabaseStore`) with the TEST SEAM OFF, a provider that answers only from the stored pages (the same endpoint and the same inputs as a stored live call; anything else is a failed call, never invented) and a REST stand-in that
 * refuses the bodies the real one refuses. The saved plan is what the engine and the delivery contract then run on (`replayMission`'s `savedPlan`).
 */
export interface ProductionPlanningInput {
  fixture: string;
  request: string;
  answer?: string | null;
  createdAt: string;
  platform: "tiktok" | "x" | "facebook" | "instagram" | "youtube";
  /** A test account (its platform flag is `test`), else the platform's flag is `on`. */
  testAccount?: boolean;
  replay?: ReplayOptions;
  /** Changes a stored PLANNING page after it is read (the anonymiser replaced the words a live ranking read): written in the test that needs it. */
  transformPlanningPage?: (endpointId: string, page: unknown) => unknown;
  /** The planning moment (the compiler's «now»). */
  planningAt?: string;
}

const catalog = loadTregCatalog();
const FLAGS_OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" };

export interface ProductionPlanning {
  status: string;
  error: string | null;
  summary: string | null;
  question: string | null;
  plan: PricedPlan | null;
  savedBody: string | null;
  rejected: Array<{ table: string; bytes: number }>;
  providerCalls: Array<{ endpointId: string; params: Record<string, unknown>; served: boolean }>;
  mission: { reserved_points?: unknown; unit_price_points?: unknown };
}

export async function runProductionPlanning(input: ProductionPlanningInput): Promise<ProductionPlanning> {
  setModelPlanningForTests(false);
  try {
    const memory = createMemoryStore();
    const rest = fakeRestClient();
    const sb = createSupabaseStore(rest.client);
    const store = { ...memory, updateMission: async (id: string, patch: Record<string, unknown>) => { await sb.updateMission(id, patch as never); return memory.updateMission(id, patch as never); }, addEvent: async (id: string, e: never) => { await sb.addEvent(id, e); return memory.addEvent(id, e); } } as typeof memory;
    const id = `msn_prod_${input.fixture.slice(4, 12)}`;
    memory.missions.set(id, newMission({ id, user_id: "user_prod", request_text: input.request, ...(input.answer ? { answer_text: input.answer } : {}), status: "planning", created_at: input.createdAt }));
    rest.rowsOf("missions").push({ id });
    if (input.testAccount) memory.userEmails.set("user_prod", "iam.magdy+1@outlook.com");
    Object.assign(memory.settings, { redesign_flags: { ...FLAGS_OFF, [input.platform]: input.testAccount ? "test" : "on" } });
    const cut = (endpointId: string, params: Record<string, unknown>): Record<string, unknown> => {
      const names = input.replay?.cut80?.[endpointId];
      return names ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, names.includes(k) && typeof v === "string" ? v.slice(0, 80) : v])) : params;
    };
    const keyOf = (endpointId: string, params: Record<string, unknown>) => inputKey(endpointId, cut(endpointId, params), input.replay?.only?.[endpointId]);
    const byKey = new Map(storedCalls(input.fixture).filter((c) => (c[3] === "ok" || c[3] === "empty") && (c[1] ?? "planning") === "planning").map((c) => [keyOf(c[2], c[5]), c] as const));
    const providerCalls: ProductionPlanning["providerCalls"] = [];
    const call = vi.fn(async (o: { endpointId: string; params: Record<string, unknown> }) => {
      // a page of ANOTHER stored call of the same tool that stands in for a page the live run never read, written in the test that needs it (never implicit)
      const lent = input.replay?.borrow?.find((b) => b.endpointId === o.endpointId && b.when(o.params));
      const c = lent ? (storedCalls(lent.fromMission).find((x) => x[0] === lent.call && x[2] === o.endpointId) ?? null) : byKey.get(keyOf(o.endpointId, o.params));
      const file = c ? new URL(`../fixtures/live/missions/${lent ? lent.fromMission : input.fixture}/raw/${c[0]}.json`, import.meta.url) : null;
      providerCalls.push({ endpointId: o.endpointId, params: o.params, served: Boolean(c && file && existsSync(file)) });
      if (!c || !file || !existsSync(file)) return tregResult(null, 0, { ok: false, httpStatus: 404, error: "not_found" });
      const page = JSON.parse(readFileSync(file, "utf8"));
      return tregResult(input.transformPlanningPage ? input.transformPlanningPage(o.endpointId, page) : page, Number(catalog.byId.get(o.endpointId)?.cost?.usd ?? 0.001));
    });
    const rec = fakeRecorder();
    const driver = createFakeDriver([{ tool: "ask_question", args: { question_ar: "؟", options_ar: ["أ", "ب"] } }]);
    const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
    if (input.planningAt) vi.setSystemTime(new Date(input.planningAt));
    await runPlanning(deps, memory.missions.get(id)!);
    const m = memory.missions.get(id)!;
    const row = rest.rowsOf("missions").find((r) => r.id === id)!;
    return {
      status: String(m.status), error: (m.error as string | null) ?? null, summary: (m.summary_ar as string | null) ?? null, question: (m.question_ar as string | null) ?? null,
      plan: row.plan ? (JSON.parse(JSON.stringify(row.plan)) as PricedPlan) : null, savedBody: row.plan ? JSON.stringify(row.plan) : null,
      rejected: rest.rejected, providerCalls, mission: { reserved_points: row.reserved_points, unit_price_points: row.unit_price_points },
    };
  } finally {
    setModelPlanningForTests(true);
  }
}
