import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { BALANCE_AFTER_SETTLE_DELAYS_MS, refreshBalanceAfterSettle } from "../src/lib/missionBalance";

/**
 * ITEM 4: THE CHAT HEADER'S BALANCE REFRESHES AFTER A JOB SETTLES. Live test 2026-11-01: after A2 the header showed 5,426 while the wallet showed 5,506 (80 points of released hold missing). Cause: the balance provider (useBalance) was refreshed
 * when the customer approved (the hold taken) and on focus, and the mission card did nothing when its mission ended, so the release and the charge written at settlement never reached the header until a reload. A mission that is over now asks for the balance
 * again (at once, and once more a few seconds later like the legacy job path does). Display only: nothing here reads or writes the ledger.
 */
afterEach(() => vi.useRealTimers());

describe("refreshBalanceAfterSettle", () => {
  it("reads the balance at once and once more a few seconds later; the second read is cancelled when the card goes away", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const stop = refreshBalanceAfterSettle(refresh);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(Math.max(...BALANCE_AFTER_SETTLE_DELAYS_MS) + 10);
    expect(refresh).toHaveBeenCalledTimes(BALANCE_AFTER_SETTLE_DELAYS_MS.length);
    const refresh2 = vi.fn();
    const stop2 = refreshBalanceAfterSettle(refresh2);
    vi.advanceTimersByTime(1);
    stop2();
    vi.advanceTimersByTime(10_000);
    expect(refresh2).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("the wiring", () => {
  it("the mission card tells the page when its mission is over, and the chat page answers by refreshing the shared balance (the header reads the same provider)", () => {
    const card = readFileSync("src/components/mission/AgentMissionCard.tsx", "utf8");
    expect(card).toMatch(/refreshBalanceAfterSettle/);
    expect(card).toMatch(/onSettled/);
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toMatch(/onSettled=\{\(\) => void loadBalance\(\)\}/);
  });
});
