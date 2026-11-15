import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { RAW_PATH } from "../agent/src/gateway";
import { ingestRows } from "../agent/src/items/ingest";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { emptyReviewState } from "../agent/src/review";
import { REASON_TEXT_AR, shortfallClauseAr, zeroDeliveryReasonAr } from "../agent/src/finalize";
import { JUDGED_DRY_PAGES } from "../agent/src/engine/run";
const REASON_STOP_AR = (r: string): string => shortfallClauseAr(r as never, { pending: 0, stop: null });
import { deliveredMissionsReader, loadApprovedPriorDelivery, priorDeliveryCardReader, priorDeliveryForPlanning, withPriorDelivery } from "../agent/src/priorDelivery";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import {
  PRIOR_DELIVERY_PATH, PRIOR_DELIVERY_REASON, canonicalLinkOf, planPriorDeliveryOf, deliveryKeysOf, parsePriorDeliverySnapshot, priorDeliveryLineAr, priorDeliveryMatcherOf, priorDeliverySnapshotOf,
} from "../src/lib/agentMission/priorDelivery";
import { EXISTING_REMOVAL_REASONS, isAllowedRemovalRaw } from "../src/lib/agentMission/rawDelivery";
import { parseBrief, storedBriefOf } from "../src/lib/agentMission/researchBrief";
import { briefPromptLines } from "../src/lib/agentMission/conversationModel";
import { agentChatTurn } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import type { MissionRecord } from "../agent/src/types";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * P0, 15 NOV 2026: «WITHOUT REPEATING WHAT WAS DELIVERED» IS ENFORCED (msn_8824508f840f703dee69, conversation b7abe45b18874b4b9d53; offline, zero paid calls).
 *
 * The customer: «هل ممكن تتوسع اكتر في استخراج التغريدات من دون تكرار بواقع 400 تغريدة», after msn_dd7c2e9c131b8783bf2e delivered 79 tweets. Before this change nothing in the system could honour «من دون تكرار»: no mission knew what
 * an earlier one delivered (the customer-exclusion switch `customer_exclusion_files_v1` checks COMPANIES against an uploaded spreadsheet; it cannot recognise a tweet). Now the model's reading (`exclude_delivered`) reaches the card,
 * the worker pins the identities of everything the conversation's earlier missions delivered, a planning sample never chooses one, and execution never delivers or charges one.
 */
const fx = JSON.parse(readFileSync(new URL("./fixtures/p0-x-account/production-2026-11-15-cd5f.json", import.meta.url), "utf8")) as { request_text: string; created_at: string; source_answer: string; page_1_items: Array<Record<string, unknown>> };
const catalog = loadTregCatalog();
const nowMs = Date.parse(fx.created_at);
const pageOf = (items: unknown[], nextCursor: string | null = null) => ({ output: { data: { items, nextCursor } } });
/** SYNTHETIC posts of the account about countering rumors (never production). */
const post = (id: string, text: string, at = "2024-05-02T09:00:00.000Z") => ({ id, text, authorName: "وزارة الصحة السعودية", authorUsername: "SaudiMOH", authorFollowers: 1, createdUtc: at, url: `https://x.com/i/web/status/${id}`, isReply: false, lang: "ar", likeCount: 1, replyCount: 0, retweetCount: 0, viewCount: 1 });
const EARLIER = [post("9100000000000000001", "تحذر وزارة الصحة من تداول الشائعات حول اللقاحات."), post("9100000000000000002", "لا صحة لما يتم تداوله عن فيروس جديد؛ نرجو عدم الالتفات للإشاعات.")];
const NEW = [post("9100000000000000003", "الوزارة تنفي ما يتم تداوله من شائعات عن نقص الأدوية."), post("9100000000000000004", "احذروا الشائعات الصحية واستقوا المعلومة من مصادرها الرسمية.")];
const ABOUT = new Set([...EARLIER, ...NEW].map((p) => p.id));
const judge = async ({ rows }: { rows: ReadonlyArray<{ id: string; text: string }> }) => ({ verdicts: new Map(rows.map((r) => [r.id, ABOUT.has(r.id)])), costUsd: 0.0004 });
const reviewer = () => { const asked: string[] = []; return { asked, budgetUsd: 1, state: async () => emptyReviewState(), review: async ({ rows }: { rows: Array<{ id: string }> }) => { asked.push(...rows.map((r) => r.id)); return new Map(rows.map((r) => [r.id, ABOUT.has(r.id)])); } }; };
/** What the earlier mission delivered, as its file's rows (the item store keeps the mapped row: id and link). */
const EARLIER_SNAPSHOT = priorDeliverySnapshotOf([{ id: "msn_dd7c2e9c131b8783bf2e", rows: EARLIER.map((p) => ({ id: p.id, link: `https://twitter.com/SaudiMOH/status/${p.id}?s=20` })) }]);
const parent = (p: PricedPlan): PricedStage => p.stages.find((s) => s.parent_key === null)!;

