import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, VARIANTS_FILE } from "../agent/src/compiled";
import { paramsSignature, PARAMS_SIG_KEY } from "../agent/src/gateway";
import { readRunState } from "../agent/src/runState";
import { RAW_PATH } from "../agent/src/gateway";
import { anthropicReviewCall } from "../agent/src/review";
import { topicVariants, TOPIC_VARIANTS_MAX_TOKENS } from "../agent/src/researchJudge";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { sourceAnswerOf, sourceIdIn, sourceIdOf } from "../src/lib/agentMission/foundation/sourceScope";

/**
 * P0, 15 NOV 2026, THIRD RETEST AFTER PR #502 (msn_7365668c48162ce20bbd, msn_c6767995ad124f9edbec, msn_cfee23cdac3a2c7e4ab4; recorded production evidence, zero paid calls).
 *
 * Six search reads, five empty, one of 20 rows (the account's 20 newest tweets, no topic at all), no plan, nothing charged. What the evidence proves:
 *  Q1 THE MODEL LAYER WAS SILENT. Every mission kept `planning_variants.json` of 12 bytes ({"terms":[]}): claude-haiku-5-5 thinks by default and its thinking counts toward `max_tokens`, so the 300-token variants call ended after a
 *     thinking block with no text. The worker read that as «no other wording» and kept it for the mission. The same shared call serves the capability choice and the channel names (200 tokens each).
 *  Q2 THE QUERY WAS THE CUSTOMER'S SENTENCE: «الشائعات الصحية وتصحيحها وجهود الوزارة» as one exact phrase, then the same words all required: posts are not worded like a research brief.
 *  Q3 THE RECALL STRATEGY CAME TOO LATE: it ran only after the literal read had spent one of the two planning samples; with no terms the second sample read the account's newest 20 tweets with no topic.
 *  Q4 THE HANDLE KEPT THE SENTENCE'S FULL STOP: «https://x.com/SaudiMOH.» became `from:SaudiMOH.`, an account that does not exist.
 */
const fx = JSON.parse(readFileSync(new URL("./fixtures/p0-x-account/production-2026-11-15-retest3.json", import.meta.url), "utf8")) as {
  missions: Array<{ id: string; request_text: string; answer_text?: string; source_answer?: string; status: string; calls: Array<{ query: string; status: string; rows: number }>; variants_file_bytes: number; planning_llm_usd: number }>;
  cost_usd: { provider: number; planning_model: number };
};
const catalog = loadTregCatalog();
const nowMs = Date.parse("2026-11-15T11:58:19Z");
const pageOf = (items: unknown[], nextCursor: string | null = null) => ({ output: { data: { items, nextCursor } } });
/** SYNTHETIC posts (never production) where a test needs rows that are about the topic. */
const post = (id: string, text: string) => ({ id, text, authorName: "وزارة الصحة السعودية", authorUsername: "SaudiMOH", authorFollowers: 1, createdUtc: "2024-05-02T09:00:00.000Z", url: `https://x.com/i/web/status/${id}`, isReply: false, lang: "ar", likeCount: 1, replyCount: 0, retweetCount: 0, viewCount: 1 });
const ABOUT = [post("9100000000000000001", "لا صحة لما يتم تداوله عن انتشار فيروس جديد؛ نرجو عدم الالتفات للإشاعات."), post("9100000000000000002", "تحذر الوزارة من الشائعات الصحية وتدعو لاستقاء المعلومات من مصادرها الرسمية.")];
const judge = async ({ rows }: { rows: ReadonlyArray<{ id: string }> }) => ({ verdicts: new Map(rows.map((r) => [r.id, r.id.startsWith("91")])), costUsd: 0.0002 });

/**
 * claude-haiku-5-5 as the API documents it: with no `thinking` field it thinks first, and the thinking counts toward `max_tokens` (a short cap can end the answer after a thinking block and before any text); with
 * `thinking: {"type": "disabled"}` (accepted at the default effort) it answers directly.
 */
function haikuFetch(answer: string, seen: Array<Record<string, unknown>> = []) {
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    seen.push(body);
    const off = (body.thinking as { type?: string } | undefined)?.type === "disabled";
    const content = off ? [{ type: "text", text: answer }] : [{ type: "thinking", thinking: "", signature: "sig" }];
    return { ok: true, status: 200, json: async () => ({ content, stop_reason: off ? "end_turn" : "max_tokens", usage: { input_tokens: 300, output_tokens: off ? 60 : Number(body.max_tokens) } }) };
  }) as never;
}

