import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { RAW_PATH } from "../agent/src/gateway";
import { ingestRows } from "../agent/src/items/ingest";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { emptyReviewState } from "../agent/src/review";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import { cleanVariants, planningJudge, topicVariants, MAX_TOPIC_VARIANTS } from "../agent/src/researchJudge";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { expandedInputsOf, parentInputs, researchRelevanceOf, EXPANDED_QUERY_MAX_CHARS, RESEARCH_GATE_NOTE_AR } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { classifyRowDetailed } from "../src/lib/agentMission/relevance";
import { NO_ABOUT_OPTIONS_AR, TOPIC_RELATION_KEY, noAboutQuestionAr, topicRelationAr } from "../src/lib/agentMission/foundation/topicChoice";
import { VARIANTS_FILE } from "../agent/src/compiled";
import { JUDGED_DRY_PAGES } from "../agent/src/engine/run";
import { searchScopeEndAr } from "../src/lib/agentMission/foundation/searchScope";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";

/**
 * P0, 15 NOV 2026, SECOND RETEST (msn_cd5f32adadefb9bb971f, recorded production evidence, zero paid calls).
 *
 * The request: up to 400 tweets of @SaudiMOH «عن الشائعات أو التصدي للشائعات أو جهود الوزارة في مكافحة الشائعات» over five years, «بس لازم التغريدات تكون فعلًا من حساب الوزارة وعن الموضوع ده».
 * What production did: one search page of 3 rows (all three contain «شائعة» in its OTHER meaning, «common»: a respiratory virus, «أخطاء شائعة» in addiction treatment, «الأسئلة الشائعة»), the empty cursor page read TWICE, a question that
 * offered «أكمل بما وجدتموه كما هو», a plan of exactly 3 tweets (the sample) priced at the mission minimum (200 points, 66.67 a tweet) with notes that both said «every item names one of the alternatives / all match your conditions» and
 * «what we chose does not name the topic», an execution that read NOTHING (the pinned sample was replayed), a file whose own column said 0 of 3 are about the topic, status completed, 200 points charged.
 *
 * The root causes this file pins (each would reproduce the incident on its own):
 *  R1 relevance was a LABEL, never a gate: compiled plans carried no relevance rule, so execution accepted every row; and the customer was offered to buy rows that are not about the request.
 *  R2 a word is not a meaning: the word rule cannot tell «شائعة» (common) from «الشائعات» (rumors), nor recognize a post about rumors that does not repeat the customer's words.
 *  R3 the planning sample SIZED the plan: planned = rows of the sample (≤ 2 pages), so 400 asked became 3 sold, priced by the minimum spread over 3, and executed with no read.
 *  R4 recall was never attempted: the precise wording returned 3 rows and the second sample went to its empty next page (twice), not to another way of saying the topic.
 */
const fx = JSON.parse(readFileSync(new URL("./fixtures/p0-x-account/production-2026-11-15-cd5f.json", import.meta.url), "utf8")) as {
  request_text: string; created_at: string; source_answer: string; final_answer_text: string; query_sent: string;
  questions: Array<{ why: string; options_offered?: string[] }>;
  calls: Array<{ cursor_sent: boolean; status: string; rows_returned: number }>; execution_calls: number;
  plan: { planned_rows: number; unit_price_points: number; reserve_points: number; contradictory_notes: string[] };
  outcome: { status: string; delivered_units: number; charged_points: number; workbook_topic_marks: Record<string, number> };
  page_1_items: Array<Record<string, unknown>>; page_1_next_cursor: string;
};
const catalog = loadTregCatalog();
const xSearch = cardOf("anyapi.x.search.posts")!;
const nowMs = Date.parse(fx.created_at);
/** The Ask as the planning reads it once the customer gave the account (the driver applies `choices.sourceId`). */
const ask = () => ({ ...buildAsk(fx.request_text, fx.source_answer, nowMs), source: { kind: "named" as const, text: fx.source_answer } });
const pageOf = (items: unknown[], nextCursor: string | null = null) => ({ output: { data: { items, nextCursor } } });
const PAGE_1 = pageOf(fx.page_1_items, fx.page_1_next_cursor);
/** SYNTHETIC (never production): posts of the account that are about countering rumors, used only where a test needs relevant rows to exist. */
const synthetic = (id: string, text: string, at = "2024-05-02T09:00:00.000Z") => ({ id, text, authorName: "وزارة الصحة السعودية", authorUsername: "SaudiMOH", authorFollowers: 1, createdUtc: at, url: `https://x.com/i/web/status/${id}`, isReply: false, lang: "ar", likeCount: 1, replyCount: 0, retweetCount: 0, viewCount: 1 });
const RUMOR_POSTS = [
  synthetic("9000000000000000001", "تحذر وزارة الصحة من تداول الشائعات حول اللقاحات، وتدعو لاستقاء المعلومات من مصادرها الرسمية."),
  synthetic("9000000000000000002", "لا صحة لما يتم تداوله عن انتشار فيروس جديد؛ نرجو عدم الالتفات للإشاعات."),
];
const RUMOR_IDS = new Set(RUMOR_POSTS.map((p) => p.id));
/** The research judge, scripted by test: the incident's three rows are NOT about rumors (their «شائعة» means «common»); the synthetic rumor posts are. The real judge is the execution's model review (researchJudge.ts). */
const scriptedJudge = (seen: string[][] = []) => async ({ rows }: { subject: string; rows: ReadonlyArray<{ id: string; text: string }> }) => { seen.push(rows.map((r) => r.id)); return { verdicts: new Map(rows.map((r) => [r.id, RUMOR_IDS.has(r.id)])), costUsd: 0.0004 }; };
const scriptedVariants = (terms: string[]) => async () => ({ terms, costUsd: 0.0001 });

