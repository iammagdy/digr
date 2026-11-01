import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { buildContactSteps, chainExpectation, companyPhoneSourcesOf, validatorSourcesOf, withContactColumns, type ContactStep, type FinderInfo } from "../src/lib/agentMission/contactFinders";
import { companyCountryOf, companyPhoneOfRow, mapsParamsFor, phoneStatusOf, phoneVerdictIn, placePhoneIn, validatorParamsFor } from "../src/lib/agentMission/phoneValidation";
import { companyIdentityOf } from "../src/lib/agentMission/companyIdentity";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/**
 * ITEM 3 (live test A1, 2026-11-01): a US number (+1 858 254 9559, from the people of a company named «mycompany») was marked «موثّق» on an Egyptian company's person. Benchmark (owner's agent, TREG, 5 companies x 2 decision makers): 0 of 10 personal phones exist in the sources, the company's head-office phone
 * was found for 10 of 10 and validated as an Egyptian landline. Rules: the personal phone first; none: the COMPANY's phone in the person's row, labelled «رقم الشركة» (column «نوع الرقم»: «شخصي» / «رقم الشركة»); every phone validated; a number of another country than the company's is
 * «رقم من دولة أخرى», never «موثّق»; «موثّق» only when validation passes.
 */
const MISSION = "msn_phones";
const FIND: FinderInfo = { id: "cheap.people.phone.find", usd: 0.000495, inputs: [{ name: "person_linkedin_url", required: true }] };
const VALIDATE: FinderInfo = { id: "hlrlookup.people.phone.validate", usd: 0.000001, inputs: [{ name: "telephone_number", required: true }, { name: "input_format", required: false }] };
const MAPS: FinderInfo = { id: "litescrape.google.serp.maps", usd: 0.00015, inputs: [{ name: "query", required: true }, { name: "country", required: false }] };
const columns = [{ key: "full_name", title_ar: "الاسم" }, { key: "job_title", title_ar: "المسمى الوظيفي" }, { key: "linkedin", title_ar: "الملف المهني" }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" as const }, { key: "phone_status", title_ar: "حالة توثيق رقم التليفون", status_of: "phone" }, { key: "phone_type", title_ar: "نوع الرقم", type_of: "phone" }];
const person = (i: number, title = "General Manager", phone = "") => ({ id: `p${i}`, parent_id: "c1", full_name: `Person${i} Name${i}`, job_title: title, linkedin: `https://www.linkedin.com/in/person${i}`, phone });
const FALCON = { id: "c1", name: "Falcon Misr Electromechanical", website: "https://www.falconmisr.com/", city: "Cairo", country: "EG" };
const egyptianMaps = { places: [{ title: "Some Other Business", website: "https://other.example", phone: "+20 2 1111 1111" }, { title: "Falcon Misr Electromechanical", website: "https://falconmisr.com", phone: "+20 2 2345 6789" }] };

/** A validator that answers like hlrlookup: the country comes from the number's calling code (or the format hint for a national number). */
const hlr = (params: Record<string, unknown>) => {
  const n = String(params.telephone_number ?? "");
  const iso3 = params.input_format ? String(params.input_format) : n.startsWith("20") ? "EGY" : n.startsWith("1") ? "USA" : n.startsWith("39") ? "ITA" : "ZZZ";
  const prefix = iso3 === "EGY" ? "20" : iso3 === "USA" ? "1" : iso3 === "ITA" ? "39" : "";
  return { results: [{ error: "NONE", detected_telephone_number: n, telephone_number_type: iso3 === "EGY" && !n.startsWith("201") ? "LANDLINE" : "MOBILE", original_network_details: { country_iso3: iso3, country_prefix: prefix } }] };
};

type Answer = unknown | "fail";
async function world(opts: { people: Array<ReturnType<typeof person>>; company?: Record<string, unknown>; validators?: FinderInfo[]; companyPhone?: FinderInfo[]; perPersonUsd?: number; ceilingUsd?: number; answers: (endpoint: string, params: Record<string, unknown>) => Answer }) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, MISSION);
  await items.commit([
    { t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { ...(opts.company ?? FALCON) } as any },
    ...opts.people.map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: { ...p } })),
  ]);
  const validators = opts.validators === undefined ? [VALIDATE] : opts.validators;
  const companyPhone = opts.companyPhone === undefined ? [MAPS] : opts.companyPhone;
  const step: ContactStep = { kind: "phone", stage_key: "people", column_key: "phone", status_key: "phone_status", type_key: "phone_type", per_person_usd: opts.perPersonUsd ?? 0.01, finders: [FIND], ...(validators.length ? { validators } : {}), ...(companyPhone.length ? { company_phone: companyPhone } : {}) };
  const plan: any = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }], planned_rows: 1, filters: [{ kind: "place", places: ["EG"], values: ["مصر"] }] }, { key: "people", parent_key: "companies", title_ar: "موظفو كل شركة", deliver: true, columns, planned_rows: opts.people.length, role_preference: { role: "manager" } }], contact_steps: [step] };
  const budget = createJobCallBudget({ ceilingUsd: opts.ceilingUsd ?? 1, spentUsd: 0 });
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let n = 0;
  const priced = new Map([FIND, ...validators, ...companyPhone].map((f) => [f.id, f.usd] as const));
  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      calls.push({ endpoint: a.endpoint_id, params: a.params });
      const out = opts.answers(a.endpoint_id, a.params);
      if (out === "fail") return { ok: false, call_id: `call_${++n}`, failed: true, http_status: 500, message: "x" };
      const id = `call_${String(++n).padStart(4, "0")}`;
      await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json");
      if (out !== null) budget.settle(0, priced.get(a.endpoint_id) ?? 0);
      return { ok: true, call_id: id, http_status: 200, rows_in_page: out !== null ? 1 : 0, has_more: false, next_cursor: null };
    },
  };
  const run = () => runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async () => {}, budget, deadlineMs: Date.now() + 60_000 });
  const cell = (id: string) => { const r = items.acceptedRows("people").find((x) => x.id === id)!; return { phone: String(r.phone ?? "").replace(/\D/g, ""), status: String(r.phone_status ?? ""), type: String(r.phone_type ?? "") }; };
  return { items, budget, calls, run, cell };
}

