import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { RAW_PATH } from "../agent/src/gateway";
import { planByCompiler } from "../agent/src/compiled";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { confirmFieldsOnRows, fieldNotesAr, type FieldReport } from "../src/lib/agentMission/foundation/discovery/fieldRecovery";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { samplesView } from "../src/lib/agentMission/customerView";
import { CLIPPED_LINK_NOTE_AR, LONG_LINK_NOTE_AR, SAMPLE_LINK_MAX_CHARS, sampleCellText, storedSampleCell } from "../src/lib/agentMission/sampleLinks";

/**
 * NOV 7 2026 (Cairo) TARGETED RETEST, FACEBOOK: msn_365928deea447ca8ae92 (test account, created 2026-11-06 22:16 UTC, 215 points charged; read-only SELECTs on `missions` and `mission_calls`, no Storage read).
 * Request: «اجمع لي منشورين عامين من فيسبوك عن الذكاء الاصطناعي (منشورات فيديو لو متاح)، مع تعليقين حقيقيين على كل منشور، والروابط وأسماء الصفحات.»
 *  1. THE PERMALINK: the private plan's first chosen post holds the source's whole link (155 characters, `…story_fbid=pfbid02V4…Kl&id=61570030318692`); the stored PUBLIC plan's sample shows it cut at 120 characters
 *     (`…VPfT`), so the `id` the link needs was gone and the card's link opened nothing. The page link (`author_url`) was cut the same way.
 *  2. THE ACCOUNT NAMES: the first keyword search (call_0001) answered EMPTY; the test account's second search (call_0002, 20 posts) gave the rows. The field check ran on the empty first page and the card said
 *     «طلبت أسماء أصحاب الحسابات، لكن المصدر المختار لا يعيدها…» while BOTH chosen posts carried their page's name («العالم الجديد - يوسف بهنس», «AraGeek - أراجيك»).
 * DATA: the two chosen posts and the two spare posts are the stored rows of that mission (ids, links, names, counters and instants as stored; texts shortened). The page bodies are rebuilt in the second search's own shape.
 */
const catalog = loadTregCatalog();
const NOW = Date.parse("2026-11-06T22:17:00Z");
const REQUEST = "اجمع لي منشورين عامين من فيسبوك عن الذكاء الاصطناعي (منشورات فيديو لو متاح)، مع تعليقين حقيقيين على كل منشور، والروابط وأسماء الصفحات.";
const FULL_LINK = "https://www.facebook.com/permalink.php?story_fbid=pfbid02V4SXQw2Vc6D9FxaKnmKn8DZZ6T88NX19REzuHy89GwEt9SJTCCWsVb7g9UhVPfTKl&id=61570030318692";
const STORED_CUT_LINK = "https://www.facebook.com/permalink.php?story_fbid=pfbid02V4SXQw2Vc6D9FxaKnmKn8DZZ6T88NX19REzuHy89GwEt9SJTCCWsVb7g9UhVPfT";
const PAGE_LINK = "https://www.facebook.com/people/%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85-%D8%A7%D9%84%D8%AC%D8%AF%D9%8A%D8%AF-%D9%8A%D9%88%D8%B3%D9%81-%D8%A8%D9%87%D9%86%D8%B3/61570030318692/";

/** The four posts of the retest, in the second search's item shape (`output.data.items`). */
const ITEMS = [
  { id: "122181051998667677", text: "⭕ #إيلون_ماسك : الذكاء الاصطناعي سيقود البشرية إلى عصر الوفرة", authorName: "العالم الجديد - يوسف بهنس ", authorUrl: PAGE_LINK, createdUtc: "2026-10-20T05:57:06.000Z", url: FULL_LINK, commentCount: 281, reactionCount: 1617, shareCount: 261 },
  { id: "1545315464289711", text: "بيل غيتس يحذر: الذكاء الاصطناعي قد يجلب جائحة أسوأ من كوفيد.", authorName: "AraGeek - أراجيك", authorUrl: "https://www.facebook.com/arageek", createdUtc: "2026-11-05T14:35:22.000Z", url: "https://www.facebook.com/arageek/posts/pfbid0yXbAwXQLu3U2UePJHGqqAEve4YEPZMpvW58kpYqdPYuXaX4hdNQCFGUM7DPmoPUBl", commentCount: 189, reactionCount: 813, shareCount: 216 },
  { id: "1701176435379155", text: "منتدى للتعمّق والتعلّم في موضوع الذكاء الاصطناعي", authorName: "إسرائيل تتكلم بالعربية", authorUrl: "https://www.facebook.com/IsraelArabic", createdUtc: "2026-11-03T15:00:09.000Z", url: "https://www.facebook.com/IsraelArabic/posts/pfbid0kqd4nWc2mwA75DQatNduRLEAQwBHbC3vaNoo7XvhaLpYMary9CkE7YTdgDSPs7U1l", commentCount: 148, reactionCount: 339, shareCount: 8 },
  { id: "1022516487027532", text: "كم مرة سألت أحد نماذج الذكاء الاصطناعي سؤالًا دينيًا", authorName: "Abdallah Seye", authorUrl: "https://www.facebook.com/abdallah.seye.2025", createdUtc: "2026-06-27T03:52:21.000Z", url: "https://www.facebook.com/abdallah.seye.2025/posts/pfbid0LCAuFnswLvHuPmsJ8Bu2dZTcure1jfT8tGsRG1JGLi3HqaihdRxoeaDxwWM4xNcTl", commentCount: 103, reactionCount: 327, shareCount: 5 },
];
const comments = (post: string) => ({ success: true, comments: [1, 2, 3].map((i) => ({ id: `c_${post}_${i}`, text: `تعليق ${i}`, author: { name: `user ${i}` }, created_at: "2026-11-05T15:00:00.000Z", reactions: 1, replies_count: 0, feedback_id: `fb_${post}_${i}`, expansion_token: `tok_${post}_${i}` })), cursor: null, has_next_page: false });

