import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { contactCallKey, contactSrcKey, runContactEnrichment } from "../agent/src/engine/contacts";
import { emailValueTypeOf, finderSourcesOf, foundContactIn, mailboxListerSourcesOf, type ContactStep, type FinderInfo } from "../src/lib/agentMission/contactFinders";
import { verifyContactValue } from "../src/lib/agentMission/contacts";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NO_SENSITIVE_ACCESS, categoryOf, policyVerdict } from "../src/lib/treg/dataPolicy";
import { readFileSync } from "node:fs";

/**
 * PHASE 5: THE B2B CONTACT SERVICE (company -> employees -> professional identity -> work e-mail -> business phone), offline.
 *
 * The finder answers below are SIMULATED (labelled): no provider is called. The catalog, the data policy and the engine are the real ones. What is proven:
 *   - a named professional address on the company's domain is delivered with its status and its internal provenance (source id + recorded call id);
 *   - an address on another COMPANY's domain is kept and labelled «غير موثّق لهذه الشركة» (employer association), never «موثّق»;
 *   - a PRIVATE MAILBOX (gmail.com, outlook.com …) is never written in the work-email cell, for any account, and the next finder is asked;
 *   - a missing, masked or malformed value leaves the cell empty: nothing is invented;
 *   - a company's HQ phone is labelled «رقم الشركة» and carries its provenance;
 *   - the step fills cells only: no row is added, the delivered count (the charge's basis) does not depend on what was found;
 *   - an ordinary account's chain holds no sensitive endpoint.
 */
const MISSION = "msn_phase5_b2b";
const EMAIL_A: FinderInfo = { id: "cheap.people.email.find", usd: 0.0005, inputs: [{ name: "person_linkedin_url", required: true }] };
const EMAIL_B: FinderInfo = { id: "dear.people.email.find", usd: 0.0009, inputs: [{ name: "domain", required: true }, { name: "full_name", required: false }] };
const MAPS: FinderInfo = { id: "maps.google.serp.maps", usd: 0.001, inputs: [{ name: "q", required: true }] };
const columns = [{ key: "full_name", title_ar: "الاسم" }, { key: "job_title", title_ar: "المسمى الوظيفي" }, { key: "linkedin", title_ar: "الملف المهني" }, { key: "email", title_ar: "الإيميل", kind: "work_email" as const }, { key: "email_status", title_ar: "حالة توثيق الإيميل", status_of: "email" }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" as const }, { key: "phone_status", title_ar: "حالة توثيق رقم التليفون", status_of: "phone" }, { key: "phone_type", title_ar: "نوع الرقم", type_of: "phone" }];
const person = (i: number, title: string) => ({ id: `p${i}`, parent_id: "c1", full_name: `Person${i} Name${i}`, job_title: title, linkedin: `https://www.linkedin.com/in/person${i}`, email: "", phone: "" });
const PEOPLE = [person(1, "Chief Executive Officer"), person(2, "Sales Director"), person(3, "Accountant"), person(4, "Engineer")];
const slug = (p: Record<string, unknown>) => String(p.person_linkedin_url ?? "").split("/in/")[1] ?? String(p.full_name ?? "").split(" ")[0].toLowerCase();

async function world(answers: (endpoint: string, params: Record<string, unknown>) => unknown, steps?: ContactStep[]) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, MISSION);
  await items.commit([
    { t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", name: "Orascom EM", website: "https://www.orascom-em.com.eg", city: "Cairo", country: "Egypt" } },
    ...PEOPLE.map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: { ...p } })),
  ]);
  const plan: any = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }, { key: "city", title_ar: "المدينة" }], planned_rows: 1 }, { key: "people", parent_key: "companies", title_ar: "موظفو كل شركة", deliver: true, columns, planned_rows: PEOPLE.length, role_preference: { role: "manager" } }], contact_steps: steps ?? [
    { kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: 0.002, max_person_usd: 0.002, finders: [EMAIL_A, EMAIL_B] },
    { kind: "phone", stage_key: "people", column_key: "phone", status_key: "phone_status", type_key: "phone_type", per_person_usd: 0.002, max_person_usd: 0.002, finders: [], company_phone: [MAPS] },
  ] };
  const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
  const calls: Array<{ endpoint: string; params: Record<string, unknown>; id: string }> = [];
  let n = 0;
  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      const id = `${MISSION}:call_${++n}`;
      calls.push({ endpoint: a.endpoint_id, params: a.params, id });
      const out = answers(a.endpoint_id, a.params);
      if (out === "fail") return { ok: false, call_id: id, failed: true, http_status: 500, message: "x" };
      await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json");
      budget.settle(0, 0.0005);
      return { ok: true, call_id: id, http_status: 200, rows_in_page: out ? 1 : 0, has_more: false, next_cursor: null };
    },
  };
  const run = () => runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async () => undefined, budget, deadlineMs: Date.now() + 60_000 });
  const row = (id: string) => { const r = items.acceptedRows("people").find((x) => x.id === id)! as Record<string, unknown>; return { ...r, email: String(r.email ?? ""), email_status: String(r.email_status ?? ""), phone: String(r.phone ?? "") }; };
  return { store, items, calls, run, row };
}

