import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { buildContactSteps, type ContactStep, type FinderInfo } from "../src/lib/agentMission/contactFinders";
import { MEASURED_FINDER_CALLS, finderHitRate, pooledHitRate } from "../src/lib/agentMission/finderStats";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/**
 * ITEM 1 (owner decision after #321): the e-mail step's cap (0.0024024 USD x 8 people) let the dearer finder (anyapi.linkedin.email.work.find, 0.011 USD, a REAL hit) run for 1 of 8 people, because the price assumed one person in ten needs it (FALLBACK_MISS_SHARE 0.1) and that the
 * verifier is bought for 8 in 10 (EMAIL_FOUND_SHARE 0.8). In msn_7539ea17512cf58aa0e7 the cheap finder missed 8 of 8. The shares are now DERIVED from the live call log (mission_calls, SELECT 2026-11-01, every phase): hits are billed answers (these finders bill a hit only), and the step's CAP lets
 * every delivered decision maker go through the whole chain (finders, then the verifier).
 */
const FREE: FinderInfo = { id: "blitzapi.people.email.find", usd: 0.000495, bill: "success", inputs: [{ name: "person_linkedin_url", required: true }] };
const QUICK: FinderInfo = { id: "quickenrich.people.email.find", usd: 0.004834, bill: "success", inputs: [{ name: "linkedin_url", required: false }, { name: "company_url", required: false }, { name: "first_name", required: false }, { name: "last_name", required: false }] };
const DEAR: FinderInfo = { id: "anyapi.linkedin.email.work.find", usd: 0.011, bill: "success", inputs: [{ name: "profileUrl", required: true }] };
const V_FREE: FinderInfo = { id: "contactout.people.email.verify", usd: 0.000001, bill: "success", inputs: [{ name: "email", required: true }] };
const V_PAID: FinderInfo = { id: "millionverifier.people.email.verify", usd: 0.00178, bill: "success", inputs: [{ name: "email", required: true }] };
const P_FREE: FinderInfo = { id: "blitzapi.people.phone.find", usd: 0.000495, bill: "success", inputs: [{ name: "person_linkedin_url", required: true }] };
const P_QUICK: FinderInfo = { id: "quickenrich.people.phone.find", usd: 0.004834, bill: "success", inputs: [{ name: "linkedin_url", required: false }] };
const P_DEAR: FinderInfo = { id: "tomba.people.phone.find", usd: 0.0445, bill: "success", inputs: [{ name: "linkedin", required: false }] };

describe("the shares come from the measured call log, not from a guess", () => {
  it("the log: blitz e-mail 9 hits in 42 calls, quickenrich e-mail 0 in 14 (a phone-only answer is free), anyapi 5 in 5", () => {
    expect(MEASURED_FINDER_CALLS["blitzapi.people.email.find"]).toEqual({ calls: 42, hits: 9 });
    expect(MEASURED_FINDER_CALLS["quickenrich.people.email.find"]).toEqual({ calls: 14, hits: 0 });
    expect(MEASURED_FINDER_CALLS["anyapi.linkedin.email.work.find"]).toEqual({ calls: 5, hits: 5 });
    expect(MEASURED_FINDER_CALLS["blitzapi.people.phone.find"]).toEqual({ calls: 21, hits: 2 });
  });
  it("the hit rate is smoothed (hits + 0.5) / (calls + 1): never 0 and never 1; an unmeasured finder takes the pooled rate of its kind", () => {
    expect(finderHitRate("blitzapi.people.email.find", "email")).toBeCloseTo(9.5 / 43, 6);
    expect(finderHitRate("quickenrich.people.email.find", "email")).toBeCloseTo(0.5 / 15, 6);
    expect(finderHitRate("anyapi.linkedin.email.work.find", "email")).toBeCloseTo(5.5 / 6, 6);
    expect(finderHitRate("some.new.people.email.find", "email")).toBeCloseTo(pooledHitRate("email"), 9);
    expect(pooledHitRate("email")).toBeGreaterThan(0.1);
    expect(pooledHitRate("email")).toBeLessThan(0.4);
  });
});

describe("the step's price and cap from the chain", () => {
  const stage = { key: "people", title_ar: "موظفو كل شركة", parent_key: "companies", deliver: true, role_preference: { role: "manager" }, columns: [{ key: "name" }, { key: "title" }, { key: "linkedin" }] as Array<{ key: string; kind?: string }> };
  const steps = (): ContactStep[] => buildContactSteps([stage] as any, "عايز ٥ شركات مصرية ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون", (kind) => (kind === "email" ? [FREE, QUICK, DEAR] : [P_FREE, P_QUICK, P_DEAR]), (kind) => (kind === "email" ? { verifiers: [V_FREE, V_PAID] } : { validators: [{ id: "hlrlookup.people.phone.validate", usd: 0.000001, bill: "success", inputs: [{ name: "telephone_number", required: true }] }], company_phone: [{ id: "crawl4ai.google.serp.maps", usd: 0.00015, bill: "call", inputs: [{ name: "query", required: true }] }] }));
  it("e-mail: the price of one person is the expected cost of the chain (a hit is billed, a miss is free) plus the verifier for those found; it is far above the old 0.0024", () => {
    const e = steps().find((s) => s.kind === "email")!;
    const h1 = 9.5 / 43, h2 = 0.5 / 15, h3 = 5.5 / 6;
    const reach2 = 1 - h1, reach3 = reach2 * (1 - h2);
    const found = 1 - reach3 * (1 - h3);
    const expected = h1 * 0.000495 + reach2 * h2 * 0.004834 + reach3 * h3 * 0.011 + found * 0.00178;
    expect(e.per_person_usd).toBeCloseTo(expected, 9);
    expect(e.per_person_usd).toBeGreaterThan(0.0024024 * 3);
  });
  it("e-mail: the CAP lets every person go through the whole chain: finders and the verifier at their full price, for every person", () => {
    const e = steps().find((s) => s.kind === "email")!;
    expect(e.max_person_usd).toBeCloseTo(0.000495 + 0.004834 + 0.011 + 0.00178, 9);
    expect(e.max_person_usd!).toBeGreaterThan(e.per_person_usd);
  });
  it("phone: expected cost carries the dear third finder only for those the first two miss, the company phone and the validator; the cap carries the whole chain", () => {
    const p = steps().find((s) => s.kind === "phone")!;
    expect(p.max_person_usd).toBeCloseTo(0.000495 + 0.004834 + 0.0445 + 0.00015 + 0.000001, 9);
    expect(p.per_person_usd).toBeGreaterThan(0.01);
    expect(p.per_person_usd).toBeLessThan(p.max_person_usd!);
  });
});