describe("the identity of a delivered item", () => {
  it("one post has one identity however its link is written", () => {
    const id = "1790000000000000001";
    const forms = [`https://x.com/SaudiMOH/status/${id}`, `https://twitter.com/saudimoh/status/${id}?s=20&t=abc`, `https://mobile.twitter.com/SaudiMOH/status/${id}/`, `https://x.com/i/web/status/${id}`];
    for (const f of forms) expect(canonicalLinkOf(f)).toBe(`x:status:${id}`);
    expect(canonicalLinkOf("https://www.tiktok.com/@a/video/7663879872137252114?lang=ar")).toBe("tiktok:video:7663879872137252114");
    expect(canonicalLinkOf("https://youtu.be/abcDEF12345")).toBe("youtube:video:abcDEF12345");
    expect(canonicalLinkOf("https://www.youtube.com/watch?v=abcDEF12345&t=3")).toBe("youtube:video:abcDEF12345");
    expect(canonicalLinkOf("https://www.instagram.com/reel/Cx1_ab/?igsh=1")).toBe("instagram:media:Cx1_ab");
    expect(canonicalLinkOf("not a link")).toBeNull();
    expect(deliveryKeysOf({ id: "9", link: `https://x.com/a/status/${id}` })).toEqual(["id:9", `x:status:${id}`]);
  });
  it("a row matches by its id OR by its link (another endpoint may key the same post differently)", () => {
    const m = priorDeliveryMatcherOf(EARLIER_SNAPSHOT);
    expect(m({ id: EARLIER[0].id })).toBe(true);
    expect(m({ id: "fingerprint_x", link: `https://x.com/i/web/status/${EARLIER[1].id}` })).toBe(true);
    expect(m({ id: NEW[0].id, link: NEW[0].url })).toBe(false);
  });
  it("the snapshot is pinned by its digest: an altered copy is refused", () => {
    expect(parsePriorDeliverySnapshot(JSON.parse(JSON.stringify(EARLIER_SNAPSHOT)))).toEqual(EARLIER_SNAPSHOT);
    expect(parsePriorDeliverySnapshot({ ...EARLIER_SNAPSHOT, keys: EARLIER_SNAPSHOT.keys.slice(1) })).toBeNull();
    expect(EARLIER_SNAPSHOT.items).toBe(2);
  });
  it("the reason is an allowed removal in raw delivery and is said truthfully to the customer", () => {
    expect(EXISTING_REMOVAL_REASONS).toContain(PRIOR_DELIVERY_REASON);
    expect(isAllowedRemovalRaw(PRIOR_DELIVERY_REASON)).toBe(true);
    expect(REASON_TEXT_AR[PRIOR_DELIVERY_REASON]).toBe("سُلّم لك في مهمة سابقة");
    expect(zeroDeliveryReasonAr({ found: 40, pending: 0, excludedByReason: { already_delivered: 40 } } as never)).toMatch(/سُلّم لك من قبل/);
    expect(priorDeliveryLineAr({ missions: 1, items: 79 })).toMatch(/نستبعد ٧٩ عنصرًا سُلّم لك في ١ مهمة سابقة/);
    // the card never promises a read past the sample it may not make
    expect(priorDeliveryLineAr({ missions: 1, items: 79 })).not.toMatch(/نقرأ المصدر أبعد/);
  });
});

