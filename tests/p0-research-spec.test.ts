import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { RAW_PATH } from "../agent/src/gateway";
import { anthropicReviewCall, createReviewer, reviewPrompt, type ReviewCall } from "../agent/src/review";
import { planningJudge, topicVariants } from "../agent/src/researchJudge";
import { checkedSpecAnswer, customerAlternativesCount, customerWordsOf, readResearchSpec, researchSpecFor, RESEARCH_SPEC_FILE, specBlock, specSignature, SPEC_SYSTEM, type ResearchSpec } from "../agent/src/researchSpec";
import { buildMethodology, periodLimitLineAr, topicRelationLinesOf, type MissionFacts } from "../agent/src/methodology";
import { customerWordsFromPlan, customerWordsToStore, CUSTOMER_WORDS_MAX_TURNS } from "../src/lib/agentMission/customerWords";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { researchRelevanceOf } from "../src/lib/agentMission/foundation/compilePlan";
import { TOPIC_RELATION_KEY, TOPIC_RELATION_TITLE_AR, topicRelationAr } from "../src/lib/agentMission/foundation/topicChoice";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { agentChatTurn } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * P0, 15 NOV 2026: THE CUSTOMER'S MEANING IS ONE STORED SPECIFICATION, READ BY EVERY JUDGMENT (production evidence: msn_6d86fb6f698bb8ca7320, msn_5abbc68352f31fa31d56).
 *
 * What production proved (read-only queries, recorded in the fixture):
 *  R1 THE CUSTOMER'S WORDS NEVER REACHED THE WORKER. The customer wrote «… الشائعات الصحية أو تصحيح الشائعات أو جهود الوزارة في مكافحة المعلومات المضللة …»; the mission stored only the chat model's summary «… الشائعات الصحية وتصحيح
 *     الشائعات وجهود الوزارة في مكافحة …» («أو» became «و»).
 *  R2 EACH STEP RE-DERIVED THE MEANING FROM THE STEP BEFORE. The worker's word rules read the summary as the topic «الشائعات الصحية وتصحيح الشائعات وجهود الوزارة» (no alternatives, the qualifier cut at «في»), and that label was the
 *     judge's «What they mean»: the continuation delivered six tweets, five of them the ministry's general news.
 *  R3 PLANNING AND EXECUTION BUILT THEIR JUDGE INPUTS SEPARATELY (two subjects, two request strings).
 *  R4 THE METHODOLOGY CONTRADICTED ITSELF: «لم يُحذف بها شيء … وسُلّمت كلها» beside a counts table of exclusions; a word-rule sentence for a meaning judgment; «غطّت النتائج أقل من ساعة» for one tweet of a five-year request; and
 *     the summary shown as «طلبك (بكلماتك)».
 */
const fx = JSON.parse(readFileSync(new URL("./fixtures/p0-research-spec/production-2026-11-15.json", import.meta.url), "utf8")) as {
  missions: Array<{ id: string; customer_said: string; request_text: string; answer_text: string; delivered: number; delivered_on_topic?: number; methodology_lines_seen?: string[] }>;
};
const [FIRST, FOLLOW] = fx.missions;
const NOW = Date.parse("2026-11-15T12:00:00Z");
/** The owner's acceptance request (the critical scenario), as written. */
const CRITICAL = "أنا محتاجة 400 تغريدة من حساب وزارة الصحة السعودية عن الشائعات أو التصدي للشائعات أو جهود الوزارة في مكافحة الشائعات خلال آخر خمس سنين. ولو العدد المتاح أقل من 400 مفيش مشكلة، بس لازم التغريدات تكون فعلًا من حساب الوزارة وعن الموضوع ده.";
const FOLLOW_UP = "هات 400 تغريدة تانية عن نفس الموضوع ومن نفس الحساب ومن غير تكرار.";

