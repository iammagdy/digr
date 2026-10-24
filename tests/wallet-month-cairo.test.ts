import { describe, expect, it } from "vitest";
import { cairoMonthStartMs, walletMonthStats } from "../src/lib/walletView";

/**
 * «released this month» on the wallet. Evidence: the counter showed 9 where the customer had 10. Cause: the month started at the server's local midnight
 * (UTC on the hosting), while the month the customer lives in is Cairo's: a hold released at 01:00 on the 1st in Cairo was counted in the month before.
 */
const job = (id: string, releasedAt: string) => [
  { type: "reserve", delta: -100, jobId: id, createdAt: "2026-10-30T10:00:00Z" },
  { type: "release", delta: 100, jobId: id, createdAt: releasedAt },
] as any[];

describe("the wallet's month is the Cairo month", () => {
  it("the November month starts at 00:00 Cairo time (22:00 UTC on 31 October) and July uses the summer offset (21:00 UTC on 30 June)", () => {
    expect(new Date(cairoMonthStartMs(new Date("2026-11-15T12:00:00Z"))).toISOString()).toBe("2026-10-31T22:00:00.000Z");
    expect(new Date(cairoMonthStartMs(new Date("2026-07-15T12:00:00Z"))).toISOString()).toBe("2026-06-30T21:00:00.000Z");
  });
  it("a hold released at 01:00 on 1 November in Cairo (23:00 UTC on 31 October) is a November release, and counts", () => {
    const stats = walletMonthStats(job("j1", "2026-10-31T23:00:00Z"), new Date("2026-11-15T12:00:00Z"));
    expect(stats.releasedJobs).toBe(1);
    expect(stats.releasedHold).toBe(100);
  });
  it("a release at 23:30 on 31 October in Cairo (21:30 UTC) belongs to October and does not count in November", () => {
    const stats = walletMonthStats(job("j2", "2026-10-31T21:30:00Z"), new Date("2026-11-15T12:00:00Z"));
    expect(stats.releasedJobs).toBe(0);
  });
  it("ten releases in the month count ten, including one at the boundary", () => {
    const rows = [...Array.from({ length: 9 }, (_, i) => job(`m${i}`, `2026-11-0${(i % 9) + 1}T09:00:00Z`)), job("edge", "2026-10-31T23:00:00Z")].flat();
    expect(walletMonthStats(rows as any[], new Date("2026-11-15T12:00:00Z")).releasedJobs).toBe(10);
  });
});
