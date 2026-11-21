import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { readDeliveredWorkbook } from "../agent/src/workbookBilling";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";

function stage(key: string, title: string, planned: number, parent: string | null, columns: PricedStage["columns"]): PricedStage {
  return {
    key, title_ar: title, planned_rows: planned, expected_rows: planned, endpoint_id: "fixture.items",
    parent_key: parent, deliver: true, columns, sample_rows: [], measured_by: [],
    measured_from_calls: [], measured_cost_per_row_usd: 0,
  };
}

function planOf(stages: PricedStage[]): PricedPlan {
  const deliveredRows = stages.reduce((sum, entry) => sum + entry.planned_rows, 0);
  return {
    summary_ar: "ملف بالنتائج المطلوبة",
    stages,
    price: { deliveredRows, totalCostUsd: 0, costPerFinalRowUsd: 0, unitPricePoints: 1, reservePoints: 200, maxChargePoints: 200, overCap: false } as PricedPlan["price"],
  };
}

describe("FX-M1 charges only the contacts and rows in the emitted workbook", () => {
  it.each([
    { variation: "original", expected: { companies: 3, people: 3 }, billed: 5 },
    { variation: "shorter", expected: { companies: 3, people: 2 }, billed: 4 },
    { variation: "replace contact", expected: { companies: 3, people: 3 }, billed: 4 },
    { variation: "add contact", expected: { companies: 3, people: 3 }, billed: 6 },
  ])("$variation", async ({ variation, expected, billed }) => {
    const plan = planOf([
      stage("companies", "الشركات", 3, null, [{ key: "name", title_ar: "اسم الشركة" }]),
      stage("people", "الأشخاص", 3, "companies", [
        { key: "name", title_ar: "اسم الشخص" },
        { key: "email", title_ar: "الإيميل", kind: "work_email" },
        { key: "phone", title_ar: "التليفون", kind: "phone" },
        { key: "phone_type", title_ar: "نوع الرقم", type_of: "phone" },
      ]),
    ]);
    plan.contact_steps = (["email", "phone"] as const).map((kind) => ({
      kind, column_key: kind, stage_key: "people", status_key: `${kind}_status`, per_person_usd: 0, finders: [],
    }));
    const { xlsx, billingLayout } = await buildMissionFiles(plan, {
      companies: ["ألف", "باء", "جيم"].map((name, i) => ({ id: `c${i}`, name })),
      people: [
        { id: "p0", parent_id: "c0", name: "شخص أول", email: "person@example.test", phone: "معرّف 12345678" },
        { id: "p1", parent_id: "c1", name: "شخص ثان", phone: "+20 2 5555 0123", phone_type: "فاكس الشركة" },
        { id: "p2", parent_id: "c2", name: "شخص ثالث", email: "غير متاح", phone: "2026-11-21", phone_type: "01000111222" },
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx as never);
    const people = workbook.worksheets[2];
    const email = people.getRow(1).values as string[];
    const emailColumn = email.indexOf("الإيميل");
    if (variation === "shorter") people.spliceRows(3, 1);
    if (variation === "replace contact") people.getCell(2, emailColumn).value = "غير متاح";
    if (variation === "add contact") people.getCell(4, emailColumn).value = "another@example.test";
    const result = await readDeliveredWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), billingLayout, plan);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.counts).toEqual(expected);
    expect(expected.companies + expected.people - result.unbilled.total).toBe(billed);
  });

  it("counts only the surviving reply in a threaded sheet and rejects changed headers", async () => {
    const text = [{ key: "text", title_ar: "النص" }];
    const plan = planOf([
      stage("posts", "المنشورات", 1, null, text),
      stage("comments", "التعليقات", 1, "posts", text),
      { ...stage("replies", "الردود", 2, "comments", text), replies_of: "comments" },
    ]);
    const { xlsx, billingLayout } = await buildMissionFiles(plan, {
      posts: [{ id: "post", text: "منشور" }],
      comments: [{ id: "comment", parent_id: "post", text: "تعليق" }],
      replies: [{ id: "reply1", parent_id: "comment", text: "رد أول" }, { id: "reply2", parent_id: "comment", text: "رد ثان" }],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx as never);
    const thread = workbook.worksheets[2];
    thread.spliceRows(4, 1);
    const read = async () => readDeliveredWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), billingLayout, plan);
    expect(await read()).toMatchObject({ ok: true, counts: { posts: 1, comments: 1, replies: 1 } });
    thread.getCell(1, 1).value = "اسم آخر";
    expect(await read()).toEqual({ ok: false, code: "layout_mismatch" });
  });
});
