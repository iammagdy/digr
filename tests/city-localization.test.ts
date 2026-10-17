import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { extractCityFromAddress, localizeCityFromAddress, localizeCityName } from "../src/lib/server/addressParser";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";

describe("English city names become Arabic", () => {
  it.each([
    ["Cairo", "القاهرة"],
    ["New Cairo", "القاهرة الجديدة"],
    ["Port Said", "بورسعيد"],
    ["Sheikh Zayed", "الشيخ زايد"],
    ["Nasr City", "مدينة نصر"],
    ["Sharm El Sheikh", "شرم الشيخ"],
    ["6th of October", "السادس من أكتوبر"],
    ["Riyadh", "الرياض"],
    ["Khamis Mushait", "خميس مشيط"],
    ["Al Ahsa", "الأحساء"],
    ["Dubai", "دبي"],
    ["Abu Dhabi", "أبوظبي"],
    ["Kuwait City", "مدينة الكويت"],
    ["Berlin", "برلين"],
    ["München", "ميونخ"],
    ["San Francisco", "سان فرانسيسكو"],
    ["Cape Town", "كيب تاون"],
  ])("%s -> %s", (english, arabic) => {
    expect(localizeCityName(english, "")).toBe(arabic);
  });

  it("finds the city inside a full address and prefers the longest name", () => {
    expect(extractCityFromAddress("12 Street 9, New Cairo, Cairo Governorate, Egypt")).toBe("القاهرة الجديدة");
    expect(extractCityFromAddress("Al Olaya, Riyadh, Saudi Arabia")).toBe("الرياض");
    expect(extractCityFromAddress("Industrial Zone, Port Said, Egypt")).toBe("بورسعيد");
  });

  it("does not match a city name inside another word", () => {
    expect(extractCityFromAddress("Chrome Street 5, Hailey Road")).not.toBe("روما");
    expect(extractCityFromAddress("Chrome Street 5, Hailey Road")).not.toBe("حائل");
  });

  it("Oman the country is not read as Amman the city", () => {
    expect(extractCityFromAddress("مسقط، سلطنة عمان")).toBe("مسقط");
  });

  it("never returns an untranslated Latin city in an Arabic deliverable", () => {
    expect(localizeCityName("Kafr El Sheikh", "Egypt")).toBe("غير متاح");
    expect(localizeCityFromAddress("Street 9, Kafr El Sheikh", "Egypt")).toBe("غير متاح");
    expect(localizeCityName("  ", "Egypt")).toBe("غير متاح");
    expect(localizeCityName("الإسكندرية", "Egypt")).toBe("الإسكندرية");
  });
});

describe("city names in the delivered Excel files", () => {
  it("company workbook city column is Arabic for city values and for city found only in the address", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await generateExcelReport({
      title: "شركات",
      country: "Egypt",
      entityType: "companies",
      rows: [
        { company_name: "A", city: "Port Said" },
        { company_name: "B", address: "5 Street 9, Sheikh Zayed, Egypt" },
        { company_name: "C", city: "Kafr El Sheikh" },
      ],
    })) as any);
    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    const cityColumn = (sheet.getRow(1).values as string[]).indexOf("المدينة");
    expect(sheet.getRow(2).getCell(cityColumn).value).toBe("بورسعيد");
    expect(sheet.getRow(3).getCell(cityColumn).value).toBe("الشيخ زايد");
    expect(sheet.getRow(4).getCell(cityColumn).value).toBe("غير متاح");
  });

  it("people workbook location column is Arabic", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await generateExcelReport({
      title: "صناع قرار",
      entityType: "people",
      rows: [{ contact_name: "Ali", job_title: "CEO", company_name: "X", city: "Riyadh", country: "Saudi Arabia" }],
    })) as any);
    const sheet = workbook.getWorksheet("بيانات المهنيين")!;
    const headers = sheet.getRow(4).values as string[];
    expect(sheet.getRow(5).getCell(headers.indexOf("الدولة / الموقع")).value).toBe("الرياض");
  });
});
