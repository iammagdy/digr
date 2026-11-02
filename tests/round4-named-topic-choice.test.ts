import { describe, expect, it } from "vitest";
import { assertReplayInvariants, type ReplayResult } from "./helpers/agentReplay";
import { FB, FBT, YT, fbTopicWorld, fbtCommentsOf, runBench, ytCommentsOf, ytRepliesTotal, ytWorld } from "./helpers/benchWorld";
import { runS11, postUrl as igPostUrl } from "./helpers/s11World";
import { splitPromise } from "../src/lib/agentMission/completeCount";
import { isRepliesStage } from "../src/lib/agentMission/replies";
import { ALL_REPLIES_AR } from "../src/lib/agentMission/repliesCard";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * THE LIVE ROUND OF 2026-11-02 17:30-17:45 AFTER #343 (docs/S1-LIVE-FINDINGS.md, «Round 4»). The owner's rule, for every platform: when the request names a page, an account or a channel AND a topic and/or a period, and the listing tool has no topic or date input, enough of the listing is read (the planning
 * guard allows two reads of one source) and the posts or videos to read are CHOSEN: the ones from the named source first, then those whose own text discusses the topic (the topic-meaning rule), then the most commented. It chooses which items to read; nothing delivered is removed. When the items read do not hold enough
 * matching ones, the plan says so with the real number before approval; when the items read do not reach the start of the requested period, it says that too. Live: Facebook Al Arabiya «about AI, last 3 months» delivered the two NEWEST posts (Clinton and Bush, an explosion in Lebanon); YouTube's second video was a
 * non-official channel's and about another cup; Instagram's two posts were twenty minutes old.
 */
type Run = ReplayResult;
const planOf = (r: Run) => r.plannedPlan as PricedPlan;
const notesOf = (r: Run): string => ((r.planView.notesAr ?? []) as string[]).join(" ");
const urlsOf = (r: Run, key: string): string[] => (planOf(r).stages.find((s) => s.key === key)?.pinned_rows ?? []).map((row) => String(row.url));
const fbUrl = (i: number) => `https://www.facebook.com/AlArabiya/posts/pfbid0${i}`;

describe("1. Facebook: «هات منشورات صفحة العربية على فيسبوك عن الذكاء الاصطناعي آخر ٣ شهور، ومع كل منشور كل التعليقات وكل الردود» (the live round: the listing has no topic and no date input)", () => {
  it("the listing is read a second time (the plan is sent back once), the posts chosen are the two that talk about the topic, not the two newest, and the card says what was read and what it covers", async () => {
    const world = fbTopicWorld();
    expect(world.request).toBe(FB.REQUEST);
    const r = await runBench(world);
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals[0].result.ok).toBe(false);
    expect(JSON.stringify(proposals[0].result)).toContain("next page");
    expect(urlsOf(r, "posts")).toEqual([fbUrl(3), fbUrl(4)]);
    const notes = notesOf(r);
    // the real numbers: six read, two talk about the topic
    expect(notes).toContain("قرأنا ٦");
    expect(notes).toContain("تتحدث عن الموضوع");
    // the six posts read are from the last ten days: they do not reach the start of the three months asked for
    expect(notes).toContain("لم تصل إلى بداية الفترة");
  });
  it("the promise is the counters of the two chosen posts (5 and 4) and no reply number is promised (the sample's own reply counters were all 0): the replies are «all the replies of the chosen comments»; promise == delivered", async () => {
    const r = await runBench(fbTopicWorld());
    const plan = planOf(r);
    const replies = plan.stages.find(isRepliesStage)!;
    expect(replies.replies_open).toBe(true);
    expect((r.planView.stages ?? []).some((s) => s.rowsAr === ALL_REPLIES_AR)).toBe(true);
    const counters = FBT.COUNTERS[3] + FBT.COUNTERS[4];
    expect(plan.stages.find((s) => s.key === "comments")!.planned_rows).toBe(counters);
    expect(fbtCommentsOf(3).length + fbtCommentsOf(4).length).toBe(counters);
    expect(r.mission.delivered_units).toBe(2 + counters);
    expect(r.notices[0].facts.delivered).toBe(r.notices[0].facts.planned);
    assertReplayInvariants(r, { expectDelivered: 2 + counters, expectStatus: "completed" });
  });
  it("only ONE of the six posts read talks about the topic: it is chosen, the other place is filled by the most commented of the rest, and the card says «only one»", async () => {
    const texts = [...FBT.TEXTS];
    texts[4] = "نتائج مباراة الأهلي والزمالك";
    const r = await runBench(fbTopicWorld(texts));
    expect(urlsOf(r, "posts")).toEqual([fbUrl(3), fbUrl(0)]);
    expect(notesOf(r)).toContain("وجدنا ١ فقط");
  });
});

