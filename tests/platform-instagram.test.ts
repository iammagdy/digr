import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, compiledPlatformActive, type CompiledPlanning } from "../agent/src/compiled";
import { chooseCard, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { redesignStagesOf, fallbackStageOf } from "../agent/src/redesign";
import type { Gateway } from "../agent/src/gateway";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { replayGateway } from "./helpers/replayGateway";

/**
 * FOUNDATION-PLAN PR 3, INSTAGRAM ON THE FOUNDATION (acceptance 2): M16 `msn_e3e7632e2fb2d42f9c19` and M15 `msn_afe9bb0b436670e35a3c` read the account with the pageable card, choose the
 * two most commented of the pool (the stored 12-post page), and have a replies stage. The comments and replies pages are the stored ones, served only for the same tool and the same post
 * (an Instagram post link is compared by its media id: tests/helpers/replayGateway.ts).
 */
const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const request = (id: string): string => fixture.missions.find((m) => m.id === id)!.request;
const M16 = "msn_e3e7632e2fb2d42f9c19";
const M15 = "msn_afe9bb0b436670e35a3c";
const SCRAPE = "scrapecreators.instagram.user.posts";
const rows = (mission: string, stage: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/rows/${stage}.json`, import.meta.url), "utf8"));

async function plan(mission: string, over: { created: string; catalogOnly?: boolean }) {
  const store = createMemoryStore();
  const target = `msn_replay_${mission.slice(4, 10)}`;
  const { gateway, stats } = replayGateway(mission, catalog, store, target);
  const out = await planByCompiler({ mission: { id: target, request_text: request(mission), answer_text: null, created_at: over.created }, gateway, store, catalog, nowMs: Date.parse(over.created) + 60_000, ...(over.catalogOnly ? { catalogOnly: true } : {}) });
  return { out, stats };
}
const planOf = (out: CompiledPlanning) => { if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}${"reason" in out ? ` ${out.reason}` : ""}`); return out; };
const codeOf = (link: unknown): string => String(link).match(/\/p\/([^/]+)\//)![1];

describe("acceptance 2: M16 reads the account with the pageable card, chooses the two most commented, and has a replies stage", () => {
  it("the Ask: the account `alhadath`, no topic, 2 posts, every comment and reply", () => {
    const ask = buildAsk(request(M16), null, Date.parse("2026-11-02T17:31:00Z"));
    expect([ask.platform, ask.count, ask.source, ask.topic.text, ask.period, ask.comments, ask.replies]).toEqual(["instagram", 2, { kind: "named", text: "alhadath" }, null, null, "all", "all"]);
  });

  it("the pageable card is the account card that has a real page showing `next_max_id` (verified), for every account and for a test account (the cheaper verified one wins over the catalog_only one)", () => {
    const ask = buildAsk(request(M16), null, Date.parse("2026-11-02T17:31:00Z"));
    expect(chooseCard(ask, "parents")!.endpointId).toBe(SCRAPE);
    expect(chooseCard(ask, "parents", { catalogOnly: true })!.endpointId).toBe(SCRAPE);
    expect(parentInputs(chooseCard(ask, "parents")!, ask)).toEqual({ handle: "alhadath" });
  });

  it("the compiled plan: posts, comments, replies, all by verified cards (any account), 1 pool read and 2 exposure reads, the stored page of 12 posts", async () => {
    const { out, stats } = await plan(M16, { created: "2026-11-02T17:31:00Z" });
    const p = planOf(out);
    expect(p.plan.stages.map((s) => [s.key, s.endpoint_id])).toEqual([["posts", SCRAPE], ["comments", "anyapi.instagram.post.comments"], ["comments_replies", "anyapi.instagram.comment_replies"]]);
    // CHANGED (live round 10): with no period the listing's next page is read too (the gateway's two samples of a source); no stored second page answers it here, so the read is recorded as not served and the pool is the 12 posts
    expect(p.reads).toEqual({ pool: 2, exposure: 2 });
    expect(stats.unserved.map((u) => [u.endpointId, typeof u.params.next_max_id])).toEqual([[SCRAPE, "string"]]);
    expect(stats.served.map((s) => s.storedCall)).toEqual(["call_0002", "call_0008", "call_0009"]);
    expect(p.plan.compiled?.by).toBe("compiler");
    expect(p.plan.unserved_steps).toBeUndefined();
  });

  it("it chooses the two most commented of the pool: the same two posts the stored delivery had (9 and 5 comments), most commented first", async () => {
    const p = planOf((await plan(M16, { created: "2026-11-02T17:31:00Z" })).out);
    const chosen = (p.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((r) => [codeOf(r.link), r.comments]);
    expect(chosen).toEqual([["DfPmHqGE3Jn", 9], ["DfPmsKPjX_B", 5]]);
    expect(new Set(chosen.map((c) => c[0]))).toEqual(new Set(rows(M16, "posts").map((r) => String(r.id))));
    // posts the pool ranked next are kept as spares
    expect((p.plan.stages[0].spare_rows ?? []).length).toBe(2);
  });

  it("the promises: posts exact, comments by the platform counters (9 + 5), replies open (the comments card has no reply counter)", async () => {
    const p = planOf((await plan(M16, { created: "2026-11-02T17:31:00Z" })).out);
    expect(p.result.promises.posts).toEqual({ type: "exact", n: 2 });
    expect(p.result.promises.comments).toEqual({ type: "counter", n: 14, counter: 14 });
    expect(p.result.promises.comments_replies.type).toBe("open");
    const replies = p.plan.stages[2];
    expect(replies.parent_key).toBe("comments");
    expect(replies.engine?.parent_binding).toMatchObject({ param: "commentId", from: "id", also: [{ param: "url", from: "link", grand: true }] });
    // the comments stage binds each post by its link
    expect(p.plan.stages[1].engine?.parent_binding).toEqual({ param: "url", from: "link" });
    expect(p.plan.stages[1].parent_pins).toEqual(p.result.chosen);
  });

  it("the card in Arabic only, no provider, no price, no Latin digit", async () => {
    const p = planOf((await plan(M16, { created: "2026-11-02T17:31:00Z" })).out);
    for (const line of [p.plan.summary_ar, ...(p.plan.notes_ar ?? []), ...(p.plan.assumptions_ar ?? [])]) {
      expect(checkCustomerText(line, { maxChars: 400 }).issues, line).toEqual([]);
      expect(line).not.toMatch(/[0-9]/);
    }
    expect(JSON.stringify(p.plan.summary_ar)).toContain("منشوران");
  });
});

describe("the engine executes the compiled M16 plan on the stored execution pages: the delivered ids are the stored ones", () => {
  it("the 2 posts, the 13 comments (8 + 5) and the 1 reply of the stored delivery; no stored page is missing, no call outside the plan", async () => {
    const store = createMemoryStore();
    const target = "msn_replay_m16_exec";
    const planning = replayGateway(M16, catalog, store, target);
    const out = await planByCompiler({ mission: { id: target, request_text: request(M16), answer_text: null, created_at: "2026-11-02T17:31:00Z" }, gateway: planning.gateway, store, catalog, nowMs: Date.parse("2026-11-02T17:32:00Z") });
    const p = planOf(out);
    const exec = replayGateway(M16, catalog, store, target, { firstSeq: 100 });
    const items = await ItemStore.open(store, target);
    const OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" } as RedesignFlags;
    await runEngine({ items, store, plan: withPromiseCaps(p.plan), missionId: target, gateway: exec.gateway as unknown as Gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(p.plan, OFF, true, { instagram: "test" }) });
    expect(new Set(items.acceptedRows("posts").map((r) => codeOf(r.link)))).toEqual(new Set(rows(M16, "posts").map((r) => String(r.id))));
    expect(new Set(items.acceptedRows("comments").map((r) => String(r.id)))).toEqual(new Set(rows(M16, "comments").map((r) => String(r.id))));
    expect(items.acceptedRows("comments")).toHaveLength(13);
    expect(new Set(items.acceptedRows("comments_replies").map((r) => String(r.id)))).toEqual(new Set(rows(M16, "comments_replies").map((r) => String(r.id))));
    // CHANGED (round 16): the plan now carries the one verified alternative comments card, so the engine, whose main tool ended before the count for a post, asks it (once more after a failure); the live run never read it, so no stored page answers: the ONLY unserved calls are
    // those of that planned alternative, nothing outside the plan, and they add no row (the 13 comments above are still exactly the stored ones)
    const alternatives = (p.plan.stages.find((s) => s.key === "comments")!.engine!.alternatives ?? []).map((a) => a.endpoint_id);
    expect(alternatives).toEqual(["scrapecreators.instagram.post.comments"]);
    expect(exec.stats.unserved.length).toBeGreaterThan(0);
    expect(exec.stats.unserved.every((u) => alternatives.includes(u.endpointId))).toBe(true);
    // F6: the compiled plan runs the new engine whole and never falls back
    expect([...redesignStagesOf(p.plan, OFF, false, {})].sort()).toEqual(["comments", "comments_replies", "posts"]);
    expect(fallbackStageOf(p.plan, OFF, false, {})).toBeNull();
  }, 120_000);
});

describe("M15 (the same request, the other stored account page)", () => {
  it("chooses the two most commented of its 12 posts (5 and 2 comments) with the same stages; a post whose comments no stored page answers is chosen unchecked, never dropped", async () => {
    const { out, stats } = await plan(M15, { created: "2026-11-02T15:35:00Z" });
    const p = planOf(out);
    expect(p.plan.stages.map((s) => s.endpoint_id)).toEqual([SCRAPE, "anyapi.instagram.post.comments", "anyapi.instagram.comment_replies"]);
    expect((p.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((r) => [codeOf(r.link), r.comments])).toEqual([["DfPYmZ1AcI2", 5], ["DfPaQZDiLCq", 2]]);
    expect(p.result.promises.comments).toEqual({ type: "counter", n: 7, counter: 7 });
    expect(p.result.promises.comments_replies.type).toBe("open");
    // the page of the first post was never read live, so no stored page answers it: the read is recorded as not served
    // (and the second page of the listing, which no stored page answers: round 10)
    expect(stats.unserved).toHaveLength(2);
  });
});

describe("a topic or a period on an account: the card says it cannot carry them, and chooses by the caption (a choice, never a filter)", () => {
  it("the account listing has no keyword and no date input: both are said before approval and nothing is dropped", async () => {
    const store = createMemoryStore();
    const { gateway } = replayGateway(M16, catalog, store, "msn_replay_ig_t");
    const out = await planByCompiler({ mission: { id: "msn_replay_ig_t", request_text: "هات منشورين من حساب الحدث على إنستجرام (alhadath) عن الانتخابات آخر شهر، مع كل التعليقات والردود.", answer_text: null, created_at: "2026-11-02T17:31:00Z" }, gateway, store, catalog, nowMs: Date.now() });
    const p = planOf(out);
    expect(p.plan.stages[0].engine?.gaps).toEqual(expect.arrayContaining([{ cls: "date", reason: "no_field" }]));
    expect((p.plan.notes_ar ?? []).join("\n")).toContain("«الانتخابات»");
    expect(p.plan.stages[0].filters?.some((f) => f.kind === "period")).toBe(true);
  });

  it("an account given by an Arabic name (no handle) cannot be read by a handle input: the plan is not made and the reason is honest", async () => {
    const store = createMemoryStore();
    const { gateway } = replayGateway(M16, catalog, store, "msn_replay_ig_n");
    const out = await planByCompiler({ mission: { id: "msn_replay_ig_n", request_text: "هات منشورين من حساب قناة الحدث على إنستجرام، مع كل التعليقات والردود.", answer_text: null, created_at: "2026-11-02T17:31:00Z" }, gateway, store, catalog, nowMs: Date.now() });
    expect(out.kind).toBe("cannot");
    if (out.kind === "cannot") expect(out.reason).toBe("no_parent_card");
    expect(out.reads.pool).toBe(0);
  });
});

describe("the flag", () => {
  it("Instagram is compiled only behind its own flag", () => {
    expect(compiledPlatformActive({ instagram: "test" }, "instagram", true)).toBe(true);
    expect(compiledPlatformActive({ instagram: "test" }, "instagram", false)).toBe(false);
    expect(compiledPlatformActive({ instagram: "on" }, "instagram", false)).toBe(true);
    expect(compiledPlatformActive({ facebook: "on", youtube: "on" }, "instagram", true)).toBe(false);
    expect(compiledPlatformActive({}, "instagram", true)).toBe(false);
  });
});
