import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, type CompiledPlanning } from "../agent/src/compiled";
import { pageMatchesSource, topicTierOf } from "../src/lib/agentMission/foundation/pool";
import { cardMapCode, cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { NAMED_SHORTFALL_OPTIONS_AR } from "../src/lib/agentMission/foundation/namedShortfall";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { replayGateway, type ReplayStore } from "./helpers/replayGateway";
import type { CallRow } from "../agent/src/types";

/**
 * LIVE ROUND 10 (3 Nov 2026), item 1: the Facebook named-shortfall card did not fire on msn_f189151e625d45564d58
 * («هات منشورات عن الذكاء الاصطناعي من صفحة قناة العربية ... ٣ منشورات»: the card said «منها من الصفحة ويتحدث نصه عن الموضوع: ٢» for 3 asked and asked nothing).
 * Three causes, each proved below on the REAL M17 pages (search calls 4 and 5, anonymised) with the structure the live run showed:
 *   1. `pageMatchesSource` took any page whose name CONTAINS the word «العربية» («المملكة العربية السعودية ...» and «صباح العربية» counted as «قناة العربية»);
 *   2. the shortfall counted the named page's posts whatever they were about, so 4 «named» posts of a pool with only 2 about the topic satisfied 3 asked;
 *   3. the link of a `permalink.php?story_fbid=..&id=..` post lost its query string, so its comments could never be read.
 * The pages' author names and captions are replaced by the anonymiser, so the tests put back the structure the live card reported (the README's precedent), never a real name.
 */
const catalog = loadTregCatalog();
const M17 = "msn_6bb78c15d116268b0b9b";
const FBS = "justoneapi.x.facebook-search-post-v1";
const REQUEST = "هات منشورات عن الذكاء الاصطناعي من صفحة قناة العربية على فيسبوك آخر ٣ شهور، ٣ منشورات، مع كل التعليقات والردود.";
const TOPIC = "الذكاء الاصطناعي";
const SAUDI = "المملكة العربية السعودية الميرة الذكاء الاصطناعي";
const SABAH = "صباح العربية - Sabah Al Arabiya";
const CHANNEL = "قناة العربية  Al Arabiya";

describe("1. which author is «قناة العربية» (the page is chosen by its NAME, not by a word inside another page's name)", () => {
  it("the channel's own page matches, the Saudi page and the morning programme's page do not", () => {
    expect(pageMatchesSource({ author: CHANNEL, author_url: "https://www.facebook.com/AlArabiya" }, "قناة العربية")).toBe(true);
    expect(pageMatchesSource({ author: "العربية", author_url: "" }, "قناة العربية")).toBe(true);
    expect(pageMatchesSource({ author: SAUDI, author_url: "https://www.facebook.com/people/x/61593967473726/" }, "قناة العربية")).toBe(false);
    expect(pageMatchesSource({ author: SABAH, author_url: "https://www.facebook.com/sabah.alarabiya" }, "قناة العربية")).toBe(false);
  });
  it("a Latin handle still matches by the link's last part; a longer Arabic name is matched word for word", () => {
    expect(pageMatchesSource({ author: "x", author_url: "https://www.facebook.com/AlArabiya" }, "AlArabiya")).toBe(true);
    expect(pageMatchesSource({ author: "الجزيرة مباشر - Aljazeera Mubasher", author_url: "" }, "صفحة الجزيرة مباشر")).toBe(true);
    expect(pageMatchesSource({ author: "الجزيرة", author_url: "" }, "صفحة الجزيرة مباشر")).toBe(false);
  });
});

/** The real M17 pages with the structure of the live run put back: the page's own posts (some about the topic), a Saudi page, the programme's page. */
const pageOf = (call: string): { data: { results: Array<Record<string, any>>; cursor?: string } } => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M17}/raw/${call}.json`, import.meta.url), "utf8"));
function patchedStore(base: ReplayStore, shape: { named: Array<{ about: boolean; comments: number }>; saudi: number }): ReplayStore {
  return {
    putFile: async (m, p, body, ct) => {
      try {
        const d = JSON.parse(body) as { data?: { results?: Array<Record<string, any>> } };
        if (Array.isArray(d.data?.results) && d.data!.results!.length > 0) {
          const rows = d.data!.results!;
          rows.forEach((r, i) => {
            const slot = i < shape.named.length ? shape.named[i] : null;
            if (slot) { r.author = { id: "100069103503573", name: CHANNEL, url: "https://www.facebook.com/AlArabiya" }; r.message = slot.about ? `${TOPIC} يدخل غرف الأخبار ${i}` : `نشرة الصباح ${i}`; r.comments_count = slot.comments; }
            else if (i < shape.named.length + shape.saudi) { r.author = { id: "61593967473726", name: SAUDI, url: "https://www.facebook.com/people/x/61593967473726/" }; r.message = `Hey everyone ${i}`; r.comments_count = 15; }
            else { r.author = { id: `9${i}`, name: `صفحة أخرى ${i}`, url: `https://www.facebook.com/other${i}` }; r.message = `نص آخر ${i}`; r.comments_count = 3; }
          });
          return base.putFile(m, p, JSON.stringify(d), ct);
        }
      } catch { /* not a search page */ }
      return base.putFile(m, p, body, ct);
    },
  };
}
const SECOND_PAGE = [{ endpointId: FBS, fromMission: M17, call: "call_0005", when: (p: Record<string, unknown>) => p.cursor !== undefined }];

