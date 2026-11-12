import { describe, expect, it } from "vitest";
import { buildAsk, periodOfRequest } from "../src/lib/agentMission/foundation/ask";
import { conditionsOfRequest } from "../src/lib/agentMission/requestConditions";
import { cairoDayEndExclusiveMs, cairoDayStartMs } from "../src/lib/agentMission/cairoTime";

/**
 * ROUND 16, PART 4: «الشهر الماضي» / «الشهر اللي فات» IS THE PREVIOUS CALENDAR MONTH IN CAIRO TIME (a request on 3 Nov 2026 is 1 to 31 Oct 2026). requestConditions.ts already reports a date condition for it; ask.ts used to produce no period, so the plan carried no period at all.
 * «آخر شهر» stays the last 30 days (a month back from the day of the request, that day included).
 */
const at = (iso: string): number => Date.parse(iso);
const day = (p: ReturnType<typeof periodOfRequest>) => (p ? [p.from, p.to] : null);

describe("the previous calendar month, in Cairo time", () => {
  it("a request on 3 Nov 2026 gives 1 to 31 Oct 2026, with the Cairo instants of its edges", () => {
    const p = periodOfRequest("هات منشورات عن الذكاء الاصطناعي الشهر الماضي", at("2026-11-03T12:00:00Z"));
    expect(day(p)).toEqual(["2026-10-01", "2026-10-31"]);
    expect(p!.startMs).toBe(cairoDayStartMs("2026-10-01"));
    expect(p!.endExclusiveMs).toBe(cairoDayEndExclusiveMs("2026-10-31"));
  });
  it("«الشهر اللي فات» is the same month", () => {
    expect(day(periodOfRequest("هات تعليقات الشهر اللي فات", at("2026-11-03T12:00:00Z")))).toEqual(["2026-10-01", "2026-10-31"]);
  });
  it("«الشهر الماضى» (ى) and «الشهر الماضي» with a leading «في» read alike", () => {
    expect(day(periodOfRequest("في الشهر الماضي", at("2026-11-03T12:00:00Z")))).toEqual(["2026-10-01", "2026-10-31"]);
    expect(day(periodOfRequest("الشهر الماضى", at("2026-11-03T12:00:00Z")))).toEqual(["2026-10-01", "2026-10-31"]);
  });
  it("YEAR BOUNDARY: a request on 5 Jan 2027 gives 1 to 31 Dec 2026", () => {
    expect(day(periodOfRequest("الشهر الماضي", at("2027-01-05T10:00:00Z")))).toEqual(["2026-12-01", "2026-12-31"]);
  });
  it("FEBRUARY IN A LEAP YEAR: a request on 10 Mar 2028 gives 1 to 29 Feb 2028; in a common year 1 to 28 Feb 2027", () => {
    expect(day(periodOfRequest("الشهر الماضي", at("2028-03-10T10:00:00Z")))).toEqual(["2028-02-01", "2028-02-29"]);
    expect(day(periodOfRequest("الشهر الماضي", at("2027-03-10T10:00:00Z")))).toEqual(["2027-02-01", "2027-02-28"]);
  });
  it("a month with 30 days: a request on 2 May 2026 gives 1 to 30 Apr 2026", () => {
    expect(day(periodOfRequest("الشهر الماضي", at("2026-05-02T10:00:00Z")))).toEqual(["2026-04-01", "2026-04-30"]);
  });
  it("THE DAY IS THE CAIRO DAY: 31 Oct 2026 at 22:30 UTC is already 1 Nov in Cairo (UTC+2), so the previous month is October; 30 Nov 2026 at 22:30 UTC is 1 Dec in Cairo, so it is November, while 21:30 UTC is still 30 Nov (October)", () => {
    expect(day(periodOfRequest("الشهر الماضي", at("2026-10-31T22:30:00Z")))).toEqual(["2026-10-01", "2026-10-31"]);
    expect(day(periodOfRequest("الشهر الماضي", at("2026-11-30T22:30:00Z")))).toEqual(["2026-11-01", "2026-11-30"]);
    expect(day(periodOfRequest("الشهر الماضي", at("2026-11-30T21:30:00Z")))).toEqual(["2026-10-01", "2026-10-31"]);
  });
  it("«آخر شهر» stays the last 30 days (a month back from the request's day, that day included), not the previous calendar month", () => {
    expect(day(periodOfRequest("آخر شهر", at("2026-11-03T12:00:00Z")))).toEqual(["2026-10-03", "2026-11-03"]);
  });
  it("a named month wins over the words around it, and «الشهر الحالي» is not read as the previous month", () => {
    expect(day(periodOfRequest("في شهر أكتوبر ٢٠٢٦", at("2026-11-03T12:00:00Z")))).toEqual(["2026-10-01", "2026-10-31"]);
    // (round 51: «الشهر الحالي» is now read, as the CURRENT month from its 1st to the day of the request; still never the previous month)
    expect(day(periodOfRequest("الشهر الحالي", at("2026-11-03T12:00:00Z")))).toEqual(["2026-11-01", "2026-11-03"]);
  });
});

describe("the Ask carries it, end to end", () => {
  it("a Facebook request with «الشهر الماضي» has the period 1 to 31 Oct 2026, the request's own date condition agrees, and the card sentence says it", () => {
    const request = "هات ٣ منشورات عن الذكاء الاصطناعي من فيسبوك الشهر الماضي";
    expect(conditionsOfRequest(request)).toContain("date");
    const ask = buildAsk(request, null, at("2026-11-03T12:00:00Z"));
    expect(ask.period).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
  });
  it("«آخر شهر» through the Ask is the last 30 days", () => {
    const ask = buildAsk("هات ٣ منشورات عن الذكاء الاصطناعي من فيسبوك آخر شهر", null, at("2026-11-03T12:00:00Z"));
    expect(ask.period).toMatchObject({ from: "2026-10-03", to: "2026-11-03" });
  });
});
