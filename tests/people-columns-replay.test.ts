import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook } from "./helpers/agentReplay";
import { cell, g1 } from "./helpers/g1World";
import { llmCostFromUsage } from "../agent/src/llmCost";
import { MODEL_HAIKU } from "../src/lib/agentMission/constants";
import type { ReviewCall } from "../agent/src/review";

/**
 * GOLDEN PROMPT G1 (docs/AUDIT-2026-11.md section 7), OFFLINE REPLAY, PART c: the people's columns of the reference (A, columns 7 and 8) and the owner's per-company note.
 * «م» on both sheets; the person sheet in the owner's order (name, title, the marker «صانع قرار», e-mail and phone with their statuses, the notes last); a title and a name as «العربية (English)»; a company whose delivered people hold no decision maker is marked
 * «لم نجد صناع قرار في هذه الشركة» on its own row and on its people's rows. The names come from ONE small request (a fake here); its cost is added to the mission's model cost.
 */
const FIRST: Record<string, string> = { Hossam: "حسام", Mona: "منى", Ahmed: "أحمد", Salma: "سلمى", Karim: "كريم", Nadia: "نادية", Tamer: "تامر" };
const LAST: Record<string, string> = { orascom: "أوراسكوم", nile: "النيل", delta: "دلتا", cairo: "القاهرة", suez: "السويس" };
const USAGE = { input_tokens: 600, output_tokens: 240 };
const namesRequests: string[] = [];
/** The model's side: a verdict per row when it is asked to review (`rows`), else the Arabic spelling of every numbered name. */
const fakeCall: ReviewCall = async (input) => {
  if (input.rows) return { text: JSON.stringify(Array.from({ length: input.rows }, () => 1)), usage: { input_tokens: 10, output_tokens: 2 } };
  namesRequests.push(input.user);
  const names = input.user.split("\n").slice(1).map((l) => l.replace(/^\d+\.\s*/, ""));
  return { text: JSON.stringify(names.map((n) => { const [f, l] = n.split(" "); return `${FIRST[f] ?? f} ${LAST[l.toLowerCase()] ?? l}`; })), usage: USAGE };
};
/** Suez's source gives no manager at all: its delivered people are engineers. */
const SUEZ_ENGINEERS = ["Engineer", "Engineer II", "Technical Office Engineer", "Accountant", "Receptionist"];
const run = () => { namesRequests.length = 0; return g1({ titles: { "suez-em": SUEZ_ENGINEERS }, deps: (base) => ({ ...base, reviewCall: fakeCall }) }); };

async function sheets(r: Awaited<ReturnType<typeof run>>) {
  const wb = await readWorkbook(r);
  const read = (i: number) => {
    const sheet = wb.worksheets[i];
    const header = (sheet.getRow(1).values as unknown[]).map(cell);
    const rows = Array.from({ length: sheet.rowCount - 1 }, (_, k) => sheet.getRow(k + 2));
    const col = (title: string) => { const at = header.indexOf(title); expect(at, `column «${title}» in ${JSON.stringify(header)}`).toBeGreaterThan(0); return rows.map((row) => cell(row.getCell(at).value)); };
    return { header, rows, col };
  };
  return { company: read(1), people: read(2) };
}

