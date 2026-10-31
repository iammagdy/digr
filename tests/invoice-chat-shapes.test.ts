import { describe, expect, it } from "vitest";
import { countByMapping, emailsIn, isDepartment, normName, phonesIn, sectorBase } from "../src/lib/invoices/chat/count";
import { detectHeaderRow, profileSheet } from "../src/lib/invoices/chat/profile";
import { completeMappings } from "../src/lib/invoices/chat/sheets";
import type { ParsedSheetFile, SheetMapping } from "../src/lib/invoices/chat/types";
import { runAgent } from "../src/lib/server/invoices/chat/run";
import { newRowBudget, parseAgentFile } from "../src/lib/server/invoices/chat/parseFiles";
import {
  ELECTRO_MAPPING, ELECTRO_PER_FILE_MANAGERS, ELECTRO_TRUTH, PETRO_FILE, PETRO_MAPPING, PETRO_SHEETS, PETRO_TRUTH, electroShapeFiles, petroShapeFile,
} from "./helpers/ownerShapeFixtures";

/**
 * The shapes of the owner's real files, reproduced with SYNTHETIC data (no real file is used or committed). On the code before INVOICE AGENT 2 these gave
 *   electromechanical 201 companies / 605 managers  (the merged TITLE row was taken as the header: the real header row was counted as data, +1 company and +1 manager per file)
 *   petroleum 36 companies (the model mapped ONE detail sheet and the code skipped the other two without a word; +1 for the header row again)
 */
const load = async (f: { name: string; bytes: Uint8Array }): Promise<ParsedSheetFile> => {
  const p = await parseAgentFile(f.name, f.bytes, newRowBudget());
  if (p.kind !== "sheet") throw new Error("not a sheet");
  return p;
};
const electroMapping = (file: string, sectorName: string): SheetMapping => ({ file, sheet: "Sheet1", sectorName, columns: { ...ELECTRO_MAPPING } });
const petroMapping = (sheet: string, sectorName = "بترول"): SheetMapping => ({ file: PETRO_FILE, sheet, sectorName, columns: { ...PETRO_MAPPING } });
const count = (files: ParsedSheetFile[], mapped: SheetMapping[]) => { const c = completeMappings(files, mapped); return { ...c, result: countByMapping(files, c.mappings, c.inferred) }; };

describe("the title row is never the header, and header or title rows are never counted", () => {
  it("a title merged across the table reads as one cell: the header is row 2", async () => {
    const [first] = await electroShapeFiles();
    const file = await load(first);
    const rows = file.sheets[0].rows;
    expect(rows[0].filter((c) => c !== "")).toHaveLength(1);           // the merged title is ONE cell
    expect(detectHeaderRow(rows)).toBe(1);                            // the header is the second row
    expect(rows[1].slice(0, 5)).toEqual(["م", "اسم الشركة", "البريد العام للشركة", "هاتف الشركة", "اسم المدير"]);
  });

  it("a title whose text is repeated in every cell (a CSV export of a merged title) is skipped too", () => {
    expect(detectHeaderRow([["دليل", "دليل", "دليل", "دليل"], ["م", "الشركة", "المدير", "الهاتف"], ["1", "أ", "ب", "010"]])).toBe(1);
  });

  it("the profile shows the model the real headers, not the title", async () => {
    const file = await load((await electroShapeFiles())[0]);
    const p = profileSheet(file.sheets[0]);
    expect(p.header_row).toBe(2);
    expect(p.columns.map((c) => c.header)).toContain("اسم المدير");
    expect(p.rows).toBe(file.sheets[0].rows.length - 2);
  });
});