/** A model answer of the forced structured tool, as the real call hands it back (the tool input as JSON text). */
const GOOD = { criterion: "تغريدات الوزارة التي تتناول الشائعات الصحية أو تصحيحها أو جهود الوزارة في مكافحة المعلومات المضللة", any_of: ["الشائعات الصحية", "تصحيح الشائعات", "جهود الوزارة في مكافحة المعلومات المضللة"], not_relevant: ["أخبار الوزارة العامة وأنشطتها التي لا تتناول الشائعات", "«أخطاء شائعة» بمعنى أخطاء متكررة"] };
function specCall(answer: unknown, seen: Array<Record<string, unknown>> = [], extra: Record<string, unknown> = {}): ReviewCall {
  return (async (i: Record<string, unknown>) => { seen.push(i); return { text: typeof answer === "string" ? answer : JSON.stringify(answer), usage: { input_tokens: 900, output_tokens: 120 }, ...extra }; }) as unknown as ReviewCall;
}
const mission = (m: { id: string; request_text: string; answer_text?: string | null }) => ({ id: m.id, request_text: m.request_text, answer_text: m.answer_text ?? null, created_at: "2026-11-15T12:00:00Z" }) as never;

describe("R1/R2 recorded: the summary lost the customer's alternatives and the word rules cut the qualifier", () => {
  it("the customer's words give three alternatives with their qualifier; the stored summary gives one topic without «في مكافحة …»", () => {
    const own = buildAsk(FIRST.customer_said, null, NOW, {}, { semantic: false }).topic;
    const summary = buildAsk(FIRST.request_text, null, NOW, {}, { semantic: false }).topic;
    expect(own.alternatives).toEqual(["الشائعات الصحية", "تصحيح الشائعات", "جهود الوزارة في مكافحة المعلومات المضللة"]);
    expect(summary.alternatives).toBeUndefined();
    expect(summary.text).toBe("الشائعات الصحية وتصحيح الشائعات وجهود الوزارة");
    // the subject the judge was given from the summary: the qualifier is gone (the label production judged with)
    expect(researchRelevanceOf({ topic: summary }, ["text"])!.subject_ar).not.toContain("مكافحة");
    expect(FOLLOW.delivered_on_topic).toBe(1);
    expect(FOLLOW.delivered).toBe(6);
  });
  it("the owner's critical request keeps three alternatives in the customer's words", () => {
    expect(customerAlternativesCount([CRITICAL], NOW)).toBe(3);
    expect(customerAlternativesCount([FIRST.request_text], NOW)).toBe(0);
  });
});

describe("the customer's own words are stored with the card by code, bounded", () => {
  it("keeps the newest turns, oldest first, one line each, clipped; drops empty and non-text values", () => {
    const many = Array.from({ length: 12 }, (_, i) => `رسالة ${i + 1}\n  ثانية`);
    const kept = customerWordsToStore(many);
    expect(kept).toHaveLength(CUSTOMER_WORDS_MAX_TURNS);
    expect(kept[kept.length - 1]).toBe("رسالة 12 ثانية");
    expect(customerWordsToStore(["x".repeat(2000)])[0]).toHaveLength(900);
    expect(customerWordsFromPlan({ customerWords: ["  ", 5, "أهلًا", null] })).toEqual(["أهلًا"]);
    expect(customerWordsFromPlan({ agentMissionId: "m" })).toBeNull();
    expect(customerWordsFromPlan(null)).toBeNull();
  });
  it("a mission with no stored words is judged with its own text (admin missions, older cards)", () => {
    expect(customerWordsOf(null, { request_text: "نص  المهمة" })).toEqual(["نص المهمة"]);
    expect(customerWordsOf([FIRST.customer_said, FOLLOW.customer_said], { request_text: "x" })).toEqual([FIRST.customer_said, FOLLOW.customer_said]);
  });
});

