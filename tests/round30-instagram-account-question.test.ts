import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { planByCompiler } from "../agent/src/compiled";
import { readRunState } from "../agent/src/runState";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { INSTAGRAM_ACCOUNT_DECLINED_AR, INSTAGRAM_ACCOUNT_QUESTION_AR, instagramAccountNoteAr, instagramAccountOf } from "../src/lib/agentMission/foundation/instagramAccount";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { NOT_ADMIN, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { inputKey, storedCalls } from "./helpers/replayGateway";

/**
 * ROUND 30. Live QA (4 Nov 2026): «عايز ١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي» ended «مصادرنا لا تخدم هذا الطلب» with no provider call: Instagram's only verified parent tool reads the posts of a NAMED public account (`posts.account`), and the
 * request named none. Now the customer is asked once, in the same mission and before anything is read, held or priced, which account to read; a username or an account link is read by code; the topic and the count stay the request's own; no usable answer
 * ends the request honestly and never asks twice. No provider capability is added.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const catalog = loadTregCatalog();
const M16 = "msn_e3e7632e2fb2d42f9c19"; // the stored real pages of the account «alhadath»
const OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" };
const TEST_EMAIL = "iam.magdy+1@outlook.com";
const GENERIC = "عايز ١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي";
const NAMED_IN_REQUEST = "عايز ١٠ منشورات من حساب @alhadath على إنستجرام عن الذكاء الاصطناعي";

function storedProvider(mission: string) {
  const byKey = new Map(storedCalls(mission).filter((c) => c[3] === "ok" || c[3] === "empty").map((c) => [inputKey(c[2], c[5]), c] as const));
  return vi.fn(async (o: { endpointId: string; params: Record<string, unknown> }) => {
    const c = byKey.get(inputKey(o.endpointId, o.params));
    const file = c ? new URL(`./fixtures/live/missions/${mission}/raw/${c[0]}.json`, import.meta.url) : null;
    if (!c || !file || !existsSync(file)) return tregResult(null, 0, { ok: false, httpStatus: 404, error: "not_found" });
    return tregResult(JSON.parse(readFileSync(file, "utf8")), Number(catalog.byId.get(o.endpointId)?.cost?.usd ?? 0.001));
  });
}

/** One mission on one memory store, planned as many times as the test asks (the customer's answers are put on the same mission, as the site does). */
function world(request: string) {
  const store = createMemoryStore();
  const id = "msn_r30_1";
  store.missions.set(id, newMission({ id, user_id: "user_r30", request_text: request, status: "planning", created_at: "2026-11-04T18:19:00Z" }));
  store.userEmails.set("user_r30", TEST_EMAIL);
  Object.assign(store.settings, { redesign_flags: { ...OFF, instagram: "test" } });
  const rec = fakeRecorder();
  const call = storedProvider(M16);
  const driver = createFakeDriver([{ tool: "ask_question", args: { question_ar: "هل تقصد هذا؟", options_ar: ["نعم", "لا"] } }]);
  const run = vi.spyOn(driver, "run");
  const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
  const plan = async () => { await runPlanning(deps, store.missions.get(id)!); return store.missions.get(id)!; };
  const answer = async (text: string) => { const m = store.missions.get(id)!; store.missions.set(id, { ...m, answer_text: text, status: "planning" } as typeof m); return plan(); };
  const questions = () => store.events.filter((e) => e.kind === "question").length;
  return { store, id, plan, answer, call, modelRuns: () => run.mock.calls.length, questions };
}

describe("the question: a request with no account", () => {
  it("asks once, in the same mission, with the exact words, before any read, hold, price or model call", async () => {
    const w = world(GENERIC);
    const m = await w.plan();
    expect(m.status).toBe("needs_input");
    expect(m.question_ar).toBe(INSTAGRAM_ACCOUNT_QUESTION_AR);
    expect(INSTAGRAM_ACCOUNT_QUESTION_AR).toBe("نقدر نجمع منشورات من حساب إنستجرام عام محدد. اكتب اسم المستخدم أو رابط الحساب اللي عايز نبحث فيه.");
    expect((m.plan_public as { question_options?: string[] } | null)?.question_options).toEqual([]);
    expect(m.plan).toBeNull();
    expect(m.reserved_points ?? 0).toBe(0);
    expect(m.job_id ?? null).toBeNull();
    expect(m.quote_id ?? null).toBeNull();
    expect(w.call).not.toHaveBeenCalled();
    expect(w.modelRuns()).toBe(0);
    expect(w.store.calls).toHaveLength(0);
    expect(w.questions()).toBe(1);
    expect(w.store.missions.size).toBe(1);
    expect((await readRunState(w.store, w.id)).pending).toBe("instagram_account");
    expect(checkCustomerText(INSTAGRAM_ACCOUNT_QUESTION_AR).issues).toEqual([]);
  });
});

describe("the answer: an account", () => {
  it.each([
    ["@handle", "@alhadath"],
    ["a bare username", "alhadath"],
    ["an account link", "https://www.instagram.com/alhadath/"],
    ["a link without the scheme", "instagram.com/alhadath"],
    ["a handle inside a sentence", "من حساب @AlHadath لو سمحت"],
  ])("%s (%s): the plan comes from that account's posts, with the request's own topic and count, and says so", async (_name, text) => {
    const w = world(GENERIC);
    await w.plan();
    const m = await w.answer(text);
    expect(m.status).toBe("plan_ready");
    expect(m.plan!.compiled?.by).toBe("compiler");
    expect(m.plan!.stages[0].endpoint_id).toBe("scrapecreators.instagram.user.posts");
    expect(m.plan!.stages[0].planned_rows).toBe(10);
    // the topic is the request's («الذكاء الاصطناعي»), never polluted by the answer's words
    const pub = JSON.stringify(m.plan_public);
    expect(pub).toContain("الذكاء الاصطناعي");
    expect(JSON.stringify(m.plan!.summary_ar)).not.toMatch(/@|instagram\.com/i);
    // the account is disclosed: these are that account's posts, not all of Instagram
    expect(m.plan!.notes_ar).toContain(instagramAccountNoteAr("alhadath"));
    expect(instagramAccountNoteAr("alhadath")).toBe("النتائج من حساب «@alhadath» وحده، وليست بحثًا في كل إنستجرام.");
    // the only Latin letters are the customer's own account name, shown back to them
    expect(checkCustomerText(instagramAccountNoteAr("alhadath").replace("@alhadath", "الحساب")).issues).toEqual([]);
    // only the verified account tool was asked, for that account
    expect(w.call.mock.calls.length).toBeGreaterThan(0);
    expect(w.call.mock.calls.every((c) => (c[0] as { endpointId: string }).endpointId === "scrapecreators.instagram.user.posts" && (c[0] as { params: { handle?: string } }).params.handle === "alhadath")).toBe(true);
    // the same mission, one question, no second mission, no job, no approval
    expect(w.questions()).toBe(1);
    expect(w.store.missions.size).toBe(1);
    expect(m.job_id ?? null).toBeNull();
    expect(w.modelRuns()).toBe(0);
    expect((await readRunState(w.store, w.id)).choices?.instagramAccount).toBe("alhadath");
    expect((await readRunState(w.store, w.id)).pending).toBeUndefined();
  });

  it("the price is the one the same request with the account written in it gets (the answer changes no money rule)", async () => {
    const viaAnswer = world(GENERIC); await viaAnswer.plan();
    const a = await viaAnswer.answer("@alhadath");
    const inRequest = world(NAMED_IN_REQUEST);
    const b = await inRequest.plan();
    expect(b.status).toBe("plan_ready");
    expect(a.plan!.price).toEqual(b.plan!.price);
    expect(a.reserved_points ?? null).toEqual(b.reserved_points ?? null);
    // the request that names its account is not asked and carries no note
    expect(inRequest.questions()).toBe(0);
    expect(JSON.stringify(b.plan!.notes_ar ?? [])).not.toContain("وليست بحثًا في كل إنستجرام");
  });

  it("a planning that starts again after the answer (a restart) does not ask again and keeps the account", async () => {
    const w = world(GENERIC);
    await w.plan();
    await w.answer("@alhadath");
    const again = world(GENERIC);
    // the same store: the stored run state keeps the account, the mission goes back to planning
    const m = w.store.missions.get(w.id)!;
    w.store.missions.set(w.id, { ...m, status: "planning", plan: null, plan_public: null } as typeof m);
    const redone = await w.plan();
    expect(redone.status).toBe("plan_ready");
    expect(w.questions()).toBe(1);
    void again;
  });
});

describe("the answer: not an account, or none", () => {
  it.each([
    ["words, not an account", "مش عارف"],
    ["a post link (not an account)", "https://www.instagram.com/p/ABC123/"],
    ["a reel link", "https://www.instagram.com/reel/ABC123/"],
    ["a number", "١٠"],
    ["a site that is not Instagram", "https://example.com/alhadath"],
  ])("%s: the request ends honestly, nothing is read, held or charged, and the question is never asked again", async (_n, text) => {
    const w = world(GENERIC);
    await w.plan();
    const m = await w.answer(text);
    expect(m.status).toBe("unserved");
    expect(m.summary_ar).toBe(INSTAGRAM_ACCOUNT_DECLINED_AR);
    expect(m.plan ?? null).toBeNull();
    expect(m.reserved_points ?? 0).toBe(0);
    expect(m.job_id ?? null).toBeNull();
    expect(w.call).not.toHaveBeenCalled();
    expect(w.questions()).toBe(1);
    expect(w.store.missions.size).toBe(1);
    expect(checkCustomerText(INSTAGRAM_ACCOUNT_DECLINED_AR).issues).toEqual([]);
    expect(INSTAGRAM_ACCOUNT_DECLINED_AR).toContain("لم يُخصم منك شيء");
  });
});

describe("instagramAccountOf", () => {
  it("reads usernames and account links, lower-cased, and nothing else", () => {
    expect(instagramAccountOf("@alhadath")).toBe("alhadath");
    expect(instagramAccountOf("  AlHadath  ")).toBe("alhadath");
    expect(instagramAccountOf("https://www.instagram.com/some.user_1/?hl=ar")).toBe("some.user_1");
    expect(instagramAccountOf("m.instagram.com/x/")).toBe("x");
    expect(instagramAccountOf("‏@alhadath‏")).toBe("alhadath");
    for (const bad of ["", "   ", "مش عارف", "١٢٣", "123", "a b", ".bad", "bad.", "a..b", "x".repeat(31), "https://www.instagram.com/p/ABC/", "https://www.instagram.com/explore/", "https://example.com/alhadath", null, undefined]) expect(instagramAccountOf(bad), String(bad)).toBeNull();
  });
});

describe("the other platforms and the named Instagram account are untouched", () => {
  it("an Instagram request that names its account in the request is planned as before: no question, no note", async () => {
    const w = world("هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات والردود.");
    const m = await w.plan();
    expect(m.status).toBe("plan_ready");
    expect(w.questions()).toBe(0);
    expect(JSON.stringify(m.plan!.notes_ar ?? [])).not.toContain("وليست بحثًا في كل إنستجرام");
  });

  it.each([
    ["TikTok", "عايز ١٠ فيديوهات من تيك توك عن الذكاء الاصطناعي"],
    ["X", "عايز ١٠ منشورات عامة من إكس عن الذكاء الاصطناعي"],
    ["Facebook", "عايز ١٠ منشورات عامة من فيسبوك عن الذكاء الاصطناعي"],
    ["YouTube", "عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي"],
  ])("%s: a request with no account never gets the Instagram question", async (_n, request) => {
    const store = createMemoryStore();
    const gateway = { tregCall: vi.fn(async () => ({ ok: false as const, failed: true, http_status: 500, message: "stub" })) } as never;
    const out = await planByCompiler({ mission: { id: "msn_r30_o", request_text: request, answer_text: null, created_at: "2026-11-04T18:19:00Z" } as never, gateway, store, catalog, nowMs: Date.parse("2026-11-04T18:19:30Z"), askCount: true });
    expect(out.kind === "question" ? out.why : null).not.toBe("instagram_account");
    expect(out.kind === "cannot" ? out.reason : null).not.toBe("instagram_account_missing");
  });

  it("the new rule is guarded by the platform and by the absence of a parent card, and imports no money module", async () => {
    const { readFileSync: read } = await import("node:fs");
    const compiled = read("agent/src/compiled.ts", "utf8");
    expect(compiled).toMatch(/if \(ask\.platform === "instagram" && ask\.source\.kind !== "named" && chooseCard\(ask, "parents"[^)]*\) === null\)/);
    const mod = read("src/lib/agentMission/foundation/instagramAccount.ts", "utf8");
    expect(mod).not.toMatch(/import /);
  });
});
