import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { RAW_PATH } from "../agent/src/gateway";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { parentInputs, relaxedInputsOf, SEARCH_STRATEGIES_MAX, topicQueryOf } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { topicTierOf } from "../src/lib/agentMission/foundation/pool";
import { extendedAlternativeTopicOf, topicAlternativesOf } from "../src/lib/agentMission/foundation/topicAlternatives";
import { searchScopeEndAr } from "../src/lib/agentMission/foundation/searchScope";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { agentChatTurn, NO_PLAN_YET_AR, noPlanEndedAr } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * P0, 15 NOV 2026: THE OVERLY LITERAL SEARCH AND THE FALSE «NO MATCH» (recorded production evidence, zero paid calls).
 * Three real missions (msn_84d0f3738c87d5ed3aee, msn_7758164aa2b4a840fda5, msn_47c4016d9099f63c2bb5) asked for up to 400 tweets of the Saudi Ministry of Health's account «عن الشائعات أو التصدي للشائعات أو جهود الوزارة في مكافحة
 * الشائعات» over the last five years; the customer gave @SaudiMOH. Each sent ONE exact quoted phrase with the literal word «أو» («"الشائعات أو التصدي للشائعات أو جهود الوزارة" from:SaudiMOH …»), got 0 rows, followed the empty page's cursor
 * (0 rows again), ended «بحثنا في المصادر المتاحة فلم نجد ما يطابق طلبك», showed «لقينا المصادر» as done, and the chat then said the details were in a plan that did not exist. 6 search calls (0.00294 USD) and 0.000679 USD of planning model,
 * no point charged.
 * ROOT CAUSE (proved below from the recorded calls): (1) overly literal search construction (the alternatives read as one phrase, «أو» included, the third alternative cut at «في»); (6) the second planning sample spent on the empty
 * page's cursor. NOT the cause: (2) syntax (`since:`/`until:` and grouped `OR` answered rows in production on this card; `from:` is the catalog's documented operator); (5) filtering after retrieval (0 raw rows came back, nothing was
 * filtered); (3)/(4) provider coverage or paging cannot be judged from an improbable phrase and are not assumed.
 */
const fx = JSON.parse(readFileSync(new URL("./fixtures/p0-x-account/production-2026-11-15.json", import.meta.url), "utf8")) as {
  query_as_sent: string; query_as_recorded_prefix: string; recorded_empty_page: unknown;
  missions: Record<string, { request_text: string; answer_text: string; created_at: string; summary_ar: string; calls: Array<{ cursor_sent: boolean; rows_returned: number }>; chat_question?: string; chat_reply?: string }>;
  syntax_evidence: { catalog_note: string; grouped_or_answered: Array<{ query: string; rows: number }> };
};
const IDS = ["msn_84d0f3738c87d5ed3aee", "msn_7758164aa2b4a840fda5", "msn_47c4016d9099f63c2bb5"] as const;
const catalog = loadTregCatalog();
const xSearch = cardOf("anyapi.x.search.posts")!;
const HANDLE = "SaudiMOH";
const askOf = (id: (typeof IDS)[number]) => buildAsk(fx.missions[id].request_text, fx.missions[id].answer_text, Date.parse(fx.missions[id].created_at));

const tweet = (id: string, username: string, text: string, at = "2025-03-10T10:00:00.000Z") => ({ id, text, authorName: `name_${username}`, authorUsername: username, createdUtc: at, url: `https://x.com/${username}/status/${id}`, isReply: false, lang: "ar", likeCount: 1, retweetCount: 0, replyCount: 0, quoteCount: 0, viewCount: 10 });
const pageOf = (items: unknown[], nextCursor: string | null = null) => ({ output: { data: { items, nextCursor } } });