describe("ELECTROMECHANICAL shape: 4 files x 50 companies, continuation rows are more managers", () => {
  it("each file alone: 50 companies and its managers (150 / 151 / 150 / 150)", async () => {
    const files = await Promise.all((await electroShapeFiles()).map(load));
    files.forEach((f, i) => {
      const r = countByMapping([f], [electroMapping(f.name, "كهروميكانيكا")]).sectors[0];
      expect([r.companies, r.managers, r.departments]).toEqual([50, ELECTRO_PER_FILE_MANAGERS[i], 0]);
    });
  });

  it("all four files, each named by the model with its file number: ONE sector, exactly 200 companies and 601 managers (the old code said 201 and 605)", async () => {
    const raw = await electroShapeFiles();
    const files = await Promise.all(raw.map(load));
    const { result, unmapped } = count(files, files.map((f, i) => electroMapping(f.name, `كهروميكانيكا ${i + 1}`)));
    expect(unmapped).toEqual([]);
    expect(result.sectors).toHaveLength(1);
    expect(result.sectors[0]).toMatchObject({ sector: "كهروميكانيكا", companies: ELECTRO_TRUTH.companies, managers: ELECTRO_TRUTH.managers, departments: 0, duplicateCompanies: 0, duplicateContacts: 0 });
    expect(result.sheets.map((s) => s.headerRow)).toEqual([2, 2, 2, 2]);
    expect(result.sheets.map((s) => s.role)).toEqual(["normal", "normal", "normal", "normal"]);
  });

  it("companies with no manager are companies (not managers); the managers' e-mails and phones are information, not extra items", async () => {
    const files = await Promise.all((await electroShapeFiles()).map(load));
    const { result } = count(files, files.map((f) => electroMapping(f.name, "كهروميكانيكا")));
    const s = result.sectors[0];
    expect(s.companies).toBe(200);
    expect(s.managers).toBe(601);
    expect(s.emails).toBe(601);          // one e-mail per manager (the company's general addresses are in another column)
    expect(s.invalidEmails).toBe(0);
    expect(s.phones).toBeGreaterThan(0);  // the company phones: «02… / 010… (Ext. 142)»: two numbers a cell, the extension is not a third
  });
});

describe("PETROLEUM shape: one file, an overall sheet and two detail sheets", () => {
  it("all three sheets mapped: 149 companies (one listed twice), 239 people and 32 departments; 151 repeats ignored (the old code over-counted every sheet again)", async () => {
    const file = await load(await petroShapeFile());
    const { result } = count([file], Object.values(PETRO_SHEETS).map((s, i) => petroMapping(s, ["دليل شركات البترول", "شركات الحفر والخدمات", "شركات الهيئة والمشترك"][i])));
    expect(result.sectors).toHaveLength(1);
    expect(result.sectors[0]).toMatchObject({ sector: "دليل شركات البترول", companies: PETRO_TRUTH.companies, managers: PETRO_TRUTH.people, departments: PETRO_TRUTH.departments });
    expect(result.sectors[0].duplicateCompanies).toBe(PETRO_TRUTH.repeats);
    expect(result.duplicateCompanies).toBe(151);
    expect(result.sheets.map((s) => s.companyRows)).toEqual([150, 35, 115]);
    expect(result.sheets.map((s) => s.role)).toEqual(["overall", "detail", "detail"]);
  });

  it("only the overall sheet mapped: the same truth (the details add nothing)", async () => {
    const file = await load(await petroShapeFile());
    const { result } = count([file], [petroMapping(PETRO_SHEETS.overall)]);
    expect([result.sectors[0].companies, result.sectors[0].managers, result.sectors[0].departments]).toEqual([149, 239, 32]);
  });

  it("the live failure: the model maps ONE DETAIL sheet; the code finds the other two by their headers and counts them, saying which it inferred", async () => {
    const file = await load(await petroShapeFile());
    const { result, inferred, unmapped } = count([file], [petroMapping(PETRO_SHEETS.drilling)]);
    expect(unmapped).toEqual([]);
    expect([...inferred].sort()).toEqual([`${PETRO_FILE}\u0000${PETRO_SHEETS.overall}`, `${PETRO_FILE}\u0000${PETRO_SHEETS.authority}`].sort());
    expect([result.sectors[0].companies, result.sectors[0].managers, result.sectors[0].departments]).toEqual([149, 239, 32]);
    expect(result.sheets.filter((s) => s.inferred)).toHaveLength(2);
    expect(result.sheets.find((s) => s.sheet === PETRO_SHEETS.overall)?.role).toBe("overall");
  });

  it("people and departments are told apart by code, and the contact rows are listed for the owner to move", async () => {
    const file = await load(await petroShapeFile());
    const s = count([file], [petroMapping(PETRO_SHEETS.overall)]).result.sectors[0];
    expect(s.contacts).toHaveLength(271);
    expect(s.contacts.filter((c) => c.kind === "department")).toHaveLength(32);
    expect(s.contacts.filter((c) => c.kind === "department").every((c) => /^(إدارة|قطاع|الإدارة|قسم|Procurement|Department)/.test(c.name))).toBe(true);
    expect(new Set(s.contacts.map((c) => c.id)).size).toBe(271); // every row has its own id
    expect(s.duplicateContacts).toBeGreaterThan(0);              // the repeated company's contacts
  });
});

