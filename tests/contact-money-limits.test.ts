import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import type { ContactStep, FinderInfo } from "../src/lib/agentMission/contactFinders";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/**
 * ITEM 4: the finder steps are in the price (tests/contact-step-price.test.ts, tests/contact-finder-step.test.ts: the e-mail verifier, the company-phone search and the validator are added by code to the step's per-person cost), and THE JOB NEVER SPENDS BEYOND WHAT IT WAS APPROVED:
 * the job budget (40% of the approved reserve's value, shared with the stages) ends everything, each step has its own cap (its price x its people), and the people are taken DECISION MAKERS FIRST: each person gets every step (e-mail with its verifier, phone with its company
 * lookup and validator) before the next person is looked at, so when the money ends the people with the lowest titles are the ones left with empty cells.
 */
const MISSION = "msn_money";
const FIND_E: FinderInfo = { id: "cheap.people.email.find", usd: 0.000495, inputs: [{ name: "person_linkedin_url", required: true }] };
const VERIFY: FinderInfo = { id: "first.people.email.verify", usd: 0.00124, inputs: [{ name: "email", required: true }] };
const FIND_P: FinderInfo = { id: "cheap.people.phone.find", usd: 0.000495, inputs: [{ name: "person_linkedin_url", required: true }] };
const MAPS: FinderInfo = { id: "litescrape.google.serp.maps", usd: 0.00015, inputs: [{ name: "query", required: true }] };
const VALIDATE: FinderInfo = { id: "hlrlookup.people.phone.validate", usd: 0.000001, inputs: [{ name: "telephone_number", required: true }] };
const columns = [{ key: "full_name", title_ar: "الاسم" }, { key: "job_title", title_ar: "المسمى الوظيفي" }, { key: "linkedin", title_ar: "الملف المهني" }, { key: "email", title_ar: "الإيميل", kind: "work_email" as const }, { key: "email_status", title_ar: "حالة توثيق الإيميل", status_of: "email" }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" as const }, { key: "phone_status", title_ar: "حالة توثيق رقم التليفون", status_of: "phone" }, { key: "phone_type", title_ar: "نوع الرقم", type_of: "phone" }];
const TITLES = ["Site Engineer", "Chief Executive Officer", "Accountant", "General Manager", "Technician", "Managing Director", "Driver", "Chairman"];
const person = (i: number) => ({ id: `p${i}`, parent_id: "c1", full_name: `Person${i} Name${i}`, job_title: TITLES[i % TITLES.length], linkedin: `https://www.linkedin.com/in/person${i}`, email: "", phone: "" });
const DECISION_MAKERS = new Set(["Chief Executive Officer", "General Manager", "Managing Director", "Chairman"]);

async function world(opts: { people: number; ceilingUsd: number; perPerson?: { email: number; phone: number } }) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, MISSION);
  const people = Array.from({ length: opts.people }, (_, i) => person(i));
  await items.commit([
    { t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", name: "Orascom EM", website: "https://www.orascom-em.com.eg/", country: "EG", city: "Cairo" } },
    ...people.map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: { ...p } })),
  ]);
  const steps: ContactStep[] = [
    { kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: opts.perPerson?.email ?? FIND_E.usd + VERIFY.usd, finders: [FIND_E], verifiers: [VERIFY] },
    { kind: "phone", stage_key: "people", column_key: "phone", status_key: "phone_status", type_key: "phone_type", per_person_usd: opts.perPerson?.phone ?? FIND_P.usd + MAPS.usd + VALIDATE.usd, finders: [FIND_P], company_phone: [MAPS], validators: [VALIDATE] },
  ];
  const plan: any = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }], planned_rows: 1 }, { key: "people", parent_key: "companies", title_ar: "موظفو كل شركة", deliver: true, columns, planned_rows: opts.people, role_preference: { role: "manager" } }], contact_steps: steps };
  const budget = createJobCallBudget({ ceilingUsd: opts.ceilingUsd, spentUsd: 0 });
  const price = new Map([FIND_E, VERIFY, FIND_P, MAPS, VALIDATE].map((f) => [f.id, f.usd] as const));
  let n = 0;
  const calls: string[] = [];
  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      calls.push(a.endpoint_id);
      const who = String(a.params.person_linkedin_url ?? "").split("/in/")[1] ?? "";
      const answer: unknown = a.endpoint_id === FIND_E.id ? { email: `${who}@orascom-em.com.eg` }
        : a.endpoint_id === VERIFY.id ? { status: "safe", deliverable: true, is_catch_all: false }
        : a.endpoint_id === FIND_P.id ? null
        : a.endpoint_id === MAPS.id ? { places: [{ title: "Orascom EM", website: "https://orascom-em.com.eg", phone: "+20 2 3000 4567" }] }
        : { results: [{ error: "NONE", detected_telephone_number: "20230004567", telephone_number_type: "LANDLINE", original_network_details: { country_iso3: "EGY", country_prefix: "20" } }] };
      const id = `call_${String(++n).padStart(4, "0")}`;
      await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify(answer ?? {}), "application/json");
      if (answer !== null) budget.settle(0, price.get(a.endpoint_id) ?? 0);
      return { ok: true, call_id: id, http_status: 200, rows_in_page: answer !== null ? 1 : 0, has_more: false, next_cursor: null };
    },
  };
  const run = () => runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async () => {}, budget, deadlineMs: Date.now() + 60_000 });
  const rows = () => items.acceptedRows("people");
  const complete = (r: Record<string, unknown>) => String(r.email ?? "") !== "" && String(r.phone ?? "") !== "";
  return { items, budget, calls, run, rows, complete, steps };
}

