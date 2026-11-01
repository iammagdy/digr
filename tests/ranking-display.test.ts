import { describe, expect, it } from "vitest";
import { buildTools } from "../agent/src/tools";
import { normalizeRedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { makeHarness } from "./helpers/agentHarness";

/** S1 item 1.5 (display): in the redesigned mode `describe_endpoint` shows every input with its whole note, and `catalog_search` lists every input of a hit and what it can and cannot carry. */
describe("the planner sees every input and the whole note in the new mode", () => {
  const noteOf = (r: any, name: string) => r.endpoint.inputs.find((i: { name: string }) => i.name === name).note as string;
  it("flags off: the note is clipped as before; new mode: the whole note", async () => {
    const off = makeHarness({ responses: [] });
    const on = makeHarness({ responses: [] });
    on.ctx.redesign = { flags: normalizeRedesignFlags({ social_posts: "on" }), isTest: false };
    const a = await buildTools(off.ctx).find((t) => t.name === "describe_endpoint")!.handler({ id: "anyapi.x.search.posts" }) as any;
    const b = await buildTools(on.ctx).find((t) => t.name === "describe_endpoint")!.handler({ id: "anyapi.x.search.posts" }) as any;
    expect(noteOf(a, "query").length).toBeLessThanOrEqual(141);
    expect(noteOf(b, "query").length).toBeGreaterThan(141);
    expect(noteOf(b, "query")).toMatch(/advanced-search operators/);
  });
  it("catalog_search in the new mode says what each hit can carry for the words of the request", async () => {
    const on = makeHarness({ responses: [], mission: { request_text: "هات ٥٠ تغريدة عن الذكاء الاصطناعي في مصر آخر أسبوع باللغة العربية" } });
    on.ctx.redesign = { flags: normalizeRedesignFlags({ social_posts: "on" }), isTest: false };
    const r = await buildTools(on.ctx).find((t) => t.name === "catalog_search")!.handler({ words: ["tweets", "search"], platform: "x", limit: 5 }) as any;
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) { expect(Array.isArray(h.can_carry)).toBe(true); expect(Array.isArray(h.cannot_carry)).toBe(true); }
    const scores = r.hits.map((h: any) => h.can_carry.filter((c: string) => c !== "count").length);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });
});
