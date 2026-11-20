import { describe, expect, it } from "vitest";
import { AGENT_PLANNING_WALL_MS } from "../src/lib/agentMission/constants";
import { companyRuleTerms, sectorWordsOf } from "../src/lib/agentMission/entities";
import { missionTitleAr } from "../src/lib/agentMission/fileNames";
import { itemNounFromCapability } from "../src/lib/agentMission/itemNoun";
import { buildMissionNotice, noticeTitleAr, type MissionNoticeKind } from "../src/lib/agentMission/notices";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { renderEmailTemplate } from "../supabase/functions/send-email/templates";

describe("DT-20261120-emails: fail-first regression suite (#1 title typo, #10 unit noun, failure email + timing)", () => {
  it("#1: sectorWordsOf preserves Arabic root letters (و/ب/ل/ف) like برمجيات/فنادق/بلاستيك/لوجستيات/وكالات and fixes 2-company title", () => {
    expect(sectorWordsOf("عايز شركتين برمجيات في مصر ومدير كل شركة")).toEqual(["برمجيات"]);
    expect(sectorWordsOf("عايز شركات فنادق وبلاستيك ولوجستيات ووكالات")).toEqual(["فنادق", "وبلاستيك", "ولوجستيات", "ووكالات"]);
    expect(sectorWordsOf("شركات في قطاع بالبرمجيات للتسويق والكهروميكانيكا")).toEqual(["البرمجيات", "تسويق", "الكهروميكانيكا"]);

    const terms = companyRuleTerms(["شركات", "software"], "عايز شركتين برمجيات في مصر ومدير كل شركة");
    expect(terms).toContain("برمجيات");
    expect(terms).not.toContain("رمجيات");

    const plan = {
      stages: [
        {
          key: "companies",
          deliver: true,
          parent_key: null,
          expected_rows: 2,
          title_ar: "شركات برمجيات في مصر",
          relevance: { terms, subject_ar: "شركات برمجيات في مصر", entity: true },
        },
        { key: "people", deliver: true, parent_key: "companies", expected_rows: 2, title_ar: "مدير كل شركة" },
      ],
    };
    const title = missionTitleAr({ plan, requestText: "عايز شركتين برمجيات في مصر ومدير كل شركة", parentDelivered: 2 });
    expect(title).toBe("شركتان برمجيات");
    const notice = buildMissionNotice("completed", {
      delivered: 4,
      planned: 4,
      chargedPoints: 276,
      releasedPoints: 0,
      reservedPoints: 276,
      hasJob: true,
      stages: [
        { titleAr: "شركات برمجيات في مصر", delivered: 2, planned: 2, parentKey: null },
        { titleAr: "مدير كل شركة", delivered: 2, planned: 2, parentKey: "companies", isPeople: true },
      ],
    }, title);
    expect(notice.email!.subject).toBe("شركتان برمجيات — النتائج جاهزة");
    expect(notice.email!.heading).toBe("ملفات «شركتان برمجيات» جاهزة للتحميل");
  });

  it("#10: comments partial (parent videos not delivered, child comments delivered) says «تعليق», never «جهة تواصل»", () => {
    const notice = buildMissionNotice(
      "partial",
      {
        delivered: 18,
        planned: 300,
        chargedPoints: 126,
        releasedPoints: 2275,
        reservedPoints: 2401,
        noun: "تعليق",
        hasJob: true,
        shortfallClauseAr: "لأن بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو",
        stages: [
          {
            titleAr: "تعليقات كل فيديو",
            delivered: 18,
            planned: 300,
            parentKey: "videos",
            isPeople: false,
            isContacts: false,
            capability: "youtube.video.comments",
            platform: "youtube",
          },
        ],
      },
      "٣٠٠ تعليق عن أسعار الذهب",
    );
    const joined = [notice.email!.preheader, notice.email!.lead, notice.body].join(" ");
    expect(joined).toContain("١٨");
    expect(joined).toContain("تعليق");
    expect(joined).not.toContain("جهة تواصل");
    expect(joined).not.toContain("جهات تواصل");
  });

  it("#10: catalog capability metadata resolves real item type for comments, posts, videos, companies, people, and contacts", () => {
    expect(itemNounFromCapability("youtube.video.comments", "youtube")?.singular).toBe("تعليق");
    expect(itemNounFromCapability("x.search.posts", "x")?.singular).toBe("منشور");
    expect(itemNounFromCapability("youtube.search.videos", "youtube")?.singular).toBe("فيديو");
    expect(itemNounFromCapability("companies.search", "companies")?.singular).toBe("شركة");

    const postsNotice = buildMissionNotice(
      "partial",
      {
        delivered: 12,
        planned: 50,
        chargedPoints: 200,
        releasedPoints: 300,
        reservedPoints: 500,
        hasJob: true,
        stages: [
          { titleAr: "نتائج الصفحة", delivered: 12, planned: 50, parentKey: null, isContacts: false, capability: "facebook.page.posts", platform: "facebook" },
        ],
      },
      "٥٠ منشور من فودافون مصر",
    );
    expect(postsNotice.email!.lead).toContain("منشور");
    expect(postsNotice.email!.lead).not.toContain("جهة تواصل");

    const videosNotice = buildMissionNotice(
      "completed",
      {
        delivered: 20,
        planned: 20,
        chargedPoints: 200,
        releasedPoints: 0,
        reservedPoints: 200,
        hasJob: true,
        stages: [
          { titleAr: "نتائج البحث", delivered: 20, planned: 20, parentKey: null, isContacts: false, capability: "youtube.search.videos", platform: "youtube" },
        ],
      },
      "٢٠ فيديو عن أسعار الذهب",
    );
    expect(videosNotice.email!.detail1).toContain("٢٠ فيديو");

    const companiesNotice = buildMissionNotice(
      "completed",
      {
        delivered: 10,
        planned: 10,
        chargedPoints: 200,
        releasedPoints: 0,
        reservedPoints: 200,
        hasJob: true,
        stages: [
          { titleAr: "شركات تسويق في القاهرة", delivered: 10, planned: 10, parentKey: null, isContacts: false, capability: "companies.search", platform: "companies" },
        ],
      },
      "١٠ شركات تسويق",
    );
    expect(companiesNotice.email!.detail1).toBe("خُصم ٢٠٠ نقطة مقابل ١٠ شركات.");

    const managersNotice = buildMissionNotice(
      "partial",
      {
        delivered: 183,
        planned: 200,
        chargedPoints: 9200,
        releasedPoints: 1300,
        reservedPoints: 10500,
        hasJob: true,
        stages: [
          { titleAr: "شركات مقاولات في الرياض", delivered: 100, planned: 100, parentKey: null },
          { titleAr: "مدير كل شركة", delivered: 83, planned: 100, parentKey: "companies", isPeople: true },
        ],
      },
      "١٠٠ شركة مقاولات في الرياض",
    );
    expect(managersNotice.email!.lead).toContain("١٠٠ شركة و٨٣ مديرًا من أصل ١٠٠ مدير");
  });

  it("Backlog #2: failure e-mail lead is ONE clear Arabic sentence + charge line in DetailOne, and AGENT_PLANNING_WALL_MS remains 20 min", () => {
    const cases: Array<[MissionNoticeKind, Record<string, unknown>]> = [
      ["failed", { cause: "internal", delivered: 0, planned: 5, chargedPoints: 0, releasedPoints: 200, reservedPoints: 200, hasJob: true }],
      ["failed", { delivered: 0, planned: 5, chargedPoints: 0, releasedPoints: 200, reservedPoints: 200, hasJob: true }],
      ["unserved", { cause: "empty", delivered: 0, planned: 5, chargedPoints: 0, releasedPoints: 200, reservedPoints: 200, hasJob: true }],
      ["unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false }],
    ];
    for (const [kind, facts] of cases) {
      const n = buildMissionNotice(kind, facts as any, "مهمتك");
      const e = n.email!;
      // Single sentence: no mid-string period followed by another sentence
      expect(e.lead).not.toMatch(/\.[^\n]*\S/);
      expect(e.lead.endsWith(".")).toBe(true);
      expect(e.detail1).toMatch(/لم يُخصم شيء|لم يُحجز أي رصيد/);
      expect(checkCustomerText(e.lead, { maxChars: 300 }).issues, e.lead).toEqual([]);
      expect(e.lead).not.toMatch(/خلل|خطأ داخلي|endpoint|provider|job_id|msn_|[A-Za-z0-9]/);
    }
    expect(AGENT_PLANNING_WALL_MS).toBe(20 * 60_000);
    expect(noticeTitleAr({ plan: null, requestText: "طلب فشل" })).toBe("مهمتك");
  });

  it("Counter-case: welcome and job-update Edge Function templates keep their layout unchanged", () => {
    const w = renderEmailTemplate("welcome", { Name: "أحمد" });
    expect(w.subject).toContain("ديجر");
    expect(w.html).toContain('dir="rtl"');
    const j = renderEmailTemplate("job-update", {
      Name: "أحمد",
      Subject: "عنوان",
      Preheader: "ملخص",
      Heading: "رأس",
      Lead: "جملة واحدة.",
      DetailOne: "لم يُحجز أي رصيد ولم يُخصم شيء.",
      DetailTwo: "",
      ButtonLabel: "افتح طلبك",
      JobURL: "https://diger.tech/dashboard/requests",
    });
    expect(j.html).toContain("جملة واحدة.");
    expect(j.html).toContain("لم يُحجز أي رصيد ولم يُخصم شيء.");
  });
});
