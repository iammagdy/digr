import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BELOW_MINIMUM_AR, CAPACITY_NOTE_AR, WALLET_REPLIES_SHARE, minimumOrderPoints, walletCapacityOf } from "../src/lib/walletEstimate";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * ROUND 14, item 6: THE WALLET'S ESTIMATE. Live: with 113 points «رصيدك يكفي تقريبًا لـ ٤١٠ تعليق يوتيوب، ٩٦٤ منشور إكس، ٣٥ شركة». Real orders: 20 X tweets cost 200 points, 101 YouTube items cost 97 of a hold of 242; the minimum order is 200 points (the price rule's own minimum).
 * The estimate now comes from `priceMissionByCode` (the plan card's price function, read only, `price.ts` untouched) with the verified cards' cost per row.
 */
const costPerRow = (id: string) => { const c = cardOf(id)!; return c.costUsdPerPage / Math.max(1, c.page.observedRowsPerPage); };

describe("below the minimum order there is no estimate, and the page says so", () => {
  it("the minimum is the price rule's own 200 points", () => { expect(minimumOrderPoints()).toBe(200); });
  it("113 points (the live balance): «رصيدك أقل من الحد الأدنى للطلب», no chip", () => {
    expect(walletCapacityOf(113)).toEqual({ kind: "below_minimum", minimumPoints: 200 });
    expect(walletCapacityOf(0)).toEqual({ kind: "below_minimum", minimumPoints: 200 });
    expect(walletCapacityOf(199).kind).toBe("below_minimum");
    expect(BELOW_MINIMUM_AR(200)).toContain("رصيدك أقل من الحد الأدنى للطلب");
    expect(BELOW_MINIMUM_AR(200)).toContain("٢٠٠");
    expect(BELOW_MINIMUM_AR(200)).not.toMatch(/[0-9]/);
  });
  it("200 points is an order", () => { expect(walletCapacityOf(200).kind).toBe("ok"); });
});

describe("what is promised is what the plan card's price rule holds", () => {
  const yt = (n: number) => priceMissionByCode([
    { rows: 2, costPerRowUsd: costPerRow("tikhub.x.youtube-web-search-channel"), deliver: true },
    { rows: n, costPerRowUsd: costPerRow("tikhub.youtube.video.comments"), deliver: true },
    { rows: Math.ceil(n * WALLET_REPLIES_SHARE), costPerRowUsd: costPerRow("anyapi.youtube.comment_replies"), deliver: true, codeOnly: true },
  ]).reservePoints;
  const x = (n: number) => priceMissionByCode([{ rows: n, costPerRowUsd: costPerRow("anyapi.x.search.posts"), deliver: true }]).reservePoints;
  it.each([200, 242, 500, 1000, 5000])("with %i points each chip is the LARGEST request whose hold fits, by the same function", (points) => {
    const cap = walletCapacityOf(points);
    if (cap.kind !== "ok") throw new Error("expected an estimate");
    const youtube = cap.chips.find((c) => c.id === "youtube-comments")!.records;
    const xposts = cap.chips.find((c) => c.id === "x-posts")!.records;
    expect(yt(youtube)).toBeLessThanOrEqual(points);
    if (youtube < 5000) expect(yt(youtube + 1)).toBeGreaterThan(points);
    expect(x(xposts)).toBeLessThanOrEqual(points);
    if (xposts < 5000) expect(x(xposts + 1)).toBeGreaterThan(points);
  });
  it("never more than a real plan gave: the live YouTube plan held 242 points for 200 comments and 20 replies; the estimate for 242 points is not above 200 comments", () => {
    const cap = walletCapacityOf(242);
    if (cap.kind !== "ok") throw new Error("expected an estimate");
    expect(cap.chips.find((c) => c.id === "youtube-comments")!.records).toBeLessThanOrEqual(200);
  });
  it("no chip is promised for a kind that has no verified card (companies), and no chip is above one job's limit", () => {
    const cap = walletCapacityOf(25_000);
    if (cap.kind !== "ok") throw new Error("expected an estimate");
    expect(cap.chips.map((c) => c.id).sort()).toEqual(["x-posts", "youtube-comments"]);
    for (const c of cap.chips) expect(c.records).toBeLessThanOrEqual(5000);
  });
});

describe("the wallet page uses it", () => {
  const page = readFileSync(new URL("../src/app/dashboard/topup/page.tsx", import.meta.url), "utf8");
  it("walletCapacityOf drives the chips, the old per-record table does not", () => {
    expect(page).toContain("walletCapacityOf(available)");
    expect(page).not.toContain("capacityForPoints");
    expect(page).toContain("wallet-below-minimum");
  });
  it("the sentences pass checkCustomerText", () => {
    for (const t of [BELOW_MINIMUM_AR(200), CAPACITY_NOTE_AR]) expect(checkCustomerText(t, { maxChars: 400 }).issues, t).toEqual([]);
  });
});
