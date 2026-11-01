import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { NOT_ADMIN } from "./helpers/agentHarness";
import { childStepSourcesFor } from "../src/lib/agentMission/childSources";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { companyPhoneSourcesOf, finderSourcesOf, mailboxListerSourcesOf, validatorSourcesOf, verifierSourcesOf } from "../src/lib/agentMission/contactFinders";
import { estimateModelCostUsd, priceMissionByCode } from "../src/lib/agentMission/price";
import { AGENT_MODEL_PLANNING_ESTIMATE_USD, AGENT_REVIEW_ROW_ESTIMATE_USD, NAMES_STEP_USD_PER_PERSON } from "../src/lib/agentMission/constants";

const OWNER = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون";
const catalog = loadTregCatalog();
const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;

/** The live measurements of msn_7539ea17512cf58aa0e7: companies from tomba (0.000178 USD for 50), people from aviato (0.005 USD a page of 5), the catalog's own finder chains. */
const calls = new Map([
  ["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "electromechanical" } }],
  ["call_0002", { id: "call_0002", endpointId: "aviato.companies.employees", ok: true, costUsd: 0.005, rows: 5, params: { website: "esweco.com", perPage: 5, page: 1 } }],
]);
const lookup: PlanLookup = {
  call: (id) => calls.get(id) ?? null, evidenceText: () => "esweco.com https://esweco.com person-1 person-2 Osama Abou Shady CIO https://linkedin.com/in/osama-abou-shady-90966540", endpointAllowed: () => true, requestText: OWNER,
  childStepSources: (noun) => childStepSourcesFor(noun, catalog, allowed),
  endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 5 }]]),
  isContactSource: (id) => /email/i.test(id),
  contactFinders: (kind) => finderSourcesOf(kind, catalog, allowed),
  // CHANGED (PR 1 part b): the company's own e-mail step (reference A column 5) is part of the standard request's price
  mailboxListers: () => mailboxListerSourcesOf(catalog, allowed),
  contactAids: (kind) => (kind === "email" ? { verifiers: verifierSourcesOf(catalog, allowed) } : { validators: validatorSourcesOf(catalog, allowed), company_phone: companyPhoneSourcesOf(catalog, allowed) }),
};
const companies = { key: "companies", title_ar: "الشركات المصرية في قطاع الكهروميكانيكا", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }], sample_rows: [{ id: "esweco.com", name: "ESWECO", website: "https://esweco.com", country: "EG" }], measured_by: ["call_0001"] };
const people = { key: "people", title_ar: "صناع القرار في كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "name", title_ar: "اسم المدير" }, { key: "title", title_ar: "المسمى الوظيفي" }, { key: "linkedin", title_ar: "الملف المهني" }], sample_rows: [{ id: "person-1", name: "Osama Abou Shady", title: "CIO", linkedin: "https://linkedin.com/in/osama-abou-shady-90966540" }], measured_by: ["call_0002"], role_preference: { role: "manager" } };


/**
 * AUDIT 2026-11 PR 2, item 2 (G15): THE MODEL'S SHARE ENTERS THE ESTIMATE BY CODE, so the revenue of a full delivery is about ten times the expected REAL cost (provider + model).
 * Live: G1 (msn_ecca2a0d…) planning cost 0.0117 USD, G4 (msn_3da66037…) 0.0183 USD for a two-stage plan; the estimate was one flat 0.012 for every plan; the review of a row is measured at 0.0000115 USD (2 calls, 50 rows). Planning is now priced by the plan's shape (a base for one stage and an increment
 * for each further stage: a child stage is the dearer one to plan), the review by the measured per-row cost, the names, titles and activities by their per-person estimate. The charge formula (priceByRule, markup 10, the 200-point minimum) is untouched: only the cost it is given changes.
 */
const stage = (rows: number, cost: number, extra: Record<string, unknown> = {}) => ({ rows, costPerRowUsd: cost, deliver: true, ...extra });

describe("planning is priced by the plan's shape, not one flat number", () => {
  it("one stage: the base; each further stage adds its increment; the two-stage estimate covers the measured planning cost of G4 (0.0183 USD)", () => {
    const one = estimateModelCostUsd([stage(50, 0.0003)]);
    const two = estimateModelCostUsd([stage(5, 0.0002), stage(50, 0.0003)]);
    const three = estimateModelCostUsd([stage(5, 0.0002), stage(50, 0.0003), stage(50, 0.0003)]);
    const EXEC = 0.005;
    // the planning part of each estimate (what is left after the per-stage execution estimate) sits inside the live range
    expect(one - EXEC).toBeGreaterThanOrEqual(0.006);
    expect(one - EXEC).toBeLessThanOrEqual(0.0093);
    expect(two - 2 * EXEC).toBeGreaterThanOrEqual(0.0117);
    expect(two - 2 * EXEC).toBeLessThanOrEqual(0.0211);
    expect(three - two).toBeCloseTo(two - one, 6);
    expect(two - one).toBeGreaterThan(EXEC);
  });
  it("the review is the rows to collect x the share the model reviews x the measured per-row cost", () => {
    const base = estimateModelCostUsd([stage(10, 0.001, { yield: 0.5 })]);
    const reviewed = estimateModelCostUsd([stage(10, 0.001, { yield: 0.5, reviewShare: 0.6 })]);
    expect(reviewed - base).toBeCloseTo((10 / 0.5) * 0.6 * AGENT_REVIEW_ROW_ESTIMATE_USD, 9);
  });
});

describe("G1 and G4: the plan's revenue is about ten times the expected cost (provider + model), the minimum excepted", () => {
  const standard = () => {
    const checked = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا ومعهم صناع القرار.", stages: [companies, people] }, lookup);
    if (!checked.ok) throw new Error(JSON.stringify(checked));
    return checked.plan.price;
  };
  it("G1 (the standard request): the model estimate carries the planning of two stages, the review and the names; revenue / expected cost is 10 within 2", () => {
    const price = standard();
    const model = price.modelCostUsd!;
    expect(model).toBeGreaterThanOrEqual(AGENT_MODEL_PLANNING_ESTIMATE_USD + 0.008 + 0.005 * 2);
    expect(price.minApplied).toBeFalsy();
    const revenueUsd = price.maxChargePoints / 550;
    const ratio = revenueUsd / (price.providerCostUsd! + model);
    expect(ratio).toBeGreaterThan(8);
    expect(ratio).toBeLessThan(12);
    process.stderr.write(`G1 plan: unit ${price.unitPricePoints} max ${price.maxChargePoints} reserve ${price.reservePoints} provider ${price.providerCostUsd!.toFixed(4)} model ${model.toFixed(4)} ratio ${ratio.toFixed(2)}\n`);
  });
  it("G4 (5 videos and 50 comments): the 200-point minimum sets the charge, so the ratio is above 10 and shown", () => {
    const p = priceMissionByCode([stage(5, 0.00003), stage(50, 0.0002)]);
    expect(p.minApplied).toBe(true);
    const ratio = p.maxChargePoints / 550 / (p.providerCostUsd! + p.modelCostUsd!);
    expect(ratio).toBeGreaterThan(10);
    process.stderr.write(`G4 plan: unit ${p.unitPricePoints} max ${p.maxChargePoints} provider ${p.providerCostUsd!.toFixed(4)} model ${p.modelCostUsd!.toFixed(4)} ratio ${ratio.toFixed(2)}\n`);
  });
  it("the names step is per person in the price, as measured", () => {
    expect(NAMES_STEP_USD_PER_PERSON).toBeGreaterThanOrEqual(0.00006);
  });
});