describe("the company's phone, labelled, when there is no personal phone", () => {
  it("BENCHMARK SHAPE: no personal phone exists; the company's head-office phone from a map search goes in the person's row as «رقم الشركة», validated as Egyptian: «موثّق»; one lookup per company", async () => {
    const w = await world({ people: [person(1), person(2), person(3)], answers: (ep, p) => (ep === FIND.id ? null : ep === MAPS.id ? egyptianMaps : ep === VALIDATE.id ? hlr(p) : null) });
    await w.run();
    for (const id of ["p1", "p2", "p3"]) expect(w.cell(id)).toEqual({ phone: "20223456789", status: "موثّق", type: "رقم الشركة" });
    expect(w.calls.filter((c) => c.endpoint === MAPS.id).length).toBe(1);
    expect(w.calls.filter((c) => c.endpoint === MAPS.id)[0].params.query).toBe("Falcon Misr Electromechanical Cairo");
  });

  it("a personal phone, when the finder has one, is «شخصي» and no company lookup is paid for", async () => {
    const w = await world({ people: [person(1)], answers: (ep, p) => (ep === FIND.id ? { phone: "+201001234567" } : ep === MAPS.id ? egyptianMaps : ep === VALIDATE.id ? hlr(p) : null) });
    await w.run();
    expect(w.cell("p1")).toEqual({ phone: "201001234567", status: "موثّق", type: "شخصي" });
    expect(w.calls.some((c) => c.endpoint === MAPS.id)).toBe(false);
  });

  it("the company's phone from the company's own data (a national number) is used before any paid search, validated with the company's country as the format hint", async () => {
    const w = await world({ people: [person(1), person(2)], company: { ...FALCON, phone: "02 2345 6789" }, answers: (ep, p) => (ep === FIND.id ? null : ep === VALIDATE.id ? hlr(p) : null) });
    await w.run();
    expect(w.cell("p1")).toMatchObject({ type: "رقم الشركة", status: "موثّق" });
    expect(w.calls.some((c) => c.endpoint === MAPS.id)).toBe(false);
    expect(w.calls.find((c) => c.endpoint === VALIDATE.id)!.params).toEqual({ telephone_number: "0223456789", input_format: "EGY" });
  });

  it("a map result that is some other business is not the company's phone: the cell stays empty and the person stays", async () => {
    const w = await world({ people: [person(1)], answers: (ep) => (ep === FIND.id ? null : ep === MAPS.id ? { places: [{ title: "Some Other Business", website: "https://other.example", phone: "+20 2 1111 1111" }] } : null) });
    await w.run();
    expect(w.cell("p1")).toEqual({ phone: "", status: "", type: "" });
    expect(w.items.acceptedRows("people").length).toBe(1);
  });
});

