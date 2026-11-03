import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, type CompiledPlanning } from "../agent/src/compiled";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { topicTierOf } from "../src/lib/agentMission/foundation/pool";
import { checkChannelsAgainstWords } from "../src/lib/agentMission/foundation/understand";
import { OCCURRENCE_OPTIONS_AR, approxInstantOfRelative, isRecurringEvent, occurrenceChoiceOf } from "../src/lib/agentMission/foundation/occurrence";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { redesignStagesOf } from "../agent/src/redesign";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import { threadCounterLinesOfPlan } from "../agent/src/threadCounters";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { replayGateway, type ReplayStore } from "./helpers/replayGateway";

/**
 * LIVE ROUND 10 (3 Nov 2026), YouTube: msn_67cafa6747d70356d9cb («هات فيديوهين على يوتيوب عن نهائي السوبر المصري الأهلي والزمالك من القنوات الرسمية، مع كل التعليقات والردود»), a TEST account.
 * The record (read-only SELECTs): 2 videos chosen (both from the Al Ahly channel, one of 2019); the comments tool was the catalog_only one that carries a reply counter and a reply token (20 comments a page, 12 replies counted at planning); the run read TWO
 * comment pages of the FIRST video (40 = the stage's total, taken from the first pages of both videos), never the second video's; and made NO replies call: the comments stage did not keep each comment's reply token on its stored row (`carry_keys`),
 * so the replies stage found nothing to ask. The file said «لا قيود سُجّلت». The real pages used here: M2 (the channel search and the in-channel search pages, call 3, 4, 6, 7), whose structure is the live one; the comments and replies pages are
 * written in the test in the shape the live plan's sample rows showed (no stored real page of that comments tool exists: the README's precedent).
 */
const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const M2 = "msn_ee599cdbbde993073b15";
const request = fixture.missions.find((m) => m.id === M2)!.request;
const IN_CHANNEL = "tikhub.x.youtube-web-search-channel";
const CHANNEL_SEARCH = "tikhub.x.youtube-web-v2-search-channels";
const TIKHUB_COMMENTS = "tikhub.youtube.video.comments";
const REPLIES = "anyapi.youtube.comment_replies";
const TOPIC = "نهائي السوبر المصري الأهلي والزمالك";
const AHLY = "UCA86pBGxVPZGrTeTecOtjew";
const OTHER = "UCeFU0ebL1MK2KlBFniRs6Iw";
const BORROW = [
  { endpointId: CHANNEL_SEARCH, fromMission: M2, call: "call_0003", when: (p: Record<string, unknown>) => String(p.keyword).startsWith("الأهلي") },
  { endpointId: CHANNEL_SEARCH, fromMission: M2, call: "call_0004", when: (p: Record<string, unknown>) => String(p.keyword).startsWith("الزمالك") },
];

/** The M2 channel pages with the titles the anonymiser replaced put back: the videos named here talk about the topic. */
const titled = (base: ReplayStore, titles: Record<string, string>): ReplayStore => ({
  putFile: async (m, p, body, ct) => {
    try {
      const d = JSON.parse(body) as { data?: { videos?: Array<{ video_id: string; title: string }> } };
      if (Array.isArray(d.data?.videos)) { for (const v of d.data!.videos!) if (titles[v.video_id]) v.title = titles[v.video_id]; return base.putFile(m, p, JSON.stringify(d), ct); }
    } catch { /* not a video page */ }
    return base.putFile(m, p, body, ct);
  },
});

