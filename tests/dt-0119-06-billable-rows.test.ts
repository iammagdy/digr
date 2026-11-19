import { describe, expect, it } from "vitest";
import { billedUnits, hasContact, minChargeOf, noBillableReasonAr, peopleWithoutRequestedContact, unbilledLineAr } from "../src/lib/agentMission/billableRows";
import { settlementCharge } from "../src/lib/agentMission/price";
import { settlementChargeByStage } from "../src/lib/agentMission/stageUnits";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { jobViewWithMission } from "../src/lib/jobs/requestStatus";
import { buildBoard, type JobRow } from "../src/lib/server/failureBoard";

/**
 * DT-20261119-06 PART B (owner decision D-0117): a delivered person is CHARGED only if a cell of a contact kind the customer asked for holds a real value. The row is delivered either way.
 * These tests pin the pure rule (which people are unbilled), the arithmetic (never above today's charge, the card minimum, nothing billable → nothing charged), the charge table the PR shows the owner,
 * the customer's lines, and the screens that read the job row (the job's delivered count is now the billable one).
 */
const people = (n: number, fill: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, full_name: `Person ${i}`, email: "", phone: "", ...fill(i) }));
const columns = [{ key: "full_name" }, { key: "email", kind: "work_email" }, { key: "email_status", status_of: "email" }, { key: "phone", kind: "phone" }, { key: "phone_status", status_of: "phone" }, { key: "phone_type", type_of: "phone" }];
const step = (kind: "email" | "phone", over: Record<string, unknown> = {}) => ({ stage_key: "people", column_key: kind, kind, ...over });
const planOf = (steps: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({ stages: [{ key: "companies", deliver: true, columns: [{ key: "name" }] }, { key: "people", deliver: true, columns, ...over }], contact_steps: steps as never });
const rowsOf = (p: Array<Record<string, unknown>>) => ({ companies: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: `Company ${i}` })), people: p });

describe("hasContact: a contact is a cell with the SHAPE of a value, never a word list", () => {
  it("an address and a phone are contacts, labelled or not; placeholders, blanks, masked values and shapeless words are not", () => {
    for (const v of ["a@b.co", "gm@orascom-em.com.eg", "person@gmail.com"]) expect(hasContact("email", v), v).toBe(true);
    for (const v of ["+20 100 111 2222", "01001112222", "+20 2 3333 4444"]) expect(hasContact("phone", v), v).toBe(true);
    for (const v of ["", "  ", null, undefined, "غير متوفر", "لم يكتمل البحث", "N/A", "-", "null", "j***@x.com", "none"]) expect(hasContact("email", v), String(v)).toBe(false);
    for (const v of ["", null, undefined, "غير متوفر", "لم يكتمل البحث", "12345", "+20 ***", "N/A", "-"]) expect(hasContact("phone", v), String(v)).toBe(false);
  });
});