describe("Phase 5 B2B: named employees with professional e-mails (simulated finder answers)", () => {
  it("each employee's own professional address lands on THEIR row, with its status and the source + call that gave it", async () => {
    const w = await world((ep, p) => (ep === EMAIL_A.id ? { found: true, email: `${slug(p)}@orascom-em.com.eg` } : null));
    const out = await w.run();
    for (const p of PEOPLE) {
      const r = w.row(p.id);
      // row identity: the address was asked with this person's own page, and written on this person's row only
      expect(r.email).toBe(`${p.id.replace("p", "person")}@orascom-em.com.eg`);
      expect(r.email_status).toBe("غير موثّق"); // no verifier in this world: a finder's claim is not a verification
      expect(r[contactSrcKey("email")]).toBe(EMAIL_A.id);
      const call = w.calls.find((c) => c.id === r[contactCallKey("email")])!;
      expect(call.endpoint).toBe(EMAIL_A.id);
      expect(call.params.person_linkedin_url).toBe(p.linkedin);
      expect(await w.store.getFile(MISSION, `raw/${call.id}.json`)).toContain(String(r.email));
    }
    expect(out.filled.email).toBe(PEOPLE.length);
    expect(out.withheld.personal_email).toBe(0);
  });

  it("employer association: an address on ANOTHER company's domain is kept but never «موثّق»: «غير موثّق لهذه الشركة»", async () => {
    const w = await world((ep, p) => (ep === EMAIL_A.id && slug(p) === "person1" ? { found: true, email: "person1@other-holding.com" } : null));
    await w.run();
    expect(w.row("p1")).toMatchObject({ email: "person1@other-holding.com", email_status: "غير موثّق لهذه الشركة" });
  });
});

