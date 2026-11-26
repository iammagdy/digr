import { describe, expect, it } from "vitest";
import { foldArabicIndicDigits, invisibleToSpace, removeControlAndInvisible, stripBom } from "../src/lib/arabicNormalize";
import { normalizePromoCode } from "../src/lib/server/promoCodes";
import { normalizeWhatsapp } from "../src/lib/supportContact";
import { toNumber } from "../src/lib/coerce";
import { parseMissionIds } from "../src/lib/agentMission/rawZip";
import { decodeCsv } from "../src/lib/server/invoices/chat/parseFiles";
import { parseCsv } from "../src/lib/server/excelFromCsv";
import { normalizedPostText } from "../src/lib/server/rowDedupe";
import { cleanText } from "../src/lib/invoices/validate";
import { columnSpec } from "../agent/src/sheetLayout";
import { digitsOf, looksLikePhone } from "../src/lib/invoices/chat/mask";
import { normalizePhone, phonesFromPage } from "../src/lib/agentMission/pageExtract";
import { profileSheet } from "../src/lib/invoices/chat/profile";

const enc = (s: string) => new TextEncoder().encode(s);

/** M1 (D-0232): every expected value below was produced by the code of 59dd75c8 (frozen); the new code must give the same value. */
describe("M1 mechanical orthography swaps: same outputs as 59dd75c8", () => {
  it("exported behaviours are unchanged (promo codes, whatsapp digits, numbers, id lists, CSV, post text, cleaning, layout, masks, phones, profile)", () => {
    expect(normalizePromoCode(" ab١٢۳ cd ")).toEqual("AB123 CD"); // promo1
    expect(normalizePromoCode("Ab12")).toEqual("AB12"); // promo2
    expect(normalizeWhatsapp("+٢٠ ١٠٠ ٠١٢٣٤٥٦")).toEqual("201000123456"); // wa1
    expect(normalizeWhatsapp("201000123456")).toEqual("201000123456"); // wa2
    expect(normalizeWhatsapp("۲۰۱۰۰۰۱۲۳۴۵۶")).toEqual(""); // wa3
    expect(toNumber("١٬٢٥٠")).toBeUndefined(); // num1
    expect(toNumber("1,250")).toEqual(1250); // num2
    expect(toNumber("٣٠")).toEqual(30); // num3
    expect(toNumber("۳۰")).toEqual(30); // num4
    expect(toNumber("12.5")).toEqual(12.5); // num5
    expect(parseMissionIds("msn_a، msn_b\nmsn_c")).toEqual({"ok": false, "error": "رقم مهمة غير صحيح. اكتب أرقام المهام كما تظهر في قائمة المهام، مفصولة بفاصلة أو بسطر جديد."}); // ids1
    expect(parseMissionIds("msn_a,msn_b msn_a")).toEqual({"ok": false, "error": "رقم مهمة غير صحيح. اكتب أرقام المهام كما تظهر في قائمة المهام، مفصولة بفاصلة أو بسطر جديد."}); // ids2
    expect(decodeCsv(enc("\uFEFFa,b"))).toEqual("a,b"); // csvDec1
    expect(decodeCsv(enc("a,b"))).toEqual("a,b"); // csvDec2
    expect(parseCsv("\uFEFFa,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]); // csv1
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]); // csv2
    expect(normalizedPostText("مُحَمَّد  أحمد مدرسة مستشفى http://x.co/1 ٥٠ \u0640")).toEqual("محمداحمدمدرسهمستشفي٥٠"); // post1
    expect(normalizedPostText("Hello, World!")).toEqual("helloworld"); // post2
    expect(cleanText("a\u200bb\u0007c d\u202ee\uFEFFf")).toEqual("abc def"); // clean1
    expect(cleanText("invoice 🧾 \u200B\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\uFEFF test")).toEqual("invoice   test"); // clean-am1 (all invisibles + emoji)
    expect(cleanText("نص عادي")).toEqual("نص عادي"); // clean2
    expect(columnSpec({ title: "x", values: ["١٢٫٥", "3,000", "-4"] }).kind).toEqual("number"); // col1
    expect(columnSpec({ title: "x", values: ["abc", "12"] }).kind).toEqual("text"); // col2
    expect(digitsOf("٠١٢ ۳۴۵ ab6")).toEqual("0123456"); // dig1
    expect(looksLikePhone("+20 100 000 1234")).toEqual(true); // ph1
    expect(looksLikePhone("ابج 123")).toEqual(false); // ph2
    expect(looksLikePhone("0100 000 1234 a")).toEqual(false); // ph3
    expect(normalizePhone("+٢٠ ١٠٠ ٣٣٠ ٨٣٢٢", null)).toEqual("+201003308322"); // pn1
    expect(normalizePhone("+20 100 330 8322", null)).toEqual("+201003308322"); // pn2
    expect(phonesFromPage({ markdown: "اتصل ٠١٠٠٣٣٠٨٣٢٢ أو +201003308322" }, "EG")).toEqual([{"phone": "+201003308322"}]); // pg1
    expect(profileSheet({ name: "s", rows: [["name", "email", "n"], ["a", "x@y.co", "١٢"], ["b", "p،q@z.co", "3"], ["c", "", "۴"]] } as any)).toEqual({"sheet": "s", "rows": 3, "header_row": 1, "columns": [{"col": "A", "header": "name", "filled": 3, "distinct": 3, "email_share": 0, "phone_share": 0, "number_share": 0, "avg_words": 1, "samples": ["a.", "b.", "c."]}, {"col": "B", "header": "email", "filled": 2, "distinct": 2, "email_share": 1, "phone_share": 0, "number_share": 0, "avg_words": 1, "samples": ["x***@y***.co", "p***@z***.co"]}, {"col": "C", "header": "n", "filled": 3, "distinct": 3, "email_share": 0, "phone_share": 0, "number_share": 1, "avg_words": 1, "samples": ["١٢", "3", "۴"]}]}); // prof1
  });

  it("documented widening (layout width only): a column of Persian digits is now laid out as a number", () => {
    expect(columnSpec({ title: "x", values: ["۱۲", "۳"] }).kind).toBe("number");
  });
});

