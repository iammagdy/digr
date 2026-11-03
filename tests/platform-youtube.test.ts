import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, compiledPlatformActive, type CompiledPlanning } from "../agent/src/compiled";
import { buildAsk, officialChannelQueriesOf } from "../src/lib/agentMission/foundation/ask";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { replayGateway, type ReplayOptions } from "./helpers/replayGateway";

/**
 * FOUNDATION-PLAN PR 3, YOUTUBE ON THE FOUNDATION (acceptance 3): M2 `msn_ee599cdbbde993073b15`, M18 `msn_3594a5ab6311c8691f20` and M20 `msn_adcfafabcdebc27ff803` take their videos
 * from the channel ids of the stored channel-search pages and have comments and replies stages. Only M2 stored a channel search; M18 and M20 have the same request text, so they are planned on M2's
 * stored pages. THE STORED SEARCH WORDS ARE THE MODEL'S (English club names; the in-channel search words); the compiler writes its own, so the replay serves the channel pages by the channel
 * input only (`only`), and the two club names are given to the Ask as the channel names (`edits.channels`), as the understanding step of Stage 2 will give them.
 */
const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const request = (id: string): string => fixture.missions.find((m) => m.id === id)!.request;
const M2 = "msn_ee599cdbbde993073b15";
const M18 = "msn_3594a5ab6311c8691f20";
const M20 = "msn_adcfafabcdebc27ff803";
const CHANNELS = ["Al Ahly SC official", "Zamalek SC official"];
const IN_CHANNEL = "tikhub.x.youtube-web-search-channel";
const REPLAY: ReplayOptions = { only: { [IN_CHANNEL]: ["channel_id"], "crawl4ai.youtube.video.comments": ["video"] } };
const OFFICIAL_IDS = new Set(["UCA86pBGxVPZGrTeTecOtjew", "UCeFU0ebL1MK2KlBFniRs6Iw"]);