describe("Phase 5 B2B: a private mailbox is not a work e-mail", () => {
  it("the classifier: a named company address is professional; free consumer mailboxes are private; junk is invalid", () => {
    expect(emailValueTypeOf("mina.naguib@orascom-em.com.eg")).toBe("professional");
    expect(emailValueTypeOf("info@acme.com")).toBe("professional");
    for (const p of ["someone@gmail.com", "A@Outlook.com", "x@yahoo.co.uk", "x@hotmail.fr", "x@icloud.com", "x@proton.me", " x@live.com "]) expect(emailValueTypeOf(p), p).toBe("personal_mailbox");
    for (const bad of ["", "not an address", "m****@x.com", "a@b", null, undefined]) expect(emailValueTypeOf(bad), String(bad)).toBe("invalid");
    // look-alike company domains are NOT private mailboxes
    expect(emailValueTypeOf("a@gmail.company.com")).toBe("professional");
    expect(emailValueTypeOf("a@mygmail.com")).toBe("professional");
  });

  it("a finder that returns a gmail / outlook address: nothing is written, the next finder is asked, its professional address is delivered; the withheld count says how many", async () => {
    const w = await world((ep, p) => {
      if (ep === EMAIL_A.id) return slug(p) === "person1" ? { found: true, email: "person1.private@gmail.com" } : slug(p) === "person2" ? { email: "p2@outlook.com" } : null;
      if (ep === EMAIL_B.id) return String(p.full_name).startsWith("Person1") ? { found: true, email: "person1@orascom-em.com.eg" } : null;
      return null;
    });
    const out = await w.run();
    expect(w.row("p1")).toMatchObject({ email: "person1@orascom-em.com.eg", [contactSrcKey("email")]: EMAIL_B.id });
    expect(w.row("p2")).toMatchObject({ email: "", email_status: "" });
    expect(JSON.stringify(w.items.acceptedRows("people"))).not.toMatch(/gmail\.com|outlook\.com/);
    expect(out.withheld.personal_email).toBe(2);
    expect(w.items.acceptedRows("people")).toHaveLength(PEOPLE.length);
  });

  it("the ingest rule agrees: a source's own private-mailbox value never passes the work-email check", () => {
    expect(verifyContactValue("work_email", "mona@gmail.com")).toBeNull();
    expect(verifyContactValue("work_email", "mona@orascom-em.com.eg")).toBe("mona@orascom-em.com.eg");
  });
});

describe("Phase 5 B2B: missing or invalid values are never invented", () => {
  it.each([
    ["no answer", null],
    ["found: false", { found: false }],
    ["a masked address", { email: "m****@orascom-em.com.eg" }],
    ["text that is not an address", { email: "contact via website" }],
  ])("%s: the cell stays empty and has no status, the person stays", async (_l, answer) => {
    const w = await world((ep) => (ep === EMAIL_A.id || ep === EMAIL_B.id ? answer : null));
    await w.run();
    for (const p of PEOPLE) expect(w.row(p.id)).toMatchObject({ email: "", email_status: "" });
    expect(w.items.acceptedRows("people")).toHaveLength(PEOPLE.length);
  });

  it("a phone that is too short or a repeated digit is no phone", () => {
    expect(foundContactIn("phone", { phone: "12-3 45" })).toBeNull();
    expect(verifyContactValue("phone", "0000000000")).toBeNull();
    expect(verifyContactValue("phone", "+20 100 123 4567")).not.toBeNull();
  });

  it("a failing finder is not a value: the next one is asked, and nothing is written from the failure", async () => {
    const w = await world((ep, p) => (ep === EMAIL_A.id ? "fail" : ep === EMAIL_B.id && String(p.full_name).startsWith("Person1") ? { email: "person1@orascom-em.com.eg" } : null));
    await w.run();
    expect(w.row("p1")).toMatchObject({ email: "person1@orascom-em.com.eg", [contactSrcKey("email")]: EMAIL_B.id });
  });
});

