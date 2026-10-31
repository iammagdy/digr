import { describe, expect, it } from "vitest";
import { emptyForm, formToInput, formToPreview } from "../src/lib/invoices/form";
import { buildSheetModel } from "../src/lib/invoices/sheetModel";
import { QUICK_TYPE_NAMES, addSector, applyAssist, countText, otherLines, quickFields, removeSector, renameSector, setCount, zeroPriceNames, type ItemTypeLite } from "../src/lib/invoices/sectors";

const SELLER = { name: "ديجر", email: "support@diger.tech", website: "diger.tech", taxNumber: "", commercialRegister: "" };
const BASE = { id: null, number: "", status: "draft" as const, revision: 1, instapayAddress: "iammagdy@instapay" };
const T = (n: number, nameAr: string, unitCc: number): ItemTypeLite => ({ id: `00000000-0000-4000-8000-00000000000${n}`, nameAr, unitCc });
const TYPES = [T(1, "شركة", 1200), T(2, "مدير", 3500), T(3, "بريد إلكتروني", 45), T(4, "رقم هاتف", 800)];
const ZERO_TYPES = TYPES.map((t) => ({ ...t, unitCc: 0 }));
const blank = () => emptyForm("invoice", "2026-10-31", { rateE4: 507_500, payment: "" });

describe("quick fields", () => {
  it("the four known item types give four fields in the fixed order; a renamed or missing type has none", () => {
    expect(quickFields(TYPES).map((f) => f.name)).toEqual([...QUICK_TYPE_NAMES]);
    expect(quickFields([TYPES[1], TYPES[0]]).map((f) => f.name)).toEqual(["شركة", "مدير"]);
    expect(quickFields([{ ...TYPES[0], nameAr: "منشأة" }])).toEqual([]);
  });
});

describe("a sector row: numbers make lines, empty fields make none, prices come from the item types", () => {
  const owner = () => {
    let f = addSector(blank(), "كهروميكانيكا");
    const k = f.batches[0].key;
    f = setCount(f, k, TYPES[0], "200");
    f = setCount(f, k, TYPES[1], "340");
    return { f, k };
  };

  it("typing 200 companies and 340 managers creates exactly two lines with the default prices (12 and 35 cents), nothing else", () => {
    const { f, k } = owner();
    expect(f.lines).toHaveLength(2);
    expect(f.lines.map((l) => [l.itemTypeName, l.qty, l.unit, l.batchKey])).toEqual([["شركة", "200", "0.12", k], ["مدير", "340", "0.35", k]]);
    expect(countText(f, k, TYPES[0].id)).toBe("200");
    expect(countText(f, k, TYPES[2].id)).toBe("");
  });

  it("clearing a field (or typing 0) removes its line; changing it updates the same line and keeps a price the owner edited", () => {
    let { f, k } = owner();
    f = { ...f, lines: f.lines.map((l) => (l.itemTypeId === TYPES[0].id ? { ...l, unit: "0.15" } : l)) };
    f = setCount(f, k, TYPES[0], "250");
    expect(f.lines.find((l) => l.itemTypeId === TYPES[0].id)).toMatchObject({ qty: "250", unit: "0.15" });
    expect(setCount(f, k, TYPES[1], "").lines.map((l) => l.itemTypeName)).toEqual(["شركة"]);
    expect(setCount(f, k, TYPES[1], "0").lines.map((l) => l.itemTypeName)).toEqual(["شركة"]);
    expect(setCount(f, k, TYPES[3], "").lines).toHaveLength(2); // an empty field with no line stays no line
  });

  it("each sector keeps its own numbers; removing a sector removes its lines; renaming keeps them", () => {
    let { f, k } = owner();
    f = addSector(f, "بترول");
    const k2 = f.batches[1].key;
    f = setCount(f, k2, TYPES[0], "80");
    expect(f.lines.filter((l) => l.batchKey === k2)).toHaveLength(1);
    f = renameSector(f, k2, "بترول وغاز");
    expect(f.batches[1].title).toBe("بترول وغاز");
    f = removeSector(f, k);
    expect(f.batches.map((b) => b.title)).toEqual(["بترول وغاز"]);
    expect(f.lines.map((l) => l.qty)).toEqual(["80"]);
  });

  it("the lines the quick fields cannot show (another type, a described line, a hidden line) stay listed, never lost", () => {
    let { f, k } = owner();
    const extra = { ...f.lines[0], key: "x1", description: "ملاحظة" };
    f = { ...f, lines: [...f.lines, extra] };
    expect(otherLines(f, k, quickFields(TYPES)).map((l) => l.key)).toEqual(["x1"]);
  });
});