/** A gateway that answers the retest's calls: the first search EMPTY (as call_0001 was), the second search with the four posts, each post's comments. */
function retestGateway(store: ReturnType<typeof createMemoryStore>, mission: string) {
  let seq = 0;
  const calls: string[] = [];
  return {
    calls,
    gateway: {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const endpointId = String(input.endpoint_id ?? "");
        const params = (input.params ?? {}) as Record<string, unknown>;
        const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
        calls.push(endpointId);
        const body = endpointId === "justoneapi.x.facebook-search-post-v1" ? { code: 0, data: { results: [], cursor: null } }
          : endpointId === "anyapi.facebook.search_posts" ? { output: { data: { items: ITEMS } } }
          : endpointId === "scrapecreators.x.v1-facebook-post-comments" ? comments(String(params.url ?? ""))
          : null;
        const endpoint = catalog.byId.get(endpointId);
        if (!body || !endpoint) return { ok: false as const, call_id: callId, failed: true as const, http_status: 0, message: "not served in this test" };
        await store.putFile(mission, RAW_PATH(callId), JSON.stringify(body), "application/json");
        const { reading } = buildShapeDigest(body, endpoint);
        return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: reading.hasMore ?? null, next_cursor: reading.nextCursor ?? null, shape: null, first_rows: [], warnings: [], saved: callId };
      },
    },
  };
}

async function planRetest() {
  const store = createMemoryStore();
  const mission = "msn_nov7_fb_retest";
  const { gateway, calls } = retestGateway(store, mission);
  const out = await planByCompiler({ mission: { id: mission, request_text: REQUEST, answer_text: null, created_at: "2026-11-06T22:16:12Z" }, gateway, store, catalog, nowMs: NOW, catalogOnly: true });
  return { out, calls };
}

describe("NOV 7 retest, 2: the account-name warning before approval is judged on the posts chosen for the file", () => {
  it("the first search empty, the second search's chosen posts carry the page names: NO «غير متاح» sentence, the field is `card`", async () => {
    const { out, calls } = await planRetest();
    expect(calls.slice(0, 2)).toEqual(["justoneapi.x.facebook-search-post-v1", "anyapi.facebook.search_posts"]);
    expect(out.kind).toBe("plan");
    if (out.kind !== "plan") return;
    const parent = out.plan.stages.find((s) => s.parent_key === null)!;
    const chosen = parent.pinned_rows ?? [];
    expect(chosen.length).toBe(2);
    expect(chosen.every((r) => typeof r.author === "string" && (r.author as string).trim() !== "")).toBe(true);
    expect(out.plan.compiled?.fields?.find((f) => f.key === "author")?.status).toBe("card");
    expect((out.plan.notes_ar ?? []).some((n) => /أسماء أصحاب الحسابات/.test(n))).toBe(false);
    expect((out.plan.notes_ar ?? []).some((n) => /غير متاح/.test(n))).toBe(false);
  });

  it("the chosen rows decide: all carry it → card; some → partial with the count; none → unavailable (the sentence stays, never a written value)", () => {
    const report: FieldReport[] = [{ key: "author", status: "unavailable" }];
    expect(confirmFieldsOnRows(report, [{ author: "AraGeek - أراجيك" }, { author: "Abdallah Seye" }])).toEqual([{ key: "author", status: "card" }]);
    const partial = confirmFieldsOnRows(report, [{ author: "AraGeek - أراجيك" }, { author: "" }, { author: "غير متاح" }]);
    expect(partial).toEqual([{ key: "author", status: "partial", of: { n: 1, total: 3 } }]);
    expect(fieldNotesAr(partial, ["author"])).toEqual(["أسماء أصحاب الحسابات: أعادها المصدر في ١ من ٣ من العناصر المختارة؛ الباقي يظهر «غير متاح» في الملف، ولم نكتب أي قيمة من عندنا."]);
    const none = confirmFieldsOnRows([{ key: "author", status: "card", path: "author.name" }], [{ author: null }, { author: "  " }]);
    expect(none).toEqual([{ key: "author", status: "unavailable" }]);
    expect(fieldNotesAr(none, ["author"])[0]).toMatch(/^طلبت أسماء أصحاب الحسابات، لكن المصدر المختار لا يعيدها/);
    // the handle is the account too; a real 0 is a value; recovered / approximate keep their provenance; no chosen rows: nothing is re-decided
    expect(confirmFieldsOnRows(report, [{ username: "arageek" }])[0].status).toBe("card");
    expect(confirmFieldsOnRows([{ key: "likes", status: "unavailable" }], [{ likes: 0 }])[0].status).toBe("card");
    expect(confirmFieldsOnRows([{ key: "posted_at", status: "approximate", path: "published" }], [{ posted_at: null }])[0].status).toBe("approximate");
    expect(confirmFieldsOnRows(report, [])).toEqual(report);
  });
});

