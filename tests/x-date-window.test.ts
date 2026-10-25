import { describe, it, expect } from "vitest";
import { withXDateOperators, xUntilDay, X_UNTIL_DAYS_AFTER_DATE_TO } from "../src/lib/xSearchWindow";
import { getSocialCapability } from "../src/lib/socialSources";
import { summarizeRowDates } from "../src/lib/server/dateRangeFilter";
import { allRowsOutsideWindow, dateWindowPageEventAr, OUTSIDE_WINDOW_SENTENCE_AR } from "../src/lib/server/dateWindowNotes";
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import type { ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";

const QUERY = "مباراة مصر والمغرب كأس العالم";
const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("the day after dateTo is one helper", () => {
  it("until is the stored dateTo moved forward by the single constant", () => {
    expect(X_UNTIL_DAYS_AFTER_DATE_TO).toBe(1);
    expect(xUntilDay("2026-07-19")).toBe("2026-07-20");
    expect(xUntilDay("2026-07-31")).toBe("2026-08-01");
    expect(xUntilDay("2026-12-31")).toBe("2027-01-01");
    expect(xUntilDay("2028-02-28")).toBe("2028-02-29");
    expect(xUntilDay("2026-07-19T10:00:00Z")).toBe("2026-07-20");
    expect(xUntilDay("not a date")).toBeNull();
    expect(xUntilDay(undefined)).toBeNull();
  });

  it("appends since and until to the search text, and nothing else changes", () => {
    expect(withXDateOperators(QUERY, "2026-06-11", "2026-07-19")).toBe(`${QUERY} since:2026-06-11 until:2026-07-20`);
    expect(withXDateOperators(QUERY, "2026-06-11", undefined)).toBe(`${QUERY} since:2026-06-11`);
    expect(withXDateOperators(QUERY, undefined, "2026-07-19")).toBe(`${QUERY} until:2026-07-20`);
    expect(withXDateOperators(QUERY)).toBe(QUERY);
    expect(withXDateOperators(QUERY, "garbage", "")).toBe(QUERY);
  });

  it("a query that already carries its own operator is left as the customer wrote it", () => {
    expect(withXDateOperators("goal since:2026-01-01", "2026-06-11", "2026-07-19")).toBe("goal since:2026-01-01 until:2026-07-20");
    expect(withXDateOperators("goal until:2026-01-01 since:2025-01-01", "2026-06-11", "2026-07-19")).toBe("goal until:2026-01-01 since:2025-01-01");
  });
});

describe("X topic search sends the window inside the search text", () => {
  const topic = getSocialCapability("social-x-posts")!.discover.query!;

  it("with a window: operators in the query; limit, queryType and cursor are exactly as before", () => {
    expect(topic[0].build({ query: QUERY, limit: 50, dateFrom: "2026-06-11", dateTo: "2026-07-19" })).toEqual({
      query: `${QUERY} since:2026-06-11 until:2026-07-20`,
      limit: 50,
      queryType: "Latest",
    });
    expect(topic[0].build({ query: QUERY, limit: 50, cursor: "cur_1", dateFrom: "2026-06-11", dateTo: "2026-07-19" })).toEqual({
      query: `${QUERY} since:2026-06-11 until:2026-07-20`,
      limit: 50,
      queryType: "Latest",
      cursor: "cur_1",
    });
    expect(topic[1].build({ query: QUERY, limit: 20, dateFrom: "2026-06-11", dateTo: "2026-07-19" })).toEqual({
      keyword: `${QUERY} since:2026-06-11 until:2026-07-20`,
      search_type: "Latest",
    });
  });

  it("without a window the request is the same as before", () => {
    expect(topic[0].build({ query: QUERY, limit: 50 })).toEqual({ query: QUERY, limit: 50, queryType: "Latest" });
    expect(topic[1].build({ query: QUERY, limit: 20 })).toEqual({ keyword: QUERY, search_type: "Latest" });
  });

  it("account posts have no search text, so they take no operators", () => {
    const account = getSocialCapability("social-x-posts")!.discover.channel!;
    expect(account[0].build({ channel: "@AlAhly", limit: 20, dateFrom: "2026-06-11", dateTo: "2026-07-19" })).toEqual({ handle: "AlAhly", limit: 20 });
  });

  it("through the adapter: one call per page, the stored window is untouched, the operators reach the source", async () => {
    const seen: Array<Record<string, any>> = [];
    const call: SocialCall = async (_source, params): Promise<SocialCallOutcome> => {
      seen.push(params);
      return { ok: true, httpStatus: 200, data: { ok: true, rows: [{ tweet_id: "t1", text: "x", createdUtc: secs("2026-06-20T10:00:00Z") }] }, costMicro: 600, tregCallId: "c1" };
    };
    const params = { query: QUERY, dateFrom: "2026-06-11", dateTo: "2026-07-19" };
    const input: ProviderAdapterCallInput = {
      jobId: "job_x", userId: "u1", step: 0, endpointId: "anyapi.x.search.posts", capabilitySlug: "social-x-posts", method: "POST", params,
      paginationStrategy: "cursor", cursor: null, pageSize: 50, remainingNeeded: 50, targetVolumeMax: 50, deliveredSoFar: 0,
    };
    const result = await runSocialChunk(input, { call });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ query: `${QUERY} since:2026-06-11 until:2026-07-20`, limit: 50, queryType: "Latest" });
    expect(params).toEqual({ query: QUERY, dateFrom: "2026-06-11", dateTo: "2026-07-19" });
  });
});

