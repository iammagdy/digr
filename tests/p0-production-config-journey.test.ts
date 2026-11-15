import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { RAW_PATH } from "../agent/src/gateway";
import { namedSourceTruthAr } from "../agent/src/finalize";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { agentChatTurn, AGENT_TURN_CONTENT_AR, CHAT_RESEARCH_BRIEF_FLAG_KEY, FOLLOW_UP_STARTED_AR } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { CAPABILITY_DISCOVERY_FLAG_KEY } from "../src/lib/agentMission/capabilities";
import { SOURCE_OPTIONS_AR } from "../src/lib/agentMission/foundation/sourceScope";

/**
 * PRODUCTION ACTIVATION, 15 NOV 2026: the P0 incident (msn_93ed6dea95edb303fd2b, msn_fefee20b5a4dfc1aafc2, msn_dd7c2e9c131b8783bf2e) replayed with the PRODUCTION CONFIGURATION the owner switched on for every customer:
 * `chat_research_brief_v1` = true and `capability_discovery_v1` = true (global values, not test-account scopes), X on. The real chat turn (a scripted model writing the brief the real model wrote in the live evaluation of
 * 14 Nov 2026) creates the mission; the worker's compiled planning reads it over the RECORDED production pool. No network, no paid call, no money moved.
 */
const fx = JSON.parse(readFileSync(new URL("./fixtures/p0-x-account/production-2026-11-14.json", import.meta.url), "utf8")) as {
  missions: Record<string, { request_text: string; created_at: string; pool_page?: unknown }>;
};
const M1 = fx.missions.msn_93ed6dea95edb303fd2b;
const M2 = fx.missions.msn_fefee20b5a4dfc1aafc2;
const M3 = fx.missions.msn_dd7c2e9c131b8783bf2e;
const catalog = loadTregCatalog();
const USER = "7d2f1c3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
/** Made up for the test: the real handle is never guessed by code or by this test. */
const HANDLE = "ExampleMinistry";
const PRODUCTION_SETTINGS = [
  { key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: true },
  { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: true },
  { key: "redesign_flags", value: { x: "on", tiktok: "on", youtube: "on", facebook: "on", instagram: "on" } },
];

let script: Array<Record<string, unknown>> = [];
const brief = (o: Record<string, unknown>) => ({ status: "ready", platforms: ["x"], content: ["posts"], count: null, topic: "", source: "", period: "", country: "", language: "", ...o });
const say = (b: Record<string, unknown>) => ({ type: "data_request", reason: "scripted", reply: "", count: null, brief: b });
function world() {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 5000 }]);
  db.seed("mission_events", []);
  db.seed("messages", []);
  db.seed("missions", []);
  db.seed("agent_settings", PRODUCTION_SETTINGS);
  return db;
}
let seq = 0;
async function turn(db: any, message: string) {
  seq += 1;
  const at = Date.parse("2026-11-15T09:00:00Z") + seq * 2000;
  db.seed("messages", [
    { id: `u${seq}`, conversation_id: "conv1", user_id: USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date(at).toISOString() },
    { id: `a${seq}`, conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "…", created_at: new Date(at + 1).toISOString() },
  ]);
  const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: `u${seq}`, assistantMsgId: `a${seq}`, message, conversationTitle: "محادثة جديدة" });
  return { r };
}
const live = (db: any) => (db.rows("missions") as Array<{ id: string; status: string; request_text: string }>).filter((m) => m.status !== "cancelled");

/** The worker's compiled planning of one mission, over a recorded page (every provider call answered from it, recorded). */
async function plan(request_text: string, extra: Record<string, unknown> = {}, page: unknown = M3.pool_page) {
  const store = createMemoryStore();
  const queries: string[] = [];
  let n = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      n += 1;
      queries.push(JSON.stringify(input.params ?? {}));
      const id = `call_${String(n).padStart(4, "0")}`;
      await store.putFile("msn_t", RAW_PATH(id), JSON.stringify(page), "application/json");
      const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!);
      return { ok: true as const, call_id: id, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: null };
    },
  };
  const r = await planByCompiler({ mission: { id: "msn_t", request_text, answer_text: (extra.answer as string) ?? null, created_at: M2.created_at } as never, gateway: gateway as never, store, catalog, nowMs: Date.parse(M3.created_at), ...extra });
  return { r, queries };
}
const tweet = (id: string, username: string, text: string) => ({ id, text, authorName: `name_${username}`, authorUsername: username, createdUtc: "2026-11-10T10:00:00.000Z", url: `https://x.com/${username}/status/${id}`, isReply: false, lang: "ar", likeCount: 1, retweetCount: 0, replyCount: 0, quoteCount: 0, viewCount: 10 });
const pageOf = (items: unknown[]) => ({ output: { data: { items, nextCursor: null } } });

