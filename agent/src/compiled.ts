import { buildAsk, type Ask } from "../../src/lib/agentMission/foundation/ask";
import { chooseCard, compilePlan, parentInputs, COMPILED_PLATFORMS, type CompileResult } from "../../src/lib/agentMission/foundation/compilePlan";
import { rankPool } from "../../src/lib/agentMission/foundation/pool";
import { mapPage } from "../../src/lib/agentMission/foundation/toolCards";
import type { PricedPlan } from "../../src/lib/agentMission/plan";
import type { MissionPricingSettings } from "../../src/lib/missionPricing";
import type { TregCatalog } from "../../src/lib/treg/catalog";
import { isSocialPlatform, type PlatformFlags, type SocialPlatform } from "../../src/lib/agentMission/redesignFlagTypes";
import { RAW_PATH, type GatewayCallResult } from "./gateway";
import type { AgentStore, MissionRecord } from "./types";

/**
 * THE COMPILED PLANNING (docs/FOUNDATION-PLAN.md PR 2a; F1-F5 by code, no model). Only for a platform of COMPILED_PLATFORMS (TikTok, X), and only when that platform's OWN flag
 * is `on`, or `test` for a test account (an unset platform flag, «inherit», keeps today's path: nothing changes by default). Every page is read THROUGH THE GATEWAY passed in
 * (the planning budget, the daily cap, the two-samples-per-source cap of the protected gateway.ts and the call record all apply); nothing here calls a provider by itself.
 */
export function compiledPlatformActive(platformFlags: PlatformFlags | undefined, platform: SocialPlatform | null | undefined, isTest: boolean): boolean {
  if (!platform || !(COMPILED_PLATFORMS as ReadonlyArray<string>).includes(platform) || !isSocialPlatform(platform)) return false;
  const own = platformFlags?.[platform];
  return own === "on" || (own === "test" && isTest);
}

export interface CompiledPlanningDeps {
  mission: Pick<MissionRecord, "id" | "request_text" | "answer_text" | "created_at">;
  gateway: { tregCall: (input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) => Promise<GatewayCallResult | Record<string, unknown>> };
  store: Pick<AgentStore, "getFile">;
  catalog: Pick<TregCatalog, "byId">;
  pricingSettings?: MissionPricingSettings;
  nowMs: number;
  /** The customer's edit of the card (Stage 2 recompiles with it). */
  edits?: Ask["edits"];
}
export type CompiledPlanning =
  | { kind: "plan"; plan: PricedPlan; ask: Ask; result: Extract<CompileResult, { ok: true }>; reads: { pool: number; exposure: number } }
  | { kind: "cannot"; ask: Ask; reason: string; reads: { pool: number; exposure: number } };

/** The pages a parent may be read for at planning beyond the ones it needs (the exposure check replaces an empty parent by the next one). */
const EXPOSURE_EXTRA = 3;

/** Reads the pool and the exposure pages through the gateway, then compiles. */
export async function planByCompiler(deps: CompiledPlanningDeps): Promise<CompiledPlanning> {
  const at = Date.parse(String(deps.mission.created_at ?? ""));
  const ask = buildAsk(deps.mission.request_text, deps.mission.answer_text, Number.isFinite(at) ? at : deps.nowMs, deps.edits ?? {});
  const reads = { pool: 0, exposure: 0 };
  const card = chooseCard(ask, "parents");
  if (!card) return { kind: "cannot", ask, reason: "no_parent_card", reads };
  const read = async (endpointId: string, params: Record<string, unknown>): Promise<{ callId: string; page: unknown; nextCursor: string | null; hasMore: boolean | null } | { failed: true; refused: boolean }> => {
    const r = (await deps.gateway.tregCall({ endpoint_id: endpointId, params, purpose: deps.mission.request_text })) as Record<string, unknown>;
    if (r.ok !== true) return { failed: true, refused: "refused" in r };
    const raw = await deps.store.getFile(deps.mission.id, RAW_PATH(String(r.call_id)));
    let page: unknown = null;
    try { page = raw === null ? null : JSON.parse(raw); } catch { page = null; }
    return { callId: String(r.call_id), page, nextCursor: (r.next_cursor as string | null) ?? null, hasMore: (r.has_more as boolean | null) ?? null };
  };

  // F4: THE POOL, the first page of the chosen card (and its next page when the first holds fewer rows than are needed with their spares: the gateway allows two samples of one source)
  const params = parentInputs(card, ask);
  const first = await read(card.endpointId, params);
  reads.pool += 1;
  if ("failed" in first) return { kind: "cannot", ask, reason: first.refused ? "pool_refused" : "pool_failed", reads };
  const pages = [{ callId: first.callId, page: first.page }];
  const need = Math.max(1, ask.count ?? 10);
  if (mapPage(card, first.page).length < need + 2 && card.inputs.cursor && first.nextCursor && first.hasMore !== false) {
    const second = await read(card.endpointId, { ...params, [card.inputs.cursor]: first.nextCursor });
    reads.pool += 1;
    if (!("failed" in second)) pages.push({ callId: second.callId, page: second.page });
  }

  // THE EXPOSURE CHECK (decision 7.3): the first comments page of the ranked parents, in order, until enough parents with comments are found (a read the gateway refuses, its cap, leaves the parent unchecked)
  const exposure = new Map<string, { callId: string | null; page: unknown | null; failed: boolean }>();
  const commentsCard = ask.comments !== "none" ? chooseCard(ask, "comments") : null;
  if (commentsCard?.inputs.parent) {
    const ranked = rankPool(pages.flatMap((p) => mapPage(card, p.page)), ask, card);
    let withComments = 0;
    for (const row of ranked) {
      if (withComments >= need || reads.exposure >= need + EXPOSURE_EXTRA) break;
      if (card.counter && Number(row[card.counter.key]) === 0) continue;
      const value = row[commentsCard.inputs.parent.from];
      if (value === undefined || value === null || value === "") continue;
      const r = await read(commentsCard.endpointId, { [commentsCard.inputs.parent.param]: value });
      reads.exposure += 1;
      if ("failed" in r) { exposure.set(row.id, { callId: null, page: null, failed: true }); withComments += 1; continue; }
      exposure.set(row.id, { callId: r.callId, page: r.page, failed: false });
      if (mapPage(commentsCard, r.page).length > 0) withComments += 1;
    }
  }

  const result = compilePlan({ ask, pool: { card, params, pages }, exposure: (id) => exposure.get(id), capabilityOf: (id) => deps.catalog.byId.get(id)?.capability ?? null, pricingSettings: deps.pricingSettings });
  if (!result.ok) return { kind: "cannot", ask, reason: result.reason, reads };
  return { kind: "plan", plan: result.plan, ask, result, reads };
}
