import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { planByCompiler } from "../agent/src/compiled";
import { readRunState } from "../agent/src/runState";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { YOUTUBE_CHANNEL_DECLINED_AR, YOUTUBE_CHANNEL_QUESTION_AR, YOUTUBE_CHANNEL_UNIDENTIFIED_AR, matchChannel, youtubeChannelNoteAr, youtubeChannelOf } from "../src/lib/agentMission/foundation/youtubeChannel";
import { OCCURRENCE_OPTIONS_AR } from "../src/lib/agentMission/foundation/occurrence";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { NOT_ADMIN, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * ROUND 31. Live QA (4 Nov 2026): «عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي» ended «مصادرنا لا تخدم» after ONE channel-search call that answered (200, one row) and NO video call (`msn_5349f30a20f414417b5a`, `msn_175b3946d0810ce262be`). The planner turned a request with no channel into a lookup of
 * «<topic> الرسمية», a guess that the first result is an official channel. The stored raw page of those calls cannot be read (1,339 bytes, not downloadable here), so whether its one row carried a channel id is NOT known; the stored REAL pages of the same card (M2, calls 3 and 4)
 * map every row with its id and its handle, so no mapping defect is proven. The cure does not depend on it: with no channel in the request the customer is asked ONCE, before anything is read, held or priced; the answer is looked up with the verified channel search and used only if a
 * result carries it; the plan says it is a search inside that channel. No usable answer, or a channel that cannot be identified, ends honestly and charges nothing.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const catalog = loadTregCatalog();
const M2 = "msn_ee599cdbbde993073b15";
const OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" };
const TEST_EMAIL = "iam.magdy+1@outlook.com";
const GENERIC = "عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي";
const CHANNEL_SEARCH = "tikhub.x.youtube-web-v2-search-channels";
const IN_CHANNEL = "tikhub.x.youtube-web-search-channel";
const raw = (call: string) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M2}/raw/${call}.json`, import.meta.url), "utf8")) as { data: { channels?: Array<Record<string, unknown>> } & Record<string, unknown> };

/** The real stored channel-search page (M2 call 4: two channels, each with an id and a handle; the anonymiser made their titles placeholders, so the titles the test needs are written here). */
const IDS = { first: "UC0zCM7UBPakpaVVnZVCntrQ", second: "UCeFU0ebL1MK2KlBFniRs6Iw" };
function lookupPage(rows: Array<Record<string, unknown>>) { const p = raw("call_0004"); p.data.channels = rows; return p; }
const ROWS = [
  { channel_id: IDS.first, title: "قناة الزمالك", handle: "@zamalekfc", subscriber_count_text: "٢ مليون" },
  { channel_id: IDS.second, title: "النادي الأهلي - Al Ahly SC", handle: "@alahlyeg", subscriber_count_text: "٥ مليون" },
];

/** The provider: the channel search answers with `rows`, the in-channel search answers with the stored real page of M2 call 7 (30 videos); every call is recorded. */
function provider(rows: Array<Record<string, unknown>> = ROWS) {
  return vi.fn(async (o: { endpointId: string; params: Record<string, unknown> }) => {
    if (o.endpointId === CHANNEL_SEARCH) return tregResult(lookupPage(rows), 0.001);
    if (o.endpointId === IN_CHANNEL) return tregResult(raw("call_0007"), 0.001);
    return tregResult(null, 0, { ok: false, httpStatus: 404, error: "not_found" });
  });
}

function world(request: string, call = provider()) {
  const store = createMemoryStore();
  const id = "msn_r31_1";
  store.missions.set(id, newMission({ id, user_id: "user_r31", request_text: request, status: "planning", created_at: "2026-11-04T18:12:00Z" }));
  store.userEmails.set("user_r31", TEST_EMAIL);
  Object.assign(store.settings, { redesign_flags: { ...OFF, youtube: "test" } });
  const rec = fakeRecorder();
  const driver = createFakeDriver([{ tool: "ask_question", args: { question_ar: "هل تقصد هذا؟", options_ar: ["نعم", "لا"] } }]);
  const run = vi.spyOn(driver, "run");
  const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
  const plan = async () => { await runPlanning(deps, store.missions.get(id)!); return store.missions.get(id)!; };
  const answer = async (text: string) => { const m = store.missions.get(id)!; store.missions.set(id, { ...m, answer_text: text, status: "planning" } as typeof m); return plan(); };
  const questions = () => store.events.filter((e) => e.kind === "question").length;
  const endpoints = () => call.mock.calls.map((c) => (c[0] as { endpointId: string }).endpointId);
  return { store, id, plan, answer, call, modelRuns: () => run.mock.calls.length, questions, endpoints };
}

describe("the question: a request with no channel", () => {
  it("asks once, in the same mission, with the exact words, before any read, hold, price or model call", async () => {
    const w = world(GENERIC);
    const m = await w.plan();
    expect(m.status).toBe("needs_input");
    expect(m.question_ar).toBe(YOUTUBE_CHANNEL_QUESTION_AR);
    expect(YOUTUBE_CHANNEL_QUESTION_AR).toBe("نقدر نبحث عن الفيديوهات داخل قناة يوتيوب محددة. اكتب اسم القناة أو رابطها عشان نكمل البحث.");
    expect((m.plan_public as { question_options?: string[] } | null)?.question_options).toEqual([]);
    expect(m.plan).toBeNull();
    expect(m.reserved_points ?? 0).toBe(0);
    expect(m.job_id ?? null).toBeNull();
    expect(m.quote_id ?? null).toBeNull();
    expect(w.call).not.toHaveBeenCalled();
    expect(w.modelRuns()).toBe(0);
    expect(w.questions()).toBe(1);
    expect(w.store.missions.size).toBe(1);
    expect((await readRunState(w.store, w.id)).pending).toBe("youtube_channel");
    expect(checkCustomerText(YOUTUBE_CHANNEL_QUESTION_AR).issues).toEqual([]);
  });

  it("the failure shape of the live QA («عامة»): the same, nothing is looked up as «<topic> الرسمية» any more", async () => {
    const w = world("عايز ١٠ فيديوهات عامة من يوتيوب عن الذكاء الاصطناعي", provider([{ title: "قناة بلا رقم", handle: "@x" }]));
    const m = await w.plan();
    expect(m.status).toBe("needs_input");
    expect(w.call).not.toHaveBeenCalled();
  });
});

describe("the answer: a channel", () => {
  it.each([
    ["a name", "الأهلي"],
    ["a name with «قناة»", "قناة الأهلي"],
    ["a handle", "@AlAhlyEG"],
    ["a handle link", "https://www.youtube.com/@alahlyeg"],
    ["a handle link, no scheme", "youtube.com/@alahlyeg/videos"],
  ])("%s (%s): the lookup finds the channel that really carries it (the SECOND result, not the first), and its own videos about the topic are read", async (_n, text) => {
    const w = world(GENERIC);
    await w.plan();
    const m = await w.answer(text);
    expect(m.status).toBe("plan_ready");
    expect(w.endpoints()).toEqual([CHANNEL_SEARCH, IN_CHANNEL]);
    const inChannel = w.call.mock.calls.find((c) => (c[0] as { endpointId: string }).endpointId === IN_CHANNEL)![0] as { params: Record<string, unknown> };
    expect(inChannel.params.channel_id).toBe(IDS.second);
    expect(inChannel.params.search_query).toBe("الذكاء الاصطناعي");
    expect(m.plan!.compiled?.by).toBe("compiler");
    expect(m.plan!.stages[0].endpoint_id).toBe(IN_CHANNEL);
    expect(m.plan!.stages[0].planned_rows).toBe(10);
    // the request's topic and count, unpolluted by the answer
    expect(JSON.stringify(m.plan!.summary_ar)).toContain("الذكاء الاصطناعي");
    expect(JSON.stringify(m.plan_public)).not.toMatch(/alahlyeg|youtube\.com\/@/i);
    // the card says what this is: a search inside that channel, never «the official channels»
    const notes = (m.plan!.notes_ar ?? []).join(" ");
    expect(notes).toContain(youtubeChannelNoteAr("النادي الأهلي"));
    expect(notes).not.toContain("القنوات الرسمية");
    expect(youtubeChannelNoteAr("النادي الأهلي")).toBe("هذا بحث داخل القناة «النادي الأهلي» وحدها، وليس بحثًا في كل يوتيوب. راجع أنها القناة المقصودة قبل الاعتماد.");
    expect(w.questions()).toBe(1);
    expect(w.store.missions.size).toBe(1);
    expect(m.job_id ?? null).toBeNull();
    expect(w.modelRuns()).toBe(0);
    expect((await readRunState(w.store, w.id)).pending).toBeUndefined();
  });

  it("a channel link with its id needs no lookup at all: only the channel's own videos are read, for that id", async () => {
    const w = world(GENERIC);
    await w.plan();
    const m = await w.answer(`https://www.youtube.com/channel/${IDS.second}`);
    expect(m.status).toBe("plan_ready");
    expect(w.endpoints()).toEqual([IN_CHANNEL]);
    expect((w.call.mock.calls[0][0] as { params: Record<string, unknown> }).params.channel_id).toBe(IDS.second);
    expect((m.plan!.notes_ar ?? []).join(" ")).toContain("وليس بحثًا في كل يوتيوب");
  });

  it("the price is the one the same request with the channel written in it gets (the answer changes no money rule)", async () => {
    const viaAnswer = world(GENERIC); await viaAnswer.plan();
    const a = await viaAnswer.answer("الأهلي");
    const inRequest = world("عايز ١٠ فيديوهات من قناة الأهلي على يوتيوب عن الذكاء الاصطناعي");
    const b = await inRequest.plan();
    expect(b.status).toBe("plan_ready");
    expect(inRequest.questions()).toBe(0);
    expect(a.plan!.price).toEqual(b.plan!.price);
    expect(a.reserved_points ?? null).toEqual(b.reserved_points ?? null);
  });

  it("a planning that starts again after the answer (a restart) does not ask again and keeps the channel", async () => {
    const w = world(GENERIC);
    await w.plan();
    await w.answer("الأهلي");
    const m = w.store.missions.get(w.id)!;
    w.store.missions.set(w.id, { ...m, status: "planning", plan: null, plan_public: null } as typeof m);
    expect((await w.plan()).status).toBe("plan_ready");
    expect(w.questions()).toBe(1);
  });
});