describe("NOV 7 retest, 1: a link in the card's sample is the source's whole link, never a cut one", () => {
  it("the planned card shows the post's permalink and the page link WHOLE, exactly as the source gave them (the `&id=` the link needs is kept)", async () => {
    const { out } = await planRetest();
    if (out.kind !== "plan") throw new Error("no plan");
    const pub = customerPlanView(out.plan as PricedPlan, { now: NOW });
    const posts = pub.stages.find((s) => s.parent_key === null)!;
    const first = posts.sample_rows.find((r) => String(r.link ?? "").includes("61570030318692"))!;
    expect(first.link).toBe(FULL_LINK);
    expect(first.author_url).toBe(PAGE_LINK);
    expect(posts.links_whole).toBe(true);
    // the card the customer reads (customerView) keeps it whole too
    const view = samplesView({ stages: [posts] })!;
    const linkCol = view.columns.findIndex((c) => c.key === "link");
    expect(linkCol).toBeGreaterThanOrEqual(0);
    expect(view.rows.some((r) => r[linkCol] === FULL_LINK)).toBe(true);
    // text cells keep their limit
    expect(posts.sample_rows.every((r) => String(r.text ?? "").length <= 120)).toBe(true);
  });

  it("a link longer than the bound is replaced by a sentence, never by a partial link; other text is cut as before", () => {
    const long = `https://www.facebook.com/permalink.php?story_fbid=${"a".repeat(SAMPLE_LINK_MAX_CHARS)}&id=1`;
    expect(sampleCellText(long, 120)).toBe(LONG_LINK_NOTE_AR);
    expect(sampleCellText(FULL_LINK, 120)).toBe(FULL_LINK);
    expect(sampleCellText("ن".repeat(200), 120)).toHaveLength(120);
    expect(sampleCellText("see https://x.test/a b", 10)).toBe("see https:");
  });

  it("a public plan stored BEFORE the rule (the retest's own stored sample): the cut link is said to be cut, not shown as a working link, and no id is rebuilt", () => {
    expect(STORED_CUT_LINK).toHaveLength(120);
    expect(FULL_LINK.startsWith(STORED_CUT_LINK)).toBe(true);
    const storedStage = { key: "posts", title_ar: "المنشورات", deliver: true, parent_key: null, columns: [{ key: "link", title_ar: "الرابط" }, { key: "author", title_ar: "صاحب الحساب" }], sample_rows: [{ link: STORED_CUT_LINK, author: "العالم الجديد - يوسف بهنس " }, { link: ITEMS[1].url, author: "AraGeek - أراجيك" }] };
    const view = samplesView({ stages: [storedStage] })!;
    expect(view.rows[0][0]).toBe(CLIPPED_LINK_NOTE_AR);
    expect(view.rows.flat().some((c) => c.includes("story_fbid=pfbid02V4") && !c.includes("&id="))).toBe(false);
    // a whole stored link of another length is shown as it is
    expect(view.rows[1][0]).toBe(ITEMS[1].url);
    // a stage written under the rule is trusted: a genuine 120-character link is shown
    expect(storedSampleCell(STORED_CUT_LINK, true)).toBe(STORED_CUT_LINK);
  });
});