describe("peopleWithoutRequestedContact: which delivered people carry none of the asked contacts", () => {
  it("a. both asked, 10 people, 5 with a value in either column: 5 are unbilled", () => {
    const rows = people(10, (i) => (i < 2 ? { email: `p${i}@x.com.eg` } : i < 4 ? { phone: "+20 100 111 2222" } : i === 4 ? { email: "a@b.co", phone: "+20 100 111 3333" } : {}));
    const r = peopleWithoutRequestedContact(planOf([step("email"), step("phone")]), rowsOf(rows));
    expect(r).toEqual({ byStage: { people: 5 }, total: 5, kinds: ["email", "phone"] });
  });
  it("b. e-mail only asked: a person with only a phone is NOT charged; a person with an e-mail is", () => {
    const rows = people(4, (i) => (i === 0 ? { email: "a@b.co" } : i === 1 ? { phone: "+20 100 111 2222" } : {}));
    expect(peopleWithoutRequestedContact(planOf([step("email")]), rowsOf(rows)).total).toBe(3);
    expect(peopleWithoutRequestedContact(planOf([step("phone")]), rowsOf(rows)).total).toBe(3);
    expect(peopleWithoutRequestedContact(planOf([step("email"), step("phone")]), rowsOf(rows)).total).toBe(2);
  });
  it("c. both asked: either one charges the row (only phone, only e-mail), neither does not", () => {
    const rows = people(3, (i) => (i === 0 ? { phone: "+20 100 111 2222" } : i === 1 ? { email: "a@b.co" } : {}));
    expect(peopleWithoutRequestedContact(planOf([step("email"), step("phone")]), rowsOf(rows))).toMatchObject({ total: 1 });
  });
  it("d. placeholders and blanks are not contacts; a value labelled «غير موثّق» or a status next to it IS (it is delivered); a status or type cell is never a contact", () => {
    const rows = people(5, (i) => [{ email: "غير متوفر" }, { email: "لم يكتمل البحث" }, { email: "  " }, { email: "x@y.co", email_status: "غير موثّق — إيميل شخصي" }, { email_status: "موثّق", phone_type: "+20 100 111 2222", phone_status: "+20 100 111 2222" }][i]);
    expect(peopleWithoutRequestedContact(planOf([step("email")]), rowsOf(rows)).total).toBe(4);
  });
  it("e. a native e-mail or phone column of the stage that is not the step's own counts too (marked or keyed as that kind)", () => {
    const native = { columns: [...columns, { key: "work_mail", kind: "work_email" }, { key: "mobile", kind: "phone" }] };
    const rows = people(3, (i) => (i === 0 ? { work_mail: "a@b.co" } : i === 1 ? { mobile: "+20 100 111 2222" } : {}));
    expect(peopleWithoutRequestedContact(planOf([step("email"), step("phone")], native), rowsOf(rows)).total).toBe(1);
  });
  it("f. COUNTER: nothing asked (no person-level step, or only company-level steps) -> every named person is charged as today", () => {
    const rows = people(10, () => ({}));
    expect(peopleWithoutRequestedContact(planOf([]), rowsOf(rows))).toEqual({ byStage: {}, total: 0, kinds: [] });
    expect(peopleWithoutRequestedContact(planOf([step("email", { level: "company" }), step("phone", { level: "company" })]), rowsOf(rows)).total).toBe(0);
    expect(peopleWithoutRequestedContact({ stages: [{ key: "companies", deliver: true }], contact_steps: [] as never }, { companies: [{ id: "c" }] }).total).toBe(0);
  });
  it("g. a stage that is not delivered, or has no rows, adds nothing; two people stages are counted apart; the file caps what is unbilled", () => {
    const rows = people(5, () => ({}));
    expect(peopleWithoutRequestedContact(planOf([step("email")], { deliver: false }), rowsOf(rows)).total).toBe(0);
    expect(peopleWithoutRequestedContact(planOf([step("email")]), { companies: [], people: [] }).total).toBe(0);
    const two = { stages: [{ key: "companies", deliver: true }, { key: "a", deliver: true, columns }, { key: "b", deliver: true, columns }], contact_steps: [step("email", { stage_key: "a" }), step("email", { stage_key: "b" })] as never };
    expect(peopleWithoutRequestedContact(two, { a: people(3, () => ({})), b: people(2, (i) => (i === 0 ? { email: "a@b.co" } : {})) })).toMatchObject({ byStage: { a: 3, b: 1 }, total: 4 });
    expect(peopleWithoutRequestedContact(planOf([step("email")]), rowsOf(rows), { people: 3 })).toMatchObject({ byStage: { people: 3 }, total: 3 });
  });
});

