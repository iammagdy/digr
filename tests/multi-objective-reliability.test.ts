import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryDb } from "./helpers/memoryDb";
import { REPLAY_USER } from "./helpers/agentReplay";
import { agentChatTurn, WAITING_ROOM_AR, CARD_UNSAVED_AR, CHAT_RESEARCH_BRIEF_FLAG_KEY, GROUP_NOT_SAVED_AR, GROUP_UNCHANGED_AR } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting, type ChatModelInput } from "../src/lib/agentMission/chatModel";
import { createCustomerMission, loadCustomerMission } from "../src/lib/agentMission/customerActions";
import { parseBrief } from "../src/lib/agentMission/researchBrief";
import { droppedRequirementsOf, inventedRequirementOf, partCardIdOf, partMissionIdOf, storedGroupOf, RESEARCH_GROUP_MAX_PARTS } from "../src/lib/agentMission/researchGroup";
import { CAPABILITY_DISCOVERY_FLAG_KEY } from "../src/lib/agentMission/capabilities";
import { appendNewMessages, partCardMessagesOf, storedCardMissionOf } from "../src/lib/agentMission/chatCards";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";

/**
 * MULTI-OBJECTIVE RELIABILITY (docs/MULTI-OBJECTIVE-RESEARCH.md sections 8-10), OFFLINE through the real chat turn (`agentChatTurn`, a SCRIPTED model in the real JSON format) on an in-memory database that behaves like
 * Supabase where it matters here: a write can RESOLVE with an error object (not throw), a write can throw, and the primary key refuses a second row with the same id (`23505`). No network, no paid call, no key.
 */
type Obj = { id: string; operation: string; platform?: string; parent?: string; contacts?: string[]; what?: string; request?: string };
const o = (id: string, operation: string, x: Partial<Obj> = {}): Obj => ({ id, operation, ...x });
const briefOf = (b: Record<string, unknown>) => ({ status: "ready", platforms: [], content: [], count: null, topic: "", period: "", country: "", language: "", ...b });
const say = (brief: Record<string, unknown>, reply = "", type = "data_request") => ({ type, reason: "x", reply, count: null, brief: briefOf(brief) });
let modelCalls: ChatModelInput[] = [];
function scripted(steps: Array<Record<string, unknown>>) {
  modelCalls = [];
  const script = [...steps];
  setChatModelForTesting(async (input) => {
    modelCalls.push(input);
    const s = script.shift();
    if (!s) return { ok: false, failure: "http_529" };
    return { ok: true, text: JSON.stringify(s), usage: { inputTokens: 1800, outputTokens: 420 } };
  });
}

const REQUEST = "عايز تعليقات تيك توك عن السياحة، وتقييمات فنادق الغردقة، وآخر الأخبار عن السياحة في مصر";
const TIKTOK_PART = "هات تعليقات تيك توك عن السياحة";
const HOTELS_PART = "تقييمات فنادق الغردقة";
const NEWS_PART = "آخر الأخبار عن السياحة في مصر";
const THREE = (x: { tiktok?: string; hotels?: string; news?: string; request?: string } = {}) => ({
  request: x.request ?? REQUEST, platforms: ["tiktok"], content: ["comments", "places", "reviews"],
  objectives: [
    o("o1", "social.parents", { platform: "tiktok", request: x.tiktok ?? TIKTOK_PART }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }),
    o("o3", "places.discover", { request: x.hotels ?? HOTELS_PART }), o("o4", "places.reviews", { parent: "o3" }),
    o("o5", "web.search", { request: x.news ?? NEWS_PART }), o("o6", "web.read", { parent: "o5" }),
  ],
});

