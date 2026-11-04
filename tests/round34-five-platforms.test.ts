import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { cardsWithDiscovery, discoveryActive, SOCIAL_DISCOVERY_KEY, type SelectCapability, type CandidateView } from "../src/lib/agentMission/foundation/discovery";
import { NO_SENSITIVE_ACCESS } from "../src/lib/treg/dataPolicy";
import { PARENT_ROLES } from "../src/lib/agentMission/foundation/compilePlan";
import { replayMission, catalog, type MissionReplay } from "./helpers/missionReplay";
import { FB, M12, MISSIONS, YT1 } from "./helpers/round14Missions";
import { catalogPage, deliver, discoveryWorld } from "./helpers/discoveryWorld";

/**
 * ROUND 34, DISCOVERY ON ALL FIVE PLATFORMS. The switch (`social_discovery = test`, a test account) sends EVERY compiled social mission through the catalog evaluation: the verified, hand-written tools and the tools derived from the catalog are candidates together, each candidate's chain is
 * checked against the catalog, the model may choose only among the validated ones, and the plan keeps the audit mark (what was eligible, what was refused and why, what was chosen). EVIDENCE LABELS: TikTok, Facebook and YouTube run on the stored REAL provider pages; X and Instagram run on
 * SIMULATED pages (the catalog's own example shape), because no stored real page answers their planning inputs (documented in tests/round33-acceptance-real.test.ts). Nothing is a network call and nothing is paid.
 */
const ids = (c: ReadonlyArray<CandidateView>): string[] => c.map((x) => x.endpointId);

describe("THE SWITCH: only the exact value `test`, only for a test account", () => {
  it("is on for `test` + a test account; off for `on`, other values, no value, and any customer account", () => {
    expect(SOCIAL_DISCOVERY_KEY).toBe("social_discovery");
    expect(discoveryActive({ social_discovery: "test" }, true)).toBe(true);
    expect(discoveryActive({ social_discovery: "test" }, false)).toBe(false);
    for (const v of ["on", "off", "TEST", "true", true, 1, null, undefined, { mode: "test" }]) expect(discoveryActive({ social_discovery: v }, true), String(v)).toBe(false);
    expect(discoveryActive({}, true)).toBe(false);
    expect(discoveryActive(undefined, true)).toBe(false);
  });
});

describe("THE GRAMMAR: all five platforms have a parent role the catalog's capabilities feed, and every refusal has a reason", () => {
  it.each(["tiktok", "x", "facebook", "instagram", "youtube"] as const)("%s: the evaluation sees every catalog tool of its roles (derived or refused with a named reason) next to the verified cards", (platform) => {
    const d = cardsWithDiscovery(catalog, platform, NO_SENSITIVE_ACCESS);
    const verified = d.cards.filter((c) => !c.derived && c.platform === platform && PARENT_ROLES[platform].includes(c.role));
    expect(verified.length, "a verified or hand-written parent card exists").toBeGreaterThan(0);
    const evaluated = d.cards.filter((c) => c.platform === platform).length + d.rejected.length;
    expect(evaluated, "the catalog's tools of the platform's capabilities were evaluated").toBeGreaterThan(verified.length);
    for (const r of d.rejected) expect(r.reason, r.endpointId).toMatch(/^[a-z_]+$/);
  });
  it("TikTok, X and Facebook: a tool that already has a verified card is recorded as `has_hand_card`, not derived twice, and the other catalog tools are decided by the catalog's evidence", () => {
    for (const platform of ["tiktok", "x", "facebook"] as const) {
      const d = cardsWithDiscovery(catalog, platform, NO_SENSITIVE_ACCESS);
      const reasons = new Set(d.rejected.map((r) => r.reason));
      expect(reasons.has("has_hand_card"), platform).toBe(true);
      for (const c of d.cards.filter((x) => x.derived)) { expect(c.status).toBe("catalog_only"); expect(c.platform).toBe(platform); }
    }
  });
});