async function plan(pages: unknown[], extra: Record<string, unknown> = {}, priorCalls?: unknown[]) {
  const store = createMemoryStore();
  const calls: Array<Record<string, unknown>> = [];
  if (priorCalls) for (const [i, p] of (priorCalls as Array<{ page: unknown }>).entries()) await store.putFile("msn_t", RAW_PATH(`call_${String(i + 1).padStart(4, "0")}`), JSON.stringify(p.page), "application/json");
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      calls.push((input.params ?? {}) as Record<string, unknown>);
      const n = (priorCalls?.length ?? 0) + calls.length;
      const page = pages[calls.length - 1] ?? pageOf([]);
      const callId = `call_${String(n).padStart(4, "0")}`;
      await store.putFile("msn_t", RAW_PATH(callId), JSON.stringify(page), "application/json");
      const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!);
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: (page as { output?: { data?: { nextCursor?: string | null } } }).output?.data?.nextCursor ?? null };
    },
  };
  const r = await planByCompiler({ mission: { id: "msn_t", request_text: fx.request_text, answer_text: fx.source_answer, created_at: fx.created_at } as never, gateway: gateway as never, store, catalog, nowMs, choices: { sourceId: fx.source_answer }, answerIsChoice: true, ...(priorCalls ? { priorCalls: (priorCalls as Array<Record<string, unknown>>).map((c, i) => ({ ...c, id: `msn_t:call_${String(i + 1).padStart(4, "0")}` })) } : {}), ...extra } as never);
  return { r, calls, queries: calls.map((c) => String(c.query ?? "")) };
}
const parentStage = (p: PricedPlan): PricedStage => p.stages.find((s) => s.parent_key === null)!;

describe("the incident as recorded (the evidence these tests stand on)", () => {
  it("3 rows, the empty cursor page read twice, a plan of the sample priced by the minimum, no execution read, 0 of 3 about the topic, completed and 200 points charged", () => {
    expect(fx.calls.map((c) => [c.cursor_sent, c.rows_returned])).toEqual([[false, 3], [true, 0], [true, 0]]);
    expect(fx.execution_calls).toBe(0);
    expect(fx.plan.planned_rows).toBe(3);
    expect(fx.plan.unit_price_points).toBeCloseTo(fx.plan.reserve_points / 3, 3);
    expect(fx.outcome).toMatchObject({ status: "completed", delivered_units: 3, charged_points: 200 });
    expect(fx.outcome.workbook_topic_marks).toEqual({ "يتحدث نصه عن الموضوع": 0, "لا يذكر الموضوع": 3 });
    expect(fx.questions.find((q) => q.why === "no_about")!.options_offered).toContain(NO_ABOUT_OPTIONS_AR.useAsIs);
    // the plan contradicted itself before approval
    expect(fx.plan.contradictory_notes.join(" ")).toMatch(/يذكر واحدًا منها على الأقل/);
    expect(fx.plan.contradictory_notes.join(" ")).toMatch(/ما اخترناه لا يذكر الموضوع/);
    // R2: every delivered row carries the topic's root in its OTHER meaning
    for (const it of fx.page_1_items) expect(String(it.text)).toMatch(/شائع/);
  });
  it("the query sent is the one the compiler still builds for the precise strategy (source, period, originals kept)", () => {
    expect(String(parentInputs(xSearch, ask()).query)).toBe(fx.query_sent);
  });
});

