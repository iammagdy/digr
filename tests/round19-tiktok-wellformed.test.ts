import { readFileSync, existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createSupabaseStore } from "../agent/src/supabaseStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { setModelPlanningForTests } from "../src/lib/agentMission/testSeam";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { illFormedPaths, wellFormedDeep, wellFormedText } from "../src/lib/agentMission/wellFormed";
import { NOT_ADMIN, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { fakeRestClient, restRefuses } from "./helpers/fakeRestClient";
import { inputKey, storedCalls } from "./helpers/replayGateway";

/**
 * ROUND 19, THE TIKTOK FAILURE OF 4 NOV 2026 (msn_e4e2efab054c8ff6669d: «تعذّر استكمال مهمتك», status failed, error «mission update: Empty or invalid json»).
 * EVIDENCE (read-only SELECTs on mission_events and mission_calls, and the project's API log): the planning read 4 pages and COMPILED the plan («خطة مبنية بالكود»), then the one write that saves the plan (PATCH /rest/v1/missions, a 19,463 byte body) was refused with 400 three times
 * (the worker re-queued the mission twice, then failed it); the plan writes of X, Instagram, Facebook and YouTube in the same smoke, on the same build, were accepted (204). The compiled plan carries text of the provider's own rows (captions, authors, comment text, in the card's samples and its
 * pinned rows): a string that holds half of an emoji is written by JSON.stringify as a lone surrogate escape, which the database's strict JSON parser refuses. The replay below puts such text on the stored real TikTok pages and runs the REAL planning (compiled path, test seam OFF) into the REAL store writer.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const catalog = loadTregCatalog();
const M12 = "msn_5851abc92a1e6645a9cd";
const REQUEST = "هات ٢ فيديو تيك توك من مصر بالعربي عن الذكاء الاصطناعي، مع ١٠ تعليقات من كل فيديو";
const HALF = "\uD83D"; // the first half of an emoji, its partner cut away

/** Every anonymised text of a stored page (the placeholders of anonymise.py) now ends with half an emoji, as a real caption or comment cut by the source does. */
function withHalfEmoji(v: unknown): unknown {
  if (typeof v === "string") return /^(نص_|txt_)/.test(v) ? `${v} ${HALF}` : v;
  if (Array.isArray(v)) return v.map(withHalfEmoji);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withHalfEmoji(x)]));
  return v;
}
function storedProvider(mission: string, damage: boolean) {
  const byKey = new Map(storedCalls(mission).filter((c) => c[3] === "ok" || c[3] === "empty").map((c) => [inputKey(c[2], c[5]), c] as const));
  return vi.fn(async (o: { endpointId: string; params: Record<string, unknown> }) => {
    const c = byKey.get(inputKey(o.endpointId, o.params));
    const file = c ? new URL(`./fixtures/live/missions/${mission}/raw/${c[0]}.json`, import.meta.url) : null;
    if (!c || !file || !existsSync(file)) return tregResult(null, 0, { ok: false, httpStatus: 404, error: "not_found" });
    const page = JSON.parse(readFileSync(file, "utf8"));
    return tregResult(damage ? withHalfEmoji(page) : page, Number(catalog.byId.get(o.endpointId)?.cost?.usd ?? 0.001));
  });
}