/** The worker's compiled planning over scripted pages, one per call in order (the recorded empty page first by default). Every call's params are recorded; nothing leaves the test. */
async function plan(id: (typeof IDS)[number], pages: unknown[], extra: Record<string, unknown> = {}) {
  const m = fx.missions[id];
  const store = createMemoryStore();
  const calls: Array<Record<string, unknown>> = [];
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const n = calls.length + 1;
      calls.push((input.params ?? {}) as Record<string, unknown>);
      const page = pages[n - 1] ?? pageOf([]);
      const callId = `call_${String(n).padStart(4, "0")}`;
      await store.putFile("msn_t", RAW_PATH(callId), JSON.stringify(page), "application/json");
      const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!);
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: (page as { output?: { data?: { nextCursor?: string | null } } }).output?.data?.nextCursor ?? null };
    },
  };
  const r = await planByCompiler({ mission: { id: "msn_t", request_text: m.request_text, answer_text: m.answer_text, created_at: m.created_at } as never, gateway: gateway as never, store, catalog, nowMs: Date.parse(m.created_at), choices: { sourceId: HANDLE }, answerIsChoice: true, ...extra });
  return { r, calls, queries: calls.map((c) => String(c.query ?? "")) };
}

describe("ROOT CAUSE, proved from the recorded calls", () => {
  it("the three missions sent ONE quoted phrase with the literal «أو», the third alternative cut at «في», then the empty page's cursor: 0 raw rows each time (nothing was filtered after retrieval)", () => {
    expect(fx.query_as_sent.startsWith(fx.query_as_recorded_prefix)).toBe(true);
    for (const id of IDS) {
      expect(fx.missions[id].calls.map((c) => [c.cursor_sent, c.rows_returned])).toEqual([[false, 0], [true, 0]]);
      expect(fx.missions[id].summary_ar).toMatch(/بحثنا في المصادر المتاحة فلم نجد/);
    }
    // the provider's own rule: bare terms are ANDed; alternatives go with OR; and a grouped OR query of this card answered rows in production
    expect(fx.syntax_evidence.catalog_note).toMatch(/OR between alternatives/);
    expect(fx.syntax_evidence.grouped_or_answered[0]).toMatchObject({ rows: 20 });
    expect(fx.syntax_evidence.grouped_or_answered[0].query).toMatch(/\(.+ OR .+\)/);
  });
});

describe("A. alternative meanings are separate concepts, never one improbable phrase", () => {
  it("the request is read as three alternatives, the third with its words after «في»; no alternative contains «أو»", () => {
    expect(askOf("msn_84d0f3738c87d5ed3aee").topic.alternatives).toEqual(["الشائعات", "التصدي للشائعات", "جهود الوزارة في مكافحة الشائعات"]);
    expect(askOf("msn_47c4016d9099f63c2bb5").topic.alternatives).toEqual(["الشائعات", "التصدي للشائعات", "جهود الوزارة في مكافحتها"]);
    for (const id of IDS) for (const a of askOf(id).topic.alternatives ?? []) expect(a).not.toMatch(/(?:^|\s)(?:أو|او)(?:\s|$)/);
  });
  it("the X query is one OR group (the card's documented disjunction), the recorded phrase is never sent", () => {
    for (const id of IDS) {
      const q = String(parentInputs(xSearch, askOf(id)).query);
      expect(q).toMatch(/^\(الشائعات OR "التصدي للشائعات" OR "جهود الوزارة في (?:مكافحة الشائعات|مكافحتها)"\) from:SaudiMOH /);
      expect(q).not.toContain('"الشائعات أو');
    }
  });
  it("a place after «في» stays the country condition (no list, the language rule only); a topic with no «أو» is untouched", () => {
    expect(extendedAlternativeTopicOf("السياحة أو الفنادق", "عايز تغريدات عن السياحة أو الفنادق في مصر على إكس")).toBe("السياحة أو الفنادق");
    expect(topicAlternativesOf("السياحة أو الفنادق")).toEqual(["السياحة", "الفنادق"]);
    expect(topicAlternativesOf("الذكاء الاصطناعي")).toEqual([]);
    expect(topicAlternativesOf("كأس العالم ٢٠٢٢/٢٠٢٦")).toEqual([]);
    const single = buildAsk("عايز ١٠٠ تغريدة عن الذكاء الاصطناعي على إكس", null, Date.now());
    expect(single.topic.alternatives).toBeUndefined();
    expect(topicQueryOf(xSearch, single)).toBe('"الذكاء الاصطناعي"');
  });
  it("relevance: an item that names ANY alternative is about the topic, in the customer's other wording too; the word «أو» is never required", () => {
    const ask = askOf("msn_84d0f3738c87d5ed3aee");
    expect(topicTierOf("نحذر من تداول الشائعات الصحية", ask)).toBe(2);
    expect(topicTierOf("جهود الوزارة في مكافحة الشائعات مستمرة", ask)).toBe(2);
    expect(topicTierOf("التصدي للشائعات مسؤولية الجميع", ask)).toBe(2);
    expect(topicTierOf("حملة التطعيم الموسمية تبدأ اليوم", ask)).toBe(0);
  });
});

