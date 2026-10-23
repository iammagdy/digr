import { describe, expect, it } from "vitest";

import { runSocialChunk, type SocialCall, type VideoSelector } from "../src/lib/server/socialAdapter";
import { isUsableComment } from "../src/lib/server/commentQuality";
import { getSocialCapability } from "../src/lib/socialSources";
import { maxPagesForJob } from "../src/lib/server/providerCallCaps";
import { VIDEO_ADOPTED_KEY } from "../src/lib/server/videoAdoption";
import {
  COMMENTS_CALL_MICRO,
  FALLBACK_SEARCH_CALL_MICRO,
  FIXTURE_TOPIC,
  SEARCH_CALL_MICRO,
  facebookKeywordWorld,
  fixtureComments,
  postNumberOf,
} from "./helpers/fakeFacebookKeyword";

/**
 * The Facebook keyword mission through the real social chunk runner: posts are searched page by page, judged as a LIST (the fake judge stands in for the model), and the
 * comments of ADOPTED posts only are read, one call per post. The provider is a fixture (see helpers/fakeFacebookKeyword.ts: prices from the catalog read of 2026-10-23,
 * rows invented). No model, no provider, no network.
 */
const NOW = Date.parse("2026-10-23T12:00:00Z");
const SLUG = "social-facebook-keyword-comments";

/** The fake judge: a post is about the topic when its own text says so; it records every batch it was given. */
function judge() {
  const batches: number[] = [];
  const selector: VideoSelector = async (refs) => {
    batches.push(refs.length);
    return { adopted: refs.filter((ref) => String(ref.title).includes(FIXTURE_TOPIC)) };
  };
  return { selector, batches };
}

interface Drive {
  rows: Array<Record<string, any>>;
  delivered: number;
  steps: number;
  costMicro: number;
  outs: Array<Awaited<ReturnType<typeof runSocialChunk>>>;
}

/** Drives the chunks of one job the way the worker does: the cursor and the remaining count carry over from chunk to chunk. */
async function drive(call: SocialCall, params: Record<string, any>, target: number, selector?: VideoSelector, maxSteps = 400): Promise<Drive> {
  let cursor: string | null = null;
  let delivered = 0;
  let costMicro = 0;
  const rows: Array<Record<string, any>> = [];
  const outs: Drive["outs"] = [];
  let step = 0;
  for (; step < maxSteps; step++) {
    const out = await runSocialChunk({
      jobId: "job_fb", userId: "u", step, endpointId: "scrapecreators.x.v1-facebook-post-comments", capabilitySlug: SLUG, method: "GET", params,
      paginationStrategy: "cursor", cursor, pageSize: 50, remainingNeeded: Math.max(1, target - delivered), targetVolumeMax: target, deliveredSoFar: delivered,
    } as any, { call, now: () => NOW, videoSelector: selector });
    outs.push(out);
    expect(out.ok, `step ${step}`).toBe(true);
    costMicro += out.costMicro;
    const usable = out.rows.filter(isUsableComment).slice(0, Math.max(0, target - delivered));
    rows.push(...usable);
    delivered += usable.length;
    cursor = out.nextCursor;
    if (!cursor || delivered >= target) { step += 1; break; }
  }
  return { rows, delivered, steps: step, costMicro, outs };
}

const owner = { query: FIXTURE_TOPIC, perVideo: 5, videoCount: 300, region: "EG" };

