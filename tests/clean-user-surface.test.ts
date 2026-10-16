import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { UNVERIFIED_PLATFORM_MESSAGE_AR } from "../src/functions/shared/capabilityRegistry";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { LlmClient } from "../src/functions/shared/llmClient";

describe("Task 4: Clean User Surface & Card Redesign", () => {
  it("1. Landing page contains no availability or pending preparation badges", () => {
    const landing = ["src/app/page.tsx", "src/components/landing/Sections.tsx", "src/components/landing/HeroLens.tsx", "src/components/landing/data.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
    expect(landing).not.toContain("قيد التجهيز");
    expect(landing).not.toContain("متاح الآن");
    expect(landing).not.toContain("طلب تفعيل");
    expect(landing).not.toContain("الكتالوج");
  });

  it("2. Chat page contains no 'طلب تفعيل خدمة' buttons or unsupported platform cards", () => {
    const chatPage = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chatPage).not.toContain("طلب تفعيل");
    expect(chatPage).not.toContain("قيد التجهيز");
    expect(chatPage).not.toContain("قريبًا — يمكنك تسجيل رغبتك");
  });

  it("3. PlanQuoteCard contains no badges, warning alerts, or technical notes", () => {
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card).not.toContain("<Badge");
    expect(card).not.toContain("<Stamp");
    expect(card).not.toContain("<Alert");
    expect(card).not.toContain("منهجية الجمع");
    expect(card).not.toContain("قيد التجهيز");
    expect(card).not.toContain("الكتالوج");
    // Verifies primary "أوافق وابدأ البحث" button and secondary "تعديل" button
    expect(card).toContain("أوافق وابدأ البحث");
    expect(card).toContain('"تعديل"');
    // Verifies RTL and plain language steps (what, from where, how many)
    expect(card).toContain('dir="rtl"');
    expect(card).toContain("أوافق وابدأ البحث");
  });

  it("PlanQuoteCard describes people fields as present or absent without claiming verification", () => {
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card).toContain("موجودًا أو غير موجود في السجل");
    expect(card).toContain("وجود البريد لا يعني التحقق من صحته");
    expect(card).not.toContain("متحقق / غير متاح");
    expect(card).not.toContain("حالة التحقق لكل حقل");
  });

  it("people result columns use presence wording instead of verification claims", () => {
    const results = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
    expect(results).toContain('email_verification_status: "توفر البريد"');
    expect(results).toContain('title_verification_status: "توفر المسمى الوظيفي"');
    expect(results).toContain('verification_status: "الحالة المسجلة"');
    expect(results).not.toContain('verification_status: "حالة التحقق"');
  });

  it("keeps visible starter, attachment, and format copy in Arabic", () => {
    const emptyChat = readFileSync("src/app/dashboard/chat/components/EmptyChat.tsx", "utf8");
    const composer = readFileSync("src/app/dashboard/chat/components/Composer.tsx", "utf8");
    const results = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");

    expect(emptyChat).toContain("شركات ومؤسسات (إكسل)");
    expect(emptyChat).toContain("ابحث لي عن ٥ شركات");
    expect(emptyChat).not.toContain("Excel");
    expect(composer).toContain('aria-label="رفع ملف استبعاد بصيغة إكسل أو سي إس في"');
    expect(composer).toContain("ملفات بي دي إف والمستندات المصورة غير مدعومة حاليًا");
    expect(composer).not.toContain("جداول البيانات Excel");
    expect(results).toContain("تقرير نتائج جمع البيانات (بي دي إف)");
    expect(results).toContain('label: "إكسل"');
    expect(results).toContain('label: "سي إس في"');
    expect(results).not.toContain("ملف Excel");
    expect(results).not.toContain("تقرير PDF");
  });

  it("4. The details sentence has no counters, progress bar or badges", () => {
    const discovery = readFileSync("src/app/dashboard/chat/components/DetailsBlanks.tsx", "utf8");
    expect(discovery).not.toContain("answeredCount");
    expect(discovery).not.toContain("<Badge");
  });

  it("5. Plan validation errors in planManager contain no 'معطلة في الكتالوج' or technical slugs", () => {
    const planManager = readFileSync("src/functions/shared/planManager.ts", "utf8");
    expect(planManager).not.toContain("غير متوفرة أو معطلة في الكتالوج");
  });

  it("6. UNVERIFIED_PLATFORM_MESSAGE_AR is a natural Arabic sentence without banned phrases", () => {
    expect(UNVERIFIED_PLATFORM_MESSAGE_AR).toBe("هتحقق من الطلب وأرجعلك");
    expect(UNVERIFIED_PLATFORM_MESSAGE_AR).not.toContain("قيد التجهيز");
    expect(UNVERIFIED_PLATFORM_MESSAGE_AR).not.toContain("الكتالوج");
  });

  it("7. ChatHandler returns clean natural Arabic sentence on unsupported/mismatched platform", async () => {
    vi.spyOn(LlmClient.prototype, "executeTurn").mockResolvedValue({
      output: {
        type: "propose_plan",
        summaryAr: "استخراج حساب تيك توك",
        capabilities: [
          {
            capabilitySlug: "tiktok-profile",
            params: { username: "someuser" },
            targetVolumeMin: 1,
            targetVolumeMax: 1,
          },
        ],
        outputFormats: ["xlsx", "pdf", "csv"],
        methodologyNotes: "ملاحظات المنهجية",
      },
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0001,
      model: "claude-haiku-5-5",
    });

    const mockTables: any = {
      listRows: vi.fn().mockResolvedValue({ rows: [] }),
      getRow: vi.fn().mockResolvedValue({
        $id: "user-1",
        accountBalance: 100,
        email: "test@example.com",
        name: "Test",
      }),
      createRow: vi.fn().mockResolvedValue({ $id: "msg-1" }),
      updateRow: vi.fn().mockResolvedValue({ $id: "msg-1" }),
    };

    const handler = new ChatHandler(mockTables);
    const result = await handler.handleUserMessage({
      userId: "user-1",
      conversationId: "conv-clean-test",
      message: "عايز بيانات من سناب شات",
      userBalance: 100,
    });

    expect(result.contentAr).toContain("هتحقق من الطلب وأرجعلك");
    expect(result.contentAr).not.toContain("قيد التجهيز");
    expect(result.contentAr).not.toContain("الكتالوج");
    expect(result.contentAr).not.toContain("طلب تفعيل");
  });
});