describe("B, D, G. bounded strategies, each keeping the account and the period", () => {
  it("D + G: the recorded empty first page is NOT followed by its cursor; the one remaining sample tries the account's own posts in the period; never more than two reads", async () => {
    for (const id of IDS) {
      const { calls, queries } = await plan(id, [fx.recorded_empty_page, pageOf([])]);
      expect(calls).toHaveLength(SEARCH_STRATEGIES_MAX);
      expect(calls.some((c) => "cursor" in c)).toBe(false);
      expect(queries[0]).toMatch(/^\(.+ OR .+\) from:SaudiMOH since:\S+ until:\S+ -filter:replies$/);
      expect(queries[1]).toMatch(/^from:SaudiMOH since:\S+ until:\S+ -filter:replies$/);
    }
  });
  it("B: every query of every strategy carries from:<the identifier> and the period; none searches all of X", () => {
    const ask = askOf("msn_84d0f3738c87d5ed3aee");
    const relaxed = relaxedInputsOf(xSearch, ask)!;
    expect(relaxed.strategy).toBe("source_items");
    for (const q of [String(parentInputs(xSearch, ask).query), String(relaxed.params.query)]) { expect(q).toContain("from:SaudiMOH"); expect(q).toMatch(/since:\S+ until:\S+/); }
    // with no source carried there is no relaxed read for alternatives: the request ends with its scope (never a broader search)
    const noSource = buildAsk("عايز تغريدات عن الشائعات أو التصدي للشائعات على إكس", null, Date.now());
    expect(relaxedInputsOf(xSearch, noSource)).toBeNull();
  });
  it("G: a single phrase of several words relaxes to its words once (same operators); a single word with no source has no relaxed strategy", () => {
    const phrase = buildAsk("عايز ٥٠ تغريدة عن الأمن السيبراني بالعربي على إكس", null, Date.now());
    const r = relaxedInputsOf(xSearch, phrase)!;
    expect(r.strategy).toBe("words");
    expect(String(r.params.query)).toBe(String(parentInputs(xSearch, phrase).query).replace('"الأمن السيبراني"', "الأمن السيبراني"));
    expect(relaxedInputsOf(xSearch, buildAsk("عايز ٥٠ تغريدة عن كورونا على إكس", null, Date.now()))).toBeNull();
  });
});

