import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { redesignStagesOf, fallbackStageOf } from "../agent/src/redesign";
import type { Gateway } from "../agent/src/gateway";
import { planByCompiler, type CompiledPlanning } from "../agent/src/compiled";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import { chooseCard, compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { checkCustomerText } from "../src/lib/agentMission/text";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { replayGateway, storedCalls } from "./helpers/replayGateway";

/**
 * F7, THE REPLAY OF REAL MISSIONS (docs/FOUNDATION-PLAN.md PR 2a acceptance 2 and 3). The compiler plans from the stored pages (served by the replay gateway only for the
 * same endpoint and the same inputs as the stored call) and the engine executes the compiled plan on the stored pages. No model, no network, no paid call.
 */
const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string; stages: Array<{ key: string; endpoint_id: string }> }> };
const stored = (id: string) => fixture.missions.find((m) => m.id === id)!;
const rows = (mission: string, stage: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/rows/${stage}.json`, import.meta.url), "utf8"));
const TYPES_OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" } as RedesignFlags;

const M12 = "msn_5851abc92a1e6645a9cd";
// M12's card was edited by the customer 15 seconds after it was shown (two plan events, V: SELECT on mission_events): the stored edited plan has 300 comments and 67 replies
// (V: SELECT on missions.plan). The Ask carries that edit, as Stage 2 will recompile with it.
const M12_EDIT = { comments: 300, replies: 67 };

describe("acceptance 2: M12 (TikTok) replayed on its stored pages", () => {
  let planned: CompiledPlanning;
  let planningStats: ReturnType<typeof replayGateway>["stats"];
  let delivered: { videos: string[]; comments: string[]; replies: string[]; unserved: number };
  beforeAll(async () => {
    const store = createMemoryStore();
    const target = "msn_replay_m12";
    const { gateway, stats } = replayGateway(M12, catalog, store, target);
    planningStats = stats;
    planned = await planByCompiler({ mission: { id: target, request_text: stored(M12).request, answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-02T11:36:00Z"), edits: M12_EDIT });
    if (planned.kind !== "plan") return;
    const exec = replayGateway(M12, catalog, store, target, { firstSeq: 100 });
    const items = await ItemStore.open(store, target);
    const plan = planned.plan;
    await runEngine({ items, store, plan: withPromiseCaps(plan), missionId: target, gateway: exec.gateway as unknown as Gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(plan, TYPES_OFF, true, { tiktok: "test" }) });
    delivered = { videos: items.acceptedRows("videos").map((r) => String(r.id)), comments: items.acceptedRows("comments").map((r) => String(r.id)), replies: items.acceptedRows("comments_replies").map((r) => String(r.id)), unserved: exec.stats.unserved.length };
  }, 120_000);

  it("the compiler plans it (no model) from the stored pages only: the pool is the stored search page, the exposure check the stored first comments pages", () => {
    expect(planned.kind).toBe("plan");
    expect(planningStats.unserved).toEqual([]);
    expect(planningStats.served.map((s) => s.storedCall)).toEqual(["call_0007", "call_0008", "call_0019"]);
  });

  it("the same tools as the stored plan, stage by stage", () => {
    if (planned.kind !== "plan") throw new Error("no plan");
    expect(planned.plan.stages.map((s) => s.endpoint_id)).toEqual(stored(M12).stages.map((s) => s.endpoint_id));
    expect(planned.plan.stages.map((s) => s.key)).toEqual(["videos", "comments", "comments_replies"]);
  });

  it("the typed promise: 2 videos exact, the comments by the platform counters (capped by the edit), the replies open; no estimate", () => {
    if (planned.kind !== "plan") throw new Error("no plan");
    expect(planned.result.promises.videos).toEqual({ type: "exact", n: 2 });
    expect(planned.result.promises.comments).toEqual({ type: "counter", n: 300, counter: 1167 + 1084 });
    expect(planned.result.promises.comments_replies).toEqual({ type: "open", n: 67 });
    expect(Object.values(planned.plan.compiled!.promises).map((p) => p.type).every((t) => ["exact", "counter", "open"].includes(t))).toBe(true);
    // the chosen videos are the stored pinned ones: Egypt and Arabic first, then the most commented of the pool
    expect(planned.result.chosen).toEqual(["7663879872137252114", "7690257663250205974"]);
  });

  it("the engine delivers the same ids as the stored rows: 2 videos, 300 comments, 67 replies", () => {
    expect(new Set(delivered.videos)).toEqual(new Set(rows(M12, "videos").map((r) => String(r.id))));
    expect(delivered.comments).toHaveLength(300);
    expect(new Set(delivered.comments)).toEqual(new Set(rows(M12, "comments").map((r) => String(r.id))));
    expect(delivered.replies).toHaveLength(67);
    expect(new Set(delivered.replies)).toEqual(new Set(rows(M12, "comments_replies").map((r) => String(r.id))));
  });

  it("every customer sentence of the compiled card passes the customer-text check (Arabic, no provider, no price)", () => {
    if (planned.kind !== "plan") throw new Error("no plan");
    for (const line of [planned.plan.summary_ar, ...(planned.plan.notes_ar ?? []), ...(planned.plan.assumptions_ar ?? [])]) {
      expect(checkCustomerText(line, { maxChars: 400 }).issues, line).toEqual([]);
      expect(line).not.toMatch(/[0-9]/);
    }
  });

  it("F6: the compiled plan runs the new engine whole, whatever the type flags say, and never falls back", () => {
    if (planned.kind !== "plan") throw new Error("no plan");
    expect([...redesignStagesOf(planned.plan, TYPES_OFF, false, {})].sort()).toEqual(["comments", "comments_replies", "videos"]);
    expect(fallbackStageOf(planned.plan, TYPES_OFF, false, {})).toBeNull();
  });
});

const M14 = "msn_b060d3347ed7660f972e";
describe("acceptance 3: M14 (X) replayed on its stored pages: NOT MET, and why", () => {
  it("the compiler chooses the stored tool, and writes the Cairo October; no stored page answers those inputs, so the replay serves nothing and plans nothing", async () => {
    const store = createMemoryStore();
    const { gateway, stats } = replayGateway(M14, catalog, store, "msn_replay_m14");
    const out = await planByCompiler({ mission: { id: "msn_replay_m14", request_text: stored(M14).request, answer_text: null, created_at: "2026-11-02T13:04:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-02T13:05:00Z") });
    expect(out.kind).toBe("cannot");
    expect(stats.served).toEqual([]);
    expect(stats.unserved).toHaveLength(1);
    expect(stats.unserved[0].endpointId).toBe(stored(M14).stages[0].endpoint_id);
    // the compiled query: the customer's words, Arabic, and Cairo October as UTC instants (21:00 on 30 September to 22:00 on 31 October)
    expect(stats.unserved[0].params).toEqual({ query: "\"العاصمة الإدارية\" lang:ar since:2026-09-30_21:00:00_UTC until:2026-10-31_22:00:00_UTC -filter:replies", queryType: "Latest", limit: 20 });
    // the stored delivery was read with the model's own day bound until:2026-10-31 (UTC midnight), which leaves out 31 October; the one stored page with until:2026-11-01 shares 1 tweet of 20 with the delivery
    const execution = storedCalls(M14).filter((c) => c[1] === "execution");
    expect(execution.map((c) => c[5].query)).toEqual(["\"العاصمة الإدارية\" lang:ar since:2026-10-01 until:2026-10-31"]);
  });

  it("what IS met: on the page the stored delivery came from, the compiled tweets stage maps the same 20 ids, the promise is exact 20, and the replies step is the child stage of the verified X replies card (round 8)", () => {
    const ask = buildAsk(stored(M14).request, null, Date.parse("2026-11-02T13:04:00Z"));
    const card = chooseCard(ask, "parents")!;
    expect(card.endpointId).toBe("anyapi.x.search.posts");
    const page = JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M14}/raw/call_0003.json`, import.meta.url), "utf8"));
    const r = compilePlan({ ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0003", page }] }, exposure: () => undefined, capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null });
    if (!r.ok) throw new Error(r.reason);
    // the same 20 tweets (the page holds exactly 20), but the originals now come first: the request says «مع الردود», so a tweet that is itself a reply ranks below them (live D5)
    expect(new Set(r.chosen)).toEqual(new Set(rows(M14, "tweets").map((t) => String(t.id))));
    const isReply = new Map(rows(M14, "tweets").map((t) => [String(t.id), ((t.__marks as { reply?: boolean } | undefined)?.reply === true)] as const));
    const firstReply = r.chosen.findIndex((id) => isReply.get(id));
    expect(firstReply).toBeGreaterThan(0);
    expect(r.chosen.slice(firstReply).every((id) => isReply.get(id))).toBe(true);
    expect(r.promises.tweets).toEqual({ type: "exact", n: 20 });
    expect(r.plan.unserved_steps).toBeUndefined();
    expect(r.plan.stages.map((s) => s.key)).toEqual(["tweets", "replies"]);
    expect(cardOf("anyapi.x.search.posts")!.status).toBe("verified");
  });
});