describe("the people are taken decision makers first, each with every step, until the money ends", () => {
  // one complete lookup of a person: finder 0.000495 + verifier 0.00124 + company search 0.00015 (once) + validator 0.000001 = 0.001886; a second person of the same company: 0.001736 (the company's phone is remembered)
  it("with room for two people only, the chief executive and the chairman have BOTH their e-mail and their phone, and nobody else has anything", async () => {
    const w = await world({ people: 8, ceilingUsd: 0.0037 });
    const out = await w.run();
    const done = w.rows().filter((r) => w.complete(r)).map((r) => String(r.job_title)).sort();
    expect(done.length).toBe(2);
    for (const t of done) expect(DECISION_MAKERS.has(t)).toBe(true);
    expect(w.rows().filter((r) => !w.complete(r) && (String(r.email ?? "") !== "" || String(r.phone ?? "") !== "")).length).toBe(0);
    expect(out.stopped).toBe("budget");
    expect(w.budget.spentUsd()).toBeLessThanOrEqual(0.0037 + 1e-9);
  });

  it.each([0.0005, 0.002, 0.004, 0.007, 0.012, 1])("whatever the job budget (%s USD) the spend never passes it, and the people filled are always the highest titles first", async (ceilingUsd) => {
    const w = await world({ people: 8, ceilingUsd });
    await w.run();
    expect(w.budget.spentUsd()).toBeLessThanOrEqual(ceilingUsd + 1e-9);
    const filled = w.rows().filter((r) => String(r.email ?? "") !== "" || String(r.phone ?? "") !== "");
    const isDm = (r: Record<string, unknown>) => DECISION_MAKERS.has(String(r.job_title));
    // nobody of a lower title has a cell while a decision maker has none
    if (filled.some((r) => !isDm(r))) expect(w.rows().filter(isDm).every((r) => String(r.email ?? "") !== "" || String(r.phone ?? "") !== "")).toBe(true);
  });

  it("each step is held to its own priced cap: the phone step's calls are not counted against the e-mail step's amount, and neither spends past its own", async () => {
    // an e-mail step priced at finder + verifier for 8 people, a phone step priced at only the validator: the phone step buys nothing (its search and finder do not fit its cap) while every e-mail is looked up and verified
    const w = await world({ people: 8, ceilingUsd: 1, perPerson: { email: FIND_E.usd + VERIFY.usd, phone: 0.000002 } });
    await w.run();
    expect(w.rows().filter((r) => String(r.email_status ?? "") === "موثّق").length).toBe(8);
    expect(w.rows().filter((r) => String(r.phone ?? "") !== "").length).toBe(0);
    expect(w.calls.filter((c) => c === MAPS.id || c === FIND_P.id).length).toBe(0);
    // and the whole run spent no more than the two steps' priced amounts together
    expect(w.budget.spentUsd()).toBeLessThanOrEqual(8 * (FIND_E.usd + VERIFY.usd) + 8 * 0.000002 + 1e-9);
  });

  it("a run of the same step again (a resumed mission) buys nothing: every value already has its final status", async () => {
    const w = await world({ people: 4, ceilingUsd: 1 });
    await w.run();
    const spent = w.budget.spentUsd();
    const calls = w.calls.length;
    await w.run();
    expect(w.calls.length).toBe(calls);
    expect(w.budget.spentUsd()).toBe(spent);
  });
});

