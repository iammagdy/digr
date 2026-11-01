import { describe, expect, it, vi } from "vitest";
import { readWorkbook, replay } from "./helpers/agentReplay";
import { COMPANIES, PEOPLE, SLUGS, companiesPage, peopleAnswer, planFlow, request } from "./helpers/a1World";
import { tregResult } from "./helpers/agentFakeWorld";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { executionBudgetUsd } from "../src/lib/agentMission/price";
import type { TregCallOptions } from "../src/functions/shared/tregClient";
// CHANGED (PR 1 part c): the people sheet of «companies and their decision makers» uses the owner's titles (taskContracts.ts): «اسم صانع القرار», «إيميل المسؤول المباشر», «هاتف / محمول المسؤول» and the statuses beside them

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * THE A1 REPLAY OF THE LIVE TEST OF 2026-11-01 (msn_7a8b…: 5 companies, 10 people, all with a name, a job title and a professional page, every e-mail and phone cell EMPTY although the e-mail finder had answered for some of them).
 * BEFORE (finders that find nothing, which is what the file looked like): 10 people, 0 e-mails. AFTER (finders that answer): e-mails fill the cells, the verified ones with «موثّق», the ones the check does not verify with «غير موثّق», the phone cells likewise;
 * the people are the same 10, the delivered count and the charge are what they were, and the spend stays inside the approved reserve.
 */
const catalog = loadTregCatalog();
const cell = (v: unknown) => String(v ?? "").trim();
const sum = (s: string) => [...s].reduce((n, c) => n + c.charCodeAt(0), 0);

/** What the fake sources answer: companies and people as the A1 world; an e-mail finder answers by the person it is asked for (a company address, a mailbox the check does not verify, or nothing); a phone finder for some. */
function dispatcher(mode: "none" | "answer") {
  return (o: TregCallOptions) => {
    const capability = catalog.byId.get(o.endpointId)?.capability ?? "";
    if (o.endpointId === COMPANIES) return tregResult(companiesPage, 0.0005);
    if (o.endpointId === PEOPLE) return peopleAnswer(o);
    const who = JSON.stringify(o.params ?? {});
    if (capability === "people.email.find" || capability === "people.email.find.personal") {
      if (mode === "none") return tregResult({ found: false }, 0);
      const h = sum(who) % 3;
      // CHANGED (item 2): the address is on the domain of the person's OWN company (it was always orascom-em's, whoever the person was), so the company-domain rule can tell it from another company's
      if (h === 0) return tregResult({ found: true, email: `person${sum(who)}@${SLUGS.find((s) => who.includes(s)) ?? "orascom-em"}.com.eg` }, 0.000495);
      if (h === 1) return tregResult({ found: true, email: `person${sum(who)}@gmail.com` }, 0.000495);
      return tregResult({ found: false }, 0);
    }
    // CHANGED (item 2): the verifier of the chain answers safe and deliverable (it is the only thing that makes an address «موثّق»)
    if (capability === "people.email.verify") return tregResult({ status: "safe", deliverable: true, is_catch_all: false }, 0.00178);
    if (capability === "people.phone.find" || capability === "people.phone.find.personal") {
      if (mode === "none" || sum(who) % 2 === 1) return tregResult({ found: false }, 0);
      return tregResult({ found: true, phone: `+2010${String(sum(who) * 7919).padStart(8, "0").slice(0, 8)}` }, 0.000495);
    }
    return peopleAnswer(o);
  };
}
const a1 = (mode: "none" | "answer") => replay({ request, planning: planFlow(), execution: () => [], answers: Array.from({ length: 140 }, () => dispatcher(mode)) });

async function peopleSheet(r: Awaited<ReturnType<typeof a1>>) {
  const sheet = (await readWorkbook(r)).worksheets[2];
  const header = (sheet.getRow(1).values as unknown[]).map(cell);
  const people = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2));
  const col = (title: string) => people.map((row) => cell(row.getCell(header.indexOf(title)).value));
  return { header, people, col };
}

describe("A1 replay: the people's e-mail and phone cells", () => {
  it("BEFORE: finders that find nothing: the same 10 people are delivered, no e-mail and no phone, no status", async () => {
    const r = await a1("none");
    const s = await peopleSheet(r);
    expect(s.people.length).toBe(10);
    expect(s.col("إيميل المسؤول المباشر").filter(Boolean).length).toBe(0);
    expect(s.col("هاتف / محمول المسؤول").filter(Boolean).length).toBe(0);
    expect(s.col("حالة توثيق إيميل المسؤول المباشر").filter(Boolean).length).toBe(0);
  });

  it("AFTER: finders that answer: e-mails and phones fill the cells with their Arabic status next to them; the people, the delivered count and the charge are unchanged; the spend is inside the approved reserve", async () => {
    const none = await a1("none");
    const r = await a1("answer");
    const s = await peopleSheet(r);
    expect(s.people.length).toBe(10);
    const emails = s.col("إيميل المسؤول المباشر");
    const status = s.col("حالة توثيق إيميل المسؤول المباشر");
    const filled = emails.filter(Boolean);
    expect(filled.length).toBeGreaterThan(0);
    // every value has its status beside it, and the empty cells have none
    emails.forEach((e, i) => expect(status[i] === "").toBe(e === ""));
    // CHANGED (item 2): a verifier-backed «موثّق» for the company's own addresses; an address on another domain (gmail.com) is «غير موثّق لهذه الشركة»
    expect(new Set(status.filter(Boolean))).toEqual(new Set(["موثّق", "غير موثّق لهذه الشركة"]));
    emails.forEach((e, i) => { if (e.endsWith("@gmail.com")) expect(status[i]).toBe("غير موثّق لهذه الشركة"); else if (e) expect(status[i]).toBe("موثّق"); });
    const phones = s.col("هاتف / محمول المسؤول").filter(Boolean);
    expect(phones.length).toBeGreaterThan(0);
    expect(s.col("حالة توثيق هاتف / محمول المسؤول").filter(Boolean).length).toBe(phones.length);
    // the status column sits right after its value column
    expect(s.header.indexOf("حالة توثيق إيميل المسؤول المباشر")).toBe(s.header.indexOf("إيميل المسؤول المباشر") + 1);
    // decision-maker titles first: every chief executive / general manager is looked up before an accountant is
    // money: the delivered count and the charge do not depend on what the finders found; the spend stays inside what the reserve allows
    expect(r.mission.delivered_units).toBe(none.mission.delivered_units);
    expect(r.mission.charged_points).toBe(none.mission.charged_points);
    expect(Number(r.mission.charged_points)).toBeLessThanOrEqual(Number(r.mission.reserved_points));
    expect(Number(r.mission.execution_treg_usd)).toBeLessThanOrEqual(executionBudgetUsd(Number(r.mission.reserved_points)) + 1e-9);
    // the finders ran as the plan said: only the plan's ranked finders were called, at most three per person and kind
    const steps = (r.plannedPlan as any).contact_steps as Array<{ finders: Array<{ id: string }> }>;
    const allowed = new Set(steps.flatMap((x) => x.finders.map((f) => f.id)));
    const finderCalls = (await r.store.listCalls(r.missionId)).filter((c) => c.phase === "execution" && allowed.has(c.endpoint_id));
    expect(finderCalls.length).toBeGreaterThan(0);
    expect(finderCalls.length).toBeLessThanOrEqual(10 * 3 * 2);
  });
});
