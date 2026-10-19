import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAutoPlanProposal, buildDeterministicPlanFromIntent, dateFiltersFromHint, extractDateHint } from "../src/functions/shared/chatHandler";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { extractRequestIntent } from "../src/lib/requestIntent";
import { filterRowsByDateRange } from "../src/lib/server/dateRangeFilter";

const NOW = new Date("2026-10-19T16:17:00Z");
const DEFAULT_WINDOW = "آخر 3 شهور";
const caps = APPROVED_CAPABILITY_CATALOG as any[];

describe("dateFiltersFromHint reads every form of a relative window", () => {
  it("«شهور» and «أشهر» are months, with Latin or Arabic-Indic digits (the live bug turned «آخر ٣ شهور» into 3 days)", () => {
    for (const hint of ["آخر 3 شهور", "آخر ٣ شهور", "آخر ٣ أشهر", "خلال ٣ اشهر"]) {
      expect(dateFiltersFromHint(hint, NOW), hint).toEqual({ from: "2026-07-19", to: "2026-10-19" });
    }
    expect(dateFiltersFromHint("آخر شهر", NOW)).toEqual({ from: "2026-09-19", to: "2026-10-19" });
    expect(dateFiltersFromHint("آخر ١٢ شهر", NOW)).toEqual({ from: "2025-10-19", to: "2026-10-19" });
  });

  it("the dual forms carry their own count of two", () => {
    expect(dateFiltersFromHint("آخر شهرين", NOW)).toEqual({ from: "2026-08-19", to: "2026-10-19" });
    expect(dateFiltersFromHint("خلال أسبوعين", NOW)).toEqual({ from: "2026-10-05", to: "2026-10-19" });
    expect(dateFiltersFromHint("آخر يومين", NOW)).toEqual({ from: "2026-10-17", to: "2026-10-19" });
    expect(dateFiltersFromHint("آخر سنتين", NOW)).toEqual({ from: "2024-10-19", to: "2026-10-19" });
    expect(dateFiltersFromHint("خلال عامين", NOW)).toEqual({ from: "2024-10-19", to: "2026-10-19" });
  });

  it("weeks, years and days, singular and plural", () => {
    expect(dateFiltersFromHint("آخر ٣ أسابيع", NOW)).toEqual({ from: "2026-09-28", to: "2026-10-19" });
    expect(dateFiltersFromHint("آخر أسبوع", NOW)).toEqual({ from: "2026-10-12", to: "2026-10-19" });
    expect(dateFiltersFromHint("آخر سنة", NOW)).toEqual({ from: "2025-10-19", to: "2026-10-19" });
    expect(dateFiltersFromHint("آخر ٣ سنوات", NOW)).toEqual({ from: "2023-10-19", to: "2026-10-19" });
    expect(dateFiltersFromHint("آخر ١٠ أيام", NOW)).toEqual({ from: "2026-10-09", to: "2026-10-19" });
    expect(dateFiltersFromHint("آخر ٣٠ يوم", NOW)).toEqual({ from: "2026-09-19", to: "2026-10-19" });
  });

  it("absolute dates and years still win, and text with no window gives none", () => {
    expect(dateFiltersFromHint("من 2025-02-01 إلى 2025-03-01", NOW)).toEqual({ from: "2025-02-01", to: "2025-03-01" });
    expect(dateFiltersFromHint("في سنة 2024", NOW)).toEqual({ from: "2024-01-01", to: "2024-12-31" });
    expect(dateFiltersFromHint("٣ مديرين في شركات الطاقة في السعودية", NOW)).toEqual({});
  });

  it("extractDateHint recognizes the same forms in a request", () => {
    expect(extractDateHint("هات منشورات آخر شهرين")).toBe("آخر شهرين");
    expect(extractDateHint("هات منشورات خلال أسبوعين")).toBe("خلال أسبوعين");
    expect(extractDateHint("هات منشورات آخر ٣ شهور")).toBe("آخر ٣ شهور");
    expect(extractDateHint("٣ مديرين في شركات الطاقة في السعودية")).toBeUndefined();
  });
});

describe("the default window is for feeds, not for directories of people or companies", () => {
  afterEach(() => vi.useRealTimers());
  const brief = (dateRange?: string) => ({ platforms: [], topics: [], formats: [], dateRange } as any);
  const companyBrief = (dateRange?: string) => ({ platforms: ["companies"], topics: ["كهرباء"], formats: [], dateRange } as any);
  const PEOPLE = "٣ مديرين في شركات الطاقة في السعودية مع إيميلاتهم وأرقامهم";
  const COMPANIES = "عايز شركتين كهرباء في مصر";

  it("a people plan from a request with no date carries no dateFrom or dateTo, even when the brief holds the default window", () => {
    const plan = buildDeterministicPlanFromIntent(extractRequestIntent(PEOPLE), PEOPLE, brief(DEFAULT_WINDOW), caps);
    const params = plan.capabilities[0].params;
    expect(params).not.toHaveProperty("dateFrom");
    expect(params).not.toHaveProperty("dateTo");
    expect(params).toMatchObject({ country: "SA", limit: 3 });
  });

  it("a company plan from a request with no date carries no window either", () => {
    const plan = buildDeterministicPlanFromIntent(extractRequestIntent(COMPANIES), COMPANIES, companyBrief(DEFAULT_WINDOW), caps);
    expect(plan.capabilities[0].capabilitySlug).toBe("icypeas-companies-search");
    const params = plan.capabilities[0].params;
    expect(params).not.toHaveProperty("dateFrom");
    expect(params).not.toHaveProperty("dateTo");
  });

  it("an explicit period in a people or company request still produces the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const people = `${PEOPLE} آخر شهرين`;
    const peoplePlan = buildDeterministicPlanFromIntent(extractRequestIntent(people), people, brief(), caps);
    expect(peoplePlan.capabilities[0].params).toMatchObject({ dateFrom: "2026-08-19", dateTo: "2026-10-19" });
    const companies = `${COMPANIES} خلال سنة 2024`;
    const companyPlan = buildDeterministicPlanFromIntent(extractRequestIntent(companies), companies, companyBrief(), caps);
    expect(companyPlan.capabilities[0].params).toMatchObject({ dateFrom: "2024-01-01", dateTo: "2024-12-31" });
  });

  it("a feed (posts) keeps the default window of the brief", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const plan = buildAutoPlanProposal(
      { platforms: ["x"], topics: ["كرة السلة"], targetVolume: 10, dateRange: DEFAULT_WINDOW },
      caps,
      "هات ١٠ تغريدات عن كرة السلة",
    );
    expect(plan.capabilities[0].params).toMatchObject({ dateFrom: "2026-07-19", dateTo: "2026-10-19" });
  });
});

describe("the worker's date filter on a directory", () => {
  const rows = [{ company_name: "No date" }, { company_name: "In", created_at: "2026-09-01T00:00:00Z" }, { company_name: "Out", created_at: "2020-01-01T00:00:00Z" }];

  it("keeps rows that have no date when keepUndated is set, and still drops rows dated outside the window", () => {
    const result = filterRowsByDateRange(rows, "2026-07-19", "2026-10-19", { keepUndated: true });
    expect(result.rows.map((row) => row.company_name)).toEqual(["No date", "In"]);
    expect(result.excludedCount).toBe(1);
  });

  it("the default stays strict for feeds: an undated row is dropped", () => {
    const result = filterRowsByDateRange(rows, "2026-07-19", "2026-10-19");
    expect(result.rows.map((row) => row.company_name)).toEqual(["In"]);
  });
});