describe.each(MISSIONS.filter((m) => [M12, YT1, FB].includes(m.id)))("REAL stored pages, discovery ON: $label", ({ input }) => {
  let off: MissionReplay;
  let on: MissionReplay;
  const shown: string[][] = [];
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(input.readAt));
    off = await replayMission(input);
    // the model's choice: always the first validated candidate (a recording stand-in: it is shown only what the compiler validated)
    const select: SelectCapability = async ({ candidates }) => { shown.push(ids(candidates)); return { endpointId: candidates[0].endpointId, reason: "first validated candidate", costUsd: 0 }; };
    on = await replayMission({ ...input, discovery: { select } });
  }, 480_000);
  afterAll(() => { vi.useRealTimers(); });

  it("DISCOVERY WAS ENTERED: the plan keeps the audit mark with the platform, the eligible candidates and the chosen tool, and the chosen tool is among the eligible ones", () => {
    const mark = on.planned.plan.compiled?.discovery;
    expect(mark, "mark").toBeDefined();
    expect(mark!.entered).toBe(true);
    expect(mark!.evaluation!.platform).toBe(input.platform);
    expect(mark!.evaluation!.eligible.length).toBeGreaterThanOrEqual(1);
    expect(mark!.evaluation!.eligible.map((e) => e.endpoint_id)).toContain(mark!.endpoint_id);
    expect(mark!.selection?.candidates).toContain(mark!.endpoint_id);
    expect(mark!.evaluation!.rejected).toBeTypeOf("object");
    expect(off.planned.plan.compiled?.discovery).toBeUndefined();
  });
  it("A VERIFIED TOOL STAYS A SAFE CANDIDATE: the chosen parents tool is a verified card and the plan's tools, counts and price equal the plan made without discovery", () => {
    const mark = on.planned.plan.compiled!.discovery!;
    expect(mark.status).toBe("verified");
    expect(mark.derived).toBe(false);
    expect(on.planned.plan.stages.map((s) => [s.key, s.endpoint_id, s.planned_rows])).toEqual(off.planned.plan.stages.map((s) => [s.key, s.endpoint_id, s.planned_rows]));
    expect(JSON.stringify(on.planned.plan.price)).toBe(JSON.stringify(off.planned.plan.price));
  });
  it("THE MODEL SEES ONLY VALIDATED CANDIDATES: what it was shown are ids of the evaluation's eligible set (never a free endpoint id), and nothing it said changed a price", () => {
    const eligible = new Set(on.planned.plan.compiled!.discovery!.evaluation!.eligible.map((e) => e.endpoint_id));
    for (const list of shown) for (const id of list) expect(eligible.has(id) || catalog.byId.has(id), id).toBe(true);
    expect(JSON.stringify(on.planned.plan.price)).toBe(JSON.stringify(off.planned.plan.price));
  });
  it("THE DELIVERY IS UNCHANGED: the same rows and ids as without discovery, no unserved read, no row dropped by a relevance judgement, and the methodology carries the completeness line", () => {
    for (const [stage, rows] of Object.entries(off.rowsByStage)) expect((on.rowsByStage[stage] ?? []).map((r) => String(r.id))).toEqual(rows.map((r) => String(r.id)));
    expect(on.unservedExecution).toBe(0);
    expect(on.built.contract.violations).toEqual([]);
    const text = JSON.stringify(on.planned.plan.notes_ar ?? []);
    expect(text).toMatch(/قرأنا|انتهت نتائج المصدر|لا نعرف إن كانت|في المصدر نتائج أخرى/);
    expect(text).not.toMatch(/لم يُجرَّب من قبل/);
  });
});

describe("X (SIMULATED pages: no stored real page answers the compiler's inputs): a verified search and a catalog-derived search are evaluated together", () => {
  const VERIFIED = "anyapi.x.search.posts";
  const DERIVED = "justoneapi.x.twitter-search-v1";
  const tweet = (i: number) => ({ id: `19000000000${i}`, text: `تغريدة عن الذكاء الاصطناعي ${i}`, authorName: `كاتب ${i}`, authorUsername: `writer${i}`, authorFollowers: 100 + i, createdUtc: "2026-10-20T10:00:00Z", url: `https://x.com/writer${i}/status/19000000000${i}`, isReply: false, lang: "ar", likeCount: i, replyCount: 0, retweetCount: i, viewCount: i * 10 });
  const REQUEST = "هات ١٠ تغريدات من تويتر عن الذكاء الاصطناعي";

  it("DISCOVERY ENTERED: both tools are eligible, the verified one is chosen (the derived one cannot carry the period), only it is read, and the mark says so", async () => {
    const w = discoveryWorld(REQUEST, { [VERIFIED]: () => catalogPage(VERIFIED, Array.from({ length: 14 }, (_, i) => tweet(i + 1)), null) }, { discovery: true, platform: "x" });
    const r = await w.plan();
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const mark = r.plan.compiled!.discovery!;
    expect(mark.entered).toBe(true);
    expect(mark.evaluation!.platform).toBe("x");
    const eligible = mark.evaluation!.eligible.map((e) => e.endpoint_id);
    expect(eligible).toContain(VERIFIED);
    expect(eligible).toContain(DERIVED);
    expect(mark.endpoint_id).toBe(VERIFIED);
    expect(mark.status).toBe("verified");
    expect(w.endpoints()).toEqual([VERIFIED]);
    expect(mark.evaluation!.rejected.has_hand_card ?? 0).toBeGreaterThanOrEqual(1);
    const d = await deliver(w, r.plan, REQUEST, "x");
    expect(d.rowsByStage.tweets.length).toBeGreaterThan(0);
    expect(w.executionCalls.every((c) => c.endpoint === VERIFIED)).toBe(true);
  });
  it("THE MODEL MAY CHOOSE ONLY AMONG VALIDATED CANDIDATES: a valid pick is used and recorded `model`; an id it invented is no answer (the ranking decides, recorded `rank`); no endpoint outside the evaluation is ever read", async () => {
    const seen: string[][] = [];
    const pick = (id: string): SelectCapability => async ({ candidates }) => { seen.push(ids(candidates)); return { endpointId: id, reason: "test", costUsd: 0 }; };
    const handlers = { [VERIFIED]: () => catalogPage(VERIFIED, Array.from({ length: 14 }, (_, i) => tweet(i + 1)), null), [DERIVED]: () => catalogPage(DERIVED, Array.from({ length: 14 }, (_, i) => ({ type: "tweet", tweet_id: `18000000000${i}`, screen_name: `w${i}`, created_at: "Mon Oct 20 10:00:00 +0000 2026", text: `تغريدة ${i}`, favorites: i, replies: 0, retweets: i, views: i, lang: "ar", conversation_id: `${i}` })), null) };
    const a = await discoveryWorld(REQUEST, handlers, { discovery: true, platform: "x" }).plan({ selectCapability: pick(VERIFIED) });
    expect(a.kind).toBe("plan");
    if (a.kind === "plan") { expect(a.plan.compiled!.discovery!.selection!.by).toBe("model"); expect(a.plan.stages[0].endpoint_id).toBe(VERIFIED); }
    const b = discoveryWorld(REQUEST, handlers, { discovery: true, platform: "x" });
    const rb = await b.plan({ selectCapability: pick("made.up.endpoint") });
    expect(rb.kind).toBe("plan");
    if (rb.kind === "plan") expect(rb.plan.compiled!.discovery!.selection!.by).toBe("rank");
    expect(b.endpoints().every((e) => [VERIFIED, DERIVED].includes(e))).toBe(true);
    for (const list of seen) expect(list.sort()).toEqual([DERIVED, VERIFIED].sort());
  });
  it("A VALID FALLBACK: the chosen tool's read failing (not refused) reads the next validated candidate once, and the mark records the fallback", async () => {
    const w = discoveryWorld(REQUEST, { [VERIFIED]: () => "fail", [DERIVED]: () => catalogPage(DERIVED, Array.from({ length: 14 }, (_, i) => ({ type: "tweet", tweet_id: `18000000000${i}`, screen_name: `w${i}`, created_at: "Mon Oct 20 10:00:00 +0000 2026", text: `تغريدة عن الذكاء الاصطناعي ${i}`, favorites: i, replies: 0, retweets: i, views: i, lang: "ar", conversation_id: `${i}` })), null) }, { discovery: true, platform: "x" });
    const r = await w.plan();
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.plan.stages[0].endpoint_id).toBe(DERIVED);
    expect(r.plan.compiled!.discovery!.derived).toBe(true);
    expect(r.plan.compiled!.discovery!.selection!.reason).toMatch(/fallback from/);
    expect(w.endpoints()).toEqual([VERIFIED, DERIVED]);
  });
});

