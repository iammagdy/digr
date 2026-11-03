import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, type CompiledPlanning } from "../agent/src/compiled";
import { RAW_PATH } from "../agent/src/gateway";
import { pageNotFoundAr } from "../src/lib/agentMission/foundation/namedShortfall";

/**
 * ROUND 17, item 3 (live round 14, msn_86dd9484261f41416f57: «هات منشورين من صفحة قناة العربية على فيسبوك آخر ٣ شهور، مع كل التعليقات» was answered «مصادرنا لا تخدم هذا الطلب بالدقة المطلوبة الآن»; the mission has NO call at all: the compiler found no card).
 * A named page with no topic: the keyword search (verified) is read ONCE with the page's name to find the page's link by its author's name, word for word; then the verified page listing is read by that link and walked back by its cursor, each row's date checked in Cairo days by code,
 * inside the gateway's own caps (a refused read ends the walk); the card says before approval when the period was not reached. Never refused while a verified card can serve part of the request.
 */
const catalog = loadTregCatalog();
const SEARCH = "justoneapi.x.facebook-search-post-v1";
const LISTING = "anyapi.facebook.user.posts";
const COMMENTS = "scrapecreators.x.v1-facebook-post-comments";
const NOW = "2026-11-03T19:18:59Z";
const REQUEST = "هات منشورين من صفحة قناة العربية على فيسبوك آخر ٣ شهور، مع كل التعليقات.";
const DAY = 86_400;
const nowS = Math.floor(Date.parse(NOW) / 1000);

const searchPage = (authors: Array<{ name: string; url: string }>) => ({ data: { results: authors.map((a, i) => ({ post_id: `s${i}`, message: `منشور ${i}`, author: { id: `100${i}`, name: a.name, url: a.url }, timestamp: nowS - i * 3600, url: `https://www.facebook.com/x/posts/${i}`, comments_count: i, reactions_count: 1, reshare_count: 0 })), cursor: "c" } });
/** one listing page: 3 posts a page, k = the page number (0-based), `dayStep` days between pages; counters rise with k so the most commented are the oldest read */
const listingPage = (k: number, dayStep: number, more = true) => ({ output: { data: { posts: [0, 1, 2].map((j) => ({ id: `p${k}_${j}`, author: "العربية", authorId: "100064", comments: k * 10 + j, createdUtc: String(nowS - Math.round(k * dayStep * DAY) - j * 600), likes: 1, shares: 0, text: `منشور ${k}-${j}`, url: `https://www.facebook.com/AlArabiya/posts/${k}${j}` })), nextCursor: more ? `cur${k + 1}` : null } } });
const commentsPage = { comments: [{ id: "k1", text: "تعليق", created_at: "2026-11-03T18:00:00.000Z", reply_count: 0, author: { id: "a", name: "ن" }, feedback_id: "f", expansion_token: "e" }], cursor: null, has_next_page: false };