async function plan(m: (typeof fx.missions)[number], pages: unknown[], extra: Record<string, unknown> = {}, store = createMemoryStore()) {
  const calls: Array<Record<string, unknown>> = [];
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      calls.push((input.params ?? {}) as Record<string, unknown>);
      const page = pages[calls.length - 1] ?? pageOf([]);
      const callId = `call_${String(calls.length).padStart(4, "0")}`;
      await store.putFile(m.id, RAW_PATH(callId), JSON.stringify(page), "application/json");
      const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!);
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: (page as { output?: { data?: { nextCursor?: string | null } } }).output?.data?.nextCursor ?? null };
    },
  };
  const answer = m.answer_text ?? m.source_answer ?? null;
  const sourceId = m.answer_text ? (sourceAnswerOf(m.answer_text) as { id?: string } | null)?.id : m.source_answer;
  const r = await planByCompiler({ mission: { id: m.id, request_text: m.request_text, answer_text: answer, created_at: "2026-11-15T11:58:19Z" } as never, gateway: gateway as never, store, catalog, nowMs, ...(sourceId ? { choices: { sourceId } } : {}), answerIsChoice: Boolean(m.source_answer), judge, ...extra } as never);
  return { r, calls, queries: calls.map((c) => String(c.query ?? "")), store };
}

describe("the retest as recorded", () => {
  it("six reads, five empty, the only rows came from a query with no topic; every mission kept an EMPTY variants file; nothing was planned or charged", () => {
    const all = fx.missions.flatMap((m) => m.calls);
    expect(all).toHaveLength(6);
    expect(all.filter((c) => c.rows === 0)).toHaveLength(5);
    const withRows = all.filter((c) => c.rows > 0);
    expect(withRows).toEqual([expect.objectContaining({ rows: 20 })]);
    expect(withRows[0].query.startsWith("from:SaudiMOH")).toBe(true);
    for (const m of fx.missions) expect(m.variants_file_bytes).toBe(JSON.stringify({ terms: [] }).length);
    expect(fx.missions.map((m) => m.status)).toEqual(["cancelled", "unserved", "unserved"]);
    expect(fx.missions.some((m) => m.calls.some((c) => c.query.includes("from:SaudiMOH.")))).toBe(true);
    expect(fx.cost_usd.provider + fx.cost_usd.planning_model).toBeCloseTo(0.004385, 6);
  });
});

describe("Q1: a model call never comes back silently empty", () => {
  it("the worker's shared call asks for no thinking (so a short cap holds the answer), and the variants step reads the terms", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const call = anthropicReviewCall("k", haikuFetch('["شائعات","إشاعات","معلومات مغلوطة","لا صحة"]', seen));
    const got = await topicVariants(call)({ request: fx.missions[2].request_text, topic: "الشائعات الصحية", alternatives: [] });
    expect(seen[0].thinking).toEqual({ type: "disabled" });
    expect(seen[0].max_tokens).toBe(TOPIC_VARIANTS_MAX_TOKENS);
    expect(got?.failed).toBeUndefined();
    expect(got?.terms).toEqual(["شائعات", "إشاعات", "معلومات مغلوطة", "لا صحة"]);
  });
  it("the production failure, reproduced: without that field the answer ends at the cap after thinking, and it is reported as a FAILED call (never as «no other wording»)", async () => {
    // the call exactly as production sent it (no thinking field): a model that refuses the field is asked once more without it
    const refusing = (async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (body.thinking) return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "thinking", thinking: "", signature: "s" }], stop_reason: "max_tokens", usage: { input_tokens: 300, output_tokens: 300 } }) };
    }) as never;
    const res = await anthropicReviewCall("k", refusing)({ model: "claude-haiku-5-5", system: "s", user: "u", maxTokens: 300 });
    expect(res).toMatchObject({ text: "", truncated: true });
    const got = await topicVariants(anthropicReviewCall("k", refusing))({ request: "r", topic: "t", alternatives: [] });
    expect(got).toMatchObject({ terms: [], failed: true });
    expect(got!.costUsd).toBeGreaterThan(0);
  });
  it("a verdict call keeps its forced tool and asks for no thinking; an API that refuses both is asked without thinking, then without the tool", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const f = (async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(b);
      if (b.thinking || b.tool_choice) return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "[1,0]" }], stop_reason: "end_turn", usage: {} }) };
    }) as never;
    const out = await anthropicReviewCall("k", f)({ model: "m", system: "s", user: "u", maxTokens: 50, rows: 2 });
    expect(out?.text).toBe("[1,0]");
    // never thinking back on before the tool was dropped (review finding 3): no tool, still no thinking, comes second
    expect(bodies.map((b) => [Boolean(b.thinking), Boolean(b.tool_choice)])).toEqual([[true, true], [true, false], [false, true], [false, false]]);
  });
  it("a failed variants call is never kept for the mission: the next planning run asks again (production kept {\"terms\":[]} and every later run trusted it)", async () => {
    const m = fx.missions[2];
    let n = 0;
    const variants = async () => { n += 1; return n === 1 ? { terms: [], costUsd: 0.0001, failed: true as const } : { terms: ["شائعات", "إشاعات"], costUsd: 0.0001 }; };
    const store = createMemoryStore();
    await plan(m, [pageOf([])], { variants }, store);
    expect(await store.getFile(m.id, VARIANTS_FILE)).toBeNull();
    const again = await plan({ ...m, id: m.id }, [pageOf([...ABOUT], null)], { variants }, store);
    expect(n).toBe(2);
    expect(JSON.parse((await store.getFile(m.id, VARIANTS_FILE))!)).toMatchObject({ terms: ["شائعات", "إشاعات"] });
    expect(again.queries[0]).toMatch(/^\(شائعات OR إشاعات OR /);
  });
});