async function plan(over: { text?: string; answer?: string | null; catalogOnly?: boolean; titles?: Record<string, string>; understand?: () => Promise<{ channels: string[]; costUsd: number } | null>; occurrence?: unknown; created?: string } = {}) {
  // the request of the live mission is a recurring event with no year: unless a test is about the question, the customer has answered «كل المرات»
  const occurrence = over.occurrence === null ? undefined : (over.occurrence ?? { kind: "all" });
  const store = createMemoryStore();
  const { gateway, stats } = replayGateway(M2, catalog, titled(store, over.titles ?? {}), "msn_r10_yt", { only: { [IN_CHANNEL]: ["channel_id"] }, borrow: BORROW });
  const created = over.created ?? "2026-11-03T12:14:15Z";
  const out = await planByCompiler({
    mission: { id: "msn_r10_yt", request_text: over.text ?? request, answer_text: over.answer ?? null, created_at: created }, gateway, store, catalog, nowMs: Date.parse(created) + 60_000,
    ...(over.catalogOnly ? { catalogOnly: true } : {}), ...(over.understand ? { understand: over.understand } : {}), ...(occurrence ? { occurrence: occurrence as never } : {}),
  });
  return { out, stats, store };
}
const planOf = (out: CompiledPlanning) => { if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}${"reason" in out ? ` ${out.reason}` : ""}`); return out; };
const ASKED_YEAR_FREE = "هات فيديوهين على يوتيوب عن نهائي السوبر المصري الأهلي والزمالك من القنوات الرسمية آخر سنة، مع كل التعليقات والردود.";

describe("5. the topic is matched on its KEY tokens, not on the whole phrase", () => {
  const topic = { topic: { text: TOPIC, relation: "about" as const } };
  it("the two live titles are about the topic: «زيزو رجل نهائي السوبر أمام الزمالك ✨😎» and «لحظات تتويج الأهلي بكأس السوبر المصري والفوز على الزمالك ٣-٢»", () => {
    expect(topicTierOf("زيزو رجل نهائي السوبر أمام الزمالك ✨😎", topic)).toBe(2);
    expect(topicTierOf("لحظات تتويج الأهلي بكأس السوبر المصري والفوز على الزمالك ٣-٢", topic)).toBe(2);
  });
  it("a text with one of the names, or none, is not about it; the «و» glued to a name does not hide it", () => {
    expect(topicTierOf("مقطع طريف عن القطط", topic)).toBe(0);
    expect(topicTierOf("تدريب الأهلي اليوم", topic)).toBe(0);
    expect(topicTierOf("الأهلي و الزمالك في السوبر", { topic: { text: "الأهلي والزمالك", relation: "about" } })).toBe(2);
  });
  it("a topic of one, two or three words is matched as before (every word): nothing changes for «الذكاء الاصطناعي»", () => {
    const ai = { topic: { text: "الذكاء الاصطناعي", relation: "about" as const } };
    expect(topicTierOf("الذكاء وحده", ai)).toBe(0);
    expect(topicTierOf("عن الذكاء الاصطناعي اليوم", ai)).toBe(2);
    expect(topicTierOf("#ذكاء_اصطناعي رقصة", { topic: { text: "ذكاء اصطناعي", relation: "about" } })).toBe(1);
  });
});

describe("6. the official channels: the model fills the names through the understand step, code checks them against the customer's words", () => {
  it("a name the customer's words contain is kept (and gets «الرسمية»); a name they do not contain, or a Latin one, is dropped", () => {
    expect(checkChannelsAgainstWords(["الأهلي", "الزمالك", "الدوري المصري", "Al Ahly SC"], request)).toEqual(["الأهلي الرسمية", "الزمالك الرسمية"]);
    expect(checkChannelsAgainstWords(["الأهلي", "الدوري المصري الرسمي"], `${request} والدوري المصري`)).toEqual(["الأهلي الرسمية", "الدوري المصري الرسمي"]);
    expect(checkChannelsAgainstWords(["Al Ahly SC"], request)).toEqual([]);
    expect(checkChannelsAgainstWords([], request)).toEqual([]);
  });

  it("the plan reads each official channel the understand step named (the card lists the channels it read), and the 2 chosen videos are from two DIFFERENT clubs' channels", async () => {
    let asked = 0;
    const { out, stats } = await plan({ understand: async () => { asked += 1; return { channels: ["الأهلي", "الزمالك"], costUsd: 0.0004 }; } });
    const p = planOf(out);
    expect(asked).toBe(1);
    expect(stats.served.filter((s) => s.endpointId === CHANNEL_SEARCH).map((s) => s.params.keyword)).toEqual(["الأهلي الرسمية", "الزمالك الرسمية"]);
    const chosen = p.plan.stages[0].pinned_rows as Array<Record<string, unknown>>;
    expect(new Set(chosen.map((r) => String(r.channel_id))).size).toBe(2);
    expect(chosen.map((r) => String(r.channel_id)).sort()).toEqual([AHLY, OTHER].sort());
    const line = (p.plan.notes_ar ?? []).find((x) => /القنوات/.test(x));
    expect(line).toContain("عدد القنوات التي قرأنا فيديوهاتها: ٢");
  });

  it("a model that gives nothing usable (no answer, or names the customer never wrote) leaves the code's names: the plan is the same as with no understand step", async () => {
    const a = planOf((await plan({ understand: async () => null })).out);
    const b = planOf((await plan({ understand: async () => ({ channels: ["Real Madrid", "الدوري الإنجليزي"], costUsd: 0.0002 }) })).out);
    const c = planOf((await plan()).out);
    expect(a.result.chosen).toEqual(c.result.chosen);
    expect(b.result.chosen).toEqual(c.result.chosen);
  });
});

describe("7. a recurring event with no year or date asks «تقصد أنهي مرة؟» before anything is read (Facebook, Instagram, YouTube)", () => {
  it("the topic is a recurring event (a final, a cup, a season, an election) and the words give no year and no period", () => {
    const ask = buildAsk(request, null, Date.parse("2026-11-03T12:14:15Z"));
    expect(isRecurringEvent(ask, request)).toBe(true);
    expect(isRecurringEvent(buildAsk("هات ٣ منشورات عن الذكاء الاصطناعي من فيسبوك", null, 0), "هات ٣ منشورات عن الذكاء الاصطناعي من فيسبوك")).toBe(false);
    expect(isRecurringEvent(buildAsk(ASKED_YEAR_FREE, null, Date.parse("2026-11-03T12:14:15Z")), ASKED_YEAR_FREE)).toBe(false);
    const withYear = "هات فيديوهين على يوتيوب عن نهائي السوبر المصري الأهلي والزمالك ٢٠٢٤ من القنوات الرسمية";
    expect(isRecurringEvent(buildAsk(withYear, null, 0), withYear)).toBe(false);
  });

  it("the question card has the three answers, the latest occurrence first; nothing is read or priced", async () => {
    const { out, stats } = await plan({ occurrence: null });
    expect(out.kind).toBe("question");
    if (out.kind !== "question") return;
    expect(out.why).toBe("occurrence");
    expect(out.question).toContain("تقصد أنهي مرة؟");
    expect(out.options).toEqual([OCCURRENCE_OPTIONS_AR.latest, OCCURRENCE_OPTIONS_AR.all, OCCURRENCE_OPTIONS_AR.year]);
    expect(out.reads).toEqual({ pool: 0, exposure: 0 });
    expect(stats.served).toEqual([]);
    expect(checkCustomerText(out.question, { maxChars: 400 }).issues).toEqual([]);
    expect(out.question).not.toMatch(/[0-9]/);
  });

  it("the answers are read by their exact words; «حدد سنة» asks for the year, a typed year is the year", async () => {
    expect(occurrenceChoiceOf(OCCURRENCE_OPTIONS_AR.latest)).toEqual({ kind: "latest" });
    expect(occurrenceChoiceOf(OCCURRENCE_OPTIONS_AR.all)).toEqual({ kind: "all" });
    expect(occurrenceChoiceOf(OCCURRENCE_OPTIONS_AR.year)).toEqual({ kind: "ask_year" });
    expect(occurrenceChoiceOf("٢٠٢٤")).toEqual({ kind: "year", year: 2024 });
    expect(occurrenceChoiceOf("سنة 2019")).toEqual({ kind: "year", year: 2019 });
    expect(occurrenceChoiceOf("أي كلام")).toBeNull();
    const { out } = await plan({ answer: OCCURRENCE_OPTIONS_AR.year, occurrence: null });
    expect(out.kind).toBe("question");
    if (out.kind === "question") { expect(out.why).toBe("occurrence_year"); expect(out.options).toEqual([]); expect(out.question).toContain("اكتب السنة"); }
  });

  it("the latest occurrence is the default: the chosen videos are of the newest year the pool has about the topic, not the 2019 one (live: «7 years ago»)", async () => {
    // the stored pages' own `published_time`: 7 years ago (VZqp9F8ed2s), 2 years ago (rFsXhDoW8DU), 9 months ago (RmjKXb5gYiw): the titles the anonymiser replaced are put back so all three talk about the topic
    const titles = { VZqp9F8ed2s: "لحظات تتويج الأهلي بكأس السوبر المصري والفوز على الزمالك ٣-٢", rFsXhDoW8DU: "زيزو رجل نهائي السوبر أمام الزمالك", RmjKXb5gYiw: "نهائي السوبر المصري الأهلي والزمالك" };
    const latest = planOf((await plan({ titles, occurrence: { kind: "latest" }, catalogOnly: true })).out);
    const ids = (latest.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((r) => String(r.id));
    expect(ids).not.toContain("VZqp9F8ed2s");
    expect(ids).toContain("RmjKXb5gYiw");
    const all = planOf((await plan({ titles, occurrence: { kind: "all" }, catalogOnly: true })).out);
    expect((all.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((r) => String(r.id))).toContain("VZqp9F8ed2s");
  });

  it("«published» in the words of the source («7 years ago», «Streamed 6 years ago», «11 months ago») is an approximate moment", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(new Date(approxInstantOfRelative("7 years ago", now)!).getUTCFullYear()).toBe(2019);
    expect(new Date(approxInstantOfRelative("Streamed 6 years ago", now)!).getUTCFullYear()).toBe(2020);
    expect(new Date(approxInstantOfRelative("11 months ago", now)!).getUTCFullYear()).toBe(2025);
    expect(approxInstantOfRelative("3 days ago", now)).toBe(now - 3 * 86_400_000);
    expect(approxInstantOfRelative("لا شيء", now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------- the engine, on pages written in the live shape
const comment = (video: string, i: number, withReplies: boolean) => ({ id: `${video}_c${i}`, text: `نص_${video}_${i}`, author: `@u${i}`, likes: i % 7, reply_count: withReplies ? 2 : 0, ...(withReplies ? { reply_continuation_token: `tok_${video}_${i}` } : {}) });
/** tikhub comments: the FIRST chosen video has 7 pages of 20 (140, above the per-video allowance); the second has one page of 20. The first 3 comments of each page carry replies (2 each). */
function liveGateway(store: ReplayStore, mission: string, firstVideo: string) {
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let seq = 100;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      calls.push({ endpoint, params });
      const id = `call_${String((seq += 1)).padStart(4, "0")}`;
      let page: unknown;
      let next: string | null = null;
      let n = 0;
      if (endpoint === TIKHUB_COMMENTS) {
        const video = String(params.video_id);
        const at = params.continuation_token ? Number(String(params.continuation_token).replace("p", "")) : 1;
        const pages = video === firstVideo ? 7 : 1;
        next = at < pages ? `p${at + 1}` : null;
        page = { data: { comments: Array.from({ length: 20 }, (_, i) => comment(video, (at - 1) * 20 + i, i < 3)), continuation_token: next } };
        n = 20;
      } else if (endpoint === REPLIES) {
        const token = String(params.continuationToken);
        page = { output: { data: { comments: [{ id: `${token}_r1`, text: "رد", author: "@r1", likes: 0 }, { id: `${token}_r2`, text: "رد٢", author: "@r2", likes: 1 }], nextCursor: null } } };
        n = 2;
      } else return { ok: false as const, call_id: id, failed: true as const, http_status: 0, message: "not served" };
      await store.putFile(mission, RAW_PATH(id), JSON.stringify(page), "application/json");
      return { ok: true as const, call_id: id, http_status: 200, rows_in_page: n, has_more: next !== null, next_cursor: next, shape: null, first_rows: [], warnings: [], saved: id };
    },
  };
  return { gateway, calls };
}

describe("3 and 4. the compiled plan keeps the reply tokens and sizes an open comments stage per video; the engine then reads EVERY chosen video and the replies of every comment that has a token", () => {
  const OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" } as RedesignFlags;
  async function compiled() { return planOf((await plan({ catalogOnly: true })).out); }

  it("the comments stage keeps each comment's reply token on the stored row (`carry_keys`) and the replies stage binds to it", async () => {
    const p = await compiled();
    const comments = p.plan.stages.find((s) => s.key === "comments")!;
    expect(comments.endpoint_id).toBe(TIKHUB_COMMENTS);
    expect(comments.carry_keys).toEqual(["reply_continuation_token"]);
    expect(p.plan.stages.find((s) => s.key === "comments_replies")!.engine?.parent_binding).toEqual({ param: "continuationToken", from: "reply_continuation_token" });
  });

  it("an OPEN comments stage is sized by a per-video allowance (not by the first pages it saw), and the card says so", async () => {
    const p = await compiled();
    const comments = p.plan.stages.find((s) => s.key === "comments")!;
    expect(comments.per_parent_rows).toBe(100);
    expect(comments.planned_rows).toBe(200);
    expect((p.plan.notes_ar ?? []).join("\n")).toContain("حتى ١٠٠ تعليق من كل");
  });

  it("run on pages of the live shape: the first video is read up to its allowance (100), the SECOND video is read too (20), and the replies of every comment with a token are read (2 each)", async () => {
    const p = await compiled();
    const [first, second] = p.result.chosen;
    const mission = "msn_r10_yt_exec";
    const store = createMemoryStore();
    const items = await ItemStore.open(store, mission);
    const { gateway, calls } = liveGateway(store, mission, first);
    await runEngine({ items, store, plan: withPromiseCaps(p.plan), missionId: mission, gateway: gateway as unknown as Gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(p.plan, OFF, true, { youtube: "test" }) });
    const comments = items.acceptedRows("comments");
    expect(comments.filter((c) => c.parent_id === first)).toHaveLength(100);
    expect(comments.filter((c) => c.parent_id === second)).toHaveLength(20);
    const replies = items.acceptedRows("comments_replies");
    // 100 comments of the first video = 5 pages of 3 with a token (15) and the second video's 3: 18 tokens, 2 replies each
    expect(calls.filter((c) => c.endpoint === REPLIES)).toHaveLength(18);
    expect(replies).toHaveLength(36);
    expect(replies.every((r) => String(r.parent_id).startsWith(`${first}_c`) || String(r.parent_id).startsWith(`${second}_c`))).toBe(true);
  }, 60_000);
});

describe("3. «حدود هذا التسليم» says every gap per video, even when the platform gives no counter", () => {
  // the live record: video 1 gave 40 comments (12 of them carry replies by their counters), video 2 gave 0, replies 0; the videos carry no counter
  const plan = {
    compiled: { by: "compiler" as const, platform: "youtube" as const, promises: {} },
    stages: [
      { key: "videos", title_ar: "الفيديوهات", deliver: true, parent_key: null, planned_rows: 2 },
      { key: "comments", title_ar: "التعليقات", deliver: true, parent_key: "videos", planned_rows: 200, per_parent_rows: 100, children_cap_per_parent: 100, children_open: true, all_children: true },
      { key: "comments_replies", title_ar: "الردود", deliver: true, parent_key: "comments", planned_rows: 12, replies_of: "comments", replies_open: true, replies_uncapped: true },
    ],
  } as never;
  const videos = [{ id: "V1" }, { id: "V2" }];
  const comments = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, parent_id: "V1", replies_count: i < 12 ? 1 : 0 }));
  const noun = (t: string | undefined) => (t === "الفيديوهات" ? "فيديو" : t === "التعليقات" ? "تعليق" : t === "الردود" ? "رد" : null);

  it("each video: comments delivered against the allowance (no counter is said so), the one with none is named, the replies against the reply counters of its delivered comments", () => {
    const lines = threadCounterLinesOfPlan(plan, { videos, comments, comments_replies: [] }, noun, { comments: "target_reached", comments_replies: "source_exhausted" });
    const text = [...lines.counterLines, ...lines.limitLines].join("\n");
    expect(text).toContain("الفيديو رقم ١");
    expect(text).toContain("الفيديو رقم ٢");
    expect(lines.limitLines.some((l) => l.startsWith("الفيديو رقم ٢") && /لم يُسلَّم منه أي تعليق/.test(l))).toBe(true);
    expect(lines.limitLines.some((l) => l.startsWith("الفيديو رقم ١") && /ردود التعليقات المسلّمة بحسب عدّاداتها ١٢ ردًا وسُلّم منها/.test(l))).toBe(true);
    expect(lines.limitLines.join("\n")).not.toMatch(/[0-9]/);
  });

  it("a plan with nothing missing says nothing (no noise): both videos delivered up to the allowance and every reply by its counter", () => {
    const full = [...comments, ...Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, parent_id: "V2", replies_count: 0 }))];
    const replies = comments.filter((c) => c.replies_count > 0).map((c, i) => ({ id: `r${i}`, parent_id: c.id }));
    const lines = threadCounterLinesOfPlan(plan, { videos, comments: full, comments_replies: replies }, noun, { comments: "source_exhausted", comments_replies: "source_exhausted" });
    expect(lines.limitLines).toEqual([]);
  });
});
