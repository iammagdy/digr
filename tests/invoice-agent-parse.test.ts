import { describe, expect, it } from "vitest";
import { AgentInputError, cellText, checkZipSize, detectKind, newRowBudget, parseAgentFile, parseCsvText } from "../src/lib/server/invoices/chat/parseFiles";
import { fixtureElectro, fixturePetrol, PNG_1X1 } from "./helpers/agentFixtures";

const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "no error"; } catch (e) { return e instanceof AgentInputError ? e.code : `other:${(e as Error).message}`; } };

describe("files are read in memory, with code", () => {
  it("an xlsx fixture is read into rows (header + data), the non-data sheet too, nothing is lost", async () => {
    const f = await fixtureElectro();
    const parsed = await parseAgentFile(f.name, f.bytes, newRowBudget());
    expect(parsed.kind).toBe("sheet");
    if (parsed.kind !== "sheet") return;
    expect(parsed.sheets.map((s) => s.name)).toEqual(["الشركات", "ملاحظات"]);
    expect(parsed.sheets[0].rows).toHaveLength(f.rows.length); // header + every row
    expect(parsed.sheets[0].rows[0]).toEqual(["م", "اسم الشركة", "المدير المسؤول", "البريد الإلكتروني", "الهاتف"]);
    // a phone stored as an Excel NUMBER keeps its digits (the leading zero is gone: a number cell never had it)
    expect(parsed.sheets[0].rows.some((r) => /^1[0125]\d{8}$/.test(r[4]))).toBe(true);
  });

  it("a CSV: BOM, semicolons, quoted cells with commas and newlines, doubled quotes, and Windows-1256 Arabic", async () => {
    const text = "﻿الشركة;المدير;البريد\n\"شركة \"\"النور\"\", للتجارة\";أحمد;a@b.com\nشركة ثانية;\"سطر\nمزدوج\";\n;;\n";
    const rows = parseCsvText(text.replace(/^﻿/, ""));
    expect(rows).toEqual([["الشركة", "المدير", "البريد"], ['شركة "النور", للتجارة', "أحمد", "a@b.com"], ["شركة ثانية", "سطر\nمزدوج", ""]]);
    const utf8 = await parseAgentFile("a.csv", new TextEncoder().encode(text), newRowBudget());
    expect(utf8.kind === "sheet" && utf8.sheets[0].rows[1][0]).toBe('شركة "النور", للتجارة');
    // windows-1256 bytes for «شركة» (0xD4 0xD1 0xDF 0xC9): not valid UTF-8, read as 1256
    const cp1256 = Uint8Array.from([0xd4, 0xd1, 0xdf, 0xc9, 0x2c, 0x78, 0x0a, 0xd4, 0xd1, 0xdf, 0xc9, 0x2c, 0x79]);
    const f = await parseAgentFile("b.csv", cp1256, newRowBudget());
    expect(f.kind === "sheet" && f.sheets[0].rows[0][0]).toBe("شركة");
  });

  it("an image is accepted as an image (png / jpg), never parsed as data", async () => {
    const f = await parseAgentFile("a.png", PNG_1X1, newRowBudget());
    expect(f.kind).toBe("image");
    expect(f.kind === "image" && f.mediaType).toBe("image/png");
  });

  it("refused with a plain error: xls, unknown types, a renamed file, empty, too big, a broken xlsx", async () => {
    const x = await fixturePetrol();
    expect(await code(parseAgentFile("old.xls", x.bytes, newRowBudget()))).toBe("xls");
    expect(await code(parseAgentFile("a.docx", x.bytes, newRowBudget()))).toBe("type");
    expect(await code(parseAgentFile("a.png", x.bytes, newRowBudget()))).toBe("bad_file");   // an xlsx named .png
    expect(await code(parseAgentFile("a.xlsx", PNG_1X1, newRowBudget()))).toBe("bad_file");   // a png named .xlsx
    expect(await code(parseAgentFile("a.csv", x.bytes, newRowBudget()))).toBe("bad_file");    // an xlsx named .csv
    expect(await code(parseAgentFile("a.csv", new Uint8Array(0), newRowBudget()))).toBe("empty");
    expect(await code(parseAgentFile("big.csv", new Uint8Array(10 * 1024 * 1024 + 1).fill(97), newRowBudget()))).toBe("too_big");
    expect(await code(parseAgentFile("big.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(5 * 1024 * 1024).fill(0)]), newRowBudget()))).toBe("too_big");
    expect(await code(parseAgentFile("broken.xlsx", Uint8Array.from([0x50, 0x4b, 1, 2, 3, 4, 5, 6]), newRowBudget()))).toBe("bad_file");
  });

  it("a zip that would unpack to more than the limit is refused BEFORE it is inflated (central directory only)", () => {
    // a hand-built zip: one entry that declares 200 MB uncompressed
    const name = new TextEncoder().encode("x");
    const central = new Uint8Array(46 + name.length); const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint32(24, 200 * 1024 * 1024, true); cv.setUint16(28, name.length, true); central.set(name, 46);
    const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(10, 1, true); ev.setUint32(12, central.length, true); ev.setUint32(16, 0, true);
    const zip = new Uint8Array(central.length + eocd.length); zip.set(central, 0); zip.set(eocd, central.length);
    expect(() => checkZipSize("bomb.xlsx", zip)).toThrowError(AgentInputError);
    expect(() => checkZipSize("bomb.xlsx", Uint8Array.from([1, 2, 3]))).toThrowError(AgentInputError);
  });

  it("the 50,000-row cap is for ALL files together", async () => {
    const big = "الشركة,المدير\n" + "شركة,مدير\n".repeat(30_000);
    const bytes = new TextEncoder().encode(big);
    const budget = newRowBudget();
    await parseAgentFile("one.csv", bytes, budget);
    expect(await code(parseAgentFile("two.csv", bytes, budget))).toBe("rows");
  });

  it("detectKind and cellText basics", () => {
    expect(detectKind("A.XLSX", Uint8Array.from([0x50, 0x4b]))).toBe("xlsx");
    expect(cellText({ richText: [{ text: "شركة " }, { text: "النور" }] })).toBe("شركة النور");
    expect(cellText({ text: "a@b.com", hyperlink: "mailto:a@b.com" })).toBe("a@b.com");
    expect(cellText({ formula: "A1&B1", result: "xy" })).toBe("xy");
    expect(cellText(1012345678)).toBe("1012345678");
    expect(cellText({ error: "#N/A" })).toBe("");
  });
});