describe("C, E, F, J. what is planned is the source's own, real, dated, relevant rows", () => {
  it("C + J: one matching post of the account gives a truthful plan for ONE post, with the source, the topic, the period, the price and the shortfall said before approval", async () => {
    const { r } = await plan("msn_84d0f3738c87d5ed3aee", [pageOf([tweet("101", HANDLE, "جهود الوزارة في مكافحة الشائعات الصحية مستمرة"), tweet("102", HANDLE, "حملة التطعيم الموسمية تبدأ اليوم")])]);
    if (r.kind !== "plan") throw new Error(r.kind);
    expect((r.plan.stages[0].pinned_rows as Array<{ id: string }>).map((x) => x.id)).toEqual(["101"]);
    expect(r.plan.stages[0].planned_rows).toBe(1);
    const notes = r.plan.notes_ar!.join(" ");
    expect(notes).toMatch(/«@SaudiMOH» وحده/);
    expect(notes).toMatch(/بحثنا عن أيٍّ من: «الشائعات» أو «التصدي للشائعات» أو «جهود الوزارة في مكافحة الشائعات»/);
    const view = customerPlanView(r.plan) as unknown as Record<string, unknown>;
    expect(JSON.stringify(view)).not.toMatch(/anyapi|treg|USD|\$/i);
    expect(r.plan.price.maxChargePoints).toBeGreaterThan(0);
    expect(r.plan.price.deliveredRows).toBe(1);
  });
  it("D + C: the first query empty, the account's own posts in the period hold one about the topic: a plan for that one post (no cursor of the empty page read)", async () => {
    const { r, calls } = await plan("msn_7758164aa2b4a840fda5", [fx.recorded_empty_page, pageOf([tweet("201", HANDLE, "لا تصدقوا الشائعات واستقوا المعلومة من مصادرها"), tweet("202", HANDLE, "مواعيد العيادات في رمضان")])]);
    expect(calls).toHaveLength(2);
    if (r.kind !== "plan") throw new Error(r.kind);
    expect((r.plan.stages[0].pinned_rows as Array<{ id: string }>).map((x) => x.id)).toEqual(["201"]);
    // the customer reads how the items were found; a fresh read at execution keeps the topic words (never the account's unrelated posts)
    expect(r.plan.notes_ar!.join(" ")).toMatch(/البحث بالعبارات كما كتبتها لم يُرجع نتائج، فبحثنا في منشورات الحساب نفسه داخل الفترة/);
    expect(JSON.stringify(r.plan)).toContain("(الشائعات OR");
  });
  it("E: nothing is fabricated: every planned row is one the source returned, with its own link", async () => {
    const rows = [tweet("301", HANDLE, "التصدي للشائعات واجب"), tweet("302", HANDLE, "الشائعات الصحية خطر")];
    const { r } = await plan("msn_84d0f3738c87d5ed3aee", [pageOf(rows)]);
    if (r.kind !== "plan") throw new Error(r.kind);
    for (const p of r.plan.stages[0].pinned_rows as Array<{ id: string; link?: string }>) {
      const src = rows.find((x) => x.id === p.id)!;
      expect(src).toBeDefined();
      expect(p.link).toBe(src.url);
    }
  });
  it("F: a provider that ignores from: cannot put another account's rows in the plan (exact author check), nor a post outside the period, nor one about something else", async () => {
    const { r } = await plan("msn_84d0f3738c87d5ed3aee", [pageOf([
      tweet("401", "other_account", "الشائعات الصحية"),
      tweet("402", `${HANDLE}_fan`, "التصدي للشائعات"),
      tweet("403", HANDLE, "الشائعات الصحية", "2019-01-01T10:00:00.000Z"),
      tweet("404", HANDLE, "حملة التطعيم الموسمية"),
      tweet("405", HANDLE, "مكافحة الشائعات مسؤولية الجميع، وجهود الوزارة في مكافحة الشائعات مستمرة"),
    ])]);
    if (r.kind !== "plan") throw new Error(r.kind);
    expect((r.plan.stages[0].pinned_rows as Array<{ id: string }>).map((x) => x.id)).toEqual(["405"]);
  });
  it("dedup across strategies: the same tweet answered twice counts once", async () => {
    const t = tweet("501", HANDLE, "الشائعات الصحية");
    const ask = askOf("msn_84d0f3738c87d5ed3aee");
    const { searchScopeOf } = await import("../src/lib/agentMission/foundation/searchScope");
    const scope = searchScopeOf(ask, xSearch, [{ page: pageOf([t]) }, { page: pageOf([t]) }], [{ strategy: "exact", rows: 1 }, { strategy: "source_items", rows: 1 }]);
    expect(scope).toMatchObject({ read: 1, bySource: 1, inPeriod: 1, about: 1 });
  });
});

