import { describe, expect, it } from "vitest";
import { redesignStagesOf } from "../agent/src/redesign";
import { normalizeRedesignFlags } from "../src/lib/agentMission/redesignFlags";

/** S1 (wiring of items 1.1, 1.3, 1.9): which stages run the redesigned engine. The ordering gate lives here: every stage's recipe must be built by code. */
const stage = (key: string, by: "code" | "model" | undefined, parent: string | null = null) => ({ key, title_ar: "x", parent_key: parent, deliver: true, planned_rows: 5, engine: { built_by: by } });
const plan = (...s: ReturnType<typeof stage>[]) => ({ stages: s } as never);

describe("the stages that run the redesigned engine", () => {
  it("a posts plan, flag on, built by code: its stages", () => {
    expect([...redesignStagesOf(plan(stage("posts", "code")), normalizeRedesignFlags({ social_posts: "on" }), false)]).toEqual(["posts"]);
  });
  it("the ordering gate: a recipe the model built never runs the new engine, whatever the flag says", () => {
    expect(redesignStagesOf(plan(stage("posts", "model")), normalizeRedesignFlags({ social_posts: "on" }), false).size).toBe(0);
    expect(redesignStagesOf(plan(stage("posts", undefined)), normalizeRedesignFlags({ social_posts: "on" }), false).size).toBe(0);
  });
  it("no half-new mission: one stage not built by code puts the whole mission on the old path", () => {
    expect(redesignStagesOf(plan(stage("posts", "code"), stage("comments", "model", "posts")), normalizeRedesignFlags({ social_comments: "on" }), false).size).toBe(0);
    expect([...redesignStagesOf(plan(stage("posts", "code"), stage("comments", "code", "posts")), normalizeRedesignFlags({ social_comments: "on" }), false)]).toEqual(["posts", "comments"]);
  });
  it("the flag of the plan's own type decides: comments off, posts on does not switch a comments plan", () => {
    expect(redesignStagesOf(plan(stage("posts", "code"), stage("comments", "code", "posts")), normalizeRedesignFlags({ social_posts: "on" }), false).size).toBe(0);
  });
  it("test mode: only a test account; off: nobody", () => {
    const flags = normalizeRedesignFlags({ social_posts: "test" });
    expect(redesignStagesOf(plan(stage("posts", "code")), flags, true).size).toBe(1);
    expect(redesignStagesOf(plan(stage("posts", "code")), flags, false).size).toBe(0);
    expect(redesignStagesOf(plan(stage("posts", "code")), normalizeRedesignFlags({}), true).size).toBe(0);
  });
});