/** The live shape of msn_7539…: the cheap finder misses every person, the second answers phone-only (no address), the third hits for every person. */
const MISSION = "msn_budget";
const columns = [{ key: "full_name", title_ar: "الاسم" }, { key: "job_title", title_ar: "المسمى الوظيفي" }, { key: "linkedin", title_ar: "الملف المهني" }, { key: "email", title_ar: "الإيميل", kind: "work_email" as const }, { key: "email_status", title_ar: "حالة توثيق الإيميل", status_of: "email" }];
async function world(people: number, step: ContactStep, answers: (endpoint: string, params: Record<string, unknown>) => unknown) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, MISSION);
  const rows = Array.from({ length: people }, (_, i) => ({ id: `p${i + 1}`, parent_id: "c1", full_name: `Person${i + 1} Name${i + 1}`, job_title: "General Manager", linkedin: `https://www.linkedin.com/in/person${i + 1}`, email: "" }));
  await items.commit([{ t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", name: "365 Ecology", website: "https://365ecology.com/" } }, ...rows.map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: { ...p } }))]);
  const plan: any = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }], planned_rows: 1 }, { key: "people", parent_key: "companies", title_ar: "موظفو كل شركة", deliver: true, columns, planned_rows: people, role_preference: { role: "manager" } }], contact_steps: [step] };
  const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
  const calls: string[] = [];
  let n = 0;
  const priced = new Map([...step.finders, ...(step.verifiers ?? [])].map((f) => [f.id, f.usd] as const));
  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      calls.push(a.endpoint_id);
      const out = answers(a.endpoint_id, a.params);
      const id = `call_${String(++n).padStart(4, "0")}`;
      await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json");
      // these providers bill a HIT only: a phone-only answer and a miss are free
      if (out !== null && JSON.stringify(out).includes("@") && !a.endpoint_id.endsWith("verify")) budget.settle(0, priced.get(a.endpoint_id) ?? 0);
      if (out !== null && a.endpoint_id === V_PAID.id) budget.settle(0, priced.get(a.endpoint_id) ?? 0);
      return { ok: true, call_id: id, http_status: 200, rows_in_page: out !== null ? 1 : 0, has_more: false, next_cursor: null };
    },
  };
  const out = await runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async () => {}, budget, deadlineMs: Date.now() + 60_000 });
  const cells = items.acceptedRows("people").map((r) => ({ email: String(r.email ?? ""), status: String(r.email_status ?? "") }));
  return { calls, cells, out, spent: budget.spentUsd() };
}
const slug = (p: Record<string, unknown>) => String(p.person_linkedin_url ?? p.profileUrl ?? p.linkedin_url).split("/in/")[1];

describe("LIVE SHAPE: every person goes through the whole chain, not the first one only", () => {
  const stage = { key: "people", title_ar: "موظفو كل شركة", parent_key: "companies", deliver: true, role_preference: { role: "manager" }, columns: [{ key: "name" }, { key: "title" }, { key: "linkedin" }, { key: "email", kind: "work_email" }] };
  const emailStep = (): ContactStep => buildContactSteps([stage] as any, "عايز ٥ شركات ومعاهم صناع القرار والإيميل", () => [FREE, QUICK, DEAR], () => ({ verifiers: [V_FREE, V_PAID] })).find((s) => s.kind === "email")!;
  it("8 people: the cheap finder misses all, the second gives no address, the dear one hits: ALL 8 get an address (before: 1 of 8) and every address goes to a verifier", async () => {
    const w = await world(8, emailStep(), (ep, p) => (ep === FREE.id ? null : ep === QUICK.id ? { phone: "+201000000000", email: null } : ep === DEAR.id ? { emails: [{ address: `${slug(p)}@365ecology.com`, deliverability: "deliverable" }] } : { status: "safe", deliverable: true }));
    expect(w.cells.filter((c) => c.email !== "")).toHaveLength(8);
    expect(w.calls.filter((c) => c === DEAR.id)).toHaveLength(8);
    expect(w.cells.every((c) => c.status === "موثّق")).toBe(true);
    expect(w.calls.filter((c) => c === V_FREE.id).length).toBeGreaterThan(0);
  });
  it("the spend of that worst case stays inside the step's cap (max per person x people) and the job budget", async () => {
    const step = emailStep();
    const w = await world(8, step, (ep, p) => (ep === FREE.id ? null : ep === QUICK.id ? { phone: "+201000000000", email: null } : ep === DEAR.id ? { emails: [{ address: `${slug(p)}@365ecology.com` }] } : { status: "safe", deliverable: true }));
    expect(w.spent).toBeLessThanOrEqual(step.max_person_usd! * 8 + 1e-9);
    expect(w.spent).toBeGreaterThan(step.per_person_usd * 8 * 0.9);
  });
});