describe("H. a genuinely empty search ends truthfully, with the tested scope and no charge", () => {
  it("both strategies empty: no plan, the scope and the counts are said, never «nothing exists», no Latin identifier, no provider, nothing charged", async () => {
    const { r, calls } = await plan("msn_84d0f3738c87d5ed3aee", [fx.recorded_empty_page, pageOf([])]);
    expect(calls).toHaveLength(2);
    if (r.kind !== "cannot") throw new Error(r.kind);
    expect(r.reason).toBe("no_rows");
    const s = searchScopeEndAr(r.scope!);
    expect(r.scope).toMatchObject({ read: 0, strategies: [{ strategy: "exact", rows: 0 }, { strategy: "source_items", rows: 0 }] });
    expect(s).toMatch(/داخل الحساب الذي حدّدته على إكس/);
    expect(s).toMatch(/في الفترة من ٢٠٢١-١١-١٥ إلى ٢٠٢٦-١١-١٥/);
    expect(s).toMatch(/عن أيٍّ من: «الشائعات» أو «التصدي للشائعات»/);
    expect(s).toMatch(/جرّبنا طريقتين للبحث/);
    expect(s).toMatch(/عدد ما أرجعه البحث: ٠/);
    expect(s).toMatch(/لا يثبت أن الحساب لم ينشر عن الموضوع/);
    expect(s).toMatch(/لم يُخصم منك شيء/);
    expect(s).not.toMatch(/[A-Za-z$]/);
    expect(s).not.toMatch(/المصادر المتاحة فلم نجد/);
  });
  it("rows of the account in the period but none about the topic: the customer is ASKED before anything is priced (never chosen silently)", async () => {
    const { r } = await plan("msn_84d0f3738c87d5ed3aee", [fx.recorded_empty_page, pageOf([tweet("601", HANDLE, "حملة التطعيم الموسمية"), tweet("602", HANDLE, "مواعيد العيادات")])]);
    expect(r.kind).toBe("question");
    if (r.kind === "question") expect(r.why).toBe("no_about");
  });
});

describe("I. the customer's progress steps reflect the real states", () => {
  const ended = { id: "msn_x", status: "unserved", question_ar: null, plan_public: null, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: "…", files: null, created_at: new Date().toISOString() };
  it("a request that ended with no plan never shows «لقينا المصادر» or the sample as done, even after planning calls", () => {
    const v = customerMissionView({ mission: ended as never, events: [], callsMade: 2, now: Date.now() }) as unknown as { steps: Array<{ titleAr: string; state: string }> };
    const found = v.steps.find((s) => s.titleAr === "لقينا المصادر")!;
    expect(found.state).not.toBe("done");
    expect(v.steps.filter((s) => s.state === "done").map((s) => s.titleAr)).toEqual(["فهمنا طلبك"]);
  });
});