// ---- a database that fails the way Supabase fails --------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Op = { table: string; op: "insert" | "update"; row?: any; patch?: any; eqs: Record<string, any> };
type Verdict = "error" | "throw" | null;
const USER = REPLAY_USER;
function world(rules: Array<(op: Op) => Verdict> = []) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 5000 }]);
  for (const t of ["mission_events", "messages", "missions"]) db.seed(t, []);
  db.seed("agent_settings", [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: [USER] } }, { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: [USER] } }]);
  const verdict = (op: Op): Verdict => { for (const r of rules) { const v = r(op); if (v) return v; } return null; };
  const baseFrom = db.from;
  const seen: Op[] = [];
  db.from = (name: string) => {
    const b = baseFrom(name);
    const eqs: Record<string, any> = {};
    let pending: Op | null = null;
    const origEq = b.eq, origInsert = b.insert, origUpdate = b.update, origThen = b.then;
    b.eq = (c: string, v: any) => { eqs[c] = v; origEq(c, v); return b; };
    b.insert = (row: any) => {
      const op: Op = { table: name, op: "insert", row, eqs };
      seen.push(op);
      const v = verdict(op);
      if (v === "throw") return Promise.reject(new Error("network reset"));
      if (v === "error") return Promise.resolve({ data: null, error: { message: "server error", code: "08006" } });
      // the primary key (messages.id and missions.id are both TEXT PRIMARY KEY)
      if ((name === "messages" || name === "missions") && db.rows(name).some((r: any) => r.id === row.id)) return Promise.resolve({ data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } });
      // the database's own defaults (created_at now()): a mission row without them reads as an expired plan to the open-missions reader
      return origInsert(name === "missions" && !row.created_at ? { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } : row);
    };
    b.update = (p: any) => { pending = { table: name, op: "update", patch: p, eqs }; seen.push(pending); origUpdate(p); return b; };
    b.then = (res: any, rej: any) => {
      if (pending) {
        const v = verdict(pending);
        if (v === "error") return Promise.resolve({ data: null, error: { message: "server error" } }).then(res, rej);
        if (v === "throw") return Promise.reject(new Error("network reset")).then(res, rej);
      }
      return origThen(res, rej);
    };
    return b;
  };
  return Object.assign(db, { seen });
}
const cardInsertOf = (missionText: string) => (op: Op): Verdict => (op.table === "messages" && op.op === "insert" && op.row?.plan?.researchBrief?.request === missionText ? "error" : null);
const summaryUpdate = (op: Op): Verdict => (op.table === "messages" && op.op === "update" && op.patch?.plan?.researchGroup && !op.patch.plan.agentMissionId ? "error" : null);

