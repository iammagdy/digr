import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { NOT_ADMIN } from "./helpers/agentHarness";
import { childStepSourcesFor } from "../src/lib/agentMission/childSources";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { companyPhoneSourcesOf, finderSourcesOf, validatorSourcesOf, verifierSourcesOf } from "../src/lib/agentMission/contactFinders";
import { executionBudgetUsd } from "../src/lib/agentMission/price";
import { AGENT_JOB_POINTS_CAP } from "../src/lib/agentMission/constants";

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
  contactAids: (kind) => (kind === "email" ? { verifiers: verifierSourcesOf(catalog, allowed) } : { validators: validatorSourcesOf(catalog, allowed), company_phone: companyPhoneSourcesOf(catalog, allowed) }),
};
const companies = { key: "companies", title_ar: "الشركات المصرية في قطاع الكهروميكانيكا", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }], sample_rows: [{ id: "esweco.com", name: "ESWECO", website: "https://esweco.com", country: "EG" }], measured_by: ["call_0001"] };
const people = { key: "people", title_ar: "صناع القرار في كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "name", title_ar: "اسم المدير" }, { key: "title", title_ar: "المسمى الوظيفي" }, { key: "linkedin", title_ar: "الملف المهني" }], sample_rows: [{ id: "person-1", name: "Osama Abou Shady", title: "CIO", linkedin: "https://linkedin.com/in/osama-abou-shady-90966540" }], measured_by: ["call_0002"], role_preference: { role: "manager" } };

describe("the standard request after the owner's decision (before #321's follow-up: price 373, reserve 429, provider estimate 0.0454 USD)", () => {
  const priced = () => {
    const checked = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا ومعهم صناع القرار.", stages: [companies, people] }, lookup);
    if (!checked.ok) throw new Error(JSON.stringify(checked));
    return checked.plan;
  };
  const DAILY_CAP_USD = 0.8;
  it("two decision makers a company are kept (the default count is not lowered) and the price carries the deeper search and the whole lookup chain", () => {
    const p = priced();
    const stage = p.stages.find((s) => s.key === "people")!;
    expect(stage.per_parent_rows).toBe(2);
    expect(p.price.deliveredRows).toBe(15);
    expect(stage.pages_per_parent).toBe(3);
    // the numbers of this run: unit 80.73 points, the most that can be charged 1,211 points, the hold 1,393 (before: 24.81, 373, 429)
    expect(p.price.maxChargePoints).toBeGreaterThan(1100);
    expect(p.price.maxChargePoints).toBeLessThan(1300);
    expect(p.price.reservePoints).toBeGreaterThan(1300);
    expect(p.price.reservePoints).toBeLessThan(1500);
  });
  it("it stays inside the job cap", () => {
    const p = priced();
    expect(p.price.overCap).toBe(false);
    expect(p.price.reservePoints).toBeLessThanOrEqual(AGENT_JOB_POINTS_CAP);
  });
  it("the EXPECTED provider cost is about a quarter of the provider's daily cap (0.80 USD), and even the WORST case (every person goes through every finder, every page is read) is under two thirds of it and inside the job's own call budget", () => {
    const p = priced();
    const expected = p.price.providerCostUsd ?? 0;
    expect(expected).toBeGreaterThan(0.15);
    expect(expected / DAILY_CAP_USD).toBeLessThan(1 / 3);
    const people = p.stages.find((s) => s.key === "people")!;
    const pages = people.planned_rows * ((people.pages_per_parent ?? 1) * (people.page_cost_usd ?? 0)) / (people.per_parent_rows ?? 1);
    const chain = (p.contact_steps ?? []).reduce((n, st) => n + (st.max_person_usd ?? st.per_person_usd) * people.planned_rows, 0);
    const worst = pages + chain + 0.0001;
    expect(worst / DAILY_CAP_USD).toBeLessThan(2 / 3);
    expect(worst).toBeLessThan(executionBudgetUsd(p.price.reservePoints));
  });
  it("the chain behind the price: e-mail blitz, anyapi, dropleads then a verifier; phone blitz, quickenrich, then the company's phone and a validator; no call above 0.02 USD", () => {
    const steps = priced().contact_steps ?? [];
    const email = steps.find((s) => s.kind === "email")!;
    const phone = steps.find((s) => s.kind === "phone")!;
    expect(email.finders.map((f) => f.id)).toEqual(["blitzapi.people.email.find", "anyapi.linkedin.email.work.find", "dropleads.people.email.find"]);
    expect(email.verifiers!.length).toBeGreaterThan(0);
    expect(phone.finders.map((f) => f.id)).toEqual(["blitzapi.people.phone.find", "quickenrich.people.phone.find"]);
    expect(phone.company_phone!.length).toBeGreaterThan(0);
    for (const f of [...email.finders, ...phone.finders]) expect(f.usd).toBeLessThanOrEqual(0.02);
    expect(email.max_person_usd).toBeCloseTo(0.000495 + 0.011 + 0.018 + 0.00178, 6);
  });
});