describe("the chat never points to a plan that does not exist", () => {
  const USER = "8a2f1c3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); })); vi.spyOn(console, "info").mockImplementation(() => undefined); });
  afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  async function ask(status: string, reply: string, summary = "بحثنا داخل الحساب الذي حدّدته على إكس …") {
    setChatModelForTesting(async () => ({ ok: true, text: JSON.stringify({ type: "other", reason: "scripted", reply, count: null }), usage: { inputTokens: 1, outputTokens: 1 } }));
    const db: any = createMemoryDb();
    db.seed("conversations", [{ id: "c1", user_id: USER, title: "t", status: "active" }]);
    db.seed("credit_ledger", [{ user_id: USER, delta: 100 }]);
    db.seed("missions", [{ id: "msn_e1e1e1e1e1e1e1e1e1e1", user_id: USER, conversation_id: "c1", status, request_text: "…", summary_ar: summary, plan: null, created_at: "2026-11-15T06:38:50Z" }]);
    db.seed("mission_events", []);
    db.seed("messages", [
      { id: "u0", conversation_id: "c1", user_id: USER, role: "user", content_ar: "طلب", created_at: "2026-11-15T06:38:43Z" },
      { id: "a0", conversation_id: "c1", user_id: USER, role: "assistant", content_ar: "بدأ الوكيل دراسة طلبك", plan: { agentMissionId: "msn_e1e1e1e1e1e1e1e1e1e1" }, created_at: "2026-11-15T06:38:44Z" },
      { id: "u1", conversation_id: "c1", user_id: USER, role: "user", content_ar: fx.missions.msn_84d0f3738c87d5ed3aee.chat_question, request_status: "planning", created_at: "2026-11-15T06:42:16Z" },
      { id: "a1", conversation_id: "c1", user_id: USER, role: "assistant", content_ar: "…", created_at: "2026-11-15T06:42:16.5Z" },
    ]);
    const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "c1", userMsgId: "u1", assistantMsgId: "a1", message: fx.missions.msn_84d0f3738c87d5ed3aee.chat_question!, conversationTitle: "t" });
    return r.contentAr;
  }
  it("the recorded reply («… مكتوبة في خطة الطلب المعروضة أمامك») after an ended request with no plan is replaced by the facts: no plan, nothing charged, what was searched", async () => {
    const summary = "بحثنا داخل الحساب الذي حدّدته على إكس عن أيٍّ من: «الشائعات». عدد ما أرجعه البحث: ٠.";
    expect(await ask("unserved", fx.missions.msn_84d0f3738c87d5ed3aee.chat_reply!, summary)).toBe(noPlanEndedAr(summary));
  });
  it("while planning: no plan yet is said; a reply that does not speak of a plan is kept", async () => {
    expect(await ask("planning", "التفاصيل في خطة الطلب.")).toBe(NO_PLAN_YET_AR);
    expect(await ask("unserved", "بحثنا داخل الحساب نفسه فقط.")).toBe("بحثنا داخل الحساب نفسه فقط.");
  });
});

