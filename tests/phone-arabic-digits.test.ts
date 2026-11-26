import { describe, expect, it } from "vitest";
import { normalizePhone } from "../src/lib/multiProvider/policy";
import { contactShape, phoneShape } from "../src/lib/agentMission/contactShape";
import { verifyContactValue } from "../src/lib/agentMission/contacts";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { peopleWithoutRequestedContact } from "../src/lib/agentMission/billableRows";
import { decisionMakerDeliveredUnits } from "../src/functions/shared/decisionMakerPricing";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";

describe("Arabic-Indic and Persian phone numbers normalize and pass shape identically to Latin twins", () => {
  it.each([
    ["international spaced Arabic-Indic", "+٢٠ ٢٢ ٣٤٥٦ ٧٨٩٠", "+20 22 3456 7890", "+202234567890"],
    ["local mobile Arabic-Indic", "٠١٠٠١٢٣٤٥٦٧", "01001234567", "01001234567"],
    ["00 international prefix Arabic-Indic", "٠٠٢٠١٠٠١٢٣٤٥٦٧", "00201001234567", "+201001234567"],
    ["trunk zero in parentheses Arabic-Indic", "+٢٠ (٠)٢٢ ٣٤٥٦ ٧٨٩٠", "+20 (0)22 3456 7890", "+202234567890"],
    ["mixed Latin and Arabic-Indic", "+20 ١٠٠ 123 ٤٥٦٧", "+20 100 123 4567", "+201001234567"],
    ["Persian digits", "۰۱۰۰۱۲۳۴۵۶۷", "01001234567", "01001234567"],
  ])("must-pass: %s", (_name, arabic, latin, expected) => {
    expect(normalizePhone(arabic)).toBe(expected);
    expect(normalizePhone(arabic)).toBe(normalizePhone(latin));
    expect(phoneShape(arabic)).toBe(true);
    expect(phoneShape(arabic)).toBe(phoneShape(latin));
    expect(verifyContactValue("phone", arabic)).toBe(verifyContactValue("phone", latin));
  });

  it.each([
    ["all-zero local placeholder", "٠٠٠٠٠٠٠٠٠٠", "0000000000"],
    ["all-zero international placeholder", "+٠ ٠٠٠ ٠٠٠ ٠٠٠٠", "+0 000 000 0000"],
    ["repeated digit placeholder", "١١١١١١١١١١", "1111111111"],
    ["too short (6 digits)", "١٢٣٤٥٦", "123456"],
    ["too long (16 digits)", "+٢٠١٠٠١١١٢٢٢٢٣٣٣٤", "+2010011122223334"],
  ])("counter-case rejected by both normalizePhone and phoneShape: %s", (_name, arabic, latin) => {
    expect(normalizePhone(arabic)).toBeNull();
    expect(normalizePhone(latin)).toBeNull();
    expect(phoneShape(arabic)).toBe(false);
    expect(phoneShape(latin)).toBe(false);
    expect(verifyContactValue("phone", arabic)).toBeNull();
  });

  it.each([
    ["ISO date", "٢٠٢١-٠٣-١٢", "2021-03-12"],
    ["day-first slash date", "١٢/٠٣/٢٠٢١", "12/03/2021"],
    ["decimal", "٣.١٤١٥٩٢٦٥", "3.14159265"],
    ["dotted ip", "١٠.٠.٠.١", "10.0.0.1"],
    ["masked phone", "٠١٠****٥٦٧", "010****567"],
    ["labelled text", "رقم ١٢٣٤٥٦٧٨", "رقم 12345678"],
  ])("counter-case rejected by phoneShape identically to Latin: %s", (_name, arabic, latin) => {
    expect(phoneShape(arabic)).toBe(false);
    expect(phoneShape(latin)).toBe(false);
    expect(contactShape("phone", arabic)).toBe(false);
  });

  it("parity property: every Latin phone/shape case has the identical verdict under toArabicDigits", () => {
    const latinCases = [
      "+20 100 111 2222", "+20 (0)22 345 6789", "01001112222", "0100-111-2222", "(02) 2345 6789",
      "+20 2 3333 4444", "tel:+201001112222", "20123456", "010 1234 5678", "+20 10 1234 5678",
      "+201012345678", "(02) 2345-6789", "02-2345-6789", "010-12-3456", "1234-12-34",
      "2012345678", "55-77-2024", "010.1234.5678", "+44.2071234567", "+1.2025551234",
      "2345678", "+201001112222333", "00 20 22 508 7419", "022 508 7419",
      "2021-03-12", "12/03/2021", "12.03.2021", "3.14159265", "192.168.100.200",
      "Reg No: 12345678", "CR 1234567", "Tax ID 123-456-789", "March 3, 2021", "123456",
      "+2010011122223334", "+20 100 *** 22", "غير متوفر", "  ", "N/A", "a@b.co",
      "2021 - 03 - 12", "+3.14159265", "0000000000", "12 / 05 / 2024", "12 - 05 - 2024",
      "-3.75", "000-000-0000", "+0 000 000 0000", "1111111111", "2021.03.12",
      "+1234567.89", "2021-13-45", "1999/99/99", "2021-3-12", "2021.3.12", "2024.5.7", "2021 - 13 - 45",
    ];
    for (const value of latinCases) {
      const arabic = toArabicDigits(value);
      expect(phoneShape(arabic), `phoneShape(${value})`).toBe(phoneShape(value));
      expect(normalizePhone(arabic), `normalizePhone(${value})`).toBe(normalizePhone(value));
    }
  });

  it("ingest keeps normalized phone for Arabic-Indic cells, drops non-phone Arabic-digit cells, and matches billable/DM unit counts", async () => {
    const st: PricedStage = {
      key: "people", title_ar: "الأشخاص", endpoint_id: "e", expected_rows: 4, planned_rows: 4, parent_key: null, deliver: true,
      columns: [
        { key: "full_name", title_ar: "الاسم" },
        { key: "phone", title_ar: "التليفون", kind: "phone" },
        { key: "phone_status", title_ar: "حالة التليفون", status_of: "phone" },
      ],
    } as unknown as PricedStage;
    const plan = {
      summary_ar: "x",
      stages: [st],
      contact_steps: [{ stage_key: "people", column_key: "phone", kind: "phone" }],
      price: { deliveredRows: 4 },
    } as unknown as PricedPlan;

    const arabicItems = await ItemStore.open(createMemoryStore(), "msn_ar_phone", { legacyStages: ["people"] });
    await ingestRows({ items: arabicItems, plan, addEvent: async () => undefined }, st, [
      { id: "1", full_name: "Ahmed Hassan", phone: "+٢٠ (٠)٢٢ ٣٤٥٦ ٧٨٩٠" },
      { id: "2", full_name: "Mona Samir", phone: "٠١٠٠١٢٣٤٥٦٧" },
      { id: "3", full_name: "Omar Fathy", phone: "٢٠٢١-٠٣-١٢" },
      { id: "4", full_name: "Hala Nabil", phone: "٠٠٠٠٠٠٠٠٠٠" },
    ], { silent: true, idField: null });

    const latinItems = await ItemStore.open(createMemoryStore(), "msn_lat_phone", { legacyStages: ["people"] });
    await ingestRows({ items: latinItems, plan, addEvent: async () => undefined }, st, [
      { id: "1", full_name: "Ahmed Hassan", phone: "+20 (0)22 3456 7890" },
      { id: "2", full_name: "Mona Samir", phone: "01001234567" },
      { id: "3", full_name: "Omar Fathy", phone: "2021-03-12" },
      { id: "4", full_name: "Hala Nabil", phone: "0000000000" },
    ], { silent: true, idField: null });

    const arKept = arabicItems.acceptedRows("people");
    const latKept = latinItems.acceptedRows("people");
    expect(arKept.map((r) => r.phone)).toEqual(["+202234567890", "01001234567", "", ""]);
    expect(arKept.map((r) => r.phone)).toEqual(latKept.map((r) => r.phone));

    expect(peopleWithoutRequestedContact(plan as never, { people: arKept as never }, { people: 4 }))
      .toEqual(peopleWithoutRequestedContact(plan as never, { people: latKept as never }, { people: 4 }));
    expect(decisionMakerDeliveredUnits(arKept as never, ["phone"]))
      .toEqual(decisionMakerDeliveredUnits(latKept as never, ["phone"]));
  });
});