describe("R1 + R2: a research topic is a GATE judged by meaning, at planning and at execution", () => {
  it("planning with the judge: the three rows are judged not about rumors, nothing is priced, and the question no longer offers to buy them", async () => {
    const seen: string[][] = [];
    const { r, calls } = await plan([PAGE_1, pageOf([])], { judge: scriptedJudge(seen) });
    expect(r.kind).toBe("question");
    if (r.kind !== "question") return;
    expect(r.why).toBe("no_about");
    expect(r.options).toEqual([NO_ABOUT_OPTIONS_AR.change, NO_ABOUT_OPTIONS_AR.cancel]);
    expect(r.options).not.toContain(NO_ABOUT_OPTIONS_AR.useAsIs);
    expect(seen.flat().sort()).toEqual(fx.page_1_items.map((i) => String(i.id)).sort());
    expect(calls.length).toBeLessThanOrEqual(2);
  });
  it("the former answer «أكمل بما وجدتموه كما هو» no longer lets an unrelated row be planned (it is asked again, never priced)", async () => {
    const store = createMemoryStore();
    const gateway = { async tregCall(input: { endpoint_id?: unknown; params?: unknown }) { const callId = "call_0001"; await store.putFile("msn_t", RAW_PATH(callId), JSON.stringify(pageOf(fx.page_1_items)), "application/json"); void input; return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: 3, has_more: false, next_cursor: null }; } };
    const r = await planByCompiler({ mission: { id: "msn_t", request_text: fx.request_text, answer_text: fx.final_answer_text, created_at: fx.created_at } as never, gateway: gateway as never, store, catalog, nowMs, choices: { sourceId: fx.source_answer } } as never);
    expect(r.kind).not.toBe("plan");
  });
  it("without the model (word rule only) the three rows are still never planned: the topic gate of a source-carried search holds", async () => {
    const { r } = await plan([PAGE_1, pageOf([])]);
    expect(r.kind).toBe("question");
    if (r.kind === "question") expect(r.options).not.toContain(NO_ABOUT_OPTIONS_AR.useAsIs);
  });
  it("a post about the topic that does not repeat the customer's words is chosen when judged about it (meaning, not words)", async () => {
    const offWords = synthetic("9000000000000000003", "احرصوا على استقاء المعلومات الصحية من مصادرها الموثوقة وعدم تداول الأخبار المجهولة المصدر.");
    RUMOR_IDS.add(offWords.id);
    try {
      const { r } = await plan([pageOf([...fx.page_1_items, offWords], null)], { judge: scriptedJudge() });
      expect(r.kind).toBe("plan");
      if (r.kind !== "plan") return;
      expect((parentStage(r.plan).pinned_rows ?? []).map((x) => x.id)).toEqual([offWords.id]);
    } finally { RUMOR_IDS.delete(offWords.id); }
  });
  it("every compiled plan of a research topic carries the execution gate: the model judges every row with text, the words decide nothing", () => {
    const spec = researchRelevanceOf(ask(), ["text"])!;
    expect(spec).toMatchObject({ judge: "model", review: true, text_columns: ["text"] });
    for (const it of fx.page_1_items) expect(classifyRowDetailed(spec, { text: it.text }).verdict).toBe("review");
    expect(classifyRowDetailed(spec, { text: "" }).verdict).toBe("exclude");
    // a topic the items are made WITH (a sound) is not a research topic
    expect(researchRelevanceOf({ topic: { text: "اغنية", relation: "made_with" } } as never, ["text"])).toBeNull();
  });
  it("execution: the pinned sample is no longer replayed blind; the review decides, the rejected rows are neither delivered nor charged, the accepted ones say so in the file", async () => {
    const spec = researchRelevanceOf(ask(), ["text"])!;
    const stage = {
      key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001,
      columns: [{ key: "text", title_ar: "النص" }, { key: "username", title_ar: "اسم المستخدم" }, { key: TOPIC_RELATION_KEY, title_ar: "علاقة النص بالموضوع" }], relevance: spec,
    } as never;
    const plan0 = { summary_ar: "x", stages: [stage], price: { totalCostUsd: 0, deliveredRows: 5, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 5, maxChargePoints: 5, overCap: false } } as unknown as PricedPlan;
    const items = await ItemStore.open(createMemoryStore(), "msn_exec", { legacyStages: ["tweets"] });
    const asked: string[] = [];
    const reviewer = { budgetUsd: 1, state: async () => ({ stop: null }) as never, review: async ({ rows: r }: { rows: Array<{ id: string }> }) => { asked.push(...r.map((x) => x.id)); return new Map(r.map((x) => [x.id, RUMOR_IDS.has(x.id)])); } };
    const rows = [...fx.page_1_items, ...RUMOR_POSTS].map((x) => ({ id: x.id, text: x.text, username: x.authorUsername, [TOPIC_RELATION_KEY]: "لا يذكر الموضوع" }));
    // raw: the pinned-row replay (agent/src/engine/run.ts runPinnedRows); before the fix it skipped every relevance rule
    await ingestRows({ items, plan: plan0, addEvent: async () => undefined, reviewer: reviewer as never }, stage, rows, { silent: true, idField: null, raw: true });
    expect(asked.sort()).toEqual(rows.map((r) => r.id).sort());
    const accepted = items.acceptedRows("tweets");
    expect(accepted.map((r) => r.id).sort()).toEqual([...RUMOR_IDS].sort());
    for (const r of accepted) expect(r[TOPIC_RELATION_KEY]).toBe(topicRelationAr(2));
    expect(items.counts("tweets").excludedByReason.review_no).toBe(3);
  });
  it("execution with no reviewer (no model key): nothing of a research topic is delivered unjudged", async () => {
    const spec = researchRelevanceOf(ask(), ["text"])!;
    const stage = { key: "tweets", title_ar: "التغريدات", endpoint_id: "e", expected_rows: 3, planned_rows: 3, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, columns: [{ key: "text", title_ar: "النص" }], relevance: spec } as never;
    const plan0 = { summary_ar: "x", stages: [stage], price: { totalCostUsd: 0, deliveredRows: 3, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 3, maxChargePoints: 3, overCap: false } } as unknown as PricedPlan;
    const items = await ItemStore.open(createMemoryStore(), "msn_exec2", { legacyStages: ["tweets"] });
    await ingestRows({ items, plan: plan0, addEvent: async () => undefined }, stage, fx.page_1_items.map((x) => ({ id: x.id, text: x.text })), { silent: true, idField: null, raw: true });
    expect(items.acceptedRows("tweets")).toHaveLength(0);
  });
});

