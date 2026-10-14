import { describe, it, expect } from "vitest";
import {
  normalizeArabicCompanyName,
  normalizeEnglishCompanyName,
  normalizeDomain,
  evaluateCompanyMatch,
  auditDeduplication,
  NegativeListItem,
  CandidateCompanyRecord,
} from "../src/lib/server/negativeListEngine";

describe("Negative List Deduplication Engine", () => {
  describe("Domain & Name Normalization", () => {
    it("normalizes domains to clean base hostnames", () => {
      expect(normalizeDomain("https://www.orascom.com/en/about")).toBe("orascom.com");
      expect(normalizeDomain("http://PETROJET.COM.EG/")).toBe("petrojet.com.eg");
      expect(normalizeDomain("WWW.HASSANALLAM.COM")).toBe("hassanallam.com");
      expect(normalizeDomain(undefined)).toBeUndefined();
    });

    it("normalizes Arabic company names by removing legal forms and standardizing characters", () => {
      const norm1 = normalizeArabicCompanyName("شركة أوراسكوم للإنشاءات ش.م.م");
      expect(norm1).toContain("اوراسكوم");
      expect(norm1).not.toContain("ش م م");

      const norm2 = normalizeArabicCompanyName("مؤسسة المقاولون العرب - عثمان أحمد عثمان");
      expect(norm2).toContain("المقاولون العرب");
      expect(norm2).not.toContain("مؤسسة");
    });

    it("normalizes English company names", () => {
      const norm = normalizeEnglishCompanyName("Orascom Construction Industries S.A.E.");
      expect(norm).toContain("orascom");
      expect(norm).not.toContain("s.a.e");
    });
  });

  describe("False-Positive Guard: Generic Business Words", () => {
    it("never confirms duplicate between distinct companies sharing generic business words", () => {
      const baseline: NegativeListItem = {
        nameAr: "شركة مقاولات النيل الهندسية الكهروميكانيكية",
        normalizedNameAr: normalizeArabicCompanyName("شركة مقاولات النيل الهندسية الكهروميكانيكية"),
      };

      const candidate: CandidateCompanyRecord = {
        nameAr: "شركة مقاولات الأهرام الهندسية الكهروميكانيكية",
      };

      const result = evaluateCompanyMatch(candidate, baseline);

      // Even though they share "شركة", "مقاولات", "الهندسية", "الكهروميكانيكية",
      // the distinctive brand tokens ("النيل" vs "الاهرام") are completely different!
      expect(result.status).not.toBe("CONFIRMED_DUPLICATE");
      expect(result.status).toBe("DISTINCT");
    });
  });

  describe("Exact and High-Confidence Matching", () => {
    it("confirms duplicate on exact domain match", () => {
      const baseline: NegativeListItem = {
        nameAr: "حسن علام القابضة",
        domain: "hassanallam.com",
      };

      const candidate: CandidateCompanyRecord = {
        nameAr: "Hassan Allam Holding",
        domain: "https://www.hassanallam.com/projects",
      };

      const result = evaluateCompanyMatch(candidate, baseline);
      expect(result.status).toBe("CONFIRMED_DUPLICATE");
      expect(result.matchCriteria).toBe("domain_exact");
      expect(result.confidence).toBe(1.0);
    });

    it("confirms duplicate on commercial registration (CR) match", () => {
      const baseline: NegativeListItem = {
        nameAr: "شركة السويدي إلكتريك",
        crNumber: "123456",
      };

      const candidate: CandidateCompanyRecord = {
        nameAr: "Elsewedy Electric",
        crNumber: "123456",
      };

      const result = evaluateCompanyMatch(candidate, baseline);
      expect(result.status).toBe("CONFIRMED_DUPLICATE");
      expect(result.matchCriteria).toBe("cr_exact");
    });

    it("confirms duplicate on exact normalized Arabic name", () => {
      const baseline: NegativeListItem = {
        nameAr: "شركة إنبي للمشروعات البترولية",
        normalizedNameAr: normalizeArabicCompanyName("شركة إنبي للمشروعات البترولية"),
      };

      const candidate: CandidateCompanyRecord = {
        nameAr: "إنبي للمشروعات البترولية والغاز",
      };

      const result = evaluateCompanyMatch(candidate, baseline);
      expect(["CONFIRMED_DUPLICATE", "POSSIBLE_DUPLICATE"]).toContain(result.status);
    });
  });

  describe("Audit Trail Generation", () => {
    it("audits candidates against baseline and returns clean unique records and audit items", () => {
      const baseline: NegativeListItem[] = [
        {
          id: "ex_1",
          nameAr: "شركة أوراسكوم للإنشاءات",
          domain: "orascom.com",
        },
        {
          id: "ex_2",
          nameAr: "شركة بتروجت",
          domain: "petrojet.com.eg",
        },
      ];

      const candidates: CandidateCompanyRecord[] = [
        {
          nameAr: "أوراسكوم للإنشاء والصناعة",
          domain: "https://orascom.com/",
        },
        {
          nameAr: "شركة مقاولات الدلتا الكهروميكانيكية",
          domain: "delta-mep.com",
        },
        {
          nameAr: "بتروجت - المشروعات البترولية",
          domain: "http://petrojet.com.eg/ar",
        },
      ];

      const audit = auditDeduplication(candidates, baseline);

      expect(audit.uniqueRecords.length).toBe(1);
      expect(audit.uniqueRecords[0].nameAr).toBe("شركة مقاولات الدلتا الكهروميكانيكية");

      expect(audit.duplicatesRemovedCount).toBe(2);
      expect(audit.auditLog.length).toBe(3);

      const orascomAudit = audit.auditLog.find((a) => a.candidateName.includes("أوراسكوم"));
      expect(orascomAudit).toBeDefined();
      expect(orascomAudit?.status).toBe("CONFIRMED_DUPLICATE");
      expect(orascomAudit?.matchedBaselineName).toContain("شركة أوراسكوم للإنشاءات");
      expect(orascomAudit?.actionAr).toContain("مستبعد");
    });
  });
});