describe("G1 replay, part c: the people sheet in the owner's order", () => {
  it("«م» is the first column of both sheets and counts the rows; the person sheet follows the owner's order, the notes after the contact columns, the internal ids last", async () => {
    const { company, people } = await sheets(await run());
    expect(company.header[1]).toBe("م");
    expect(people.header[1]).toBe("م");
    expect(company.col("م")).toEqual(["1", "2", "3", "4", "5"]);
    expect(people.col("م")).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
    const order = ["اسم صانع القرار", "المسمى الوظيفي", "صانع قرار", "إيميل المسؤول المباشر", "حالة توثيق إيميل المسؤول المباشر", "هاتف / محمول المسؤول", "حالة توثيق هاتف / محمول المسؤول", "ملاحظات"];
    const at = order.map((t) => people.header.indexOf(t));
    expect(at.every((i) => i > 0), JSON.stringify(people.header)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(people.header.slice(-2)).toEqual(["المعرّف", "معرّف الأصل"]);
    expect(company.header.indexOf("ملاحظات")).toBeGreaterThan(company.header.indexOf("هاتف المقر الرئيسي"));
  });

  it("the marker «صانع قرار» says «نعم» for a decision-maker title and «لا» for the rest", async () => {
    const { people } = await sheets(await run());
    const titles = people.col("المسمى الوظيفي");
    const flags = people.col("صانع قرار");
    expect(flags.length).toBe(10);
    titles.forEach((t, i) => expect(flags[i], t).toBe(/Engineer/.test(t) ? "لا" : "نعم"));
    expect(flags.filter((f) => f === "نعم").length).toBe(8);
  });

  it("the title and the name are «العربية (English)»: the lexicon reads the common titles, one request wrote the names", async () => {
    const r = await run();
    const { people } = await sheets(r);
    const titles = people.col("المسمى الوظيفي");
    expect(titles).toContain("الرئيس التنفيذي (Chief Executive Officer)");
    expect(titles).toContain("المؤسس والرئيس التنفيذي (Founder & CEO)");
    expect(titles).toContain("مهندس (Engineer)");
    titles.forEach((t) => expect(t).toMatch(/^[؀-ۿ ]+ \([A-Za-z &]+( II)?\)$/));
    people.col("اسم صانع القرار").forEach((n) => expect(n).toMatch(/^[؀-ۿ ]+ \([A-Za-z ]+\)$/));
    expect(people.col("اسم صانع القرار")).toContain("أحمد أوراسكوم (Ahmed orascom)");
    // ONE request for the whole mission, and nothing but the names in it
    expect(namesRequests.length).toBe(1);
    expect(namesRequests[0].split("\n").length - 1).toBe(10);
  });

  it("a company whose delivered people hold no decision maker is marked on its own row and on its people's rows; the others have no note", async () => {
    const { company, people } = await sheets(await run());
    const notes = company.col("ملاحظات");
    const names = company.col("اسم الشركة");
    names.forEach((n, i) => expect(notes[i], n).toBe(n.startsWith("Suez") ? "لم نجد صناع قرار في هذه الشركة" : ""));
    const companyOfPerson = people.col("اسم الشركة");
    const peopleNotes = people.col("ملاحظات");
    companyOfPerson.forEach((c, i) => expect(peopleNotes[i], c).toBe(c.startsWith("Suez") ? "لم نجد صناع قرار في هذه الشركة" : ""));
    expect(peopleNotes.filter(Boolean).length).toBe(2);
  });

  it("money: 15 delivered, the charge is the one rule's; the names request is counted in the mission's model cost, never charged on top", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 15, expectStatus: "completed" });
    expect(Number(r.mission.charged_points)).toBeLessThanOrEqual(Number(r.mission.reserved_points));
    expect(Number(r.mission.execution_llm_usd)).toBeGreaterThanOrEqual(Number(llmCostFromUsage(MODEL_HAIKU, USAGE).toFixed(6)) - 1e-9);
    // the plan card tells the customer, in plain Arabic, that names and titles come in both languages
    expect(JSON.stringify(r.planView)).toContain("بالعربية");
  });

  it("without a model for the names (no request possible) the names stay as the source gave them and nothing else changes", async () => {
    const r = await g1({ titles: { "suez-em": SUEZ_ENGINEERS } });
    const { people } = await sheets(r);
    people.col("اسم صانع القرار").forEach((n) => expect(n).toMatch(/^[A-Za-z ]+$/));
    people.col("المسمى الوظيفي").forEach((t) => expect(t).toMatch(/\(/));
    assertReplayInvariants(r, { expectDelivered: 15, expectStatus: "completed" });
  });
});