describe("R3: a planning sample never sizes the plan", () => {
  it("relevant rows found and the query NOT at its end: the plan is sized by the customer's 400 (an open promise), priced on 400, executed by a fresh read with the gate", async () => {
    const nextPage = pageOf([synthetic("9000000000000000009", "مواعيد التطعيم الموسمي في المراكز الصحية.")], "cur_more_2");
    const { r } = await plan([pageOf([...fx.page_1_items, ...RUMOR_POSTS], "cur_more"), nextPage], { judge: scriptedJudge() });
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const st = parentStage(r.plan);
    expect(st.planned_rows).toBe(400);
    expect(r.plan.compiled?.promises?.tweets).toEqual({ type: "open", n: 400 });
    expect((st.pinned_rows ?? []).length).toBe(2);
    expect((st.pinned_rows ?? []).length).toBeLessThan(st.planned_rows); // runPinnedRows is skipped: the engine reads the source afresh
    expect(st.relevance?.judge).toBe("model");
    // never the minimum spread over the sample (66.67 a tweet in the incident)
    expect(r.plan.price.unitPricePoints).toBeLessThan(fx.plan.unit_price_points / 10);
    expect(r.plan.price.deliveredRows).toBe(400);
    const notes = (r.plan.notes_ar ?? []).join(" ");
    expect(notes).toContain("العينة لا تبيّن كم يوجد في المصدر");
    expect(notes).toContain("لا يُخصم إلا مقابل ما يُسلَّم فعلًا");
    expect(notes).toContain(RESEARCH_GATE_NOTE_AR);
    // the contradiction of the incident is gone: no note claims the chosen items «name» the alternatives, and none says the chosen ones are off-topic
    expect(notes).not.toMatch(/يذكر واحدًا منها على الأقل/);
    expect(notes).not.toMatch(/ما اخترناه لا يذكر الموضوع/);
    // the file's mark of the pinned rows is the judgment
    for (const row of st.pinned_rows ?? []) expect(row[TOPIC_RELATION_KEY]).toBe(topicRelationAr(2));
  });
  it("the query reached its END at planning: what was found is what the source gives, the plan is sized by it and says the source ended", async () => {
    const { r } = await plan([pageOf([...fx.page_1_items, ...RUMOR_POSTS], null)], { judge: scriptedJudge() });
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(parentStage(r.plan).planned_rows).toBe(2);
    expect((r.plan.notes_ar ?? []).join(" ")).toMatch(/انتهت نتائج المصدر لهذا البحث/);
    // the customer's own number is kept: delivering the 2 that exist is PARTIAL against the 400 asked (customerView / requestedRowsOf), never «complete»
    expect(r.plan.quantity).toMatchObject({ requested: 400, target: 2, source: "request" });
  });
});