let seq = 0;
async function turn(db: any, message: string, ids?: { u: string; a: string }) {
  seq += 1;
  const at = Date.parse("2026-11-12T09:00:00Z") + seq * 10_000;
  const u = ids?.u ?? `u${seq}`, a = ids?.a ?? `a${seq}`;
  db.rows("messages").push(
    { id: u, conversation_id: "conv1", user_id: USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date(at).toISOString() },
    { id: a, conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "جاري التفكير وتحليل طلبك...", created_at: new Date(at + 1).toISOString() },
  );
  const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: u, assistantMsgId: a, message, conversationTitle: "محادثة جديدة" });
  return { r, assistant: db.rows("messages").find((m: any) => m.id === a) };
}
const missions = (db: any) => db.rows("missions") as Array<{ id: string; status: string; request_text: string }>;
const live = (db: any) => missions(db).filter((m) => m.status !== "cancelled");
const cardRows = (db: any) => db.rows("messages").filter((m: any) => m.role === "assistant" && storedCardMissionOf(m.plan));
const strict = (raw: unknown) => { const p = parseBrief(raw); return p.ok ? p.brief : null; };
/** What a reload of the conversation shows: every stored row in order, a card where the row names a mission. */
const reload = (db: any) => [...db.rows("messages")].filter((m: any) => m.conversation_id === "conv1").sort((x: any, y: any) => (x.created_at < y.created_at ? -1 : 1)).map((m: any) => ({ id: m.id, role: m.role, mission: storedCardMissionOf(m.plan) }));
/** Every live mission has exactly one card, no mission has two, and every card draws a mission of this customer (a withdrawn part's card stays in the history, showing it withdrawn). */
function oneCardPerLiveMission(db: any) {
  const cards = cardRows(db).map((m: any) => m.plan.agentMissionId);
  const liveIds = new Set(live(db).map((m) => m.id));
  expect(cards.filter((id: string) => liveIds.has(id)).sort()).toEqual([...liveIds].sort());
  expect(new Set(cards).size).toBe(cards.length);
  expect(cards.every((id: string) => missions(db).some((m) => m.id === id))).toBe(true);
}
let infos: string[] = [];
let warns: string[] = [];
const lastOutcome = () => { const line = [...infos].reverse().find((l) => l.includes("chat_message_type")); return line ? JSON.parse(line).brief : null; };
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  infos = []; warns = [];
  fetchSpy = vi.fn(async () => { throw new Error("no network in this test"); });
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "info").mockImplementation((line: unknown) => { infos.push(String(line)); });
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => { warns.push(String(line)); });
});
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// =====================================================================================================================================================================================================================================
describe("ISSUE 1. a card is said saved only when its row is stored; a part whose card failed is never claimed, never lost, never doubled", () => {
  it("baseline: the summary is the answer (no card on it), every part's card is its own stored row with a derived id, and the response lists exactly the stored cards", async () => {
    scripted([say(THREE())]);
    const db = world();
    const { r, assistant } = await turn(db, REQUEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summaryOnly).toBe(true);
    expect(assistant.plan.agentMissionId).toBeUndefined();
    expect(assistant.content_ar).toBe(r.contentAr);
    expect(r.extraMissions!.map((c) => c.messageId)).toEqual(cardRows(db).map((m: any) => m.id));
    expect(r.extraMissions!.map((c) => c.messageId)).toEqual(missions(db).map((m) => partCardIdOf(m.id)));
    expect(missions(db).map((m) => m.id)).toEqual([TIKTOK_PART, HOTELS_PART, NEWS_PART].map((t) => partMissionIdOf(USER, "conv1", t, 0)));
    oneCardPerLiveMission(db);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the FIRST card's write resolves with an error object (not a throw): that part is withdrawn and said «waiting», the other two cards are stored and returned; the response matches the stored rows", async () => {
    scripted([say(THREE())]);
    const db = world([cardInsertOf(TIKTOK_PART)]);
    const { r, assistant } = await turn(db, REQUEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the response never lists the unsaved card
    expect(r.extraMissions!.map((c) => c.id)).toEqual(live(db).map((m) => m.id));
    expect(r.extraMissions).toHaveLength(2);
    expect(missions(db).find((m) => m.request_text === TIKTOK_PART)!.status).toBe("cancelled");
    oneCardPerLiveMission(db);
    // said, never claimed: the summary stored on the answer is the response's, and it says the part waits
    expect(assistant.content_ar).toBe(r.contentAr);
    expect(r.contentAr).toContain(CARD_UNSAVED_AR);
    const group = storedGroupOf(assistant.plan, strict)!;
    expect(group.parts.map((p) => [p.outcome, p.missionId === null])).toEqual([["waiting", true], ["planned", false], ["planned", false]]);
    expect(lastOutcome()).toBe("group_3_created_0_kept_2_cards_1_unsaved_0_other");
  });

  it("an ADDITIONAL card's insert throws (a network reset): the same: withdrawn, said, not returned", async () => {
    scripted([say(THREE())]);
    const db = world([(op) => (op.table === "messages" && op.op === "insert" && op.row?.plan?.researchBrief?.request === NEWS_PART ? "throw" : null)]);
    const { r } = await turn(db, REQUEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.extraMissions!.map((c) => c.contentAr.includes(NEWS_PART))).toEqual([false, false]);
    expect(missions(db).find((m) => m.request_text === NEWS_PART)!.status).toBe("cancelled");
    oneCardPerLiveMission(db);
  });

  it("PARTIAL persistence: two of three card writes fail (one error, one throw): one card stored and returned, two parts waiting with no live mission; reload shows exactly the stored card", async () => {
    scripted([say(THREE())]);
    const db = world([cardInsertOf(HOTELS_PART), (op) => (op.table === "messages" && op.op === "insert" && op.row?.plan?.researchBrief?.request === NEWS_PART ? "throw" : null)]);
    const { r, assistant } = await turn(db, REQUEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.extraMissions).toHaveLength(1);
    expect(live(db).map((m) => m.request_text)).toEqual([TIKTOK_PART]);
    oneCardPerLiveMission(db);
    expect(reload(db).filter((m) => m.mission).map((m) => m.id)).toEqual(r.extraMissions!.map((c) => c.messageId));
    expect(storedGroupOf(assistant.plan, strict)!.parts.map((p) => p.outcome)).toEqual(["planned", "waiting", "waiting"]);
  });

  it("the card write's ANSWER is lost but the row was stored: the card is checked by its id and counted saved (never withdrawn while the customer can see it)", async () => {
    scripted([say(THREE())]);
    const db: any = world();
    const base = db.from;
    db.from = (name: string) => {
      const b = base(name);
      const ins = b.insert;
      b.insert = (row: any) => (name === "messages" && row?.plan?.researchBrief?.request === HOTELS_PART ? ins(row).then(() => ({ data: null, error: { message: "timeout reading the answer" } })) : ins(row));
      return b;
    };
    const { r } = await turn(db, REQUEST);
    expect(r.ok && r.extraMissions).toHaveLength(3);
    expect(live(db)).toHaveLength(3);
    oneCardPerLiveMission(db);
  });

  it("a card fails AND its mission cannot be withdrawn (the worker took it): the mission is kept in the group, and the next turn writes ITS card, never a second mission", async () => {
    scripted([say(THREE()), say(THREE())]);
    let failing = true;
    const db = world([(op) => (failing ? cardInsertOf(TIKTOK_PART)(op) : null), (op) => (failing && op.table === "missions" && op.op === "update" && op.patch?.status === "cancelled" ? "error" : null)]);
    const first = await turn(db, REQUEST);
    expect(first.r.ok && first.r.extraMissions).toHaveLength(2);
    const tiktok = missions(db).find((m) => m.request_text === TIKTOK_PART)!;
    expect(tiktok.status).toBe("queued");
    expect(storedGroupOf(first.assistant.plan, strict)!.parts[0]).toMatchObject({ outcome: "waiting", missionId: tiktok.id });
    // the database recovers; the customer says «كمّل»
    failing = false;
    const second = await turn(db, "كمّل");
    expect(second.r.ok).toBe(true);
    if (!second.r.ok) return;
    expect(missions(db)).toHaveLength(3);
    expect(second.r.extraMissions!.map((c) => c.id)).toEqual([tiktok.id]);
    oneCardPerLiveMission(db);
  });

  it("RETRY after a failure: «كمّل» prepares the part that failed (a new id: its first mission was withdrawn), keeps the two saved parts (no new mission, no second card), and reload shows one card per live mission", async () => {
    scripted([say(THREE()), say(THREE())]);
    let failing = true;
    const db = world([(op) => (failing ? cardInsertOf(TIKTOK_PART)(op) : null)]);
    await turn(db, REQUEST);
    failing = false;
    const before = live(db).map((m) => m.id);
    const { r, assistant } = await turn(db, "كمّل");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.extraMissions).toHaveLength(1);
    expect(r.extraMissions![0].id).toBe(partMissionIdOf(USER, "conv1", TIKTOK_PART, 1));
    expect(live(db).map((m) => m.id).sort()).toEqual([...before, partMissionIdOf(USER, "conv1", TIKTOK_PART, 1)].sort());
    expect(storedGroupOf(assistant.plan, strict)!.parts.map((p) => p.outcome)).toEqual(["planned", "planned", "planned"]);
    oneCardPerLiveMission(db);
    // and once more: nothing new
    scripted([say(THREE())]);
    const third = await turn(db, "تمام");
    expect(third.r.contentAr).toBe(GROUP_UNCHANGED_AR);
    expect(live(db)).toHaveLength(3);
    oneCardPerLiveMission(db);
  });

  it("the SUMMARY write fails (resolves with an error, twice): the stored cards stand and are returned, the failure is logged, and the next turn still knows the parts from the cards' group (no duplicate)", async () => {
    scripted([say(THREE()), say(THREE())]);
    let failing = true;
    const db = world([(op) => (failing ? summaryUpdate(op) : null)]);
    const first = await turn(db, REQUEST);
    expect(first.r.ok && first.r.extraMissions).toHaveLength(3);
    expect(warns.some((w) => w.includes("agent_group_summary_unsaved"))).toBe(true);
    failing = false;
    const second = await turn(db, "كمّل");
    expect(second.r.contentAr).toBe(GROUP_UNCHANGED_AR);
    expect(live(db)).toHaveLength(3);
    oneCardPerLiveMission(db);
  });

  it("NOTHING can be stored (every card and the summary fail): no live mission is left, nothing is claimed, the customer is told to say «كمّل»; the retry prepares all three exactly once", async () => {
    scripted([say(THREE()), say(THREE())]);
    let failing = true;
    const db = world([(op) => (failing && op.table === "messages" && (op.op === "insert" || summaryUpdate(op)) ? "error" : null)]);
    const first = await turn(db, REQUEST);
    expect(first.r).toEqual({ ok: false, contentAr: GROUP_NOT_SAVED_AR, status: 200 });
    expect(live(db)).toHaveLength(0);
    expect(cardRows(db)).toHaveLength(0);
    failing = false;
    const second = await turn(db, "كمّل");
    expect(second.r.ok && second.r.extraMissions).toHaveLength(3);
    expect(live(db)).toHaveLength(3);
    oneCardPerLiveMission(db);
  });

  it("CONCURRENT duplicate requests (a double send: two messages, two turns at the same moment): three missions and three cards in all, never six; both answers list the same stored cards", async () => {
    scripted([say(THREE()), say(THREE())]);
    const db = world();
    const [x, y] = await Promise.all([turn(db, REQUEST, { u: "ux", a: "ax" }), turn(db, REQUEST, { u: "uy", a: "ay" })]);
    expect(modelCalls).toHaveLength(2);
    expect(live(db)).toHaveLength(3);
    expect(missions(db)).toHaveLength(3);
    oneCardPerLiveMission(db);
    const ids = (t: typeof x) => (t.r.ok ? t.r.extraMissions!.map((c) => c.messageId).sort() : []);
    expect(ids(x)).toEqual(cardRows(db).map((m: any) => m.id).sort());
    expect(ids(y)).toEqual(ids(x));
    // the page appends a card it already shows only once
    const page = appendNewMessages([], [...partCardMessagesOf(x.r.ok ? x.r.extraMissions : [], "t"), ...partCardMessagesOf(y.r.ok ? y.r.extraMissions : [], "t")]);
    expect(page).toHaveLength(3);
  });

  it("a mission created by another turn is ADOPTED, never re-created, and a finished one is never reused (the part takes its next id)", async () => {
    const db = world();
    const id0 = partMissionIdOf(USER, "conv1", HOTELS_PART, 0);
    const made = await createCustomerMission(db, { userId: USER, text: HOTELS_PART, id: id0 });
    expect(made).toEqual({ ok: true, id: id0 });
    const again = await createCustomerMission(db, { userId: USER, text: HOTELS_PART, id: id0 });
    expect(again).toMatchObject({ ok: false, conflict: true });
    expect(await createCustomerMission(db, { userId: USER, text: HOTELS_PART, id: "msn_not-hex" })).toMatchObject({ ok: false, status: 400 });
    missions(db)[0].status = "delivered";
    scripted([say(THREE())]);
    const { r } = await turn(db, REQUEST);
    expect(r.ok && r.extraMissions!.map((c) => c.id)).toContain(partMissionIdOf(USER, "conv1", HOTELS_PART, 1));
    expect(missions(db).filter((m) => m.request_text === HOTELS_PART).map((m) => m.status)).toEqual(["delivered", "queued"]);
  });
});

