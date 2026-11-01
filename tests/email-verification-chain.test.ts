import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { EMAIL_FOUND_SHARE, buildContactSteps, verifierSourcesOf, type ContactStep, type FinderInfo } from "../src/lib/agentMission/contactFinders";
import { emailOnOtherDomain, emailVerdictIn } from "../src/lib/agentMission/emailVerification";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/**
 * ITEM 2 (live test A1, 2026-11-01): 4 e-mails marked «موثّق» that no verifier had seen; an ISSS person had an address on another company's domain (saudisicli.com.sa) and it was «موثّق» too. The chain is: finder, fallback finder, VERIFIER.
 *   «موثّق»                    only when a verifier answered deliverable (safe / valid) and not catch-all;
 *   «غير موثّق»                found but not verified (no verifier answered, the budget had no room) or catch-all / undeliverable / unknown;
 *   «غير موثّق لهذه الشركة»    the address's domain differs from the company's domain. A found value is never dropped.
 */
const MISSION = "msn_verify";
const FIND_A: FinderInfo = { id: "cheap.people.email.find", usd: 0.000495, inputs: [{ name: "person_linkedin_url", required: true }] };
const FIND_B: FinderInfo = { id: "dear.people.email.find", usd: 0.004834, inputs: [{ name: "company_url", required: false }, { name: "first_name", required: false }, { name: "last_name", required: false }] };
const VERIFY_A: FinderInfo = { id: "first.people.email.verify", usd: 0.00124, inputs: [{ name: "email", required: true }] };
const VERIFY_B: FinderInfo = { id: "second.people.email.verify", usd: 0.0018, inputs: [{ name: "email", required: true }] };
const columns = [{ key: "full_name", title_ar: "الاسم" }, { key: "job_title", title_ar: "المسمى الوظيفي" }, { key: "linkedin", title_ar: "الملف المهني" }, { key: "email", title_ar: "الإيميل", kind: "work_email" as const }, { key: "email_status", title_ar: "حالة توثيق الإيميل", status_of: "email" }];
const person = (i: number, title = "General Manager", email = "") => ({ id: `p${i}`, parent_id: "c1", full_name: `Person${i} Name${i}`, job_title: title, linkedin: `https://www.linkedin.com/in/person${i}`, email });
const safe = { status: "safe", deliverable: true, is_catch_all: false };

type Answer = unknown | "fail" | "refuse";
async function world(opts: { people: Array<ReturnType<typeof person>>; website?: string; verifiers?: FinderInfo[]; finders?: FinderInfo[]; perPersonUsd?: number; ceilingUsd?: number; answers: (endpoint: string, params: Record<string, unknown>) => Answer }) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, MISSION);
  await items.commit([
    { t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", name: "ISSS", website: opts.website ?? "https://www.isssystems.com/" } },
    ...opts.people.map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: { ...p } })),
  ]);
  const finders = opts.finders ?? [FIND_A];
  const verifiers = opts.verifiers === undefined ? [VERIFY_A] : opts.verifiers;
  const step: ContactStep = { kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: opts.perPersonUsd ?? 0.01, finders, ...(verifiers.length > 0 ? { verifiers } : {}) };
  const plan: any = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }], planned_rows: 1 }, { key: "people", parent_key: "companies", title_ar: "موظفو كل شركة", deliver: true, columns, planned_rows: opts.people.length, role_preference: { role: "manager" } }], contact_steps: [step] };
  const budget = createJobCallBudget({ ceilingUsd: opts.ceilingUsd ?? 1, spentUsd: 0 });
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let n = 0;
  const priced = new Map([...finders, ...verifiers].map((f) => [f.id, f.usd] as const));
  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      calls.push({ endpoint: a.endpoint_id, params: a.params });
      const out = opts.answers(a.endpoint_id, a.params);
      if (out === "refuse") return { ok: false, call_id: `call_${++n}`, refused: "over_budget", message: "no" };
      if (out === "fail") return { ok: false, call_id: `call_${++n}`, failed: true, http_status: 429, message: "rate limit" };
      const id = `call_${String(++n).padStart(4, "0")}`;
      await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json");
      if (out !== null) budget.settle(0, priced.get(a.endpoint_id) ?? 0);
      return { ok: true, call_id: id, http_status: 200, rows_in_page: out !== null ? 1 : 0, has_more: false, next_cursor: null };
    },
  };
  const run = () => runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async () => {}, budget, deadlineMs: Date.now() + 60_000 });
  const cell = (id: string) => { const r = items.acceptedRows("people").find((x) => x.id === id)!; return { email: String(r.email ?? ""), status: String(r.email_status ?? "") }; };
  return { items, budget, calls, run, cell };
}
const byLinkedin = (p: Record<string, unknown>) => String(p.person_linkedin_url).split("/in/")[1];

