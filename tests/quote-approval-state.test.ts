import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getQuoteApprovalState } from "../src/lib/quoteApprovalState";

describe("quote approval state", () => {
  const futureExpiry = "2026-10-16T16:00:00.000Z";
  const now = Date.parse("2026-10-16T15:30:00.000Z");

  it("blocks a superseded quote even when its expiry timestamp is still in the future", () => {
    expect(getQuoteApprovalState("expired", futureExpiry, now)).toEqual({
      canApprove: false,
      expiredByTime: false,
      inactiveStatus: true,
    });
  });

  it("allows a current quoted plan only while its expiry timestamp is valid", () => {
    expect(getQuoteApprovalState("quoted", futureExpiry, now).canApprove).toBe(true);
    expect(getQuoteApprovalState("quoted", "2026-10-16T15:00:00.000Z", now).canApprove).toBe(false);
  });

  it("fails closed for a restored quote whose saved status could not be loaded", () => {
    expect(getQuoteApprovalState("unknown", futureExpiry, now).canApprove).toBe(false);
  });

  it("gates the approval button on current stored quote status and reports inactive quotes", () => {
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    const chatPage = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(card).toContain("!locked && !low && approvalState.canApprove");
    expect(card).toContain("approvalState.inactiveStatus");
    expect(card).toContain("هذا العرض لم يعد صالحاً للموافقة");
    expect(chatPage).toMatch(/\.from\("plans_quotes"\)\s+\.select\("id, status"\)/);
    expect(chatPage).toContain('status: quoteStatusById.get(quoteId) || "unknown"');
  });
});

describe("an incomplete plan can never be approved", () => {
  it("needs a service, parameters and a volume in every step", async () => {
    const { isQuotePlanComplete } = await import("../src/lib/quoteApprovalState");
    const ok = { capabilitySlug: "social-x-posts", params: { query: "كرة السلة" }, targetVolumeMax: 10 };
    expect(isQuotePlanComplete([ok])).toBe(true);
    expect(isQuotePlanComplete(undefined)).toBe(true);
    expect(isQuotePlanComplete([])).toBe(false);
    expect(isQuotePlanComplete([ok, { ...ok, params: {} }])).toBe(false);
    expect(isQuotePlanComplete([{ ...ok, capabilitySlug: "" }])).toBe(false);
    expect(isQuotePlanComplete([{ ...ok, targetVolumeMax: 0 }])).toBe(false);
  });
});
