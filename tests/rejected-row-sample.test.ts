import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import {
  buildRejectedSample,
  maskSensitive,
  mergeRejectedSample,
  rejectionReasonCode,
  REJECTED_SAMPLE_LIMIT,
} from "../src/lib/server/rejectedRowSample";

describe("A5: capped, masked sample of rejected rows with reason codes", () => {
  it("the cap is ten rows per job", () => {
    expect(REJECTED_SAMPLE_LIMIT).toBe(10);
    const rows = Array.from({ length: 25 }, (_, i) => ({ company_name: `Co ${i}`, _relevance_reason: "لا يتضمن نص السجل كلمات من موضوع البحث" }));
    expect(buildRejectedSample(rows)).toHaveLength(10);
  });

  it("chunks of one job never push the stored sample past the cap", () => {
    const entry = buildRejectedSample([{ company_name: "A", _relevance_reason: "x" }]);
    let stored = mergeRejectedSample(null, buildRejectedSample(Array.from({ length: 7 }, () => ({ company_name: "A" }))));
    stored = mergeRejectedSample(stored, buildRejectedSample(Array.from({ length: 7 }, () => ({ company_name: "B" }))));
    stored = mergeRejectedSample(stored, entry);
    expect(stored).toHaveLength(10);
    expect(stored.slice(0, 7).every((item) => item.fields.name === "A")).toBe(true);
  });

  it("maps the gate's real rejection reasons to stable codes", () => {
    const company = {
      capabilitySlug: "icypeas-companies-search",
      endpointId: "icypeas.companies.search",
      params: { country: "Egypt", industry: "الكهرباء والطاقة الكهربائية" },
    };
    const water = evaluateResearchRowRelevance(
      { company_name: "Water Co", industry: "Utilities", description: "Water treatment and chemical supplies", location: "Alexandria, Egypt" },
      company,
    );
    expect(water.decision).toBe("no_match");
    expect(rejectionReasonCode(water.reasonAr)).toBe("industry_mismatch");

    const social = { capabilitySlug: "social-x-posts", endpointId: "anyapi.x.search.posts", params: { query: "كرة السلة" } };
    const offTopic = evaluateResearchRowRelevance({ text: "Football highlights and goals from tonight" }, social);
    expect(rejectionReasonCode(offTopic.reasonAr)).toBe("topic_not_in_text");
    expect(rejectionReasonCode(evaluateResearchRowRelevance({ id: "1" }, social).reasonAr)).toBe("no_text");

    const trending = { capabilitySlug: "social-tiktok-videos", endpointId: "x.trending", params: { trending: true, region: "EG" } };
    const foreign = evaluateResearchRowRelevance({ title: "كعكة", region: "US" }, trending);
    expect(rejectionReasonCode(foreign.reasonAr)).toBe("out_of_region");
    expect(rejectionReasonCode("سبب غير معروف")).toBe("other_mismatch");
  });

  it("masks emails, phones, links and handles; keeps only diagnostic fields", () => {
    const [entry] = buildRejectedSample([{
      company_name: "Water Co",
      industry: "Utilities",
      email: "owner@water.example",
      phone: "+20 100 123 4567",
      website: "https://water.example/secret/path?token=abc",
      author_name: "private_person",
      text: "اتصل على owner@water.example او 01001234567 وزور https://x.example/a/b",
      _relevance_reason: "وصف النشاط يوضح مجالاً مختلفاً عن الكهرباء؛ استُبعد السجل ولم يُحتسب",
    }]);
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("owner@water.example");
    expect(serialized).not.toContain("01001234567");
    expect(serialized).not.toContain("1234567");
    expect(serialized).not.toContain("secret/path");
    expect(serialized).not.toContain("private_person");
    expect(entry.fields).not.toHaveProperty("email");
    expect(entry.fields).not.toHaveProperty("phone");
    expect(entry.fields.author).toBe("pr***");
    expect(entry.reasonCode).toBe("industry_mismatch");
    expect(maskSensitive("a@b.co")).toBe("a***@***");
  });

  it("the worker writes the sample to the job's partials storage, before any release path, without affecting the chunk", () => {
    const route = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    const write = route.indexOf("rejected_sample.json");
    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(route.indexOf("const acceptedRows = adapterResult.ok"));
    expect(route.slice(write - 1200, write + 1800)).toContain("Best effort: the sample is for diagnosis");
    // Cleanup removes only step files, so the sample stays for diagnosis.
    expect(route).toContain("`${jobId}/step_${idx}.json`");
    // It adds nothing to money paths: no ledger, spend or settlement call near it.
    const block = route.slice(write - 800, write + 1800);
    expect(block).not.toMatch(/settle_job_atomic|release_job_atomic|reserve_|complete_chunk|credit_ledger/);
  });
});