describe("the verifier decides «موثّق»", () => {
  it("a found address on the company's domain that the verifier calls safe and deliverable is «موثّق»; the verifier is asked with the address", async () => {
    const w = await world({ people: [person(1)], answers: (ep, p) => (ep === FIND_A.id ? { email: `${byLinkedin(p)}@isssystems.com` } : ep === VERIFY_A.id ? safe : null) });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "person1@isssystems.com", status: "موثّق" });
    expect(w.calls.filter((c) => c.endpoint === VERIFY_A.id).map((c) => c.params)).toEqual([{ email: "person1@isssystems.com" }]);
  });

  it("the finder says the address is verified but no verifier is in the plan: the address is kept as «غير موثّق» (a finder's own claim is not a verification)", async () => {
    const w = await world({ people: [person(1)], verifiers: [], answers: (ep, p) => (ep === FIND_A.id ? { email: `${byLinkedin(p)}@isssystems.com`, verified: true, verification: { status: "valid" } } : null) });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "person1@isssystems.com", status: "غير موثّق" });
  });

  it("catch-all, undeliverable and unknown answers keep the address as «غير موثّق»", async () => {
    const verdicts: Record<string, unknown> = { person1: { status: "safe", deliverable: true, is_catch_all: true }, person2: { status: "invalid", deliverable: false }, person3: { status: "unknown" } };
    const w = await world({ people: [person(1), person(2), person(3)], answers: (ep, p) => (ep === FIND_A.id ? { email: `${byLinkedin(p)}@isssystems.com` } : ep === VERIFY_A.id ? verdicts[String(p.email).split("@")[0]] : null) });
    await w.run();
    for (const id of ["p1", "p2", "p3"]) expect(w.cell(id)).toMatchObject({ status: "غير موثّق" });
    expect(w.cell("p1").email).toBe("person1@isssystems.com");
  });

  it("LIVE SHAPE (ISSS): an address on another company's domain (saudisicli.com.sa) is kept as «غير موثّق لهذه الشركة», never «موثّق», and no verifier is paid for it", async () => {
    const w = await world({ people: [person(1)], answers: (ep) => (ep === FIND_A.id ? { email: "sales@saudisicli.com.sa" } : ep === VERIFY_A.id ? safe : null) });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "sales@saudisicli.com.sa", status: "غير موثّق لهذه الشركة" });
    expect(w.calls.some((c) => c.endpoint === VERIFY_A.id)).toBe(false);
  });

  it("an address on a subdomain of the company's domain is the company's", async () => {
    const w = await world({ people: [person(1)], answers: (ep) => (ep === FIND_A.id ? { email: "x@mail.isssystems.com" } : ep === VERIFY_A.id ? safe : null) });
    await w.run();
    expect(w.cell("p1").status).toBe("موثّق");
  });

  it("an address the SOURCE already gave (a people row with an e-mail) goes through the verifier too, with no finder call", async () => {
    const w = await world({ people: [person(1, "General Manager", "given@isssystems.com")], answers: (ep) => (ep === VERIFY_A.id ? safe : null) });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "given@isssystems.com", status: "موثّق" });
    expect(w.calls.some((c) => c.endpoint === FIND_A.id)).toBe(false);
  });

  it("a verifier that is rate limited does not stop the chain: the next ranked verifier answers, and the broken one is not asked again after two failures", async () => {
    const w = await world({ people: [person(1), person(2), person(3), person(4)], verifiers: [VERIFY_A, VERIFY_B], answers: (ep, p) => (ep === FIND_A.id ? { email: `${byLinkedin(p)}@isssystems.com` } : ep === VERIFY_A.id ? "fail" : ep === VERIFY_B.id ? safe : null) });
    await w.run();
    for (const id of ["p1", "p2", "p3", "p4"]) expect(w.cell(id).status).toBe("موثّق");
    expect(w.calls.filter((c) => c.endpoint === VERIFY_A.id).length).toBe(2);
    expect(w.calls.filter((c) => c.endpoint === VERIFY_B.id).length).toBe(4);
  });

  it("finder, then the fallback finder, then the verifier: a miss of the first finder goes to the second, whose address is verified", async () => {
    const w = await world({ people: [person(1)], finders: [FIND_A, FIND_B], answers: (ep) => (ep === FIND_A.id ? null : ep === FIND_B.id ? { email: "fallback@isssystems.com" } : ep === VERIFY_A.id ? safe : null) });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "fallback@isssystems.com", status: "موثّق" });
    expect(w.calls.map((c) => c.endpoint)).toEqual([FIND_A.id, FIND_B.id, VERIFY_A.id]);
  });

  it("MONEY: the verifier's price is inside the step's priced amount (finder + verifier per person) and the job budget; decision makers are done completely first", async () => {
    // room for two complete lookups (finder 0.000495 + verifier 0.00124 = 0.001735 each) and not a third
    const w = await world({ people: [person(1, "Site Engineer"), person(2, "Chief Executive Officer"), person(3, "Accountant"), person(4, "General Manager")], perPersonUsd: 0.001735, ceilingUsd: 0.0035, answers: (ep, p) => (ep === FIND_A.id ? { email: `${byLinkedin(p)}@isssystems.com` } : ep === VERIFY_A.id ? safe : null) });
    const out = await w.run();
    expect(["p1", "p2", "p3", "p4"].filter((id) => w.cell(id).email !== "").sort()).toEqual(["p2", "p4"]);
    expect(["p2", "p4"].map((id) => w.cell(id).status)).toEqual(["موثّق", "موثّق"]);
    expect(out.stopped).toBe("budget");
    expect(w.budget.spentUsd()).toBeLessThanOrEqual(0.0035 + 1e-9);
  });

  it("when the budget has room for the finder but not the verifier, the address is delivered «غير موثّق» (never dropped, never unbought)", async () => {
    const w = await world({ people: [person(1)], perPersonUsd: 0.001735, ceilingUsd: 0.001, answers: (ep, p) => (ep === FIND_A.id ? { email: `${byLinkedin(p)}@isssystems.com` } : ep === VERIFY_A.id ? safe : null) });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "person1@isssystems.com", status: "غير موثّق" });
    expect(w.calls.some((c) => c.endpoint === VERIFY_A.id)).toBe(false);
  });
});

