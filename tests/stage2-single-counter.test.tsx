import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { m12Fixture, type Arrived, type M12Fixture } from "./helpers/stage2CardFixture";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { liveProgressOf, phoneCollectLine } from "../src/lib/agentMission/stage2/singleCounter";
import { collectLineOf } from "../src/lib/agentMission/customerView";
import type { LiveData } from "../src/lib/agentMission/stage2/livePoller";

/**
 * FINDING F-2 (integration rounds 2, 3 and 4): on a PHONE, while the live sheet is shown, the request card said «وصلنا ١٤ من ٤٢ عنصرًا» (its own total: the delivering stages' rows, no replies) and a bar of 14/70, while the live counter said «١٤ من ٧٠»
 * (`promisedTotalOf`, the total the final Excel uses). Worse, at the next step the card said «٤٢ من ٤٢» (collection over) while the live counter said «٦٢ من ٧٠». Now, when live data with a KNOWN promised total is visible, the phone shows ONE progress counter (the live one) and the card's bar follows it;
 * LAUNCH ROUND: the desktop grid now shows the same live counter, so the rule holds on EVERY width (one counter, one bar; the card's own «(X من N)» and its other-total bar are not drawn while live progress is known). Nothing else changes: with the flag off, with no live data yet, with an unknown promised total and for a finished mission the card's markup is byte-for-byte today's (golden fixture generated from the unmodified card).
 * Real stored rows and the real customer view of M12 (tests/helpers/stage2CardFixture.ts); display only: no money, no rows, no file.
 */
const golden = JSON.parse(readFileSync("tests/fixtures/stage2-card-flags-off.json", "utf8")) as Record<string, string>;
const P1: Arrived = { v: 2, c: 12, r: 0 };   // 14 delivered
const P2: Arrived = { v: 2, c: 40, r: 20 };  // 62 delivered
const OVER: Arrived = { v: 2, c: 300, r: 67 }; // 369 stored rows? the live total is whatever the contract says: asserted from the data, not typed

let fx: M12Fixture;
beforeAll(async () => { fx = await m12Fixture(); }, 120_000);