describe("the answer: no channel, or a channel that cannot be identified", () => {
  it.each([
    ["no channel", "مش عارف"],
    ["any channel", "أي قناة"],
    ["a video link", "https://www.youtube.com/watch?v=abc123"],
    ["a Short link", "https://www.youtube.com/shorts/abc123"],
    ["a playlist link", "https://www.youtube.com/playlist?list=PL123"],
    ["a link of another site", "https://example.com/x"],
    ["one letter", "ا"],
  ])("%s: the request ends honestly, nothing is read, held or charged, and the question is never asked again", async (_n, text) => {
    const w = world(GENERIC);
    await w.plan();
    const m = await w.answer(text);
    expect(m.status).toBe("unserved");
    expect(m.summary_ar).toBe(YOUTUBE_CHANNEL_DECLINED_AR);
    expect(m.plan ?? null).toBeNull();
    expect(m.reserved_points ?? 0).toBe(0);
    expect(m.job_id ?? null).toBeNull();
    expect(w.call).not.toHaveBeenCalled();
    expect(w.questions()).toBe(1);
    expect(checkCustomerText(YOUTUBE_CHANNEL_DECLINED_AR).issues).toEqual([]);
  });

  it("a name that no result carries is not replaced by the first result: one lookup, no video read, nothing charged, and the sentence says so", async () => {
    const w = world(GENERIC);
    await w.plan();
    const m = await w.answer("قناة لا وجود لها");
    expect(m.status).toBe("unserved");
    expect(m.summary_ar).toBe(YOUTUBE_CHANNEL_UNIDENTIFIED_AR);
    expect(w.endpoints()).toEqual([CHANNEL_SEARCH]);
    expect(m.reserved_points ?? 0).toBe(0);
    expect(m.job_id ?? null).toBeNull();
    expect(w.questions()).toBe(1);
    expect(checkCustomerText(YOUTUBE_CHANNEL_UNIDENTIFIED_AR).issues).toEqual([]);
  });

  it("the lookup answered but no result has a usable channel id (the live failure's possible shape): the same honest ending, no video read", async () => {
    const w = world(GENERIC, provider([{ title: "النادي الأهلي", handle: "@alahlyeg" }, { channel_id: "", title: "النادي الأهلي" }]));
    await w.plan();
    const m = await w.answer("الأهلي");
    expect(m.status).toBe("unserved");
    expect(m.summary_ar).toBe(YOUTUBE_CHANNEL_UNIDENTIFIED_AR);
    expect(w.endpoints()).toEqual([CHANNEL_SEARCH]);
  });

  it("a handle no result carries is not guessed from the order of the results", async () => {
    const w = world(GENERIC);
    await w.plan();
    const m = await w.answer("@someoneelse");
    expect(m.status).toBe("unserved");
    expect(w.endpoints()).toEqual([CHANNEL_SEARCH]);
  });
});

