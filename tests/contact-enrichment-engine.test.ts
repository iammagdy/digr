import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { foundContactIn, personFactsOf, finderParamsFor, type ContactStep, type FinderInfo } from "../src/lib/agentMission/contactFinders";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/**
 * ITEM 2: THE ENGINE LOOKS EVERY DELIVERED PERSON UP (owner direction after the live test of 2026-11-01: 14 people, no e-mail, no phone cell filled although the finders returned values: msn_7a8b… called the e-mail finder 12 times, 2 hits, and no hit reached the file).
 * For each delivered person with a name and a company domain or a professional page: the cheapest ranked e-mail finder, then (phones asked, budget left) the cheapest phone finder; decision-maker titles first; the value goes in the cell and «موثّق» / «غير موثّق» in the status cell;
 * never more than the step's priced amount, never past the job budget; a person is never dropped, a cell is empty only when nothing was found.
 */
const MISSION = "msn_enrich";
const EMAIL_A: FinderInfo = { id: "cheap.people.email.find", usd: 0.0005, inputs: [{ name: "person_linkedin_url", required: true }] };
const EMAIL_B: FinderInfo = { id: "dear.people.email.find", usd: 0.0089, inputs: [{ name: "domain", required: true }, { name: "full_name", required: false }] };
const PHONE_A: FinderInfo = { id: "cheap.people.phone.find", usd: 0.0005, inputs: [{ name: "person_linkedin_url", required: true }] };
const columns = [{ key: "full_name", title_ar: "الاسم" }, { key: "job_title", title_ar: "المسمى الوظيفي" }, { key: "linkedin", title_ar: "الملف المهني" }, { key: "email", title_ar: "الإيميل", kind: "work_email" as const }, { key: "email_status", title_ar: "حالة توثيق الإيميل", status_of: "email" }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" as const }, { key: "phone_status", title_ar: "حالة توثيق رقم التليفون", status_of: "phone" }];
const person = (i: number, title: string) => ({ id: `p${i}`, parent_id: "c1", full_name: `Person${i} Name${i}`, job_title: title, linkedin: `https://www.linkedin.com/in/person${i}`, email: "", phone: "" });
const PEOPLE = [person(1, "Site Engineer"), person(2, "Chief Executive Officer"), person(3, "Accountant"), person(4, "General Manager"), person(5, "Technician")];

async function world(opts: { answers: (endpoint: string, params: Record<string, unknown>) => unknown | "refuse" | "fail"; steps?: ContactStep[]; ceilingUsd?: number; people?: typeof PEOPLE }) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, MISSION);
  await items.commit([
    { t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", name: "Orascom EM", website: "https://www.orascom-em.com.eg/home" } },
    ...(opts.people ?? PEOPLE).map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: { ...p } })),
  ]);
  const steps: ContactStep[] = opts.steps ?? [
    { kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: EMAIL_A.usd, finders: [EMAIL_A, EMAIL_B] },
    { kind: "phone", stage_key: "people", column_key: "phone", status_key: "phone_status", per_person_usd: PHONE_A.usd, finders: [PHONE_A] },
  ];
  const plan: any = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }], planned_rows: 1 }, { key: "people", parent_key: "companies", title_ar: "موظفو كل شركة", deliver: true, columns, planned_rows: PEOPLE.length, role_preference: { role: "manager" } }], contact_steps: steps };
  const budget = createJobCallBudget({ ceilingUsd: opts.ceilingUsd ?? 1, spentUsd: 0 });
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let n = 0;
  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      calls.push({ endpoint: a.endpoint_id, params: a.params });
      const out = opts.answers(a.endpoint_id, a.params);
      if (out === "refuse") return { ok: false, call_id: `call_${++n}`, refused: "over_budget", message: "no" };
      if (out === "fail") return { ok: false, call_id: `call_${++n}`, failed: true, http_status: 500, message: "x" };
      const id = `call_${String(++n).padStart(4, "0")}`;
      const hit = out !== null;
      await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json");
      const finder = [...steps.flatMap((s) => s.finders)].find((f) => f.id === a.endpoint_id)!;
      if (hit) budget.settle(0, finder.usd); // a hit is billed at the finder's price, a miss is free
      return { ok: true, call_id: id, http_status: 200, rows_in_page: hit ? 1 : 0, has_more: false, next_cursor: null };
    },
  };
  const events: any[] = [];
  const run = () => runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async (e: any) => { events.push(e); }, budget, deadlineMs: Date.now() + 60_000 });
  return { store, items, plan, budget, calls, events, run };
}
const cellsOf = (items: ItemStore, id: string) => { const r = items.acceptedRows("people").find((x) => x.id === id)!; return { email: String(r.email), email_status: String(r.email_status ?? ""), phone: String(r.phone), phone_status: String(r.phone_status ?? "") }; };

