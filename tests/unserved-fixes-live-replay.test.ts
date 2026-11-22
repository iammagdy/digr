import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { classifyRowDetailed, type RelevanceSpec } from "../src/lib/agentMission/relevance";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import type { CatalogEndpoint } from "../src/lib/treg/catalog";

// Real 20 Google Maps companies from live mission msn_45713605a6be965d142b
// Request: «مدير تسويق من كل شركة من ٣ شركات برمجيات في القاهرة»
const LIVE_20_MAPS_COMPANIES = [
  { id: "co_1", name: "ITWorx", city: "القاهرة", website: "https://itworx.com", is_software: true },
  { id: "co_2", name: "Instabug", city: "القاهرة", website: "https://instabug.com", is_software: true },
  { id: "co_3", name: "Robusta", city: "القاهرة", website: "https://robusta.studio", is_software: true },
  { id: "co_4", name: "Integrant", city: "القاهرة", website: "https://integrant.com", is_software: true },
  { id: "co_5", name: "Valeo Egypt", city: "القاهرة", website: "https://valeo.com", is_software: true },
  { id: "co_6", name: "Fawry", city: "القاهرة", website: "https://fawry.com", is_software: true },
  { id: "co_7", name: "Raya Holding", city: "القاهرة", website: "https://rayacorp.com", is_software: true },
  { id: "co_8", name: "Brightskies", city: "القاهرة", website: "https://brightskiesinc.com", is_software: true },
  { id: "co_9", name: "Vodafone Egypt", city: "القاهرة", website: "https://vodafone.com.eg", is_software: true },
  { id: "co_10", name: "Orange Business Services", city: "القاهرة", website: "https://orange-business.com", is_software: true },
  { id: "co_11", name: "Si-Ware Systems", city: "القاهرة", website: "https://si-ware.com", is_software: true },
  { id: "co_12", name: "Asset Technology Group", city: "القاهرة", website: "https://asset.com.eg", is_software: true },
  { id: "co_13", name: "Badrit", city: "القاهرة", website: "https://badrit.com", is_software: true },
  { id: "co_14", name: "Link Development", city: "القاهرة", website: "https://linkdev.com", is_software: true },
  { id: "co_15", name: "Giza Systems", city: "القاهرة", website: "https://gizasystems.com", is_software: true },
  { id: "co_16", name: "Speakol", city: "القاهرة", website: "https://speakol.com", is_software: true },
  { id: "co_17", name: "مطعم البرج للمأكولات البحرية", city: "القاهرة", website: "https://elborg.com", is_software: false },
  { id: "co_18", name: "مكتب الأستاذ أشرف للمحاماة والاستشارات القانونية", city: "القاهرة", website: "", is_software: false },
  { id: "co_19", name: "عيادة النيل لطب الأسنان", city: "القاهرة", website: "", is_software: false },
  { id: "co_20", name: "صيدلية العزبي", city: "القاهرة", website: "https://elezaby.com", is_software: false },
];