describe("the owner's request on a fixture: 300 posts, 5 comments each", () => {
  it("1,500 comments from 300 adopted posts: one comments call per ADOPTED post, none for the others, 100 search pages, and the whole cost fits the price's cost basis", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 1200 });
    const { selector, batches } = judge();
    const run = await drive(world.call, owner, 1500, selector);

    expect(run.delivered).toBe(1500);
    // 300 posts, exactly five comments from each, every comment of an adopted post
    const byPost = new Map<string, number>();
    for (const row of run.rows) byPost.set(String(row.video_url), (byPost.get(String(row.video_url)) ?? 0) + 1);
    expect(byPost.size).toBe(300);
    expect([...byPost.values()].every((n) => n === 5)).toBe(true);
    expect(run.rows.every((row) => row[VIDEO_ADOPTED_KEY] === true)).toBe(true);
    expect(new Set(run.rows.map((row) => row.comment_id)).size).toBe(1500);

    // comments were read ONLY under adopted (on-topic, even-numbered) posts, one call for each: 300 calls; the 300 other posts cost no comment call
    const readPosts = world.reads().map((entry) => postNumberOf(entry.params.url));
    expect(readPosts).toHaveLength(300);
    expect(new Set(readPosts).size).toBe(300);
    expect(readPosts.every((n) => n % 2 === 0)).toBe(true);
    // the search listed 600 posts to find 300 about the topic: 100 pages of 6, one source, the cursor carried from page to page
    expect(world.searches()).toHaveLength(100);
    expect(world.searches().every((entry) => entry.endpoint === "justoneapi.x.facebook-search-post-v1")).toBe(true);
    expect(world.searches().map((entry) => entry.params.cursor ?? "0").slice(0, 3)).toEqual(["0", "6", "12"]);
    expect(world.searches()[0].params).toEqual({ keyword: `${FIXTURE_TOPIC} مصر` }); // the country word travels in the search text
    // the posts reached the judge as LISTS, never a comment and never page by page: a short probe of 12 posts first, then lists of about 50 (nine pages of six), 12 lists for 600 posts
    // (judged page by page it would have been 100 review calls; the review budget of a job pays for about 18)
    expect(batches[0]).toBe(12);
    expect(batches.slice(1, -1).every((n) => n === 50)).toBe(true); // exactly one review list each (two calls of 25), the rest of a page waits for the next list
    expect(batches[batches.length - 1]).toBeLessThanOrEqual(50);
    expect(batches).toHaveLength(13);
    expect(batches.reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(590); // 600 listed; the few posts still waiting when the 300th post was adopted are not judged
    expect(batches.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(600);

    // the provider's bill: 100 search calls and 300 comment calls, at the catalog prices
    expect(run.costMicro).toBe(100 * SEARCH_CALL_MICRO + 300 * COMMENTS_CALL_MICRO);
    expect(run.costMicro / 1_000_000).toBeCloseTo(3.516, 6);
    // per delivered comment: at most the cost the unit price is built on (0.00235 USD), here 0.002344
    expect(run.costMicro / 1_000_000 / 1500).toBeLessThanOrEqual(getSocialCapability(SLUG)!.rowCostUsd);
    // the job needs fewer chunks than the page allowance of a 1,500-comment job
    expect(run.steps).toBeLessThanOrEqual(maxPagesForJob(1500, 50, "feed"));
  });

  it("it stops by itself when the posts wanted are adopted: asking for 12 posts reads 12 posts and no search page more than needed", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 1200 });
    const { selector } = judge();
    const run = await drive(world.call, { query: FIXTURE_TOPIC, perVideo: 5, videoCount: 12 }, 60, selector);
    expect(run.delivered).toBe(60);
    expect(world.reads()).toHaveLength(12);
    expect(world.searches()).toHaveLength(4); // 4 pages of 6 = 24 posts listed, 12 of them on topic
    expect(world.searches()[0].params).toEqual({ keyword: FIXTURE_TOPIC });
    expect(run.outs[run.outs.length - 1].nextCursor).toBeNull();
  });

  it("without a judge (a plain test run) every listed post is read, those that show the topic first: the judge is the only thing that makes it selective", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 30 });
    const run = await drive(world.call, { query: FIXTURE_TOPIC, perVideo: 5, videoCount: 6 }, 30);
    expect(run.delivered).toBe(30);
    // the posts whose own text shows the topic come first (the reading order of every topic search), then the others
    expect(world.reads().map((entry) => postNumberOf(entry.params.url))).toEqual([0, 2, 4, 1, 3, 5]);
  });
});