describe("pure helpers", () => {
  it("a finder's answer: a plausible company address is verified, a source that says invalid or a malformed address is kept as not verified, a masked value is no value", () => {
    expect(foundContactIn("email", { found: true, email: "Mina.Naguib@Orascom-EM.com.eg" })).toEqual({ value: "mina.naguib@orascom-em.com.eg", status: "verified" });
    expect(foundContactIn("email", { data: { email: "a.b@x-co.com", verification: { status: "invalid" } } })).toEqual({ value: "a.b@x-co.com", status: "unverified" });
    expect(foundContactIn("email", { email: "someone@gmail.com" })).toEqual({ value: "someone@gmail.com", status: "unverified" });
    expect(foundContactIn("email", { email: "m****@x.com" })).toBeNull();
    expect(foundContactIn("email", { found: false })).toBeNull();
    expect(foundContactIn("phone", { found: true, phone: "+20 100 123 4567" })?.status).toBe("verified");
    expect(foundContactIn("phone", { phone: "12-3 45" })).toBeNull();
  });
  it("a finder is called only with what the person has: the professional page, or the name with the company's bare domain; a finder that needs more is skipped", () => {
    const facts = personFactsOf(PEOPLE[1], columns, { id: "c1", name: "Orascom EM", website: "https://www.orascom-em.com.eg/home" });
    expect(finderParamsFor(EMAIL_A, facts)).toEqual({ person_linkedin_url: "https://www.linkedin.com/in/person2" });
    expect(finderParamsFor(EMAIL_B, facts)).toEqual({ domain: "orascom-em.com.eg", full_name: "Person2 Name2" });
    expect(finderParamsFor(EMAIL_A, { ...facts, linkedin: null })).toBeNull();
    expect(finderParamsFor(EMAIL_B, { ...facts, domain: null })).toBeNull();
  });
});