describe("R4: recall, the expanded strategy, bounded", () => {
  const VARIANTS = ["شائعات", "إشاعات", "معلومات مغلوطة", "أخبار كاذبة", "مصادر موثوقة"];
  it("(15 Nov retest, msn_7365/c676/cfee) THE FIRST READ IS THE EXPANDED QUERY (the customer's words OR the model's search terms), its next page is the second sample, and the plan executes it", async () => {
    const { r, queries, calls } = await plan([pageOf([...fx.page_1_items, ...RUMOR_POSTS], "cur_x"), pageOf([], null)], { judge: scriptedJudge(), variants: scriptedVariants(VARIANTS) });
    expect(queries).toHaveLength(2);
    // the precise query alone is never read first: its terms are inside the disjunction, so the expanded read finds everything it finds
    expect(queries[0]).not.toBe(fx.query_sent);
    expect(queries[0]).toMatch(/^\(شائعات OR إشاعات OR "معلومات مغلوطة" OR "أخبار كاذبة" OR "مصادر موثوقة" OR الشائعات OR "التصدي للشائعات" OR "جهود الوزارة في مكافحة الشائعات"\) from:SaudiMOH since:\S+ until:\S+ -filter:replies$/);
    // the second sample is the SAME query's next page (never a literal query that the expanded one already contains)
    expect(queries[1]).toBe(queries[0]);
    expect(calls[1].cursor).toBe("cur_x");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(String(parentStage(r.plan).engine?.params?.query)).toBe(queries[0]);
    expect((r.plan.notes_ar ?? []).join(" ")).toMatch(/بحثنا بعباراتك وبصيغ أخرى للموضوع ومرادفاته معًا/);
    expect((r.plan.notes_ar ?? []).join(" ")).not.toMatch(/بعباراتك وحدها/);
  });
  it("with no search terms (no model, or the variants call failed) the precise query is read first, as before", async () => {
    const { queries } = await plan([PAGE_1, pageOf([])], { judge: scriptedJudge(), variants: async () => ({ terms: [], costUsd: 0.0001, failed: true as const }) });
    expect(queries[0]).toBe(fx.query_sent);
  });
  it("an EMPTY expanded page is followed only by the source's own items in the period (never by the narrower «all the words» query)", async () => {
    const { queries } = await plan([pageOf([], null), pageOf(fx.page_1_items, null)], { judge: scriptedJudge(), variants: scriptedVariants(VARIANTS) });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/^\(شائعات OR/);
    expect(queries[1]).toMatch(/^from:SaudiMOH since:\S+ until:\S+ -filter:replies$/);
  });
  it("the expanded query keeps every hard condition, differs from the precise one from its first word (a recorded page is matched by its first 80 characters), and fits the length cap", () => {
    const a = ask();
    const ex = expandedInputsOf(xSearch, a, VARIANTS)!;
    const exact = String(parentInputs(xSearch, a).query);
    const q = String(ex.params.query);
    for (const cond of ["from:SaudiMOH", "since:", "until:", "-filter:replies"]) expect(q).toContain(cond);
    expect(q.slice(0, 80)).not.toBe(exact.slice(0, 80));
    const many = Array.from({ length: 40 }, (_, i) => `صيغة طويلة رقم ${i}`);
    expect(String(expandedInputsOf(xSearch, a, many)!.params.query).length).toBeLessThanOrEqual(EXPANDED_QUERY_MAX_CHARS);
    expect(expandedInputsOf(xSearch, a, [])).toBeNull();
  });
  it("model variants are cleaned by code: no operators, quotes, accounts, long phrases or repeats of the customer's own alternatives", () => {
    const alts = ["الشائعات", "التصدي للشائعات"];
    expect(cleanVariants(["شائعات", "الشائعات", "from:SaudiMOH", "\"x\"", "a OR b", "(تضليل)", "معلومات مغلوطة", "كلمة واحدة اثنتان ثلاث أربع خمس", "#لا_للشائعات", "شائعات"], alts)).toEqual(["شائعات", "معلومات مغلوطة", "لا_للشائعات"]);
    expect(cleanVariants(Array.from({ length: 30 }, (_, i) => `صيغة${i}`), alts)).toHaveLength(MAX_TOPIC_VARIANTS);
    expect(cleanVariants("not an array", alts)).toEqual([]);
  });
  it("the real variants call is read from the model's JSON array and costs what the API says; an unusable answer adds nothing", async () => {
    const call = async () => ({ text: 'إليك: ["شائعات","إشاعات","from:x"]', usage: { input_tokens: 1000, output_tokens: 50 } });
    const got = await topicVariants(call as never)({ request: fx.request_text, topic: "الشائعات", alternatives: ["الشائعات"] });
    expect(got?.terms).toEqual(["شائعات", "إشاعات"]);
    expect(got!.costUsd).toBeGreaterThan(0);
    const bad = await topicVariants((async () => ({ text: "no list", usage: { input_tokens: 10, output_tokens: 2 } })) as never)({ request: "r", topic: "t", alternatives: [] });
    expect(bad?.terms).toEqual([]);
  });
  it("still nothing about the topic after both strategies: no plan, and the end sentence counts what the judgment found (not the shared words)", async () => {
    const { r } = await plan([PAGE_1, pageOf(fx.page_1_items, null)], { judge: scriptedJudge(), variants: scriptedVariants(VARIANTS) });
    expect(r.kind).not.toBe("plan");
  });
  it("at most the two samples of one source are read at planning, whatever the strategies", async () => {
    const { calls } = await plan([PAGE_1, pageOf([]), pageOf([]), pageOf([])], { judge: scriptedJudge(), variants: scriptedVariants(VARIANTS) });
    expect(calls.length).toBeLessThanOrEqual(2);
  });
});

