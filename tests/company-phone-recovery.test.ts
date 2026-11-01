import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import type { ContactStep, FinderInfo } from "../src/lib/agentMission/contactFinders";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/**
 * F4 (golden G1, msn_ecca2a0d074fef9f4456): the HQ phone was filled for 2 of 5 companies. From the stored plan and the call log: the companies source gave no phone for any of the five (the three sample rows carry none), so every company went to the map-search step; for three of them it ended «غير متوفر»:
 * the first helper answered nothing or places that were not the company (a search by the name and the city), the second was down (HTTP 503 twice), and the third needs a LOCATION and was never called for a company with no city and no country in its row, although the customer asked for «شركات مصرية».
 * Fix: (1) when the name search finds no place that is the company, the same helper is asked once with the company's WEBSITE as the query (the place whose website is the company's domain is the company, the strictest proof there is); (2) the country the request names is the company's country when its row says none, so a helper that needs a location is called.
 */
const MISSION = "msn_f4";
const CRAWL: FinderInfo = { id: "crawl4ai.google.serp.maps", usd: 0.00015, inputs: [{ name: "query", required: true }, { name: "location", required: false }] };
const DOWN: FinderInfo = { id: "litescrape.google.serp.maps", usd: 0.00015, inputs: [{ name: "q", required: false }] };
const ANY: FinderInfo = { id: "anyapi.google.serp.maps", usd: 0.00175, inputs: [{ name: "query", required: true }, { name: "location", required: true }] };

async function world(opts: { company: Record<string, unknown>; helpers: FinderInfo[]; requestText?: string; answers: (endpoint: string, params: Record<string, unknown>) => unknown | "fail" }) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, MISSION);
  await items.commit([{ t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", ...opts.company } }]);
  const step: ContactStep = { kind: "phone", level: "company", stage_key: "companies", column_key: "company_phone", status_key: "company_phone_status", per_person_usd: 0.00015, max_person_usd: 0.0035, finders: [], company_phone: opts.helpers };
  const plan: any = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }, { key: "city", title_ar: "المدينة" }, { key: "company_phone", title_ar: "هاتف المقر الرئيسي" }], planned_rows: 1 }], contact_steps: [step] };
  const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let n = 0;
  const priced = new Map(opts.helpers.map((f) => [f.id, f.usd] as const));
  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      calls.push({ endpoint: a.endpoint_id, params: a.params });
      const out = opts.answers(a.endpoint_id, a.params);
      if (out === "fail") return { ok: false, call_id: `call_${++n}`, failed: true, http_status: 503, message: "down" };
      const id = `call_${String(++n).padStart(4, "0")}`;
      await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json");
      budget.settle(0, priced.get(a.endpoint_id) ?? 0);
      return { ok: true, call_id: id, http_status: 200, rows_in_page: out ? 1 : 0, has_more: false, next_cursor: null };
    },
  };
  const run = () => runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async () => {}, budget, deadlineMs: Date.now() + 60_000, ...(opts.requestText ? { requestText: opts.requestText } : {}) } as any);
  const cell = () => String(items.acceptedRows("companies").find((x) => x.id === "c1")!.company_phone ?? "");
  return { calls, run, cell };
}
const place = (title: string, website: string, phone: string) => ({ title, website, phone });

describe("F4: the HQ phone of a company the first name search did not find", () => {
  it("the name search gives other businesses; the same helper asked with the company's website finds the place whose website IS the company's, and its phone is kept", async () => {
    const w = await world({
      company: { name: "ESWECO", website: "esweco.com", city: "Alexandria" }, helpers: [CRAWL],
      answers: (ep, p) => (ep !== CRAWL.id ? null : String(p.query).includes("esweco.com") ? { results: [place("Egyptian Swedish Welding Electrodes", "https://www.esweco.com/", "+20 3 4567890")] } : { results: [place("Alexandria Hardware", "https://hardware.example", "+20 3 111111"), place("Delta Tools", "https://delta.example", "+20 3 222222")] }),
    });
    await w.run();
    expect(w.cell()).toBe("+2034567890");
    expect(w.calls.map((c) => c.endpoint)).toEqual([CRAWL.id, CRAWL.id]);
  });
  it("a place that is some other business is still never the company's phone (nothing found twice: «غير متوفر»)", async () => {
    const w = await world({ company: { name: "ESWECO", website: "esweco.com", city: "Alexandria" }, helpers: [CRAWL], answers: () => ({ results: [place("Alexandria Hardware", "https://hardware.example", "+20 3 111111")] }) });
    await w.run();
    expect(w.cell()).toBe("غير متوفر");
  });
  it("no city and no country in the row, the customer asked for Egyptian companies: the helper that needs a location is called with the request's country", async () => {
    const w = await world({
      company: { name: "Kahromika", website: "kahromika.com" }, helpers: [DOWN, ANY], requestText: "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا",
      answers: (ep) => (ep === DOWN.id ? "fail" : ep === ANY.id ? { results: [place("Kahromika Electromechanical", "https://kahromika.com", "+20 2 2222222")] } : null),
    });
    await w.run();
    const any = w.calls.find((c) => c.endpoint === ANY.id);
    expect(any).toBeTruthy();
    expect(String(any!.params.location).toLowerCase()).toMatch(/eg|egypt|مصر/);
    expect(w.cell()).toBe("+2022222222");
  });
});