describe("the model's reading reaches the card (no keyword list, no migration)", () => {
  it("the brief schema keeps `exclude_delivered` (and round-trips through the stored card); the prompt tells the model when to write it", () => {
    const b = parseBrief({ status: "ready", request: "جمع ٤٠٠ تغريدة على إكس", platforms: ["x"], content: ["tweets"], count: 400, topic: "الشائعات", exclude_delivered: true });
    expect(b.ok && b.brief.exclude_delivered).toBe(true);
    if (b.ok) expect(storedBriefOf({ researchBrief: b.brief })?.exclude_delivered).toBe(true);
    const off = parseBrief({ status: "ready", request: "جمع ٤٠٠ تغريدة على إكس", platforms: ["x"], content: ["tweets"], count: 400, topic: "الشائعات", exclude_delivered: "yes" });
    expect(off.ok && off.brief.exclude_delivered).toBeUndefined();
    expect(briefPromptLines(null).join("\n")).toMatch(/exclude_delivered/);
  });

  describe("the chat turn", () => {
    const USER = "8a2f1c3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); })); vi.spyOn(console, "info").mockImplementation(() => undefined); });
    afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
    const world = () => {
      const db: any = createMemoryDb();
      db.seed("conversations", [{ id: "c1", user_id: USER, title: "t", status: "active" }]);
      db.seed("credit_ledger", [{ user_id: USER, delta: 1000 }]);
      db.seed("agent_settings", [{ key: "chat_research_brief_v1", value: true }]);
      db.seed("missions", [{ id: "msn_dd7c2e9c131b8783bf2e", user_id: USER, status: "completed", request_text: "x", plan: null, created_at: "2026-11-14T18:10:00Z" }]);
      db.seed("mission_events", []);
      db.seed("messages", [
        { id: "u0", conversation_id: "c1", user_id: USER, role: "user", content_ar: "أريد ٤٠٠ تغريدة عن الشائعات الصحية من حساب وزارة الصحة السعودية على إكس", request_status: "completed", created_at: "2026-11-14T18:10:00Z" },
        { id: "a0", conversation_id: "c1", user_id: USER, role: "assistant", content_ar: "…", plan: { agentMissionId: "msn_dd7c2e9c131b8783bf2e" }, created_at: "2026-11-14T18:10:30Z" },
        { id: "ucur", conversation_id: "c1", user_id: USER, role: "user", content_ar: "هل ممكن تتوسع اكتر في استخراج التغريدات من دون تكرار بواقع 400 تغريدة", request_status: "planning", created_at: "2026-11-15T09:22:11Z" },
        { id: "acur", conversation_id: "c1", user_id: USER, role: "assistant", content_ar: "…", created_at: "2026-11-15T09:22:11.5Z" },
      ]);
      return db;
    };
    const brief = (over: Record<string, unknown> = {}) => ({ status: "ready", request: "جمع ٤٠٠ تغريدة على إكس من حساب وزارة الصحة السعودية عن الشائعات الصحية", platforms: ["x"], content: ["tweets"], count: 400, topic: "الشائعات الصحية", source: "وزارة الصحة السعودية", period: "", country: "", language: "", ...over });
    const model = (b: Record<string, unknown>) => setChatModelForTesting(async () => ({ ok: true, text: JSON.stringify({ type: "data_request", reason: "scripted", reply: "", count: 400, brief: b }), usage: { inputTokens: 1, outputTokens: 1 } }));
    const run = (db: any) => agentChatTurn({ sb: db, userId: USER, conversationId: "c1", userMsgId: "ucur", assistantMsgId: "acur", message: "هل ممكن تتوسع اكتر في استخراج التغريدات من دون تكرار بواقع 400 تغريدة", conversationTitle: "t" });
    it("the model read «من دون تكرار»: the new card records the conversation's earlier missions (server-written, the worker verifies them)", async () => {
      model(brief({ exclude_delivered: true }));
      const db = world();
      const r = await run(db);
      expect(r.ok).toBe(true);
      const card = (db.rows("messages") as any[]).find((m) => m.id === "acur");
      expect(card.plan.priorDelivery).toEqual({ missionIds: ["msn_dd7c2e9c131b8783bf2e"] });
      expect(card.plan.researchBrief.exclude_delivered).toBe(true);
    });
    it("without that reading nothing is recorded (an ordinary new request is never narrowed)", async () => {
      model(brief());
      const db = world();
      await run(db);
      const card = (db.rows("messages") as any[]).find((m) => m.id === "acur");
      expect(card.plan.priorDelivery).toBeUndefined();
    });
  });
});