describe("summarizeRowDates", () => {
  const rows = [
    { createdUtc: secs("2026-10-18T07:00:00Z") },
    { createdUtc: secs("2026-10-12T07:00:00Z") },
    { text: "no date" },
    { published_at: "2026-06-20" },
  ];

  it("splits missing from outside, reports the oldest and newest day, keeps at most three sample dates", () => {
    const summary = summarizeRowDates(rows, "2026-06-11", "2026-07-19");
    expect(summary).toEqual({ missing: 1, outside: 2, inside: 1, oldest: "2026-06-20", newest: "2026-10-18", sampleDates: ["2026-10-18", "2026-10-12", null] });
  });

  it("agrees with the filter: rows inside the window are neither missing nor outside", () => {
    expect(summarizeRowDates([{ published_at: "2026-06-20" }], "2026-06-11", "2026-07-19")).toMatchObject({ missing: 0, outside: 0 });
    expect(summarizeRowDates([], "2026-06-11", "2026-07-19")).toEqual({ missing: 0, outside: 0, inside: 0, oldest: null, newest: null, sampleDates: [] });
  });
});

describe("the page line and the honest sentence", () => {
  const allLater = Array.from({ length: 20 }, (_, i) => ({ createdUtc: secs("2026-10-12T07:00:00Z") + i * 3600 }));

  it("all rows later than the window: counts, oldest/newest and the plain sentence, in Arabic digits and no provider words", () => {
    const summary = summarizeRowDates(allLater, "2026-06-11", "2026-07-19");
    expect(allRowsOutsideWindow(summary, 20)).toBe(true);
    const line = dateWindowPageEventAr(summary, 20);
    expect(line).toContain("تم استبعاد ٢٠ سجل");
    expect(line).toContain("٢٠ خارج الفترة المطلوبة");
    expect(line).toContain("أقدم تاريخ نشر ٢٠٢٦-١٠-١٢");
    expect(line).toContain(OUTSIDE_WINDOW_SENTENCE_AR);
    expect(OUTSIDE_WINDOW_SENTENCE_AR).toBe("المصدر أعاد منشورات خارج الفترة التي حددتها");
    expect(line).not.toMatch(/[A-Za-z0-9]/);
  });

  it("undated rows are reported as undated and never called 'outside the window'", () => {
    const summary = summarizeRowDates([{ text: "a" }, { text: "b" }], "2026-06-11", "2026-07-19");
    expect(allRowsOutsideWindow(summary, 2)).toBe(false);
    const line = dateWindowPageEventAr(summary, 2);
    expect(line).toContain("٢ بلا تاريخ نشر يمكن التحقق منه");
    expect(line).toContain("لم يظهر تاريخ نشر في أي سجل");
    expect(line).not.toContain(OUTSIDE_WINDOW_SENTENCE_AR);
  });

  it("a page fully inside the window says nothing was dropped", () => {
    const summary = summarizeRowDates([{ published_at: "2026-06-20" }, { published_at: "2026-07-01" }], "2026-06-11", "2026-07-19");
    expect(dateWindowPageEventAr(summary, 2)).toBe("فحصنا تواريخ سجلين من هذه الصفحة وكلها داخل الفترة المطلوبة (أقدم تاريخ نشر ٢٠٢٦-٠٦-٢٠ وأحدث تاريخ ٢٠٢٦-٠٧-٠١).");
  });
});