describe("a price of 0 is never silent", () => {
  it("BUG 3: the live item types are all at price 0 -> a sector with numbers lists every type that adds nothing to the total", () => {
    let f = addSector(blank(), "كهروميكانيكا");
    const k = f.batches[0].key;
    f = setCount(f, k, ZERO_TYPES[0], "200");
    f = setCount(f, k, ZERO_TYPES[1], "340");
    expect(zeroPriceNames(f)).toEqual(["شركة", "مدير"]);
    const total = buildSheetModel(formToPreview({ ...f, company: "x" }, BASE), SELLER).totalRows.at(-1)!.amounts;
    expect(total).toEqual(["٠.٠٠"]); // the total really is zero: that is exactly what the warning explains
  });

  it("no warning once the prices are set, for a type with no number typed, or for a price the owner typed on the line", () => {
    let f = addSector(blank(), "ك");
    const k = f.batches[0].key;
    f = setCount(f, k, TYPES[0], "200");
    expect(zeroPriceNames(f)).toEqual([]);
    const z = setCount(addSector(blank(), "ك"), addSector(blank(), "ك").batches[0].key, ZERO_TYPES[0], "");
    expect(zeroPriceNames(z)).toEqual([]);
    const typed = { ...f, lines: f.lines.map((l) => ({ ...l, unit: "0" })) };
    expect(zeroPriceNames(typed)).toEqual(["شركة"]);
    expect(zeroPriceNames({ ...typed, lines: typed.lines.map((l) => ({ ...l, unit: "0.12" })) })).toEqual([]);
  });
});

describe("the owner's real job through the sector rows: the total is the hand-worked figure", () => {
  it("3 sectors: 200 + 340 managers, 80, 120 companies -> $167.00 and 84,753 points; the document saves and reads back the same", () => {
    let f = { ...blank(), company: "شركة العميل", showUsd: true, showPoints: true };
    for (const [title, counts] of [["كهروميكانيكا", [["200", 0], ["340", 1]]], ["بترول", [["80", 0]]], ["مقاولات", [["120", 0]]]] as const) {
      f = addSector(f, title);
      const k = f.batches.at(-1)!.key;
      for (const [n, i] of counts) f = setCount(f, k, TYPES[i], n);
    }
    const total = buildSheetModel(formToPreview(f, BASE), SELLER).totalRows.at(-1)!.amounts;
    expect(total).toEqual(["١٦٧.٠٠", "٨٤٬٧٥٣"]);
    const r = formToInput(f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.lines.map((l) => [l.quantity, l.unitCc])).toEqual([[200, 1200], [340, 3500], [80, 1200], [120, 1200]]);
  });
});

describe("applying the helper's result", () => {
  it("adds sectors and counts as an editable draft with prices from the item types; an existing sector is added to, not duplicated", () => {
    let f = addSector(blank(), "كهروميكانيكا");
    f = setCount(f, f.batches[0].key, TYPES[0], "10");
    const out = applyAssist(f, [
      { sector: "كهروميكانيكا", counts: [{ itemTypeId: TYPES[0].id, itemTypeName: "شركة", quantity: 200 }, { itemTypeId: TYPES[1].id, itemTypeName: "مدير", quantity: 340 }] },
      { sector: "بترول", counts: [{ itemTypeId: TYPES[0].id, itemTypeName: "شركة", quantity: 80 }] },
    ], TYPES);
    expect(out.batches.map((b) => b.title)).toEqual(["كهروميكانيكا", "بترول"]);
    expect(out.lines.map((l) => [l.itemTypeName, l.qty, l.unit])).toEqual([["شركة", "210", "0.12"], ["مدير", "340", "0.35"], ["شركة", "80", "0.12"]]);
    expect(f.lines).toHaveLength(1); // the original form object is not changed
  });
});
