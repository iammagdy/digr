import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { checkCustomerText } from "../src/lib/agentMission/text";
import {
  TERMS,
  PRIVACY,
  REFUNDS_INTRO,
  REFUNDS_SECTIONS,
  ACCEPTABLE_USE_INTRO,
  ACCEPTABLE_USE_SECTIONS,
  COOKIES_INTRO,
  COOKIES_SECTIONS,
} from "../src/lib/legalText";
import { HELP_SECTIONS } from "../src/lib/helpContent";
import { OVERVIEW_STEPS_AR } from "../src/components/landing/Overview";
import { MobileResultCard, recordToMobileCard } from "../src/components/results/MobileResultCard";
import { InnerFooter } from "../src/components/layout/InnerFooter";
import sitemap from "../src/app/sitemap";

describe("DT-20261121-audit FX-06 and Legal Pages Verification", () => {
  it("P1 retention text is identical across Terms, Privacy, and Help", () => {
    const termsRetention = TERMS[5][1];
    const privacyRetention = PRIVACY[3][1];
    const helpRetention = HELP_SECTIONS[3].paragraphsAr[1];

    expect(termsRetention).toBe(privacyRetention);
    expect(privacyRetention).toBe(helpRetention);
    expect(termsRetention).toContain("تظل ملفات النتائج متاحة للتنزيل طوال فترة نشاط حسابك دون مدة انتهاء محددة");
    expect(termsRetention).toContain("٣٠ يومًا");
    expect(termsRetention).not.toContain("٩٠ يوم");
  });

  it("P2a minimum charge and P4 15% reserve hold in Terms clause 3 use «رجع لمحفظتك» per D-0187", () => {
    const clause3 = TERMS[2][1];
    expect(clause3).toContain("رجع لمحفظتك");
    expect(clause3).toContain("هامشًا احتياطيًا بنسبة ١٥٪");
    expect(clause3).toContain("الحد الأدنى لاحتساب تكلفة المهمة هو ٢٠٠ نقطة");
    expect(clause3).not.toContain("مُحرَّر");
    expect(clause3).not.toContain("استرداد");
    expect(clause3).not.toContain("المبالغ المستردة");

    const check = checkCustomerText(clause3, { maxChars: 1200 });
    expect(check.issues).toEqual([]);
  });

  it("P5/N14 file formats are Excel and CSV only in Terms and landing overview", () => {
    const clause1 = TERMS[0][1];
    expect(clause1).toContain("ملفات إكسل (XLSX)");
    expect(clause1).toContain("ملفات جدولية مفصولة بفواصل (CSV)");
    expect(clause1).not.toContain("PDF");

    const step3 = OVERVIEW_STEPS_AR[2];
    expect(step3.title).toBe("استلم ملفك");
    expect(step3.text).toContain("ملف إكسل أو ملف مفصول بفواصل");
    expect(step3.text).not.toContain("بي دي إف");
  });

  it("P7 stale dates are updated", () => {
    const legalPageSrc = readFileSync("src/components/LegalPage.tsx", "utf8");
    expect(legalPageSrc).toContain("آخر تحديث: نوفمبر ٢٠٢٦");
    expect(legalPageSrc).not.toContain("١١ أكتوبر ٢٠٢٦");

    const segmentsSrc = readFileSync("src/lib/segments.ts", "utf8");
    expect(segmentsSrc).toContain("const TODAY = new Date();");
    expect(segmentsSrc).not.toContain("Date.UTC(2026, 9, 20)");
  });

  it("legal pages texts pass customer text guard and contain no forbidden promises or words", () => {
    const allLegalStrings = [
      REFUNDS_INTRO,
      ...REFUNDS_SECTIONS.flatMap(([h, b]) => [h, b]),
      ACCEPTABLE_USE_INTRO,
      ...ACCEPTABLE_USE_SECTIONS.flatMap(([h, b]) => [h, b]),
      COOKIES_INTRO,
      ...COOKIES_SECTIONS.flatMap(([h, b]) => [h, b]),
    ];

    for (const str of allLegalStrings) {
      expect(str).not.toContain("استرداد");
      expect(str).not.toContain("المبالغ المستردة");
      expect(str).not.toContain("مُحرَّر");
      expect(str).not.toContain("مسودة قيد المراجعة");
      expect(str).not.toMatch(/خلال دقائق(?! برابط)/);
    }
  });

  it("InnerFooter links all public and legal pages including the 3 new ones", () => {
    const html = renderToStaticMarkup(createElement(InnerFooter));
    expect(html).toContain('href="/legal/terms"');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/refunds"');
    expect(html).toContain('href="/legal/acceptable-use"');
    expect(html).toContain('href="/legal/cookies"');
    expect(html).toContain('href="/pricing"');
    expect(html).toContain('href="/calculator"');
    expect(html).toContain('href="/help"');
    expect(html).toContain('href="/contact"');
    expect(html).toContain("ديجر © ٢٠٢٦ · مصادر متاحة فقط");
  });

  it("sitemap contains the 3 new legal routes", () => {
    const sm = sitemap();
    const urls = sm.map((entry) => entry.url);
    expect(urls.some((u) => u.endsWith("/legal/refunds"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/legal/acceptable-use"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/legal/cookies"))).toBe(true);
  });
});

describe("DT-20261121-audit FX-07 UI Verification", () => {
  it("N15: MobileResultCard renders clean fields without raw internal IDs", () => {
    const sampleRecord = {
      id: "raw_internal_id_12345",
      name: "شركة النيل للأبحاث",
      headline: "تطوير البيانات والأبحاث",
      content: "تقديم خدمات واستشارات تحليلية وبحثية دقيقة للمؤسسات والشركات.",
      city: "القاهرة",
      phone: "01012345678",
      email: "contact@nile-research.com",
      url: "https://example.com/company",
      verified: true,
      verified_label: "موثق",
      published_at: "2026-11-20",
    };

    const cardData = recordToMobileCard(sampleRecord, 0);
    const html = renderToStaticMarkup(createElement(MobileResultCard, { record: cardData, index: 0 }));

    expect(html).toContain("شركة النيل للأبحاث");
    expect(html).toContain("تطوير البيانات والأبحاث");
    expect(html).toContain("القاهرة");
    expect(html).toContain("موثق");
    expect(html).toContain("فتح المصدر");
    // Raw internal IDs are NOT rendered
    expect(html).not.toContain("raw_internal_id_12345");
    expect(html).toContain('data-testid="mobile-result-card-0"');
  });

  it("N20.1: AppShell hides «نقطة» unit when balance is loading", () => {
    const appShellSrc = readFileSync("src/components/app/AppShell.tsx", "utf8");
    expect(appShellSrc).toContain('balance.status === "ready"');
    expect(appShellSrc).toMatch(/balance\.status === "ready"\s*&&\s*\(\s*<span[^>]*>نقطة<\/span>\s*\)/);
  });

  it("N20.2: PasswordInput in AuthLayout uses CSS logical properties and dynamic dir", () => {
    const authSrc = readFileSync("src/components/AuthLayout.tsx", "utf8");
    expect(authSrc).toContain("ps-4 pe-[80px]");
    expect(authSrc).toContain("end-2");
    expect(authSrc).toContain('dir={isValueEntered ? "ltr" : "rtl"}');
    expect(authSrc).not.toContain("left-2.5");
    expect(authSrc).not.toContain("paddingLeft: 76");
  });
});