describe("the worker verifies what it excludes", () => {
  it("only this customer's completed missions that delivered something; their item stores give the delivered identities", async () => {
    const db: any = createMemoryDb();
    db.seed("missions", [
      { id: "msn_aaaaaaaaaaaaaaaaaaaa", user_id: "u1", status: "completed", delivered_units: 2, plan: { stages: [{ key: "tweets", deliver: true, planned_rows: 2 }] } },
      { id: "msn_bbbbbbbbbbbbbbbbbbbb", user_id: "u2", status: "completed", delivered_units: 5, plan: { stages: [{ key: "tweets", deliver: true, planned_rows: 5 }] } },
      { id: "msn_cccccccccccccccccccc", user_id: "u1", status: "failed", delivered_units: 0, plan: { stages: [{ key: "tweets", deliver: true, planned_rows: 5 }] } },
    ]);
    const readMissions = deliveredMissionsReader(db);
    // another customer's mission is never returned; the worker decides by status and delivery
    expect((await readMissions(["msn_aaaaaaaaaaaaaaaaaaaa", "msn_bbbbbbbbbbbbbbbbbbbb", "msn_cccccccccccccccccccc"], "u1")).map((m) => m.id).sort()).toEqual(["msn_aaaaaaaaaaaaaaaaaaaa", "msn_cccccccccccccccccccc"]);
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_aaaaaaaaaaaaaaaaaaaa");
    const st = { key: "tweets", title_ar: "التغريدات", endpoint_id: "e", expected_rows: 2, planned_rows: 2, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "link", title_ar: "الرابط" }], sample_rows: [] } as unknown as PricedStage;
    await ingestRows({ items, plan: { summary_ar: "x", stages: [st], price: {} } as unknown as PricedPlan, addEvent: async () => undefined }, st, EARLIER.map((p) => ({ id: p.id, text: p.text, link: p.url })), { silent: true, idField: null });
    const mission = { id: "msn_new0000000000000000", user_id: "u1" } as MissionRecord;
    const snap = await priorDeliveryForPlanning({ mission, store, readCard: async () => ({ missionIds: ["msn_aaaaaaaaaaaaaaaaaaaa", "msn_bbbbbbbbbbbbbbbbbbbb", "msn_new0000000000000000", "not-an-id"] }), readMissions });
    expect(snap?.missions).toEqual(["msn_aaaaaaaaaaaaaaaaaaaa"]);
    expect(snap?.items).toBe(2);
    expect(priorDeliveryMatcherOf(snap!)({ id: "other", link: `https://twitter.com/x/status/${EARLIER[1].id}` })).toBe(true);
    // no card record: nothing is read or excluded
    expect(await priorDeliveryForPlanning({ mission, store, readCard: async () => null, readMissions })).toBeNull();
  });
  it("the card reader: this user's card of this mission, then the conversation's earlier cards read BY THE WORKER (the chat's list may be empty after a failed read on its side); any failed read throws", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = (results: Array<{ data: unknown; error: unknown }>) => { let n = 0; return { from: () => { const r = results[Math.min(n, results.length - 1)]; n += 1; const b: any = { select: () => b, eq: (c: string, v: unknown) => { calls.push([c, v]); return b; }, lt: (c: string, v: unknown) => { calls.push([`${c}<`, v]); return b; }, order: () => b, limit: () => Promise.resolve(r) }; return b; } }; };
    const card = { plan: { agentMissionId: "msn_x", priorDelivery: { missionIds: [] } }, created_at: "2026-11-15T09:22:11Z", conversation_id: "c1" };
    const earlier = [{ plan: { agentMissionId: "msn_dd7c" } }, { plan: { agentMissionId: "msn_cd5f" } }, { plan: null }];
    const read = priorDeliveryCardReader(client([{ data: [card], error: null }, { data: earlier, error: null }]));
    expect((await read("msn_x", "u1"))?.missionIds.sort()).toEqual(["msn_cd5f", "msn_dd7c"]);
    expect(calls).toEqual(expect.arrayContaining([["user_id", "u1"], ["role", "assistant"], ["plan->>agentMissionId", "msn_x"], ["conversation_id", "c1"], ["created_at<", "2026-11-15T09:22:11Z"]]));
    // a card that does not ask: nothing is read further
    expect(await priorDeliveryCardReader(client([{ data: [{ ...card, plan: { agentMissionId: "msn_x" } }], error: null }]))("msn_x", "u1")).toBeNull();
    await expect(priorDeliveryCardReader(client([{ data: null, error: { message: "down" } }]))("msn_x", "u1")).rejects.toThrow("prior_delivery_card_read_failed");
    await expect(priorDeliveryCardReader(client([{ data: [card], error: null }, { data: null, error: { message: "down" } }]))("msn_x", "u1")).rejects.toThrow("prior_delivery_conversation_read_failed");
  });
  it("what is NOT known is said, never «nothing to exclude»: an earlier mission still running (its items so far are excluded) and an earlier delivery whose items cannot be read; an older mission's stage file is read", async () => {
    const store = createMemoryStore();
    const st = { key: "tweets", title_ar: "التغريدات", endpoint_id: "e", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "link", title_ar: "الرابط" }], sample_rows: [] } as unknown as PricedStage;
    const running = await ItemStore.open(store, "msn_run00000000000000000");
    await ingestRows({ items: running, plan: { summary_ar: "x", stages: [st], price: {} } as unknown as PricedPlan, addEvent: async () => undefined }, st, [EARLIER[0]].map((p) => ({ id: p.id, text: p.text, link: p.url })), { silent: true, idField: null });
    await store.putFile("msn_old00000000000000000", "rows/tweets.json", JSON.stringify([{ id: EARLIER[1].id, link: EARLIER[1].url }]), "application/json");
    const stages = [{ key: "tweets", rows: 5 }];
    const snap = await priorDeliveryForPlanning({
      mission: { id: "msn_new0000000000000000", user_id: "u1" } as MissionRecord, store, readCard: async () => ({ missionIds: ["msn_run00000000000000000", "msn_old00000000000000000", "msn_gone0000000000000000", "msn_none0000000000000000"] }),
      readMissions: async () => [
        { id: "msn_run00000000000000000", status: "executing", delivered: 0, stages },
        { id: "msn_old00000000000000000", status: "completed", delivered: 1, stages },
        { id: "msn_gone0000000000000000", status: "completed", delivered: 4, stages },
        { id: "msn_none0000000000000000", status: "cancelled", delivered: 0, stages },
      ],
    });
    expect(snap).toMatchObject({ items: 2, running: 1, unreadable: 1 });
    expect(snap!.missions.sort()).toEqual(["msn_old00000000000000000", "msn_run00000000000000000"]);
    const line = priorDeliveryLineAr(planPriorDeliveryOf(snap!));
    expect(line).toMatch(/نستبعد ٢ عنصرًا/);
    expect(line).toMatch(/١ مهمة سابقة ما زالت قيد التنفيذ/);
    expect(line).toMatch(/تعذّر علينا قراءة ما سُلّم في ١ مهمة سابقة/);
    expect(priorDeliveryLineAr({ missions: 0, items: 0, unreadable: 2 })).not.toMatch(/لم نجد في هذه المحادثة/);
    expect(parsePriorDeliverySnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });
});