async function plan(shape: { named: Array<{ about: boolean; comments: number }>; saudi: number }, over: { answer?: string | null; priorCalls?: CallRow[]; refuseAll?: boolean } = {}) {
  const store = createMemoryStore();
  const target = "msn_r10_fb";
  const { gateway, stats } = replayGateway(M17, catalog, patchedStore(store, shape), target, { borrow: SECOND_PAGE, only: { [FBS]: ["keyword"] } });
  const out = await planByCompiler({
    mission: { id: target, request_text: REQUEST, answer_text: over.answer ?? null, created_at: "2026-11-03T12:05:32Z" },
    gateway: over.refuseAll ? { tregCall: async () => ({ ok: false as const, call_id: "call_9999", refused: "repeat_sample", message: "refused" }) } : gateway, store, catalog, nowMs: Date.parse("2026-11-03T12:05:40Z"),
    ...(over.priorCalls ? { priorCalls: over.priorCalls } : {}),
  });
  return { out, stats, store };
}
const planOf = (out: CompiledPlanning) => { if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}${"reason" in out ? ` ${out.reason}` : ""}`); return out; };

describe("2. the shortfall counts the named page's posts that are ALSO about the topic (decision 7.5)", () => {
  // the live shape: 4 posts of the page (2 about the topic), 2 posts of the Saudi page, the rest of other pages; 3 asked
  const LIVE = { named: [{ about: true, comments: 379 }, { about: true, comments: 13 }, { about: false, comments: 8 }, { about: false, comments: 4 }], saudi: 2 };

  it("3 asked, 2 of the page's posts talk about the topic: the question card is shown, nothing is priced, and the question names the topic", async () => {
    const { out } = await plan(LIVE);
    expect(out.kind).toBe("question");
    if (out.kind !== "question") return;
    expect(out.why).toBe("named_shortfall");
    expect(out.options).toEqual([NAMED_SHORTFALL_OPTIONS_AR.onlyFound, NAMED_SHORTFALL_OPTIONS_AR.fill, NAMED_SHORTFALL_OPTIONS_AR.cancel]);
    expect(out.question).toMatch(/٢ منشور/);
    expect(out.question).toMatch(/٣ منشور/);
    expect(out.question).toContain(`«${TOPIC}»`);
    expect(out.question).not.toMatch(/[0-9]/);
    expect(checkCustomerText(out.question, { maxChars: 500 }).issues).toEqual([]);
  });

  it("the Saudi page and the programme's page are not counted as the named page (they were: «منها من صفحة «العربية»: ٤» with 2 real ones)", async () => {
    const { out } = await plan(LIVE, { answer: NAMED_SHORTFALL_OPTIONS_AR.fill });
    const p = planOf(out);
    expect((p.plan.notes_ar ?? []).join("\n")).toContain("منها من صفحة «العربية»: ٤");
    const posts = p.plan.stages[0].pinned_rows as Array<Record<string, any>>;
    // the Saudi page's post is never marked as the named page's: it carries the mismatch mark
    for (const r of posts) if (r.author === SAUDI) expect(r.named_source).toBe("المصدر المسمّى: غير مطابق");
  });

  it("«only the ones found» keeps the page's posts that talk about the topic (2), never a post of the page that does not, never another page's", async () => {
    const p = planOf((await plan(LIVE, { answer: NAMED_SHORTFALL_OPTIONS_AR.onlyFound })).out);
    expect(p.result.chosen).toHaveLength(2);
    for (const r of p.plan.stages[0].pinned_rows as Array<Record<string, any>>) { expect(r.author).toBe(CHANNEL); expect(topicTierOf(String(r.text), { topic: { text: TOPIC, relation: "about" } })).toBe(2); }
  });

  it("when the page has enough posts about the topic the question is not asked", async () => {
    const enough = { named: [{ about: true, comments: 9 }, { about: true, comments: 8 }, { about: true, comments: 7 }], saudi: 1 };
    expect((await plan(enough)).out.kind).toBe("plan");
  });
});

describe("3. a post's link keeps what names it (permalink.php?story_fbid=..&id=..), and drops the tracking", () => {
  it("the search card keeps story_fbid and id of a permalink, never a tracking parameter; a normal post link loses its query as before", () => {
    const card = cardOf(FBS)!;
    const page = { data: { results: [
      { post_id: "1", url: "https://www.facebook.com/permalink.php?story_fbid=pfbid02abc&id=61593967473726&__cft__[0]=zzz&__tn__=%2CO%2CP-R", message: "m", author: { id: "7", name: "n", url: "u" }, timestamp: 1790000000, comments_count: 1 },
      { post_id: "2", url: "https://www.facebook.com/AlArabiya/posts/pfbid0xyz?__cft__[0]=zzz&__tn__=%2CO", message: "m", author: { id: "7", name: "n", url: "u" }, timestamp: 1790000000, comments_count: 1 },
    ] } };
    const rows = mapPage(card, page);
    expect(rows[0].link).toBe("https://www.facebook.com/permalink.php?story_fbid=pfbid02abc&id=61593967473726");
    expect(rows[1].link).toBe("https://www.facebook.com/AlArabiya/posts/pfbid0xyz");
  });
  it("TikTok's and X's mapping code is byte for byte what it was on main (sha256 of each card's code, taken before this PR)", () => {
    const pinned: Record<string, string> = { "tikhub.tiktok.search.videos": "bc6c2c4580d174c8", "anyapi.tiktok.search.videos": "050fe3e95d453904", "crawl4ai.tiktok.search.videos": "16af0d02a27c0139", "anyapi.tiktok.video.comments": "cb1b71afb784859f", "anyapi.tiktok.comment_replies": "cb1b71afb784859f", "anyapi.x.search.posts": "8660b8f6cce6c3f8", "anyapi.x.post.comments": "e39f0998242a53ff" };
    for (const [id, hash] of Object.entries(pinned)) expect(createHash("sha256").update(cardMapCode(cardOf(id)!)).digest("hex").slice(0, 16), id).toBe(hash);
  });
});

describe("4. the answer to the question re-plans from the pages ALREADY read (the gateway refuses a third read of a search: repeat_sample), at no new cost", () => {
  const LIVE = { named: [{ about: true, comments: 379 }, { about: true, comments: 13 }, { about: false, comments: 8 }], saudi: 1 };
  it("the answer «only the ones found» is planned from the recorded planning pages when the gateway refuses every new read", async () => {
    const first = await plan(LIVE);
    expect(first.out.kind).toBe("question");
    // what the first planning recorded (mission_calls): its two search reads, with the digest the gateway writes (strings cut at 80 characters)
    const prior: CallRow[] = first.stats.served.map((s, i) => ({
      id: `msn_r10_fb:call_${String(i + 1).padStart(4, "0")}`, mission_id: "msn_r10_fb", phase: "planning", endpoint_id: s.endpointId,
      params_digest: Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 80) : v])), status: "ok", refused_reason: null, http_status: 200, rows_returned: 5, cost_usd: 0.02952, estimate_usd: 0.02952,
      provider_cost_id: null, storage_path: `raw/call_${String(i + 1).padStart(4, "0")}.json`, duration_ms: 1,
    }));
    const store = createMemoryStore();
    // the raw pages of those calls are in the mission's own storage
    const seen = patchedStore(store, LIVE);
    for (let i = 0; i < first.stats.served.length; i += 1) {
      const body = JSON.stringify(first.stats.served[i].storedCall === "call_0004" ? pageOf("call_0004") : pageOf("call_0005"));
      await seen.putFile("msn_r10_fb", `raw/call_${String(i + 1).padStart(4, "0")}.json`, body, "application/json");
    }
    const out = await planByCompiler({
      mission: { id: "msn_r10_fb", request_text: REQUEST, answer_text: NAMED_SHORTFALL_OPTIONS_AR.onlyFound, created_at: "2026-11-03T12:05:32Z" },
      gateway: { tregCall: async () => ({ ok: false as const, call_id: "call_9999", refused: "repeat_sample", message: "refused" }) }, store, catalog, nowMs: Date.parse("2026-11-03T12:08:00Z"), priorCalls: prior,
    });
    expect(out.kind).toBe("plan");
    if (out.kind === "plan") expect(out.reads.pool).toBe(2);
  });
});
