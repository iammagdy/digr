import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";
import { recordsInOneJob, reserveInOneJob } from "../src/lib/jobSizing";
import { estimateMission } from "../src/lib/missionEstimate";
import { computePublicCalculatorQuote } from "../src/lib/calculatorPricing";
import { SEGMENTS, segmentExample } from "../src/lib/segments";
import { DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
  getEndpointDetails: vi.fn(async (id: string) => ({ id, catalogPriceUsd: 0.005, pointsPerUnit: 28 })),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";

function makeMockTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const parseEqual = (q: string): [string, string[]] | null => {
    const m = /^equal\("([^"]+)",\s*(\[.*\]|".*")\)$/.exec(q.trim());
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[2]);
      const vals = Array.isArray(parsed) ? parsed : [parsed];
      return [m[1], vals.map(String)];
    } catch {
      return null;
    }
  };
  const parseLimit = (q: string): number | null => {
    const m = /^limit\((\d+)\)$/.exec(q.trim());
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    async rpc(name: string, args: any) {
      return name === "settle_people_job_atomic"
        ? { data: null, error: { code: "P0001", message: `Job ${args.p_job_id} not found` } }
        : { data: null, error: { code: "PGRST202", message: `function ${name} not found` } };
    },
    async createRow({ tableId, rowId, data }: any) {
      const id = rowId || `row_${Math.random().toString(36).slice(2)}`;
      const doc = { $id: id, ...data };
      table(tableId).set(id, doc);
      return doc;
    },
    async getRow({ tableId, rowId }: any) {
      const doc = table(tableId).get(rowId);
      if (!doc) throw new Error("row not found");
      return doc;
    },
    async listRows({ tableId, queries = [] }: any) {
      let rows = [...table(tableId).values()];
      let limit: number | null = null;
      for (const q of queries) {
        const eq = typeof q === "string" ? parseEqual(q) : null;
        if (eq) {
          const [attr, vals] = eq;
          rows = rows.filter((r) => vals.includes(String(r[attr])));
          continue;
        }
        const lim = typeof q === "string" ? parseLimit(q) : null;
        if (lim !== null) limit = lim;
      }
      if (limit !== null) rows = rows.slice(0, limit);
      return { total: rows.length, rows };
    },
    async updateRow({ tableId, rowId, data }: any) {
      const prev = table(tableId).get(rowId);
      if (!prev) throw new Error("row not found");
      const doc = { ...prev, ...data };
      table(tableId).set(rowId, doc);
      return doc;
    },
    __store: store,
  };
}


const BUFFER = DEFAULT_PRICING_SETTINGS.safetyBuffer;
const writerPeople = async (count: string) => {
  clearBriefCacheForTesting();
  const res: any = await new ChatHandler(makeMockTables() as any).handleUserMessage({
    userId: `u_people_${count}`, message: `أنا عايز ${count} صناع قرار في شركات الكهرباء والميكانيكا في مصر.`, userBalance: 5000,
  });
  return res.planQuote;
};
const writerXPosts = async (asked = "٥٠٠") => {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  const res: any = await handler.handleUserMessage({ userId: "u_x", message: `هات ${asked} تغريدة عن الغلاء على إكس آخر شهر`, userBalance: 20000 });
  return res.planQuote;
};

