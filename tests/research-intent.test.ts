import { describe, it, expect } from "vitest";
import {
  extractResearchIntent,
  extractSampleSize,
  extractEntityType,
  extractGeographicScope,
  formatIntentForSystemPrompt,
  ResearchIntentSchema,
} from "../src/lib/server/researchIntent";

describe("Research Intent & Provenance Engine", () => {
  it("extracts explicit sample size from Egyptian Arabic digits and text", () => {
    const res1 = extractSampleSize("عايز 50 شركة مقاولات كهروميكانيكية في مصر");
    expect(res1.count).toBe(50);
    expect(res1.provenance).toBe("EXPLICIT");

    const res2 = extractSampleSize("استخرج ٥٠٠ تعليق من فيسبوك");
    expect(res2.count).toBe(500);
    expect(res2.provenance).toBe("EXPLICIT");

    const res3 = extractSampleSize("ابحث في المنشورات بدون تحديد عدد");
    expect(res3.count).toBeUndefined();
    expect(res3.provenance).toBe("UNKNOWN");
  });

  it("extracts entity types accurately", () => {
    expect(extractEntityType("بيانات شركات المقاولات والتوريدات").entityType).toBe("companies");
    expect(extractEntityType("تعليقات الجمهور على بوستات فيسبوك").entityType).toBe("comments");
    expect(extractEntityType("مقاطع فيديو يوتيوب عن التحول الرقمي").entityType).toBe("videos");
    expect(extractEntityType("تغريدات ومنشورات عن الذهب").entityType).toBe("posts");
  });

  it("extracts geographic scope with high confidence", () => {
    const egypt = extractGeographicScope("شركات المقاولات في مصر والقاهرة");
    expect(egypt.scope).toBe("مصر");
    expect(egypt.provenance).toBe("EXPLICIT");

    const ksa = extractGeographicScope("مشاريع البنية التحتية في السعودية والرياض");
    expect(ksa.scope).toBe("المملكة العربية السعودية");
    expect(ksa.provenance).toBe("EXPLICIT");

    const none = extractGeographicScope("بحث عام عن الذكاء الاصطناعي");
    expect(none.provenance).toBe("UNKNOWN");
  });

  it("builds a fully validated ResearchIntentSpec with provenance tracking", () => {
    const userMessage = "أريد حصر 50 شركة مقاولات كهروميكانيكية (MEP) في مصر غير الشركات الموجودة في الملف المرفق مع استخراج شيت إكسل وملف PDF";
    const uploadedFiles = [
      {
        fileId: "file_123",
        fileName: "excluded_contractors.xlsx",
        fileType: "xlsx" as const,
        purpose: "exclusion_list" as const,
      },
    ];

    const intent = extractResearchIntent(userMessage, undefined, uploadedFiles);

    // Validate with Zod
    const validated = ResearchIntentSchema.parse(intent);
    expect(validated).toBeDefined();

    expect(intent.topic.value).toContain("مقاولات كهروميكانيكية");
    expect(intent.topic.provenance).toBe("EXPLICIT");
    expect(intent.sampleSize.value).toBe(50);
    expect(intent.sampleSize.provenance).toBe("EXPLICIT");
    expect(intent.entityType.value).toBe("companies");
    expect(intent.geographicScope.value).toBe("مصر");
    expect(intent.outputTypes.value).toContain("xlsx");
    expect(intent.outputTypes.value).toContain("pdf");
    expect(intent.userExclusions.value.hasExclusionReference).toBe(true);
    expect(intent.userExclusions.value.fileReferences.length).toBe(1);

    const promptText = formatIntentForSystemPrompt(intent);
    expect(promptText).toContain("مقاولات كهروميكانيكية");
    expect(promptText).toContain("50");
  });

  it("detects when an exclusion file is referenced in text but not uploaded", () => {
    const userMessage = "أريد 30 شركة طاقة متجددة بدون الشركات المسجلة في شيت الاستبعاد المرفق";
    const intent = extractResearchIntent(userMessage, undefined, []);

    expect(intent.userExclusions.value.hasExclusionReference).toBe(true);
    expect(intent.userExclusions.value.fileReferences.length).toBe(0);
  });
});