const body = (view: ReturnType<M12Fixture["view"]>, live?: LiveData | null) => renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false, ...(live !== undefined ? { live } : {}) }));
const element = (html: string, testid: string): string => new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>[\\s\\S]*?</(?:span|div|p)>`).exec(html)?.[0] ?? "";
/** The live bar of the status block (the one bar drawn while live progress is known). */
const liveBar = (html: string) => bars(html).find((x) => x.wrapper === "w-full")!;
const bars = (html: string): Array<{ now: number; max: number; width: string; wrapper: string }> =>
  [...html.matchAll(/<div class="([^"]*)"[^>]*>(?:<div[^>]*>)?<div role="progressbar"[^>]*aria-valuemax="(\d+)"[^>]*aria-valuenow="(\d+)"[^>]*><div[^>]*style="width:([\d.]+%)/g)].map((m) => ({ wrapper: m[1], max: Number(m[2]), now: Number(m[3]), width: m[4] }));

describe("the rule (pure): live progress owns the counter only when its promised total is known", () => {
  it("ratio of delivered to promised, capped at 1", () => {
    expect(liveProgressOf({ delivered: 14, promised: 70 })).toEqual({ delivered: 14, promised: 70, ratio: 0.2 });
    expect(liveProgressOf({ delivered: 0, promised: 40 })).toEqual({ delivered: 0, promised: 40, ratio: 0 });
    expect(liveProgressOf({ delivered: 40, promised: 40 })?.ratio).toBe(1);
    expect(liveProgressOf({ delivered: 109, promised: 70 })).toEqual({ delivered: 109, promised: 70, ratio: 1 });
  });
  it("nothing to own: no live data, an unknown or zero promised total, numbers that are not whole numbers", () => {
    expect(liveProgressOf(null)).toBeNull();
    expect(liveProgressOf(undefined)).toBeNull();
    expect(liveProgressOf({ delivered: 12, promised: null })).toBeNull();
    expect(liveProgressOf({ delivered: 12, promised: 0 })).toBeNull();
    expect(liveProgressOf({ delivered: -1, promised: 40 })).toBeNull();
    expect(liveProgressOf({ delivered: 1.5, promised: 40 })).toBeNull();
    expect(liveProgressOf({ delivered: "3" as unknown as number, promised: 40 })).toBeNull();
  });
});

describe("flags OFF, loading, unknown total, finished mission: the card is EXACTLY today's (golden markup of the unmodified card)", () => {
  it("no live prop at all (the flag is off: the page never passes one)", () => {
    expect(body(fx.view(P1, "executing"))).toBe(golden.running_progress_1);
    expect(body(fx.view(P2, "executing"))).toBe(golden.running_progress_2);
    expect(body(fx.view(OVER, "completed", 109))).toBe(golden.completed_over_delivery);
  });
  it("initial loading: the live poll has not answered yet (null)", () => {
    expect(body(fx.view(P1, "executing"), null)).toBe(golden.running_progress_1);
  });
  it("an unknown promised total: the live counter shows only a number, so there is no competing total and nothing is hidden", async () => {
    const live = { ...(await fx.live(P1, "running")), promised: null };
    expect(body(fx.view(P1, "executing"), live)).toBe(golden.running_progress_1);
  });
  it("a finished mission: the started block is not drawn, so live data changes nothing in the card", async () => {
    const done = await fx.live(OVER, "done");
    expect(done.delivered).toBe(109); // the delivered count of the card's completed view is the live snapshot's (the per-video cap applied), not the raw stored rows
    expect(body(fx.view(OVER, "completed", 109), done)).toBe(golden.completed_over_delivery);
  });
});

describe("a phone with live data visible: ONE progress counter", () => {
  it("main's sentence «نجمع العناصر (١٤ من ٤٢)» is read WITHOUT its count on every width, and no element of the card says «من ٤٢» (the other total)", async () => {
    const html = body(fx.view(P1, "executing"), await fx.live(P1, "running"));
    const line = element(html, "agent-started-line");
    expect(line).not.toContain("hidden sm:inline");
    expect(element(html, "agent-started-line-phone")).toContain(">نجمع العناصر<");
    expect(html).not.toContain("من ٤٢");
  });
  it("the card's bar follows the live counter (delivered of promised) on every width", async () => {
    const live = await fx.live(P1, "running");
    const html = body(fx.view(P1, "executing"), live);
    const bar = liveBar(html);
    expect([bar.now, bar.max]).toEqual([live.delivered, live.promised]);
    expect(bar.width).toBe(`${Math.round((live.delivered / (live.promised as number)) * 100)}%`);
    expect(bars(html).some((x) => x.now === 14 && x.max === 70 && x.wrapper !== "w-full")).toBe(false);
  });
  it("exactly one bar in the status block, visible at every width", async () => {
    const html = body(fx.view(P1, "executing"), await fx.live(P1, "running"));
    // the status block only: the plan panel below draws its own per-stage bars
    const status = html.slice(html.indexOf('data-testid="agent-started"'), html.indexOf('data-testid="agent-close-notice"'));
    expect((status.match(/role="progressbar"/g) ?? []).length).toBe(1);
    expect(status).not.toMatch(/sm:hidden|hidden sm:block/);
    expect((status.match(/class="w-full" data-testid="agent-progress-live"/g) ?? []).length).toBe(1);
  });
  it("the next step: the card used to say «٤٢ من ٤٢» (collection over) while the live counter said «٦٢ من ٧٠»; the bar now says 62 of 70 and the sentence does not claim the end", async () => {
    const live = await fx.live(P2, "running");
    expect(live.delivered).toBe(62);
    expect(live.promised).toBe(70);
    const html = body(fx.view(P2, "executing"), live);
    const bar = liveBar(html);
    expect([bar.now, bar.max, bar.width]).toEqual([62, 70, "89%"]);
    // main's sentence claims «جمعنا العناصر، ونجهّز ملفك الآن» on the card's 42-row total: while live says 62 of 70 (not complete) every width reads «نجمع العناصر»
    expect(element(html, "agent-started-line")).not.toContain("جمعنا العناصر");
    expect(element(html, "agent-started-line-phone")).toContain(">نجمع العناصر<");
  });
  it("over-delivery while running: the bar is full, never above the promised total", async () => {
    const live = await fx.live(OVER, "running");
    expect(live.delivered).toBeGreaterThan(live.promised as number);
    const phone = liveBar(body(fx.view(P2, "executing"), live));
    expect([phone.now, phone.max, phone.width]).toEqual([live.promised, live.promised, "100%"]);
  });
  it("exact completion (delivered equals promised): a full bar", async () => {
    const live = { ...(await fx.live(P1, "running")), delivered: 70, promised: 70 };
    const phone = liveBar(body(fx.view(P2, "executing"), live));
    expect([phone.now, phone.max, phone.width]).toEqual([70, 70, "100%"]);
  });
  it("nothing delivered yet of a known total: an empty bar", async () => {
    const live = { ...(await fx.live(P1, "running")), delivered: 0, promised: 70 };
    const phone = liveBar(body(fx.view(P1, "executing"), live));
    expect([phone.now, phone.max, phone.width]).toEqual([0, 70, "0%"]);
  });
  it("once the live snapshot is complete (done, or delivered reached promised) the phone keeps the card's own «collection is over» sentence", async () => {
    const view = fx.view(P2, "executing");
    const done = { ...(await fx.live(P2, "done")) };
    expect(element(body(view, done), "agent-started-line-phone")).toContain(">جمعنا العناصر، ونجهّز ملفك الآن<");
    const reached = { ...(await fx.live(P2, "running")), delivered: 70, promised: 70 };
    expect(element(body(view, reached), "agent-started-line-phone")).toContain(">جمعنا العناصر، ونجهّز ملفك الآن<");
  });
  it("everything else in the status block is untouched: the close-page notice and the remaining time", async () => {
    const view = fx.view(P1, "executing");
    const off = body(view);
    const on = body(view, await fx.live(P1, "running"));
    for (const id of ["agent-close-notice", "agent-remaining"]) expect(element(on, id), id).toBe(element(off, id));
    expect(on).toContain('data-testid="agent-started"');
  });
});

describe("phoneCollectLine against main's REAL sentences (collectLineOf)", () => {
  const live = (status: "running" | "done", delivered: number, promised: number | null) => ({ status, delivered, promised });
  it("an unfinished collection: the count is cut, the noun kept, for every noun main can name", () => {
    for (const noun of ["تعليقات", "منشورات", "تغريدات", "فيديوهات", "عناصر", "شركات"]) {
      const line = collectLineOf("executing", 14, 42, { plural: noun })!;
      expect(line).toMatch(/\([٠-٩٬]+ من [٠-٩٬]+\)$/); // main's format, pinned
      expect(phoneCollectLine(line, live("running", 14, 70))).toBe(`نجمع ال${noun}`);
    }
  });
  it("a finished collection by the card's total: the claim is kept only when the live snapshot is complete", () => {
    const line = collectLineOf("executing", 42, 42, { plural: "عناصر" })!;
    expect(phoneCollectLine(line, live("running", 62, 70))).toBe("نجمع العناصر");
    expect(phoneCollectLine(line, live("done", 62, 70))).toBe(line);
    expect(phoneCollectLine(line, live("running", 70, 70))).toBe(line);
    expect(phoneCollectLine(line, live("running", 109, 70))).toBe(line);
  });
  it("nothing to follow (no live data, unknown total) or a sentence of another shape: returned as it is", () => {
    const line = collectLineOf("executing", 14, 42, { plural: "عناصر" })!;
    expect(phoneCollectLine(line, null)).toBe(line);
    expect(phoneCollectLine(line, live("running", 14, null))).toBe(line);
    expect(phoneCollectLine("نجمع ٤٢ عنصرًا", live("running", 14, 70))).toBe("نجمع ٤٢ عنصرًا");
    expect(phoneCollectLine("", live("running", 14, 70))).toBe("");
  });
});

describe("how the card knows (wiring)", () => {
  it("the card keeps the last live data the panel reported, and passes it only while the live sheet is shown", () => {
    const card = readFileSync("src/components/mission/AgentMissionCard.tsx", "utf8");
    expect(card).toContain("useState<LiveData | null>(null)");
    expect(card).toContain("live={showLive ? liveData : null}");
    expect(card).toContain("<LiveSheetPanel missionId={missionId} enabled missionLive={!ended} onData={setLiveData} />");
    const panel = readFileSync("src/components/mission/LiveSheetPanel.tsx", "utf8");
    expect(panel).toContain("onData");
  });
});
