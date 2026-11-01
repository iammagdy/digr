import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { foundContactIn, type ContactStep, type FinderInfo } from "../src/lib/agentMission/contactFinders";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/**
 * ITEM 1 OF THE 2026-11-01 11:38 LIVE TEST (msn_7539ea17512cf58aa0e7: 5 Egyptian electromechanical companies, 8 decision makers delivered, 0 of 8 e-mails).
 * What the call log shows for each of the 8: blitzapi.people.email.find answered EMPTY, quickenrich.people.email.find answered 1 row at cost 0 (a phone-only answer: the provider bills no e-mail), and the third ranked finder
 * (anyapi.linkedin.email.work.find, 0.011 USD) was asked for the FIRST person only: it BILLED (a hit) and still no address reached the cell, because the extractor only knew a few key names. No verifier was ever called (nothing reached it).
 * Owner direction: a found address is ALWAYS written («غير موثّق» when the verifier failed, was rate limited or is missing); a verifier failure never erases it; a rate-limited free verifier falls through to the next ranked one.
 */
describe("a finder's answer carries an address under whatever key the provider uses", () => {
  const A = "mohamed.saied@365ecology.com";
  const shapes: Array<[string, unknown]> = [
    ["a list of objects keyed `address`", { emails: [{ address: A, deliverability: "deliverable", validation_status: "valid", quality_score: 95 }], name: "Mohamed Saied", headline: "Operations" }],
    ["camel case `emailAddress`", { profile: { name: "Mohamed Saied" }, emailAddress: A }],
    ["a `professional_email` key", { professional_email: A }],
    ["a list of objects keyed `value`", { data: { result: { emails: [{ value: A, type: "work" }] } } }],
    ["a `mailto:` link", { contact: { link: `mailto:${A}` } }],
    ["the address as a plain value under an unrelated key", { result: { found: true, best: A } }],
  ];
  for (const [label, page] of shapes) {
    it(`finds it in ${label}`, () => {
      const hit = foundContactIn("email", page);
      expect(hit?.value).toBe(A);
    });
  }
  it("a phone-only answer (an e-mail of null) is no value", () => {
    expect(foundContactIn("email", { phone: "+201001234567", email: null })).toBeNull();
  });
  it("a masked address is no value", () => {
    expect(foundContactIn("email", { emailAddress: "m*****@365ecology.com" })).toBeNull();
  });
});

const MISSION = "msn_found";
const FIND_FREE: FinderInfo = { id: "free.people.email.find", usd: 0.000495, inputs: [{ name: "person_linkedin_url", required: true }] };
const FIND_DEAR: FinderInfo = { id: "dear.people.email.find", usd: 0.011, inputs: [{ name: "profileUrl", required: true }] };
const V_FREE: FinderInfo = { id: "contactout.people.email.verify", usd: 0.000001, inputs: [{ name: "email", required: true }] };
const V_PAID: FinderInfo = { id: "millionverifier.people.email.verify", usd: 0.00178, inputs: [{ name: "email", required: true }] };
const columns = [{ key: "full_name", title_ar: "الاسم" }, { key: "job_title", title_ar: "المسمى الوظيفي" }, { key: "linkedin", title_ar: "الملف المهني" }, { key: "email", title_ar: "الإيميل", kind: "work_email" as const }, { key: "email_status", title_ar: "حالة توثيق الإيميل", status_of: "email" }];
const person = (i: number) => ({ id: `p${i}`, parent_id: "c1", full_name: `Person${i} Name${i}`, job_title: "General Manager", linkedin: `https://www.linkedin.com/in/person${i}`, email: "" });