describe("the engine fills the cells of the people it delivered", () => {
  const hitEmail = (n: string) => ({ found: true, email: `${n}@orascom-em.com.eg` });
  it("every person with a page gets the cheapest finder first; values land with a status; people stay; nothing is added or removed", async () => {
    const w = await world({ answers: (ep, p) => (ep === EMAIL_A.id ? hitEmail(String(p.person_linkedin_url).split("/in/")[1]) : ep === PHONE_A.id ? { found: true, phone: "+201001234567" } : null) });
    await w.run();
    expect(w.items.acceptedRows("people").length).toBe(5);
    const first = cellsOf(w.items, "p2");
    // CHANGED (item 2, owner direction): «موثّق» only when a verifier says deliverable; the steps of this world have no verifier, so a finder's hit is delivered «غير موثّق» (the claim of a finder is not a verification). The chain with a verifier is tests/email-verification-chain.test.ts.
    // CHANGED (item 3): the phone is «موثّق» only when a validator says the number is valid; this world's steps have no validator, so the number is kept «غير موثّق»
    expect(first).toEqual({ email: "person2@orascom-em.com.eg", email_status: "غير موثّق", phone: "+201001234567", phone_status: "غير موثّق" });
    expect(w.calls.filter((c) => c.endpoint === EMAIL_A.id).length).toBe(5);
    expect(w.calls.some((c) => c.endpoint === EMAIL_B.id)).toBe(false);
  });
  it("a miss goes to the next ranked finder; a value the check does not verify is delivered with «غير موثّق»; a person nothing was found for keeps empty cells and is still delivered", async () => {
    // the step's priced amount is 0.002 a person here, so a dearer fallback finder fits for the people the cheap one missed
    const w = await world({ steps: [{ kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: 0.002, finders: [EMAIL_A, EMAIL_B] }], answers: (ep, p) => {
      if (ep === EMAIL_A.id) return String(p.person_linkedin_url).endsWith("person1") ? hitEmail("one") : null;
      if (ep === EMAIL_B.id) return String(p.full_name).startsWith("Person3") ? { email: "person3@gmail.com" } : null;
      return null;
    } });
    await w.run();
    // CHANGED (item 2): no verifier in this world, so a found address on the company's domain is «غير موثّق» as well
    expect(cellsOf(w.items, "p1")).toMatchObject({ email: "one@orascom-em.com.eg", email_status: "غير موثّق" });
    // CHANGED (item 2): an address on another domain than the company's (gmail.com for orascom-em.com.eg) says so: «غير موثّق لهذه الشركة»
    expect(cellsOf(w.items, "p3")).toMatchObject({ email: "person3@gmail.com", email_status: "غير موثّق لهذه الشركة" });
    expect(cellsOf(w.items, "p5")).toMatchObject({ email: "", email_status: "", phone: "", phone_status: "" });
    expect(w.items.acceptedRows("people").length).toBe(5);
  });
  it("decision-maker titles first: with money for two lookups only, the chief executive and the general manager are looked up", async () => {
    // a hit costs 0.0005; a ceiling that leaves room for two hits only
    const w = await world({ ceilingUsd: 0.0011, steps: [{ kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: 0.0005, finders: [EMAIL_A] }], answers: (ep, p) => (ep === EMAIL_A.id ? hitEmail(String(p.person_linkedin_url).split("/in/")[1]) : null) });
    const out = await w.run();
    const filled = ["p1", "p2", "p3", "p4", "p5"].filter((id) => cellsOf(w.items, id).email !== "");
    expect(filled.sort()).toEqual(["p2", "p4"]);
    expect(out.stopped).toBe("budget");
    expect(w.budget.spentUsd()).toBeLessThanOrEqual(0.0011);
  });
  it("the priced amount of the step is a cap: it stops when the next lookup would pass it (the dearer fallback finder does not run past it)", async () => {
    const w = await world({ steps: [{ kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: 0.0005, finders: [EMAIL_A, EMAIL_B] }], answers: (ep) => (ep === EMAIL_B.id ? { email: "x@orascom-em.com.eg" } : null) });
    await w.run();
    // cap = 0.0005 x 5 people = 0.0025: one fallback hit costs 0.0089, which does not fit, so no fallback is called
    expect(w.calls.filter((c) => c.endpoint === EMAIL_B.id).length).toBe(0);
    expect(w.budget.spentUsd()).toBeLessThanOrEqual(0.0025 + 1e-9);
  });
  it("a refusal for the job budget ends the enrichment at once and nothing already filled is lost", async () => {
    let n = 0;
    const w = await world({ answers: (ep, p) => (ep === EMAIL_A.id ? (++n > 2 ? "refuse" : hitEmail(String(p.person_linkedin_url).split("/in/")[1])) : null) });
    const out = await w.run();
    expect(out.stopped).toBe("budget");
    expect(PEOPLE.filter((p) => cellsOf(w.items, p.id).email !== "").length).toBe(2);
    // CHANGED (item 4): the people are taken in ONE pass, decision makers first, each with every step: the chief executive and the general manager each had their e-mail call AND their phone call (4 calls) before the third person's e-mail call was refused (the 5th). Before, all e-mails came first (3 calls).
    expect(w.calls.length).toBe(5);
  });
  it("phones are asked only after every e-mail and only when asked: a plan with no phone step makes no phone call; a resumed run does not look up a filled cell again", async () => {
    const onlyEmail: ContactStep[] = [{ kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: 0.0005, finders: [EMAIL_A] }];
    const w = await world({ steps: onlyEmail, answers: (ep, p) => (ep === EMAIL_A.id ? hitEmail(String(p.person_linkedin_url).split("/in/")[1]) : null) });
    await w.run();
    expect(w.calls.some((c) => c.endpoint === PHONE_A.id)).toBe(false);
    const before = w.calls.length;
    await w.run();
    expect(w.calls.length).toBe(before);
  });
  it("a person with neither a professional page nor a company domain is not called (nothing to ask with) and is still delivered", async () => {
    const lone = [{ ...person(9, "Chief Executive Officer"), linkedin: "" }];
    const w = await world({ people: lone as any, steps: [{ kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: 0.0005, finders: [EMAIL_A] }], answers: () => hitEmail("x") });
    await w.run();
    expect(w.calls.length).toBe(0);
    expect(w.items.acceptedRows("people").length).toBe(1);
  });
});

describe("which finders the catalog offers for a person", () => {
  it("only finders that take what a person row gives (a page, a name, a domain): an article-author finder and a webhook finder are never offered, cheapest first", async () => {
    const { loadTregCatalog } = await import("../src/lib/treg/catalog");
    const { finderSourcesOf } = await import("../src/lib/agentMission/contactFinders");
    const catalog = loadTregCatalog();
    const emails = finderSourcesOf("email", catalog, () => true);
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.map((f) => f.id)).not.toContain("tomba.people.email.find.author");
    expect(emails.every((f) => f.usd > 0)).toBe(true); // in the catalog's own ranking order (expected cost per delivered item)
    for (const f of [...emails, ...finderSourcesOf("phone", catalog, () => true)]) expect(f.inputs.some((i) => /linkedin|name|domain|company|profile/i.test(i.name))).toBe(true);
  });
});
