import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import ResultsCanvas from "../src/app/dashboard/chat/components/ResultsCanvas";
import { STATEMENTS, SHEETS } from "../src/components/landing/data";

describe("Task 8: Preview Columns and Landing Copy", () => {
  it("renders unique column labels for normalized company dataset, excluding 'النص' and 'المدينة / المحافظة'", () => {
    const rawDataset = {
      name: "شركات الكهرباء في مصر",
      rows: [
        {
          company_name: "شركة النيل للكهرباء",
          industry: "Electrical Engineering",
          description: "أعمال المقاولات الكهروميكانيكية وتوزيع الطاقة",
          text: "أعمال المقاولات الكهروميكانيكية وتوزيع الطاقة",
          address: "١٥ شارع النصر، المعادي، القاهرة",
          location: "القاهرة، مصر",
          city: "القاهرة",
          website: "https://nile-electric.eg",
          linkedin_url: "https://www.linkedin.com/company/nile-electric",
          phone: "+201000000001",
          work_email: "info@nile-electric.eg",
        },
      ],
      metadata: { country: "Egypt" },
    };

    const normalized = normalizeDataset(rawDataset);
    const html = renderToStaticMarkup(
      createElement(ResultsCanvas, {
        records: normalized.rows as any,
        jobStatus: "done",
      } as any)
    );

    // Extract table headers from rendered markup
    const thMatches = Array.from(html.matchAll(/<th\b[^>]*>([^<]+)<\/th>/g)).map((m) => m[1]);
    expect(thMatches.length).toBeGreaterThan(0);

    // Headers must be unique
    const uniqueHeaders = Array.from(new Set(thMatches));
    expect(thMatches).toEqual(uniqueHeaders);

    // "النص" must be excluded because description exists
    expect(thMatches).not.toContain("النص");

    // "المدينة / المحافظة" must be excluded because city exists ("المدينة" is present)
    expect(thMatches).not.toContain("المدينة / المحافظة");
    expect(thMatches).toContain("المدينة");

    // The ONE company column list (shared with the workbook): the name first, then the activity, the website, the LinkedIn page, the city.
    expect(thMatches[0]).toBe("اسم الشركة");
    expect(thMatches[1]).toBe("مجال النشاط");
    expect(thMatches[2]).toBe("الموقع الإلكتروني");
    expect(thMatches[4]).toBe("المدينة");
  });

  it("landing page copy has no Latin Excel/PDF/CSV words in SHEETS or STATEMENTS and excludes 'مع دليل المنهجية'", () => {
    const serialized = JSON.stringify({ STATEMENTS, SHEETS });

    // Assert no standalone Latin format words
    expect(serialized).not.toMatch(/\b(Excel|PDF|CSV)\b/);

    // Assert "مع دليل المنهجية" is removed
    expect(serialized).not.toContain("مع دليل المنهجية");

    // Verify Arabic format names in SHEETS
    const sheetNames = SHEETS.map((s) => s.name);
    expect(sheetNames).toEqual(["ملف سي إس في", "ملف بي دي إف", "ملف إكسل"]);
  });
});