describe("one call per post, at most five comments from it", () => {
  it("a post that answers ten comments gives five; the other five are never delivered or billed", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 12 });
    const { selector } = judge();
    const run = await drive(world.call, { query: FIXTURE_TOPIC, perVideo: 5, videoCount: 3 }, 15, selector);
    expect(run.delivered).toBe(15);
    expect(run.rows.map((row) => row.comment_id)).toEqual(
      [0, 2, 4].flatMap((post) => Array.from({ length: 5 }, (_, i) => `c_${post}_${i}`)),
    );
  });

  it("a post with fewer usable comments than five gives what it has, and the job moves on instead of paging that post (the price assumes one call per post)", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 40, commentsOf: (n) => fixtureComments(n, n % 4 === 0 ? 2 : 10) });
    const { selector } = judge();
    const run = await drive(world.call, { query: FIXTURE_TOPIC, perVideo: 5, videoCount: 8 }, 40, selector);
    // 8 adopted posts: those with a number divisible by 4 give 2 comments (posts 0, 4, 8, 12), the others 5
    expect(world.reads()).toHaveLength(8);
    expect(run.delivered).toBe(4 * 2 + 4 * 5);
    expect(run.outs[run.outs.length - 1].nextCursor).toBeNull();
  });

  it("a post nobody can read is skipped without stopping the job", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 40, unreadable: (n) => n === 2 });
    const { selector } = judge();
    const run = await drive(world.call, { query: FIXTURE_TOPIC, perVideo: 5, videoCount: 4 }, 20, selector);
    expect(run.delivered).toBe(15); // posts 0, 4 and 6 gave five each; post 2 gave none
    expect(run.rows.some((row) => String(row.video_url).endsWith("/posts/2"))).toBe(false);
  });
});