async function plan(requestOf: string, over: { catalogOnly?: boolean; channels?: string[] | null } = {}) {
  const store = createMemoryStore();
  const { gateway, stats } = replayGateway(M2, catalog, store, "msn_replay_yt", REPLAY);
  const out = await planByCompiler({
    mission: { id: "msn_replay_yt", request_text: request(requestOf), answer_text: null, created_at: "2026-11-01T21:09:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-01T21:10:00Z"),
    ...(over.channels === null ? {} : { edits: { channels: over.channels ?? CHANNELS } }), ...(over.catalogOnly ? { catalogOnly: true } : {}),
    // CHANGED (live round 10, decision 7): the request is a recurring event with no year, so the plan first asks «تقصد أنهي مرة؟»; these tests are about the plan, so the customer has answered «كل المرات» (tests/round10-youtube.test.ts covers the question)
    occurrence: { kind: "all" },
  });
  return { out, stats };
}
const planOf = (out: CompiledPlanning) => { if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}${"reason" in out ? ` ${out.reason}` : ""}`); return out; };

describe("acceptance 3: M2, M18 and M20 take their videos from the official channels' ids and have comments and replies stages", () => {
  it("the Ask: official channels, the topic, 2 videos, every comment and reply; the channel names are read from the topic's tail (the two clubs) when none is given", () => {
    const ask = buildAsk(request(M2), null, Date.parse("2026-11-01T21:09:00Z"));
    expect([ask.platform, ask.count, ask.source.kind, ask.topic.text, ask.comments, ask.replies]).toEqual(["youtube", 2, "official", "نهائي السوبر المصري الأهلي والزمالك", "all", "all"]);
    expect(officialChannelQueriesOf("نهائي السوبر المصري الأهلي والزمالك")).toEqual(["الأهلي الرسمية", "الزمالك الرسمية"]);
    expect(officialChannelQueriesOf("الانتخابات الرئاسية")).toEqual(["الانتخابات الرئاسية الرسمية"]);
  });

  it("M2 (a test account): the channels are resolved first, then each is read inside; the pool is the two stored in-channel pages (60 videos); the chosen videos are the official channels' own", async () => {
    const { out, stats } = await plan(M2, { catalogOnly: true });
    const p = planOf(out);
    const calls = stats.served.map((s) => [s.endpointId, s.storedCall]);
    // channel search first (one per club), then the in-channel searches (round-robin over the clubs' top channels, two reads at most: the gateway's two samples of a source)
    expect(calls.slice(0, 2)).toEqual([["tikhub.x.youtube-web-v2-search-channels", "call_0003"], ["tikhub.x.youtube-web-v2-search-channels", "call_0004"]]);
    expect(calls.filter((c) => c[0] === IN_CHANNEL).map((c) => c[1]).sort()).toEqual(["call_0006", "call_0007"]);
    const videos = p.plan.stages[0].pinned_rows as Array<Record<string, unknown>>;
    expect(videos).toHaveLength(2);
    for (const v of videos) expect(OFFICIAL_IDS.has(String(v.channel_id))).toBe(true);
    expect(p.plan.stages[0].endpoint_id).toBe(IN_CHANNEL);
    expect(p.plan.stages[0].engine?.params).toMatchObject({ channel_id: expect.stringMatching(/^UC/) });
  });

  it("M2 on a test account has videos, comments and replies stages; the comments card is the one that feeds replies, the replies card is the catalog_only one, both inside the 0.20 USD cap", async () => {
    const p = planOf((await plan(M2, { catalogOnly: true })).out);
    expect(p.plan.stages.map((s) => [s.key, s.endpoint_id])).toEqual([["videos", IN_CHANNEL], ["comments", "tikhub.youtube.video.comments"], ["comments_replies", "anyapi.youtube.comment_replies"]]);
    expect(p.plan.stages[1].engine?.parent_binding).toEqual({ param: "video_id", from: "id" });
    expect(p.plan.stages[2].engine?.parent_binding).toEqual({ param: "continuationToken", from: "reply_continuation_token" });
    const cost = [p.plan.stages[1], p.plan.stages[2]].reduce((s, x) => s + x.max_pages! * (x.key === "comments" ? 0.001 : 0.0012) * 2, 0);
    expect(cost).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(p.plan.unserved_steps).toBeUndefined();
  });

  it("M2 on a customer's account: videos and comments by verified cards only (the comments card that reads up to 500 in one call); the replies are said not to be included", async () => {
    const p = planOf((await plan(M2)).out);
    expect(p.plan.stages.map((s) => [s.key, s.endpoint_id])).toEqual([["videos", IN_CHANNEL], ["comments", "crawl4ai.youtube.video.comments"]]);
    expect(p.plan.stages[1].engine?.params).toEqual({ limit: 500 });
    expect(p.plan.unserved_steps?.map((s) => s.what_ar)).toEqual(["الردود"]);
  });

  it("the promise: videos exact; comments OPEN (no search or channel page has a comment counter and the free detail card is catalog_only: the detail read is not served here); replies open", async () => {
    const p = planOf((await plan(M2, { catalogOnly: true })).out);
    expect(p.result.promises.videos).toEqual({ type: "exact", n: 2 });
    expect(p.result.promises.comments.type).toBe("open");
    expect(p.result.promises.comments_replies.type).toBe("open");
    expect(Object.values(p.plan.compiled!.promises).every((x) => ["exact", "counter", "open"].includes(x.type))).toBe(true);
  });

  it("when the detail card answers (a test account), the promise is the counters of the chosen videos", async () => {
    const store = createMemoryStore();
    const { gateway } = replayGateway(M2, catalog, store, "msn_replay_yt_d", REPLAY);
    const withDetail = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) {
        if (input.endpoint_id !== "youtube.youtube.video.detail") return gateway.tregCall(input);
        const ids = String((input.params as { id?: string }).id ?? "").split(",");
        const body = JSON.stringify({ items: ids.map((id, n) => ({ id, statistics: { viewCount: "1", commentCount: String(100 + n) } })) });
        await store.putFile("msn_replay_yt_d", "raw/call_0900.json", body, "application/json");
        return { ok: true as const, call_id: "call_0900", http_status: 200, rows_in_page: ids.length, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "call_0900" };
      },
    };
    const out = await planByCompiler({ mission: { id: "msn_replay_yt_d", request_text: request(M2), answer_text: null, created_at: "2026-11-01T21:09:00Z" }, gateway: withDetail, store, catalog, occurrence: { kind: "all" }, nowMs: Date.now(), edits: { channels: CHANNELS }, catalogOnly: true });
    const p = planOf(out);
    expect(p.result.promises.comments.type).toBe("counter");
    expect(p.result.promises.comments.n).toBeGreaterThan(0);
    // ranked by the counters: the first chosen video has the largest counter of the pool
    const counters = (p.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((r) => Number(r.comments));
    expect(counters[0]).toBeGreaterThanOrEqual(counters[1]);
  });

  it("M18 and M20 (the same request text) never lose the comments stage: every account has videos and comments; a test account adds the replies", async () => {
    for (const id of [M18, M20, M2]) {
      const customer = planOf((await plan(id)).out);
      expect(customer.plan.stages.map((s) => s.key), id).toEqual(["videos", "comments"]);
      const test = planOf((await plan(id, { catalogOnly: true })).out);
      expect(test.plan.stages.map((s) => s.key), id).toEqual(["videos", "comments", "comments_replies"]);
      for (const v of test.plan.stages[0].pinned_rows as Array<Record<string, unknown>>) expect(OFFICIAL_IDS.has(String(v.channel_id)), id).toBe(true);
    }
  });

  it("with no channel read, the plan is NOT made (never a plan with a plain search that has no channel input, which was why M18 and M20 took a video of another channel)", async () => {
    const store = createMemoryStore();
    const { gateway } = replayGateway(M20, catalog, store, "msn_replay_yt_e");
    const out = await planByCompiler({ mission: { id: "msn_replay_yt_e", request_text: request(M20), answer_text: null, created_at: "2026-11-02T19:00:00Z" }, gateway, store, catalog, occurrence: { kind: "all" }, nowMs: Date.now() });
    expect(out.kind).toBe("cannot");
    if (out.kind === "cannot") expect(["no_rows", "pool_failed"]).toContain(out.reason);
  });

  it("the card is Arabic only, no provider, no price, no Latin digit, and says which channels were read", async () => {
    const p = planOf((await plan(M2, { catalogOnly: true })).out);
    for (const line of [p.plan.summary_ar, ...(p.plan.notes_ar ?? [])]) {
      expect(checkCustomerText(line, { maxChars: 450 }).issues, line).toEqual([]);
      expect(line).not.toMatch(/[0-9]/);
    }
    expect((p.plan.notes_ar ?? []).join("\n")).toContain("عدد القنوات التي قرأنا فيديوهاتها: ٢");
  });
});

describe("the flag", () => {
  it("YouTube is compiled only behind its own flag", () => {
    expect(compiledPlatformActive({ youtube: "test" }, "youtube", true)).toBe(true);
    expect(compiledPlatformActive({ youtube: "test" }, "youtube", false)).toBe(false);
    expect(compiledPlatformActive({ youtube: "on" }, "youtube", false)).toBe(true);
    expect(compiledPlatformActive({ facebook: "on", instagram: "on" }, "youtube", true)).toBe(false);
    expect(compiledPlatformActive({}, "youtube", true)).toBe(false);
  });
});
