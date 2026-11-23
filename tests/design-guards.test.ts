import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AllowIndex,
  loadAllowList,
  loadTregCatalogIds,
  scanCodebase,
  scanSourceCode,
} from "./designGuardsScanner";

describe("Design Guard Detectors (Unit Tests for Required Detectors)", () => {
  const catalog = loadTregCatalogIds(path.resolve(__dirname, "../data/treg"));

  it("Detector 1 fires: detects Arabic regex literal and RegExp() call", () => {
    const fakeCode = [
      'const r1 = /سعر_الطلب/i;',
      'const r2 = new RegExp("تفاصيل_الخدمة");',
      'const validRegex = /^[a-z0-9_-]+$/i;',
    ].join("\n");

    const violations = scanSourceCode("fake/file1.ts", fakeCode, catalog, new AllowIndex());

    expect(violations.length).toBe(2);
    expect(violations[0]).toMatchObject({
      file: "fake/file1.ts",
      line: 1,
      rule: "arabic_regex",
    });
    expect(violations[0].formatted).toContain("fake/file1.ts:1");
    expect(violations[0].detail).toContain("/سعر_الطلب/i");

    expect(violations[1]).toMatchObject({
      file: "fake/file1.ts",
      line: 2,
      rule: "arabic_regex",
    });
    expect(violations[1].formatted).toContain("fake/file1.ts:2");
    expect(violations[1].detail).toContain('"تفاصيل_الخدمة"');
  });

  it("Detector 2 fires: detects hardcoded endpoint ID and provider ID from data/treg/*.json", () => {
    // Pick real known IDs from data/treg to test whole-token detection
    const sampleEndpoint = "apify.google.serp.maps";
    const sampleProvider = "crawl4ai";

    expect(catalog.endpoints.has(sampleEndpoint)).toBe(true);
    expect(catalog.providers.has(sampleProvider)).toBe(true);

    const fakeCode = [
      `const endpointId = "${sampleEndpoint}";`,
      `const providerName = "${sampleProvider}";`,
      'const genericWord = "arbitrary_catalog_variable";',
    ].join("\n");

    const violations = scanSourceCode("fake/file2.ts", fakeCode, catalog, new AllowIndex());

    expect(violations.length).toBeGreaterThanOrEqual(2);
    const epViolation = violations.find((v) => v.detail.includes(sampleEndpoint));
    const provViolation = violations.find((v) => v.detail.includes(sampleProvider));

    expect(epViolation).toBeDefined();
    expect(epViolation!.file).toBe("fake/file2.ts");
    expect(epViolation!.line).toBe(1);
    expect(epViolation!.rule).toBe("treg_token");
    expect(epViolation!.formatted).toContain("fake/file2.ts:1");

    expect(provViolation).toBeDefined();
    expect(provViolation!.file).toBe("fake/file2.ts");
    expect(provViolation!.line).toBe(2);
    expect(provViolation!.rule).toBe("treg_token");
    expect(provViolation!.formatted).toContain("fake/file2.ts:2");
  });

  it("Module specifiers containing provider or endpoint IDs are not flagged, while normal strings are", () => {
    const sampleProvider = "crawl4ai";
    expect(catalog.providers.has(sampleProvider)).toBe(true);

    const fakeCode = [
      `import { something } from "../${sampleProvider}/catalog";`,
      `export * from "./providers/${sampleProvider}";`,
      `const mod = import("../lib/${sampleProvider}");`,
      `const req = require("../lib/${sampleProvider}");`,
      `const providerName = "${sampleProvider}";`,
    ].join("\n");

    const violations = scanSourceCode("fake/moduleSpecifiers.ts", fakeCode, catalog, new AllowIndex());

    // Only line 5 (normal string literal) should be flagged; lines 1-4 are module specifiers
    expect(violations.length).toBe(1);
    expect(violations[0].line).toBe(5);
    expect(violations[0].rule).toBe("treg_token");
    expect(violations[0].detail).toContain(sampleProvider);
  });

  it("Detector 3 fires: detects string literal containing «/srv/»", () => {
    const fakeCode = [
      'const tempDir = "/srv/diger-team/fawaaly/work";',
      'const safePath = "/tmp/scratch/output.log";',
    ].join("\n");

    const violations = scanSourceCode("fake/file3.ts", fakeCode, catalog, new AllowIndex());

    expect(violations.length).toBe(1);
    expect(violations[0]).toMatchObject({
      file: "fake/file3.ts",
      line: 1,
      rule: "srv_path",
    });
    expect(violations[0].formatted).toContain("fake/file3.ts:1");
    expect(violations[0].detail).toContain("/srv/diger-team/fawaaly/work");
  });

  it("Detector 4 fires: detects fallback array literal of 4+ short lowercase parameter-like strings (.find/.some)", () => {
    const fakeCode = [
      'const chosen = ["page_size", "limit", "count", "per_page"].find((k) => k in params);',
      'const hasKey = ["cursor", "next_page", "token", "offset"].some((k) => k in params);',
      'const shortAllowed = ["a", "b"].find((k) => k === target);',
    ].join("\n");

    const violations = scanSourceCode("fake/file4.ts", fakeCode, catalog, new AllowIndex());

    expect(violations.length).toBe(2);

    expect(violations[0]).toMatchObject({
      file: "fake/file4.ts",
      line: 1,
      rule: "fallback_list",
    });
    expect(violations[0].formatted).toContain("fake/file4.ts:1");
    expect(violations[0].detail).toContain("page_size,limit,count,per_page");

    expect(violations[1]).toMatchObject({
      file: "fake/file4.ts",
      line: 2,
      rule: "fallback_list",
    });
    expect(violations[1].formatted).toContain("fake/file4.ts:2");
    expect(violations[1].detail).toContain("cursor,next_page,token,offset");
  });
});

describe("Design Guards on Current Codebase (Regression Guard)", () => {
  it("scans src/ and agent/src/ with zero unexpected design violations against allow-list in < 5s", () => {
    const t0 = Date.now();
    const violations = scanCodebase();
    const elapsedMs = Date.now() - t0;

    // Formatted error report if any violation is found
    if (violations.length > 0) {
      const report = violations.map((v) => v.formatted).join("\n");
      expect.fail(`Found ${violations.length} unexpected design violation(s) in codebase:\n${report}`);
    }

    expect(violations).toEqual([]);

    // Must be fast (< 5 s)
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("allow-list file exists and contains expected legacy baseline counts", () => {
    const allowListPath = path.resolve(__dirname, "fixtures/design-guards-allow.json");
    const allowIndex = loadAllowList(allowListPath);
    expect(allowIndex).toBeInstanceOf(AllowIndex);

    // Verify allow-list is functional on a known legacy hit
    const allowed = allowIndex.isAllowed("src/lib/server/relevanceEvidence.ts", "fallback_list", "ات,ون,ين,ان,يه,ها,ه,ي");
    expect(allowed).toBe(true);
  });
});
