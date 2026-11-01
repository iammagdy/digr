import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { tidyCompanyName, withTidyNames } from "../src/lib/agentMission/companyNames";

/**
 * ITEM 4 OF THE 2026-11-01 11:38 LIVE TEST (msn_7539ea17512cf58aa0e7): the company «mitsubishi elevators \ melco-mec egypt» was delivered with its stray backslash (the file showed «\\»), and the same text became the map search query
 * of the company-phone step («mitsubishi elevators \ melco-mec egypt \ الجيزة»). Owner direction: strip stray backslashes, quotes and trailing separators from company names in the delivered cells.
 */
describe("tidyCompanyName", () => {
  it("strips stray backslashes (the live name)", () => {
    expect(tidyCompanyName("mitsubishi elevators \\ melco-mec egypt")).toBe("mitsubishi elevators melco-mec egypt");
    expect(tidyCompanyName("mitsubishi elevators \\\\ melco-mec egypt")).toBe("mitsubishi elevators melco-mec egypt");
  });
  it("strips straight and curly quotes, and the quotation marks of «»", () => {
    expect(tidyCompanyName('"Nile Electromechanical"')).toBe("Nile Electromechanical");
    expect(tidyCompanyName("“Delta” Group")).toBe("Delta Group");
    expect(tidyCompanyName("«النيل للكهروميكانيكا»")).toBe("النيل للكهروميكانيكا");
  });
  it("strips leading and trailing separators", () => {
    expect(tidyCompanyName("Ateco ,")).toBe("Ateco");
    expect(tidyCompanyName("| Kahromika -")).toBe("Kahromika");
    expect(tidyCompanyName("365 Ecology /")).toBe("365 Ecology");
    expect(tidyCompanyName("Alu Misr ;:")).toBe("Alu Misr");
  });
  it("leaves a clean name, an apostrophe, a dot and a hyphen inside a name alone", () => {
    for (const ok of ["365 Ecology", "Melco-Mec Egypt", "L'Oréal Egypt", "Ateco Co.", "شركة الأمل للمقاولات", "A & B Trading (Egypt)"]) expect(tidyCompanyName(ok)).toBe(ok);
  });
  it("a value that is not text, or nothing but separators, is returned as it was / empty", () => {
    expect(tidyCompanyName("")).toBe("");
    expect(tidyCompanyName(" \\ ")).toBe("");
  });
});

describe("withTidyNames: the name columns of a company stage and the company cell of a people stage", () => {
  const columns = [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }];
  it("cleans the name column and nothing else", () => {
    const out = withTidyNames({ id: "c", name: "mitsubishi elevators \\ melco-mec egypt", website: "melcomec.net" }, columns, false);
    expect(out.name).toBe("mitsubishi elevators melco-mec egypt");
    expect(out.website).toBe("melcomec.net");
  });
  it("in a people stage the person's name is untouched and the company cell is cleaned", () => {
    const pcols = [{ key: "name", title_ar: "الاسم" }, { key: "company", title_ar: "الشركة" }];
    const out = withTidyNames({ id: "p", name: 'Ahmed "Mido" Ali', company: "mitsubishi elevators \\ melco-mec egypt" }, pcols, true);
    expect(out.name).toBe('Ahmed "Mido" Ali');
    expect(out.company).toBe("mitsubishi elevators melco-mec egypt");
  });
});

describe("the stored and delivered cells", () => {
  it("a company stored from the live row has a clean name, and so has the company cell of its people", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_tidy");
    const companies = { key: "companies", title_ar: "الشركات", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }], sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001 };
    const people = { key: "people", title_ar: "موظفو كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 10, planned_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "title", title_ar: "المسمى الوظيفي" }, { key: "company", title_ar: "الشركة" }], sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.001 };
    const deps = { items, plan: { summary_ar: "x", price: { deliveredRows: 15 }, stages: [companies, people] } as never, addEvent: async () => undefined };
    await ingestRows(deps, companies as never, [{ id: "melcomec", name: "mitsubishi elevators \\ melco-mec egypt", website: "melcomec.net" }], { silent: true, idField: null });
    await ingestRows(deps, people as never, [{ id: "p1", parent_id: "melcomec", name: "Michael Ayad", title: "Manager", company: "mitsubishi elevators \\ melco-mec egypt" }], { silent: true, idField: null });
    expect(String(items.acceptedRows("companies")[0].name)).toBe("mitsubishi elevators melco-mec egypt");
    expect(String(items.acceptedRows("people")[0].company)).toBe("mitsubishi elevators melco-mec egypt");
  });
});