describe("the planning judge reuses the execution's review (same prompt, same forced 0/1 answer), stores nothing, and is capped", () => {
  it("judges the rows and returns the cost the API reported", async () => {
    const prompts: string[] = [];
    const call = async ({ user, rows }: { user: string; rows?: number }) => { prompts.push(user); return { text: JSON.stringify(Array.from({ length: rows ?? 0 }, (_, i) => (i === 0 ? 1 : 0))), usage: { input_tokens: 2000, output_tokens: 20 } }; };
    const judge = planningJudge(call as never, fx.request_text);
    const got = await judge({ subject: "s", rows: fx.page_1_items.map((x) => ({ id: String(x.id), text: String(x.text) })) });
    expect([...got!.verdicts.values()]).toEqual([true, false, false]);
    expect(got!.costUsd).toBeGreaterThan(0);
    expect(prompts[0]).toContain(fx.request_text.slice(0, 50));
  });
  it("a model that cannot be reached leaves every row undecided (the word rule then applies at planning; execution judges again)", async () => {
    const judge = planningJudge((async () => null) as never, fx.request_text);
    const got = await judge({ subject: "s", rows: [{ id: "a", text: "x" }] });
    expect(got?.verdicts.size).toBe(0);
  });
});

describe("an empty page already read for this mission is not paid for again", () => {
  it("the recorded empty cursor page is served from its saved copy at the next planning run", async () => {
    const prior = [
      { phase: "planning", status: "ok", endpoint_id: "anyapi.x.search.posts", params_digest: { limit: 20, query: fx.query_sent.slice(0, 80), queryType: "Latest" }, page: PAGE_1 },
      { phase: "planning", status: "empty", endpoint_id: "anyapi.x.search.posts", params_digest: { limit: 20, query: fx.query_sent.slice(0, 80), cursor: fx.page_1_next_cursor, queryType: "Latest" }, page: pageOf([]) },
    ];
    const { calls } = await plan([], {}, prior);
    expect(calls).toHaveLength(0);
  });
});

describe("the customer's end sentence counts by meaning when the judgment decided", () => {
  it("«تتحدث فعلًا عن الموضوع» with the judged count, never «تذكر الموضوع» for a shared word", () => {
    const s = searchScopeEndAr({ platform: "x", sourceId: "SaudiMOH", period: { from: "2021-11-15", to: "2026-11-15" }, topic: "الشائعات", alternatives: ["الشائعات"], strategies: [{ strategy: "exact", rows: 3 }, { strategy: "expanded", rows: 3 }], read: 3, bySource: 3, inPeriod: 3, about: 0, judged: true });
    expect(s).toContain("تتحدث فعلًا عن الموضوع بعد فحص كل منها: ٠");
    expect(s).toContain("بصيغ أخرى للموضوع");
    expect(s).toContain("لم يُخصم منك شيء");
  });
});