describe("the model's spec is checked by code before anything uses it", () => {
  it("a good answer is kept; Western digits become Arabic-Indic", () => {
    const got = checkedSpecAnswer({ ...GOOD, criterion: `${GOOD.criterion} خلال 5 سنوات` }, { alternatives: 3, words: [CRITICAL] });
    expect(got?.anyOf).toHaveLength(3);
    expect(got?.criterion).toContain("٥");
  });
  it("an answer that MERGES the customer's «أو» alternatives into one condition is refused (the very defect of production)", () => {
    expect(checkedSpecAnswer({ ...GOOD, any_of: ["الشائعات الصحية وتصحيحها وجهود الوزارة"] }, { alternatives: 3 })).toBeNull();
    // with no alternatives written, one item is right
    expect(checkedSpecAnswer({ ...GOOD, any_of: ["الشائعات الصحية"] }, { alternatives: 0 })).not.toBeNull();
  });
  it("customer-facing rules: no Latin word the customer did not write, no «سجل», no empty criterion, no non-array lists", () => {
    expect(checkedSpecAnswer({ ...GOOD, criterion: "posts about rumors" }, { alternatives: 0, words: ["شائعات"] })).toBeNull();
    expect(checkedSpecAnswer({ ...GOOD, criterion: "منشورات عن هاتف Samsung Galaxy الجديد" }, { alternatives: 0, words: ["عايز منشورات عن Samsung Galaxy"] })?.criterion).toContain("Samsung");
    expect(checkedSpecAnswer({ ...GOOD, criterion: "كل السجلات التي تتناول الشائعات" }, { alternatives: 0 })).toBeNull();
    expect(checkedSpecAnswer({ ...GOOD, criterion: "" }, { alternatives: 0 })).toBeNull();
    expect(checkedSpecAnswer({ ...GOOD, any_of: "الشائعات" }, { alternatives: 0 })).toBeNull();
    expect(checkedSpecAnswer(null, { alternatives: 0 })).toBeNull();
  });
});

describe("one spec per mission: asked once, stored, and read the same way by planning and execution", () => {
  it("the call carries the customer's own words, forces the structured tool and is stored; a second run reads it with no call", async () => {
    const store = createMemoryStore();
    const seen: Array<Record<string, unknown>> = [];
    const m = mission({ id: FIRST.id, request_text: FIRST.request_text, answer_text: FIRST.answer_text });
    const a = await researchSpecFor({ call: specCall(GOOD, seen), store, mission: m, storedWords: [FIRST.customer_said], fallbackSubject: "x" });
    expect(a.spec.by).toBe("model");
    expect(a.costUsd).toBeGreaterThan(0);
    expect(String(seen[0].user)).toContain(FIRST.customer_said);
    expect(String(seen[0].user)).toContain("@SaudiMOH");
    expect((seen[0].tool as { name: string }).name).toBe("research_spec");
    expect(String(seen[0].system)).toBe(SPEC_SYSTEM);
    const b = await researchSpecFor({ call: specCall(GOOD, seen), store, mission: m, storedWords: [FIRST.customer_said], fallbackSubject: "x" });
    expect(seen).toHaveLength(1);
    expect(b.costUsd).toBe(0);
    expect(b.spec).toEqual(a.spec);
    expect(await readResearchSpec(store, FIRST.id)).toEqual(a.spec);
  });
  it("a changed request (another answer, other words) makes a new spec", () => {
    const words = [FIRST.customer_said];
    expect(specSignature(words, { request_text: "a", answer_text: "@x" })).not.toBe(specSignature(words, { request_text: "a", answer_text: "@y" }));
    expect(specSignature(words, { request_text: "a", answer_text: null })).not.toBe(specSignature([...words, "تعديل"], { request_text: "a", answer_text: null }));
  });
  it("a FAILED answer (merged alternatives, cut at the cap, no answer) falls back to the customer's words and is NOT stored, so the next run asks again", async () => {
    for (const call of [specCall({ ...GOOD, any_of: ["الكل"] }), specCall("", [], { truncated: true }), (async () => null) as unknown as ReviewCall]) {
      const store = createMemoryStore();
      const r = await researchSpecFor({ call, store, mission: mission({ id: "m1", request_text: FIRST.request_text }), storedWords: [FIRST.customer_said], fallbackSubject: "محتوى يتحدث فعلًا عن: الشائعات" });
      expect(r.spec.by).toBe("words");
      expect(r.spec.customerWords).toEqual([FIRST.customer_said]);
      expect(await store.getFile("m1", RESEARCH_SPEC_FILE)).toBeNull();
    }
  });
});

