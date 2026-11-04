import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInSandbox } from "../agent/src/sandbox";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { companyPhoneSourcesOf, validatorSourcesOf, verifierSourcesOf, type FinderKind } from "../src/lib/agentMission/contactFinders";
import { stagePriceInputs } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";
import { buildB2BAsk } from "../src/lib/agentMission/stage3/b2bAsk";
import { B2B_CARDS, readB2BRows } from "../src/lib/agentMission/stage3/b2bCards";
import { b2bMapCode } from "../src/lib/agentMission/stage3/b2bMapCode";
import { b2bCompaniesRequest } from "../src/lib/agentMission/stage3/b2bRequest";
import { planB2BByCode, type B2BPlanInput } from "../src/lib/agentMission/stage3/b2bPlan";

/**
 * STAGE 3, PART A (docs/STAGE-3.md section 8.0, S3): A COMPANIES AND DECISION-MAKERS PLAN BUILT BY CODE. buildB2BAsk -> compileB2BPlan -> a PricedPlan of the same shape the engine runs today
 * (stages with a recipe: endpoint, inputs, paging input, mapping code, parent binding; the contact steps of contactFinders.ts), priced ONLY by the existing pricing function
 * (`priceMissionByCode(stagePriceInputs(...))`, the same call the social compiler makes). No model, no read: the plan reads no page at planning.
 * Fixtures: the two anonymised real missions msn_4969a50fed8c45b37d8f and msn_7539ea17512cf58aa0e7 (their stored companies pages) and the live words of 7539 (tests/limits-live-7539.test.ts).
 */
const LIVE_7539 = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار";
const MISSIONS = ["msn_4969a50fed8c45b37d8f", "msn_7539ea17512cf58aa0e7"] as const;
const page = (mission: string, call: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));
const TOMBA = B2B_CARDS.find((c) => c.endpointId === "tomba.companies.search.reveal")!;
const catalog = loadTregCatalog();
const allowed = () => true;
const aids = (kind: FinderKind) => (kind === "email" ? { verifiers: verifierSourcesOf(catalog, allowed) } : { validators: validatorSourcesOf(catalog, allowed), company_phone: companyPhoneSourcesOf(catalog, allowed) });
const input = (requestText: string, over: Partial<B2BPlanInput> = {}): B2BPlanInput => ({ requestText, catalog, isAllowed: allowed, aids, ...over });
const VERIFIED = new Set(B2B_CARDS.filter((c) => c.status === "verified").map((c) => c.endpointId));

describe("the live request of 7539, planned by code", () => {
  const r = planB2BByCode(input(LIVE_7539));
  if (!r.ok) throw new Error(r.reason);
  const { plan } = r;
  it("two stages with a recipe built by code: the verified companies search, then the people of each company bound to the company's own profile link", () => {
    expect(plan.stages.map((s) => [s.key, s.endpoint_id, s.parent_key])).toEqual([["companies", "tomba.companies.search.reveal", null], ["people", "blitzapi.people.employee-finder", "companies"]]);
    for (const s of plan.stages) { expect(s.engine?.built_by).toBe("code"); expect(s.engine?.map_code).toBe(b2bMapCode(B2B_CARDS.find((c) => c.endpointId === s.endpoint_id)!)); }
    expect(plan.stages[0].engine!.cursor_param).toBe("page");
    expect(plan.stages[1].engine!.parent_binding).toEqual({ param: "company_linkedin_url", from: "linkedin" });
    expect(plan.stages[0].planned_rows).toBe(5);
    expect(plan.stages[1].per_parent_rows).toBe(2);
    expect(plan.stages[1].role_preference).toEqual({ role: "manager" });
  });
  it("the contact steps follow the compiled chains: the chain order is the finder order, and every lookup is a VERIFIED card (a non-test account)", () => {
    const steps = plan.contact_steps ?? [];
    const person = (kind: FinderKind) => steps.find((s) => s.level === undefined && s.kind === kind)!;
    expect(person("email").finders.map((f) => f.id)).toEqual(r.compiled.chains.email.filter((id) => id !== r.compiled.peopleCard));
    expect(person("phone").finders.map((f) => f.id)).toEqual(r.compiled.chains.mobile.filter((id) => id !== r.compiled.peopleCard));
    const companyPhone = steps.find((s) => s.level === "company" && s.kind === "phone")!;
    expect(companyPhone.company_phone!.map((f) => f.id)).toEqual(r.compiled.chains.hq_phone);
    const lookups = [...plan.stages.map((s) => s.endpoint_id), ...steps.flatMap((s) => [...s.finders, ...(s.company_phone ?? [])].map((f) => f.id))];
    expect(lookups.length).toBeGreaterThan(3);
    for (const id of lookups) expect(VERIFIED.has(id), id).toBe(true);
    // no verified lister of a company's general mailbox exists yet (decision 10): no e-mail step is invented for it
    expect(steps.some((s) => s.level === "company" && s.kind === "email")).toBe(false);
  });
  it("priced ONLY by the existing pricing function: the reserve is exactly what priceMissionByCode gives for these stages and steps, under the job cap", () => {
    const expected = priceMissionByCode(stagePriceInputs(plan.stages, plan.contact_steps), { settings: DEFAULT_MISSION_PRICING_SETTINGS });
    expect(plan.price).toEqual(expected);
    expect(plan.price.reservePoints).toBeGreaterThan(0);
    expect(plan.price.overCap).toBe(false);
  });
  it("the owner's company sheet: name, activity, website, the HQ, the general e-mail with its status, the HQ phone (the reference columns by code)", () => {
    const keys = plan.stages[0].columns.map((c) => c.title_ar);
    for (const t of ["اسم الشركة", "النشاط والتخصص", "الموقع الإلكتروني", "المقر الرئيسي", "الإيميل العام للشركة", "هاتف المقر الرئيسي"]) expect(keys, t).toContain(t);
    expect(plan.stages[1].columns.map((c) => c.title_ar)).toEqual(expect.arrayContaining(["اسم صانع القرار", "المسمى الوظيفي", "إيميل المسؤول المباشر", "هاتف / محمول المسؤول"]));
  });
  it("the customer's card text passes the customer-text rules (Arabic, no provider, no vendor)", () => {
    for (const t of [plan.summary_ar, ...(plan.notes_ar ?? []), ...(plan.assumptions_ar ?? [])]) expect(checkCustomerText(t).issues, t).toEqual([]);
    expect(JSON.stringify([plan.summary_ar, plan.notes_ar ?? []])).not.toMatch(/tomba|blitz|crawl4ai|aviato|USD|\$/i);
  });
  it("is deterministic: the same words give the same plan, byte for byte", () => {
    const again = planB2BByCode(input(LIVE_7539));
    expect(again.ok && JSON.stringify(again.plan)).toBe(JSON.stringify(plan));
  });
});