function world(opts: { authors?: Array<{ name: string; url: string }>; listingCap: number; dayStep: number; lastPage?: number }) {
  const store = createMemoryStore();
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let n = 0;
  let listingReads = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      calls.push({ endpoint, params });
      let page: unknown;
      if (endpoint === SEARCH) page = searchPage(opts.authors ?? [{ name: "المملكة العربية السعودية", url: "https://www.facebook.com/ksa" }, { name: "العربية", url: "https://www.facebook.com/AlArabiya?ref=x" }]);
      else if (endpoint === LISTING) {
        // the gateway's own cap: a source sampled this many times is refused (repeat_sample); the test only imitates it
        if (listingReads >= opts.listingCap) return { ok: false, refused: "repeat_sample", message: "x" };
        const k = typeof params.cursor === "string" ? Number(String(params.cursor).replace("cur", "")) : 0;
        listingReads += 1;
        page = listingPage(k, opts.dayStep, opts.lastPage === undefined || k < opts.lastPage);
      } else if (endpoint === COMMENTS) page = commentsPage;
      else return { ok: false, refused: "not_in_test" };
      n += 1;
      const id = `call_${String(n).padStart(4, "0")}`;
      await store.putFile("msn_r17_fb", RAW_PATH(id), JSON.stringify(page), "application/json");
      return { ok: true, call_id: id, rows: 3, has_more: null, next_cursor: null };
    },
  };
  return { store, gateway, calls };
}
const run = async (w: ReturnType<typeof world>, request = REQUEST) => planByCompiler({ mission: { id: "msn_r17_fb", request_text: request, answer_text: null, created_at: NOW }, gateway: w.gateway, store: w.store, catalog, nowMs: Date.parse(NOW) + 60_000 });
const planOf = (out: CompiledPlanning) => { if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}${"reason" in out ? ` ${out.reason}` : ""}`); return out; };

describe("a named page and a period, no topic", () => {
  it("is no longer refused: the page's link is found by ONE search read, the verified listing is read by it, and a plan is made from the page's own posts", async () => {
    const w = world({ listingCap: 2, dayStep: 0.2 });
    const out = planOf(await run(w));
    expect(w.calls.filter((c) => c.endpoint === SEARCH)).toHaveLength(1);
    expect(w.calls.find((c) => c.endpoint === SEARCH)!.params).toMatchObject({ keyword: "العربية", startDate: "2026-08-03", endDate: "2026-11-03" });
    const listing = w.calls.filter((c) => c.endpoint === LISTING);
    expect(listing[0].params.url).toBe("https://www.facebook.com/AlArabiya");
    expect(out.plan.stages[0].endpoint_id).toBe(LISTING);
    expect((out.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).every((r) => String(r.id).startsWith("p"))).toBe(true);
    expect(out.plan.stages[0].pinned_rows).toHaveLength(2);
  });
  it("within the gateway's cap (two samples of the listing) the walk stops: the card says before approval how many posts were read, the period they cover and that the period's start was not reached", async () => {
    const w = world({ listingCap: 2, dayStep: 0.2 });
    const out = planOf(await run(w));
    expect(w.calls.filter((c) => c.endpoint === LISTING)).toHaveLength(3); // the third is the refused one
    const line = (out.plan.notes_ar ?? []).find((n) => n.startsWith("لم نصل إلى بداية الفترة"));
    expect(line, (out.plan.notes_ar ?? []).join("\n")).toBeDefined();
    expect(line).toContain("من ٢٠٢٦-٠٨-٠٣ إلى ٢٠٢٦-١١-٠٣");
    expect(line).toContain("قرأنا ٦ منشورات");
    expect(line).toContain("بتوقيت القاهرة");
    expect(JSON.stringify(out.plan.notes_ar)).not.toMatch(/anyapi|justoneapi|scrapecreators|facebook-search|USD|\$/i);
    // the most commented of the six read are chosen (counters 12 and 11 are on the second page)
    expect((out.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((r) => r.comments)).toEqual([12, 11]);
  });
  it("with room, the listing is walked back page by page, each row's Cairo day checked by code, until a post older than the period's first day is read: no «not reached» line, no post outside the period is chosen", async () => {
    const w = world({ listingCap: 99, dayStep: 2 });
    const out = planOf(await run(w, "هات منشورين من صفحة قناة العربية على فيسبوك آخر أسبوع، مع كل التعليقات."));
    const pages = w.calls.filter((c) => c.endpoint === LISTING).length;
    expect(pages).toBe(5); // days 0, 2, 4, 6 inside the week, day 8 is the first page with posts older than it
    expect((out.plan.notes_ar ?? []).some((n) => n.startsWith("لم نصل إلى بداية الفترة"))).toBe(false);
    const start = Date.parse("2026-10-28T00:00:00+02:00");
    expect((out.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).every((r) => Date.parse(String(r.posted_at)) >= start)).toBe(true);
    expect((out.plan.notes_ar ?? []).some((n) => n.includes("لم نختر أي منشور خارج الفترة"))).toBe(true);
  });
  it("every post of the page is «مطابق» by its author's name (the Arabic name word for word), in the plan's own rows", async () => {
    const out = planOf(await run(world({ listingCap: 2, dayStep: 0.2 })));
    expect((out.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((r) => r.named_source)).toEqual(["", ""]);
    expect(out.plan.compiled?.source_text).toBe("العربية");
  });
  it("a page link in the request needs no search read at all", async () => {
    const w = world({ listingCap: 2, dayStep: 0.2 });
    planOf(await run(w, "هات منشورين من صفحة https://www.facebook.com/AlArabiya على فيسبوك آخر ٣ شهور، مع كل التعليقات."));
    expect(w.calls.filter((c) => c.endpoint === SEARCH)).toHaveLength(0);
  });
  it("a name no author of the search matches word for word (only pages that CONTAIN the word) gives no guess: the customer is told before any plan, nothing held", async () => {
    const w = world({ listingCap: 2, dayStep: 0.2, authors: [{ name: "المملكة العربية السعودية", url: "https://www.facebook.com/ksa" }, { name: "صباح العربية", url: "https://www.facebook.com/sabah" }] });
    const out = await run(w);
    expect(out.kind).toBe("cannot");
    expect((out as { reason: string }).reason).toBe("page_not_found");
    expect(w.calls.filter((c) => c.endpoint === LISTING)).toHaveLength(0);
    expect(pageNotFoundAr("قناة العربية")).toContain("لم نجد صفحة باسم «قناة العربية»");
    expect(pageNotFoundAr("قناة العربية")).toContain("لم يُخصم منك شيء");
  });
});