type Answer = unknown | "fail" | "throw";
async function world(opts: { people: number; finders: FinderInfo[]; verifiers: FinderInfo[]; perPersonUsd?: number; answers: (endpoint: string, params: Record<string, unknown>) => Answer }) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, MISSION);
  const people = Array.from({ length: opts.people }, (_, i) => person(i + 1));
  await items.commit([
    { t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", name: "365 Ecology", website: "https://365ecology.com/" } },
    ...people.map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: { ...p } })),
  ]);
  const step: ContactStep = { kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: opts.perPersonUsd ?? 0.05, finders: opts.finders, verifiers: opts.verifiers };
  const plan: any = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }], planned_rows: 1 }, { key: "people", parent_key: "companies", title_ar: "موظفو كل شركة", deliver: true, columns, planned_rows: people.length, role_preference: { role: "manager" } }], contact_steps: [step] };
  const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
  const calls: string[] = [];
  let n = 0;
  const priced = new Map([...opts.finders, ...opts.verifiers].map((f) => [f.id, f.usd] as const));
  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      calls.push(a.endpoint_id);
      const out = opts.answers(a.endpoint_id, a.params);
      if (out === "throw") throw new Error("socket hang up");
      if (out === "fail") return { ok: false, call_id: `call_${++n}`, failed: true, http_status: 429, message: "rate limit" };
      const id = `call_${String(++n).padStart(4, "0")}`;
      await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json");
      if (out !== null) budget.settle(0, priced.get(a.endpoint_id) ?? 0);
      return { ok: true, call_id: id, http_status: 200, rows_in_page: out !== null ? 1 : 0, has_more: false, next_cursor: null };
    },
  };
  const run = () => runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async () => {}, budget, deadlineMs: Date.now() + 60_000 });
  const cell = (id: string) => { const r = items.acceptedRows("people").find((x) => x.id === id)!; return { email: String(r.email ?? ""), status: String(r.email_status ?? "") }; };
  return { calls, run, cell };
}
const slug = (p: Record<string, unknown>) => String(p.person_linkedin_url ?? p.profileUrl).split("/in/")[1];
const addressOf = (p: Record<string, unknown>) => `${slug(p)}@365ecology.com`;
const safe = { status: "safe", deliverable: true, is_catch_all: false };

describe("the live chain of msn_7539…: free finder empty, phone-only second answer, dear third finder hits", () => {
  it("the third finder's address (a list keyed `address`) is written, «غير موثّق» when no verifier answered, and the person's cell is not empty", async () => {
    const w = await world({
      people: 1, finders: [FIND_FREE, FIND_DEAR], verifiers: [V_FREE, V_PAID],
      answers: (ep, p) => (ep === FIND_FREE.id ? null : ep === FIND_DEAR.id ? { emails: [{ address: addressOf(p), deliverability: "deliverable" }] } : "fail"),
    });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "person1@365ecology.com", status: "غير موثّق" });
  });
});

describe("a verifier failure never erases a found address", () => {
  it("every verifier is rate limited (HTTP 429): the address stays, «غير موثّق»", async () => {
    const w = await world({ people: 3, finders: [FIND_FREE], verifiers: [V_FREE, V_PAID], answers: (ep, p) => (ep === FIND_FREE.id ? { email: addressOf(p) } : "fail") });
    await w.run();
    for (const id of ["p1", "p2", "p3"]) expect(w.cell(id)).toEqual({ email: `${id.replace("p", "person")}@365ecology.com`, status: "غير موثّق" });
  });
  it("the free verifier is rate limited (429): the next ranked verifier answers and the address is «موثّق»", async () => {
    const w = await world({ people: 3, finders: [FIND_FREE], verifiers: [V_FREE, V_PAID], answers: (ep, p) => (ep === FIND_FREE.id ? { email: addressOf(p) } : ep === V_FREE.id ? "fail" : safe) });
    await w.run();
    for (const id of ["p1", "p2", "p3"]) expect(w.cell(id).status).toBe("موثّق");
    expect(w.calls.filter((c) => c === V_FREE.id).length).toBe(2);
  });
  it("a verifier call that THROWS (a dropped connection) does not lose the address, and the next person is still looked up", async () => {
    const w = await world({ people: 2, finders: [FIND_FREE], verifiers: [V_FREE], answers: (ep, p) => (ep === FIND_FREE.id ? { email: addressOf(p) } : "throw") });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "person1@365ecology.com", status: "غير موثّق" });
    expect(w.cell("p2")).toEqual({ email: "person2@365ecology.com", status: "غير موثّق" });
  });
  it("a finder call that throws is a miss for that finder: the next ranked finder is tried", async () => {
    const w = await world({ people: 1, finders: [FIND_FREE, FIND_DEAR], verifiers: [V_FREE], answers: (ep, p) => (ep === FIND_FREE.id ? "throw" : ep === FIND_DEAR.id ? { emailAddress: addressOf(p) } : safe) });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "person1@365ecology.com", status: "موثّق" });
  });
});