describe("END TO END (planning, then the real engine): the execution reads past the sample, through the gate, until the source ends", () => {
  it("400 asked, 2 relevant in the sample: the engine reads the source afresh page after page, the review keeps only posts about the request, the stop is the source's end, and the delivery is PARTIAL against 400", async () => {
    const store = createMemoryStore();
    const served: Array<Record<string, unknown>> = [];
    let n = 0;
    const more = [synthetic("9000000000000000011", "الوزارة تنفي ما يتم تداوله من شائعات عن نقص الأدوية."), synthetic("9000000000000000012", "اليوم العالمي للسكري: نصائح للوقاية.")];
    RUMOR_IDS.add("9000000000000000011");
    const pageFor = (params: Record<string, unknown>): unknown => {
      const cursor = params.cursor;
      if (!cursor) return pageOf([...fx.page_1_items, ...RUMOR_POSTS], "c1");
      if (cursor === "c1") return pageOf(more, "c2");
      return pageOf([], null);
    };
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        n += 1;
        const params = (input.params ?? {}) as Record<string, unknown>;
        served.push(params);
        const page = pageFor(params);
        const callId = `call_${String(n).padStart(4, "0")}`;
        await store.putFile("msn_t", RAW_PATH(callId), JSON.stringify(page), "application/json");
        const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!);
        const next = (page as { output?: { data?: { nextCursor?: string | null } } }).output?.data?.nextCursor ?? null;
        return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: next !== null, next_cursor: next, cost_usd: 0.00049 };
      },
    };
    try {
      const planned = await planByCompiler({ mission: { id: "msn_t", request_text: fx.request_text, answer_text: fx.source_answer, created_at: fx.created_at } as never, gateway: gateway as never, store, catalog, nowMs, choices: { sourceId: fx.source_answer }, answerIsChoice: true, judge: scriptedJudge() } as never);
      expect(planned.kind).toBe("plan");
      if (planned.kind !== "plan") return;
      const plan = planned.plan;
      expect(parentStage(plan).planned_rows).toBe(400);
      const planningCalls = served.length;
      const items = await ItemStore.open(store, "msn_t");
      const asked: string[] = [];
      const reviewer = { budgetUsd: 1, state: async () => emptyReviewState(), review: async ({ rows }: { rows: Array<{ id: string }> }) => { asked.push(...rows.map((r) => r.id)); return new Map(rows.map((r) => [r.id, RUMOR_IDS.has(r.id)])); } };
      const approved = withPromiseCaps(plan);
      const outcome = await runEngine({ reviewer: reviewer as never, items, store, plan: approved, missionId: "msn_t", gateway: gateway as never, sandbox: (code: string, inputs: Record<string, unknown>) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 600_000, sleep: async () => undefined, now: () => nowMs + 600_000, redesignStages: new Set(approved.stages.map((st) => st.key)) } as never);
      // the execution READ (the incident's execution read nothing): past the sample's page, to the source's end
      expect(served.length - planningCalls).toBeGreaterThanOrEqual(2);
      expect(outcome.stops.tweets).toBe("source_exhausted");
      const delivered = items.snapshotOfMemory().acceptedRows("tweets", 400);
      expect(delivered.map((r) => r.id).sort()).toEqual(["9000000000000000001", "9000000000000000002", "9000000000000000011"]);
      for (const r of delivered) { expect(r.username).toBe("SaudiMOH"); expect(r[TOPIC_RELATION_KEY]).toBe(topicRelationAr(2)); }
      // every row read was judged; none of the incident's three and not the off-topic diabetes post was delivered
      for (const it of fx.page_1_items) expect(asked).toContain(String(it.id));
      expect(asked).toContain("9000000000000000012");
      // 3 delivered of 400 asked: partial (the customer view and the result compare with the plan's 400), charged per delivered row only
      expect(delivered.length).toBeLessThan(parentStage(plan).planned_rows);
    } finally { RUMOR_IDS.delete("9000000000000000011"); }
  });
});

/** The planning and the real engine over one scripted source (page by cursor), shared by the review-finding tests below. */
async function planAndRun(pageFor: (params: Record<string, unknown>) => unknown, reviewer: unknown, extra: Record<string, unknown> = {}) {
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
  const planned = await planByCompiler({ mission: { id: "msn_t", request_text: fx.request_text, answer_text: fx.source_answer, created_at: fx.created_at } as never, gateway: gateway as never, store, catalog, nowMs, choices: { sourceId: fx.source_answer }, answerIsChoice: true, judge: scriptedJudge(), ...extra } as never);
  if (planned.kind !== "plan") throw new Error(`no plan: ${planned.kind}`);
  const planningCalls = served.length;
  const items = await ItemStore.open(store, "msn_t");
  const approved = withPromiseCaps(planned.plan);
  const outcome = await runEngine({ reviewer: reviewer as never, items, store, plan: approved, missionId: "msn_t", gateway: gateway as never, sandbox: (code: string, inputs: Record<string, unknown>) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 600_000, sleep: async () => undefined, now: () => nowMs + 600_000, redesignStages: new Set(approved.stages.map((st) => st.key)) } as never);
  return { plan: planned.plan, outcome, items, served, executionCalls: served.length - planningCalls };
}
const judgingReviewer = () => ({ budgetUsd: 1, state: async () => emptyReviewState(), review: async ({ rows }: { rows: Array<{ id: string }> }) => new Map(rows.map((r) => [r.id, RUMOR_IDS.has(r.id) || r.id.startsWith("rumor_")])) });