/** The planning and the real engine over one scripted source (page by cursor), with the earlier delivery pinned. */
async function continuation(pageFor: (params: Record<string, unknown>) => unknown, snapshot = EARLIER_SNAPSHOT) {
  const store = createMemoryStore();
  const served: Array<Record<string, unknown>> = [];
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const params = (input.params ?? {}) as Record<string, unknown>;
      served.push(params);
      const page = pageFor(params);
      const callId = `call_${String(served.length).padStart(4, "0")}`;
      await store.putFile("msn_t", RAW_PATH(callId), JSON.stringify(page), "application/json");
      const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!);
      const next = (page as { output?: { data?: { nextCursor?: string | null } } }).output?.data?.nextCursor ?? null;
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: next !== null, next_cursor: next, cost_usd: 0.00049 };
    },
  };
  const judged: string[] = [];
  const planned = await planByCompiler({ mission: { id: "msn_t", request_text: fx.request_text, answer_text: fx.source_answer, created_at: fx.created_at } as never, gateway: gateway as never, store, catalog, nowMs, choices: { sourceId: fx.source_answer }, answerIsChoice: true, judge: async (x: { subject: string; rows: ReadonlyArray<{ id: string; text: string }> }) => { judged.push(...x.rows.map((r) => r.id)); return judge(x); }, delivered: priorDeliveryMatcherOf(snapshot) } as never);
  if (planned.kind !== "plan") throw new Error(`no plan: ${planned.kind}`);
  const plan = await withPriorDelivery(planned.plan, "msn_t", store, snapshot);
  const planningCalls = served.length;
  const matcher = await loadApprovedPriorDelivery(store, "msn_t", plan.prior_delivery!);
  const items = await ItemStore.open(store, "msn_t");
  const approved = withPromiseCaps(plan);
  const rv = reviewer();
  const outcome = await runEngine({ reviewer: rv as never, items, store, plan: approved, missionId: "msn_t", gateway: gateway as never, priorDelivered: matcher!, sandbox: (code: string, inputs: Record<string, unknown>) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 600_000, sleep: async () => undefined, now: () => nowMs + 600_000, redesignStages: new Set(approved.stages.map((st) => st.key)) } as never);
  return { plan, outcome, items, store, judged, asked: rv.asked, executionCalls: served.length - planningCalls };
}