describe("billedUnits: never above today's charge; the card minimum; nothing billable -> nothing charged", () => {
  const UNIT = 211.6;
  const HOLD = 3651;
  const blended = (units: number) => settlementCharge({ deliveredUnits: units, unitPricePoints: UNIT, reservedPoints: HOLD }).chargedPoints;
  const chargeOfBlended = (c: { base: number; estimated: number }) => blended(c.base + c.estimated);
  it("the charge table of the live job 6dac53c6 (5 companies + 10 people, unit 211.6, hold 3,651): people with a contact -> charge", () => {
    const table: Array<[number, number]> = [[10, 3174], [7, 2540], [5, 2116], [3, 1693], [1, 1270], [0, 1058]];
    for (const [withContact, charge] of table) {
      const billed = billedUnits({ delivered: 15, unbilledTotal: 10 - withContact, unbilledInGroup: 0, stageCounts: null, minChargePoints: 200, chargeOf: chargeOfBlended });
      expect(billed.deliveredUnits, `${withContact} with a contact`).toBe(5 + withContact);
      expect(billed.counts).toBeNull();
      expect(blended(billed.deliveredUnits)).toBe(charge);
      expect(blended(billed.deliveredUnits)).toBeLessThanOrEqual(3174);
      expect(billed.reduced).toBe(10 - withContact);
    }
  });
  it("nothing billable (a people-only delivery, nobody has a contact): 0 units, nothing is charged, the whole hold is released", () => {
    const billed = billedUnits({ delivered: 10, unbilledTotal: 10, unbilledInGroup: 0, stageCounts: null, minChargePoints: 200, chargeOf: chargeOfBlended });
    expect(billed).toEqual({ deliveredUnits: 0, counts: null, reduced: 10 });
    expect(blended(billed.deliveredUnits)).toBe(0);
  });
  it("the card minimum: with at least one billable row the charge is never below it (rows are added back); 2 rows sold at 100 points, 1 billable -> 200 as today", () => {
    const at100 = (c: { base: number; estimated: number }) => settlementCharge({ deliveredUnits: c.base + c.estimated, unitPricePoints: 100, reservedPoints: 1000 }).chargedPoints;
    expect(billedUnits({ delivered: 2, unbilledTotal: 1, unbilledInGroup: 0, stageCounts: null, minChargePoints: 200, chargeOf: at100 }).deliveredUnits).toBe(2);
    expect(billedUnits({ delivered: 10, unbilledTotal: 8, unbilledInGroup: 0, stageCounts: null, minChargePoints: 200, chargeOf: (c) => settlementCharge({ deliveredUnits: c.base + c.estimated, unitPricePoints: 50, reservedPoints: 1000 }).chargedPoints }).deliveredUnits).toBe(4);
    // no minimum reached when the hold itself is lower (the hold caps the charge, never raised): all the rows are asked for and the charge is the hold's
    expect(billedUnits({ delivered: 3, unbilledTotal: 2, unbilledInGroup: 0, stageCounts: null, minChargePoints: 200, chargeOf: (c) => Math.min(settlementCharge({ deliveredUnits: c.base + c.estimated, unitPricePoints: 10, reservedPoints: 25 }).chargedPoints, 25) }).deliveredUnits).toBe(3);
    expect(minChargeOf(undefined)).toBe(200);
    expect(minChargeOf({ minChargePoints: 350 })).toBe(350);
  });
  it("the per-stage path (DT-01): the unbilled people leave the estimated group first, the others the base; the sum is the delivered units; the property over every number of people with a contact", () => {
    const units = { base: 100, estimated: 60 };
    const BLEND = 80;
    const HOLD2 = 2000;
    const chargeOf = (c: { base: number; estimated: number }) => settlementChargeByStage(c, units, BLEND, HOLD2);
    const today = { base: 5, estimated: 10 };
    for (let withContact = 0; withContact <= 10; withContact += 1) {
      const billed = billedUnits({ delivered: 15, unbilledTotal: 10 - withContact, unbilledInGroup: 10 - withContact, stageCounts: today, minChargePoints: 0, chargeOf });
      expect(billed.counts).toEqual({ base: 5, estimated: withContact });
      expect(billed.deliveredUnits).toBe(5 + withContact);
      expect(chargeOf(billed.counts!)).toBeLessThanOrEqual(chargeOf(today));
      if (withContact === 10) expect(chargeOf(billed.counts!)).toBe(chargeOf(today));
    }
    // unbilled people OUTSIDE the estimated group reduce the base; the group count is untouched
    expect(billedUnits({ delivered: 15, unbilledTotal: 2, unbilledInGroup: 0, stageCounts: today, minChargePoints: 0, chargeOf }).counts).toEqual({ base: 3, estimated: 10 });
    // nothing billable on the per-stage path: 0 and no counts to hand over
    expect(billedUnits({ delivered: 10, unbilledTotal: 10, unbilledInGroup: 10, stageCounts: { base: 0, estimated: 10 }, minChargePoints: 200, chargeOf }).deliveredUnits).toBe(0);
    // the minimum on the per-stage path: people are added back first
    const small = billedUnits({ delivered: 4, unbilledTotal: 2, unbilledInGroup: 2, stageCounts: { base: 2, estimated: 2 }, minChargePoints: 400, chargeOf });
    expect(small.counts).toEqual({ base: 2, estimated: 2 });
  });
});

