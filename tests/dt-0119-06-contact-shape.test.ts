import { describe, expect, it } from "vitest";
import { contactShape, emailShape, phoneShape } from "../src/lib/agentMission/contactShape";
import { hasContact, peopleWithoutRequestedContact } from "../src/lib/agentMission/billableRows";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { layoutOf } from "../agent/src/workbook";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";

/**
 * DT-20261119-06 PART B, Gate 2 r1 P0 (Megz D-0126): a date, a labelled registration number or junk in a PHONE cell is not a phone, for the file and for the charge, by ONE syntactic rule (contactShape.ts) applied before a native cell is
 * normalised and again at settlement. Real local, international, office and fax numbers, and kept consumer mailboxes, still count.
 */
describe("phoneShape: the shape of a phone, never a word list", () => {
  it.each([
    ["international", "+20 100 111 2222"], ["international, parentheses and a trunk zero", "+20 (0)22 345 6789"], ["local mobile", "01001112222"], ["local mobile, dashes", "0100-111-2222"], ["office, area code in parentheses", "(02) 2345 6789"],
    ["office", "+20 2 3333 4444"], ["fax", "+20 2 3333 4445"], ["a tel: link", "tel:+201001112222"], ["plain digits in a phone column", "20123456"], ["seven digits", "2345678"], ["fifteen digits", "+201001112222333"],
  ])("a phone: %s", (_name, value) => { expect(phoneShape(value), value).toBe(true); });
  it.each([
    ["an ISO date", "2021-03-12"], ["a day-first date", "12/03/2021"], ["a dotted date", "12.03.2021"], ["a decimal", "3.14159265"], ["an IPv4 address", "192.168.100.200"], ["a registration label", "Reg No: 12345678"], ["a commercial register", "CR 1234567"],
    ["a tax id label", "Tax ID 123-456-789"], ["a date with words", "March 3, 2021"], ["too short", "123456"], ["too long", "+2010011122223334"], ["masked", "+20 100 *** 22"], ["a placeholder", "غير متوفر"], ["a placeholder", "لم يكتمل البحث"],
    ["blank", "  "], ["junk", "N/A"], ["an address", "a@b.co"],
  ])("NOT a phone: %s", (_name, value) => { expect(phoneShape(value), value).toBe(false); });
  it("null and undefined are not phones", () => { expect(phoneShape(null)).toBe(false); expect(phoneShape(undefined)).toBe(false); });
});

describe("emailShape and the one rule", () => {
  it.each(["a@b.co", "gm@orascom-em.com.eg", "person@gmail.com"])("an address: %s", (v) => { expect(emailShape(v)).toBe(true); });
  it.each(["", "غير متوفر", "j***@x.com", "no at sign", "a@b", "a @b.co"])("not an address: %j", (v) => { expect(emailShape(v)).toBe(false); });
  it("billing and ingest read the SAME function: hasContact is contactShape", () => {
    for (const v of ["+20 100 111 2222", "2021-03-12", "Reg No: 12345678", "a@b.co", "غير متوفر", "02 2345 6789"]) {
      expect(hasContact("phone", v)).toBe(contactShape("phone", v));
      expect(hasContact("email", v)).toBe(contactShape("email", v));
    }
  });
});

const stage = (): PricedStage => ({
  key: "people", title_ar: "الأشخاص", endpoint_id: "e", expected_rows: 10, planned_rows: 10, parent_key: null, deliver: true,
  columns: [{ key: "full_name", title_ar: "الاسم" }, { key: "phone", title_ar: "التليفون", kind: "phone" }, { key: "phone_status", title_ar: "حالة التليفون", status_of: "phone" }],
} as unknown as PricedStage);

describe("through ingest, the people sheet and the charge: a native phone field that holds a date, a labelled id or junk", () => {
  const rows = [
    { id: "1", full_name: "Ahmed Hassan", phone: "+20 100 111 2222" },
    { id: "2", full_name: "Mona Samir", phone: "2021-03-12" },
    { id: "3", full_name: "Omar Fathy", phone: "Reg No: 12345678" },
    { id: "4", full_name: "Hala Nabil", phone: "(02) 2345 6789" },
    { id: "5", full_name: "Karim Adel", phone: "12/03/2021" },
    { id: "6", full_name: "Salma Ezz", phone: "+20 100 *** 22" },
    { id: "7", full_name: "Tamer Wael", phone: "tel:+201001112222" },
    { id: "8", full_name: "Dina Ashraf", phone: "غير متوفر" },
  ];
  it("the cell of a date, a labelled id, a masked value and a placeholder is EMPTY (not a normalised «phone»); real local, international, office and tel: numbers are kept; the charge counts exactly the kept ones", async () => {
    const st = stage();
    const plan = { summary_ar: "x", stages: [st], contact_steps: [{ stage_key: "people", column_key: "phone", kind: "phone" }], price: { deliveredRows: 10 } } as unknown as PricedPlan;
    const items = await ItemStore.open(createMemoryStore(), "msn_shape", { legacyStages: ["people"] });
    await ingestRows({ items, plan, addEvent: async () => undefined }, st, rows, { silent: true, idField: null });
    const kept = items.acceptedRows("people");
    expect(kept).toHaveLength(8); // verification decides a cell, never a person: every person is delivered
    const phoneOf = (id: string) => String((kept.find((r) => r.id === id) as Record<string, unknown>).phone ?? "");
    expect(phoneOf("1")).not.toBe("");
    expect(phoneOf("4")).not.toBe("");
    expect(phoneOf("7")).not.toBe("");
    for (const id of ["2", "3", "5", "6", "8"]) expect(phoneOf(id), id).toBe("");
    // the people sheet (the layout the workbook is written from) shows the same cells
    const layout = layoutOf(plan, { people: kept as never })[0];
    const phoneColumn = layout.columns.find((c) => c.key === "phone")!;
    expect(layout.rows.map((r) => String(phoneColumn.get(r, null) ?? "")).filter(Boolean)).toHaveLength(3);
    // and settlement: 5 of the 8 delivered people carry no phone
    expect(peopleWithoutRequestedContact(plan as never, { people: kept as never }, { people: 8 })).toMatchObject({ byStage: { people: 5 }, total: 5, kinds: ["phone"] });
  });
});
