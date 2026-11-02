import { describe, expect, it } from "vitest";
import { fallbackStageOf } from "../agent/src/redesign";
import { normalizeRedesignFlags } from "../src/lib/agentMission/redesignFlags";

/**
 * THE SILENT FALLBACK IS RECORDED (docs/ROOT-CAUSE.md, cause 3). A flag that is active for the mission but a stage whose recipe is not built by code put 8 of the 20 live missions on the old pipeline with no trace of which stage (the live replies stage with no `built_by`, a
 * comments stage with no recipe, a named-account listing never built by code). The worker records the 1-based number of the first such stage beside `pipe_new`. Null when the flag is off (the old pipeline is then the request, not a fallback) or every stage is built by code.
 */
const st = (key: string, by: "code" | "model" | undefined, parent: string | null = null, cap = "tiktok.video.comments") => ({ key, title_ar: "x", parent_key: parent, deliver: true, planned_rows: 5, capability: cap, engine: by === undefined ? undefined : { built_by: by } });
const plan = (...s: ReturnType<typeof st>[]) => ({ stages: s } as never);
const on = normalizeRedesignFlags({ social_comments: "on" });

describe("the stage that put a mission on the old path", () => {
  it("the replies stage with no built_by is the third stage (msn_48f6c7c80eb7068f2a38)", () => {
    expect(fallbackStageOf(plan(st("videos", "code", null, "tiktok.search.videos"), st("comments", "code", "videos"), st("comments_replies", undefined, "comments")), on, false)).toBe(3);
  });
  it("a comments stage with no recipe at all is the second (msn_a6dacebce7e7b7432aa1)", () => {
    expect(fallbackStageOf(plan(st("videos", "code", null, "tiktok.search.videos"), st("comments", undefined, "videos")), on, false)).toBe(2);
  });
  it("every stage built by code: no fallback", () => {
    expect(fallbackStageOf(plan(st("videos", "code", null, "tiktok.search.videos"), st("comments", "code", "videos")), on, false)).toBeNull();
  });
  it("the flag off is not a fallback; a platform key off is not either", () => {
    expect(fallbackStageOf(plan(st("videos", "code", null, "tiktok.search.videos"), st("comments", undefined, "videos")), normalizeRedesignFlags({}), false)).toBeNull();
    expect(fallbackStageOf(plan(st("videos", "code", null, "tiktok.search.videos"), st("comments", undefined, "videos")), on, false, { tiktok: "off" })).toBeNull();
  });
});