describe("the customer's lines", () => {
  it("the line after a lowered charge and the reason stored with a release pass the customer-text guard, say how many, which contact and that the people stay in the file", () => {
    for (const kinds of [["email", "phone"], ["email"], ["phone"]] as const) {
      for (const n of [1, 2, 3, 5, 11, 100]) {
        const line = unbilledLineAr(n, kinds);
        expect(checkCustomerText(line, { maxChars: 300 }).issues, line).toEqual([]);
        expect(line).toMatch(/^لم يُحتسب عليك /);
        expect(line).toMatch(/في الملف دون مقابل\.$/);
      }
      expect(checkCustomerText(noBillableReasonAr(kinds), { maxChars: 300 }).issues).toEqual([]);
    }
    expect(unbilledLineAr(5, ["email", "phone"])).toBe("لم يُحتسب عليك ٥ أشخاص لأنه لم يظهر لهم إيميل ولا تليفون، وهم باقون في الملف دون مقابل.");
    expect(unbilledLineAr(1, ["email"])).toBe("لم يُحتسب عليك شخص واحد لأنه لم يظهر له إيميل، وهو باقٍ في الملف دون مقابل.");
    expect(unbilledLineAr(2, ["phone"])).toBe("لم يُحتسب عليك شخصين لأنه لم يظهر لهما تليفون، وهما باقيان في الملف دون مقابل.");
    expect(noBillableReasonAr(["email", "phone"])).toBe("لم يظهر لأي شخص ما طلبته من إيميل أو تليفون، فلم يُخصم شيء وعاد الحجز كاملًا.");
  });
});

describe("the screens read the MISSION's delivered count and status when the job belongs to a mission (the job's count is what was charged)", () => {
  it("jobViewWithMission: a mission that completed with 15 rows over a job that stored 10 billable shows 15 and «completed»; a zero-edge mission over a released (failed) job shows completed", () => {
    expect(jobViewWithMission({ status: "completed", delivered_units: 10 }, { status: "completed", delivered_units: 15 })).toEqual({ status: "completed", delivered: 15 });
    expect(jobViewWithMission({ status: "failed", delivered_units: 0 }, { status: "completed", delivered_units: 10 })).toEqual({ status: "completed", delivered: 10 });
    // a mission with no recorded count, or one that did not complete with rows, leaves the job as it is
    expect(jobViewWithMission({ status: "running", delivered_units: 3 }, { status: "executing", delivered_units: null })).toEqual({ status: "running", delivered: 3 });
    expect(jobViewWithMission({ status: "failed", delivered_units: 0 }, { status: "failed", delivered_units: 0 })).toEqual({ status: "failed", delivered: 0 });
    expect(jobViewWithMission({ status: "completed", delivered_units: 4 }, undefined)).toEqual({ status: "completed", delivered: 4 });
  });
  it("the failure board: no job_partial for a mission that delivered what was sold (billable 10 of 15 on the job), no job_failed for the zero edge; a real shortfall of the MISSION is still reported", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    const at = "2026-11-19T11:00:00Z";
    const job = (id: string, over: Partial<JobRow>): JobRow => ({ id, user_id: "u1", status: "completed", endpoint_id: null, target_volume_max: 15, delivered_units: 10, error_message: null, accumulated_cost_usd: 0, created_at: at, updated_at: at, ...over } as JobRow);
    const board = (jobs: JobRow[], missions: Array<[string, { status: string; delivered_units: number }]>) => buildBoard({ jobs, missionOfJob: new Map(missions), requestTextByJob: new Map(), exploration: [], owners: new Map(), now }).rows.map((r) => `${r.jobId}:${r.kind}`);
    expect(board([job("j1", {})], [])).toEqual(["j1:job_partial"]);
    expect(board([job("j1", {})], [["j1", { status: "completed", delivered_units: 15 }]])).toEqual([]);
    expect(board([job("j2", { status: "failed", delivered_units: 0, error_message: "عاد الحجز كاملًا" })], [["j2", { status: "completed", delivered_units: 15 }]])).toEqual([]);
    expect(board([job("j2", { status: "failed", delivered_units: 0, error_message: "عاد الحجز كاملًا" })], [])).toEqual(["j2:job_failed"]);
    expect(board([job("j3", {})], [["j3", { status: "completed", delivered_units: 9 }]])).toEqual(["j3:job_partial"]);
  });
});
