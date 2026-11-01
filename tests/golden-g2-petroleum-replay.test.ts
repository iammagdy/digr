import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook } from "./helpers/agentReplay";
import { cell, g1, PHONES } from "./helpers/g1World";

/**
 * GOLDEN PROMPT G2 (docs/AUDIT-2026-11.md section 7), OFFLINE REPLAY: «عايز ٥ شركات مصرية في قطاع البترول، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون» (the second sector; baseline msn_020c92a0bc1cca3a54a7, 9 of 15 delivered).
 * The same shape as G1 (the world is tests/helpers/g1World.ts with petroleum companies): the reference's columns 2 to 11 in the order of section 1 over the two sheets, 5 companies + 2 people each delivered, the company's e-mail and HQ phone filled or «غير متوفر».
 */
const run = () => g1({ sector: "petroleum" });
const sheet = async (r: Awaited<ReturnType<typeof run>>, i: number) => {
  const s = (await readWorkbook(r)).worksheets[i];
  const header = (s.getRow(1).values as unknown[]).map(cell);
  const rows = Array.from({ length: s.rowCount - 1 }, (_, k) => s.getRow(k + 2));
  return { header, col: (title: string) => { const at = header.indexOf(title); expect(at, title).toBeGreaterThan(0); return rows.map((row) => cell(row.getCell(at).value)); } };
};

describe("G2 replay: petroleum companies and their decision makers", () => {
  it("the owner's columns in the owner's order over the two sheets (company sheet then person sheet), with «م» first on both", async () => {
    const r = await run();
    const company = await sheet(r, 1);
    const person = await sheet(r, 2);
    const inOrder = (header: string[], titles: string[]) => { const at = titles.map((t) => header.indexOf(t)); expect(at.every((i) => i > 0), JSON.stringify(header)).toBe(true); expect([...at].sort((a, b) => a - b)).toEqual(at); };
    inOrder(company.header, ["م", "اسم الشركة", "النشاط والتخصص", "الموقع الإلكتروني", "الإيميل العام للشركة", "هاتف المقر الرئيسي", "ملاحظات"]);
    inOrder(person.header, ["م", "اسم صانع القرار", "المسمى الوظيفي", "صانع قرار", "إيميل المسؤول المباشر", "هاتف / محمول المسؤول", "ملاحظات"]);
    expect(company.header[1]).toBe("م");
    expect(person.header[1]).toBe("م");
  });

  it("5 companies and 10 people are delivered; the HQ phone is the source's own value or a map search's or «غير متوفر»; the company e-mail is a role mailbox of its own domain or «غير متوفر»", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 15, expectStatus: "completed" });
    const company = await sheet(r, 1);
    const person = await sheet(r, 2);
    expect(company.col("اسم الشركة").every((n) => /Petroleum|Oil|Gas|Energy/.test(n))).toBe(true);
    expect(company.col("النشاط والتخصص").every((a) => a === "Oil and Energy")).toBe(true);
    expect(company.col("هاتف المقر الرئيسي")).toEqual([PHONES[0], PHONES[1], PHONES[2], "+20227770005", "غير متوفر"]);
    expect(company.col("الإيميل العام للشركة")).toEqual(["info@orascom-em.com.eg", "info@nile-em.com.eg", "webmaster@delta-em.com.eg", "غير متوفر", "غير متوفر"]);
    expect(person.col("م").length).toBe(10);
    // no company without a decision maker here: every note is empty, and every person is a decision maker (their titles are the A1 world's)
    expect(company.col("ملاحظات").every((n) => n === "")).toBe(true);
  });
});
