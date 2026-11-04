import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { missionDownloadName, missionFileTitleAr } from "../src/lib/agentMission/fileNames";
import { methodologyMissionOf } from "../src/lib/agentMission/methodology/missions";

/**
 * ROUND 26, item 8, on the STORED live missions of every platform (tests/fixtures/live/replay-missions.json: TikTok, X, Facebook, Instagram, YouTube; the requests and the stages are stored values).
 * The Excel name, the methodology title and the chooser card's title (the same `methodologyMissionOf` title) are all «<count with its noun> عن <subject> - <date>»:
 * never «رأي الناس» as a subject, never a bare count between the parts, the same words in all three.
 * The stage titles are the ones the compiler gives (compilePlan.ts: PARENT_TITLE, «التعليقات», «الردود»); a compiled plan carries no `relevance`, so the subject is read from the request.
 */
type Fx = { id: string; request: string; stages: Array<{ key: string; planned: number; endpoint_id: string; parent_key: string | null }> };
const missions = (JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Fx[] }).missions;
const TITLES: Record<string, string> = { posts: "المنشورات", videos: "الفيديوهات", tweets: "التغريدات", comments: "التعليقات", comments_replies: "الردود", replies: "الردود" };
const DATE = new Date(Date.UTC(2026, 10, 4, 12));
const DATE_AR = "٤ نوفمبر ٢٠٢٦";
const platformOf = (m: Fx) => (/tiktok/.test(m.stages[0].endpoint_id) ? "tiktok" : /youtube/.test(m.stages[0].endpoint_id) ? "youtube" : /instagram/.test(m.stages[0].endpoint_id) ? "instagram" : /facebook/.test(m.stages[0].endpoint_id) ? "facebook" : "x");
const stagesOf = (m: Fx) => m.stages.map((s) => ({ key: s.key, title_ar: TITLES[s.key], expected_rows: s.planned, deliver: true }));
const deliveredOf = (m: Fx) => m.stages.reduce((n, s) => n + s.planned, 0);
const NEW_FORM = new RegExp(`^(?:[٠-٩]+ \\S+|\\S+ واحد|\\S+ واحدة|\\S+ان|\\S+تان) عن \\S.* - ${DATE_AR}$`);

describe("ROUND 26 item 8: the stored live missions of every platform", () => {
  it("the fixture covers the five platforms", () => {
    expect(new Set(missions.map(platformOf))).toEqual(new Set(["tiktok", "youtube", "instagram", "facebook", "x"]));
  });
  for (const m of missions) {
    describe(`${platformOf(m)} ${m.id.slice(0, 12)}`, () => {
      const title = missionFileTitleAr({ plan: { stages: stagesOf(m) }, requestText: m.request, delivered: deliveredOf(m), date: DATE });
      it("the Excel name is «count with its noun + عن + subject - date»", () => {
        expect(title).toMatch(NEW_FORM);
        expect(title).not.toContain("رأي الناس");
        expect(title).not.toMatch(/^[٠-٩]+ -/);
        expect(title).not.toMatch(/ - [٠-٩]+ - /);
        const name = missionDownloadName({ files: [], kind: "xlsx", plan: { stages: stagesOf(m) }, requestText: m.request, deliveredUnits: deliveredOf(m), date: DATE });
        expect(name).toBe(`${title}.xlsx`);
      });
      it("the methodology title and the chooser card carry the same words, from the delivered count", () => {
        const mission = methodologyMissionOf({
          id: m.id, job_id: "job_x", status: "completed", delivered_units: deliveredOf(m), request_text: m.request,
          plan_public: { compiled: true, stages: stagesOf(m) },
          files: [{ name: "data.xlsx", path: `${m.id}/data.xlsx`, kind: "xlsx", download_name: "نتائج قديمة - ١٠ - ٣ نوفمبر ٢٠٢٦.xlsx" }],
          created_at: DATE.toISOString(),
        });
        expect(mission?.titleAr).toBe(title);
      });
    });
  }
  it("a stored name that is already in the current form is the very name of the Excel file (same words, same date, even across midnight)", () => {
    const m = missions[4];
    const stored = "٢٠ تغريدة عن العاصمة الإدارية - ٥ نوفمبر ٢٠٢٦";
    const mission = methodologyMissionOf({ id: m.id, job_id: "job_x", status: "completed", delivered_units: 20, request_text: m.request, plan_public: { compiled: true, stages: stagesOf(m) }, files: [{ name: "data.xlsx", path: "p/data.xlsx", kind: "xlsx", download_name: `${stored}.xlsx` }], created_at: "2026-11-04T23:50:00.000Z" });
    expect(mission?.titleAr).toBe(stored);
  });
  it("the live request that produced «تغريدات عن رأي الناس - ١٠» (an opinion request, 10 tweets) is «١٠ تغريدات عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦»", () => {
    const stages = [{ key: "tweets", title_ar: "التغريدات", expected_rows: 10, deliver: true }];
    expect(missionFileTitleAr({ plan: { stages }, requestText: "عايز داتا عن رأي الناس في الذكاء الاصطناعي", delivered: 10, date: DATE })).toBe(`١٠ تغريدات عن الذكاء الاصطناعي - ${DATE_AR}`);
  });
  it("a request that names its subject in quotes with no «عن» still has its subject", () => {
    const stages = [{ key: "tweets", title_ar: "التغريدات", expected_rows: 20, deliver: true }];
    expect(missionFileTitleAr({ plan: { stages }, requestText: "هات ٢٠ تغريدة على X فيها \"العاصمة الإدارية\" بالعربي في شهر أكتوبر ٢٠٢٦", delivered: 20, date: DATE })).toBe(`٢٠ تغريدة عن العاصمة الإدارية - ${DATE_AR}`);
  });
});
