import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import { replay } from "./helpers/agentReplay";
import { ENDPOINT, TOPIC, pages, planning } from "./helpers/engineXScenario";
import { callIds } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * S1 item 1.6 (wiring): in the redesigned mode the stored recipe of a stage is built BY CODE from the tool's own fields and the stage's typed filters, and records `built_by: "code"`; with every flag off the recipe is the model's measured request, byte for byte.
 */
afterEach(() => { vi.unstubAllGlobals(); });

/** The standard X scenario with two typed filters on the stage: the last 30 days and Arabic. */
function withFilters(steps: FakeStep[]): FakeStep[] {
  return steps.map((s) => {
    if (s.tool !== "propose_plan") return s;
    const make = s.args as (r: unknown) => Record<string, any>;
    return { tool: "propose_plan", args: (r) => { const plan = make(r); plan.stages[0].filters = [{ kind: "period", days: 30 }, { kind: "language", lang: "ar" }]; return plan; } } as FakeStep;
  });
}
const flags = (value: unknown) => (d: Parameters<NonNullable<Parameters<typeof replay>[0]["deps"]>>[0]) => { (d.store as MemoryStore).settings.redesign_flags = value; return d; };

describe("the recipe is built by code in the redesigned mode", () => {
  it("flag on: built_by is «code», the period and the language are in the query of the stored recipe, the measured topic is kept", async () => {
    const r = await replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: withFilters(planning()), execution: () => [], answers: [pages(1)[0], ...pages(30)], deps: flags({ social_posts: "on" }) });
    const engine = r.plannedPlan.stages[0].engine!;
    expect(engine.built_by).toBe("code");
    const q = String(engine.params.query);
    expect(q.startsWith(TOPIC)).toBe(true);
    expect(q).toMatch(/since:\d{4}-\d{2}-\d{2}/);
    expect(q).toContain("lang:ar");
    expect(engine.endpoint_id).toBe(ENDPOINT);
  });
  it("flags all off (the default): the model's measured request, no built_by, no gaps", async () => {
    const r = await replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: withFilters(planning()), execution: () => [], answers: [pages(1)[0], ...pages(30)] });
    const engine = r.plannedPlan.stages[0].engine!;
    expect(engine.built_by).toBeUndefined();
    expect(engine.gaps).toBeUndefined();
    expect(String(engine.params.query)).toBe(TOPIC);
  });
  it("the flag for another type does not change this one (social_comments on, posts off)", async () => {
    const r = await replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: withFilters(planning()), execution: () => [], answers: [pages(1)[0], ...pages(30)], deps: flags({ social_comments: "test", companies: "on" }) });
    expect(r.plannedPlan.stages[0].engine!.built_by).toBeUndefined();
  });
});
void callIds; void firstOutputId;
