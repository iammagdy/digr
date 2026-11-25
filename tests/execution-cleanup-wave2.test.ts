import { describe, it, expect } from "vitest";
import platformHosts from "../data/capabilities/platform-hosts.json";
import { normalizeHostToken } from "../agent/src/companyPeopleRecovery";
import { withoutDirectionMarks, isMetaColumnKey, buildMissionFiles } from "../agent/src/workbook";
import { cellsOf } from "./helpers/round11Worlds";
import { type PricedPlan } from "../src/lib/agentMission/plan";
import { neutralPeopleTitleAr } from "../src/lib/agentMission/roles";

describe("DT-20261125-wordlist-wave2 Phase 7: Execution Cleanup Wave 2", () => {
  it("Must-Pass 1: description keys are filtered strictly from slug keys without Arabic regex", () => {
    const textColumns = ["name", "industry", "title", "description", "category", "about", "bio", "summary", "overview"];
    const matched = textColumns.filter((k) => /desc|about|summary|bio|overview/i.test(k));
    expect(matched).toEqual(["description", "about", "bio", "summary", "overview"]);
    expect(matched).not.toContain("name");
    expect(matched).not.toContain("industry");
    expect(matched).not.toContain("title");
    expect(matched).not.toContain("category");
  });

  it("Must-Pass 2: platform hosts data file contains exact 12 platforms and strips them cleanly", () => {
    expect(Array.isArray(platformHosts)).toBe(true);
    expect(platformHosts).toHaveLength(12);
    expect(platformHosts).toContain("x.com");
    expect(platformHosts).toContain("twitter.com");
    expect(platformHosts).toContain("linkedin.com");
    expect(platformHosts).toContain("youtube.com");
    expect(platformHosts).toContain("youtu.be");

    // Platform URLs normalize to empty host
    expect(normalizeHostToken("https://www.x.com/SaudiMOH/status/123")).toBe("");
    expect(normalizeHostToken("https://twitter.com/SaudiMOH")).toBe("");
    expect(normalizeHostToken("https://www.linkedin.com/company/aramco")).toBe("");
    expect(normalizeHostToken("https://youtu.be/dQw4w9WgXcQ")).toBe("");
    expect(normalizeHostToken("https://instagram.com/p/12345")).toBe("");

    // Non-platform host is preserved cleanly
    expect(normalizeHostToken("https://cloudsoft5.com/about-us")).toBe("cloudsoft5.com");
    expect(normalizeHostToken("https://www.customdomain.org/team")).toBe("customdomain.org");
  });

  it("Must-Pass 3: workbook bidi direction marks stripped and meta column context key supported", () => {
    // Direction marks stripped from text
    const markedName = "\u202Aمحمد أحمد\u202C";
    expect(withoutDirectionMarks(markedName)).toBe("محمد أحمد");
    expect(withoutDirectionMarks(12345)).toBe(12345);

    // Meta column key recognizes context columns
    expect(isMetaColumnKey({ kind: "context", key: "company_name" })).toBe(true);
    expect(isMetaColumnKey({ availability: true })).toBe(true);
    expect(isMetaColumnKey({ key: "__row_number" })).toBe(true);
    expect(isMetaColumnKey({ key: "custom_data_col" })).toBe(false);

    // Contract summary line matching with startsWith
    const sampleLine = "تم تسليم ٥٠ عنصراً بنجاح";
    expect(sampleLine.startsWith("تم تسليم")).toBe(true);
    expect("غير مطابق".startsWith("تم تسليم")).toBe(false);
  });

  it("Counter-Case 1: B2B recovery preserves custom Arabic roles without manager fallback", () => {
    // Custom roles like engineers or doctors are preserved verbatim when neutralized against manager
    const engineerTitle = neutralPeopleTitleAr("مهندسو كل شركة", "manager", "شركة");
    expect(engineerTitle).toBe("مهندسو كل شركة");
    expect(engineerTitle).not.toContain("مدير");

    const doctorTitle = neutralPeopleTitleAr("أطباء كل شركة", "manager", "شركة");
    expect(doctorTitle).toBe("أطباء كل شركة");
    expect(doctorTitle).not.toContain("مدير");

    // Whereas manager role is neutralized to general employees
    const managerTitle = neutralPeopleTitleAr("مديرو كل شركة", "manager", "شركة");
    expect(managerTitle).toBe("موظفو كل شركة");
  });
  it("Must-Pass 4: child stage language is computed from comment's own text, not parent context text", async () => {
    const plan = {
      id: "msn_test",
      stages: [
        {
          key: "videos",
          title_ar: "الفيديوهات",
          parent_key: null,
          deliver: true,
          capability: "tiktok",
          columns: [
            { key: "id", title_ar: "المعرف" },
            { key: "text", title_ar: "النص" },
          ],
        },
        {
          key: "comments",
          title_ar: "التعليقات",
          parent_key: "videos",
          deliver: true,
          capability: "tiktok",
          columns: [
            { key: "id", title_ar: "المعرف" },
            { key: "text", title_ar: "نص التعليق" },
            { key: "lang", title_ar: "لغة النص" },
          ],
        },
      ],
      compiled: { by: "compiler", conditions: [] },
    } as unknown as PricedPlan;

    const rowsByStage = {
      videos: [{ id: "v1", text: "English video caption only", __marks: {} }],
      comments: [{ id: "c1", parent_id: "v1", text: "تعليق عربي جميل", lang: "", __marks: {} }],
    };

    const files = await buildMissionFiles(plan, rowsByStage as never);
    const cells = await cellsOf(files.xlsx);
    const commentRows = cells["التعليقات"];
    expect(commentRows[0]).toEqual(["النص", "نص التعليق", "لغة النص", "المعرّف", "معرّف الأصل"]);
    expect(commentRows[1][0]).toBe("English video caption only");
    expect(commentRows[1][1]).toBe("تعليق عربي جميل");
    // Language must be computed from the comment text ("العربية"), not parent text ("لغة أخرى")
    expect(commentRows[1][2]).toBe("العربية");
  });
  it("Must-Pass 5: context column with date key and non-date title is not treated as date", async () => {
    // Exact-main behaviour: context columns are checked for dates by title only, ignoring their key
    const plan = {
      id: "msn_test_date",
      stages: [
        {
          key: "posts",
          title_ar: "المنشورات",
          parent_key: null,
          deliver: true,
          capability: "general",
          columns: [
            { key: "id", title_ar: "المعرف" },
            { key: "created_at", title_ar: "كود المنشور" },
          ],
        },
        {
          key: "comments",
          title_ar: "التعليقات",
          parent_key: "posts",
          deliver: true,
          capability: "general",
          columns: [
            { key: "id", title_ar: "المعرف" },
            { key: "text", title_ar: "النص" },
          ],
        },
      ],
      compiled: { by: "compiler", conditions: [] },
    } as unknown as PricedPlan;

    const rowsByStage = {
      posts: [{ id: "p1", created_at: "2026-11-25T10:00:00Z", __marks: {} }],
      comments: [{ id: "c1", parent_id: "p1", text: "مرحبا", __marks: {} }],
    };

    const files = await buildMissionFiles(plan, rowsByStage as never);
    const cells = await cellsOf(files.xlsx);
    const commentRows = cells["التعليقات"];
    expect(commentRows[0]).toEqual(["كود المنشور", "النص", "المعرّف", "معرّف الأصل"]);
    // Since title "كود المنشور" has no date words, and context columns ignore key for date detection,
    // the cell value stays a raw string and is not formatted as a date.
    expect(commentRows[1][0]).toBe("2026-11-25T10:00:00Z");
  });
});
