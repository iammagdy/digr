import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  generateExcelReport,
  generateCsvReport,
  generatePdfReport,
  generateMethodologyText,
  formatArabicRtl,
} from "../src/functions/shared/fileGenerators";

describe("Research Deliverables Generator Suite", () => {
  const sampleDataset = {
    metadata: {
      title: "تفاعل الجمهور مع مباريات منتخب مصر في كأس العالم 2026 - منصة X",
      platform: "X (تويتر)",
      template: "twitter.search.tweets",
      collectedAt: "2026-06-20T14:30:00Z",
      jobId: "job_wc_egypt_2026",
    },
    rows: [
      {
        tweet_id: "1982736451",
        published_at: "2026-06-15T18:00:00Z",
        username: "sports_analyst_ar",
        author_name: "محلل رياضي",
        text: "تحليل تكتيكي لمباراة مصر وبلجيكا وتألق خط الدفاع",
        likes_count: 1420,
        retweets_count: 310,
        replies_count: 85,
        views_count: 45000,
        url: "https://x.com/sports_analyst_ar/status/1982736451",
      },
      {
        tweet_id: "1982736452",
        published_at: "2026-06-16T12:00:00Z",
        username: "egypt_football_hub",
        author_name: "نبض الفراعنة",
        text: "=ملخص أهداف وفرص منتخب مصر في الجولة الأولى",
        likes_count: 3200,
        retweets_count: 850,
        replies_count: 140,
        views_count: 98000,
        url: "https://x.com/egypt_football_hub/status/1982736452",
      },
    ],
  };

  it("preserves Arabic-Indic number order in RTL PDF text", () => {
    expect(formatArabicRtl("٥٠")).toBe("٠٥");
  });

  describe("1. Excel Report (.xlsx) Generation", () => {
    it("generates a data-only research workbook with no dashboard, quality or codebook sheets (owner decision D4)", async () => {
      const buffer = await generateExcelReport(sampleDataset);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as any);

      const sheetNames = wb.worksheets.map((ws) => ws.name);
      expect(sheetNames).toEqual(["المنشورات"]);
      for (const removed of ["لوحة المؤشرات العامة", "تحليل التفاعل", "جودة البيانات", "دليل الحقول"]) {
        expect(sheetNames).not.toContain(removed);
      }
    });

    it("enforces Right-To-Left (RTL) views on every sheet", async () => {
      const buffer = await generateExcelReport(sampleDataset);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as any);

      for (const ws of wb.worksheets) {
        const rtlView = ws.views.find((v: any) => v.rightToLeft === true);
        expect(rtlView, `Sheet ${ws.name} must have rightToLeft enabled`).toBeDefined();
      }
    });

    it("sanitizes formula injection in Excel cells and preserves numbers", async () => {
      const buffer = await generateExcelReport(sampleDataset);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as any);

      const wsData = wb.getWorksheet("المنشورات");
      expect(wsData).toBeDefined();

      let foundEscapedFormula = false;
      wsData?.eachRow((row) => {
        row.eachCell((cell) => {
          if (typeof cell.value === "string" && cell.value.startsWith("'=")) {
            foundEscapedFormula = true;
          }
        });
      });
      expect(foundEscapedFormula).toBe(true);
    });

    it("labels every active column in Arabic on the data sheet (the codebook sheet was removed)", async () => {
      const buffer = await generateExcelReport(sampleDataset);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as any);

      const wsData = wb.getWorksheet("المنشورات");
      expect(wsData).toBeDefined();
      const headers = (wsData!.getRow(1).values as string[]).filter(Boolean);

      // text, likes_count, views_count and username are the source fields; the header names them in Arabic.
      expect(headers).toContain("نص المحتوى");
      expect(headers).toContain("عدد الإعجابات");
      expect(headers).toContain("عدد المشاهدات");
      expect(headers).toContain("اسم المستخدم");
      // No raw source field names leak as headers.
      for (const raw of ["text", "likes_count", "views_count", "username"]) {
        expect(headers).not.toContain(raw);
      }
    });

    it("contains zero upstream provider names or leaks (TREG, TikHub, Apify, etc.)", async () => {
      const buffer = await generateExcelReport(sampleDataset);
      const contentStr = buffer.toString("utf-8");

      expect(contentStr).not.toContain("treg");
      expect(contentStr).not.toContain("TREG");
      expect(contentStr).not.toContain("tikhub");
      expect(contentStr).not.toContain("TikHub");
      expect(contentStr).not.toContain("apify");
    });

    it("reports supported facts and accurate integrity phrasing in the methodology (the quality sheet was removed)", () => {
      const withoutTarget = generateMethodologyText(sampleDataset);

      // When targetRequested is missing the delivered rows are never used as the requested count.
      expect(withoutTarget).toContain("العدد المطلوب في الخطة: غير متاح");
      // Integrity phrasing must not claim unverified exact identity.
      expect(withoutTarget).not.toContain("نقل مطابق للمصدر المعلن");
      // Distinct metrics: raw received, delivered after cleaning, removed duplicates.
      expect(withoutTarget).toContain("السجلات المستلمة من المصدر: ٢");
      expect(withoutTarget).toContain("السجلات المعروضة بعد التنظيف: ٢");
      expect(withoutTarget).toContain("لا توجد استبعادات مسجلة");
      expect(withoutTarget).toContain("اكتمال الحقول:");

      // With explicit targetRequested provided
      const withTarget = generateMethodologyText({
        ...sampleDataset,
        metadata: { ...sampleDataset.metadata, targetRequested: 100 },
      });
      expect(withTarget).toContain("العدد المطلوب في الخطة: ١٠٠");
    });
  });

  describe("2. CSV Report (.csv) Generation", () => {
    it("prepends UTF-8 BOM (\\uFEFF) to ensure perfect Arabic rendering in Excel", () => {
      const buffer = generateCsvReport(sampleDataset);
      expect(buffer).toBeInstanceOf(Buffer);

      // Byte 0, 1, 2 must be EF BB BF (UTF-8 BOM)
      expect(buffer[0]).toBe(0xef);
      expect(buffer[1]).toBe(0xbb);
      expect(buffer[2]).toBe(0xbf);

      const text = buffer.toString("utf-8");
      expect(text).toContain("نص المحتوى");
      expect(text).toContain("عدد الإعجابات");
      expect(text).toContain("مصر وبلجيكا");
    });

    it("escapes formula injection and wraps RFC 4180 quotes properly", () => {
      const buffer = generateCsvReport(sampleDataset);
      const text = buffer.toString("utf-8");

      expect(text).toContain("\"'=ملخص أهداف وفرص منتخب مصر في الجولة الأولى\"");
    });
  });

  describe("3. PDF Report (.pdf) Generation", () => {
    it("generates a valid PDF buffer matching research deliverable specifications", async () => {
      const buffer = await generatePdfReport(sampleDataset);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);

      const header = buffer.subarray(0, 5).toString("ascii");
      expect(header).toBe("%PDF-");
    });

    it("generates a valid PDF for account profiles without errors", async () => {
      const profileDataset = {
        profile: {
          uniqueId: "iam_megz",
          nickname: "MeGz",
          signature: "باحث رقمي وصانع محتوى",
          verified: true,
          followerCount: 25000,
          followingCount: 300,
          heartCount: 850000,
          videoCount: 120,
        },
      };

      const buffer = await generatePdfReport(profileDataset);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    });
  });

  describe("4. Academic Methodology Document Generation", () => {
    it("generates an Arabic customer methodology summary without unsupported claims or internal ids", () => {
      const text = generateMethodologyText(sampleDataset);

      expect(text).toContain("المصدر: منصة إكس");
      expect(text).toContain("السجلات المعروضة بعد التنظيف: ٢");
      expect(text).toContain("لم تُقَس نسبة تغطية المجتمع المستهدف");
      expect(text).toContain("لم ترد حالات تحقق مستقلة للحقول");
      expect(text).not.toContain("job_wc_egypt_2026");
      expect(text).not.toMatch(/\b(?:public|general|coverage|integrity|verified|Job ID|Cross-sectional)\b/i);
      expect(text).not.toContain("البيانات العامة");
      expect(text).not.toMatch(/[0-9]/);

      // Verify zero provider leaks
      expect(text.toLowerCase()).not.toContain("treg");
      expect(text.toLowerCase()).not.toContain("tikhub");
    });
  });
});