describe("R2/R3: every judgment reads the customer's own words and the same criterion", () => {
  const spec: ResearchSpec = { v: 1, sig: "s", customerWords: [FIRST.customer_said, FOLLOW.customer_said], criterion: GOOD.criterion, anyOf: GOOD.any_of, notRelevant: GOOD.not_relevant, by: "model" };
  it("the prompt carries the customer's «أو» verbatim, the alternatives, the near misses and the confirmed account", () => {
    const p = reviewPrompt({ requestText: FOLLOW.request_text, subject: spec.criterion, rows: [{ text: "t" }], spec, answer: "@SaudiMOH" });
    expect(p).toContain("الشائعات الصحية أو تصحيح الشائعات أو جهود الوزارة في مكافحة المعلومات المضللة");
    expect(p).toContain(FOLLOW.customer_said);
    expect(p).toContain("A row qualifies when it is about ANY ONE of:\n- الشائعات الصحية\n- تصحيح الشائعات\n- جهود الوزارة في مكافحة المعلومات المضللة");
    expect(p).toContain("أخبار الوزارة العامة وأنشطتها التي لا تتناول الشائعات");
    expect(p).toContain("The customer confirmed: «@SaudiMOH»");
    expect(p.indexOf("customer's own messages")).toBeLessThan(p.indexOf("summary"));
  });
  it("the planning judgment and the execution review send the SAME prompt for the same rows", async () => {
    const prompts: string[] = [];
    const call = (async (i: { user: string }) => { prompts.push(i.user); return { text: "[1]", usage: { input_tokens: 1, output_tokens: 1 } }; }) as unknown as ReviewCall;
    const requestText = `${FOLLOW.request_text} — ${FOLLOW.answer_text}`;
    await planningJudge(call, requestText, { answer: FOLLOW.answer_text })({ subject: spec.criterion, rows: [{ id: "1", text: "لا صحة لما يتم تداوله" }], spec });
    await createReviewer({ call, store: createMemoryStore(), missionId: "m", requestText, spec, answer: FOLLOW.answer_text, budgetUsd: 1 }).review({ subject: spec.criterion, rows: [{ id: "1", text: "لا صحة لما يتم تداوله" }] });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]);
  });
  it("a words-only spec still gives the judge the customer's own words (no alternatives invented)", () => {
    const p = reviewPrompt({ requestText: "r", subject: "s", rows: [{ text: "t" }], spec: { ...spec, by: "words" } });
    expect(p).toContain(FIRST.customer_said);
    expect(p).not.toContain("ANY ONE of");
    expect(specBlock({ ...spec, by: "words" }, null)).not.toContain("does NOT qualify");
  });
  it("the search-vocabulary step reads the customer's words and the alternatives", async () => {
    const seen: Array<{ user: string }> = [];
    const call = (async (i: { user: string }) => { seen.push(i); return { text: '["شائعات"]', usage: { input_tokens: 1, output_tokens: 1 } }; }) as unknown as ReviewCall;
    await topicVariants(call)({ request: FIRST.request_text, topic: "t", alternatives: [], spec });
    expect(seen[0].user).toContain(FIRST.customer_said);
    expect(seen[0].user).toContain("«جهود الوزارة في مكافحة المعلومات المضللة»");
  });
  it("the criterion becomes the stage's subject, so the card's «المقصود» shows it before approval", () => {
    const topic = buildAsk(FIRST.request_text, null, NOW, {}, { semantic: false }).topic;
    expect(researchRelevanceOf({ topic }, ["text"], `${GOOD.criterion}.`)!.subject_ar).toBe(GOOD.criterion);
    expect(researchRelevanceOf({ topic }, ["text"], "  ")!.subject_ar).toMatch(/^محتوى يتحدث فعلًا عن: /);
  });
});

describe("the real call: a forced structured answer with no thinking", () => {
  it("sends the one tool, thinking off, and hands back the tool's input as JSON", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_u: string, init: { body: string }) => { const body = JSON.parse(init.body); sent.push(body); return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", name: "research_spec", input: GOOD }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } }) }; }) as never;
    const r = await anthropicReviewCall("k", fetchFn)({ model: "m", system: "s", user: "u", maxTokens: 700, tool: { name: "research_spec", description: "d", schema: { type: "object" } } });
    expect(sent[0].thinking).toEqual({ type: "disabled" });
    expect(sent[0].tool_choice).toEqual({ type: "tool", name: "research_spec" });
    expect(JSON.parse(r!.text)).toEqual(GOOD);
  });
  it("a refused tool request (HTTP 400) is asked again without the tool; an answer cut at the cap with no text is a failed call", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_u: string, init: { body: string }) => { const body = JSON.parse(init.body); sent.push(body); if (body.tools) return { ok: false, status: 400, json: async () => ({}) }; return { ok: true, status: 200, json: async () => ({ content: [], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 700 } }) }; }) as never;
    const r = await anthropicReviewCall("k", fetchFn)({ model: "m", system: "s", user: "u", maxTokens: 700, tool: { name: "research_spec", description: "d", schema: { type: "object" } } });
    expect(sent).toHaveLength(2);
    expect(r?.truncated).toBe(true);
    expect(r?.text).toBe("");
  });
});