// ------------------------------------------------------------------------------------------------ the price carries the steps (A1 shape)
import { replay } from "./helpers/agentReplay";
import { companiesPage, peopleAnswer, planFlow, request } from "./helpers/a1World";
import { tregResult } from "./helpers/agentFakeWorld";
import { stagePriceInputs, type PricedPlan } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { repriceStoredPlan } from "../src/lib/agentMission/lifecycle";
import { FINDERS_PER_STEP, VERIFIER_PRICE_DEPTH, chainExpectation, chainPriceUsd } from "../src/lib/agentMission/contactFinders";

describe("the A1-style plan price includes every step, by code", () => {
  const plan = async () => (await replay({ request, planning: planFlow(), execution: () => [], answers: Array.from({ length: 40 }, () => (o: any) => (o.endpointId.includes("waterfall") ? peopleAnswer(o) : tregResult(companiesPage, 0.0005))) })).plannedPlan as PricedPlan;

  it("AFTER the chain (finder, fallback share, verifier, company-phone search, validator) the price is higher than when only the first finder of each step was priced (BEFORE, the previous rule); the approval's re-price is the same; no row is added", async () => {
    const p = await plan();
    const steps = p.contact_steps!;
    // BEFORE: each step priced at its first-ranked finder only
    const before = priceMissionByCode(stagePriceInputs(p.stages, steps.map((s) => ({ ...s, per_person_usd: s.finders[0]?.usd ?? 0 }))), { settings: p.price.settings });
    expect(p.price.providerCostUsd!).toBeGreaterThan(before.providerCostUsd!);
    expect(p.price.reservePoints).toBeGreaterThan(before.reservePoints);
    expect(p.price.maxChargePoints).toBeGreaterThan(before.maxChargePoints);
    expect(p.price.deliveredRows).toBe(before.deliveredRows);
    // the step prices are the documented sums
    // CHANGED (PR 1 part b): the documented sums are the PEOPLE steps' (the company-level steps have their own, tested in company-contact-step.test.ts)
    for (const s of steps.filter((x) => x.level === undefined)) {
      // CHANGED (owner decision after #321): the expected cost of the chain from the measured hit rates (finderStats.ts), not the guessed shares
      const chain = chainExpectation(s.finders, s.kind);
      const expected = chain.costUsd + (s.kind === "email" ? (1 - chain.missShare) * chainPriceUsd(s.verifiers, VERIFIER_PRICE_DEPTH) : chain.missShare * chainPriceUsd(s.company_phone, FINDERS_PER_STEP) + chainPriceUsd(s.validators));
      expect(s.per_person_usd).toBeCloseTo(expected, 9);
    }
    const again = repriceStoredPlan(p);
    expect(again.reservePoints).toBe(p.price.reservePoints);
    expect(again.maxChargePoints).toBe(p.price.maxChargePoints);
  });

  it("the reserve the customer approves is never below the job's whole spend allowance: the job budget is 40% of the reserve's value, and every step's cap is inside it", async () => {
    const p = await plan();
    // CHANGED (PR 1 part b): each step's allowance is per row of ITS OWN stage (a company step: the companies, not the people)
    const stepsCap = p.contact_steps!.reduce((n, s) => n + s.per_person_usd * p.stages.find((x) => x.key === s.stage_key)!.planned_rows, 0);
    // what the steps may spend (their caps together) is part of the provider cost the price rests on
    expect(p.price.providerCostUsd!).toBeGreaterThanOrEqual(stepsCap - 1e-9);
  });
});