describe("M1 module additions: exact sets, nothing else", () => {
  const oracleInvisible = /[​-‏‪-‮⁦-⁩﻿]/g;
  const oracleControl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​‎‏‪-‮⁦-⁩﻿]/g;
  const corpus: string[] = [];
  for (const [a, b] of [[0x0000, 0x00ff], [0x0600, 0x06ff], [0x2000, 0x206f], [0xfe70, 0xfeff]] as Array<[number, number]>) for (let c = a; c <= b; c++) { const ch = String.fromCodePoint(c); corpus.push(ch, `x${ch}y`); }

  it("invisibleToSpace / removeControlAndInvisible / stripBom / foldArabicIndicDigits equal their frozen oracles on every code point of the touched blocks", () => {
    for (const s of corpus) {
      expect(invisibleToSpace(s), `invisible U+${s.codePointAt(0)!.toString(16)}`).toBe(s.replace(oracleInvisible, " "));
      expect(removeControlAndInvisible(s), `control U+${s.codePointAt(0)!.toString(16)}`).toBe(s.replace(oracleControl, ""));
      expect(stripBom(s), `bom U+${s.codePointAt(0)!.toString(16)}`).toBe(s.replace(/^﻿/, ""));
      expect(foldArabicIndicDigits(s), `indic U+${s.codePointAt(0)!.toString(16)}`).toBe(s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));
    }
  });

  it("counter-cases: the other zero-width / format characters are NOT touched; Persian digits stay for foldArabicIndicDigits; only a LEADING BOM goes", () => {
    expect(invisibleToSpace("a⁠b­c")).toBe("a⁠b­c");
    expect(removeControlAndInvisible("a\tb\nc\rd")).toBe("a\tb\nc\rd");
    expect(foldArabicIndicDigits("٣۳")).toBe("3۳");
    expect(stripBom("a﻿b")).toBe("a﻿b");
  });
});
