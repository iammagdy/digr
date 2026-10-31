import { describe, expect, it } from "vitest";
import { maskCell, maskEmail, maskHeader, maskName, maskPhone } from "../src/lib/invoices/chat/mask";

describe("masking: nothing identifying survives", () => {
  it("e-mails look like a***@d***.com", () => {
    expect(maskEmail("ahmed.hassan@delta-power.com")).toBe("a***@d***.com");
    expect(maskEmail("info@nile.co.uk")).toBe("i***@n***.uk");
    expect(maskCell("Mona@Alnour-Co.COM")).toBe("M***@A***.COM");
  });

  it("phones look like 010****123, Arabic-Indic digits included; short numbers are fully masked", () => {
    expect(maskPhone("01012345123")).toBe("010****123");
    expect(maskCell("+20 100 123 4567")).toBe("201****567");
    expect(maskCell("٠١٠١٢٣٤٥٦٧٨")).toBe("010****678");
    expect(maskPhone("12345")).toBe("*****");
  });

  it("names and company names are reduced to the first letter of each word", () => {
    expect(maskName("أحمد محمد علي")).toBe("أ. م. ع.");
    expect(maskCell("شركة النصر للكهرباء")).toBe("ش. ا. ل.");
    expect(maskCell("Delta Power Co")).toBe("D. P. C.");
  });

  it("long digit strings (IDs) are masked, a short row number is kept", () => {
    expect(maskCell("29801011234567")).toBe("29****67");
    expect(maskCell("17")).toBe("17");
    expect(maskCell("")).toBe("");
  });

  it("no raw word of a value is ever present in its mask (property over a mixed list)", () => {
    const values = ["ahmed@delta.com", "01099887766", "محمد عبد الرحمن", "شركة الأمل للمقاولات", "29801011234567", "Cairo Electro Mechanical", "٠١١١٢٢٣٣٤٤٥"];
    for (const v of values) {
      const masked = maskCell(v);
      for (const word of v.split(/[\s@.]+/).filter((w) => w.length > 3)) expect(masked, `${v} -> ${masked}`).not.toContain(word);
      const digits = v.replace(/\D/g, "");
      if (digits.length >= 8) expect(masked.replace(/\D/g, "")).not.toBe(digits);
    }
  });

  it("a header that is really a data row (a file with no header row) is masked; a normal label is kept", () => {
    expect(maskHeader("الشركة")).toBe("الشركة");
    expect(maskHeader("البريد الإلكتروني")).toBe("البريد الإلكتروني");
    expect(maskHeader("ahmed@delta.com")).toBe("a***@d***.com");
    expect(maskHeader("01012345678")).toBe("010****678");
    expect(maskHeader("ش".repeat(100))).toHaveLength(60);
  });
});
