import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { replay } from "./helpers/agentReplay";
import { companiesPage, peopleOfCompany, planArgs, planFlow, request } from "./helpers/a1World";
import { tregResult, type Results } from "./helpers/agentFakeWorld";
import type { FakeStep } from "../agent/src/fakeDriver";
import { contactSampleMessage } from "../src/lib/agentMission/contactSampling";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * ITEM 1: THE FINDER STEP IS MANDATORY WHEN CONTACTS FOR PEOPLE ARE ASKED (owner direction after the live test of 2026-11-01: 14 people, every e-mail and phone cell empty).
 *
 * Evidence (read-only SELECTs): the approved plans of msn_7a8b… (A1) and msn_020c… (A2) had two stages, companies and people; the people stage maps `email: ''` and `phone: ''` and NO stage or step looks an e-mail or a phone up. The planner was told (prompt rule 6, contactSampling
 * message) that a finder it did not sample is «filled only if found during the approved job», and nothing in the job ever looked. Now the step is added BY CODE to the plan of every people stage when the request asks for an e-mail or a phone, whatever the planner wrote.
 */
const proposeWith = (edit: (a: any) => any): FakeStep[] => [...planFlow().slice(0, -1), { tool: "propose_plan", args: (res: Results) => edit(planArgs(res)) } as FakeStep];
const run = (planning: FakeStep[]) => replay({ request, planning, execution: () => [], answers: [tregResult(companiesPage, 0.0005), tregResult(peopleOfCompany("orascom-em"), 0.0005), tregResult(companiesPage, 0.0005), ...Array.from({ length: 12 }, () => tregResult({ results: [] }, 0.0005))] });

describe("the plan of a request that asks for e-mails and phones carries the finder steps, by code", () => {
  it("A1 shape (the planner proposed no finder): the approved plan has an e-mail step and a phone step on the people stage, finders in the catalog's ranking (cheapest expected cost first)", async () => {
    const r = await run(planFlow());
    const steps = (r.plannedPlan as any).contact_steps as Array<{ kind: string; stage_key: string; column_key: string; status_key: string; per_person_usd: number; finders: Array<{ id: string; usd: number }> }> | undefined;
    expect(steps?.map((s) => [s.kind, s.stage_key, s.column_key])).toEqual([["email", "people", "email"], ["phone", "people", "phone"]]);
    for (const s of steps!) {
      expect(s.finders.length).toBeGreaterThan(0);
      expect(s.per_person_usd).toBe(s.finders[0].usd); // the step is priced at its first-ranked finder
      expect(s.per_person_usd).toBeGreaterThan(0);
    }
  });

  it("the planner dropped the e-mail and phone columns altogether: code adds them to the people stage, each followed by an Arabic status column", async () => {
    const r = await run(proposeWith((a) => { a.stages[1].columns = a.stages[1].columns.filter((c: any) => !c.kind); return a; }));
    const cols = (r.plannedPlan.stages.find((s) => s.key === "people")!.columns) as Array<{ key: string; title_ar: string; kind?: string; status_of?: string }>;
    const keys = cols.map((c) => c.key);
    expect(cols.find((c) => c.kind === "work_email")).toBeTruthy();
    expect(cols.find((c) => c.kind === "phone")).toBeTruthy();
    const at = (k: string) => keys.indexOf(k);
    expect(keys[at("email") + 1]).toBe("email_status");
    expect(keys[at("phone") + 1]).toBe("phone_status");
    expect(cols.find((c) => c.key === "email_status")!.title_ar).toMatch(/^حالة توثيق/);
  });

  it("a note that says the contacts are not in the plan does not remove the step (a people stage is there)", async () => {
    const r = await run(proposeWith((a) => ({ ...a, contacts_note_ar: "الإيميل والتليفون لم يُختبر مصدرهما." })));
    expect(((r.plannedPlan as any).contact_steps ?? []).length).toBe(2);
  });
});

describe("no wording lets the planner skip the finder step", () => {
  const prompt = readFileSync("agent/prompts/system.md", "utf8");
  it("the system prompt no longer says a finder that was not sampled leaves the cells «filled only if found» or that an unverified value leaves a cell empty", () => {
    expect(prompt).not.toMatch(/filled only if found during the approved job/);
    expect(prompt).not.toMatch(/an unverified one leaves it empty/);
    expect(prompt).not.toMatch(/is no reason to drop the contact column/);
    expect(prompt).toMatch(/FINDER STEPS ARE ADDED BY CODE/);
  });
  it("the refusal text of a contact sample does not teach the planner to write that the cells are filled only if found", () => {
    for (const why of ["kind_sampled", "too_dear", "over_cap", "cheapest_first"] as const) for (const kind of ["email", "phone"] as const) {
      expect(contactSampleMessage(why, kind, "x.y")).not.toMatch(/filled only if found/);
    }
    expect(contactSampleMessage("kind_sampled", "email", null)).toMatch(/added to the plan by code/);
  });
});