describe("youtubeChannelOf and matchChannel", () => {
  it("reads names, handles, links and ids, and nothing else", () => {
    expect(youtubeChannelOf("الأهلي")).toEqual({ kind: "name", name: "الأهلي" });
    expect(youtubeChannelOf("قناة الأهلي")).toEqual({ kind: "name", name: "الأهلي" });
    expect(youtubeChannelOf("@AlAhlyEG")).toEqual({ kind: "handle", handle: "alahlyeg" });
    expect(youtubeChannelOf("https://www.youtube.com/@AlAhlyEG?sub=1")).toEqual({ kind: "handle", handle: "alahlyeg" });
    expect(youtubeChannelOf(`https://youtube.com/channel/${IDS.second}/videos`)).toEqual({ kind: "id", id: IDS.second });
    expect(youtubeChannelOf(IDS.second)).toEqual({ kind: "id", id: IDS.second });
    expect(youtubeChannelOf("https://www.youtube.com/c/AlAhly")).toEqual({ kind: "name", name: "AlAhly" });
    for (const bad of ["", "  ", "مش عارف", "لا", "أي قناة", "https://www.youtube.com/watch?v=1", "https://youtu.be/abc", "https://www.youtube.com/playlist?list=1", "https://example.com", "ا", "١٢٣", "x".repeat(121), null, undefined]) expect(youtubeChannelOf(bad), String(bad)).toBeNull();
  });
  it("a name is matched by the words of the title or the handle, never by position; a handle by the handle itself; an id is itself", () => {
    expect(matchChannel({ kind: "name", name: "الأهلي" }, ROWS.map((r) => ({ id: String(r.channel_id), title: String(r.title), handle: String(r.handle) })))?.id).toBe(IDS.second);
    expect(matchChannel({ kind: "name", name: "النادي الأهلي" }, [{ id: "a", title: "نادي الزمالك" }])).toBeNull();
    expect(matchChannel({ kind: "name", name: "alahlyeg" }, [{ id: "a", title: "x", handle: "@AlAhlyEG" }])?.id).toBe("a");
    expect(matchChannel({ kind: "handle", handle: "alahlyeg" }, [{ id: "a", handle: "@zamalekfc" }, { id: "b", handle: "@alahlyeg" }])?.id).toBe("b");
    expect(matchChannel({ kind: "id", id: IDS.first }, [])).toEqual({ id: IDS.first });
    expect(matchChannel({ kind: "name", name: "الأهلي" }, [{ id: "", title: "الأهلي" }])).toBeNull();
  });
  it("the verified channel card maps every row of the REAL stored pages with its id and its handle (no mapping defect is proven)", () => {
    const card = cardOf("tikhub.x.youtube-web-v2-search-channels")!;
    for (const call of ["call_0003", "call_0004"]) {
      const rows = mapPage(card, raw(call));
      expect(rows).toHaveLength(2);
      for (const r of rows) { expect(typeof r.id).toBe("string"); expect(String(r.id)).toMatch(/^UC[A-Za-z0-9_-]{22}$/); expect(typeof r.handle).toBe("string"); }
    }
  });
});