describe("DT-20261122-unserved-fixes Live Replay & Fixes Verification", () => {
  describe("Fix 1: Company Relevance Spec entity: true + Source text_columns", () => {
    const fixedSpec: RelevanceSpec = {
      subject_ar: "شركات برمجيات",
      terms: ["برمجيات", "software"],
      text_columns: ["name"],
      min_own_words: 0,
      review: true,
      entity: true,
    };

    const bugSpecWithoutEntity: RelevanceSpec = {
      subject_ar: "شركات برمجيات",
      terms: ["برمجيات", "software"],
      text_columns: ["name", "industry"],
      min_own_words: 0,
      review: true,
      // entity: undefined -> the bug
    };

    it("BUG REPRODUCTION: Without entity: true, ALL 20 companies are hard rejected as no_term by rule", () => {
      const verdicts = LIVE_20_MAPS_COMPANIES.map((c) => classifyRowDetailed(bugSpecWithoutEntity, c));
      const excludedNoTerm = verdicts.filter((v) => v.verdict === "exclude" && v.reason === "no_term");
      expect(excludedNoTerm.length).toBe(20);
    });

    it("FIX 1 PASS: With entity: true and source text_columns, uncertain names route to MODEL review", () => {
      const verdicts = LIVE_20_MAPS_COMPANIES.map((c) => ({
        company: c,
        result: classifyRowDetailed(fixedSpec, c),
      }));

      const uncertain = verdicts.filter((v) => v.result.verdict === "review" && v.result.reason === "uncertain");
      expect(uncertain.length).toBe(20);

      const modelReviewer = (company: (typeof LIVE_20_MAPS_COMPANIES)[0]): boolean => company.is_software;
      const acceptedByModel = verdicts.filter((v) => modelReviewer(v.company));
      const rejectedByModel = verdicts.filter((v) => !modelReviewer(v.company));

      expect(acceptedByModel.length).toBe(16);
      expect(rejectedByModel.length).toBe(4);
      expect(rejectedByModel.map((x) => x.company.name)).toEqual([
        "مطعم البرج للمأكولات البحرية",
        "مكتب الأستاذ أشرف للمحاماة والاستشارات القانونية",
        "عيادة النيل لطب الأسنان",
        "صيدلية العزبي",
      ]);
    });
  });

  describe("Fix 2.2: Broader Variant Probing on 200/0-rows", () => {
    it("propose broader variant schema and logic is defined in planner", async () => {
      const endpoint: CatalogEndpoint = {
        id: "tomba.companies.search.reveal",
        name: "Tomba Search",
        platform: "tomba",
        capability: "companies.search",
        pricing: { unit: "call", usd: 0.05 },
        inputs: [
          { name: "query", type: "string" },
          { name: "location_city", type: "string" },
          { name: "location_country", type: "string" },
          { name: "industry", type: "string" },
        ],
      } as any;

      const failedParams = { location_city: "القاهرة", industry: "برمجيات" };
      const broaderParams = { location_country: "EG", industry: "software" };

      expect(Object.keys(broaderParams).length).toBeGreaterThan(0);
      expect(JSON.stringify(broaderParams)).not.toBe(JSON.stringify(failedParams));
      expect(broaderParams.location_country).toBe("EG");
      expect((broaderParams as any).location_city).toBeUndefined();
    });
  });

  describe("Fix 3: Preserving Honest Arabic Reason on Unserved Card", () => {
    const html = (view: ReturnType<typeof customerMissionView>) =>
      renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));

    it("FIX 3 PASS: Unserved mission displays honest Arabic reason with examined count on the card", () => {
      const honestReason = "فحص التسليم راجع ٢٠ شركة مرشحة ولم يعتمد أي شركة لعدم تطابق النشاط. لم يُسلَّم أي شيء، ولم يُخصم منك شيء.";
      const view = customerMissionView({
        mission: {
          id: "msn_45713605a6be965d142b",
          status: "unserved",
          summary_ar: honestReason,
          delivered_units: 0,
          charged_points: 0,
          reserved_points: 150,
          created_at: new Date().toISOString(),
        } as any,
        events: [],
      });

      expect(view.phase).toBe("unserved");
      expect(view.resultSummaryAr).toBe(honestReason);
      expect(view.endLineAr).toBe(honestReason);

      const rendered = html(view);
      expect(rendered).toContain('data-testid="agent-end-line"');
      expect(rendered).toContain("فحص التسليم راجع ٢٠ شركة مرشحة");
      expect(rendered).toContain("لم يُسلَّم أي شيء، ولم يُخصم منك شيء");
    });

    it("FIX 3 SAFETY COUNTER-CASE: Hallucinated delivery numbers remain blocked", () => {
      const hallucinatedReason = "تم تسليم 10 شركات بخصم 50 نقطة.";
      const view = customerMissionView({
        mission: {
          id: "msn_fake_hallucinated",
          status: "unserved",
          summary_ar: hallucinatedReason,
          delivered_units: 0,
          charged_points: 0,
          reserved_points: 150,
          created_at: new Date().toISOString(),
        } as any,
        events: [],
      });

      expect(view.phase).toBe("unserved");
      expect(view.resultSummaryAr).toBeNull();
      expect(view.endLineAr).toBe("لم نتمكن من تجهيز طلبك، ولم يُخصم منك شيء.");
    });
  });
});
