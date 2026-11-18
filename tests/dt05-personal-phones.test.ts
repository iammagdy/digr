import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { NOT_ADMIN } from "./helpers/agentHarness";
import { peopleSourcesForCompanies } from "../src/lib/agentMission/childSources";
import {
  FINDERS_PER_STEP, SOURCE_PROFILE_KEY, alternateFinderSourcesOf, buildContactSteps, finderSourcesOf, profileLookupSourcesOf, profileUrlIn, withSourceProfiles,
  type ContactStep, type FinderInfo,
} from "../src/lib/agentMission/contactFinders";

/**
 * DT-20261118-05 item 4 (Megz D-0084, D-0031: a person's own phone is core; a missing field a catalog service offers is OUR defect). Live after #570: 0 of 4 personal phones. BUG HUNTER's probe of the real chain: a person with a professional
 * page is asked by three finders, a person with only a name by one, a person with neither by none. Four defects of ours, fixed by catalog structure only (no endpoint name in code):
 * (a) the page the people source gave one level down never reached the row; (b) a person without a page had no finder that takes a name and a domain, although the catalog has one; (c) the catalog's profile lookup (name + company → page)
 * was never asked; (d) the work e-mail the e-mail step had just found was no input of the phone step.
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;

const BLITZ: FinderInfo = { id: "fake.people.phone.by_profile", usd: 0.000495, bill: "success", inputs: [{ name: "person_linkedin_url", required: true }] };
const AIARK: FinderInfo = { id: "fake.people.phone.by_any", usd: 0.026335, bill: "success", inputs: [{ name: "linkedin", required: false }, { name: "domain", required: false }, { name: "name", required: false }] };
const TOMBA: FinderInfo = { id: "fake.people.phone.by_email", usd: 0.0445, bill: "success", inputs: [{ name: "email", required: false }, { name: "domain", required: false }, { name: "linkedin", required: false }] };
const QUICK: FinderInfo = { id: "fake.people.phone.by_name_domain", usd: 0.004834, bill: "success", inputs: [{ name: "linkedin_url", required: false }, { name: "company_url", required: false }, { name: "first_name", required: false }, { name: "last_name", required: false }] };
const LOOKUP: FinderInfo = { id: "fake.people.profile.url", usd: 0.019, bill: "success", inputs: [{ name: "firstname", required: true }, { name: "lastname", required: true }, { name: "companyOrDomain", required: false }] };
const EMAIL: FinderInfo = { id: "fake.people.email.by_name_domain", usd: 0.0005, bill: "success", inputs: [{ name: "domain", required: true }, { name: "full_name", required: false }] };

async function world(opts: { people: Array<Record<string, unknown>>; phone: Partial<ContactStep>; email?: boolean; answers: (endpoint: string, params: Record<string, unknown>) => unknown }) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, "msn_dt05");
  await items.commit([
    { t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", name: "Falcon Misr", website: "https://www.falconmisr.com/", country: "EG" } as any },
    ...opts.people.map((p) => ({ t: "item" as const, stage: "people", id: String(p.id), state: "accepted" as const, by: "rule" as const, row: { parent_id: "c1", phone: "", email: "", ...p } })),
  ]);
  const phone: ContactStep = { kind: "phone", stage_key: "people", column_key: "phone", status_key: "phone_status", type_key: "phone_type", per_person_usd: 0.01, max_person_usd: 0.1, finders: [BLITZ, AIARK, TOMBA], ...opts.phone } as ContactStep;
  const email: ContactStep = { kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: 0.0005, finders: [EMAIL] };
  const plan: any = {
    stages: [
      { key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }], planned_rows: 1 },
      { key: "people", parent_key: "companies", title_ar: "صناع القرار", deliver: true, columns: [{ key: "full_name", title_ar: "الاسم" }, { key: "email", title_ar: "الإيميل", kind: "work_email" }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" }], planned_rows: opts.people.length },
    ],
    contact_steps: [...(opts.email ? [email] : []), phone],
  };
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let n = 0;
  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      calls.push({ endpoint: a.endpoint_id, params: a.params });
      const out = opts.answers(a.endpoint_id, a.params);
      const id = `call_${String(++n).padStart(4, "0")}`;
      await store.putFile("msn_dt05", `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json");
      return { ok: true, call_id: id, http_status: 200, rows_in_page: out ? 1 : 0, has_more: false, next_cursor: null };
    },
  };
  await runContactEnrichment({ items, store, plan, missionId: "msn_dt05", gateway, addEvent: async () => {}, budget: createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 }), deadlineMs: Date.now() + 60_000 });
  const phoneOf = (id: string) => String(items.acceptedRows("people").find((x) => x.id === id)!.phone ?? "");
  const attempts = async () => JSON.parse((await store.getFile("msn_dt05", "contacts/attempts_people_phone.json")) ?? "null");
  return { calls, phoneOf, attempts };
}
const NAME_ONLY = { id: "p1", full_name: "Mina Naguib" };

describe("DT-20261118-05 item 4a: the professional page the people source gave one level down reaches the person", () => {
  it("a page under `person`, under `URLs`, as a key of its own or in a list of links is given to the person of the same name; a colleague's page inside another named object is not", () => {
    const page = {
      data: [
        { person: { fullName: "Mina Naguib", URLs: { linkedin: "linkedin.com/in/mina-naguib" } } },
        { name: "Sara Adel", linkedinURL: "https://www.linkedin.com/in/sara-adel" },
        { first_name: "Omar", last_name: "Hany", socials: ["https://x.com/omarhany", "linkedin.com/in/omar-hany"] },
        { full_name: "Hoda Samir", manager: { full_name: "Someone Else", linkedin: "https://www.linkedin.com/in/someone-else" } },
      ],
    };
    const rows = [{ id: "1", full_name: "Mina Naguib" }, { id: "2", full_name: "Sara Adel" }, { id: "3", full_name: "Omar Hany" }, { id: "4", full_name: "Hoda Samir" }, { id: "5", full_name: "Ali Fathy", linkedin: "https://www.linkedin.com/in/ali" }];
    const out = withSourceProfiles(page, rows, ["full_name"]);
    expect(out.map((r) => (r as Record<string, unknown>)[SOURCE_PROFILE_KEY] ?? null)).toEqual(["https://linkedin.com/in/mina-naguib", "https://www.linkedin.com/in/sara-adel", "https://linkedin.com/in/omar-hany", null, null]);
  });
  it("every people source of the catalog whose example answer carries a person's page gives it to a person of that answer", () => {
    const nameOf = (o: Record<string, unknown>): string => String(o.full_name ?? o.fullName ?? o.name ?? [o.first_name ?? o.firstName, o.last_name ?? o.lastName].filter(Boolean).join(" ") ?? "").trim();
    const namesIn = (node: unknown, out: string[] = []): string[] => {
      if (Array.isArray(node)) node.forEach((x) => namesIn(x, out));
      else if (node && typeof node === "object") { const n = nameOf(node as Record<string, unknown>); if (n) out.push(n); Object.values(node).forEach((v) => namesIn(v, out)); }
      return out;
    };
    const sources = peopleSourcesForCompanies(catalog, allowed).map((s) => catalog.byId.get(typeof s === "string" ? s : (s as { id: string }).id)).filter((e) => e && /linkedin\.[a-z.]+\/in\//i.test(JSON.stringify(e.example_response_trimmed ?? "")));
    expect(sources.length).toBeGreaterThan(0);
    for (const e of sources) {
      const rows = namesIn(e!.example_response_trimmed).map((n, i) => ({ id: String(i), full_name: n }));
      const out = withSourceProfiles(e!.example_response_trimmed, rows, ["full_name"]);
      expect(out.some((r) => typeof (r as Record<string, unknown>)[SOURCE_PROFILE_KEY] === "string"), e!.id).toBe(true);
    }
  });
});

describe("DT-20261118-05 item 4b: a person without a page is asked by the next ranked finder that takes a name and a domain", () => {
  it("the chain's finders the person cannot be asked by give their turn to the alternate; the phone is the person's own", async () => {
    const w = await world({ people: [NAME_ONLY], phone: { alternates: [QUICK] }, answers: (ep) => (ep === QUICK.id ? { data: { employee_phone: "+201001234567" } } : null) });
    expect(w.calls.map((c) => c.endpoint)).toEqual([AIARK.id, QUICK.id]);
    expect(w.calls[1].params).toEqual({ company_url: "falconmisr.com", first_name: "Mina", last_name: "Naguib" });
    expect(w.phoneOf("p1").replace(/\D/g, "")).toBe("201001234567");
  });
  it("an alternate dearer than what is left of the chain's price for one person is not asked, and the file says why", async () => {
    const DEAR: FinderInfo = { ...QUICK, id: "fake.people.phone.dear", usd: 0.08 }; // dearer than the whole chain (0.000495 + 0.026335 + 0.0445): a miss billed on a hit costs nothing, so only what was really billed counts
    const w = await world({ people: [NAME_ONLY], phone: { alternates: [DEAR] }, answers: () => null });
    expect(w.calls.map((c) => c.endpoint)).toEqual([AIARK.id]);
    expect((await w.attempts()).outcomes[`${DEAR.id}|not_tried:person_budget`]).toBe(1);
  });
  it("a person with a page keeps today's chain: the alternates are never asked once FINDERS_PER_STEP finders were", async () => {
    const w = await world({ people: [{ ...NAME_ONLY, linkedin: "https://www.linkedin.com/in/mina-naguib" }], phone: { alternates: [QUICK] }, answers: () => null });
    expect(w.calls.map((c) => c.endpoint)).toEqual([BLITZ.id, AIARK.id, TOMBA.id]);
    expect(FINDERS_PER_STEP).toBe(3);
  });
});

describe("DT-20261118-05 item 4c: the catalog's profile lookup is asked first for a person without a page", () => {
  it("the page it finds is given to the finders that need one", async () => {
    // the lookup is paid from the chain's own price for one person (0.000495 + 0.026335 here): it fits
    const w = await world({ people: [NAME_ONLY], phone: { finders: [BLITZ, AIARK], profile_lookup: [LOOKUP] }, answers: (ep) => (ep === LOOKUP.id ? { success: true, result: "https://www.linkedin.com/in/mina-naguib", status: "FOUND" } : ep === BLITZ.id ? { found: true, phone: "+201001234567" } : null) });
    expect(w.calls.map((c) => c.endpoint)).toEqual([LOOKUP.id, BLITZ.id]);
    expect(w.calls[0].params).toEqual({ firstname: "Mina", lastname: "Naguib", companyOrDomain: "falconmisr.com" });
    expect(w.calls[1].params).toEqual({ person_linkedin_url: "https://www.linkedin.com/in/mina-naguib" });
    expect(w.phoneOf("p1").replace(/\D/g, "")).toBe("201001234567");
  });
  it("a lookup dearer than the chain's own price for one person is not asked (no money change), and the file says why", async () => {
    const w = await world({ people: [NAME_ONLY], phone: { finders: [BLITZ], profile_lookup: [LOOKUP] }, answers: () => null });
    expect(w.calls).toEqual([]);
    expect((await w.attempts()).outcomes[`${LOOKUP.id}|not_tried:person_budget`]).toBe(1);
  });
  it("a person who already has a page is never looked up", async () => {
    const w = await world({ people: [{ ...NAME_ONLY, linkedin: "https://www.linkedin.com/in/mina-naguib" }], phone: { finders: [BLITZ], profile_lookup: [LOOKUP] }, answers: () => null });
    expect(w.calls.map((c) => c.endpoint)).toEqual([BLITZ.id]);
  });
  it("the page is read from any answer shape", () => {
    expect(profileUrlIn({ success: true, result: "https://www.linkedin.com/in/patrickcollison" })).toBe("https://www.linkedin.com/in/patrickcollison");
    expect(profileUrlIn({ data: [{ urls: ["linkedin.com/in/x-y"] }] })).toBe("https://linkedin.com/in/x-y");
    expect(profileUrlIn({ data: { company: "https://www.linkedin.com/company/stripe" } })).toBeNull();
  });
});

describe("DT-20261118-05 item 4d: the work e-mail the e-mail step found is an input of the phone step", () => {
  it("a phone finder that looks the number up from a work e-mail is asked with it", async () => {
    const w = await world({ people: [NAME_ONLY], email: true, phone: { finders: [TOMBA] }, answers: (ep) => (ep === EMAIL.id ? { email: "mina.naguib@falconmisr.com" } : ep === TOMBA.id ? { data: { e164_format: "+201001234567" } } : null) });
    expect(w.calls.map((c) => c.endpoint)).toEqual([EMAIL.id, TOMBA.id]);
    expect(w.calls[1].params).toEqual({ email: "mina.naguib@falconmisr.com", domain: "falconmisr.com" });
    expect(w.phoneOf("p1").replace(/\D/g, "")).toBe("201001234567");
  });
});

describe("DT-20261118-05 item 3: the attempts file is written on EVERY run", () => {
  it("also when nobody could be asked: every finder not tried, with the input the person lacked", async () => {
    const w = await world({ people: [{ id: "p1" }], phone: { finders: [BLITZ] }, answers: () => null });
    expect(w.calls).toEqual([]);
    expect(await w.attempts()).toEqual({ outcomes: { [`${BLITZ.id}|not_tried:missing:person_linkedin_url`]: 1 }, people: 1, stopped: null });
  });
  it("also when the stage has no people at all", async () => {
    const w = await world({ people: [], phone: { finders: [BLITZ] }, answers: () => null });
    expect(await w.attempts()).toEqual({ outcomes: {}, people: 0, stopped: null });
  });
});

describe("DT-20261118-05 item 4: the plan carries the alternates and the profile lookup from the catalog, and the price does not move", () => {
  const phoneChain = finderSourcesOf("phone", catalog, allowed);
  const alternates = alternateFinderSourcesOf("phone", catalog, allowed);
  const lookups = profileLookupSourcesOf(catalog, allowed);
  it("the alternates are the next ranked phone finders under the same ceiling; at least one takes a first and last name with a company domain; the catalog has a profile lookup", () => {
    expect(alternates.length).toBeGreaterThan(0);
    expect(alternates.some((a) => phoneChain.some((f) => f.id === a.id))).toBe(false);
    expect(alternates.some((a) => a.inputs.some((i) => /first/i.test(i.name)) && a.inputs.some((i) => /last/i.test(i.name)) && a.inputs.some((i) => /company|domain/i.test(i.name)))).toBe(true);
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((l) => l.usd <= 0.05)).toBe(true);
  });
  it("the phone step carries them; its price for one person (expected and at most) equals the step built without them", () => {
    const stages = [{ key: "companies", title_ar: "الشركات", parent_key: null, deliver: true, columns: [{ key: "name" }] }, { key: "people", title_ar: "صناع القرار", parent_key: "companies", deliver: true, columns: [{ key: "full_name" }, { key: "phone", kind: "phone" }] }];
    const without = buildContactSteps(stages, "ومعاهم التليفون", () => phoneChain, () => ({})).find((s) => s.kind === "phone")!;
    const withAids = buildContactSteps(stages, "ومعاهم التليفون", () => phoneChain, () => ({ alternates, profile_lookup: lookups })).find((s) => s.kind === "phone")!;
    expect(withAids.alternates).toEqual(alternates);
    expect(withAids.profile_lookup).toEqual(lookups);
    expect({ per: withAids.per_person_usd, max: withAids.max_person_usd, finders: withAids.finders }).toEqual({ per: without.per_person_usd, max: without.max_person_usd, finders: without.finders });
  });
});
