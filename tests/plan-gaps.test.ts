import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { applyGapNotes, gapLinesAr } from "../src/lib/agentMission/gapLines";
import type { MemoryStore } from "../agent/src/memoryStore";
import { replay } from "./helpers/agentReplay";
import { pages, planning } from "./helpers/engineXScenario";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * S1 item 1.7: THE HONEST GAP STATEMENT ON THE PLAN (owner decision D7). The ranking has already tried every other candidate (item 1.5); for each condition no tool can carry, the plan card says so in plain Arabic BEFORE approval and the customer
 * chooses (continue with the rows delivered marked, change the request, or cancel). No line when the tool has the field. Every line goes through checkCustomerText.
 */
afterEach(() => { vi.unstubAllGlobals(); });

describe("the sentences", () => {
  it("one plain Arabic line per condition the tool cannot carry, and one closing line that names the choice", () => {
    const lines = gapLinesAr([{ cls: "country", reason: "no_field" }, { cls: "language", reason: "no_field" }, { cls: "date", reason: "no_field" }]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("البلد");
    expect(lines[1]).toContain("اللغة");
    expect(lines[2]).toContain("الفترة");
    expect(lines[3]).toMatch(/تعدّل الطلب|عدّل الطلب/);
    expect(lines[3]).toContain("إلغاء");
  });
  it("a region that only places the request says it does not guarantee the country", () => {
    const [line] = gapLinesAr([{ cls: "country", reason: "not_enforced" }]);
    expect(line).toContain("لا يضمن");
  });
  it("no gap, no line", () => { expect(gapLinesAr([])).toEqual([]); });
  it("every line is Arabic, with no provider name, no Latin word, no dollar amount, no emoji", () => {
    for (const cls of ["date", "language", "country", "account", "replies"] as const) for (const reason of ["no_field", "not_enforced", "not_in_enum", "unknown_format"] as const) for (const line of gapLinesAr([{ cls, reason }])) expect(checkCustomerText(line).issues).toEqual([]);
  });
});

describe("applied to the plan", () => {
  it("the lines join the notes once (a second pass adds nothing) and keep the notes already there", () => {
    const plan = { notes_ar: ["ملاحظة قائمة."] } as { notes_ar?: string[] };
    applyGapNotes(plan, [{ cls: "language", reason: "no_field" }]);
    const first = [...plan.notes_ar!];
    applyGapNotes(plan, [{ cls: "language", reason: "no_field" }]);
    expect(plan.notes_ar).toEqual(first);
    expect(first[0]).toBe("ملاحظة قائمة.");
    expect(first.length).toBe(3);
  });
  it("no gap leaves the plan untouched", () => {
    const plan = {} as { notes_ar?: string[] };
    applyGapNotes(plan, []);
    expect(plan.notes_ar).toBeUndefined();
  });
});

describe("end to end: a tool that carries the period and the language adds no line", () => {
  function withFilters(steps: FakeStep[]): FakeStep[] {
    return steps.map((s) => s.tool !== "propose_plan" ? s : { tool: "propose_plan", args: (r) => { const plan = (s.args as (r: unknown) => Record<string, any>)(r); plan.stages[0].filters = [{ kind: "period", days: 30 }, { kind: "language", lang: "ar" }]; return plan; } } as FakeStep);
  }
  it("the X search takes both in its query: the stored plan has no gap and its notes carry no gap line", async () => {
    const r = await replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: withFilters(planning()), execution: () => [], answers: [pages(1)[0], ...pages(30)], deps: (d) => { (d.store as MemoryStore).settings.redesign_flags = { social_posts: "on" }; return d; } });
    expect(r.plannedPlan.stages[0].engine!.gaps).toBeUndefined();
    expect((r.plannedPlan.notes_ar ?? []).join(" ")).not.toContain("لا يسمح");
  });
});