describe("a continuation never redelivers, and never charges, what was delivered before", () => {
  it("the planning sample is the earlier delivery: nothing of it is chosen or judged, the plan is still sized by the customer's 400, and execution reads past it and delivers only new items", async () => {
    const pageFor = (params: Record<string, unknown>) => (!params.cursor ? pageOf([...fx.page_1_items, ...EARLIER], "c1") : params.cursor === "c1" ? pageOf([EARLIER[0]], "c2") : params.cursor === "c2" ? pageOf(NEW, "c3") : pageOf([], null));
    const { plan, outcome, items, store, judged, asked, executionCalls } = await continuation(pageFor);
    // the card: sized by the request, with the exclusion said in numbers before approval
    expect(parent(plan).planned_rows).toBe(400);
    expect(parent(plan).sample_rows).toEqual([]);
    expect(plan.prior_delivery).toEqual({ digest: EARLIER_SNAPSHOT.digest, missions: 1, items: 2 });
    expect((plan.notes_ar ?? []).join(" ")).toContain(priorDeliveryLineAr({ missions: 1, items: 2 }));
    expect((plan.notes_ar ?? []).join(" ")).toMatch(/من العينة التي قرأناها ٢ سبق أن سلّمناه لك/);
    // nothing chosen: no sentence about «what we chose», and the left-out count is of rows NOT delivered before (the incident's three)
    expect((plan.notes_ar ?? []).join(" ")).not.toMatch(/ما اخترناه|من العناصر المختارة وعددها/);
    expect((plan.notes_ar ?? []).join(" ")).toMatch(/تركنا ٣ مما قرأناه/);
    expect(await store.getFile("msn_t", PRIOR_DELIVERY_PATH)).not.toBeNull();
    // never judged at planning (no model cost spent on them), never asked at execution
    for (const p of EARLIER) { expect(judged).not.toContain(p.id); expect(asked).not.toContain(p.id); }
    // execution read on and delivered only the new posts about the topic
    expect(executionCalls).toBeGreaterThanOrEqual(2);
    expect(outcome.stops.tweets).toBe("source_exhausted");
    const delivered = items.snapshotOfMemory().acceptedRows("tweets", 400).map((r) => String(r.id)).sort();
    expect(delivered).toEqual(NEW.map((p) => p.id).sort());
    // the earlier posts were read again (page 1 and again on page 2) and kept out with their reason: not delivered, not counted, not charged
    expect(items.counts("tweets").excludedByReason.already_delivered).toBe(2);
    expect(items.counts("tweets").accepted).toBe(2);
  });
  it("pages made only of what was delivered before do not end the read as «nothing about the topic» (a continuation reads past the earlier mission's pages)", async () => {
    const many = Array.from({ length: 6 }, (_, i) => Array.from({ length: 20 }, (_, j) => post(`92000000000000${String(i).padStart(2, "0")}${String(j).padStart(3, "0")}`, `احذروا الشائعات ${i}-${j}`)));
    for (const pg of many) for (const p of pg) ABOUT.add(p.id);
    const snapshot = priorDeliverySnapshotOf([{ id: "msn_dd7c2e9c131b8783bf2e", rows: many.flat().map((p) => ({ id: p.id, link: p.url })) }]);
    try {
      const pageFor = (params: Record<string, unknown>) => {
        const c = params.cursor ? Number(String(params.cursor).slice(1)) : 0;
        if (c < many.length) return pageOf(many[c], `p${c + 1}`);
        if (c === many.length) return pageOf(NEW, null);
        return pageOf([], null);
      };
      const { items, outcome } = await continuation(pageFor, snapshot);
      expect(outcome.stops.tweets).toBe("source_exhausted");
      expect(items.snapshotOfMemory().acceptedRows("tweets", 400).map((r) => String(r.id)).sort()).toEqual(NEW.map((p) => p.id).sort());
      expect(items.counts("tweets").excludedByReason.already_delivered).toBe(120);
    } finally { for (const pg of many) for (const p of pg) ABOUT.delete(p.id); }
  });
  it("off-topic pages that also carry a few earlier deliveries still end the read (the dry stop is not defeated), with a truthful reason", async () => {
    let page = 0;
    const offTopic = (n: number) => Array.from({ length: 19 }, (_, i) => post(`93000000000${String(n).padStart(3, "0")}${String(i).padStart(3, "0")}`, `منشور عن موضوع آخر ${n}-${i}`));
    const pageFor = (params: Record<string, unknown>) => { if (!params.cursor) return pageOf([...NEW], "p1"); page += 1; return pageOf([...offTopic(page), EARLIER[page % 2]], `p${page + 1}`); };
    const { outcome, executionCalls } = await continuation(pageFor);
    expect(outcome.stops.tweets).toBe("topic_dry");
    expect(executionCalls).toBeLessThanOrEqual(JUDGED_DRY_PAGES + 4);
    expect(REASON_STOP_AR("topic_dry")).toMatch(/لم نجد فيها ما يتحدث فعلًا عن موضوعك/);
  });
  it("FAIL CLOSED: a plan approved with an exclusion never ingests without exactly that snapshot", async () => {
    const store = createMemoryStore();
    const st = { key: "tweets", title_ar: "التغريدات", endpoint_id: "e", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] } as unknown as PricedStage;
    const plan = { summary_ar: "x", stages: [st], price: {}, prior_delivery: { digest: EARLIER_SNAPSHOT.digest, missions: 1, items: 2 } } as unknown as PricedPlan;
    const items = await ItemStore.open(store, "msn_t");
    await expect(ingestRows({ items, plan, addEvent: async () => undefined }, st, [{ id: "1", text: "x" }], { silent: true, idField: null })).rejects.toThrow("prior_delivery_unavailable");
    // the private copy missing, or altered after approval: no matcher, so the runner stops before any call (runMission.ts)
    expect(await loadApprovedPriorDelivery(store, "msn_t", plan.prior_delivery!)).toBeNull();
    await store.putFile("msn_t", PRIOR_DELIVERY_PATH, JSON.stringify({ ...EARLIER_SNAPSHOT, keys: [] }), "application/json");
    expect(await loadApprovedPriorDelivery(store, "msn_t", plan.prior_delivery!)).toBeNull();
    await store.putFile("msn_t", PRIOR_DELIVERY_PATH, JSON.stringify(EARLIER_SNAPSHOT), "application/json");
    expect(await loadApprovedPriorDelivery(store, "msn_t", plan.prior_delivery!)).not.toBeNull();
  });
});

