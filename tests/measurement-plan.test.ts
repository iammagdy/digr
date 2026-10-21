import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { IDLE_GAP_SECONDS, MEASUREMENT_SQL, MEASUREMENT_WINDOW_DAYS, buildCapabilityMeasurements, percentileCont } from "../src/lib/server/measurementReport";
import { QUOTE_LIMIT_POINTS, TOTAL_PROVIDER_USD_LIMIT, largestVolumeWithin, testerQuote, testerRequests, totalExpectedProviderUsd } from "../src/lib/measurementPlan";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const iso = (secondsFromNow: number) => new Date(NOW + secondsFromNow * 1000).toISOString();

describe("the measurement query is one read-only statement", () => {
  it("only reads: no write, no definition, no grant, a single statement", () => {
    expect(MEASUREMENT_SQL).not.toMatch(/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|vacuum|copy|call|execute)\b/i);
    expect(MEASUREMENT_SQL.trim().startsWith("with done as")).toBe(true);
    expect(MEASUREMENT_SQL.trim().endsWith(";")).toBe(true);
    expect(MEASUREMENT_SQL.match(/;/g)).toHaveLength(1);
    for (const table of ["public.jobs", "public.provider_costs", "public.job_events"]) expect(MEASUREMENT_SQL).toContain(table);
    expect(MEASUREMENT_SQL).not.toMatch(/credit_ledger|topups|profiles|auth\./);
    expect(MEASUREMENT_WINDOW_DAYS).toBe(90);
    expect(IDLE_GAP_SECONDS).toBe(1800);
  });

  it("the file for the owner is that statement with a comment on top", () => {
    const file = readFileSync("docs/proposals/09_measurement_query.sql", "utf8");
    const body = file.split("\n").filter((line) => !line.startsWith("--")).join("\n");
    expect(body.trim()).toBe(MEASUREMENT_SQL.trim());
    expect(file.split("\n")[0]).toContain("READ-ONLY");
  });
});

describe("the same numbers in code", () => {
  const jobs = [
    { id: "a1", endpoint_id: "svc.a", status: "completed", delivered_units: 100, charged_credits: 300, attempt_count: 1, created_at: iso(-3600) },
    { id: "a2", endpoint_id: "svc.a", status: "completed", delivered_units: 50, charged_credits: 150, attempt_count: 0, created_at: iso(-3000) },
    { id: "a3", endpoint_id: "svc.a", status: "failed", delivered_units: 40, charged_credits: 0, attempt_count: 3, created_at: iso(-2000) },
    { id: "a4", endpoint_id: "svc.a", status: "completed", delivered_units: 0, charged_credits: 0, attempt_count: 0, created_at: iso(-2000) },
    { id: "a5", endpoint_id: "svc.a", status: "completed", delivered_units: 70, charged_credits: 210, attempt_count: 0, created_at: iso(-100 * 86400) },
    { id: "b1", endpoint_id: "svc.b", status: "completed", delivered_units: 10, charged_credits: 50, attempt_count: 0, created_at: iso(-500) },
  ];
  const costs = [
    { job_id: "a1", provider: "treg", cost_usd: 0.004, is_estimate: false },
    { job_id: "a1", provider: "treg", cost_usd: 0.002, is_estimate: false },
    { job_id: "a2", provider: "treg", cost_usd: 0.003, is_estimate: true },
    { job_id: "a1", provider: "llm", cost_usd: 9 },
    { job_id: "a3", provider: "treg", cost_usd: 5 },
    { job_id: "a5", provider: "treg", cost_usd: 5 },
  ];
  const page = (job_id: string, secondsFromNow: number) => ({ job_id, event_type: "progress", message: "الصفحة ١: استلمنا ٥٠ سجل", created_at: iso(secondsFromNow) });
  const events = [
    page("a1", -3600 + 10), page("a1", -3600 + 40), page("a1", -3600 + 60), page("a1", -3600 + 4000), // gaps 10, 30, 20, then 3,940 (waiting: not a chunk)
    page("a2", -3000 + 8),
    { job_id: "a1", event_type: "progress", message: "تم إكمال استخراج ١٥٠ سجل", created_at: iso(-3590) },
    { job_id: "a1", event_type: "info", message: "الصفحة ٢", created_at: iso(-3590) },
  ];
  const rows = buildCapabilityMeasurements({ jobs, costs, events, now: NOW });
  const a = rows.find((row) => row.serviceKey === "svc.a")!;
  const b = rows.find((row) => row.serviceKey === "svc.b")!;

  it("counts only completed jobs that delivered something, inside the window", () => {
    expect(a.jobs).toBe(2); // not the failed one, not the empty one, not the one from 100 days ago
    expect(a.deliveredRecords).toBe(150);
    expect(a.retries).toBe(1);
  });

  it("sums only the data provider's cost rows of those jobs and counts the estimates apart", () => {
    expect(a.costRowsChunks).toBe(3);
    expect(a.estimateRows).toBe(1);
    expect(a.providerUsd).toBe(0.009);
    expect(a.providerUsdPerRecord).toBe(0.00006);
    expect(a.providerUsdPerChunk).toBe(0.003);
    expect(a.recordsPerChunk).toBe(50);
  });

  it("what the customer paid per record, in points and in pounds (1 point = 0.10)", () => {
    expect(a.customerPointsPerRecord).toBe(3);
    expect(a.customerEgpPerRecord).toBe(0.3);
    expect(b.customerPointsPerRecord).toBe(5);
    expect(b.customerEgpPerRecord).toBe(0.5);
  });

  it("seconds per chunk come from the gaps between a job's page lines, the first from the job's start; a long wait is not a chunk", () => {
    // gaps: a1 first line is 10 s after the start, then 30, 20 (the 3,940 s wait is dropped); a2 first line 8 s after its start
    expect(a.secondsPerChunkP50).toBe(15);
    expect(a.secondsPerChunkP90).toBe(27);
    expect(b.secondsPerChunkP50).toBeNull(); // no page line: unknown, never zero
    expect(b.providerUsdPerRecord).toBeNull();
  });

  it("the median and the 90th percentile are Postgres' (linear between the two closest values)", () => {
    expect(percentileCont([], 0.5)).toBeNull();
    expect(percentileCont([4], 0.9)).toBe(4);
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileCont([8, 10, 20, 30], 0.9)).toBeCloseTo(27, 6);
  });

  it("the biggest service comes first", () => {
    expect(rows.map((row) => row.serviceKey)).toEqual(["svc.a", "svc.b"]);
  });
});