describe("every phone is validated, and a number of another country is never «موثّق»", () => {
  it("LIVE SHAPE: a US number (+1 858 254 9559) for an Egyptian company is kept as «رقم من دولة أخرى»", async () => {
    const w = await world({ people: [person(1)], answers: (ep, p) => (ep === FIND.id ? { phone: "+18582549559" } : ep === VALIDATE.id ? hlr(p) : null) });
    await w.run();
    expect(w.cell("p1")).toEqual({ phone: "18582549559", status: "رقم من دولة أخرى", type: "شخصي" });
  });

  it("without any validator a number is «غير موثّق», and a number of another country is still «رقم من دولة أخرى» (its calling code says so)", async () => {
    const w = await world({ people: [person(1), person(2)], validators: [], answers: (ep, p) => (ep === FIND.id ? { phone: String(p.person_linkedin_url).endsWith("person1") ? "+201001234567" : "+390612345678" } : null) });
    await w.run();
    expect(w.cell("p1").status).toBe("غير موثّق");
    expect(w.cell("p2").status).toBe("رقم من دولة أخرى");
  });

  it("a validator that says the number is not valid keeps it «غير موثّق»; a validator that fails is skipped and the number stays «غير موثّق» (never «موثّق»)", async () => {
    const bad = await world({ people: [person(1)], answers: (ep) => (ep === FIND.id ? { phone: "+201001234567" } : ep === VALIDATE.id ? { results: [{ error: "NONE", telephone_number_type: "INVALID" }] } : null) });
    await bad.run();
    expect(bad.cell("p1").status).toBe("غير موثّق");
    const down = await world({ people: [person(1)], answers: (ep) => (ep === FIND.id ? { phone: "+201001234567" } : ep === VALIDATE.id ? "fail" : null) });
    await down.run();
    expect(down.cell("p1")).toMatchObject({ phone: "201001234567", status: "غير موثّق" });
  });

  it("the country of a company with no country field is the country the customer asked for (the place filter of its stage)", async () => {
    const w = await world({ people: [person(1)], company: { id: "c1", name: "Falcon Misr Electromechanical", website: "falconmisr.com" }, answers: (ep, p) => (ep === FIND.id ? { phone: "+18582549559" } : ep === VALIDATE.id ? hlr(p) : null) });
    await w.run();
    expect(w.cell("p1").status).toBe("رقم من دولة أخرى");
  });
});

describe("money: the helpers' prices are inside the step's priced amount and the job budget; decision makers first", () => {
  it("room for the company-phone search of one company and its validation only: the chief executive is done, the rest keep empty cells", async () => {
    const people = [person(1, "Site Engineer"), person(2, "Chief Executive Officer")];
    const w = await world({ people, perPersonUsd: 0.0005 + 0.00015 + 0.000001, ceilingUsd: 0.0008, answers: (ep, p) => (ep === FIND.id ? null : ep === MAPS.id ? egyptianMaps : ep === VALIDATE.id ? hlr(p) : null) });
    await w.run();
    expect(w.budget.spentUsd()).toBeLessThanOrEqual(0.0008 + 1e-9);
    expect(w.cell("p2").type).toBe("رقم الشركة");
  });
  it("the step's cap: a search that would pass the step's priced amount is not bought", async () => {
    const w = await world({ people: [person(1)], perPersonUsd: 0.0001, answers: (ep, p) => (ep === FIND.id ? null : ep === MAPS.id ? egyptianMaps : ep === VALIDATE.id ? hlr(p) : null) });
    await w.run();
    expect(w.calls.some((c) => c.endpoint === MAPS.id)).toBe(false);
    expect(w.cell("p1")).toEqual({ phone: "", status: "", type: "" });
  });
});

