import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countPhraseAr, isCurrentTitleForm, missionDownloadName, missionFileTitleAr, missionTitleAr } from "../src/lib/agentMission/fileNames";
import { methodologyMissionOf } from "../src/lib/agentMission/methodology/missions";

/**
 * ROUND 27, item 6 (the owner's decision): a request for videos or posts WITH THEIR COMMENTS AND REPLIES is named by its PARENT items:
 * «فيديوهان مع التعليقات والردود عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦», not by the count and noun of the last stage («٣٢٢ ردًا ...»).
 * The Excel name, the methodology title and the chooser card carry the same words for the same mission, across midnight too (a stored name in the current form is the name).
 * Checked on the stored live missions of every platform (tests/fixtures/live/replay-missions.json).
 */
type Fx = { id: string; request: string; stages: Array<{ key: string; planned: number; endpoint_id: string; parent_key: string | null }> };
const missions = (JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Fx[] }).missions;
const TITLES: Record<string, string> = { posts: "المنشورات", videos: "الفيديوهات", tweets: "التغريدات", comments: "التعليقات", comments_replies: "الردود", replies: "الردود" };
const DATE = new Date(Date.UTC(2026, 10, 4, 12));
const DATE_AR = "٤ نوفمبر ٢٠٢٦";
const stagesOf = (m: Fx) => m.stages.map((s) => ({ key: s.key, title_ar: TITLES[s.key], expected_rows: s.planned, parent_key: s.parent_key, deliver: true }));
const totalOf = (m: Fx) => m.stages.reduce((n, s) => n + s.planned, 0);
const parentOf = (m: Fx) => m.stages.find((s) => s.parent_key === null)!.planned;
const hasChildren = (m: Fx) => m.stages.some((s) => s.parent_key !== null);
const stage = (key: string, title: string, rows: number, parent: string | null) => ({ key, title_ar: title, expected_rows: rows, parent_key: parent, deliver: true });

describe("the examples", () => {
  const plan = { stages: [stage("videos", "الفيديوهات", 2, null), stage("comments", "التعليقات", 140, "videos"), stage("comments_replies", "الردود", 60, "comments")] };
  it("videos with comments and replies: «فيديوهان مع التعليقات والردود عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦»", () => {
    expect(missionFileTitleAr({ plan, requestText: "هات فيديوهين تيك توك عن الذكاء الاصطناعي مع كل التعليقات والردود", delivered: 202, date: DATE })).toBe(`فيديوهان مع التعليقات والردود عن الذكاء الاصطناعي - ${DATE_AR}`);
  });
  it("Arabic count grammar of the parents: 1, 2, 3, 10, 11", () => {
    const of = (n: number) => missionFileTitleAr({ plan: { stages: [stage("videos", "الفيديوهات", n, null), stage("comments", "التعليقات", 50, "videos")] }, requestText: "عن الذكاء الاصطناعي", delivered: 50 + n, date: DATE });
    expect(of(1)).toMatch(/^فيديو واحد مع التعليقات عن الذكاء الاصطناعي - /);
    expect(of(2)).toMatch(/^فيديوهان مع التعليقات عن/);
    expect(of(3)).toMatch(/^٣ فيديوهات مع التعليقات عن/);
    expect(of(10)).toMatch(/^١٠ فيديوهات مع التعليقات عن/);
    expect(of(11)).toMatch(/^١١ فيديو مع التعليقات عن/);
  });
  it("posts and tweets, comments only, replies only", () => {
    const posts = { stages: [stage("posts", "المنشورات", 3, null), stage("comments", "التعليقات", 20, "posts")] };
    expect(missionFileTitleAr({ plan: posts, requestText: "هات منشورات عن الذكاء الاصطناعي", delivered: 23, date: DATE })).toBe(`٣ منشورات مع التعليقات عن الذكاء الاصطناعي - ${DATE_AR}`);
    const tweets = { stages: [stage("tweets", "التغريدات", 20, null), stage("replies", "الردود", 9, "tweets")] };
    expect(missionFileTitleAr({ plan: tweets, requestText: "هات ٢٠ تغريدة عن العاصمة الإدارية مع الردود", delivered: 29, date: DATE })).toBe(`٢٠ تغريدة مع الردود عن العاصمة الإدارية - ${DATE_AR}`);
  });
  it("a request with NO comments and replies keeps the round-26 rule: «١٠ تغريدات عن الذكاء الاصطناعي»", () => {
    expect(missionFileTitleAr({ plan: { stages: [stage("tweets", "التغريدات", 10, null)] }, requestText: "عايز داتا عن رأي الناس في الذكاء الاصطناعي", delivered: 10, date: DATE })).toBe(`١٠ تغريدات عن الذكاء الاصطناعي - ${DATE_AR}`);
  });
  it("the parents the file really holds win over the planned rows", () => {
    expect(missionFileTitleAr({ plan, requestText: "عن الذكاء الاصطناعي", delivered: 100, parentDelivered: 1, date: DATE })).toMatch(/^فيديو واحد مع التعليقات والردود عن/);
  });
  it("the short mission title (notices) says the same without the date", () => {
    expect(missionTitleAr({ plan, requestText: "هات فيديوهين عن الذكاء الاصطناعي مع التعليقات والردود" })).toBe("فيديوهان مع التعليقات والردود عن الذكاء الاصطناعي");
  });
});