describe("the seven small requests for the tester", () => {
  const plans = testerRequests();
  const byId = (id: string) => plans.find((plan) => plan.id === id)!;

  it("one per source: YouTube comments, TikTok comments, TikTok channels, X posts, Facebook page posts, companies, decision makers", () => {
    expect(plans.map((plan) => plan.id)).toEqual(["youtube-comments", "tiktok-comments", "tiktok-channels-top-videos", "x-posts-event", "facebook-page-posts", "companies", "decision-makers"]);
  });

  it("the volumes are the owner's caps, quoted and settled by the existing public quote function", () => {
    // per-record prices (cost per delivered record x 5,500): 0.275 a comment, 0.11715 an X post, 3.4485 a Facebook page post, 3.168 a company
    expect(byId("youtube-comments").asSpecified).toMatchObject({ volume: 30, unitPricePoints: 0.275, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
    expect(byId("tiktok-comments").asSpecified).toMatchObject({ volume: 30, unitPricePoints: 0.275, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
    expect(byId("tiktok-channels-top-videos").asSpecified).toMatchObject({ volume: 120, cutToOneJob: false, volumeHeld: 120, quotedPoints: 38, settledIfAllDeliveredPoints: 33 });
    expect(byId("x-posts-event").asSpecified).toMatchObject({ volume: 100, unitPricePoints: 0.11715, quotedPoints: 14, settledIfAllDeliveredPoints: 12 });
    expect(byId("facebook-page-posts").asSpecified).toMatchObject({ volume: 20, unitPricePoints: 3.4485, quotedPoints: 80, settledIfAllDeliveredPoints: 69 });
    expect(byId("companies").asSpecified).toMatchObject({ volume: 5, unitPricePoints: 3.168, quotedPoints: 19, settledIfAllDeliveredPoints: 16 });
    expect(byId("decision-makers").asSpecified).toMatchObject({ volume: 1, unitPricePoints: 193, quotedPoints: 222, settledIfAllDeliveredPoints: 193 });
  });

  it("the owner's two limits: at the per-record prices only the channels mission, the Facebook page posts and decision makers quote above 20 points at the specified volume", () => {
    const over = plans.filter((plan) => plan.asSpecified.quotedPoints > QUOTE_LIMIT_POINTS).map((plan) => plan.id);
    expect(over).toEqual(["tiktok-channels-top-videos", "facebook-page-posts", "decision-makers"]);
    expect(byId("companies").asSpecified.quotedPoints).toBeLessThanOrEqual(QUOTE_LIMIT_POINTS);
    expect(byId("decision-makers").within20Points).toBeNull();
    expect(largestVolumeWithin("professional-people-search", 20, 5)).toBeNull();
  });

  it("the within-20-points versions: the largest volume whose quote is at most 20, and every one is", () => {
    expect(byId("youtube-comments").within20Points).toMatchObject({ volume: 30, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
    expect(byId("tiktok-comments").within20Points).toMatchObject({ volume: 30, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
    expect(byId("tiktok-channels-top-videos").within20Points).toMatchObject({ volume: 63, quotedPoints: 20, settledIfAllDeliveredPoints: 18 });
    expect(byId("x-posts-event").within20Points).toMatchObject({ volume: 100, quotedPoints: 14, settledIfAllDeliveredPoints: 12 });
    expect(byId("facebook-page-posts").within20Points).toMatchObject({ volume: 5, quotedPoints: 20, settledIfAllDeliveredPoints: 18 });
    expect(byId("companies").within20Points).toMatchObject({ volume: 5, quotedPoints: 19, settledIfAllDeliveredPoints: 16 });
    for (const plan of plans) if (plan.within20Points) {
      expect(plan.within20Points.quotedPoints).toBeLessThanOrEqual(QUOTE_LIMIT_POINTS);
      // one more record would pass the limit (unless the request itself stops there)
      const next = testerQuote(plan.slug, plan.within20Points.volume + 1);
      if (plan.within20Points.volume < plan.asSpecified.volume) expect(next.quotedPoints).toBeGreaterThan(QUOTE_LIMIT_POINTS);
    }
  });

  it("the expected provider spend as specified is over 0.02 USD; the recommended set (two videos per channel) is under it", () => {
    expect(totalExpectedProviderUsd(plans)).toBe(0.02134);
    expect(totalExpectedProviderUsd(plans)).toBeGreaterThan(TOTAL_PROVIDER_USD_LIMIT);
    expect(totalExpectedProviderUsd(plans, "recommended")).toBe(0.01934);
    expect(totalExpectedProviderUsd(plans, "recommended")).toBeLessThan(TOTAL_PROVIDER_USD_LIMIT);
    const adjusted = byId("tiktok-channels-top-videos").adjustedForBudget!;
    expect(adjusted.quote).toMatchObject({ volume: 80, cutToOneJob: false, quotedPoints: 26, settledIfAllDeliveredPoints: 22 });
    expect(adjusted.providerCallsExpected).toBe(6);
    expect(adjusted.providerUsdExpected).toBe(0.0064);
    expect(plans.filter((plan) => plan.adjustedForBudget).map((plan) => plan.id)).toEqual(["tiktok-channels-top-videos"]);
  });

  it("a settlement never passes its quote, and the quote for the volume held is what one job reserves", () => {
    for (const plan of plans) expect(plan.asSpecified.settledIfAllDeliveredPoints).toBeLessThanOrEqual(plan.asSpecified.quotedPoints);
  });

  it("the requests are in plain Arabic: only the brackets for the tester to fill in, no Latin letters, no digits outside Arabic-Indic, no provider names", () => {
    for (const plan of plans) {
      for (const text of [plan.textAr, plan.sourceAr, plan.measureAr, plan.adjustedForBudget?.textAr ?? "", plan.adjustedForBudget?.reasonAr ?? ""]) {
        expect(text).not.toMatch(/[A-Za-z0-9]|undefined|null|NaN|https?:/);
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
      expect(plan.textAr).toMatch(/\[/);
    }
  });

  it("the plan file states every number the code states", () => {
    const doc = readFileSync("docs/LONG_JOB_MEASUREMENT_PLAN.md", "utf8");
    for (const plan of plans) {
      expect(doc).toContain(plan.textAr);
      expect(doc).toContain(`| ${plan.asSpecified.quotedPoints} |`);
    }
    for (const needle of ["0.02134", "0.01934", "26 points", "138", "193", "0.0084 (8)", "0.00288 (1)"]) expect(doc).toContain(needle);
    expect(doc).toContain(byId("tiktok-channels-top-videos").adjustedForBudget!.textAr);
  });
});