async function planTikTok(damage: boolean) {
  const memory = createMemoryStore();
  const rest = fakeRestClient();
  const sb = createSupabaseStore(rest.client);
  // the real writers (the ones the worker uses) in front of the memory store: a write the database refuses throws here as it did live; an accepted one is also applied to the memory store the run reads back
  const store = { ...memory, updateMission: async (id: string, patch: Record<string, unknown>) => { await sb.updateMission(id, patch as never); return memory.updateMission(id, patch as never); }, addEvent: async (id: string, e: never) => { await sb.addEvent(id, e); return memory.addEvent(id, e); } } as typeof memory;
  const id = "msn_r19_1";
  memory.missions.set(id, newMission({ id, user_id: "user_r19", request_text: REQUEST, answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, status: "planning", created_at: "2026-11-04T07:00:25Z" }));
  rest.rowsOf("missions").push({ id });
  memory.userEmails.set("user_r19", "iam.magdy+1@outlook.com");
  Object.assign(memory.settings, { redesign_flags: { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off", tiktok: "on" } });
  const rec = fakeRecorder();
  const driver = createFakeDriver([{ tool: "ask_question", args: { question_ar: "؟", options_ar: ["أ", "ب"] } }]);
  const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call: storedProvider(M12, damage) as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
  await runPlanning(deps, memory.missions.get(id)!);
  return { mission: memory.missions.get(id)!, rest, row: rest.rowsOf("missions").find((r) => r.id === id)! };
}

describe("round 19: the text that reaches the database is always well formed (TikTok, 4 Nov 2026)", () => {
  beforeEach(() => setModelPlanningForTests(false)); // the test seam OFF: production's own gate
  afterEach(() => setModelPlanningForTests(true));

  it("control: the same planning on the stored pages as they are is plan_ready, and the body is accepted", async () => {
    const r = await planTikTok(false);
    expect(r.mission.status).toBe("plan_ready");
    expect(r.rest.rejected).toEqual([]);
  });

  it("TikTok pages whose captions and comments hold half an emoji: the plan is compiled AND saved (plan_ready), nothing is refused, the text is repaired", async () => {
    const r = await planTikTok(true);
    expect(r.rest.rejected).toEqual([]);
    expect(r.mission.status).toBe("plan_ready");
    const saved = JSON.stringify(r.row.plan);
    expect(restRefuses(saved)).toBe(false);
    expect(saved).toContain("�");
    expect((r.row.plan as { stages: unknown[] }).stages.length).toBe(2);
    expect(r.mission.error ?? null).toBeNull();
  });
});

describe("round 19: the repair itself", () => {
  it("a lone surrogate (either half) becomes U+FFFD, a NUL is dropped, a complete emoji and Arabic text are untouched", () => {
    expect(wellFormedText(`ab${HALF}`)).toBe("ab�");
    expect(wellFormedText("x\uDE00y")).toBe("x�y");
    expect(wellFormedText("a\u0000b")).toBe("ab");
    expect(wellFormedText("تعليق 😀 جميل")).toBe("تعليق 😀 جميل");
    expect(wellFormedText(`${HALF}${HALF}\uDE00`)).toBe(`�${HALF}\uDE00`);
  });
  it("deep: objects, arrays and keys; a clean value is returned as the same object; numbers and nulls stay", () => {
    const clean = { a: [1, null, "ok", { b: true }] };
    expect(wellFormedDeep(clean)).toBe(clean);
    const dirty = { [`k${HALF}`]: [`t${HALF}`, { n: 5, z: null }] };
    const fixed = wellFormedDeep(dirty);
    expect(fixed).toEqual({ "k�": ["t�", { n: 5, z: null }] });
    expect(restRefuses(JSON.stringify(fixed))).toBe(false);
    expect(restRefuses(JSON.stringify(dirty))).toBe(true);
  });
  it("the paths it names hold keys only, never the text", () => {
    expect(illFormedPaths({ plan: { stages: [{ sample_rows: [{ text: `secret${HALF}` }] }] } })).toEqual(["plan.stages.0.sample_rows.0.text"]);
    expect(illFormedPaths({ a: "fine" })).toEqual([]);
  });
});

describe("round 19: every store write that carries text from outside is repaired", () => {
  it("updateMission, addCall and addEvent accept a half emoji (the call row's inputs are cut at 80 characters by the gateway, which can cut a pair)", async () => {
    const rest = fakeRestClient();
    const sb = createSupabaseStore(rest.client);
    rest.rowsOf("missions").push({ id: "m1" });
    await sb.updateMission("m1", { summary_ar: `ملخص${HALF}`, error: `x${HALF}` } as never);
    await sb.addCall({ id: "m1:call_0001", mission_id: "m1", phase: "planning", endpoint_id: "e", params_digest: { keyword: `${"ا".repeat(79)}${HALF}` }, status: "ok" } as never);
    await sb.addEvent("m1", { kind: "system", message_ar: "بدأ الوكيل دراسة طلبك.", counts: { note: `n${HALF}` } } as never);
    expect(rest.rejected).toEqual([]);
    expect(rest.rowsOf("missions")[0].summary_ar).toBe("ملخص�");
    expect(rest.rowsOf("mission_calls").length).toBe(1);
    expect(rest.rowsOf("mission_events").length).toBe(1);
  });
});