describe("K, L. no regression to ordinary searches and the other platforms", () => {
  it("K: an ordinary single-topic X search sends exactly the query it sent before", () => {
    const ask = buildAsk("عايز ١٠٠ تغريدة عن الذكاء الاصطناعي على إكس", null, Date.now());
    expect(String(parentInputs(xSearch, ask).query)).toBe('"الذكاء الاصطناعي" -filter:replies');
  });
  it("K: a single-topic X search whose first page HAS rows still reads its next page by the cursor (two samples, as before)", async () => {
    const store = createMemoryStore();
    const calls: Array<Record<string, unknown>> = [];
    const page1 = pageOf([tweet("1", "a", "الذكاء الاصطناعي اليوم")], "cur_next");
    const gateway = { async tregCall(input: { endpoint_id?: unknown; params?: unknown }) { calls.push((input.params ?? {}) as Record<string, unknown>); const n = calls.length; const page = n === 1 ? page1 : pageOf([tweet("2", "b", "الذكاء الاصطناعي غدًا")]); const id = `call_${String(n).padStart(4, "0")}`; await store.putFile("msn_t", RAW_PATH(id), JSON.stringify(page), "application/json"); const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!); return { ok: true as const, call_id: id, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: n === 1 ? "cur_next" : null }; } };
    await planByCompiler({ mission: { id: "msn_t", request_text: "عايز ١٠ تغريدات عن الذكاء الاصطناعي على إكس", answer_text: null, created_at: "2026-11-15T06:00:00Z" } as never, gateway: gateway as never, store, catalog, nowMs: Date.parse("2026-11-15T06:00:00Z") });
    expect(calls).toHaveLength(2);
    expect(calls[1].cursor).toBe("cur_next");
    expect(calls[1].query).toBe(calls[0].query);
  });
  it("L: a card with no documented disjunction never gets the sentence with «أو»: it searches the first alternative and every row is matched against all of them", () => {
    const fb = cardOf("apify.facebook.search.posts") ?? null;
    const card = fb ?? { ...xSearch, inputs: { ...xSearch.inputs, query: { field: "query", quoted: true } } };
    const ask = buildAsk("عايز ٣٠ منشور فيسبوك عن الشائعات أو التصدي للشائعات", null, Date.now());
    const q = topicQueryOf(card as never, ask);
    expect(q).not.toMatch(/أو/);
    expect(q.replace(/"/g, "")).toBe("الشائعات");
  });
});

describe("H (worker). the whole planning run on the recorded pages, production settings: truthful end, nothing held or charged, nothing pointing to a plan", () => {
  it("msn_84d0's request and answer, both searches empty: unserved with the tested scope, 0 points held or charged, the two reads the only provider calls", async () => {
    const { runPlanning } = await import("../agent/src/runMission");
    const { newMission } = await import("../agent/src/memoryStore");
    const { updateRunState } = await import("../agent/src/runState");
    const { createFakeDriver } = await import("../agent/src/fakeDriver");
    const { fakeMoneyClient } = await import("./helpers/agentMoney");
    const { fakeRecorder, NOT_ADMIN, USER_ID, tregResult } = await import("./helpers/agentHarness");
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const m = fx.missions.msn_84d0f3738c87d5ed3aee;
    const store = createMemoryStore();
    Object.assign(store.settings, { redesign_flags: { x: "on", tiktok: "on", youtube: "on", facebook: "on", instagram: "on" }, chat_research_brief_v1: true, capability_discovery_v1: true, semantic_normalization_v1: true });
    const money = fakeMoneyClient();
    const sent: Array<Record<string, unknown>> = [];
    const call = vi.fn(async (o: { body?: unknown; params?: unknown }) => { sent.push(((o as { body?: Record<string, unknown> }).body ?? (o as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>); return tregResult(fx.recorded_empty_page, 0.00049); });
    const rec = fakeRecorder();
    store.missions.set("msn_p0aaaaaaaaaaaaaaaa", newMission({ id: "msn_p0aaaaaaaaaaaaaaaa", user_id: USER_ID, status: "planning", request_text: m.request_text, answer_text: m.answer_text }));
    await updateRunState(store, "msn_p0aaaaaaaaaaaaaaaa", (r) => ({ ...r, pending: "source_id" }));
    await runPlanning({ store, client: money.client, catalog, driver: createFakeDriver([]), recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined } as never, store.missions.get("msn_p0aaaaaaaaaaaaaaaa")!);
    const done = store.missions.get("msn_p0aaaaaaaaaaaaaaaa")!;
    expect(done.status).toBe("unserved");
    expect(done.summary_ar).toMatch(/داخل الحساب الذي حدّدته على إكس/);
    expect(done.summary_ar).toMatch(/جرّبنا طريقتين للبحث/);
    expect(done.summary_ar).toMatch(/لا يثبت أن الحساب لم ينشر/);
    expect(done.summary_ar).not.toMatch(/المصادر المتاحة فلم نجد|خطة الطلب المعروضة/);
    expect(call).toHaveBeenCalledTimes(2);
    const queries = sent.map((b) => String(b.query ?? ""));
    expect(queries.every((q) => q.includes("from:SaudiMOH"))).toBe(true);
    expect(sent.some((b) => "cursor" in b)).toBe(false);
    expect(money.balance()).toBe(fakeMoneyClient().balance());
    expect(done.reserved_points ?? 0).toBe(0);
    expect(done.charged_points ?? 0).toBe(0);
  });
});
