import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, compiledPlatformActive, type CompiledPlanning } from "../agent/src/compiled";
import { chooseCard, compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { NAMED_SHORTFALL_OPTIONS_AR, namedShortfallChoiceOf, NAMED_MISMATCH_MARK_AR } from "../src/lib/agentMission/foundation/namedShortfall";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { replayGateway, type ReplayStore } from "./helpers/replayGateway";

/**
 * FOUNDATION-PLAN PR 3, FACEBOOK ON THE FOUNDATION (acceptance 1): M17 `msn_6bb78c15d116268b0b9b` and M19 `msn_96beb9f7a1d937a90cd0` (the same request text) are planned by the
 * compiler from the stored real pages. The page names of the anonymised pages are placeholders, so the tests name the page's own author id (the id the stored page listing returned,
 * `100069103503573`, 2 of the 10 pool rows) «قناة العربية» and, in one test, give one of its posts a made-up caption about the topic (the README's precedent: a test that needs a caption
 * builds it on the real structure). Every number asserted below is counted from the stored pages.
 */
const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const request = (id: string): string => fixture.missions.find((m) => m.id === id)!.request;
const M17 = "msn_6bb78c15d116268b0b9b";
const M19 = "msn_96beb9f7a1d937a90cd0";
const FBS = "justoneapi.x.facebook-search-post-v1";
const PAGE_ID = "100069103503573";
const TOPIC_POST_CAPTION = "الذكاء الاصطناعي يدخل غرف الأخبار";

interface Opts { captionOnPageRowWithComments?: boolean }
/** The stored pages with what the anonymiser replaced put back for the test: the page's author name and, optionally, one caption. */
const patched = (base: ReplayStore, opts: Opts = {}): ReplayStore => ({
  putFile: async (m, p, body, ct) => {
    try {
      const d = JSON.parse(body) as { data?: { results?: Array<{ author: { id: string; name: string }; comments_count: number; message?: string }> } };
      if (Array.isArray(d.data?.results)) {
        for (const r of d.data!.results!) {
          if (r.author.id === PAGE_ID) { r.author.name = "قناة العربية"; if (opts.captionOnPageRowWithComments && r.comments_count > 0) r.message = TOPIC_POST_CAPTION; }
        }
        return base.putFile(m, p, JSON.stringify(d), ct);
      }
    } catch { /* not a search page */ }
    return base.putFile(m, p, body, ct);
  },
});
const SECOND_PAGE = [{ endpointId: FBS, fromMission: M17, call: "call_0005", when: (p: Record<string, unknown>) => p.cursor !== undefined }];

async function plan(over: { mission?: string; answer?: string | null; created?: string; opts?: Opts; edits?: { count?: number }; catalogOnly?: boolean } = {}) {
  const store = createMemoryStore();
  const target = "msn_replay_fb";
  const { gateway, stats } = replayGateway(M17, catalog, patched(store, over.opts), target, { borrow: SECOND_PAGE });
  const out = await planByCompiler({
    mission: { id: target, request_text: request(over.mission ?? M17), answer_text: over.answer ?? null, created_at: over.created ?? "2026-11-02T17:36:00Z" },
    gateway, store, catalog, nowMs: Date.parse("2026-11-02T17:37:00Z"), ...(over.edits ? { edits: over.edits } : {}), ...(over.catalogOnly ? { catalogOnly: true } : {}),
  });
  return { out, stats };
}
const planOf = (out: CompiledPlanning) => { if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}`); return out; };

describe("acceptance 1: M17 and M19 choose the keyword search with the two Cairo days over the page listing", () => {
  it("the Ask reads the period as the Cairo days of the request (2026-08-02 to 2026-11-02), the named page, the topic and 2 posts", () => {
    for (const id of [M17, M19]) {
      const ask = buildAsk(request(id), null, Date.parse("2026-11-02T17:36:00Z"));
      expect([ask.platform, ask.count, ask.source, ask.topic.text, ask.period?.from, ask.period?.to]).toEqual(["facebook", 2, { kind: "named", text: "العربية" }, "الذكاء الاصطناعي", "2026-08-02", "2026-11-02"]);
    }
  });

  it("chooseCard picks the keyword search (it carries the topic and the period); the page listing is not even eligible for a named page given by its Arabic name", () => {
    const ask = buildAsk(request(M17), null, Date.parse("2026-11-02T17:36:00Z"));
    expect(chooseCard(ask, "parents")!.endpointId).toBe(FBS);
    expect(chooseCard(ask, "parents", { catalogOnly: true })!.endpointId).toBe(FBS);
    // the first call's inputs, by code: the topic AND the page's name (the model's own first stored call used exactly these words), the two days, no cursor
    expect(parentInputs(cardOf(FBS)!, ask)).toEqual({ keyword: "الذكاء الاصطناعي العربية", startDate: "2026-08-02", endDate: "2026-11-02" });
  });

  it("a page given by its link, with no topic and no period, is the one case that reads the listing (it is the only card that can carry the page)", () => {
    const ask = buildAsk("هات منشورين من صفحة https://www.facebook.com/AlArabiya على فيسبوك، مع كل التعليقات.", null, Date.parse("2026-11-02T17:36:00Z"));
    expect(ask.topic.text).toBeNull();
    expect(ask.period).toBeNull();
    expect(chooseCard(ask, "parents")!.endpointId).toBe("anyapi.facebook.user.posts");
    expect(parentInputs(chooseCard(ask, "parents")!, ask)).toEqual({ url: "https://www.facebook.com/AlArabiya" });
  });

  it("a page given by its link WITH a topic: the keyword search still wins (it carries the topic; the listing carries neither a topic nor a period), and the page's name from the link joins the keyword", () => {
    const ask = buildAsk("هات ٣ منشورات عن الذكاء الاصطناعي من صفحة https://www.facebook.com/AlArabiya على فيسبوك، مع كل التعليقات.", null, Date.parse("2026-11-02T17:36:00Z"));
    expect([ask.topic.text, ask.source.kind, ask.period]).toEqual(["الذكاء الاصطناعي", "named", null]);
    const card = chooseCard(ask, "parents")!;
    expect(card.endpointId).toBe(FBS);
    expect(parentInputs(card, ask)).toEqual({ keyword: "الذكاء الاصطناعي AlArabiya" });
  });

  it("the compiled run reads the search twice (page 1, then the next page by the cursor), never the listing, and records the 10 pool posts", async () => {
    const { out, stats } = await plan({ answer: NAMED_SHORTFALL_OPTIONS_AR.fill });
    const p = planOf(out);
    expect(p.reads.pool).toBe(2);
    expect(stats.served.map((s) => [s.endpointId, s.storedCall])).toEqual([[FBS, "call_0004"], [FBS, "call_0005"]]);
    expect(stats.served[0].params).toEqual({ keyword: "الذكاء الاصطناعي العربية", startDate: "2026-08-02", endDate: "2026-11-02" });
    expect(typeof stats.served[1].params.cursor).toBe("string");
    expect(stats.served.some((s) => s.endpointId === "anyapi.facebook.user.posts")).toBe(false);
    expect(p.plan.stages[0].endpoint_id).toBe(FBS);
    expect(p.plan.stages.map((s) => s.key)).toEqual(["posts", "comments", "comments_replies"]); // CHANGED (round 14): the replies card is verified, so every account's plan has the replies step
    expect(p.plan.compiled?.by).toBe("compiler");
  });

  it("the card says, from the stored pages' numbers, how many pool posts are from the page and about the topic, and has no line «لا يسمح بتحديد الفترة الزمنية»", async () => {
    const { out } = await plan({ answer: NAMED_SHORTFALL_OPTIONS_AR.fill, opts: { captionOnPageRowWithComments: true } });
    const p = planOf(out);
    const notes = (p.plan.notes_ar ?? []).join("\n");
    // 10 posts read in 2 pages, the source had more; 2 are from the page (its author id), 1 of the whole pool is about the topic and it is one of the page's
    expect(notes).toContain("قرأنا ١٠ منشورات من نتائج البحث في صفحتين، وفي المصدر المزيد");
    expect(notes).toContain("منها من صفحة «العربية»: ٢");
    expect(notes).toContain("منها يتحدث نصه عن «الذكاء الاصطناعي»: ١");
    expect(notes).toContain("منها من الصفحة ويتحدث نصه عن الموضوع: ١");
    for (const line of [p.plan.summary_ar, ...(p.plan.notes_ar ?? [])]) {
      expect(line).not.toMatch(/لا يسمح بتحديد الفترة/);
      expect(checkCustomerText(line, { maxChars: 400 }).issues, line).toEqual([]);
      expect(line).not.toMatch(/[0-9]/);
    }
    // the period reached the provider: the stage's own recorded inputs
    expect(p.plan.stages[0].engine?.params).toEqual({ keyword: "الذكاء الاصطناعي العربية", startDate: "2026-08-02", endDate: "2026-11-02" });
    expect(p.plan.stages[0].engine?.gaps ?? []).toEqual([]);
  });

  it("the same request text of M19 gives the same plan on the same pages", async () => {
    const a = planOf((await plan({ answer: NAMED_SHORTFALL_OPTIONS_AR.fill })).out);
    const b = planOf((await plan({ mission: M19, created: "2026-11-02T18:56:00Z", answer: NAMED_SHORTFALL_OPTIONS_AR.fill })).out);
    expect(b.plan.stages.map((s) => s.endpoint_id)).toEqual(a.plan.stages.map((s) => s.endpoint_id));
    expect(b.result.chosen).toEqual(a.result.chosen);
    expect(b.plan.stages[0].engine?.params).toEqual(a.plan.stages[0].engine?.params);
  });
});

describe("decision 7.5: the named page has fewer posts than asked, so the customer decides before approval", () => {
  it("M17: the page has 2 pool posts, one with comments (the other has none, and a comments request cannot use it): a question card with the three answers, nothing priced", async () => {
    // CHANGED (live round 10): what is counted is the page's posts that are also ABOUT the topic, so the one post the test deliverable needs a caption about it (the same patch the card test below uses)
    const { out } = await plan({ opts: { captionOnPageRowWithComments: true } });
    expect(out.kind).toBe("question");
    if (out.kind !== "question") return;
    expect(out.options).toEqual([NAMED_SHORTFALL_OPTIONS_AR.onlyFound, NAMED_SHORTFALL_OPTIONS_AR.fill, NAMED_SHORTFALL_OPTIONS_AR.cancel]);
    expect(out.question).toContain("«العربية»");
    expect(out.question).toMatch(/١ منشور/);
    expect(out.question).toMatch(/٢ منشور/);
    expect(checkCustomerText(out.question, { maxChars: 500 }).issues).toEqual([]);
    expect(out.question).not.toMatch(/[0-9]/);
  });

  it("the answers are read by their exact words, and the default (the first) is the ones found", () => {
    expect(namedShortfallChoiceOf(NAMED_SHORTFALL_OPTIONS_AR.onlyFound)).toBe("only_found");
    expect(namedShortfallChoiceOf(NAMED_SHORTFALL_OPTIONS_AR.fill)).toBe("fill");
    expect(namedShortfallChoiceOf(NAMED_SHORTFALL_OPTIONS_AR.cancel)).toBe("cancel");
    expect(namedShortfallChoiceOf("أي كلام آخر")).toBeNull();
    expect(namedShortfallChoiceOf(null)).toBeNull();
    expect(NAMED_MISMATCH_MARK_AR).toBe("المصدر المسمّى: غير مطابق");
  });

  it("«only the ones found»: the plan has only the page's posts that can be delivered (1), no other page's post, and says so", async () => {
    const p = planOf((await plan({ answer: NAMED_SHORTFALL_OPTIONS_AR.onlyFound, opts: { captionOnPageRowWithComments: true } })).out);
    expect(p.result.chosen).toHaveLength(1);
    const posts = p.plan.stages[0];
    expect(posts.pinned_rows).toHaveLength(1);
    expect((posts.pinned_rows![0] as Record<string, unknown>).author_id).toBe(PAGE_ID);
    expect((p.plan.notes_ar ?? []).join("\n")).toContain("وجدنا في ما قرأناه ١ فقط تناسب طلبك من ٢");
    expect(JSON.stringify(posts.columns)).not.toContain(NAMED_MISMATCH_MARK_AR);
  });

  it("«fill from other pages»: the plan has 2 posts, the page's first, and every post that is not the page's carries the mark «المصدر المسمّى: غير مطابق» (a mark, never a drop)", async () => {
    const p = planOf((await plan({ answer: NAMED_SHORTFALL_OPTIONS_AR.fill })).out);
    expect(p.result.chosen).toHaveLength(2);
    const posts = p.plan.stages[0].pinned_rows as Array<Record<string, unknown>>;
    expect(posts[0].author_id).toBe(PAGE_ID);
    expect(posts[0].named_source).toBe("");
    expect(posts[1].author_id).not.toBe(PAGE_ID);
    expect(posts[1].named_source).toBe(NAMED_MISMATCH_MARK_AR);
    expect(p.plan.stages[0].columns.map((c) => c.key)).toContain("named_source");
  });

  it("«cancel»: the run ends before any plan (agent/src/runMission.ts reads the same answer)", () => {
    expect(namedShortfallChoiceOf(NAMED_SHORTFALL_OPTIONS_AR.cancel)).toBe("cancel");
  });

  it("when the page has enough posts the question is never asked: 1 post asked, the page's one post with comments", async () => {
    const { out } = await plan({ edits: { count: 1 }, opts: { captionOnPageRowWithComments: true } });
    const p = planOf(out);
    expect(p.result.chosen).toHaveLength(1);
    expect(p.plan.stages[0].pinned_rows).toHaveLength(1);
  });
});

describe("the exposure check on the real empty comments page (decision 7.3)", () => {
  const page = (mission: string, call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));
  it("raw/call_0007.json is a successful empty answer (success true, comments [], no next page): the post is replaced by the next spare, and the plan's comments stage pins the others", () => {
    const empty = page(M17, "call_0007") as { success: boolean; comments: unknown[]; has_next_page: boolean };
    expect([empty.success, empty.comments, empty.has_next_page]).toEqual([true, [], false]);
    const ask = buildAsk(request(M17), NAMED_SHORTFALL_OPTIONS_AR.fill, Date.parse("2026-11-02T17:36:00Z"));
    const card = cardOf(FBS)!;
    const pages = ["call_0004", "call_0005"].map((c) => ({ callId: c, page: page(M17, c) }));
    const base = { ask, pool: { card, params: parentInputs(card, ask), pages }, capabilityOf: () => null, namedChoice: "fill" as const };
    // first without any exposure answers: the two chosen are the ones the pool ranks first
    const first = compilePlan({ ...base, exposure: () => ({ callId: null, page: null, failed: true }) });
    if (!first.ok) throw new Error(first.reason);
    const swapped = first.chosen[0];
    // the real empty answer for the first chosen post: it is replaced; the real 4-comments page (call_0009) keeps the next
    const second = compilePlan({ ...base, exposure: (id) => (id === swapped ? { callId: "call_0007", page: empty, failed: false } : { callId: "call_0009", page: page(M17, "call_0009"), failed: false }) });
    if (!second.ok) throw new Error(second.reason);
    expect(second.chosen).not.toContain(swapped);
    expect(second.chosen).toHaveLength(2);
    expect(second.plan.stages.find((s) => s.key === "comments")?.parent_pins).toEqual(second.chosen);
    expect(second.spares.length).toBeGreaterThan(0);
  });
});

describe("the comments and replies stages of a Facebook plan", () => {
  it("every account: the comments stage is the verified comments card, the promise is the sum of the chosen posts' counters, and the replies step is there (the replies card is verified, round 14)", async () => {
    const p = planOf((await plan({ answer: NAMED_SHORTFALL_OPTIONS_AR.fill })).out);
    const comments = p.plan.stages.find((s) => s.key === "comments")!;
    expect(comments.endpoint_id).toBe("scrapecreators.x.v1-facebook-post-comments");
    expect(comments.engine?.parent_binding).toEqual({ param: "url", from: "link" });
    expect(p.result.promises.comments.type).toBe("counter");
    // CHANGED (round 14): the replies card is verified on the real pages of live round 12, so the replies step is in every account's plan
    expect(p.plan.unserved_steps).toBeUndefined();
    expect(p.plan.stages.some((s) => s.replies_of !== undefined)).toBe(true);
  });

  it("a test account (decision 7.4): the replies stage is built by the catalog_only card, bound to each comment's two tokens, inside the 0.20 USD cap, and its promise is open", async () => {
    const p = planOf((await plan({ answer: NAMED_SHORTFALL_OPTIONS_AR.fill, catalogOnly: true })).out);
    const replies = p.plan.stages.find((s) => s.replies_of !== undefined)!;
    expect(replies.endpoint_id).toBe("anyapi.facebook.comment_replies");
    expect(replies.engine?.parent_binding).toMatchObject({ param: "feedbackId", from: "feedback_id", also: [{ param: "expansionToken", from: "expansion_token" }] });
    // CHANGED (round 14): the replies card is verified, so it takes no share of the 0.20 USD cap of the catalog-only tools
    expect(replies.max_pages).toBeUndefined();
    expect(p.result.promises.comments_replies.type).toBe("open");
    expect(p.plan.unserved_steps).toBeUndefined();
  });

  it("only a test account may read the second keyword search, and only once (0.06606 USD of the 0.20)", async () => {
    const store = createMemoryStore();
    const { gateway, stats } = replayGateway(M17, catalog, patched(store), "msn_replay_fb2", { borrow: SECOND_PAGE });
    await planByCompiler({ mission: { id: "msn_replay_fb2", request_text: request(M17), answer_text: NAMED_SHORTFALL_OPTIONS_AR.fill, created_at: "2026-11-02T17:36:00Z" }, gateway, store, catalog, nowMs: Date.now(), catalogOnly: true });
    const second = stats.unserved.filter((u) => u.endpointId === "anyapi.facebook.search_posts");
    expect(second).toHaveLength(1);
    expect(second[0].params).toMatchObject({ query: "الذكاء الاصطناعي العربية", startDate: "2026-08-02", endDate: "2026-11-02", limit: 20 });
    // a customer's account never reads it
    const store2 = createMemoryStore();
    const r2 = replayGateway(M17, catalog, patched(store2), "msn_replay_fb3", { borrow: SECOND_PAGE });
    await planByCompiler({ mission: { id: "msn_replay_fb3", request_text: request(M17), answer_text: NAMED_SHORTFALL_OPTIONS_AR.fill, created_at: "2026-11-02T17:36:00Z" }, gateway: r2.gateway, store: store2, catalog, nowMs: Date.now() });
    expect(r2.stats.unserved.some((u) => u.endpointId === "anyapi.facebook.search_posts")).toBe(false);
  });
});

describe("the flag", () => {
  it("Facebook is compiled only behind its OWN flag (`on`, or `test` for a test account)", () => {
    expect(compiledPlatformActive({ facebook: "test" }, "facebook", true)).toBe(true);
    expect(compiledPlatformActive({ facebook: "test" }, "facebook", false)).toBe(false);
    expect(compiledPlatformActive({ facebook: "on" }, "facebook", false)).toBe(true);
    expect(compiledPlatformActive({}, "facebook", true)).toBe(false);
    expect(compiledPlatformActive({ instagram: "on", youtube: "on", tiktok: "on", x: "on" }, "facebook", true)).toBe(false);
  });
});
