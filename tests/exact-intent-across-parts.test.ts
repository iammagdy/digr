import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { REPLAY_USER } from "./helpers/agentReplay";
import { agentChatTurn, CHAT_RESEARCH_BRIEF_FLAG_KEY } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting, type ChatModelInput } from "../src/lib/agentMission/chatModel";
import { parseBrief } from "../src/lib/agentMission/researchBrief";
import { conditionDriftOf, partBriefOf, partsOf, storedGroupOf } from "../src/lib/agentMission/researchGroup";
import { CAPABILITY_DISCOVERY_FLAG_KEY } from "../src/lib/agentMission/capabilities";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { preModelAnswer } from "../src/lib/agentMission/guardRules";

/**
 * EXACT CUSTOMER REQUIREMENTS ACROSS RESEARCH PARTS (docs/MULTI-OBJECTIVE-RESEARCH.md section 12), OFFLINE through the real chat turn (a SCRIPTED model in the real JSON format, the real validation, the real mission creation) on the
 * in-memory database. The end-to-end execution of a part with its exact conditions (chat → worker planning → the customer's own approval → execution → settlement) is in multi-objective-research «H». No network, no paid call.
 */
type Obj = { id: string; operation: string; platform?: string; parent?: string; request?: string; period?: string; country?: string; language?: string; count?: number };
const o = (id: string, operation: string, x: Partial<Obj> = {}): Obj => ({ id, operation, ...x });
const briefOf = (b: Record<string, unknown>) => ({ status: "ready", platforms: [], content: [], count: null, topic: "", period: "", country: "", language: "", ...b });
const say = (brief: Record<string, unknown>, reply = "") => ({ type: "data_request", reason: "x", reply, count: null, brief: briefOf(brief) });
let modelCalls: ChatModelInput[] = [];
function scripted(steps: Array<Record<string, unknown>>) {
  modelCalls = [];
  const script = [...steps];
  setChatModelForTesting(async (input) => {
    modelCalls.push(input);
    const s = script.shift();
    return s ? { ok: true, text: JSON.stringify(s), usage: { inputTokens: 1800, outputTokens: 450 } } : { ok: false, failure: "http_529" };
  });
}

const USER = REPLAY_USER;
function world() {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 5000 }]);
  for (const t of ["mission_events", "messages", "missions"]) db.seed(t, []);
  db.seed("agent_settings", [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: [USER] } }, { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: [USER] } }]);
  const base = db.from;
  // the database's own default (created_at now()): a mission row without it reads as an expired plan
  db.from = (name: string) => { const b = base(name); if (name === "missions") { const ins = b.insert; b.insert = (row: any) => ins(row.created_at ? row : { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); } return b; };
  return db;
}
let seq = 0;
async function turn(db: any, message: string) {
  seq += 1;
  const at = Date.parse("2026-11-12T09:00:00Z") + seq * 10_000;
  db.rows("messages").push(
    { id: `u${seq}`, conversation_id: "conv1", user_id: USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date(at).toISOString() },
    { id: `a${seq}`, conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "…", created_at: new Date(at + 1).toISOString() },
  );
  const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: `u${seq}`, assistantMsgId: `a${seq}`, message, conversationTitle: "محادثة جديدة" });
  return { r, assistant: db.rows("messages").find((m: any) => m.id === `a${seq}`) };
}
const missions = (db: any) => db.rows("missions") as Array<{ id: string; status: string; request_text: string; job_id?: string | null }>;
const live = (db: any) => missions(db).filter((m) => m.status !== "cancelled");
const strict = (raw: unknown) => { const p = parseBrief(raw); return p.ok ? p.brief : null; };
const outcomes = (a: any) => storedGroupOf(a.plan, strict)!.parts.map((p) => p.outcome);
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => { throw new Error("no network in this test"); });
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// the customer's request and the parts a faithful model writes
const REQ = "عايز تعليقات تيك توك عن السياحة آخر شهر، وتقييمات فنادق الغردقة، وآخر الأخبار عن السياحة في مصر";
const TIKTOK = "هات تعليقات تيك توك عن السياحة آخر شهر";
const HOTELS = "تقييمات فنادق الغردقة";
const NEWS = "آخر الأخبار عن السياحة في مصر";
const three = (x: { tiktok?: string; hotels?: string; news?: string; request?: string; tiktokOwn?: Partial<Obj>; hotelsOwn?: Partial<Obj>; newsOwn?: Partial<Obj>; global?: Record<string, unknown> } = {}) => ({
  request: x.request ?? REQ, platforms: ["tiktok"], content: ["comments", "places", "reviews"], ...(x.global ?? {}),
  objectives: [
    o("o1", "social.parents", { platform: "tiktok", request: x.tiktok ?? TIKTOK, ...(x.tiktokOwn ?? { period: "آخر شهر" }) }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }),
    o("o3", "places.discover", { request: x.hotels ?? HOTELS, ...(x.hotelsOwn ?? { country: "الغردقة" }) }), o("o4", "places.reviews", { parent: "o3" }),
    o("o5", "web.search", { request: x.news ?? NEWS, ...(x.newsOwn ?? { country: "مصر" }) }), o("o6", "web.read", { parent: "o5" }),
  ],
});