describe("the official-channels request, the other platforms and the money are untouched", () => {
  it("a request for the official channels of a named event is planned as before: the names come from the topic, no question", async () => {
    const w = world("هات فيديوهين على يوتيوب عن نهائي السوبر المصري الأهلي والزمالك من القنوات الرسمية");
    // the event recurs: the existing question about which occurrence comes first (it is not the channel question), then the planning reads the channels by the names in the topic
    const first = await w.plan();
    expect(first.question_ar).not.toBe(YOUTUBE_CHANNEL_QUESTION_AR);
    expect(w.call).not.toHaveBeenCalled();
    const m = await w.answer(OCCURRENCE_OPTIONS_AR.latest);
    // whatever else it may ask (a stub page has no video about the topic), it is never the channel question
    expect(m.question_ar ?? null).not.toBe(YOUTUBE_CHANNEL_QUESTION_AR);
    expect((await readRunState(w.store, w.id)).pending).not.toBe("youtube_channel");
    expect(w.call.mock.calls[0][0]).toMatchObject({ endpointId: CHANNEL_SEARCH, params: { keyword: "الأهلي الرسمية" } });
  });

  it.each([
    ["TikTok", "عايز ١٠ فيديوهات من تيك توك عن الذكاء الاصطناعي"],
    ["X", "عايز ١٠ منشورات عامة من إكس عن الذكاء الاصطناعي"],
    ["Facebook", "عايز ١٠ منشورات عامة من فيسبوك عن الذكاء الاصطناعي"],
    ["Instagram", "عايز ١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي"],
  ])("%s: a request with no account or channel never gets the YouTube question", async (_n, request) => {
    const store = createMemoryStore();
    const gateway = { tregCall: vi.fn(async () => ({ ok: false as const, failed: true, http_status: 500, message: "stub" })) } as never;
    const out = await planByCompiler({ mission: { id: "msn_r31_o", request_text: request, answer_text: null, created_at: "2026-11-04T18:19:00Z" } as never, gateway, store, catalog, nowMs: Date.parse("2026-11-04T18:19:30Z"), askCount: true });
    expect(out.kind === "question" ? out.why : null).not.toBe("youtube_channel");
    expect(String(out.kind === "cannot" ? out.reason : "")).not.toMatch(/^youtube_channel/);
  });

  it("the rule is guarded by the platform and by the absence of an official source, and the module imports nothing", async () => {
    const compiled = readFileSync("agent/src/compiled.ts", "utf8");
    expect(compiled).toContain('if (ask.platform === "youtube" && ask.source.kind !== "official" && !ask.edits.channels) {');
    expect(readFileSync("src/lib/agentMission/foundation/youtubeChannel.ts", "utf8")).not.toMatch(/^import /m);
  });
});