// =====================================================================================================================================================================================================================================
describe("ISSUE 2. every part is accounted for, whatever their number: the 7th and 8th reach their missions through «كمّل», within the existing limits, each approved on its own", () => {
  const EIGHT_REQUEST = "عايز تعليقات تيك توك عن السياحة، وتقييمات فنادق الغردقة، وآخر الأخبار عن السياحة في مصر، وشركات السياحة في القاهرة، ومطاعم الإسكندرية، ومقالات عن الطيران الاقتصادي، وتعليقات يوتيوب عن الرحلات، ومنشورات فيسبوك عن الفنادق";
  const PARTS = ["تعليقات تيك توك عن السياحة", "تقييمات فنادق الغردقة", "آخر الأخبار عن السياحة في مصر", "شركات السياحة في القاهرة", "مطاعم الإسكندرية", "مقالات عن الطيران الاقتصادي", "تعليقات يوتيوب عن الرحلات", "منشورات فيسبوك عن الفنادق"];
  const EIGHT = {
    request: EIGHT_REQUEST, platforms: ["facebook", "tiktok", "youtube"], content: ["comments", "reviews", "companies", "places"],
    objectives: [
      o("o1", "social.comments", { platform: "tiktok", request: PARTS[0] }), o("o2", "places.reviews", { request: PARTS[1] }), o("o3", "web.search", { request: PARTS[2] }), o("o4", "companies.discover", { request: PARTS[3] }),
      o("o5", "places.discover", { request: PARTS[4] }), o("o6", "web.search", { request: PARTS[5] }), o("o7", "social.comments", { platform: "youtube", request: PARTS[6] }), o("o8", "social.parents", { platform: "facebook", request: PARTS[7] }),
    ],
  };
  /** The worker finishes planning each new mission at once (a plan waiting for the customer never blocks a new request): only the per-turn cap applies. */
  const fastWorker = (db: any) => { for (const m of missions(db)) if (m.status === "queued") m.status = "plan_ready"; };

  it("8 parts within the existing limits (3 being planned at once, 5 waiting for the customer at once): all 8 are stored from the first turn, each «كمّل» prepares the next ones, parts 7 and 8 get their missions after the customer approves earlier parts; never a duplicate, never an earlier part expired", async () => {
    scripted([say(EIGHT), say(EIGHT), say(EIGHT), say(EIGHT)]);
    const db = world();
    const t1 = await turn(db, EIGHT_REQUEST);
    expect(t1.r.ok && t1.r.extraMissions).toHaveLength(3);
    const g1 = storedGroupOf(t1.assistant.plan, strict)!;
    expect(g1.parts).toHaveLength(8);
    expect(g1.parts.map((p) => p.outcome)).toEqual(["planned", "planned", "planned", "waiting", "waiting", "waiting", "waiting", "waiting"]);
    for (const part of PARTS) expect(t1.r.contentAr).toContain(part);
    // «كمّل» while the three are still being planned: the open-missions limit refuses, nothing new, nothing lost
    const t2 = await turn(db, "كمّل");
    expect(live(db)).toHaveLength(3);
    expect(storedGroupOf(t2.assistant.plan, strict)!.parts.filter((p) => p.outcome === "waiting")).toHaveLength(5);
    fastWorker(db);
    // the plans are ready: two more fit before five wait for the customer; the 6th would expire the 1st, so it waits, said
    const t3 = await turn(db, "كمّل");
    expect(t3.r.ok && t3.r.extraMissions).toHaveLength(2);
    expect(t3.r.contentAr).toContain(WAITING_ROOM_AR);
    expect(storedGroupOf(t3.assistant.plan, strict)!.parts.map((p) => p.outcome)).toEqual(["planned", "planned", "planned", "planned", "planned", "waiting", "waiting", "waiting"]);
    fastWorker(db);
    expect(missions(db).every((m) => m.status === "plan_ready")).toBe(true);
    // the customer approves the first three on their own cards (each its own approval; the money path is the existing one, proven in multi-objective-research H)
    for (const m of missions(db).slice(0, 3)) m.status = "approved";
    const t4 = await turn(db, "كمّل");
    expect(t4.r.ok && t4.r.extraMissions!.map((c) => PARTS.findIndex((p) => c.contentAr.includes(`«${p}»`)))).toEqual([5, 6, 7]);
    expect(live(db).map((m) => m.request_text).sort()).toEqual([...PARTS].sort());
    expect(missions(db)).toHaveLength(8);
    oneCardPerLiveMission(db);
    expect(storedGroupOf(t4.assistant.plan, strict)!.parts.every((p) => p.outcome === "planned" && p.missionId)).toBe(true);
    // the approved parts were never touched; the new ones wait for their own approval
    expect(missions(db).map((m) => m.status)).toEqual(["approved", "approved", "approved", "plan_ready", "plan_ready", "queued", "queued", "queued"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("when no limit refuses, at most five parts wait for the customer at once: the rest wait (said, stored, no earlier plan expired) and are prepared on «كمّل» once room is made", async () => {
    scripted([say(EIGHT), say(EIGHT)]);
    const db: any = world();
    const base = db.from;
    // the worker plans each mission the moment it exists
    db.from = (name: string) => { const b = base(name); if (name === "missions") { const ins = b.insert; b.insert = (row: any) => ins({ ...row, status: "plan_ready" }); } return b; };
    const t1 = await turn(db, EIGHT_REQUEST);
    expect(t1.r.ok && t1.r.extraMissions).toHaveLength(5);
    expect(storedGroupOf(t1.assistant.plan, strict)!.parts.map((p) => p.outcome).filter((x) => x === "waiting")).toHaveLength(3);
    expect(missions(db).every((m) => m.status === "plan_ready")).toBe(true);
    // the customer cancels one card and approves two
    missions(db)[0].status = "cancelled"; missions(db)[1].status = "approved"; missions(db)[2].status = "approved";
    const t2 = await turn(db, "كمّل");
    expect(t2.r.ok && t2.r.extraMissions).toHaveLength(3);
    expect(missions(db).filter((m) => m.status === "plan_ready")).toHaveLength(5);
    expect(missions(db).filter((m) => (m as any).summary_ar === "انتهت صلاحية الخطة")).toHaveLength(0);
  });
});

// =====================================================================================================================================================================================================================================
describe("ISSUE 3. splitting never invents, drops or alters a requirement; what cannot be established is ASKED (never refused, never silently changed)", () => {
  it("pure: a part that adds a period, a language, a place or a field the customer never wrote is caught; one that carries the customer's own is not", () => {
    const words = ["عايز تعليقات تيك توك عن السياحة آخر شهر بالعربي مع عدد المشاهدات، وتقييمات فنادق الغردقة"];
    expect(inventedRequirementOf("تعليقات تيك توك عن السياحة آخر شهر بالعربي مع عدد المشاهدات", words)).toBeNull();
    expect(inventedRequirementOf("تقييمات فنادق الغردقة", words)).toBeNull();
    expect(inventedRequirementOf("تقييمات فنادق الغردقة في مصر", words)).toBeNull(); // the city's own country
    expect(inventedRequirementOf("تقييمات فنادق شرم الشيخ", words)).toMatchObject({ kind: "place", key: "EG:sharm" });
    expect(inventedRequirementOf("تعليقات تيك توك عن السياحة", ["تعليقات تيك توك عن السياحة"])).toBeNull();
    expect(inventedRequirementOf("تعليقات تيك توك عن السياحة آخر سنة", ["تعليقات تيك توك عن السياحة"])).toMatchObject({ kind: "period" });
    expect(inventedRequirementOf("تعليقات تيك توك عن السياحة بالإنجليزي", ["تعليقات تيك توك عن السياحة"])).toMatchObject({ kind: "language" });
    expect(inventedRequirementOf("تعليقات تيك توك عن السياحة مع عدد المشاهدات", ["تعليقات تيك توك عن السياحة"])).toMatchObject({ kind: "field", field: "views" });
  });

  it("pure: a requirement of the whole request that no part carries is found (period, language, city, field, number); one carried by any part is not", () => {
    const whole = "عايز ٥٠ تعليق تيك توك عن السياحة آخر شهر بالعربي مع عدد المشاهدات، وتقييمات فنادق الغردقة";
    expect(droppedRequirementsOf(whole, ["هات ٥٠ تعليق تيك توك عن السياحة آخر شهر بالعربي مع عدد المشاهدات", "تقييمات فنادق الغردقة"])).toEqual([]);
    expect(droppedRequirementsOf(whole, ["هات تعليقات تيك توك عن السياحة", "تقييمات فنادق"]).map((r) => r.kind).sort()).toEqual(["field", "language", "number", "period", "place"]);
    expect(droppedRequirementsOf(REQUEST, [TIKTOK_PART, HOTELS_PART, NEWS_PART])).toEqual([]);
  });

  it("the model's part DROPS the customer's period: nothing is prepared, the customer is asked which part it belongs to; the corrected split is then prepared whole", async () => {
    const asked = "عايز تعليقات تيك توك عن السياحة آخر شهر، وتقييمات فنادق الغردقة، وآخر الأخبار عن السياحة في مصر";
    scripted([say(THREE({ request: asked })), say(THREE({ request: asked, tiktok: "هات تعليقات تيك توك عن السياحة آخر شهر" }))]);
    const db = world();
    const first = await turn(db, asked);
    expect(first.r.ok).toBe(false);
    expect(first.r.contentAr).toContain("«الفترة الزمنية»");
    expect(first.r.contentAr).toContain("أنهي جزء");
    expect(missions(db)).toHaveLength(0);
    expect(lastOutcome()).toBe("group_intent_dropped");
    expect(first.assistant.plan.researchBrief.status).toBe("needs_clarification");
    const second = await turn(db, "آخر شهر ده للتيك توك بس");
    expect(second.r.ok && second.r.extraMissions).toHaveLength(3);
    expect(live(db).map((m) => m.request_text)).toContain("هات تعليقات تيك توك عن السياحة آخر شهر");
  });

  it("the model's part DROPS the customer's number: asked, never prepared without it", async () => {
    const asked = "عايز ٥٠ فندق في الغردقة بتقييماتهم، وتعليقات تيك توك عن السياحة";
    scripted([say({ request: asked, platforms: ["tiktok"], content: ["comments", "places", "reviews"], objectives: [o("o1", "places.discover", { request: "فنادق الغردقة" }), o("o2", "places.reviews", { parent: "o1" }), o("o3", "social.comments", { platform: "tiktok", request: TIKTOK_PART })] })]);
    const db = world();
    const { r } = await turn(db, asked);
    expect(r.ok).toBe(false);
    expect(r.contentAr).toContain("«العدد ٥٠»");
    expect(missions(db)).toHaveLength(0);
  });

  it("the model's part CHANGES the city (Hurghada → Sharm): that part is asked and never created with a place the customer did not write; the customer's own city stays in the brief; the other parts go on", async () => {
    scripted([say(THREE({ hotels: "تقييمات فنادق شرم الشيخ" }))]);
    const db = world();
    const { r, assistant } = await turn(db, REQUEST);
    expect(r.contentAr).toContain("«شرم الشيخ» وانت ما ذكرتهوش");
    expect(live(db).map((m) => m.request_text)).toEqual([TIKTOK_PART, NEWS_PART]);
    const group = storedGroupOf(assistant.plan, strict)!;
    expect(group.parts.map((p) => p.outcome)).toEqual(["planned", "needs_clarification", "planned"]);
    expect(group.brief.request).toContain("الغردقة");
  });

  it("the model's part ADDS a period the customer never wrote (the city and the whole request intact): only that part is asked, the others are prepared", async () => {
    scripted([say(THREE({ news: "آخر الأخبار عن السياحة في مصر آخر شهر" }))]);
    const db = world();
    const { r, assistant } = await turn(db, REQUEST);
    expect(live(db).map((m) => m.request_text)).toEqual([TIKTOK_PART, HOTELS_PART]);
    expect(r.contentAr).toContain("«الفترة الزمنية» وانت ما ذكرتهوش");
    expect(storedGroupOf(assistant.plan, strict)!.parts.map((p) => p.outcome)).toEqual(["planned", "planned", "needs_clarification"]);
    // a number the customer never wrote is the existing check's: asked too
    scripted([say(THREE({ news: "آخر ٣٠ خبر عن السياحة في مصر" }))]);
    const db2 = world();
    const r2 = await turn(db2, REQUEST);
    expect(live(db2).map((m) => m.request_text)).toEqual([TIKTOK_PART, HOTELS_PART]);
    expect(r2.r.contentAr).toContain("محتاج توضيح");
  });

  it("a clarification of a group KEEPS the group: the next turn keeps the prepared parts (no second mission) and prepares only the asked one", async () => {
    scripted([say(THREE()), say(THREE({ request: `${REQUEST} آخر شهر` })), say(THREE({ request: `${REQUEST} آخر شهر`, news: `${NEWS_PART} آخر شهر` }))]);
    const db = world();
    await turn(db, REQUEST);
    const ids = live(db).map((m) => m.id);
    const ask = await turn(db, "والأخبار تكون آخر شهر");
    expect(ask.r.contentAr).toContain("«الفترة الزمنية»");
    expect(storedGroupOf(ask.assistant.plan, strict)!.parts.map((p) => p.missionId)).toEqual(ids);
    expect(live(db).map((m) => m.id)).toEqual(ids);
    const fix = await turn(db, "للأخبار بس");
    expect(fix.r.ok && fix.r.extraMissions).toHaveLength(1);
    expect(live(db).map((m) => m.request_text)).toEqual([TIKTOK_PART, HOTELS_PART, `${NEWS_PART} آخر شهر`]);
    oneCardPerLiveMission(db);
  });

  it("no false question: the legitimate multi-part requests of the acceptance set split without any intent question", async () => {
    scripted([say(THREE())]);
    const db = world();
    const { r } = await turn(db, REQUEST);
    expect(r.ok && r.extraMissions).toHaveLength(3);
    expect(r.contentAr).not.toContain("مش واضح يخص أنهي جزء");
    expect(r.contentAr).not.toContain("ما ذكرتهوش");
  });
});

// =====================================================================================================================================================================================================================================
describe("ISSUE 4. the cards the customer sees: after the answer, after a reload, connected to their missions, priced, approvable each on its own, never doubled", () => {
  it("after the answer and after a reload the page shows the SAME cards (same ids, same missions, same order), the summary draws none, and a repeated answer adds nothing", async () => {
    scripted([say(THREE())]);
    const db = world();
    const { r } = await turn(db, REQUEST);
    if (!r.ok) throw new Error("expected cards");
    const afterAnswer = partCardMessagesOf(r.extraMissions, "now");
    const afterReload = reload(db).filter((m) => m.mission);
    expect(afterAnswer.map((m) => [m.id, m.agentMissionId])).toEqual(afterReload.map((m) => [m.id, m.mission]));
    expect(reload(db).find((m) => m.role === "assistant" && !m.mission)!.id).toBe("a" + String(seq));
    const page = appendNewMessages(appendNewMessages([], afterAnswer), afterAnswer);
    expect(page).toHaveLength(3);
    expect(partCardMessagesOf([{ id: "not-a-mission", messageId: "m" }, { id: "msn_aaaaaaaaaaaaaaaaaaaa", messageId: "" }, null], "now")).toEqual([]);
  });

  it("each card draws ITS mission: once the worker priced the parts, every card shows its own price and its own «اعتمد» button", async () => {
    scripted([say(THREE())]);
    const db = world();
    const { r } = await turn(db, REQUEST);
    if (!r.ok) throw new Error("expected cards");
    const prices = [120, 450, 80];
    live(db).forEach((m: any, i) => Object.assign(m, {
      status: "plan_ready", reserved_points: prices[i], unit_price_points: 1, created_at: "2026-11-12T09:00:00Z",
      plan_public: { summary_ar: `خطة ${m.request_text}`, assumptions_ar: [], notes_ar: [], stages: [{ key: "a", title_ar: "البيانات", endpoint_id: "e", expected_rows: prices[i], planned_rows: prices[i], parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] }], price: { max_charge_points: prices[i], reserve_points: prices[i] } },
    }));
    db.seed("agent_worker_heartbeat", [{ beat_at: new Date().toISOString() }]);
    const html: string[] = [];
    for (const card of r.extraMissions!) {
      const loaded = await loadCustomerMission(db, { id: card.id, userId: USER });
      if (!loaded.ok) throw new Error("card's mission not found");
      html.push(renderToStaticMarkup(createElement(AgentMissionCardBody, { view: loaded.view, isGuest: false })));
    }
    html.forEach((h, i) => {
      expect(h).toContain('data-testid="agent-approve"');
      expect(h).toContain('data-testid="agent-price"');
      expect(h).toContain(`خطة ${live(db)[i].request_text}`);
    });
    expect(new Set(html).size).toBe(3);
  });
});