describe("the stored live missions of every platform that have comment stages", () => {
  const withChildren = missions.filter(hasChildren);
  it("the fixture has comment stages on all five platforms", () => {
    const platform = (m: Fx) => m.stages[0].endpoint_id.split(".")[1];
    expect(new Set(withChildren.map(platform))).toEqual(new Set(["tiktok", "youtube", "instagram", "facebook", "x"]));
  });
  for (const m of withChildren) {
    describe(`${m.stages[0].endpoint_id.split(".")[1]} ${m.id.slice(0, 12)}`, () => {
      const title = missionFileTitleAr({ plan: { stages: stagesOf(m) }, requestText: m.request, delivered: totalOf(m), date: DATE });
      it("the Excel name leads with the PARENTS and says «مع التعليقات»", () => {
        expect(title).toMatch(/^(?:\S+ واحد|\S+ان|\S+تان|[٠-٩]+ \S+) مع (?:التعليقات والردود|التعليقات|الردود) عن \S.* - ٤ نوفمبر ٢٠٢٦$/);
        expect(title).not.toMatch(/^[٠-٩]+ (?:ردًا|رد|ردود|تعليقًا|تعليق|تعليقات) /);
        expect(title).toContain(m.stages[0].key === "tweets" ? "تغريد" : m.stages[0].key === "videos" ? "فيديو" : "منشور");
        expect(title).not.toContain("رأي الناس");
        expect(missionDownloadName({ files: [], kind: "xlsx", plan: { stages: stagesOf(m) }, requestText: m.request, deliveredUnits: totalOf(m), date: DATE })).toBe(`${title}.xlsx`);
      });
      it("the methodology title and the chooser card are the same words; across midnight the stored name is kept", () => {
        const row = (files: unknown[]) => ({ id: m.id, job_id: "job_x", status: "completed", delivered_units: totalOf(m), request_text: m.request, plan_public: { compiled: true, stages: stagesOf(m) }, files, created_at: DATE.toISOString(), updated_at: DATE.toISOString() });
        expect(methodologyMissionOf(row([{ name: "d.xlsx", path: "p/d.xlsx", kind: "xlsx", download_name: "قديم - ١٠ - ٣ نوفمبر ٢٠٢٦.xlsx" }]))?.titleAr).toBe(title);
        expect(methodologyMissionOf(row([{ name: "d.xlsx", path: "p/d.xlsx", kind: "xlsx", download_name: `${title.replace(DATE_AR, "٥ نوفمبر ٢٠٢٦")}.xlsx` }]))?.titleAr).toBe(title.replace(DATE_AR, "٥ نوفمبر ٢٠٢٦"));
      });
      it("the parent count is the parent stage's, not the total", () => {
        const noun = { videos: "فيديوهات", tweets: "تغريدات", posts: "منشورات" }[m.stages[0].key as "videos"]!;
        expect(title.startsWith(`${countPhraseAr(parentOf(m), noun)} مع `)).toBe(true);
      });
    });
  }
});

describe("one rule for the name of a stored file: Excel download and methodology agree, for old stored names too", () => {
  const stages = [stage("videos", "الفيديوهات", 2, null), stage("comments", "التعليقات", 40, "videos")];
  const plan = { stages };
  it("the current form is recognised; the older forms (a bare count between the parts) are not", () => {
    expect(isCurrentTitleForm("فيديوهان مع التعليقات عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦")).toBe(true);
    expect(isCurrentTitleForm("تغريدات عن رأي الناس - ١٠ - ٤ نوفمبر ٢٠٢٦")).toBe(false);
    expect(isCurrentTitleForm("result")).toBe(false);
  });
  it("an old stored name is replaced by the current form in the download, as in the methodology list (same date: the mission's last update)", () => {
    const files = [{ kind: "xlsx", name: "x.xlsx", download_name: "فيديوهات عن الذكاء الاصطناعي - ٤٢ - ٣ نوفمبر ٢٠٢٦.xlsx" }];
    const name = missionDownloadName({ files, kind: "xlsx", plan, requestText: "فيديوهين عن الذكاء الاصطناعي مع التعليقات", deliveredUnits: 42, date: DATE });
    expect(name).toBe(`فيديوهان مع التعليقات عن الذكاء الاصطناعي - ${DATE_AR}.xlsx`);
    const m = methodologyMissionOf({ id: "m", job_id: "j", status: "completed", delivered_units: 42, request_text: "فيديوهين عن الذكاء الاصطناعي مع التعليقات", plan_public: { compiled: true, stages }, files: [{ ...files[0], path: "p/x.xlsx" }], created_at: "2026-11-03T10:00:00.000Z", updated_at: DATE.toISOString() });
    expect(`${m?.titleAr}.xlsx`).toBe(name);
  });
  it("a stored name in the current form is the name of both", () => {
    const stored = "فيديوهان مع التعليقات عن الذكاء الاصطناعي - ٥ نوفمبر ٢٠٢٦";
    const files = [{ kind: "xlsx", name: "x.xlsx", download_name: `${stored}.xlsx` }];
    expect(missionDownloadName({ files, kind: "xlsx", plan, requestText: "x", deliveredUnits: 42, date: DATE })).toBe(`${stored}.xlsx`);
    expect(methodologyMissionOf({ id: "m", job_id: "j", status: "completed", delivered_units: 42, request_text: "x", plan_public: { compiled: true, stages }, files: [{ ...files[0], path: "p/x.xlsx" }], created_at: DATE.toISOString(), updated_at: DATE.toISOString() })?.titleAr).toBe(stored);
  });
});