describe("planning asks for the spec once and uses it everywhere", () => {
  const catalog = loadTregCatalog();
  const pageOf = (items: unknown[], nextCursor: string | null = null) => ({ output: { data: { items, nextCursor } } });
  const post = (id: string, text: string) => ({ id, text, authorName: "وزارة الصحة السعودية", authorUsername: "SaudiMOH", authorFollowers: 1, createdUtc: "2024-05-02T09:00:00.000Z", url: `https://x.com/i/web/status/${id}`, isReply: false, lang: "ar", likeCount: 1, retweetCount: 0, replyCount: 0, quoteCount: 0, viewCount: 1 });
  const ROWS = [post("9100000000000000001", "لا صحة لما يتم تداوله عن انتشار فيروس جديد؛ نرجو عدم الالتفات للإشاعات."), post("9100000000000000002", "معالي الوزير يتفقد مستشفيات المنطقة الشرقية")];
  it("the variants step, the planning judgment and the card's subject all read the ONE spec; its cost is counted once", async () => {
    const store = createMemoryStore();
    let asked = 0;
    const seenJudge: Array<{ subject: string; spec?: ResearchSpec | null }> = [];
    const seenVariants: Array<{ spec?: ResearchSpec | null }> = [];
    const spec: ResearchSpec = { v: 1, sig: "s", customerWords: [FIRST.customer_said], criterion: GOOD.criterion, anyOf: GOOD.any_of, notRelevant: GOOD.not_relevant, by: "model" };
    const gateway = {
      calls: 0,
      async tregCall(input: { endpoint_id?: unknown }) {
        this.calls += 1;
        const page = this.calls === 1 ? pageOf(ROWS, null) : pageOf([]);
        const callId = `call_${String(this.calls).padStart(4, "0")}`;
        await store.putFile(FIRST.id, RAW_PATH(callId), JSON.stringify(page), "application/json");
        const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!);
        return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: null };
      },
    };
    const r = await planByCompiler({
      mission: { id: FIRST.id, request_text: FIRST.request_text, answer_text: FIRST.answer_text, created_at: "2026-11-15T11:58:19Z" } as never, gateway: gateway as never, store, catalog, nowMs: NOW, choices: { sourceId: "SaudiMOH" }, askCount: true,
      spec: async () => { asked += 1; return { spec, costUsd: 0.0005 }; },
      variants: async (i: { spec?: ResearchSpec | null }) => { seenVariants.push(i); return { terms: ["شائعات", "لا صحة"], costUsd: 0.0001 }; },
      judge: async (i: { subject: string; spec?: ResearchSpec | null; rows: ReadonlyArray<{ id: string }> }) => { seenJudge.push(i); return { verdicts: new Map(i.rows.map((x) => [x.id, x.id.endsWith("1")])), costUsd: 0.0002 }; },
    } as never);
    expect(asked).toBe(1);
    expect(seenVariants[0].spec).toEqual(spec);
    expect(seenJudge[0].spec).toEqual(spec);
    expect(seenJudge[0].subject).toBe(GOOD.criterion);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const parent = r.plan.stages.find((s) => s.parent_key === null)!;
    expect(parent.relevance?.subject_ar).toBe(GOOD.criterion);
    expect(parent.relevance?.judge).toBe("model");
    // only the judged-relevant tweet is a planned sample (the minister's tour is not)
    expect((parent.pinned_rows ?? []).map((x: Record<string, unknown>) => String(x.id))).toEqual(["9100000000000000001"]);
    expect((r as { llmCostUsd?: number }).llmCostUsd).toBeCloseTo(0.0005 + 0.0001 + 0.0002, 8);
  });
});