describe("a sheet is never skipped silently", () => {
  it("a sheet with other headers is put to the owner (real data) or listed as ignored (too small); the counts of the mapped sheets stay exact", async () => {
    const petro = await load(await petroShapeFile());
    const extra: ParsedSheetFile = {
      ...petro,
      sheets: [...petro.sheets,
        { name: "ملخص مالي", truncatedColumns: false, rows: [["ملخص"], ["البند", "القيمة", "ملاحظة"], ["أ", "10", "x"], ["ب", "20", "y"], ["ج", "30", "z"], ["د", "40", "w"]] },
        { name: "ملاحظات", truncatedColumns: false, rows: [["تم السحب يدويًا"], ["مراجعة"]] },
      ],
    };
    const c = count([extra], [petroMapping(PETRO_SHEETS.overall)]);
    expect(c.unmapped).toEqual([
      { file: PETRO_FILE, sheet: "ملخص مالي", rows: 4, columns: 3, status: "ask" },
      { file: PETRO_FILE, sheet: "ملاحظات", rows: 1, columns: 1, status: "ignored" },
    ]);
    expect([c.result.sectors[0].companies, c.result.sectors[0].managers]).toEqual([149, 239]);
  });

  it("the model maps NOTHING: every sheet with data is asked about; none is counted", async () => {
    const file = await load(await petroShapeFile());
    const c = completeMappings([file], []);
    expect(c.mappings).toEqual([]);
    expect(c.unmapped.map((u) => u.status)).toEqual(["ask", "ask", "ask"]);
  });
});