describe("the incident with the production configuration (understanding layer and capability discovery ON for everyone)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    setChatModelForTesting(async () => {
      const s = script.shift();
      return s ? { ok: true, text: JSON.stringify(s), usage: { inputTokens: 1500, outputTokens: 220 } } : { ok: false, failure: "http_529" };
    });
  });
  afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("msn_93ed's words: ONE mission keeps the platform, the count, the period, the topic AND the ministry as the source; planning asks for the identifier before anything is read, held or priced", async () => {
    script = [say(brief({ request: "جمع ٤٠٠ تغريدة على إكس من حساب وزارة الصحة السعودية عن الشائعات الصحية خلال آخر ٣ أشهر", count: 400, topic: "الشائعات الصحية", source: "وزارة الصحة السعودية", period: "آخر ٣ أشهر" }))];
    const db = world();
    const { r } = await turn(db, M1.request_text);
    expect(r).toMatchObject({ ok: true, contentAr: AGENT_TURN_CONTENT_AR });
    expect(live(db)).toHaveLength(1);
    const text = live(db)[0].request_text;
    const ask = buildAsk(text, null, Date.parse("2026-11-15T09:00:00Z"));
    expect(ask.platform).toBe("x");
    expect(ask.source).toMatchObject({ kind: "named" });
    expect(String((ask.source as { text?: string }).text)).toMatch(/وزارة الصحة السعودية/);
    expect(text).toMatch(/٤٠٠|400/);
    expect(text).toMatch(/آخر ٣ أشهر/);
    const { r: p, queries } = await plan(text);
    if (p.kind !== "question") throw new Error(p.kind);
    expect(p.why).toBe("source_id");
    expect(p.question).toMatch(/لا نخمّنه/);
    expect(p.options).toEqual([SOURCE_OPTIONS_AR.widen, SOURCE_OPTIONS_AR.cancel]);
    expect(queries).toEqual([]);
  });

  it("a model that DROPS the source is refused by code: no mission searching all of X is created from the reduced words", async () => {
    script = [say(brief({ request: "جمع ٤٠٠ تغريدة على إكس عن الشائعات الصحية خلال آخر ٣ أشهر", count: 400, topic: "الشائعات الصحية", period: "آخر ٣ أشهر" }))];
    const db = world();
    await turn(db, M1.request_text);
    for (const m of live(db)) {
      const { r: p, queries } = await plan(m.request_text);
      expect(p.kind === "question" ? p.why : p.kind).toBe("source_id");
      expect(queries).toEqual([]);
    }
  });

  it("msn_dd7c: «طيب ابحث عن الشائعات فقط» after the request ENDED keeps the ministry, X and 400; planning asks for the identifier", async () => {
    const db = world();
    // the conversation as production holds it: the customer's first request, its card, and the mission that ended unserved
    db.seed("messages", [
      { id: "u0", conversation_id: "conv1", user_id: USER, role: "user", content_ar: M2.request_text, created_at: "2026-11-15T08:58:00.000Z" },
      { id: "a0", conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: AGENT_TURN_CONTENT_AR, plan: { agentMissionId: "msn_ended0000000001" }, created_at: "2026-11-15T08:58:00.001Z" },
    ]);
    db.seed("missions", [{ id: "msn_ended0000000001", user_id: USER, conversation_id: "conv1", status: "unserved", request_text: M2.request_text, created_at: "2026-11-15T08:58:00Z" }]);
    script = [say(brief({ request: "جمع ٤٠٠ تغريدة على إكس من حساب وزارة الصحة السعودية عن الشائعات", count: 400, topic: "الشائعات", source: "وزارة الصحة السعودية" }))];
    const { r } = await turn(db, M3.request_text);
    expect(r.ok).toBe(true);
    const created = live(db).filter((m) => m.id !== "msn_ended0000000001");
    expect(created).toHaveLength(1);
    const text = created[0].request_text;
    expect(buildAsk(text, null, Date.now()).platform).toBe("x");
    expect(text).toMatch(/وزارة الصحة السعودية/);
    expect(text).toMatch(/٤٠٠|400/);
    const { r: p, queries } = await plan(text);
    expect(p.kind === "question" ? p.why : p.kind).toBe("source_id");
    expect(queries).toEqual([]);
    expect(FOLLOW_UP_STARTED_AR).toMatch(/لن يُخصم شيء قبل موافقتك/);
  });

  it("the identifier given: every search is restricted to it; on the recorded pool (40 tweets of 38 OTHER accounts) nothing is priced; on a mixed page only the source's own rows are planned and 400 is not promised", async () => {
    const text = "جمع ٤٠٠ تغريدة على إكس من حساب وزارة الصحة السعودية عن الشائعات الصحية خلال آخر ٣ أشهر";
    const recorded = await plan(text, { answer: `@${HANDLE}`, choices: { sourceId: HANDLE }, answerIsChoice: true });
    for (const q of recorded.queries) expect(q).toMatch(new RegExp(`from:${HANDLE}`));
    expect(recorded.r.kind).not.toBe("plan");
    const mixed = await plan(text, { answer: `@${HANDLE}`, choices: { sourceId: HANDLE }, answerIsChoice: true }, pageOf([tweet("11", HANDLE, "تحذير من الشائعات الصحية"), tweet("12", "other_account", "الشائعات الصحية"), tweet("13", `${HANDLE}_fan`, "الشائعات الصحية")]));
    if (mixed.r.kind !== "plan") throw new Error(mixed.r.kind);
    for (const q of mixed.queries) expect(q).toMatch(new RegExp(`from:${HANDLE}`));
    expect((mixed.r.plan.stages[0].pinned_rows as Array<{ id: string }>).map((x) => x.id)).toEqual(["11"]);
    expect(mixed.r.plan.notes_ar!.join(" ")).toMatch(/قد يكون أقل من المطلوب/);
  });

  it("a delivery whose items are not the named source's is said to be partial, never «fulfilled»", () => {
    const all = namedSourceTruthAr({ source: "وزارة الصحة السعودية", delivered: 79, notFromSource: 79 });
    expect(all).toMatch(/تسليم جزئي/);
  });
});