describe("Phase 5 B2B: business phone numbers", () => {
  it("no personal number: the company's HQ phone from a map search goes in, labelled «رقم الشركة», with the map search as its source (one search per company)", async () => {
    const place = { local_results: [{ title: "Orascom EM", website: "https://www.orascom-em.com.eg", phone: "+20 2 2461 1111" }] };
    const w = await world((ep) => (ep === MAPS.id ? place : null), [{ kind: "phone", stage_key: "people", column_key: "phone", status_key: "phone_status", type_key: "phone_type", per_person_usd: 0.002, max_person_usd: 0.002, finders: [], company_phone: [MAPS] }]);
    await w.run();
    const r = w.row("p1");
    expect(String(r.phone).replace(/\D/g, "")).toBe("20224611111");
    expect(r.phone_type).toBe("رقم الشركة");
    expect(r[contactSrcKey("phone")]).toBe(MAPS.id);
    expect(w.calls.filter((c) => c.endpoint === MAPS.id)).toHaveLength(1);
    for (const p of PEOPLE) expect(w.row(p.id).phone_type).toBe("رقم الشركة");
  });

  it("a map result for ANOTHER business (other website, other name) is not the company's phone: nothing is written", async () => {
    const other = { local_results: [{ title: "Totally Different Bakery", website: "https://bakery.example", phone: "+20 2 0000 1234" }] };
    const w = await world((ep) => (ep === MAPS.id ? other : null), [{ kind: "phone", stage_key: "people", column_key: "phone", status_key: "phone_status", type_key: "phone_type", per_person_usd: 0.002, max_person_usd: 0.002, finders: [], company_phone: [MAPS] }]);
    await w.run();
    expect(w.row("p1").phone).toBe("");
  });
});

describe("Phase 5 B2B: the company's own public mailbox", () => {
  it("a mailbox lister's answer gives the company's ROLE mailbox on its own domain (never a person's, never gmail), with its source and call", async () => {
    const LISTER: FinderInfo = { id: "lister.companies.emails", usd: 0.001, inputs: [{ name: "domain", required: true }] };
    const w = await world((ep) => (ep === LISTER.id ? { emails: ["ahmed.ali@orascom-em.com.eg", "orascom.em@gmail.com", "info@orascom-em.com.eg"] } : null), [{ kind: "email", level: "company", stage_key: "companies", column_key: "company_email", status_key: "company_email_status", per_person_usd: 0.001, max_person_usd: 0.001, finders: [LISTER] }]);
    await w.run();
    const c = w.items.acceptedRows("companies")[0] as Record<string, unknown>;
    expect(c.company_email).toBe("info@orascom-em.com.eg");
    expect(c[contactSrcKey("company_email")]).toBe(LISTER.id);
    expect(w.calls.find((x) => x.id === c[contactCallKey("company_email")])!.endpoint).toBe(LISTER.id);
  });
});

describe("Phase 5 B2B: money and access invariants", () => {
  it("the steps fill CELLS only: the people delivered (the charge's basis) are the same whether every finder answers or none does", async () => {
    const none = await world(() => null);
    await none.run();
    const all = await world((ep, p) => (ep === EMAIL_A.id ? { email: `${slug(p)}@orascom-em.com.eg` } : null));
    await all.run();
    expect(all.items.acceptedRows("people").map((r) => r.id)).toEqual(none.items.acceptedRows("people").map((r) => r.id));
    expect(all.items.acceptedRows("companies")).toHaveLength(1);
  });

  it("the provenance marks are internal: they start with «_» and the workbook writes only the stage's own columns", () => {
    expect(contactSrcKey("email").startsWith("_")).toBe(true);
    expect(contactCallKey("email").startsWith("_")).toBe(true);
    const wb = readFileSync("agent/src/workbook.ts", "utf-8");
    expect(wb).not.toMatch(/_src_|_call_/);
  });

  it("an ORDINARY account's finder chains hold no sensitive or blocked endpoint (real catalog and data policy)", () => {
    const catalog = loadTregCatalog();
    const allowed = (id: string) => policyVerdict(id, NO_SENSITIVE_ACCESS).allowed;
    const chains = [...finderSourcesOf("email", catalog, allowed), ...finderSourcesOf("phone", catalog, allowed), ...mailboxListerSourcesOf(catalog, allowed)];
    expect(chains.length).toBeGreaterThan(0);
    for (const f of chains) expect(["public", "b2b_contact"], f.id).toContain(categoryOf(f.id));
    // the personal-contact finders exist in the catalog and are sensitive
    expect(catalog.endpoints.filter((e) => /\.personal$/.test(e.capability ?? "")).every((e) => categoryOf(e.id) === "sensitive")).toBe(true);
  });
});
