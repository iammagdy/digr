import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { NOT_ADMIN } from "./helpers/agentHarness";
import { finderHitRate } from "../src/lib/agentMission/finderStats";
import { FALLBACK_FINDER_MAX_USD, PHONE_FINDER_MAX_USD, finderParamsFor, finderSourcesOf, foundContactIn, missingInputsFor, personFactsOf, type ContactStep, type FinderInfo } from "../src/lib/agentMission/contactFinders";

/**
 * DT-20261118-03 F1-c (Megz D-0084: the person's OWN phone is core; the company's number is never a stand-in). Live chat A: 0 of 5 personal phones. Three defects of OURS, none of them «the data does not exist»:
 *   - mapping: the answer of 6 of the catalog's person-phone finders was not read (quickenrich «employee_phone», dropleads «mobile_number», limadata «phone_numbers[].number», tomba «intl_format», contactout «phone: [...]», aiark «data: [[...]]»);
 *   - inputs: a profile written without https:// (aviato «linkedin.com/in/…») was not a profile, so a finder that needs it was skipped, in silence;
 *   - the company's number filled the person's cell and hid the miss.
 */
const catalog = loadTregCatalog();
const exampleOf = (id: string): unknown => (catalog.byId.get(id) as unknown as { example_response_trimmed?: unknown })?.example_response_trimmed;

describe("every person-phone answer shape of the catalog is read", () => {
  it.each([
    ["quickenrich.people.phone.find", "+15550101000"],
    ["dropleads.people.phone.find", "+12025550123"],
    ["limadata.people.phone.find", "+12025550123"],
    ["tomba.people.phone.find", "+1 415-555-0142"],
    ["contactout.people.contact.phone", "+10000000000"],
    ["aiark.people.phone.find", "+15555550100"],
    ["blitzapi.people.phone.find", "+14155550123"],
    ["aviato.people.phone.find", "+12025550100"],
    ["prospeo.people.phone.find", "+15555550100"],
    ["leadsforge.people.phone.find", "+14155550134"],
    ["sixtyfour.people.phone.find", "+14155550123"],
  ])("%s → %s", (id, phone) => {
    expect(foundContactIn("phone", exampleOf(id))?.value.replace(/\D/g, "")).toBe(phone.replace(/\D/g, ""));
  });
  it("a miss is no value, and a date in a list is never a phone", () => {
    expect(foundContactIn("phone", exampleOf("leadmagic.people.phone.find"))).toBeNull();
    expect(foundContactIn("phone", { dates: ["2026-11-16", "2026-11-17"], count: 3 })).toBeNull();
  });
});

// BUG HUNTER Gate 1 delta P1: the reader takes the PERSON's number only, never a fax, an office, a company or employer line, never a bare «number», a postal code or an id
describe("the reader takes the person's own number only", () => {
  it.each([
    ["a fax list", { fax: ["+20 2 3333 4444"] }, null],
    ["a company_phones list", { company_phones: ["+20 2 2222 3333"] }, null],
    ["an office_numbers list", { office_numbers: ["+20 2 2222 3333", "+20 100 111 2222"] }, null],
    ["«number» as an employee count", { name: "X", number: 5000000 }, null],
    ["«number» of a street", { address: { number: "12345678" } }, null],
    ["a phone typed fax", { phone_numbers: [{ number: "+20 2 3333 4444", type: "fax" }] }, null],
    ["a fax_number key", { fax_number: "+20 2 3333 4444" }, null],
    ["postal codes", { postal_codes: ["01234567", "07654321"] }, null],
    ["ids", { ids: ["0012345678"] }, null],
    ["national numbers in a bare list", { numbers: ["0100 111 2222"] }, null],
    ["a tag with digits", { tags: ["0800 FLOWERS"] }, null],
    ["the mobile after a fax", { phone_numbers: [{ number: "+20 2 3333 4444", type: "fax" }, { number: "+20 100 111 2222", type: "mobile" }] }, "201001112222"],
    ["the person's mobile, not the company's phone before it", { company: { phone: "+20 2 2222 3333" }, person: { mobile_phone: "+20 100 111 2222" } }, "201001112222"],
    ["the person's mobile, not the employer's phones", { employer: { phones: [{ phoneNumber: "+20 2 2222 3333" }] }, mobile: "+20 100 111 2222" }, "201001112222"],
    ["a tel key", { tel: "+20 100 111 2222" }, "201001112222"],
    ["a personal_mobile key", { personal_mobile: "+20 100 111 2222" }, "201001112222"],
  ])("%s", (_name, page, digits) => {
    const r = foundContactIn("phone", page);
    expect(r === null ? null : r.value.replace(/\D/g, "")).toBe(digits);
  });
});