describe("Q2 + Q3: the first read searches the topic's vocabulary, with every hard condition", () => {
  const TERMS = ["شائعات", "إشاعات", "معلومات مغلوطة", "لا صحة", "تضليل"];
  it("msn_cfee…: the first query is the customer's words OR the search terms, from the account, in the period, originals only; relevant posts make a plan sized by the request", async () => {
    const m = fx.missions[2];
    const { r, queries } = await plan(m, [pageOf([...ABOUT], "c2"), pageOf([], null)], { variants: async () => ({ terms: TERMS, costUsd: 0.0001 }) });
    expect(queries[0]).toMatch(/^\(شائعات OR إشاعات OR "معلومات مغلوطة" OR "لا صحة" OR تضليل OR .+\) from:SaudiMOH since:\S+ until:\S+ -filter:replies$/);
    // the recorded production query (one exact phrase of the customer's sentence) is never the first read again
    expect(queries[0].startsWith(m.calls[0].query.slice(0, 40))).toBe(false);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(String(r.plan.stages.find((s) => s.parent_key === null)!.engine?.params?.query)).toBe(queries[0]);
  });
  it("the customer's own suggested wordings (the answer of msn_c676…) reach the variants step", async () => {
    const m = fx.missions[1];
    const asked: string[] = [];
    await plan(m, [pageOf([...ABOUT], null)], { variants: async (i: { request: string }) => { asked.push(i.request); return { terms: TERMS, costUsd: 0.0001 }; } });
    expect(asked[0]).toContain("لا صحة لما يُتداول");
    expect(asked[0]).toContain(m.request_text);
  });
});

describe("Q4: an identifier never keeps the sentence's punctuation", () => {
  it("the recorded answer gives SaudiMOH, and the query carries from:SaudiMOH followed by a space", async () => {
    const m = fx.missions[1];
    expect(sourceAnswerOf(m.answer_text)).toEqual({ kind: "id", id: "SaudiMOH" });
    expect(sourceIdOf("https://x.com/SaudiMOH.")).toBe("SaudiMOH");
    expect(sourceIdOf("@SaudiMOH.")).toBe("SaudiMOH");
    expect(sourceIdIn("حسابهم هو https://twitter.com/SaudiMOH/.")).toBe("SaudiMOH");
    // an identifier with an inner dot (Instagram) is kept whole
    expect(sourceIdOf("https://instagram.com/some.user")).toBe("some.user");
    const { queries } = await plan(m, [pageOf([...ABOUT], null)], { variants: async () => ({ terms: TERMS_Q4, costUsd: 0.0001 }) });
    for (const q of queries) { expect(q).toContain("from:SaudiMOH "); expect(q).not.toContain("from:SaudiMOH."); }
  });
});
const TERMS_Q4 = ["شائعات"];

