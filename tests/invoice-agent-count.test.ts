import { describe, expect, it } from "vitest";
import { countByMapping, emailsIn, normCompany, normPhone, phonesIn } from "../src/lib/invoices/chat/count";
import { colIndex, colLetter, detectHeaderRow, profileSheet } from "../src/lib/invoices/chat/profile";
import type { ParsedSheetFile, SheetMapping } from "../src/lib/invoices/chat/types";
import { newRowBudget, parseAgentFile } from "../src/lib/server/invoices/chat/parseFiles";
import { fixtureElectro, fixtureMixedSectors, fixturePetrol, phone11, phoneVariant } from "./helpers/agentFixtures";

const load = async (f: { name: string; bytes: Uint8Array }): Promise<ParsedSheetFile> => {
  const p = await parseAgentFile(f.name, f.bytes, newRowBudget());
  if (p.kind !== "sheet") throw new Error("not a sheet");
  return p;
};
const electroMap = (file: string): SheetMapping => ({ file, sheet: "الشركات", sectorName: "كهروميكانيكا", columns: { company: "B", manager: "C", email: "D", phone: "E" } });

describe("counting is done by code, on the real cells", () => {
  it("كهروميكانيكا: 200 companies, 312 managers (not 2 per company), 287 valid distinct e-mails, 140 distinct phones", async () => {
    const f = await fixtureElectro();
    const file = await load(f);
    const r = countByMapping([file], [electroMap(f.name)]);
    expect(r.sectors).toHaveLength(1);
    expect(r.sectors[0]).toMatchObject({ sector: "كهروميكانيكا", companies: 200, managers: 312, emails: 287, phones: 140 });
    // the noise is REPORTED, not counted: 6 malformed e-mail cells, 4 «-» phone cells
    expect(r.sectors[0].invalidEmails).toBe(6);
    expect(r.sectors[0].ignoredPhones).toBe(4);
    // the fixture really is uneven: rows > companies, managers < 2 x companies, e-mails < managers
    expect(f.rows.length - 1).toBe(316);
    expect(r.sectors[0].managers).toBeLessThan(2 * r.sectors[0].companies);
  });

  it("بترول: another header wording, no companies without a manager, the second sheet (notes) is not counted", async () => {
    const f = await fixturePetrol();
    const file = await load(f);
    const r = countByMapping([file], [{ file: f.name, sheet: "بيانات", sectorName: "بترول", columns: { company: "B", manager: "C", email: "D", phone: "E" } }]);
    expect(r.sectors[0]).toMatchObject({ sector: "بترول", companies: 150, managers: 190, emails: 120, phones: 95 });
  });

  it("a SECTOR COLUMN splits one sheet by row: مقاولات and عقارات are counted apart, even when interleaved", async () => {
    const f = await fixtureMixedSectors();
    const file = await load(f);
    const r = countByMapping([file], [{ file: f.name, sheet: "الكل", sectorName: null, columns: { company: "B", manager: "C", email: "D", phone: "E", sector: "F" } }]);
    expect(r.sectors.map((s) => s.sector).sort()).toEqual(["عقارات", "مقاولات"]);
    for (const [sector, exp] of Object.entries(f.bySector)) expect(r.sectors.find((s) => s.sector === sector), sector).toMatchObject(exp);
  });

  it("three files at once: each sector is counted from its own file, and the totals add up", async () => {
    const [a, b, c] = [await fixtureElectro(), await fixturePetrol(), await fixtureMixedSectors()];
    const files = [await load(a), await load(b), await load(c)];
    const r = countByMapping(files, [electroMap(a.name), { file: b.name, sheet: "بيانات", sectorName: "بترول", columns: { company: "B", manager: "C", email: "D", phone: "E" } }, { file: c.name, sheet: "الكل", sectorName: null, columns: { company: "B", manager: "C", email: "D", phone: "E", sector: "F" } }]);
    expect(r.sectors.map((s) => s.sector)).toEqual(["كهروميكانيكا", "بترول", "مقاولات", "عقارات"]);
    expect(r.sectors.map((s) => s.companies)).toEqual([200, 150, 120, 60]);
  });

  it("the same sector in two files merges: a company in both counts once, and so does the same person of the same company (a copy of a file adds nothing)", async () => {
    const f = await fixtureElectro();
    const one = await load(f);
    const two: ParsedSheetFile = { ...one, name: "نسخة.xlsx" };
    const r = countByMapping([one, two], [electroMap(f.name), { ...electroMap("نسخة.xlsx") }]);
    expect(r.sectors).toHaveLength(1);
    expect(r.sectors[0]).toMatchObject({ companies: 200, emails: 287, phones: 140, managers: 312, duplicateContacts: 312 });
  });

  it("no mapped sector name and no sector column: the file name is the sector (stated in the report)", async () => {
    const f = await fixtureElectro();
    const r = countByMapping([await load(f)], [{ file: f.name, sheet: "الشركات", sectorName: null, columns: { company: "B" } }]);
    expect(r.sectors[0].sector).toBe("كهروميكانيكا");
    expect(r.sectors[0]).toMatchObject({ companies: 200, managers: 0, emails: 0, phones: 0 });
  });

  it("a mapped letter beyond the sheet counts nothing; an unknown sheet or file is skipped", async () => {
    const f = await fixturePetrol();
    const file = await load(f);
    expect(countByMapping([file], [{ file: f.name, sheet: "غير موجودة", sectorName: "x", columns: { company: "B" } }]).sectors).toEqual([]);
    expect(countByMapping([file], [{ file: f.name, sheet: "بيانات", sectorName: "x", columns: { company: "Z" } }]).sectors).toEqual([]);
  });
});

