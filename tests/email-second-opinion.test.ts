import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import type { ContactStep, FinderInfo } from "../src/lib/agentMission/contactFinders";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/**
 * F3 (golden G1, msn_ecca2a0d074fef9f4456, 2026-11-01 15:12 Cairo): the e-mail verifier WAS called (5 calls for the companies' addresses, 3 for the people's: HTTP 200, status «ok»), and 4 of 5 company addresses and 3 of 3 people addresses stayed «غير موثّق».
 * The free verifier (contactout; the catalog's own example answer is {"data":{"status":"accept_all"}}) answers «accept_all» for a domain it cannot judge, and the chain stopped at that first answer, so the paid verifier next in the chain was never asked.
 * A catch-all or unknown answer is now a reason to ask the NEXT verifier once more (inside the step's own priced cap); only «undeliverable» ends the chain at once; a later «deliverable» wins, a later catch-all stays «غير موثّق».
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
async function world(opts: { people: Array<ReturnType<typeof person>>; website?: string; verifiers?: FinderInfo[]; finders?: FinderInfo[]; perPersonUsd?: number; ceilingUsd?: number; onEvent?: (e: any) => void; answers: (endpoint: string, params: Record<string, unknown>) => Answer }) {
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
  const run = () => runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async (e: any) => { opts.onEvent?.(e); }, budget, deadlineMs: Date.now() + 60_000 });
  const cell = (id: string) => { const r = items.acceptedRows("people").find((x) => x.id === id)!; return { email: String(r.email ?? ""), status: String(r.email_status ?? "") }; };
  return { items, budget, calls, run, cell };
}
const byLinkedin = (p: Record<string, unknown>) => String(p.person_linkedin_url).split("/in/")[1];

describe("F3: a catch-all answer is not the end of the verifier chain", () => {
  const FIRST = { status_code: 200, data: { status: "accept_all" } };
  const SECOND = { email: "x", quality: "good", result: "ok", resultcode: 1, subresult: "ok", role: false };
  const answers = (first: unknown, second: unknown) => (ep: string, p: Record<string, unknown>) => (ep === FIND_A.id ? { email: `${byLinkedin(p)}@isssystems.com` } : ep === VERIFY_A.id ? first : ep === VERIFY_B.id ? second : null);

  it("the free verifier says accept_all, the paid one says ok: the address is «موثّق» and both were asked", async () => {
    const w = await world({ people: [person(1)], verifiers: [VERIFY_A, VERIFY_B], answers: answers(FIRST, SECOND) });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "person1@isssystems.com", status: "موثّق" });
    expect(w.calls.filter((c) => c.endpoint === VERIFY_A.id || c.endpoint === VERIFY_B.id).map((c) => c.endpoint)).toEqual([VERIFY_A.id, VERIFY_B.id]);
  });
  it("both say catch-all: the address stays «غير موثّق» and is still written", async () => {
    const w = await world({ people: [person(1)], verifiers: [VERIFY_A, VERIFY_B], answers: answers(FIRST, { result: "catch_all", quality: "risky" }) });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "person1@isssystems.com", status: "غير موثّق" });
  });
  it("undeliverable ends the chain at once: the paid verifier is not asked", async () => {
    const w = await world({ people: [person(1)], verifiers: [VERIFY_A, VERIFY_B], answers: answers({ status: "invalid", deliverable: false }, SECOND) });
    await w.run();
    expect(w.cell("p1").status).toBe("غير موثّق");
    expect(w.calls.some((c) => c.endpoint === VERIFY_B.id)).toBe(false);
  });
  it("the second opinion stays inside the step's priced cap: with no room the address is written «غير موثّق» and the paid verifier is not called", async () => {
    const w = await world({ people: [person(1)], verifiers: [VERIFY_A, VERIFY_B], perPersonUsd: 0.0006, answers: answers(FIRST, SECOND) });
    await w.run();
    expect(w.cell("p1")).toEqual({ email: "person1@isssystems.com", status: "غير موثّق" });
    expect(w.calls.some((c) => c.endpoint === VERIFY_B.id)).toBe(false);
  });
  it("the run records what each verifier said, as counts only (for the admin page, no address)", async () => {
    const events: any[] = [];
    const w = await world({ people: [person(1), person(2)], verifiers: [VERIFY_A, VERIFY_B], answers: answers(FIRST, SECOND), onEvent: (e: any) => events.push(e) });
    await w.run();
    const report = events.find((e) => e.kind === "call" && e.counts && "ver_calls" in e.counts);
    expect(report?.counts).toMatchObject({ ver_calls: 4, ver_catch_all: 2, ver_deliverable: 2, ver_second_opinion: 2 });
    expect(JSON.stringify(report)).not.toContain("@");
  });
});
