import { describe, expect, it } from "vitest";
import { missionFileTitleAr, missionTitleAr, missionDownloadName } from "../src/lib/agentMission/fileNames";

/**
 * ROUND 26, item 8: titles are built from the Ask: the count with its noun and the SUBJECT, not the opinion phrase.
 * Live: «تغريدات عن رأي الناس - ١٠ - ٤ نوفمبر ٢٠٢٦» (wrong subject, bare count). It must be «١٠ تغريدات عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦».
 */
const DATE = new Date(Date.UTC(2026, 10, 4, 12));
const stage = (title: string, rows: number, extra: Record<string, unknown> = {}) => ({ key: "s1", title_ar: title, expected_rows: rows, deliver: true, ...extra });
const plan = (title: string, rows: number) => ({ stages: [stage(title, rows)] });

describe("ROUND 26 item 8: the file title", () => {
  it("the opinion phrase is not the subject: «١٠ تغريدات عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦»", () => {
    expect(missionFileTitleAr({ plan: plan("التغريدات", 10), requestText: "عايز داتا عن رأي الناس في الذكاء الاصطناعي", delivered: 10, date: DATE }))
      .toBe("١٠ تغريدات عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦");
  });
  it("the count takes its noun: 1, 2, 3, 11", () => {
    const p = plan("التغريدات", 1);
    expect(missionFileTitleAr({ plan: p, requestText: "عن الذكاء الاصطناعي", delivered: 1, date: DATE })).toMatch(/^تغريدة واحدة عن الذكاء الاصطناعي - /);
    expect(missionFileTitleAr({ plan: plan("التغريدات", 2), requestText: "عن الذكاء الاصطناعي", delivered: 2, date: DATE })).toMatch(/^تغريدتان عن/);
    expect(missionFileTitleAr({ plan: plan("التغريدات", 3), requestText: "عن الذكاء الاصطناعي", delivered: 3, date: DATE })).toMatch(/^٣ تغريدات عن/);
    expect(missionFileTitleAr({ plan: plan("التغريدات", 11), requestText: "عن الذكاء الاصطناعي", delivered: 11, date: DATE })).toMatch(/^١١ تغريدة عن/);
  });
  it("a plain «عن» subject is unchanged", () => {
    expect(missionFileTitleAr({ plan: plan("التغريدات", 300), requestText: "هات ٣٠٠ تغريدة عن محمد صلاح", delivered: 300, date: DATE })).toBe("٣٠٠ تغريدة عن محمد صلاح - ٤ نوفمبر ٢٠٢٦");
  });
  it("for every platform: the noun of the platform's posts (فيديو، منشور)", () => {
    expect(missionFileTitleAr({ plan: plan("الفيديوهات", 10), requestText: "عن الذكاء الاصطناعي من يوتيوب", delivered: 10, date: DATE })).toMatch(/^١٠ فيديوهات عن/);
    expect(missionFileTitleAr({ plan: plan("المنشورات", 10), requestText: "عن الذكاء الاصطناعي من إنستجرام", delivered: 10, date: DATE })).toMatch(/^١٠ منشورات عن/);
  });
  it("the same title is the download name (the Excel file), with its extension", () => {
    const name = missionDownloadName({ files: [], kind: "xlsx", plan: plan("التغريدات", 10), requestText: "عايز داتا عن رأي الناس في الذكاء الاصطناعي", deliveredUnits: 10, date: DATE });
    expect(name).toBe("١٠ تغريدات عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦.xlsx");
  });
});

describe("ROUND 26 item 8: the mission title (methodology, chooser card, notices)", () => {
  it("carries the count with its noun and the subject", () => {
    expect(missionTitleAr({ plan: plan("التغريدات", 10), requestText: "عايز داتا عن رأي الناس في الذكاء الاصطناعي" })).toBe("١٠ تغريدات عن الذكاء الاصطناعي");
  });
  it("never a bare count", () => {
    expect(missionTitleAr({ plan: plan("التغريدات", 10), requestText: "عن الذكاء الاصطناعي" })).not.toMatch(/^[٠-٩]+ -/);
  });
});
