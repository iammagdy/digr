import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import platformFactsData from "../data/treg/platform_facts.json";
import { PLATFORM_FACTS, linkIdentityOf, platformFactOf, platformOfEndpointId, platformOfHost, postKindsInterchangeableOn } from "../src/lib/agentMission/platformFacts";
import { SOCIAL_PLATFORMS, isSocialPlatform } from "../src/lib/agentMission/redesignFlagTypes";
import { platformOfStages } from "../src/lib/agentMission/platformOfStages";
import { canonicalLinkOf } from "../src/lib/agentMission/priorDelivery";
import { sameKind } from "../src/lib/agentMission/namedRoutes";
import { platformLacksCommentsStage, TOOL_CARDS, type ToolCard } from "../src/lib/agentMission/foundation/toolCards";
import { applyAskEdit } from "../src/lib/agentMission/stage2/askCard";

/**
 * DT-20261126-wl4-up2 slice A (D-0240): what each served social platform IS is data (data/treg/platform_facts.json); code reads it and never branches on a platform's name.
 * The golden file was produced by the OLD code (a0900099) over every endpoint id of the catalog and the overlay and over 532 links: the new readers must give the same answer for every one.
 */
const golden = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/wl4-up2-platform-golden.json"), "utf8")) as { ids: Record<string, string | null>; links: Record<string, string | null> };