describe("the pure pieces", () => {
  it("the country of a company: its country field, else the customer's place, else a place text, else its website's suffix", () => {
    expect(companyCountryOf({ row: { country: "EG" } })).toBe("EG");
    expect(companyCountryOf({ row: { country_name: "Saudi Arabia" } })).toBe("SA");
    expect(companyCountryOf({ row: { name: "x" }, requestPlaces: ["EG:cairo"] })).toBe("EG");
    expect(companyCountryOf({ row: { location: "Milan, Italy" } })).toBe("IT");
    expect(companyCountryOf({ row: {}, domain: "x.com.eg" })).toBe("EG");
    expect(companyCountryOf({ row: {}, domain: "x.com" })).toBeNull();
  });
  it("the validator's answer, and the status", () => {
    const egypt = phoneVerdictIn({ results: [{ error: "NONE", detected_telephone_number: "20223456789", telephone_number_type: "LANDLINE", original_network_details: { country_iso3: "EGY", country_prefix: "20" } }] });
    expect(egypt).toEqual({ valid: true, countries: ["EG"] });
    expect(phoneVerdictIn({ results: [{ error: "INVALID_NUMBER" }] }).valid).toBe(false);
    expect(phoneVerdictIn({}).valid).toBeNull();
    expect(phoneStatusOf({ number: "+20223456789", verdict: egypt, companyCountry: "EG" })).toBe("verified");
    expect(phoneStatusOf({ number: "+18582549559", verdict: { valid: true, countries: ["US"] }, companyCountry: "EG" })).toBe("other_country");
    expect(phoneStatusOf({ number: "+18582549559", verdict: null, companyCountry: "EG" })).toBe("other_country");
    expect(phoneStatusOf({ number: "+18582549559", verdict: { valid: true, countries: ["US"] }, companyCountry: null })).toBe("verified");
    expect(phoneStatusOf({ number: "01001234567", verdict: null, companyCountry: "EG" })).toBe("unverified");
  });
  it("the validator's parameters: digits without «+», the country hint for a national number only", () => {
    expect(validatorParamsFor(VALIDATE, "+20 2 2345 6789", "EG")).toEqual({ telephone_number: "20223456789" });
    expect(validatorParamsFor(VALIDATE, "02 2345 6789", "EG")).toEqual({ telephone_number: "0223456789", input_format: "EGY" });
    expect(validatorParamsFor(VALIDATE, "12", "EG")).toBeNull();
  });
  it("the company's phone from a row, and from a map answer only when the place is the company", () => {
    expect(companyPhoneOfRow({ name: "x", phone: "+20 2 2345 6789" })).toBe("+20 2 2345 6789");
    expect(companyPhoneOfRow({ name: "x", phone: "n/a" })).toBeNull();
    const id = companyIdentityOf(FALCON);
    expect(placePhoneIn(egyptianMaps, id)).toBe("+20 2 2345 6789");
    expect(placePhoneIn({ places: [{ title: "Other", phone: "+20 2 1111 1111" }] }, id)).toBeNull();
    expect(mapsParamsFor(MAPS, { name: "Falcon", city: "Cairo", country: "EG" })).toEqual({ query: "Falcon Cairo", country: "eg" });
  });
});

describe("the plan: validators and company-phone searches ranked from the catalog, the type column, the price", () => {
  const catalog = loadTregCatalog();
  const allowed = () => true;
  it("the validators are the catalog's direct synchronous phone validators, the free one first", () => {
    const list = validatorSourcesOf(catalog, allowed);
    expect(list[0].id).toBe("hlrlookup.people.phone.validate");
    for (const v of list) expect(catalog.byId.get(v.id)!.capability).toBe("people.phone.verify");
  });
  it("the company-phone searches are the catalog's map searches that take a query and nothing else required", () => {
    const list = companyPhoneSourcesOf(catalog, allowed);
    expect(list.length).toBeGreaterThan(0);
    for (const m of list) expect(catalog.byId.get(m.id)!.capability).toBe("google.serp.maps");
    const usd = list.map((m) => m.usd);
    expect(usd[0]).toBeLessThanOrEqual(usd[usd.length - 1]);
  });
  it("a phone step carries its validators, its company-phone searches and the type key, priced at finder + assumed fallback share + search + validator; its type column follows its status column", () => {
    const stages = [{ key: "people", title_ar: "موظفو كل شركة", parent_key: "companies", deliver: true, role_preference: { role: "manager" }, columns: [{ key: "phone", kind: "phone" }] }];
    const [step] = buildContactSteps(stages as any, "رقم التليفون", () => [FIND], (kind) => (kind === "phone" ? { validators: [VALIDATE], company_phone: [MAPS] } : {}));
    expect(step.type_key).toBe("phone_type");
    // CHANGED (owner decision after #321): the company-phone search is priced for the share of persons the finder misses (measured), not for everyone
    const chain = chainExpectation([FIND], "phone");
    expect(step.per_person_usd).toBeCloseTo(chain.costUsd + chain.missShare * MAPS.usd + VALIDATE.usd, 9);
    const cols = withContactColumns("people", [{ key: "full_name", title_ar: "الاسم" }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" as const }], [step]);
    expect(cols.map((c) => c.key)).toEqual(["full_name", "phone", "phone_status", "phone_type"]);
    expect(cols[3].title_ar).toBe("نوع الرقم");
  });
});