describe("a nationality word sets the search's country INPUT only (owner decision 6), never a row rule", () => {
  const r = planB2BByCode(input(LIVE_7539));
  if (!r.ok) throw new Error(r.reason);
  it("«شركات مصرية»: the companies search is asked for EG; the Ask's own country stays null (nothing is filtered by it)", () => {
    expect(r.ask.country).toBeNull();
    expect((r.plan.stages[0].engine!.params.filters as Record<string, { include: string[] }>).location_country).toEqual({ include: ["EG"] });
  });
  it("no stage carries a filter (no place rule, no condition rule): no row can be dropped because of the nationality word", () => {
    for (const s of r.plan.stages) expect(s.filters ?? []).toEqual([]);
  });
  it("the stored pages of BOTH real missions were asked with the same two filter fields the code builds (country and industry)", () => {
    const built = Object.keys(b2bCompaniesRequest(r.ask, LIVE_7539, TOMBA)!.filters as Record<string, unknown>).sort();
    for (const m of MISSIONS) {
      const live = Object.keys(((page(m, "call_0001").meta as Record<string, unknown>).filters ?? {}) as Record<string, unknown>).sort();
      expect(built, m).toEqual(live);
    }
  });
});

describe("tomba's phone_number boolean never reaches the HQ phone column", () => {
  it("the mapping code (run in the sandbox) on every stored companies page gives the card's rows exactly, and no row has a phone of any kind", async () => {
    const pages = [["msn_4969a50fed8c45b37d8f", "call_0001"], ["msn_4969a50fed8c45b37d8f", "call_0007"], ["msn_7539ea17512cf58aa0e7", "call_0001"], ["msn_7539ea17512cf58aa0e7", "call_0004"]] as const;
    for (const [m, c] of pages) {
      const p = page(m, c);
      const out = await runInSandbox(b2bMapCode(TOMBA)!, { page: p });
      expect(out.ok, `${m}/${c}`).toBe(true);
      const rows = JSON.parse(out.ok ? out.resultJson ?? "[]" : "[]") as Array<Record<string, unknown>>;
      expect(rows).toEqual(JSON.parse(JSON.stringify(readB2BRows(TOMBA, p))));
      expect(rows.length).toBe(50);
      for (const row of rows) for (const [k, v] of Object.entries(row)) { expect(/phone|tel/i.test(k), k).toBe(false); expect(typeof v === "boolean", k).toBe(false); }
    }
  });
  it("the plan's HQ phone column is filled by the company phone step (the maps lookup), never by the companies search's mapping", () => {
    const r = planB2BByCode(input(LIVE_7539));
    if (!r.ok) throw new Error(r.reason);
    const step = r.plan.contact_steps!.find((s) => s.level === "company" && s.kind === "phone")!;
    expect(r.plan.stages[0].columns.find((c) => c.key === step.column_key)?.title_ar).toBe("هاتف المقر الرئيسي");
    expect(r.plan.stages[0].engine!.map_code).not.toMatch(/phone_number/);
  });
});

describe("what the code path does not plan falls back to today's path (the caller keeps the model's planning)", () => {
  it("a request that is not about companies or decision makers", () => {
    expect(planB2BByCode(input("عايز ١٠٠ تغريدة عن الذكاء الاصطناعي"))).toEqual({ ok: false, reason: "not_b2b" });
  });
  it("a people request with no company named (no verified people search card)", () => {
    const r = planB2BByCode(input("هات ١٥ مدير تسويق في مصر مع الإيميل والموبايل"));
    expect(r.ok).toBe(false);
  });
  it("a companies request with no number of companies (today's path asks the customer)", () => {
    expect(planB2BByCode(input("عايز شركات مصرية في قطاع الكهروميكانيكا ومعاهم صناع القرار"))).toEqual({ ok: false, reason: "no_count" });
  });
  it("an account that may not buy the companies search", () => {
    expect(planB2BByCode(input(LIVE_7539, { isAllowed: (id) => id !== "tomba.companies.search.reveal" }))).toEqual({ ok: false, reason: "not_allowed" });
  });
  it("the JOB CAP: a plan whose hold would pass it is not made by code (priceMissionByCode's own overCap)", () => {
    const r = planB2BByCode(input("عايز ٩٠٠٠ شركة مصرية في قطاع الكهروميكانيكا، ومعاهم ٥ من صناع القرار من كل شركة"));
    expect(r).toEqual({ ok: false, reason: "over_cap" });
  });
});