describe("the counting rules inside a sheet", () => {
  const sheet = (rows: string[][], columns: SheetMapping["columns"], sectorName = "س") => {
    const f: ParsedSheetFile = { kind: "sheet", name: "f.xlsx", sheets: [{ name: "s", truncatedColumns: false, rows }] };
    return countByMapping([f], [{ file: "f.xlsx", sheet: "s", sectorName, columns }]).sectors[0];
  };
  const H = ["م", "الشركة", "English", "المدير", "الهاتف"];
  it("an Arabic spelling variant or an English name that matches is the SAME company (the second key)", () => {
    const s = sheet([H, ["1", "شركة الأمل للبترول", "Hope Petroleum", "أحمد", ""], ["2", "شركة الامل للبترول", "", "محمد", ""], ["3", "الأمل بترول", "hope petroleum", "علي", ""], ["4", "شركة النيل", "Nile Co", "منى", ""]], { company: "B", company_en: "C", manager: "D" });
    expect(s.companies).toBe(2);
    expect(s.duplicateCompanies).toBe(2);
    expect(s.managers).toBe(4);
  });

  it("a manager row with an empty company cell belongs to the company above, and a repeated person of the same company is ignored", () => {
    const s = sheet([H, ["1", "شركة أ", "", "م. أحمد حسن", ""], ["", "", "", "محمد علي", ""], ["", "", "", "أحمد حسن", ""], ["2", "شركة ب", "", "أحمد حسن", ""]], { company: "B", manager: "D" });
    expect(s.companies).toBe(2);
    expect(s.managers).toBe(3);               // «م. أحمد حسن» = «أحمد حسن» in company A; the same name in company B is another person
    expect(s.duplicateContacts).toBe(1);
  });

  it("contact rows before any company are kept (the person is real) but are not a company", () => {
    const s = sheet([H, ["", "", "", "أحمد", ""], ["1", "شركة أ", "", "محمد", ""]], { company: "B", manager: "D" });
    expect([s.companies, s.managers]).toEqual([1, 2]);
  });

  it("department rule: إدارة / الإدارة / قطاع / قسم / Department / Procurement start a department; a person does not", () => {
    for (const d of ["إدارة المشتريات والعقود", "الإدارة العامة للمشتريات", "قطاع المشتريات وسلاسل الإمداد", "قسم التوريدات", "Procurement Department", "Department of Contracts", "ادارة العقود"]) expect(isDepartment(d), d).toBe(true);
    for (const p of ["أحمد حسن", "م. إدارة", "Ahmed Procurement", "مهندس محمود", "قطاعي أحمد"]) expect(isDepartment(p), p).toBe(false);
  });

  it("names: honorifics and spacing do not make two people", () => {
    expect(normName("م. أحمد  حسن")).toBe(normName("أحمد حسن"));
    expect(normName("د. منى علي")).toBe(normName("منى علي"));
    expect(normName("الأستاذ محمد")).toBe(normName("محمد"));
    expect(normName("أحمد حسن")).not.toBe(normName("أحمد علي"));
  });

  it("phones: «/» splits, «(Ext. 142)» and «داخلي ٥» are not part of the number, +20 / 0020 / a lost zero are one", () => {
    const r = phonesIn("010 1234 5678 / 02-3333444 (Ext. 142)");
    expect(r.valid).toEqual(["01012345678", "023333444"]);
    expect(phonesIn("02-3333444 داخلي 55").valid).toEqual(["023333444"]);
    expect(phonesIn("+20 100 123 4567 / 0020 100 123 4567 / 1001234567").valid.map((v) => v)).toEqual(["01001234567", "01001234567", "01001234567"]);
    expect(phonesIn("(Ext. 5)")).toEqual({ valid: [], ignored: 0 });
  });

  it("e-mails: several per cell, malformed ones reported", () => {
    expect(emailsIn("a@b.com / C@D.org").valid).toEqual(["a@b.com", "c@d.org"]);
    expect(emailsIn("لا يوجد").invalid).toBe(2);
  });

  it("sector names: the part number of a file is not a different sector", () => {
    for (const n of ["كهروميكانيكا ١", "كهروميكانيكا 2", "كهروميكانيكا - ملف 3", "كهروميكانيكا (4)", "كهروميكانيكا جزء ٢"]) expect(sectorBase(n), n).toBe("كهروميكانيكا");
    expect(sectorBase("بترول")).toBe("بترول");
    expect(sectorBase("٢٠٢٦")).toBe("٢٠٢٦");
  });

  it("the sector column: rows of two sectors in one sheet, continuation rows follow their company's sector", () => {
    const f: ParsedSheetFile = { kind: "sheet", name: "f.xlsx", sheets: [{ name: "s", truncatedColumns: false, rows: [["م", "الشركة", "المدير", "القطاع"], ["1", "أ", "x", "بترول"], ["", "", "y", ""], ["2", "ب", "z", "مقاولات"]] }] };
    const r = countByMapping([f], [{ file: "f.xlsx", sheet: "s", sectorName: null, columns: { company: "B", manager: "C", sector: "D" } }]);
    expect(r.sectors.map((s) => [s.sector, s.companies, s.managers])).toEqual([["بترول", 1, 2], ["مقاولات", 1, 1]]);
  });
});

describe("through the real runner: the model maps one sheet, the answer still counts all of them and says what it inferred", () => {
  it("petroleum with ONE detail sheet mapped: 149 / 239 / 32, two sheets inferred, nothing unmapped", async () => {
    const f = await petroShapeFile();
    let seen = "";
    const r = await runAgent(
      { adminId: "a", message: "اعمل فاتورة", history: [], draft: { doc_type: "invoice", currencies: { usd: false, points: false, egp: true }, rate_set: true, discount: "none", client: "", sectors: [], lines: [], lines_listed: true }, files: [f], itemTypeNames: ["شركة", "مدير"] },
      {
        now: () => new Date(), countAttempts: async () => 0, recordAttempt: async () => true,
        callModel: async (_s, content) => {
          seen = JSON.stringify(content);
          return { ok: true, inputTokens: 1, outputTokens: 1, stopReason: "end_turn", text: JSON.stringify({ mapping: [{ file: PETRO_FILE, sheet: PETRO_SHEETS.drilling, sector_name: "بترول", columns: { company: "B", company_en: "C", manager: "D", email: "F", phone: "G" } }] }) };
        },
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count?.sectors[0]).toMatchObject({ companies: 149, managers: 239, departments: 32 });
    expect(r.inferred).toHaveLength(2);
    expect(r.unmapped).toEqual([]);
    // the model saw all three sheets' profiles (so it could map them), and no raw contact name
    expect(seen).toContain(PETRO_SHEETS.overall);
    expect(seen).not.toMatch(/إدارة المشتريات والعقود/);
  });
});
