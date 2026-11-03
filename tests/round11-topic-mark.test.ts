import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { replayGateway, type ReplayStore } from "./helpers/replayGateway";

/**
 * LIVE ROUND 11 (3 Nov 2026), item 3: round 10's YouTube videos sheet had «علاقة النص بالموضوع», round 11's did not: the column was added only when SOME chosen item was not about the topic (and never for X). A file whose items are all about the
 * topic then said nothing about it, so the customer could not tell «all about it» from «not checked». The column is now on the parent sheet of every compiled social file whenever the Ask has a topic, with the value of each item (all four tiers' words),
 * on every platform: TikTok and X included (the diff of their stored replays is in tests/round11-tiktok-x-invariance.test.ts). An Ask with no topic has no such column.
 */
const catalog = loadTregCatalog();
const read = (m: string, rel: string) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${m}/${rel}.json`, import.meta.url), "utf8"));
const TOPIC = "الذكاء الاصطناعي";
const ABOUT = "يتحدث نصه عن الموضوع";
const AT = Date.parse("2026-11-03T12:00:00Z");

/** Every text of the page says it talks about the topic (the anonymiser replaced the real captions; the structure of the real page is kept). */
function aboutPage(page: unknown, topic: string = TOPIC): unknown {
  const walk = (v: unknown, key: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return typeof v === "string" && /^(text|full_text|caption|message|desc|description|title)$/i.test(key ?? "") ? `شرح ${topic} اليوم` : v;
  };
  return walk(page, null);
}

const cases: Array<{ topic?: string; platform: string; request: string; cardId: string; mission: string; call: string }> = [
  { platform: "tiktok", request: `هات فيديوهين تيك توك بالعربي عن ${TOPIC} من مصر`, cardId: "anyapi.tiktok.search.videos", mission: "msn_5851abc92a1e6645a9cd", call: "raw/call_0002" },
  { topic: "العاصمة الإدارية", platform: "x", request: `هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦`, cardId: "anyapi.x.search.posts", mission: "msn_b060d3347ed7660f972e", call: "raw/call_0003" },
  { platform: "facebook", request: `هات ٣ منشورات عن ${TOPIC} على فيسبوك آخر ٣ شهور`, cardId: "justoneapi.x.facebook-search-post-v1", mission: "msn_6bb78c15d116268b0b9b", call: "raw/call_0004" },
  { platform: "instagram", request: `هات منشورين عن ${TOPIC} من حساب الحدث على إنستجرام (alhadath)`, cardId: "scrapecreators.instagram.user.posts", mission: "msn_e3e7632e2fb2d42f9c19", call: "raw/call_0002" },
];

describe("the topic mark is on the parent sheet whenever the Ask has a topic, even when every chosen item is about it", () => {
  for (const c of cases) {
    it(`${c.platform}: all chosen items talk about the topic, and the stage still has the column with the value «${ABOUT}» on each`, () => {
      const card = cardOf(c.cardId)!;
      const ask = buildAsk(c.request, null, AT);
      const page = aboutPage(read(c.mission, c.call), c.topic);
      const r = compilePlan({ ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0001", page }] }, exposure: () => undefined, capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null, catalogOnly: true });
      if (!r.ok) throw new Error(`${c.platform}: ${r.reason}`);
      const parent = r.plan.stages[0];
      expect(parent.columns.map((x) => x.key), c.platform).toContain("topic_relation");
      expect(parent.columns.find((x) => x.key === "topic_relation")!.title_ar).toBe("علاقة النص بالموضوع");
      for (const row of (parent.pinned_rows ?? []) as Array<Record<string, unknown>>) expect(row.topic_relation, c.platform).toBe(ABOUT);
    });
    it(`${c.platform}: an Ask with no topic has no such column`, () => {
      const card = cardOf(c.cardId)!;
      const none = c.platform === "tiktok" ? "هات فيديوهين تيك توك من مصر" : c.platform === "x" ? "هات ٢٠ تغريدة على X من @account" : c.platform === "facebook" ? "هات ٣ منشورات من صفحة على فيسبوك" : "هات منشورين من حساب الحدث على إنستجرام (alhadath)";
      const ask = buildAsk(none, null, AT);
      expect(ask.topic.text).toBeNull();
      const r = compilePlan({ ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0001", page: read(c.mission, c.call) }] }, exposure: () => undefined, capabilityOf: () => null, catalogOnly: true });
      if (!r.ok) return;
      expect(r.plan.stages[0].columns.map((x) => x.key)).not.toContain("topic_relation");
    });
  }

  it("youtube: the videos of the official channels talk about the topic and the sheet has the column (round 11 had none)", async () => {
    const M2 = "msn_ee599cdbbde993073b15";
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
    const request = fixture.missions.find((m) => m.id === M2)!.request;
    const store = createMemoryStore();
    const titledAll: ReplayStore = {
      putFile: async (m, p, body, ct) => {
        try { const d = JSON.parse(body) as { data?: { videos?: Array<{ title: string }> } }; if (Array.isArray(d.data?.videos)) { for (const v of d.data!.videos!) v.title = "نهائي السوبر المصري الأهلي والزمالك"; return store.putFile(m, p, JSON.stringify(d), ct); } } catch { /* not a video page */ }
        return store.putFile(m, p, body, ct);
      },
    };
    const { gateway } = replayGateway(M2, catalog, titledAll, "msn_r11_yt", { only: { "tikhub.x.youtube-web-search-channel": ["channel_id"] }, borrow: [
      { endpointId: "tikhub.x.youtube-web-v2-search-channels", fromMission: M2, call: "call_0003", when: (p) => String(p.keyword).startsWith("الأهلي") },
      { endpointId: "tikhub.x.youtube-web-v2-search-channels", fromMission: M2, call: "call_0004", when: (p) => String(p.keyword).startsWith("الزمالك") },
    ] });
    const out = await planByCompiler({ mission: { id: "msn_r11_yt", request_text: request, answer_text: null, created_at: "2026-11-03T13:38:44Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-03T13:39:44Z"), catalogOnly: true, occurrence: { kind: "all" } });
    if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}`);
    const parent = out.plan.stages[0];
    expect(parent.columns.map((x) => x.key)).toContain("topic_relation");
    for (const row of (parent.pinned_rows ?? []) as Array<Record<string, unknown>>) expect(row.topic_relation).toBe(ABOUT);
  }, 60_000);
});