describe("2. YouTube: «هات فيديوهات نهائي كأس السوبر المصري بين الأهلي والزمالك من القنوات الرسمية للقنوات الناقلة، ومع كل فيديو كل التعليقات وكل الردود» (the named sources first)", () => {
  const ytUrlOf = (i: number) => `https://www.youtube.com/watch?v=sup${i}`;
  it("the search returns a non-official re-upload first: the two videos chosen are the official channels' (the named source), the re-upload is not chosen, and promise == delivered", async () => {
    const r = await runBench(ytWorld({ order: [3, 0, 1, 2], official: [0, 1] }));
    expect(urlsOf(r, "videos")).toEqual([ytUrlOf(0), ytUrlOf(1)]);
    const comments = ytCommentsOf(0).length + ytCommentsOf(1).length;
    const replies = ytRepliesTotal(0) + ytRepliesTotal(1);
    expect(r.mission.delivered_units).toBe(2 + comments + replies);
    assertReplayInvariants(r, { expectDelivered: 2 + comments + replies, expectStatus: "completed" });
  });
  it("only ONE official video is in the results: it comes first, the other place is filled from the others, and the card says how many came from the sources the customer named", async () => {
    const r = await runBench(ytWorld({ order: [3, 0, 2, 1], official: [0] }));
    expect(urlsOf(r, "videos")).toEqual([ytUrlOf(0), ytUrlOf(3)]);
    const notes = notesOf(r);
    expect(notes).toContain("المصادر التي سمّيتها");
    expect(notes).toContain("وجدنا ١ فقط");
    expect(YT.CHANNELS.length).toBeGreaterThan(0);
  });
});

describe("4. Instagram: «هات منشورات حساب @alhadath على إنستجرام، ومع كل منشور كل التعليقات وكل الردود» (a fast-posting account: the card says how far back the posts read reach)", () => {
  it("the 24 posts read were published within the last four hours: the card says the choice is among posts of the last hours only, so the customer can ask for a period", async () => {
    const r = await runS11({ request: "هات منشورات حساب @alhadath على إنستجرام، ومع كل منشور كل التعليقات وكل الردود" });
    expect(urlsOf(r, "posts")).toEqual([igPostUrl(16), igPostUrl(6)]);
    const notes = notesOf(r);
    expect(notes).toContain("تغطي");
    expect(notes).toContain("ساعات");
  });
});

describe("the Facebook replies of the live round: no reply number from an estimate when the sample measured none", () => {
  it("replies measured as 0 on every sampled comment split the promise as 0 replies, never the stated quarter", () => {
    expect(splitPromise(8, [0, 0, 0]).replies).toBe(0);
    expect(splitPromise(8, [0, 0, 0]).comments).toBe(8);
    // a silent sample (no counters at all) still uses the stated share, as before
    expect(splitPromise(8, undefined).replies).toBeGreaterThan(0);
    expect(splitPromise(8, [1, 1, 0]).replies).toBeGreaterThan(0);
  });
});
