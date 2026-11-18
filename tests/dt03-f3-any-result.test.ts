import { describe, expect, it } from "vitest";
import { ANY_RESULT_OPTION_AR, pickNamedItem, planWithLlm } from "../agent/src/llmPlanner/planner";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * DT-20261118-03 F3 (BUG HUNTER BH1, live chat «YouTube»): «أي فيديو عام عن الذكاء الاصطناعي، اختر فيديو متاحاً من نتائج البحث.» got the same «send the link or the exact name» question again, with no button. The lookup now
 * offers one button that lets us pick, a press of it takes the first result with no model call, and a written answer reaches the model that picks.
 */
const FIND = { key: "find", title_ar: "الفيديوهات", platform: "amazon", capability: "amazon.search.products", parent: null, deliver: false, count: { total: 1, per_parent: null, all: false }, topic: "Sony WH-1000XM5", search_terms: [] } as never;
const ROWS = [{ id: "B09XS7JWHH", title: "Sony WH-1000XM5" }, { id: "B0OTHER", title: "Other" }];
const WRITTEN = "أي فيديو عام عن الذكاء الاصطناعي، اختر فيديو متاحاً من نتائج البحث.";

describe("DT-20261118-03 F3: the lookup has an exit the customer can press", () => {
  it("the button's words pass the customer-text guard", () => {
    expect(ANY_RESULT_OPTION_AR).toBe("أي نتيجة عن الموضوع تكفي، اختاروها أنتم");
    expect(checkCustomerText(ANY_RESULT_OPTION_AR).issues).toEqual([]);
  });
  it("the pressed button takes the first result with no model call; a written answer is given to the model", async () => {
    expect(await pickNamedItem(FIND, ROWS, async () => { throw new Error("no model call"); }, [ANY_RESULT_OPTION_AR])).toBe(0);
    let user = "";
    expect(await pickNamedItem(FIND, ROWS, async (_s, u) => { user = u; return { index: 1 }; }, [WRITTEN])).toBe(1);
    expect(user).toContain(`«${WRITTEN}»`);
  });

  const run = (exchanges: Array<{ question: string; answer: string }>, pick: unknown[]) => {
    const answers: Record<string, unknown[]> = {
      request_plan: [{ decision: "plan", understanding_ar: "عشرة تقييمات لسماعة سوني من أمازون.", assumptions_ar: [], accepts_available: false, steps: [
        { key: "find_product", title_ar: "المنتجات", platform: "amazon", capability: "amazon.search.products", parent: null, deliver: false, count: { total: 1, all: false }, topic: "Sony WH-1000XM5", search_terms: ["Sony WH-1000XM5"] },
        { key: "reviews", title_ar: "التقييمات", platform: "amazon", capability: "amazon.product.reviews", parent: "find_product", deliver: true, count: { total: 10, all: false }, search_terms: [] },
      ] }],
      tool_choice: [
        { options: [{ endpoint_id: "treg.amazon.search.products", params_json: JSON.stringify({ q: "Sony WH-1000XM5" }) }] },
        { options: [{ endpoint_id: "justoneapi.x.amazon-get-product-top-reviews-v1", params_json: "{}", parent_input: { param: "asin", from_field: "id" } }] },
      ],
      field_map: [{ fields: { id: ["asin"], text: ["title"] }, extra: [] }, { fields: { id: ["rid"], text: ["body"] }, extra: [] }],
      pick_item: pick,
    };
    let n = 0;
    const pages = new Map<string, unknown>();
    return planWithLlm({ words: ["عايز ١٠ ريفيو لسماعة Sony WH-1000XM5 من أمازون"], request: "", exchanges }, {
      model: async ({ tool }) => { const next = (answers[tool.name] ?? []).shift(); return next === undefined ? null : { input: next, costUsd: 0.001 }; },
      catalog: loadTregCatalog(), access: null, today: "2026-11-16",
      probe: async (id) => {
        n += 1; const call_id = `call_${n}`;
        const reviews = id.includes("reviews");
        pages.set(call_id, reviews ? { data: { reviews: Array.from({ length: 10 }, (_, k) => ({ rid: `R${k}`, body: `review ${k}` })) } } : { data: { products: [{ asin: "B09XS7JWHH", title: "Sony WH-1000XM5" }, { asin: "B0OTHER", title: "Other" }] } });
        return { ok: true, call_id, http_status: 200, rows_in_page: reviews ? 10 : 2, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
  };
  it("no result confirmed: the question carries the button (before: no button)", async () => {
    const r = await run([], [{ index: -1 }]);
    expect(r.kind).toBe("question");
    if (r.kind === "question") expect(r.options_ar).toEqual([ANY_RESULT_OPTION_AR]);
  });
  it("after the button is pressed the plan is built, with no second question", async () => {
    const r = await run([{ question: "بحثنا…", answer: ANY_RESULT_OPTION_AR }], []);
    expect(r.kind).toBe("plan");
  });
});

// QA wave-1 FAIL #574: the live flow itself, YouTube-shaped, end to end on fakes (catalog endpoints, fake pages, scripted model answers): the question with the button, then the plan
describe("DT-20261118-03 F3: the YouTube flow of the live chat, end to end on fakes", () => {
  const REQUEST = "عايز ٥٠ تعليق على فيديو عن الذكاء الاصطناعي من يوتيوب";
  const VIDEOS = [{ videoId: "vid_ai_1", title: "ما هو الذكاء الاصطناعي؟" }, { videoId: "vid_ai_2", title: "الذكاء الاصطناعي في 10 دقائق" }];
  const ytRun = (exchanges: Array<{ question: string; answer: string }>, pick: unknown[]) => {
    const prompts: string[] = [];
    const answers: Record<string, unknown[]> = {
      request_plan: [{ decision: "plan", understanding_ar: "خمسون تعليقًا على فيديو عن الذكاء الاصطناعي من يوتيوب.", assumptions_ar: [], accepts_available: false, steps: [
        { key: "find_video", title_ar: "الفيديو", platform: "youtube", capability: "youtube.search.videos", parent: null, deliver: false, count: { total: 1, all: false }, topic: "الذكاء الاصطناعي", search_terms: ["الذكاء الاصطناعي"] },
        { key: "comments", title_ar: "التعليقات", platform: "youtube", capability: "youtube.video.comments", parent: "find_video", deliver: true, count: { total: 50, all: false }, search_terms: [] },
      ] }],
      tool_choice: [
        { options: [{ endpoint_id: "crawl4ai.youtube.search.videos", params_json: JSON.stringify({ query: "الذكاء الاصطناعي", limit: 10 }) }] },
        { options: [{ endpoint_id: "crawl4ai.youtube.video.comments", params_json: JSON.stringify({ limit: 50 }), parent_input: { param: "video", from_field: "id" } }] },
      ],
      field_map: [{ fields: { id: ["videoId"], text: ["title"] }, extra: [] }, { fields: { id: ["cid"], text: ["text"] }, extra: [] }],
      pick_item: pick,
    };
    let n = 0;
    const pages = new Map<string, unknown>();
    const probed: Array<{ id: string; params: unknown }> = [];
    const result = planWithLlm({ words: [REQUEST], request: "", exchanges }, {
      model: async ({ tool, user }: any) => { if (tool.name === "pick_item") prompts.push(String(user ?? "")); const next = (answers[tool.name] ?? []).shift(); return next === undefined ? null : { input: next, costUsd: 0.001 }; },
      catalog: loadTregCatalog(), access: null, today: "2026-11-18",
      probe: async (id: string, params: unknown) => {
        n += 1; const call_id = `call_${n}`; probed.push({ id, params });
        const comments = id.includes("comments");
        pages.set(call_id, comments ? { data: { comments: Array.from({ length: 50 }, (_, k) => ({ cid: `C${k}`, text: `تعليق ${k}` })) } } : { data: { videos: VIDEOS } });
        return { ok: true, call_id, http_status: 200, rows_in_page: comments ? 50 : 2, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id: string) => pages.get(id) ?? null
    } as any);
    return { result, prompts, probed };
  };
  it("no video confirmed: the YouTube question carries the one button (live: no button, the same question again)", async () => {
    const { result } = ytRun([], [{ index: -1 }]);
    const r = await result;
    expect(r.kind).toBe("question");
    if (r.kind !== "question") return;
    expect(r.options_ar).toEqual([ANY_RESULT_OPTION_AR]);
    expect(checkCustomerText(r.question_ar).issues).toEqual([]);
  });
  it("the button pressed: the plan is built on the first video, with no model pick and no second question; the comments are read from that video", async () => {
    const first = await ytRun([], [{ index: -1 }]).result;
    expect(first.kind).toBe("question");
    if (first.kind !== "question") return;
    const { result, prompts, probed } = ytRun([{ question: first.question_ar, answer: ANY_RESULT_OPTION_AR }], []);
    const r = await result;
    expect(r.kind, JSON.stringify(r).slice(0, 600)).toBe("plan");
    expect(prompts).toEqual([]);
    const commentsCall = probed.find((p) => p.id === "crawl4ai.youtube.video.comments");
    expect(commentsCall, JSON.stringify(probed)).toBeTruthy();
    expect(JSON.stringify(commentsCall!.params)).toContain("vid_ai_1");
  });
  it("a written answer (the live words) goes to the model that picks, and the plan follows its pick", async () => {
    const { result, prompts, probed } = ytRun([{ question: "بحثنا…", answer: WRITTEN }], [{ index: 1 }]);
    const r = await result;
    expect(r.kind, JSON.stringify(r).slice(0, 600)).toBe("plan");
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain(`«${WRITTEN}»`);
    expect(JSON.stringify(probed.find((p) => p.id === "crawl4ai.youtube.video.comments")?.params)).toContain("vid_ai_2");
  });
});