describe("R4: the methodology agrees with what was delivered", () => {
  const stage = (relevance: boolean) => ({
    key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.tweets", expected_rows: 400, planned_rows: 400, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [],
    columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: TOPIC_RELATION_KEY, title_ar: TOPIC_RELATION_TITLE_AR }],
    ...(relevance ? { relevance: { subject_ar: GOOD.criterion, terms: ["الشائعات الصحية"], text_columns: ["text"], min_own_words: 0, review: true, judge: "model" } } : {}),
    filters: [{ kind: "period", days: 1826, enabled: true }],
  });
  const planOf = (relevance: boolean): PricedPlan => ({ summary_ar: "تغريدات", stages: [stage(relevance)] as never, price: { totalCostUsd: 0, deliveredRows: 400, costPerFinalRowUsd: 0, unitPricePoints: 0.5, reservePoints: 200, maxChargePoints: 200, overCap: false } as never, quantity: { requested: 400, stage_key: "tweets", target: 400, source: "request" } } as never);
  const facts = (over: Partial<MissionFacts> = {}): MissionFacts => ({ requestText: FIRST.request_text, deliveredAt: new Date("2026-11-15T13:00:00Z"), stages: { tweets: { found: 13, duplicates: 0, accepted: 1, excluded: 12, pending: 0, unchecked: 0, acceptedByRule: 0, acceptedByModel: 1, excludedByReason: { review_no: 12 }, stop: "source_exhausted" } as never }, reviewStop: null, ...over });
  const rows = [{ id: "1", text: "نحذر من الشائعات", [TOPIC_RELATION_KEY]: topicRelationAr(2) }];
  it("a judged stage never says «nothing was removed … all delivered» (production said it beside 12 exclusions)", () => {
    const lines = topicRelationLinesOf([stage(true)] as never, { tweets: rows });
    expect(lines.join(" ")).not.toContain(FIRST.methodology_lines_seen![0]);
    expect(lines[lines.length - 1]).toContain("ما استُبعد لأنه لا يتناول طلبك فعدده في جدول الأعداد");
    // a stage that only MARKS (no judgment) keeps its true sentence
    expect(topicRelationLinesOf([stage(false)] as never, { tweets: rows }).join(" ")).toContain("لم يُحذف بها شيء");
  });
  it("the relevance item describes the meaning review that ran, not a word rule", () => {
    const m = buildMethodology({ plan: planOf(true), layouts: [], rowsByStage: { tweets: rows }, facts: facts() });
    const rel = m.items.find((i) => i.label === "كيف فُحصت الصلة بطلبك")!.values.join(" ");
    expect(rel).toContain("بمراجعة آلية لمعناها مقابل طلبك");
    expect(rel).toContain("ولا يكفي أن تذكر كلمة منه");
    expect(rel).not.toContain("تُقبل إذا ذكر نصها");
    expect(rel).toContain(`(المقصود: ${GOOD.criterion})`);
  });
  it("«طلبك (بكلماتك)» is the customer's own words; the summary is labeled a summary", () => {
    const m = buildMethodology({ plan: planOf(true), layouts: [], rowsByStage: { tweets: rows }, facts: facts({ customerWords: [FIRST.customer_said] }) });
    expect(m.items.find((i) => i.label === "طلبك (بكلماتك)")!.values).toEqual([FIRST.customer_said]);
    expect(m.items.find((i) => i.label === "ملخص الطلب الذي نُفّذ")!.values).toEqual([FIRST.request_text]);
    // no stored words: the earlier behaviour, one item
    const old = buildMethodology({ plan: planOf(true), layouts: [], rowsByStage: { tweets: rows }, facts: facts() });
    expect(old.items.find((i) => i.label === "ملخص الطلب الذي نُفّذ")).toBeUndefined();
  });
  it("one tweet of a five-year request is told as one tweet, never as «أقل من ساعة»", () => {
    const at = Date.parse("2021-12-01T10:00:00Z");
    const line = periodLimitLineAr({ filter: { kind: "period", days: 1826, enabled: true } as never, covered: { fromMs: at, toMs: at, dayOnly: false, approx: false } as never, deliveredAt: new Date("2026-11-15T13:00:00Z"), targetReached: false, delivered: 1, planned: 400 });
    expect(line).not.toContain("أقل من ساعة");
    expect(line).toContain("سُلّمت نتيجة واحدة فقط");
  });
});

