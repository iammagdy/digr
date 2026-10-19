import { describe, it, expect } from "vitest";
import { normalizeRecord, normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { generateCsvReport } from "../src/functions/shared/fileGenerators";

describe("Task 8: Company Link Normalization", () => {
  it("normalizes a LinkedIn URL in website to empty website and populated linkedin_url", () => {
    const raw = {
      company_name: "Al-Ahram Technology",
      website: "https://www.linkedin.com/company/al-ahram-tech",
      location: "Cairo, Egypt",
    };

    const norm = normalizeRecord(raw, 0);

    expect(norm.website).toBe("");
    expect(norm.linkedin_url).toContain("linkedin.com/company/al-ahram-tech");
  });

  it("preserves genuine company website and keeps linkedin_url separate", () => {
    const raw = {
      company_name: "Nile Tech Solutions",
      website: "https://niletech.eg",
      linkedin_url: "https://www.linkedin.com/company/niletech",
      location: "Giza, Egypt",
    };

    const norm = normalizeRecord(raw, 0);

    expect(norm.website).toBe("https://niletech.eg");
    expect(norm.linkedin_url).toBe("https://www.linkedin.com/company/niletech");
  });

  it("ensures CSV text has no LinkedIn URL in the website column", () => {
    const dataset = {
      name: "Companies Research",
      rows: [
        {
          company_name: "Delta Electrical Co.",
          website: "https://www.linkedin.com/company/delta-electrical",
          location: "Mansoura, Egypt",
        },
      ],
      metadata: { country: "Egypt" },
    };

    const csvBuffer = generateCsvReport(dataset);
    const csvText = csvBuffer.toString("utf-8");

    const lines = csvText.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const headerLine = lines[0];
    const dataLine = lines[1];

    // Split CSV columns handling quotes
    const headers = headerLine.split(",").map((h) => h.replace(/^"|"$/g, ""));
    const dataCells = dataLine.split(",").map((c) => c.replace(/^"|"$/g, ""));

    const websiteColIdx = headers.findIndex((h) => h.includes("الموقع"));
    if (websiteColIdx !== -1) {
      const websiteValue = dataCells[websiteColIdx];
      expect(websiteValue).not.toContain("linkedin.com");
      expect(websiteValue).toBe("");
    }

    const linkedinColIdx = headers.findIndex((h) => h.includes("لينكد إن"));
    if (linkedinColIdx !== -1) {
      expect(dataCells[linkedinColIdx]).toContain("linkedin.com/company/delta-electrical");
    }
  });
});