describe("exact values: a part executes the customer's own period, place, language and number, or is asked; it is never created on another value", () => {
  it("baseline: the faithful split is prepared whole; each part brief keeps the customer's own conditions as structured fields; nothing is fetched, nothing approved", async () => {
    scripted([say(three())]);
    const db = world();
    const { r, assistant } = await turn(db, REQ);
    expect(r.ok && r.extraMissions).toHaveLength(3);
    expect(live(db).map((m) => m.request_text)).toEqual([TIKTOK, HOTELS, NEWS]);
    expect(outcomes(assistant)).toEqual(["planned", "planned", "planned"]);
    // the structured requirements travel with each card (what the worker reads), never a value the customer did not write
    const cards = db.rows("messages").filter((m: any) => m.plan?.agentMissionId);
    expect(cards.map((c: any) => [c.plan.researchBrief.period, c.plan.researchBrief.country])).toEqual([["آخر شهر", null], [null, "الغردقة"], [null, "مصر"]]);
    // no mission runs before the customer's own approval
    expect(missions(db).every((m) => m.status === "queued" && !m.job_id)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("LAST MONTH must not become LAST YEAR: the drifting part is asked and never created (with or without the model's attribution); the others go on", async () => {
    for (const tiktokOwn of [{ period: "آخر شهر" }, {}]) {
      scripted([say(three({ tiktok: "هات تعليقات تيك توك عن السياحة آخر سنة", tiktokOwn }))]);
      const db = world();
      const { r, assistant } = await turn(db, REQ);
      expect(live(db).map((m) => m.request_text)).toEqual([HOTELS, NEWS]);
      expect(outcomes(assistant)).toEqual(["needs_clarification", "planned", "planned"]);
      expect(r.contentAr).toContain("شرط الفترة");
    }
  });

  it("relative dates keep their meaning: the part's sentence is read with the same moment and the same reader the worker executes with, so the executed window is the customer's", async () => {
    scripted([say(three())]);
    const db = world();
    await turn(db, REQ);
    const now = Date.parse("2026-11-12T09:00:00Z");
    const tiktok = live(db).find((m) => m.request_text === TIKTOK)!;
    expect(buildAsk(tiktok.request_text, null, now).period).toEqual(buildAsk("آخر شهر", null, now).period);
    expect(buildAsk(tiktok.request_text, null, now).period).not.toEqual(buildAsk("آخر سنة", null, now).period);
  });

  it("EGYPT must not become another country", async () => {
    scripted([say(three({ news: "آخر الأخبار عن السياحة في السعودية", request: `${REQ} والسعودية` }))]);
    const db = world();
    const { assistant } = await turn(db, `${REQ} والسعودية`);
    expect(live(db).map((m) => m.request_text)).toEqual([TIKTOK, HOTELS]);
    expect(outcomes(assistant)[2]).toBe("needs_clarification");
  });

  it("HURGHADA must not become CAIRO, even when the customer named Cairo for another part", async () => {
    const req = "عايز تقييمات فنادق الغردقة، وشركات السياحة في القاهرة";
    scripted([say({ request: req, content: ["places", "reviews", "companies"], objectives: [o("o1", "places.discover", { request: "تقييمات فنادق القاهرة", country: "الغردقة" }), o("o2", "places.reviews", { parent: "o1" }), o("o3", "companies.discover", { request: "شركات السياحة في القاهرة", country: "القاهرة" })] })]);
    const db = world();
    const { r, assistant } = await turn(db, req);
    expect(live(db).map((m) => m.request_text)).toEqual(["شركات السياحة في القاهرة"]);
    expect(outcomes(assistant)).toEqual(["needs_clarification", "planned"]);
    expect(r.contentAr).toContain("«الغردقة»");
  });

  it("a country must not be narrowed to a city the customer never chose", () => {
    expect(conditionDriftOf({ partRequest: "فنادق القاهرة", own: { country: "مصر" }, global: {}, elsewhere: new Set(), customerTexts: ["فنادق في مصر"], nowMs: Date.now() })).toMatchObject({ kind: "place", reason: "contradicts" });
  });

  it("ARABIC must not become ENGLISH", async () => {
    const req = "عايز تعليقات تيك توك عن السياحة بالعربي، وتقييمات فنادق الغردقة";
    scripted([say({ request: req, platforms: ["tiktok"], content: ["comments", "places", "reviews"], objectives: [o("o1", "social.comments", { platform: "tiktok", request: "تعليقات تيك توك عن السياحة بالإنجليزي", language: "بالعربي" }), o("o2", "places.discover", { request: HOTELS, country: "الغردقة" }), o("o3", "places.reviews", { parent: "o2" })] })]);
    const db = world();
    const { r } = await turn(db, req);
    expect(live(db).map((m) => m.request_text)).toEqual([HOTELS]);
    expect(r.contentAr).toContain("شرط لغة المحتوى");
  });

  it("100 COMMENTS must not become 1,000 (whether the customer wrote 1,000 for another part or never wrote it)", async () => {
    const req = "عايز ١٠٠ تعليق تيك توك عن السياحة، و١٠٠٠ منشور فيسبوك عن الفنادق";
    const brief = (tiktok: string) => ({ request: req, platforms: ["facebook", "tiktok"], content: ["comments"], objectives: [o("o1", "social.comments", { platform: "tiktok", request: tiktok, count: 100 }), o("o2", "social.parents", { platform: "facebook", request: "هات ١٠٠٠ منشور فيسبوك عن الفنادق", count: 1000 })] });
    scripted([say(brief("هات ١٠٠٠ تعليق تيك توك عن السياحة"))]);
    const db = world();
    const { r } = await turn(db, req);
    expect(live(db).map((m) => m.request_text)).toEqual(["هات ١٠٠٠ منشور فيسبوك عن الفنادق"]);
    expect(r.contentAr).toContain("شرط العدد");
    // the customer wrote only 100: 1,000 is refused by the existing number check
    const req2 = "عايز ١٠٠ تعليق تيك توك عن السياحة، وتقييمات فنادق الغردقة";
    scripted([say({ request: req2, platforms: ["tiktok"], content: ["comments", "places", "reviews"], objectives: [o("o1", "social.comments", { platform: "tiktok", request: "هات ١٠٠٠ تعليق تيك توك عن السياحة" }), o("o2", "places.discover", { request: HOTELS }), o("o3", "places.reviews", { parent: "o2" })] })]);
    const db2 = world();
    await turn(db2, req2);
    expect(live(db2).map((m) => m.request_text)).toEqual([HOTELS]);
  });

  it("COMMENTS must not silently lose REPLIES: a part whose sentence asks them without a replies objective is asked; a split that drops them everywhere is asked", async () => {
    const req = "عايز تعليقات تيك توك عن السياحة وردودها، وتقييمات فنادق الغردقة";
    scripted([say({ request: req, platforms: ["tiktok"], content: ["comments", "places", "reviews"], objectives: [o("o1", "social.parents", { platform: "tiktok", request: "هات تعليقات تيك توك عن السياحة وردودها" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "places.discover", { request: HOTELS }), o("o4", "places.reviews", { parent: "o3" })] })]);
    const db = world();
    const { r } = await turn(db, req);
    expect(live(db).map((m) => m.request_text)).toEqual([HOTELS]);
    expect(r.contentAr).toContain("من غير ردودها");
    scripted([say({ request: req, platforms: ["tiktok"], content: ["comments", "places", "reviews"], objectives: [o("o1", "social.parents", { platform: "tiktok", request: "هات تعليقات تيك توك عن السياحة" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "places.discover", { request: HOTELS }), o("o4", "places.reviews", { parent: "o3" })] })]);
    const db2 = world();
    const r2 = await turn(db2, req);
    expect(missions(db2)).toHaveLength(0);
    expect(r2.r.contentAr).toContain("«الردود»");
    // with the replies objective, the part is prepared whole
    scripted([say({ request: req, platforms: ["tiktok"], content: ["comments", "replies", "places", "reviews"], objectives: [o("o1", "social.parents", { platform: "tiktok", request: "هات تعليقات تيك توك عن السياحة وردودها" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o5", "social.replies", { platform: "tiktok", parent: "o2" }), o("o3", "places.discover", { request: HOTELS }), o("o4", "places.reviews", { parent: "o3" })] })]);
    const db3 = world();
    await turn(db3, req);
    expect(live(db3)).toHaveLength(2);
  });
});

describe("whole-request conditions and one-part conditions", () => {
  const REQ_ALL = "عايز تعليقات تيك توك عن السياحة، وأخبار السياحة في مصر، وكل ده آخر شهر";
  const both = (tiktok: string, news: string) => ({ request: REQ_ALL, platforms: ["tiktok"], content: ["comments"], period: "آخر شهر", objectives: [o("o1", "social.comments", { platform: "tiktok", request: tiktok }), o("o2", "web.search", { request: news, country: "مصر" })] });

  it("a GLOBAL condition must not disappear from any part: the part that lost it is asked, the part that keeps it goes on", async () => {
    scripted([say(both("هات تعليقات تيك توك عن السياحة آخر شهر", "أخبار السياحة في مصر"))]);
    const db = world();
    const { r, assistant } = await turn(db, REQ_ALL);
    expect(live(db).map((m) => m.request_text)).toEqual(["هات تعليقات تيك توك عن السياحة آخر شهر"]);
    expect(outcomes(assistant)).toEqual(["planned", "needs_clarification"]);
    expect(r.contentAr).toContain("«آخر شهر»");
    scripted([say(both("هات تعليقات تيك توك عن السياحة آخر شهر", "أخبار السياحة في مصر آخر شهر"))]);
    const db2 = world();
    await turn(db2, REQ_ALL);
    expect(live(db2)).toHaveLength(2);
  });

  it("a ONE-PART condition is never forced onto every part: the other parts are created without it; a part that borrows it is asked", async () => {
    scripted([say(three())]);
    const db = world();
    await turn(db, REQ);
    expect(live(db).map((m) => m.request_text)).toEqual([TIKTOK, HOTELS, NEWS]);
    expect(live(db).filter((m) => m.request_text.includes("آخر شهر"))).toHaveLength(1);
    scripted([say(three({ hotels: "تقييمات فنادق الغردقة آخر شهر" }))]);
    const db2 = world();
    const { r, assistant } = await turn(db2, REQ);
    expect(outcomes(assistant)).toEqual(["planned", "needs_clarification", "planned"]);
    expect(r.contentAr).toContain("قلته لجزء تاني");
  });

  it("partBriefOf: the part's own conditions win, else the whole request's; nothing else is filled in", () => {
    const p = parseBrief(briefOf({ ...three(), period: "آخر سنة" }));
    if (!p.ok) throw new Error(p.issue);
    const briefs = partsOf(p.brief).map((part) => partBriefOf(part, { period: p.brief.period, country: p.brief.country, language: p.brief.language })!);
    expect(briefs.map((b) => [b.period, b.country, b.language])).toEqual([["آخر شهر", null, null], ["آخر سنة", "الغردقة", null], ["آخر سنة", "مصر", null]]);
  });

  it("the schema: per-part conditions live on the part's FIRST objective (a child's condition is that part's, moved there; a conflicting one rejects); a count is a whole number", () => {
    // live evaluation 2026-11-12 (E1, H1): the real model writes the part's period on the child it is about; it is the SAME part's condition, moved to its first objective, never to another part
    const hoisted = parseBrief(briefOf({ ...three(), objectives: [o("o1", "social.parents", { platform: "tiktok", request: TIKTOK }), o("o2", "social.comments", { platform: "tiktok", parent: "o1", period: "آخر شهر" })] }));
    expect(hoisted.ok).toBe(true);
    if (hoisted.ok) {
      expect(hoisted.brief.objectives![0]).toMatchObject({ id: "o1", period: "آخر شهر" });
      expect(hoisted.brief.objectives![1].period).toBeUndefined();
    }
    // the same kind with ANOTHER value on the first objective: ambiguous, rejected (never guessed)
    expect(parseBrief(briefOf({ ...three(), objectives: [o("o1", "social.parents", { platform: "tiktok", request: TIKTOK, period: "آخر أسبوع" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1", period: "آخر شهر" })] }))).toMatchObject({ ok: false, issue: "objectives" });
    // a child whose first objective cannot be reached: rejected
    expect(parseBrief(briefOf({ ...three(), objectives: [o("o2", "social.comments", { platform: "tiktok", parent: "o9", period: "آخر شهر" })] }))).toMatchObject({ ok: false, issue: "objectives" });
    expect(parseBrief(briefOf({ ...three(), objectives: [o("o1", "social.parents", { platform: "tiktok", request: TIKTOK, count: -3 as never })] }))).toMatchObject({ ok: false, issue: "objectives" });
  });
});

describe("corrections, unfamiliar wording, privacy, approval", () => {
  it("a CORRECTION of one part's period updates only that part; an approved part is never touched; the corrected value is the customer's", async () => {
    const tiktokWeek = "هات تعليقات تيك توك عن السياحة آخر أسبوع";
    scripted([say(three()), say(three({ tiktok: tiktokWeek, tiktokOwn: { period: "آخر أسبوع" }, request: REQ.replace("آخر شهر", "آخر أسبوع") }))]);
    const db = world();
    await turn(db, REQ);
    const [tiktok, hotels, news] = live(db);
    // the customer approved the hotels part on its own card (the money path is the existing one)
    hotels.status = "approved";
    const { assistant } = await turn(db, "خلي التيك توك آخر أسبوع بدل آخر شهر");
    expect(missions(db).find((m) => m.id === tiktok.id)!.status).toBe("cancelled");
    expect(missions(db).find((m) => m.id === hotels.id)!.status).toBe("approved");
    expect(missions(db).find((m) => m.id === news.id)!.status).toBe("queued");
    expect(live(db).map((m) => m.request_text).sort()).toEqual([HOTELS, NEWS, tiktokWeek].sort());
    expect(outcomes(assistant)).toEqual(["planned", "planned", "planned"]);
    // the next turn's prompt carries each part's own conditions back to the model
    scripted([say(three({ tiktok: tiktokWeek, tiktokOwn: { period: "آخر أسبوع" }, request: REQ.replace("آخر شهر", "آخر أسبوع") }))]);
    await turn(db, "تمام");
    expect(JSON.stringify(modelCalls[0])).toContain("period=«آخر أسبوع»");
  });

  it("UNFAMILIAR wording is never refused: a condition no reader understands is carried as the customer wrote it and the part is prepared (and asked only if the part drops it)", async () => {
    const req = "عايز تعليقات تيك توك عن السياحة من ساعة ما بدأ الموسم، وتقييمات فنادق الغردقة";
    const brief = (tiktok: string) => ({ request: req, platforms: ["tiktok"], content: ["comments", "places", "reviews"], objectives: [o("o1", "social.comments", { platform: "tiktok", request: tiktok, period: "من ساعة ما بدأ الموسم" }), o("o2", "places.discover", { request: HOTELS }), o("o3", "places.reviews", { parent: "o2" })] });
    scripted([say(brief("هات تعليقات تيك توك عن السياحة من ساعة ما بدأ الموسم"))]);
    const db = world();
    const { r } = await turn(db, req);
    expect(r.ok && r.extraMissions).toHaveLength(2);
    scripted([say(brief("هات تعليقات تيك توك عن السياحة"))]);
    const db2 = world();
    await turn(db2, req);
    expect(live(db2).map((m) => m.request_text)).toEqual([HOTELS]);
  });

  it("the SINGLE request: the consolidated sentence must execute the customer's own period (asked otherwise); a faithful one, and unfamiliar wording, become missions", async () => {
    const req = "هات تعليقات تيك توك عن السياحة آخر شهر";
    scripted([say({ request: "هات تعليقات تيك توك عن السياحة آخر سنة", platforms: ["tiktok"], content: ["comments"], period: "آخر شهر" })]);
    const db = world();
    const { r } = await turn(db, req);
    expect(r.ok).toBe(false);
    expect(r.contentAr).toContain("شرط الفترة");
    expect(missions(db)).toHaveLength(0);
    scripted([say({ request: req, platforms: ["tiktok"], content: ["comments"], period: "آخر شهر" })]);
    const db2 = world();
    expect((await turn(db2, req)).r.ok).toBe(true);
    const odd = "هات تعليقات تيك توك عن السياحة من أول ما الموسم بدأ";
    scripted([say({ request: odd, platforms: ["tiktok"], content: ["comments"], period: "من أول ما الموسم بدأ" })]);
    const db3 = world();
    expect((await turn(db3, odd)).r.ok).toBe(true);
  });

  it("PRIVATE data stays refused: a private part is refused alone, an all-private request is refused before the model; the new checks never re-admit it", async () => {
    const req = "عايز تعليقات تيك توك عن السياحة آخر شهر، وأرقام تليفونات المعلقين";
    scripted([say({ request: req, platforms: ["tiktok"], content: ["comments"], objectives: [o("o1", "social.comments", { platform: "tiktok", request: TIKTOK, period: "آخر شهر" }), o("o2", "unsupported", { request: "أرقام تليفونات المعلقين" } as never)] })]);
    const db = world();
    await turn(db, req);
    expect(live(db).map((m) => m.request_text).every((t) => !t.includes("تليفون"))).toBe(true);
    expect(preModelAnswer("هات أرقام تليفونات الناس اللي علقوا على تيك توك آخر شهر")?.kind).toBe("privacy_refusal");
  });
});
