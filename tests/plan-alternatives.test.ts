import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import type { FakeStep } from "../agent/src/fakeDriver";
import { replay } from "./helpers/agentReplay";
import { callIds, tregResult } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { ENDPOINT, TOPIC, pages, planning, pad } from "./helpers/engineXScenario";

/**
 * S1 item 1.9 (plan side): THE ALTERNATIVES STORED WITH THE PLAN. When the planner also sampled and mapped another source of the same capability, and that mapping gives the stage's columns on the page it was measured on (proven the same way as the main recipe),
 * the plan stores that source as the next tool of the stage: its code-built first-page inputs, its cursor input, its proven mapping. The engine takes it when the first tool fails or runs dry (tests/tool-fallback-continues.test.ts). Only in the redesigned mode;
 * nothing is measured for it beyond what the planner already did, so the plan's price and reserve do not change (a dearer tool that would exceed the reserve is refused by the same budget and the stage ends with need_new_plan).
 */
afterEach(() => { vi.unstubAllGlobals(); });
const ALT = "tikhub.x.twitter-web-fetch-search-timeline";
const altPage = () => ({ data: { tweets: Array.from({ length: 10 }, (_, i) => ({ id: `19${pad(i)}`, text: `${TOPIC} تعليق رقم ${i} في المباراة`, author_id: `acct${i}`, created_at: "2026-10-30T10:00:00Z" })), cursor: "tok_2" } });
const MAP_ALT = "return inputs.call_0002.data.tweets.map(t => ({ id: t.id, text: t.text, url: 'https://x.example/u/status/' + t.id, author: t.author_id, date: t.created_at }))";

/** The standard X planning, with a second source of the same capability sampled and mapped after the first. */
function twoSources(): FakeStep[] {
  const base = planning();
  const [progress, search, describeA, callA, runA, proposeA] = base;
  return [progress, search, describeA, callA,
    { tool: "describe_endpoint", args: { id: ALT } },
    { tool: "treg_call", args: { endpoint_id: ALT, params: { keyword: TOPIC }, why: "a second source of the same job, sampled to have a next tool if the first fails" } },
    runA,
    { tool: "run_code", args: { code: MAP_ALT, files: ["call_0002"] } },
    proposeA,
  ];
}
const run = (flags: unknown) => replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: twoSources(), execution: () => [], answers: [pages(1)[0], tregResult(altPage(), 0.001), ...pages(30)], deps: (d) => { (d.store as MemoryStore).settings.redesign_flags = flags; return d; } });

describe("the next tool is stored with the plan", () => {
  it("flag on: the second sampled source is the stage's alternative, with its own proven mapping and a cursor discovered from its inputs", async () => {
    const r = await run({ social_posts: "on" });
    const engine = r.plannedPlan.stages[0].engine!;
    expect(engine.endpoint_id).toBe(ENDPOINT);
    expect(engine.alternatives).toHaveLength(1);
    const alt = engine.alternatives![0];
    expect(alt.endpoint_id).toBe(ALT);
    expect(alt.map_file_id).toBe("call_0002");
    expect(alt.map_code).toContain("call_0002");
    expect(alt.cursor_param).toBe("cursor");
    expect(alt.params).toMatchObject({ keyword: TOPIC });
    // the price and the reserve are the ones of the first tool (nothing was measured or priced for the alternative)
    expect(Number(r.plannedPlan.price.reservePoints)).toBeGreaterThan(0);
  });
  it("flags off: no alternative is stored and the plan is as it always was", async () => {
    const r = await run({});
    expect(r.plannedPlan.stages[0].engine!.alternatives).toBeUndefined();
  });
});
void callIds; void firstOutputId;