describe("the follow-up keeps the earlier request's words for the spec", () => {
  it("the stored words of a continuation hold the earlier request, so «نفس الموضوع» is resolved from the customer's own words", () => {
    const words = customerWordsToStore([CRITICAL, "@SaudiMOH", FOLLOW_UP]);
    expect(words[0]).toBe(CRITICAL);
    expect(words[words.length - 1]).toBe(FOLLOW_UP);
    expect(customerAlternativesCount(words, NOW)).toBe(3);
  });
});

describe("the chat card carries the customer's own words (code-written, beside the model's summary)", () => {
  const USER = "8a2f1c3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); })); vi.spyOn(console, "info").mockImplementation(() => undefined); });
  afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("a follow-up's card stores the earlier request and the follow-up as typed, while the summary may say «و»", async () => {
    const db: any = createMemoryDb();
    db.seed("conversations", [{ id: "c1", user_id: USER, title: "t", status: "active" }]);
    db.seed("credit_ledger", [{ user_id: USER, delta: 1000 }]);
    db.seed("agent_settings", [{ key: "chat_research_brief_v1", value: true }]);
    db.seed("missions", [{ id: FIRST.id, user_id: USER, status: "completed", request_text: FIRST.request_text, plan: null, created_at: "2026-11-15T12:10:00Z" }]);
    db.seed("mission_events", []);
    db.seed("messages", [
      { id: "u0", conversation_id: "c1", user_id: USER, role: "user", content_ar: CRITICAL, request_status: "completed", created_at: "2026-11-15T12:10:00Z" },
      { id: "a0", conversation_id: "c1", user_id: USER, role: "assistant", content_ar: "…", plan: { agentMissionId: FIRST.id }, created_at: "2026-11-15T12:10:30Z" },
      { id: "u1", conversation_id: "c1", user_id: USER, role: "user", content_ar: "@SaudiMOH", request_status: "completed", created_at: "2026-11-15T12:11:00Z" },
      { id: "ucur", conversation_id: "c1", user_id: USER, role: "user", content_ar: FOLLOW_UP, request_status: "planning", created_at: "2026-11-15T12:30:00Z" },
      { id: "acur", conversation_id: "c1", user_id: USER, role: "assistant", content_ar: "…", created_at: "2026-11-15T12:30:00.5Z" },
    ]);
    const summary = "400 تغريدة من حساب وزارة الصحة السعودية عن الشائعات والتصدي للشائعات وجهود الوزارة في مكافحة الشائعات خلال آخر خمس سنين، من غير تكرار ما سُلّم سابقًا";
    setChatModelForTesting(async () => ({ ok: true, text: JSON.stringify({ type: "data_request", reason: "scripted", reply: "", count: 400, brief: { status: "ready", request: summary, platforms: ["x"], content: ["tweets"], count: 400, topic: "الشائعات والتصدي للشائعات وجهود الوزارة في مكافحة الشائعات", source: "وزارة الصحة السعودية", period: "آخر خمس سنين", exclude_delivered: true } }), usage: { inputTokens: 1, outputTokens: 1 } }));
    const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "c1", userMsgId: "ucur", assistantMsgId: "acur", message: FOLLOW_UP, conversationTitle: "t" });
    expect(r.ok).toBe(true);
    const card = (db.rows("messages") as any[]).find((m) => m.id === "acur");
    expect(card.plan.customerWords).toEqual([CRITICAL, "@SaudiMOH", FOLLOW_UP]);
    expect(customerWordsFromPlan(card.plan)).toEqual([CRITICAL, "@SaudiMOH", FOLLOW_UP]);
    // the worker's spec then sees the customer's three alternatives, whatever the summary says
    expect(customerAlternativesCount(card.plan.customerWords, NOW)).toBe(3);
    expect(customerAlternativesCount([card.plan.researchBrief.request], NOW)).toBe(0);
  });
});