describe("independent review findings on the PR head (fixed before merge)", () => {
  const TERMS = ["شائعات", "إشاعات", "معلومات مغلوطة"];
  /** A planning run over recorded calls (as production rebuilds it after an answer or a restart): `recorded` pages are on disk, new reads come from `fresh`. */
  async function replan(m: (typeof fx.missions)[number], recorded: Array<{ params: Record<string, unknown>; page: unknown; withSig?: boolean }>, fresh: unknown[], extra: Record<string, unknown> = {}, store = createMemoryStore()) {
    const priorCalls = [];
    for (const [i, r] of recorded.entries()) {
      const id = `call_${String(i + 1).padStart(4, "0")}`;
      await store.putFile(m.id, RAW_PATH(id), JSON.stringify(r.page), "application/json");
      const digest: Record<string, unknown> = Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 80) : v]));
      if (r.withSig !== false) digest[PARAMS_SIG_KEY] = paramsSignature(r.params);
      const rows = ((r.page as { output: { data: { items: unknown[] } } }).output.data.items).length;
      priorCalls.push({ id: `${m.id}:${id}`, phase: "planning", status: rows > 0 ? "ok" : "empty", rows_returned: rows, endpoint_id: "anyapi.x.search.posts", params_digest: digest });
    }
    const calls: Array<Record<string, unknown>> = [];
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        calls.push((input.params ?? {}) as Record<string, unknown>);
        const page = fresh[calls.length - 1] ?? pageOf([]);
        const callId = `call_${String(recorded.length + calls.length).padStart(4, "0")}`;
        await store.putFile(m.id, RAW_PATH(callId), JSON.stringify(page), "application/json");
        const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!);
        return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: null };
      },
    };
    const r = await planByCompiler({ mission: { id: m.id, request_text: m.request_text, answer_text: null, created_at: "2026-11-15T11:58:19Z" } as never, gateway: gateway as never, store, catalog, nowMs, choices: { sourceId: "SaudiMOH" }, judge, priorCalls, ...extra } as never);
    return { r, calls, store };
  }
  it("FINDING 1: a recorded page is reused only for the SAME complete inputs: a query that shares its first 80 characters but not its period is read afresh", async () => {
    const m = fx.missions[2];
    const first = await plan(m, [pageOf([...ABOUT], null)], { variants: async () => ({ terms: TERMS, costUsd: 0.0001 }) });
    const sent = first.calls[0];
    // the same query with another period: identical first 80 characters (the terms come first), a different query
    const otherPeriod = { ...sent, query: String(sent.query).replace(/since:\S+/, "since:2025-01-01_00:00:00_UTC") };
    expect(String(otherPeriod.query).slice(0, 80)).toBe(String(sent.query).slice(0, 80));
    const store = createMemoryStore();
    await store.putFile(m.id, VARIANTS_FILE, JSON.stringify({ terms: TERMS, topic: JSON.stringify([buildAskTopic(m), []]) }), "application/json");
    const stale = await replan(m, [{ params: otherPeriod, page: pageOf([...ABOUT], null) }], [pageOf([...ABOUT], null)], { variants: async () => ({ terms: TERMS, costUsd: 0.0001 }) }, store);
    expect(stale.calls).toHaveLength(1);
    expect(stale.calls[0].query).toBe(sent.query);
    // the identical inputs ARE reused (no call)
    const store2 = createMemoryStore();
    await store2.putFile(m.id, VARIANTS_FILE, JSON.stringify({ terms: TERMS, topic: JSON.stringify([buildAskTopic(m), []]) }), "application/json");
    const same = await replan(m, [{ params: sent, page: pageOf([...ABOUT], null) }], [], { variants: async () => ({ terms: TERMS, costUsd: 0.0001 }) }, store2);
    expect(same.calls).toHaveLength(0);
  });
  it("FINDING 2: terms are never asked once this search already gave a planning page with rows: the run reuses the recorded precise pages instead of a refused third sample", async () => {
    const m = fx.missions[2];
    const precise = (await plan(m, [pageOf([...ABOUT], "c"), pageOf([...ABOUT].map((p) => ({ ...p, id: p.id.replace("91", "92") })), null)], { variants: async () => ({ terms: [], costUsd: 0.0001, failed: true as const }) })).calls;
    let asked = 0;
    const again = await replan(m, precise.map((p, i) => ({ params: p, page: i === 0 ? pageOf([...ABOUT], "c") : pageOf([...ABOUT].map((x) => ({ ...x, id: x.id.replace("91", "92") })), null) })), [], { variants: async () => { asked += 1; return { terms: TERMS, costUsd: 0.0001 }; } });
    expect(asked).toBe(0);
    expect(again.calls).toHaveLength(0);
    expect(again.r.kind).not.toBe("cannot");
  });
  it("FINDING 2b: a kept vocabulary of ANOTHER topic is not used (the customer changed the topic)", async () => {
    const m = fx.missions[2];
    const store = createMemoryStore();
    await store.putFile(m.id, VARIANTS_FILE, JSON.stringify({ terms: ["كلمة قديمة"], topic: JSON.stringify(["موضوع آخر", []]) }), "application/json");
    const { queries } = await plan(m, [pageOf([...ABOUT], null)], { variants: async () => ({ terms: TERMS, costUsd: 0.0001 }) }, store);
    expect(queries[0]).not.toContain("كلمة قديمة");
    expect(queries[0]).toMatch(/^\(شائعات OR /);
  });
  it("FINDING 5: a source choice saved with the sentence's full stop is normalized, not dropped", async () => {
    const store = createMemoryStore();
    await store.putFile("msn_rs", "run_state.json", JSON.stringify({ planningStarts: 1, choices: { sourceId: "SaudiMOH." } }), "application/json");
    expect((await readRunState(store, "msn_rs")).choices?.sourceId).toBe("SaudiMOH");
  });
});
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
function buildAskTopic(m: (typeof fx.missions)[number]): string { return buildAsk(m.request_text, null, nowMs).topic.text ?? ""; }