describe("the period is a gate at execution exactly where the planning gated it (the approved card's own rule)", () => {
  const st = (key = "videos") => ({ key, title_ar: "x", endpoint_id: "e", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "posted_at", title_ar: "التاريخ" }], filters: [{ kind: "period", from: "2026-11-08", to: "2026-11-15", field: "posted_at", enabled: true }], sample_rows: [] } as unknown as PricedStage);
  const rows = [{ id: "old", text: "x", posted_at: "2025-01-01T10:00:00.000Z" }, { id: "in", text: "y", posted_at: "2026-11-10T10:00:00.000Z" }];
  const run = async (compiled: Record<string, unknown>) => {
    const items = await ItemStore.open(createMemoryStore(), "msn_t");
    const s = st();
    await ingestRows({ items, plan: { summary_ar: "x", stages: [s], price: {}, compiled } as unknown as PricedPlan, addEvent: async () => undefined }, s, rows, { silent: true, idField: null, raw: true });
    return items;
  };
  it("a plan whose planning only MARKED the period (TikTok, an ordinary X search): the row stays, with its mark, as the card said", async () => {
    const items = await run({ by: "compiler", platform: "tiktok", promises: {} });
    expect(items.snapshotOfMemory().acceptedRows("videos").map((r) => r.id).sort()).toEqual(["in", "old"]);
  });
  it("a plan whose planning chose inside the period (`period_gate`): the row outside it is never delivered or charged", async () => {
    const items = await run({ by: "compiler", platform: "x", promises: {}, period_gate: true });
    expect(items.snapshotOfMemory().acceptedRows("videos").map((r) => r.id)).toEqual(["in"]);
    expect(items.counts("videos").excludedByReason.filter_period).toBe(1);
  });
});