describe("one job's size comes from ONE function, the quote writer's own rule", () => {
  // The provider side is out of the way (a high balance, and a daily limit in points far above the cap), so the 5,000-point job cap is the ceiling
  // that both the real quote and the public estimate show.
  beforeEach(() => { clearBriefCacheForTesting(); setProviderBalanceForTesting(10); });
  afterEach(() => resetProviderBalanceCacheForTesting());

  it("the rule: reserve-bound for every service, charge-bound (reserve clipped to the cap) for decision makers", () => {
    expect(recordsInOneJob({ unitPricePoints: 5, capPoints: 600, safetyBuffer: BUFFER })).toBe(104);
    expect(reserveInOneJob(104, { unitPricePoints: 5, capPoints: 600, safetyBuffer: BUFFER })).toBe(598);
    expect(recordsInOneJob({ unitPricePoints: 3, capPoints: 600, safetyBuffer: BUFFER })).toBe(173);
    expect(recordsInOneJob({ unitPricePoints: 193, capPoints: 600, safetyBuffer: BUFFER, chargeCapped: true })).toBe(3);
    expect(reserveInOneJob(3, { unitPricePoints: 193, capPoints: 600, safetyBuffer: BUFFER, chargeCapped: true })).toBe(600);
    expect(recordsInOneJob({ unitPricePoints: 193, capPoints: 200, safetyBuffer: BUFFER, chargeCapped: true })).toBe(1);
    expect(recordsInOneJob({ unitPricePoints: 193, capPoints: 100, safetyBuffer: BUFFER, chargeCapped: true })).toBe(0);
    expect(recordsInOneJob({ unitPricePoints: 0, capPoints: 600, safetyBuffer: BUFFER })).toBe(0);
    expect(recordsInOneJob({ unitPricePoints: 5, capPoints: 0, safetyBuffer: BUFFER })).toBe(0);
  });

  it("decision makers: the public estimate says what the real quote says (25 people, 5,000 points held), for any size asked", async () => {
    for (const asked of ["١٠٤", "٢٠٠"]) {
      const plan = await writerPeople(asked);
      // floor(5000 / 193) = 25 people (4,825 points of charge); the buffered hold is clipped to the cap
      expect(plan.targetVolumeMax).toBe(25);
      expect(plan.quotedPoints).toBe(5000);
      const estimate: any = estimateMission({ kind: "people", volume: Number(asked.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))), dailyCapPoints: 100000 });
      expect(estimate.maxVolumeInOneJob).toBe(plan.targetVolumeMax);
      expect(estimateMission({ kind: "people", volume: plan.targetVolumeMax, dailyCapPoints: 100000 })).toMatchObject({ reservePoints: plan.quotedPoints, fitsInOneJob: true, jobsNeeded: 1 });
    }
  });

  it("posts on X: the public estimate says what the real quote says (500 posts fit whole: 68 held; 40,000 are cut to 37,113 posts, 5,000 held)", async () => {
    const small = await writerXPosts();
    expect(small.targetVolumeMax).toBe(500);
    expect(small.quotedPoints).toBe(68);
    expect(estimateMission({ kind: "posts", platform: "x", volume: 500, dailyCapPoints: 100000 })).toMatchObject({ maxVolumeInOneJob: 37113, fitsInOneJob: true, reservePoints: 68 });
    const large = await writerXPosts("٤٠٠٠٠");
    expect(large.targetVolumeMax).toBe(37113);
    expect(large.quotedPoints).toBe(5000);
    expect(estimateMission({ kind: "posts", platform: "x", volume: 40000, dailyCapPoints: 100000 })).toMatchObject({ maxVolumeInOneJob: 37113, fitsInOneJob: false });
    expect(estimateMission({ kind: "posts", platform: "x", volume: 37113, dailyCapPoints: 100000 })).toMatchObject({ reservePoints: 5000, fitsInOneJob: true });
  });

  const SERVICES: Array<{ label: string; input: any; slug: string }> = [
    { label: "decision makers", input: { kind: "people" }, slug: "professional-people-search" },
    { label: "posts on X", input: { kind: "posts", platform: "x" }, slug: "social-x-posts" },
    { label: "YouTube comments", input: { kind: "comments", platform: "youtube" }, slug: "social-youtube-comments" },
    { label: "companies", input: { kind: "companies" }, slug: "icypeas-companies-search" },
  ];

  it("the estimate box and the detailed calculator give the same records per job, with the same cap input", () => {
    for (const service of SERVICES) {
      for (const dailyCapPoints of [undefined, 100000, 600, 200]) {
        const estimate: any = estimateMission({ ...service.input, volume: 100000, dailyCapPoints });
        const detailed = computePublicCalculatorQuote(service.slug, 100000, 100000, undefined, undefined, undefined, undefined, dailyCapPoints);
        expect(estimate.unitPricePoints, `${service.label} unit`).toBe(detailed.unitPricePoints);
        expect(estimate.jobCapPoints, `${service.label} cap`).toBe(detailed.maxCapPoints);
        // the detailed calculator never shows less than one record; the estimate says 0 when not even one fits
        expect(Math.max(1, estimate.maxVolumeInOneJob), `${service.label} @${dailyCapPoints}`).toBe(detailed.maxCappedVolume);
        expect(detailed.cappedReservedPoints).toBeLessThanOrEqual(Math.max(detailed.maxCapPoints!, detailed.unitPricePoints * 2));
      }
    }
  });

  it("decision makers are priced per person plus both contact fields in the detailed calculator, as the writer does (193, not the base 83)", () => {
    const detailed = computePublicCalculatorQuote("professional-people-search", 3, 3);
    expect(detailed.unitPricePoints).toBe(83 + 55 + 55);
    expect(detailed.maxCappedVolume).toBe(3);
    // 579 x 1.15 = 665.85 -> 666 held (the 5,000-point cap does not clip it)
    expect(detailed.cappedReservedPoints).toBe(666);
  });

  it("the segment pages size one job exactly as the estimate box does, at the default and at a live limit", () => {
    for (const segment of SEGMENTS) {
      for (const dailyCapPoints of [undefined, 200]) {
        const example = segmentExample(segment, dailyCapPoints);
        const estimate = estimateMission({ ...segment.estimate, dailyCapPoints });
        expect(example.result).toEqual(estimate);
      }
    }
  });

  it("a lower live limit lowers every surface alike; none of them changes a cap value", () => {
    const fresh: any = estimateMission({ kind: "posts", platform: "x", volume: 50000, dailyCapPoints: 100000 });
    const live: any = estimateMission({ kind: "posts", platform: "x", volume: 50000, dailyCapPoints: 200 });
    expect(fresh.jobCapPoints).toBe(5000);
    expect(live.jobCapPoints).toBe(200);
    expect(live.maxVolumeInOneJob).toBeLessThan(fresh.maxVolumeInOneJob);
    const detailed = computePublicCalculatorQuote("social-x-posts", 50000, 50000, undefined, undefined, undefined, undefined, 200);
    expect(detailed.maxCappedVolume).toBe(live.maxVolumeInOneJob);
    // with no live reading both use the provider's default daily limit in points (0.80 USD = 4,400), which is below the cap
    const unread: any = estimateMission({ kind: "posts", platform: "x", volume: 50000 });
    expect(unread.jobCapPoints).toBe(4400);
    expect(computePublicCalculatorQuote("social-x-posts", 50000, 50000).maxCapPoints).toBe(4400);
  });
});