describe("the stall guard of the keyword search: nothing keeps buying pages that bring nothing", () => {
  it("a source that answers its first page again and again: the search stops after the second repeat, with the comments of that one page", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 1200, repeatsFirstPage: true });
    const { selector } = judge();
    const run = await drive(world.call, owner, 1500, selector);
    // page 1 is new (6 posts, 3 on topic: 15 comments); pages 2 and 3 repeat it: the second repeat ends the search
    expect(world.searches()).toHaveLength(3);
    expect(run.delivered).toBe(15);
    expect(world.reads()).toHaveLength(3);
    expect(run.outs[run.outs.length - 1].nextCursor).toBeNull();
    expect(run.costMicro).toBe(3 * SEARCH_CALL_MICRO + 3 * COMMENTS_CALL_MICRO);
  });

  it("36 listed posts and none about the topic (three short probes of 12): the search stops, no comment was read or paid for, and the answer says no relevant post was found", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 1200, onTopic: () => false });
    const { selector } = judge();
    const out = await runSocialChunk({
      jobId: "job_fb", userId: "u", step: 0, endpointId: "x", capabilitySlug: SLUG, method: "GET", params: owner, paginationStrategy: "cursor", cursor: null,
      pageSize: 50, remainingNeeded: 1500, targetVolumeMax: 1500, deliveredSoFar: 0,
    } as any, { call: world.call, now: () => NOW, videoSelector: selector });
    expect(world.searches()).toHaveLength(6); // 36 posts at six a page: the most such a job costs the platform is 6 search calls (0.177 USD), and the customer pays nothing
    expect(world.reads()).toHaveLength(0);
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(0);
    expect(out.nextCursor).toBeNull();
    expect(out.emptyReason).toBe("no_relevant_videos");
    expect(out.costMicro).toBe(6 * SEARCH_CALL_MICRO);
  });

  it("a full list of posts with none about the topic AFTER comments were delivered ends the search without an empty-result answer: the job keeps what it delivered", async () => {
    // the first 12 listed posts include 6 on topic; after that nothing is about the topic
    const world = facebookKeywordWorld({ postsAvailable: 1200, onTopic: (n) => n < 12 && n % 2 === 0 });
    const { selector } = judge();
    const run = await drive(world.call, owner, 1500, selector);
    expect(run.delivered).toBe(30); // 6 posts x 5
    expect(world.searches()).toHaveLength(2 + 9); // the probe of two pages, then ONE list of 50 posts (nine pages) with none about the topic: the search ends
    expect(run.outs.every((out) => out.emptyReason === undefined)).toBe(true);
    expect(run.outs[run.outs.length - 1].nextCursor).toBeNull();
  });

  it("the review budget runs out while the posts are judged: the search stops at once (no more pages are bought for posts nobody can review)", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 1200 });
    let pages = 0;
    const selector: VideoSelector = async (refs) => {
      pages += 1;
      // the budget pays for the first two lists only (the probe and one list of 50); the third is left unreviewed
      return pages <= 2
        ? { adopted: refs.filter((ref) => String(ref.title).includes(FIXTURE_TOPIC)) }
        : { adopted: [], budgetStop: true };
    };
    const run = await drive(world.call, owner, 1500, selector);
    expect(pages).toBe(3);
    expect(world.searches()).toHaveLength(Math.ceil((12 + 50 + 50) / 6)); // the probe, two lists of 50: the third list was judged unreviewable and nothing more was searched
    expect(run.delivered).toBe(world.reads().length * 5); // the adopted posts of the judged lists only, 5 comments each
    expect(world.reads().length).toBeGreaterThan(6);
    expect(world.reads().length).toBeLessThanOrEqual(6 + 25 + 25);
    expect(run.outs[run.outs.length - 1].nextCursor).toBeNull();
  });

  it("a judge that throws adopts nothing (fail closed): no comment is read", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 1200 });
    const run = await drive(world.call, owner, 1500, async () => { throw new Error("model down"); });
    expect(world.reads()).toHaveLength(0);
    expect(run.delivered).toBe(0);
    expect(world.searches()).toHaveLength(6); // three probes of 12 posts, then the search ends (nothing was adopted)
  });

  it("the whole job can never search more than 150 pages: the worst case of the search bill is 150 calls", async () => {
    // nothing is ever adopted until page 140, and a page in between adopts one post so the barren streak never reaches three
    const world = facebookKeywordWorld({ postsAvailable: 100_000, onTopic: (n) => n % 12 === 0 });
    const { selector } = judge();
    const run = await drive(world.call, { query: FIXTURE_TOPIC, perVideo: 5, videoCount: 300 }, 1500, selector, 600);
    expect(world.searches().length).toBeLessThanOrEqual(150);
    expect(run.costMicro).toBeLessThanOrEqual(150 * SEARCH_CALL_MICRO + 300 * COMMENTS_CALL_MICRO);
  });
});

describe("the sources: the first one pages, the second serves one page", () => {
  it("when the first search source is down the second answers ONE page of 20 posts and the job ends with the comments of its adopted posts", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 1200, firstSourceDown: true });
    const { selector } = judge();
    const run = await drive(world.call, owner, 1500, selector);
    expect(world.searches().map((entry) => entry.endpoint)).toEqual(["justoneapi.x.facebook-search-post-v1", "anyapi.facebook.search_posts"]);
    expect(world.searches()[1].params).toEqual({ query: `${FIXTURE_TOPIC} مصر`, limit: 20 });
    expect(world.reads()).toHaveLength(10); // 20 listed, the even ones adopted
    expect(run.delivered).toBe(50);
    expect(run.outs[run.outs.length - 1].nextCursor).toBeNull(); // it has no cursor: the job ends honestly with less than asked
    expect(run.costMicro).toBe(FALLBACK_SEARCH_CALL_MICRO + 10 * COMMENTS_CALL_MICRO);
  });

  it("the customer's period reaches the search as dates (yyyy-MM-dd), and only when the customer gave one", async () => {
    const world = facebookKeywordWorld({ postsAvailable: 12 });
    const { selector } = judge();
    await drive(world.call, { query: FIXTURE_TOPIC, perVideo: 5, videoCount: 1, dateFrom: "2026-09-23", dateTo: "2026-10-23" }, 5, selector);
    expect(world.searches()[0].params).toEqual({ keyword: FIXTURE_TOPIC, startDate: "2026-09-23", endDate: "2026-10-23" });
  });
});
