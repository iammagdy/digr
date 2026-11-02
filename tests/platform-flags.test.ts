import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";

const state = vi.hoisted(() => ({ client: null as any, audits: [] as string[] }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => ({ ok: true, ctx: { adminId: "adm-1", audit: async (_k: string, label: string, detail: string) => { state.audits.push(`${label} | ${detail}`); } } })),
}));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));

import { POST as agentPOST } from "../src/app/api/admin/agent/route";
import { SOCIAL_PLATFORMS, readPlatformFlags, redesignActiveFor, platformOfStages } from "../src/lib/agentMission/redesignFlagTypes";
import { normalizeRedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { redesignStagesOf, anyRedesignFlag } from "../agent/src/redesign";
import { loadOverview } from "../src/lib/agentMission/adminActions";
import { RedesignFlagsSection } from "../src/components/admin/RedesignFlagsSection";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * PER-PLATFORM FLAGS (docs/ROOT-CAUSE.md, section 5.3): tiktok, x, instagram, facebook, youtube. Each defaults to the existing type value (no key = follow the type), is stored in the SAME `redesign_flags` value of `agent_settings` (no SQL), is written by
 * the SAME admin action with the SAME audit row, and has rows in the admin toggle section. RED FIRST: none of this existed.
 */
const stage = (key: string, cap: string, parent: string | null = null) => ({ key, title_ar: "x", parent_key: parent, deliver: true, planned_rows: 5, capability: cap, engine: { built_by: "code" as const } });
const plan = (...s: ReturnType<typeof stage>[]) => ({ stages: s } as never);
const tiktokComments = () => plan(stage("videos", "tiktok.search.videos"), stage("comments", "tiktok.video.comments", "videos"));
const instaComments = () => plan(stage("posts", "instagram.user.posts"), stage("comments", "instagram.post.comments", "posts"));

describe("reading the platform flags", () => {
  it("the five social platforms, in this order", () => { expect([...SOCIAL_PLATFORMS]).toEqual(["tiktok", "x", "instagram", "facebook", "youtube"]); });
  it("only a valid platform with a valid mode is kept; everything else is ignored; an unreadable value is no override", () => {
    expect(readPlatformFlags({ tiktok: "on", x: "maybe", instagram: "test", orkut: "on", social_posts: "on" })).toEqual({ tiktok: "on", instagram: "test" });
    expect(readPlatformFlags(null)).toEqual({});
    expect(readPlatformFlags("on")).toEqual({});
    expect(readPlatformFlags([])).toEqual({});
  });
  it("the six type flags are read exactly as before, platform keys beside them change nothing", () => {
    const raw = { social_posts: "test", tiktok: "on" };
    expect(normalizeRedesignFlags(raw)).toEqual(normalizeRedesignFlags({ social_posts: "test" }));
  });
});

describe("which platform a plan is on, from its structure", () => {
  it("the capability of the stage's tool decides, never the words of a title", () => {
    expect(platformOfStages([stage("a", "tiktok.search.videos")])).toBe("tiktok");
    expect(platformOfStages([stage("a", "facebook.user.posts")])).toBe("facebook");
    expect(platformOfStages([stage("a", "x.search.posts")])).toBe("x");
    expect(platformOfStages([stage("a", "linkedin.company.posts")])).toBeNull();
  });
  it("without a stored capability the endpoint id's own platform words are read, and the X namespace marker of a vendor is not the platform X", () => {
    expect(platformOfStages([{ key: "c", endpoint_id: "scrapecreators.x.v1-facebook-post-comments" } as never])).toBe("facebook");
    expect(platformOfStages([{ key: "t", endpoint_id: "anyapi.x.search.posts" } as never])).toBe("x");
    expect(platformOfStages([{ key: "t", endpoint_id: "tikhub.x.twitter-web-fetch-search-timeline" } as never])).toBe("x");
    expect(platformOfStages([{ key: "i", endpoint_id: "tikhub.x.instagram-v2-fetch-post-comments" } as never])).toBe("instagram");
  });
});

describe("the effective mode: the platform's own value, else the type's", () => {
  const flags = normalizeRedesignFlags({ social_comments: "on" });
  it("no platform key follows the type (the default)", () => {
    expect(redesignActiveFor(flags, {}, "social_comments", "tiktok", { isTest: false })).toBe(true);
    expect(redesignActiveFor(normalizeRedesignFlags({}), {}, "social_comments", "tiktok", { isTest: true })).toBe(false);
  });
  it("a platform key overrides the type in both directions", () => {
    expect(redesignActiveFor(flags, { tiktok: "off" }, "social_comments", "tiktok", { isTest: true })).toBe(false);
    expect(redesignActiveFor(normalizeRedesignFlags({}), { tiktok: "on" }, "social_comments", "tiktok", { isTest: false })).toBe(true);
    expect(redesignActiveFor(normalizeRedesignFlags({}), { tiktok: "test" }, "social_comments", "tiktok", { isTest: false })).toBe(false);
    expect(redesignActiveFor(normalizeRedesignFlags({}), { tiktok: "test" }, "social_comments", "tiktok", { isTest: true })).toBe(true);
  });
  it("a platform key never touches another platform", () => {
    expect(redesignActiveFor(flags, { tiktok: "off" }, "social_comments", "instagram", { isTest: false })).toBe(true);
  });
  it("a type that is not social is never switched by a platform key", () => {
    expect(redesignActiveFor(normalizeRedesignFlags({}), { tiktok: "on" }, "companies", "tiktok", { isTest: false })).toBe(false);
  });
});

describe("the stages that run the new engine honour the platform flag", () => {
  const typeOn = normalizeRedesignFlags({ social_comments: "on" });
  it("flags without any platform key: byte for byte the answer of today", () => {
    expect([...redesignStagesOf(tiktokComments(), typeOn, false)]).toEqual(["videos", "comments"]);
    expect([...redesignStagesOf(tiktokComments(), typeOn, false, {})]).toEqual(["videos", "comments"]);
  });
  it("TikTok switched off alone: the old pipeline for TikTok, the new one for Instagram", () => {
    expect(redesignStagesOf(tiktokComments(), typeOn, false, { tiktok: "off" }).size).toBe(0);
    expect(redesignStagesOf(instaComments(), typeOn, false, { tiktok: "off" }).size).toBe(2);
  });
  it("Instagram switched on alone while every type is off", () => {
    const off = normalizeRedesignFlags({});
    expect(redesignStagesOf(instaComments(), off, false, { instagram: "on" }).size).toBe(2);
    expect(redesignStagesOf(tiktokComments(), off, false, { instagram: "on" }).size).toBe(0);
  });
  it("the pipeline that ran is recorded when only a platform key is switched on", () => {
    expect(anyRedesignFlag(normalizeRedesignFlags({}))).toBe(false);
    expect(anyRedesignFlag(normalizeRedesignFlags({}), { youtube: "test" })).toBe(true);
    expect(anyRedesignFlag(normalizeRedesignFlags({}), { youtube: "off" })).toBe(false);
  });
});

describe("the admin route: the same action, the same audit row, no SQL", () => {
  let db: MemoryDb;
  beforeEach(() => { db = createMemoryDb(); state.client = { from: (t: string) => db.from(t), rpc: async () => ({ data: null, error: null }) }; state.audits = []; });
  const post = (body: unknown) => agentPOST(new Request("http://x/api/admin/agent", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never);
  const stored = async () => (await state.client.from("agent_settings").select("value").eq("key", "redesign_flags").maybeSingle()).data?.value;

  it("switching a platform stores its key beside the six types and writes the audit row", async () => {
    const res = await post({ action: "redesign_flag", type: "tiktok", mode: "test" });
    expect(res.status).toBe(200);
    expect(await stored()).toMatchObject({ tiktok: "test", social_posts: "off", social_account: "off", social_comments: "off" });
    expect(state.audits).toEqual([expect.stringContaining("tiktok: inherit → test")]);
  });
  it("a later write of a TYPE keeps the platform keys (the old write path dropped every key it did not know)", async () => {
    await post({ action: "redesign_flag", type: "youtube", mode: "on" });
    await post({ action: "redesign_flag", type: "social_posts", mode: "test" });
    expect(await stored()).toMatchObject({ youtube: "on", social_posts: "test" });
  });
  it("«inherit» removes the platform key: it follows its type again", async () => {
    await post({ action: "redesign_flag", type: "x", mode: "on" });
    const res = await post({ action: "redesign_flag", type: "x", mode: "inherit" });
    expect(res.status).toBe(200);
    expect((await stored()).x).toBeUndefined();
  });
  it("«inherit» is refused for a type (a type has no parent to follow); an unknown key and an unknown mode are refused and nothing is written", async () => {
    expect((await post({ action: "redesign_flag", type: "social_posts", mode: "inherit" })).status).toBe(400);
    expect((await post({ action: "redesign_flag", type: "orkut", mode: "on" })).status).toBe(400);
    expect((await post({ action: "redesign_flag", type: "tiktok", mode: "sometimes" })).status).toBe(400);
    expect(await stored()).toBeUndefined();
  });
  it("the overview carries the platform flags as stored (none when nothing is stored)", async () => {
    expect((await loadOverview(state.client)).platformFlags).toEqual({});
    db.seed("agent_settings", [{ key: "redesign_flags", value: { social_comments: "on", facebook: "off", x: "maybe" } }]);
    expect((await loadOverview(state.client)).platformFlags).toEqual({ facebook: "off" });
  });
});

describe("the admin section has a row per platform", () => {
  const html = (platformFlags: Record<string, string> = {}) => renderToStaticMarkup(createElement(RedesignFlagsSection as never, { flags: normalizeRedesignFlags({}), platformFlags, confirming: null, busy: false, onPick: () => undefined, onConfirm: () => undefined, onCancel: () => undefined }));
  it("five rows, each with off, test, on and «inherit»; the current mode is pressed; an absent key reads as following the type", () => {
    const out = html({ tiktok: "test" });
    for (const p of SOCIAL_PLATFORMS) {
      expect(out).toContain(`data-testid="redesign-flag-platform-${p}"`);
      for (const m of ["off", "test", "on", "inherit"]) expect(out).toContain(`data-testid="redesign-flag-platform-${p}-${m}"`);
    }
    const row = (p: string) => out.split(`data-testid="redesign-flag-platform-${p}"`)[1].split("</li>")[0];
    expect(row("tiktok")).toContain("الوضع الحالي: تجريبي");
    expect(row("youtube")).toContain("الوضع الحالي: يتبع النوع");
    expect(row("youtube").match(/<button[^>]*data-testid="redesign-flag-platform-youtube-inherit"[^>]*>/)![0]).toContain('aria-pressed="true"');
  });
  it("Arabic only, no Latin letter, no emoji", () => {
    const text = html({ x: "on" }).replace(/<[^>]+>/g, " ");
    for (const line of text.split(/\s{2,}/).filter((l) => l.trim().length > 0)) expect(checkCustomerText(line, { maxChars: 600 }).issues.filter((i) => !/must be Arabic/.test(i)), line).toEqual([]);
  });
});