describe("the counting rules, one by one", () => {
  it("company names: alef, ya, tashkeel, tatweel, spaces and case count once; different names stay different", () => {
    expect(normCompany("شركة الأمل")).toBe(normCompany("شركه الامل".replace("شركه", "شركة")));
    expect(normCompany("  شركة   النيل ")).toBe(normCompany("شركة النيل"));
    expect(normCompany("شـركـة النِّيل")).toBe(normCompany("شركة النيل"));
    expect(normCompany("Delta CO.")).toBe(normCompany("delta co"));
    expect(normCompany("شركة النيل")).not.toBe(normCompany("شركة النصر"));
  });

  it("e-mails: several per cell, case-insensitive, malformed ones reported", () => {
    expect(emailsIn("A@B.com; c@d.org / A@b.COM")).toEqual({ valid: ["a@b.com", "c@d.org", "a@b.com"], invalid: 0 });
    expect(emailsIn("لا يوجد")).toEqual({ valid: [], invalid: 2 });
    expect(emailsIn("abc@")).toEqual({ valid: [], invalid: 1 });
    expect(emailsIn("x@y").valid).toEqual([]);
    expect(emailsIn("<info@delta-co.com>").valid).toEqual(["info@delta-co.com"]);
  });

  it("phones: +20, 0020, a lost leading zero, spaces, dashes and Arabic-Indic digits are ONE number; short or digit-less values are reported", () => {
    const p = phone11(7);
    const same = [p, String(Number(p)), `+20 ${p.slice(1)}`, `0020${p.slice(1)}`, `${p.slice(0, 4)}-${p.slice(4)}`, phoneVariant(7, 1) as string];
    expect(new Set(same.map(normPhone)).size).toBe(1);
    expect(normPhone("٠١٠١٢٣٤٥٦٧٨")).toBe("01012345678");
    expect(phonesIn("010 1234 5678 / 011 9999 8888").valid).toEqual(["01012345678", "01199998888"]);
    expect(phonesIn("-")).toEqual({ valid: [], ignored: 1 });
    expect(phonesIn("123")).toEqual({ valid: [], ignored: 1 });
  });

  it("column letters round-trip (A..Z, AA, AB)", () => {
    for (const i of [0, 1, 25, 26, 27, 51, 52, 701, 702]) expect(colIndex(colLetter(i))).toBe(i);
    expect(colLetter(26)).toBe("AA");
  });
});

describe("the header row is found by code", () => {
  it("a title line above the table is skipped; no header row = the first row; numbers are not a header", () => {
    expect(detectHeaderRow([["كشف الشركات"], ["", ""], ["الشركة", "المدير", "الهاتف"], ["أ", "ب", "0101"]])).toBe(2);
    expect(detectHeaderRow([["الشركة", "المدير"], ["أ", "ب"]])).toBe(0);
    expect(detectHeaderRow([["1", "2", "3"], ["الشركة", "المدير", "الهاتف"]])).toBe(1);
    expect(detectHeaderRow([])).toBe(0);
  });
});

describe("what the model may see: the profile", () => {
  it("has headers, counts and at most 5 masked samples per column, and NO raw cell value of the file", async () => {
    for (const f of [await fixtureElectro(), await fixturePetrol(), await fixtureMixedSectors()]) {
      const file = await load(f);
      const profiles = file.sheets.map(profileSheet);
      const json = JSON.stringify(profiles);
      for (const sheet of file.sheets) {
        const data = sheet.rows.slice(1);
        for (const row of data) for (const cell of row) {
          if (cell.length < 4) continue;
          expect(json.includes(cell), `${f.name}: raw «${cell}» leaked`).toBe(false);
        }
      }
      for (const p of profiles) for (const c of p.columns) expect(c.samples.length).toBeLessThanOrEqual(5);
    }
  });

  it("describes the shape: e-mail and phone columns are recognisable without any raw value", async () => {
    const f = await fixtureElectro();
    const file = await load(f);
    const p = profileSheet(file.sheets[0]);
    expect(p.rows).toBe(316);
    expect(p.header_row).toBe(1);
    const by = Object.fromEntries(p.columns.map((c) => [c.col, c]));
    expect(by.D.email_share).toBeGreaterThan(0.5);
    expect(by.E.phone_share).toBeGreaterThan(0.5);
    expect(by.B.header).toBe("اسم الشركة");
    expect(by.D.samples.every((s) => /^[^@]\*\*\*@[^@]\*\*\*\.[a-z]+$/i.test(s) || s === "")).toBe(true);
  });
});
