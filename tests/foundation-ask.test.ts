import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAsk, periodOfRequest } from "../src/lib/agentMission/foundation/ask";

/**
 * F1, THE ASK, on the 20 stored requests of the test account (docs/ROOT-CAUSE.md section 1; the texts are `tests/fixtures/live/replay-missions.json`, read by SELECT).
 * The table below is written by hand from the customer's words, not from the code's output: what each request asks, value by value. The moment of each request is its
 * stored Cairo time (2026, Cairo = UTC+2 on these days: Egypt's summer time ended on 2026-10-29). None of the 20 gives a number per parent («N تعليق من كل فيديو»): both per-parent
 * numbers are null (the live request that does is tests/foundation-live-e32cd467.test.ts).
 */
interface Fx { id: string; cairo: string; request: string }
const missions = (JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Fx[] }).missions;
const atOf = (cairo: string): number => Date.parse(`2026-${cairo.replace(" ", "T")}:00+02:00`);

// CHANGED (round 19): every Ask now also carries `commentsBare` (a bare number of comments with no «each» and no «total»; null for these twenty requests, none of which has one)
const FB = (from: string, to: string) => ({ platform: "facebook", parentKind: "posts", count: 2, source: { kind: "named", text: "العربية" }, topic: { text: "الذكاء الاصطناعي", relation: "about" }, period: { from, to }, country: null, language: null, order: "most_commented", comments: "all", replies: "all", commentsPerParent: null, commentsBare: null, repliesPerComment: null });
const YT = { platform: "youtube", parentKind: "videos", count: 2, source: { kind: "official", text: null }, topic: { text: "نهائي السوبر المصري الأهلي والزمالك", relation: "about" }, period: null, country: null, language: null, order: "most_commented", comments: "all", replies: "all", commentsPerParent: null, commentsBare: null, repliesPerComment: null };
const TT = { platform: "tiktok", parentKind: "videos", count: 2, source: { kind: "none", text: null }, topic: { text: "الذكاء الاصطناعي", relation: "about" }, period: null, country: "EG", language: "ar", order: "most_commented", comments: "all", replies: "all", commentsPerParent: null, commentsBare: null, repliesPerComment: null };
const IG = { platform: "instagram", parentKind: "posts", count: 2, source: { kind: "named", text: "alhadath" }, topic: { text: null, relation: "none" }, period: null, country: null, language: null, order: "most_commented", comments: "all", replies: "all", commentsPerParent: null, commentsBare: null, repliesPerComment: null };
// X: no comments are asked on X (a reply is a tweet), so the order is the newest; «مع الردود» asks the replies, without «كل»
const X = { platform: "x", parentKind: "tweets", count: 20, source: { kind: "none", text: null }, topic: { text: "العاصمة الإدارية", relation: "about" }, period: { from: "2026-10-01", to: "2026-10-31" }, country: null, language: "ar", order: "newest", comments: "none", replies: "some", commentsPerParent: null, commentsBare: null, repliesPerComment: null };

const TABLE: Record<string, unknown> = {
  msn_a254618740b9b9878126: FB("2026-08-01", "2026-11-01"), // M1, 11-01 23:04
  msn_ee599cdbbde993073b15: YT, // M2
  msn_481a78e310d9e68fddce: TT, // M3
  msn_3ec7bb6012a36a703180: IG, // M4
  msn_e3d679014c58168c3227: X, // M5
  msn_48f6c7c80eb7068f2a38: TT, msn_a6dacebce7e7b7432aa1: TT, msn_7a35b44e35e6f3f1b8e9: TT, msn_c796a6ff13d79f7a973d: TT, msn_6066498b5da3dd512595: TT, msn_5d849cbac96092de0287: TT, msn_5851abc92a1e6645a9cd: TT, msn_f22426e67810c2ce852e: TT, // M6-M13
  msn_b060d3347ed7660f972e: X, // M14
  msn_afe9bb0b436670e35a3c: IG, msn_e3e7632e2fb2d42f9c19: IG, // M15, M16
  msn_6bb78c15d116268b0b9b: FB("2026-08-02", "2026-11-02"), // M17, 11-02 17:36 (the stored search used startDate 2026-08-02 / endDate 2026-11-02)
  msn_3594a5ab6311c8691f20: YT, // M18
  msn_96beb9f7a1d937a90cd0: FB("2026-08-02", "2026-11-02"), // M19
  msn_adcfafabcdebc27ff803: YT, // M20
};

const comparable = (a: ReturnType<typeof buildAsk>) => ({ ...a, period: a.period ? { from: a.period.from, to: a.period.to } : null, edits: undefined });

describe("F1: the Ask of the 20 stored requests equals the hand-written table", () => {
  it("covers exactly the 20 stored missions", () => {
    expect(missions.length).toBe(20);
    expect(new Set(missions.map((m) => m.id))).toEqual(new Set(Object.keys(TABLE)));
  });
  for (const m of missions) {
    it(`${m.id} (${m.cairo})`, () => {
      const ask = buildAsk(m.request, null, atOf(m.cairo));
      expect(comparable(ask)).toEqual({ ...(TABLE[m.id] as object), edits: undefined });
    });
  }
});

describe("F1: the period as Cairo instants, and the edit", () => {
  it("October 2026 in Cairo starts at 21:00 UTC on 30 September (summer time) and ends at 22:00 UTC on 31 October (winter time)", () => {
    const p = periodOfRequest("في شهر أكتوبر ٢٠٢٦", Date.parse("2026-11-02T13:00:00Z"))!;
    expect(p.from).toBe("2026-10-01");
    expect(p.to).toBe("2026-10-31");
    expect(new Date(p.startMs).toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(new Date(p.endExclusiveMs).toISOString()).toBe("2026-10-31T22:00:00.000Z");
  });
  it("«آخر ٣ شهور» counts back from the Cairo day of the request, that day included", () => {
    const p = periodOfRequest("آخر ٣ شهور", Date.parse("2026-11-02T15:36:00Z"))!;
    expect([p.from, p.to]).toEqual(["2026-08-02", "2026-11-02"]);
  });
  it("the customer's edit of the card is part of the Ask (Stage 2 recompiles with it); the words still decide everything else", () => {
    const a = buildAsk("هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.", null, Date.parse("2026-11-02T11:35:00Z"), { comments: 300 });
    expect(a.edits).toEqual({ comments: 300 });
    expect(a.comments).toBe("all");
    expect(a.count).toBe(2);
  });
  it("a request that names the newest is ordered by the newest", () => {
    expect(buildAsk("هات أحدث فيديوهين تيك توك عن الذكاء الاصطناعي مع كل التعليقات", null, 0).order).toBe("newest");
  });
});