describe("UP2-A: platform facts are data", () => {
  it("1. the served platforms are the file's keys, in its order (tiktok, x, instagram, facebook, youtube as before)", () => {
    expect([...SOCIAL_PLATFORMS]).toEqual(["tiktok", "x", "instagram", "facebook", "youtube"]);
    expect([...SOCIAL_PLATFORMS]).toEqual(Object.keys(platformFactsData));
    expect(isSocialPlatform("youtube")).toBe(true);
    expect(isSocialPlatform("reddit")).toBe(false);
  });

  it("2. PARITY: the platform of every one of the catalog's and overlay's endpoint ids is what the old code said (3314 ids)", () => {
    const entries = Object.entries(golden.ids);
    expect(entries.length).toBeGreaterThan(3000);
    const wrong = entries.filter(([id, platform]) => platformOfStages([{ endpoint_id: id }]) !== platform).map(([id]) => id);
    expect(wrong).toEqual([]);
    expect(new Set(Object.values(golden.ids))).toEqual(new Set(["tiktok", "x", "instagram", "facebook", "youtube", null]));
  });

  it("3. PARITY: the canonical identity of 532 links (hosts × paths, bad links, tracking queries) is what the old code said", () => {
    const entries = Object.entries(golden.links);
    expect(entries.length).toBe(532);
    const wrong = entries.filter(([url, key]) => canonicalLinkOf(url) !== key).map(([url]) => url);
    expect(wrong).toEqual([]);
    expect(canonicalLinkOf("https://twitter.com/u/status/12?s=20")).toBe("x:status:12");
    expect(canonicalLinkOf("https://youtu.be/ABC")).toBe("youtube:video:ABC");
    expect(canonicalLinkOf("https://www.instagram.com/reel/R1/")).toBe("instagram:media:R1");
    // counter-case: a facebook link has no item rule, so it is its host and path; an unknown host the same
    expect(canonicalLinkOf("https://www.facebook.com/page/posts/1")).toBe("url:facebook.com/page/posts/1");
    expect(canonicalLinkOf("https://example.com/a/b")).toBe("url:example.com/a/b");
    expect(canonicalLinkOf("https://facebook.com.evil.io/a")).toBe("url:facebook.com.evil.io/a");
  });

  it("4. the `x` between a vendor and a job is not the platform; a real X tool is; the first marker in precedence order wins", () => {
    expect(platformOfEndpointId("tikhub.x.user.posts")).toBe("x");
    expect(platformOfEndpointId("justoneapi.x.1688-get-item-detail-v1")).toBeNull();
    expect(platformOfEndpointId("vendor.x.tiktok.thing")).toBe("tiktok");
    expect(platformOfEndpointId("youtube.facebook.mix")).toBe("youtube");
    expect(platformOfEndpointId("anyapi.google.serp.maps")).toBeNull();
    // precedence (tiktok, youtube, instagram, facebook, then x): an id with two platforms' words belongs to the first (measured on the old code)
    for (const [id, platform] of [["youtube.x.user.posts", "youtube"], ["tiktok.x.search.posts", "tiktok"], ["instagram.facebook.x", "instagram"], ["facebook.twitter", "facebook"], ["twitter.tiktok", "tiktok"]] as const) expect(platformOfEndpointId(id)).toBe(platform);
  });

  it("5. YouTube's account «posts» are not its videos; every other platform's are interchangeable with its search; an unknown platform is interchangeable", () => {
    expect(postKindsInterchangeableOn("youtube")).toBe(false);
    for (const p of ["tiktok", "x", "instagram", "facebook", "reddit", "nope"]) expect(postKindsInterchangeableOn(p)).toBe(true);
    expect(sameKind("youtube", "posts", "videos")).toBe(false);
    expect(sameKind("youtube", "videos", "videos")).toBe(true);
    expect(sameKind("tiktok", "posts", "videos")).toBe(true);
    expect(sameKind("facebook", "comments", "posts")).toBe(false);
  });

  it("6. a platform whose tool cards have no comments stage takes replies from the posts: X today; read from the CARDS, not from the name", () => {
    expect(platformLacksCommentsStage("x")).toBe(true);
    for (const p of ["tiktok", "instagram", "facebook", "youtube"] as const) expect(platformLacksCommentsStage(p)).toBe(false);
    expect(platformLacksCommentsStage(null)).toBe(false);
    const card = (platform: string, role: string) => ({ platform, role }) as unknown as ToolCard;
    // a platform added tomorrow with posts and no comments card behaves like X, with no code change; one with a comments card does not; one with no cards is not that platform
    expect(platformLacksCommentsStage("newplat" as any, [card("newplat", "posts.search")])).toBe(true);
    expect(platformLacksCommentsStage("newplat" as any, [card("newplat", "posts.search"), card("newplat", "post.comments")])).toBe(false);
    expect(platformLacksCommentsStage("newplat" as any, [])).toBe(false);
    // the same answer from the real cards as the old `platform === "x"` gave
    expect(TOOL_CARDS.some((c) => c.platform === "x" && (c.role === "video.comments" || c.role === "post.comments"))).toBe(false);
  });

  it("7. the ask card offers comments on every platform but X and refuses the edit there; replies hang on the posts on X, on the comments elsewhere", () => {
    const base: any = { platform: "x", comments: "none", replies: "none", edits: {}, commentsPerParent: null, repliesPerComment: null, commentsBare: null };
    expect(applyAskEdit(base, { field: "comments", value: "some" } as any, { nowMs: 0 })).toMatchObject({ ok: false });
    const tiktok = applyAskEdit({ ...base, platform: "tiktok" }, { field: "comments", value: "some" } as any, { nowMs: 0 }) as any;
    expect(tiktok.ok).toBe(true);
    // on X, replies are allowed with comments "none"; on TikTok they are refused
    expect(applyAskEdit(base, { field: "replies", value: "all" } as any, { nowMs: 0 })).toMatchObject({ ok: true });
    expect(applyAskEdit({ ...base, platform: "tiktok" }, { field: "replies", value: "all" } as any, { nowMs: 0 })).toMatchObject({ ok: false });
  });

  it("8. every platform's fact has the fields the readers need, and hosts/markers are valid patterns", () => {
    for (const [name, f] of Object.entries(PLATFORM_FACTS)) {
      expect(Number.isInteger(f.idPrecedence), name).toBe(true);
      for (const src of [...f.idMarkers, ...f.hosts, ...f.linkIdentity.flatMap((r) => [r.host, r.path].filter((x): x is string => typeof x === "string"))]) expect(() => new RegExp(src), `${name}: ${src}`).not.toThrow();
      for (const r of f.linkIdentity) expect(r.key).toContain("$1");
    }
    expect(new Set(Object.values(PLATFORM_FACTS).map((f) => f.idPrecedence)).size).toBe(Object.keys(PLATFORM_FACTS).length);
    expect(platformOfHost("www.tiktok.com")).toBe("tiktok");
    expect(platformFactOf("reddit")).toBeUndefined();
    expect(linkIdentityOf("reddit", new URL("https://reddit.com/r/a"), "reddit.com", "/r/a")).toBeNull();
  });
});