describe("independent review findings (fixed before merge)", () => {
  it("HIGH: reading on at execution keeps the plan's own selection rules as hard gates: another account, outside the period, or an X reply is never delivered, even about the topic", async () => {
    const other = { ...synthetic("rumor_other", "شائعات عن اللقاحات يجب الحذر منها."), authorUsername: "SomeoneElse", authorName: "حساب آخر" };
    const old = synthetic("rumor_old", "تحذر الوزارة من الشائعات.", "2019-01-01T10:00:00.000Z");
    const reply = { ...synthetic("rumor_reply", "@x لا صحة لهذه الشائعة."), isReply: true };
    const good = synthetic("rumor_good", "الوزارة تنفي شائعة انتشار وباء جديد.");
    const pageFor = (params: Record<string, unknown>) => (!params.cursor ? pageOf([...fx.page_1_items, ...RUMOR_POSTS], "c1") : params.cursor === "c1" ? pageOf([other, old, reply, good], "c2") : pageOf([], null));
    const { items, executionCalls } = await planAndRun(pageFor, judgingReviewer());
    expect(executionCalls).toBeGreaterThanOrEqual(2);
    const ids = items.snapshotOfMemory().acceptedRows("tweets", 400).map((r) => String(r.id)).sort();
    expect(ids).toEqual([...RUMOR_POSTS.map((p) => p.id), "rumor_good"].sort());
    const ex = items.counts("tweets").excludedByReason;
    expect(ex.filter_account).toBe(1);
    expect(ex.filter_period).toBe(1);
    expect(ex.filter_reply).toBe(1);
  });
  it("MEDIUM: a research read ends after consecutive pages that add nothing the review accepts (bounded by yield, not by the budget)", async () => {
    let page = 0;
    const offTopic = (n: number) => Array.from({ length: 20 }, (_, i) => synthetic(`80000000000${String(n).padStart(3, "0")}${String(i).padStart(3, "0")}`, `منشور عن موضوع آخر ${n}-${i}`));
    const pageFor = (params: Record<string, unknown>) => { if (!params.cursor) return pageOf([...RUMOR_POSTS], "p1"); page += 1; return pageOf(offTopic(page), `p${page + 1}`); };
    const { outcome, executionCalls } = await planAndRun(pageFor, judgingReviewer());
    expect(outcome.stops.tweets).toBe("topic_dry");
    expect(executionCalls).toBeLessThanOrEqual(JUDGED_DRY_PAGES + 3);
  });
  it("MEDIUM: the topic variants are asked ONCE per mission; a later planning run builds the same expanded query and reads it from its recorded page", async () => {
    const VARS = ["شائعات", "إشاعات"];
    let asked = 0;
    const variants = async () => { asked += 1; return { terms: asked === 1 ? VARS : ["مختلف"], costUsd: 0.0001 }; };
    const store = createMemoryStore();
    const queries: string[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const params = (input.params ?? {}) as Record<string, unknown>;
        queries.push(String(params.query));
        sent.push(params);
        const page = queries.length === 1 ? PAGE_1 : pageOf([...RUMOR_POSTS], "cx");
        const callId = `call_${String(queries.length).padStart(4, "0")}`;
        await store.putFile("msn_t", RAW_PATH(callId), JSON.stringify(page), "application/json");
        return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: 3, has_more: true, next_cursor: queries.length === 1 ? fx.page_1_next_cursor : "cx" };
      },
    };
    const deps = { mission: { id: "msn_t", request_text: fx.request_text, answer_text: fx.source_answer, created_at: fx.created_at }, gateway, store, catalog, nowMs, choices: { sourceId: fx.source_answer }, answerIsChoice: true, judge: scriptedJudge(), variants };
    const first = await planByCompiler(deps as never);
    expect(first.kind).toBe("plan");
    expect(JSON.parse((await store.getFile("msn_t", VARIANTS_FILE))!)).toMatchObject({ terms: VARS });
    // recorded the way the gateway records them (every input, strings clipped to 80 characters: gateway.ts `params_digest`)
    const recorded = sent.map((p, i) => ({ id: `msn_t:call_${String(i + 1).padStart(4, "0")}`, phase: "planning", status: "ok", endpoint_id: "anyapi.x.search.posts", params_digest: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 80) : v])) }));
    const before = queries.length;
    const second = await planByCompiler({ ...deps, priorCalls: recorded } as never);
    expect(second.kind).toBe("plan");
    expect(asked).toBe(1);
    expect(queries.length).toBe(before);
    if (first.kind === "plan" && second.kind === "plan") expect(second.plan.stages[0].engine?.params).toEqual(first.plan.stages[0].engine?.params);
  });
  it("LOW: the question is truthful when the judgment rejected rows that DO share a word with the topic; the gate sentence of a plan with comments says the comments are not judged", () => {
    const q = noAboutQuestionAr("الشائعات", { one: "تغريدة", talks: "يتحدث نصها" }, false, true);
    expect(q).toContain("لا يتحدث عن الموضوع، وإن تشابهت بعض كلماته");
    expect(q).not.toContain("لا يذكر الموضوع في نصه");
  });
  it("LOW: a row accepted later by the review (a pending row resolved) carries the verdict's mark too", async () => {
    const items = await ItemStore.open(createMemoryStore(), "msn_mark", { legacyStages: ["tweets"] });
    await items.commit([{ t: "item", stage: "tweets", id: "a", state: "pending", reason: "not_reviewed", row: { id: "a", text: "x" } }] as never);
    await items.commit([{ t: "resolve", stage: "tweets", id: "a", state: "accepted", by: "model", marks: { [TOPIC_RELATION_KEY]: topicRelationAr(2) } }] as never);
    expect(items.acceptedRows("tweets")[0][TOPIC_RELATION_KEY]).toBe(topicRelationAr(2));
  });
});