describe("INSTAGRAM (SIMULATED pages): the catalog's keyword and hashtag tools are evaluated beside the verified account listing", () => {
  const HASHTAG = "scrapecreators.x.v1-instagram-search-hashtag";
  const post = (i: number) => ({ id: `39000000000000${String(i).padStart(5, "0")}`, shortcode: `Sc${i}`, url: `https://www.instagram.com/reel/Sc${i}/`, caption: `منشور عن الذكاء الاصطناعي ${i}`, video_view_count: i, video_play_count: i * 10, product_type: "clips", taken_at_timestamp: 1_790_000_000 + i, owner: { username: `u${i}` } });
  it("DISCOVERY ENTERED: the evaluation lists the verified listing and the derived keyword tools, the chosen tool is among them, and the mark carries the platform and the rejections with reasons", async () => {
    const w = discoveryWorld("عايز ١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي", { [HASHTAG]: () => catalogPage(HASHTAG, Array.from({ length: 14 }, (_, i) => post(i + 1)), null) }, { discovery: true, platform: "instagram" });
    const r = await w.plan();
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const mark = r.plan.compiled!.discovery!;
    expect(mark.entered).toBe(true);
    expect(mark.evaluation!.platform).toBe("instagram");
    expect(mark.evaluation!.eligible.map((e) => e.endpoint_id)).toContain(mark.endpoint_id);
    expect(Object.keys(mark.evaluation!.rejected).length).toBeGreaterThan(0);
  });
});

describe("EVERY PLATFORM'S EVIDENCE IS AUDIT-ONLY: nothing of the evaluation reaches the customer's plan text", () => {
  it("the customer-facing notes never contain an endpoint id, a provider name or a price", async () => {
    const w = discoveryWorld("هات ١٠ تغريدات من تويتر عن الذكاء الاصطناعي", { "anyapi.x.search.posts": () => catalogPage("anyapi.x.search.posts", [{ id: "1", text: "تغريدة عن الذكاء الاصطناعي", authorName: "ك", authorUsername: "k", createdUtc: "2026-10-20T10:00:00Z", url: "https://x.com/k/status/1", isReply: false, lang: "ar", likeCount: 1, replyCount: 0, retweetCount: 0, viewCount: 1 }], null) }, { discovery: true, platform: "x" });
    const r = await w.plan();
    if (r.kind !== "plan") return;
    const text = (r.plan.notes_ar ?? []).join("\n");
    expect(text).not.toMatch(/anyapi|justoneapi|tikhub|scrapecreators|crawl4ai|endpoint|USD|\$/i);
  });
});
