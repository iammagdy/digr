import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { NOT_ADMIN } from "./helpers/agentHarness";
import { childStepSourcesFor } from "../src/lib/agentMission/childSources";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { companyPhoneSourcesOf, finderSourcesOf, mailboxListerSourcesOf, validatorSourcesOf, verifierSourcesOf } from "../src/lib/agentMission/contactFinders";
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
  // CHANGED (PR 1 part b): the company's own e-mail step (reference A column 5) is part of the standard request's price
  mailboxListers: () => mailboxListerSourcesOf(catalog, allowed),
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
    // the numbers of this run: unit 100.58 points, the most that can be charged 1,509 points, the hold 1,736 (CHANGED in PR 1 part b: the company's own e-mail and HQ phone steps are in the price, five companies x 0.0108 USD; before: 80.73, 1,211, 1,393; before #322: 24.81, 373, 429)
    // CHANGED (DT-20261118-03 PR-2c, Megz D-0085): the person-phone chain may use finders up to 0.05 USD a call (the ones that find the person's own phone more often), so the price rises: max 2,603, hold 2,993 on these fakes (before: max 1,400-1,600, hold 1,600-1,850)
    expect(p.price.maxChargePoints).toBeGreaterThan(2500);
    expect(p.price.maxChargePoints).toBeLessThan(2700);
    expect(p.price.reservePoints).toBeGreaterThan(2900);
    expect(p.price.reservePoints).toBeLessThan(3100);
  });
  it("it stays inside the job cap", () => {
    const p = priced();
    expect(p.price.overCap).toBe(false);
    expect(p.price.reservePoints).toBeLessThanOrEqual(AGENT_JOB_POINTS_CAP);
  });
  // CHANGED (DT-20261118-03 fix round 1, BUG HUNTER Gate 2 P0; Megz D-0085 and its addendum): the daily cap is ONE number for all of TREG, every vendor together (agent/src/gateway.ts:295 reserves under provider «treg»;
  // supabase/migrations/20261016205309_fix_provider_spend_scope.sql:19-26 sums every TREG cost against it). With the 0.05 USD phone chain a standard request expects about 56% of the 0.80 USD cap and may plan up to about 145% of it:
  // two such requests a day use up the default cap (accepted in the D-0085 addendum; the cap is raised in admin). Before: expected < 1/3 and worst < 2/3 of the cap.
  it("the EXPECTED TREG cost is under 60% of the TREG-wide daily cap (0.80 USD), and even the WORST case (every person goes through every finder, every page is read) is under 150% of it and inside the job's own call budget", () => {
    const p = priced();
    const expected = p.price.providerCostUsd ?? 0;
    expect(expected).toBeGreaterThan(0.15);
    expect(expected).toBeLessThan(DAILY_CAP_USD * 0.6);
    const people = p.stages.find((s) => s.key === "people")!;
    const pages = people.planned_rows * ((people.pages_per_parent ?? 1) * (people.page_cost_usd ?? 0)) / (people.per_parent_rows ?? 1);
    // CHANGED (PR 1 part b): each step's cap is per row of ITS OWN stage (the company steps: the five companies, not the ten people)
    const chain = (p.contact_steps ?? []).reduce((n, st) => n + (st.max_person_usd ?? st.per_person_usd) * p.stages.find((x) => x.key === st.stage_key)!.planned_rows, 0);
    const worst = pages + chain + 0.0001;
    expect(worst).toBeLessThan(DAILY_CAP_USD * 1.5);
    expect(worst).toBeLessThan(executionBudgetUsd(p.price.reservePoints));
  });
  // CHANGED (DT-20261118-03, Megz D-0084): the person's phone step has no company-phone search (before: «then the company's phone»; company_phone non-empty)
  // CHANGED (DT-20261118-03 PR-2c, Megz D-0085): the phone chain is chosen up to 0.05 USD a call: blitz, aiark, tomba (before: blitz, quickenrich, every call up to 0.02)
  it("the chain behind the price: e-mail blitz, anyapi, dropleads then a verifier (up to 0.02 USD a call); phone blitz, aiark, tomba and a validator (up to 0.05), never the company's phone", () => {
    const steps = priced().contact_steps ?? [];
    const email = steps.find((s) => s.kind === "email")!;
    const phone = steps.find((s) => s.kind === "phone")!;
    expect(email.finders.map((f) => f.id)).toEqual(["blitzapi.people.email.find", "anyapi.linkedin.email.work.find", "dropleads.people.email.find"]);
    expect(email.verifiers!.length).toBeGreaterThan(0);
    expect(phone.finders.map((f) => f.id)).toEqual(["blitzapi.people.phone.find", "aiark.people.phone.find", "tomba.people.phone.find"]);
    expect(phone.company_phone).toBeUndefined();
    for (const f of email.finders) expect(f.usd).toBeLessThanOrEqual(0.02);
    for (const f of phone.finders) expect(f.usd).toBeLessThanOrEqual(0.05);
    expect(email.max_person_usd).toBeCloseTo(0.000495 + 0.011 + 0.018 + 0.00178, 6);
  });
});