const BLITZ: FinderInfo = { id: "blitzapi.people.phone.find", usd: 0.000495, inputs: [{ name: "person_linkedin_url", required: true }] };
describe("the person's inputs", () => {
  const columns = [{ key: "name", title_ar: "اسم المدير" }, { key: "linkedin", title_ar: "الملف المهني" }];
  it("a profile without https:// is the person's profile and is given to the finder with it", () => {
    const facts = personFactsOf({ id: "p1", name: "Mina Naguib", linkedin: "linkedin.com/in/mina-naguib" }, columns, { website: "orascom-em.com.eg" });
    expect(facts.linkedin).toBe("https://linkedin.com/in/mina-naguib");
    expect(finderParamsFor(BLITZ, facts)).toEqual({ person_linkedin_url: "https://linkedin.com/in/mina-naguib" });
  });
  it("a finder the person cannot be given says which input was missing", () => {
    const facts = personFactsOf({ id: "p1", name: "Mina Naguib" }, columns, { website: "orascom-em.com.eg" });
    expect(missingInputsFor(BLITZ, facts)).toEqual(["person_linkedin_url"]);
  });
});

describe("D-0084: the company's number is never written in a person's phone cell", () => {
  const run = async (people: Array<Record<string, unknown>>, answers: (ep: string) => unknown, companyPhone?: string) => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_p");
    await items.commit([
      { t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", name: "Falcon Misr", website: "https://www.falconmisr.com/", country: "EG", ...(companyPhone ? { phone: companyPhone } : {}) } as any },
      ...people.map((p) => ({ t: "item" as const, stage: "people", id: String(p.id), state: "accepted" as const, by: "rule" as const, row: { parent_id: "c1", phone: "", ...p } })),
    ]);
    // the person's phone step as buildContactSteps now makes it: the person's finders only, no company-number search
    const step: ContactStep = { kind: "phone", stage_key: "people", column_key: "phone", status_key: "phone_status", type_key: "phone_type", per_person_usd: 0.01, finders: [BLITZ] };
    const plan: any = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }], planned_rows: 1 }, { key: "people", parent_key: "companies", title_ar: "صناع القرار", deliver: true, columns: [{ key: "full_name", title_ar: "الاسم" }, { key: "linkedin", title_ar: "الملف المهني" }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" }], planned_rows: people.length }], contact_steps: [step] };
    const calls: string[] = [];
    let n = 0;
    const gateway: any = { async tregCall(a: { endpoint_id: string }) { calls.push(a.endpoint_id); const out = answers(a.endpoint_id); const id = `call_${String(++n).padStart(4, "0")}`; await store.putFile("msn_p", `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json"); return { ok: true, call_id: id, http_status: 200, rows_in_page: out ? 1 : 0, has_more: false, next_cursor: null }; } };
    await runContactEnrichment({ items, store, plan, missionId: "msn_p", gateway, addEvent: async () => {}, budget: createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 }), deadlineMs: Date.now() + 60_000 });
    const cell = (id: string) => { const r = items.acceptedRows("people").find((x) => x.id === id)!; return { phone: String(r.phone ?? ""), type: String(r.phone_type ?? "") }; };
    return { store, calls, cell };
  };
  it("no personal phone found: the cell stays empty and no map search is paid for", async () => {
    const w = await run([{ id: "p1", full_name: "Mina Naguib", linkedin: "linkedin.com/in/mina-naguib" }], (ep) => (ep.includes("maps") ? { places: [{ title: "Falcon Misr", phone: "+20 2 2345 6789" }] } : null));
    expect(w.cell("p1")).toEqual({ phone: "", type: "" });
    expect(w.calls).toEqual([BLITZ.id]);
  });
  // BUG HUNTER Gate 1 delta P0: the company ROW's own phone was copied into the person's cell with no search at all
  it("the company row's own phone is never copied into a person's cell", async () => {
    const w = await run([{ id: "p1", full_name: "Mina Naguib", linkedin: "linkedin.com/in/mina-naguib" }], () => null, "+20 2 2345 6789");
    expect(w.cell("p1")).toEqual({ phone: "", type: "" });
    expect(w.calls).toEqual([BLITZ.id]);
  });
  it("a profile without https:// reaches the finder and the person's own number is written as «شخصي»", async () => {
    const w = await run([{ id: "p1", full_name: "Mina Naguib", linkedin: "linkedin.com/in/mina-naguib" }], (ep) => (ep === BLITZ.id ? { found: true, phone: "+201001234567" } : null));
    expect(w.cell("p1")).toEqual({ phone: "+201001234567", type: "شخصي" });
  });
  it("a person the finder cannot be given is recorded in the mission's file with the missing input, never skipped in silence", async () => {
    const w = await run([{ id: "p1", full_name: "Mina Naguib" }, { id: "p2", full_name: "Sara Adel" }], () => null);
    expect(w.calls).toEqual([]);
    expect(JSON.parse((await w.store.getFile("msn_p", "contacts/not_tried_people_phone.json"))!)).toEqual({ [`${BLITZ.id}|person_linkedin_url`]: 2 });
  });
});

// DT-20261118-03 PR-2c (Megz D-0085, D-0086): the person-phone chain is chosen from the catalog by capability, price and measured rate only (no service named in code); a phone call may cost up to 0.05 USD, an e-mail call 0.02
describe("the person-phone chain, from catalog metadata only", () => {
  const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;
  it("phone finders up to 0.05 USD a call, cheapest per found number first, three at most; e-mail finders stay at 0.02", () => {
    expect(PHONE_FINDER_MAX_USD).toBe(0.05);
    const phone = finderSourcesOf("phone", catalog, allowed);
    expect(phone.length).toBe(3);
    for (const f of phone) expect(f.usd).toBeLessThanOrEqual(PHONE_FINDER_MAX_USD);
    expect(phone.some((f) => f.usd > FALLBACK_FINDER_MAX_USD)).toBe(true);
    const keys = phone.map((f) => f.usd / finderHitRate(f.id, "phone"));
    expect([...keys].sort((a, b) => a - b)).toEqual(keys);
    for (const f of finderSourcesOf("email", catalog, allowed)) expect(f.usd).toBeLessThanOrEqual(FALLBACK_FINDER_MAX_USD);
  });
  it("a finder is never called without a person identifier (a profile or a name): a company domain alone is not a person", () => {
    const anyOf: FinderInfo = { id: "x.people.phone.find", usd: 0.04, inputs: [{ name: "email", required: false }, { name: "domain", required: false }, { name: "linkedin", required: false }] };
    const columns = [{ key: "name", title_ar: "اسم المدير" }, { key: "linkedin", title_ar: "الملف المهني" }];
    expect(finderParamsFor(anyOf, personFactsOf({ id: "p1" }, columns, { website: "orascom-em.com.eg" }))).toBeNull();
    expect(finderParamsFor(anyOf, personFactsOf({ id: "p1", linkedin: "linkedin.com/in/mina" }, columns, { website: "orascom-em.com.eg" }))).toEqual({ domain: "orascom-em.com.eg", linkedin: "https://linkedin.com/in/mina" });
  });
});