describe("the pure pieces", () => {
  it("a verifier's answer, whatever its fields are called", () => {
    expect(emailVerdictIn({ status: "safe", deliverable: true, is_catch_all: false })).toBe("deliverable");
    expect(emailVerdictIn({ data: { result: { status: "valid" } } })).toBe("deliverable");
    expect(emailVerdictIn({ results: [{ deliverability: "deliverable", accept_all: false }] })).toBe("deliverable");
    expect(emailVerdictIn({ status: "safe", deliverable: true, is_catch_all: true })).toBe("catch_all");
    expect(emailVerdictIn({ result: "accept_all" })).toBe("catch_all");
    expect(emailVerdictIn({ status: "invalid" })).toBe("undeliverable");
    expect(emailVerdictIn({ deliverable: false })).toBe("undeliverable");
    expect(emailVerdictIn({ status: "risky" })).toBe("unknown");
    expect(emailVerdictIn({})).toBe("unknown");
    expect(emailVerdictIn(null)).toBe("unknown");
  });
  it("the company's domain", () => {
    expect(emailOnOtherDomain("a@saudisicli.com.sa", "isssystems.com")).toBe(true);
    expect(emailOnOtherDomain("a@gmail.com", "isssystems.com")).toBe(true);
    expect(emailOnOtherDomain("a@mail.isssystems.com", "isssystems.com")).toBe(false);
    expect(emailOnOtherDomain("a@isssystems.com", null)).toBe(false);
  });
});

describe("the plan: ranked verifiers from the catalog, priced by code", () => {
  const catalog = loadTregCatalog();
  const allowed = () => true;
  it("verifiers are the catalog's direct, synchronous e-mail verifiers that take only an address, cheapest first, at most three; a routed one (its cost is a range) is never one", () => {
    const list = verifierSourcesOf(catalog, allowed);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.length).toBeLessThanOrEqual(3);
    for (const v of list) {
      const e = catalog.byId.get(v.id)!;
      expect(e.capability).toBe("people.email.verify");
      expect(e.kind).toBe("direct");
      expect(e.async).toBeFalsy();
      expect(v.inputs.some((i) => /^e-?mail$/i.test(i.name))).toBe(true);
    }
    expect(list.map((v) => v.id)).not.toContain("treg.people.email.verify");
    const usd = list.map((v) => v.usd);
    expect([...usd].sort((a, b) => a - b)).toEqual(usd);
  });
  it("a step's price per person is the finder plus the verifier for the share of people an address is found for: a free first verifier that may be rate limited is priced at the next one", () => {
    const stages = [{ key: "people", title_ar: "موظفو كل شركة", parent_key: "companies", deliver: true, role_preference: { role: "manager" }, columns: [{ key: "email", kind: "work_email" }] }];
    const finders = () => [FIND_A];
    const [step] = buildContactSteps(stages as any, "عايز الإيميل", finders, (kind) => (kind === "email" ? { verifiers: [{ id: "free.verify", usd: 0.000001, inputs: [{ name: "email", required: true }] }, VERIFY_A] } : {}));
    expect(step.verifiers?.map((v) => v.id)).toEqual(["free.verify", VERIFY_A.id]);
    expect(step.per_person_usd).toBeCloseTo(FIND_A.usd + EMAIL_FOUND_SHARE * VERIFY_A.usd, 9);
  });
});
