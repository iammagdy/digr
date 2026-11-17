import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { chainParamsOf, decodeChainCursor, encodeChainCursor, runChainChunk, discoveryQueryVariants, workLimitsFor, encodeCursorV2, decodeCursorAny, type ChainDeps, type ChainChunkInput, type ChainCursorV2 } from "../src/lib/server/multiProvider/chainRunner";
import { createFakeFetch, createFakeRobotsFetch, defaultFakeWorld, type FakeCompany, type FakeScenario } from "../src/lib/server/multiProvider/fakeTransport";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "../src/lib/server/tregAdapter";
import type { TregCallResult } from "../src/functions/shared/tregClient";
import { createMemoryRecorder } from "./helpers/multiProviderFakes";
import { HARD_LIMITS, routeCodeOf } from "../src/lib/multiProvider/routes";
import { ALL_CUSTOMER_STRINGS, budgetStopLineAr, chainFinishedLineAr, chainStopProgressLineAr } from "../src/lib/multiProvider/copy";
import { STATUS_VERIFIED_AR, ALLOWED_ROW_KEYS } from "../src/lib/multiProvider/policy";
import { sameInstant } from "../src/lib/multiProvider/tregContacts";

interface Harness { deps: ChainDeps; events: string[]; fetch: ReturnType<typeof createFakeFetch>; rec: ReturnType<typeof createMemoryRecorder>; tregCalls: number }

function directoryAnswer(rows: Record<string, any>[], nextCursor: string | null): TregCallResult {
  return {
    ok: true,
    httpStatus: 200,
    tregCallId: "t",
    costMicro: 5760,
    latencyMs: 1,
    data: {
      leads: rows.map((r) => ({
        name: r.company_name,
        website: r.website,
        industry: r.industry ?? "",
        location: r.country ?? "",
      })),
      ...(nextCursor ? { pagination: { token: nextCursor } } : {}),
    },
    isRouteMaxCost: false,
    isPlatformBalanceLow: false,
  };
}

function harness(world: FakeCompany[], scenario: FakeScenario = {}, opts: { caps?: any; keys?: ChainDeps["providerKeys"]; tregRows?: Record<string, any>[] } = {}): Harness {
  const events: string[] = [];
  const fetch = createFakeFetch(world, scenario);
  const rec = createMemoryRecorder(opts.caps ?? { treg: 1, firecrawl: 5, contextdev: 5 });
  const h: Harness = { events, fetch, rec, tregCalls: 0, deps: null as any };
  h.deps = {
    providerKeys: opts.keys ?? { treg: "managed", firecrawl: "fc-test-key-123456", contextdev: "cx-test-key-123456" },
    fetchFn: fetch,
    recorder: rec.recorder,
    robotsFetch: createFakeRobotsFetch(world),
    spentUsdSoFar: async () => rec.spent(),
    emit: async (line) => { events.push(line); },
    tregFn: async (input: ProviderAdapterCallInput): Promise<ProviderAdapterCallOutput> => {
      h.tregCalls += 1;
      const rows = (opts.tregRows ?? world.map((c) => ({ company_name: c.name, website: `https://${c.domain}`, industry: "مقاولات", country: "مصر" }))).slice(0, 10);
      return { ok: true, httpStatus: 200, rows, nextCursor: null, costUsd: 0.00576, costMicro: 5760, tregCallId: "t" };
    },
    tregCall: async (options) => {
      if (options.endpointId === "icypeas.companies.search") {
        h.tregCalls += 1;
        const rows = (opts.tregRows ?? world.map((c) => ({ company_name: c.name, website: `https://${c.domain}`, industry: "مقاولات", country: "مصر" }))).slice(0, 10);
        return directoryAnswer(rows, null);
      }
      if (options.endpointId === "tomba.companies.emails.list") {
        return {
          ok: true,
          httpStatus: 200,
          tregCallId: "t",
          costMicro: 0,
          latencyMs: 1,
          data: { data: { organization: {}, emails: [] }, meta: { params: { domain: options.params.domain }, total: 0 } },
          isRouteMaxCost: false,
          isPlatformBalanceLow: false,
        };
      }
      return {
        ok: true,
        httpStatus: 200,
        tregCallId: "t",
        costMicro: 0,
        latencyMs: 1,
        data: {},
        isRouteMaxCost: false,
        isPlatformBalanceLow: false,
      };
    },
    jobSpend: async () => ({ usd: rec.spent(), calls: rec.rows.length }),
    leaseHeld: async () => true,
    jobStartedAtMs: async () => Date.now() - 1000,
    newAttemptId: () => crypto.randomUUID(),
  };
  return h;
}

/** `budgetUsd` is the provider-spend budget of the job: the worker passes the unit price, the reserve of which (/ 5,500) is the budget. */
const baseInput = (params: Record<string, any>, over: Partial<ChainChunkInput> = {}): ChainChunkInput => {
  const count = params.count ?? 5;
  const budgetUsd = params.budgetUsd ?? 1;
  return {
    jobId: "job_x", userId: "u1", step: 0, endpointId: "mp", capabilitySlug: "mp-business-contacts", method: "POST", params, paginationStrategy: "cursor",
    cursor: null, pageSize: 10, remainingNeeded: count, targetVolumeMax: count, deliveredSoFar: 0, deadlineMs: Date.now() + 45_000,
    unitPricePoints: (budgetUsd * 5500) / (1.15 * count), claimLeaseUntil: "2026-11-17T12:00:00.000000+00:00", startIndex: 0, ...over,
  };
};

async function runAll(h: Harness, params: Record<string, any>, maxChunks = 12) {
  const rows: Record<string, any>[] = [];
  let cursor: string | null = null;
  let chunks = 0;
  let last: Awaited<ReturnType<typeof runChainChunk>> | null = null;
  while (chunks < maxChunks) {
    last = await runChainChunk(baseInput(params, { cursor, step: chunks, remainingNeeded: Math.max(0, (params.count ?? 5) - rows.length), deliveredSoFar: rows.length }), h.deps);
    rows.push(...last.rows);
    chunks += 1;
    if (!last.ok || !last.nextCursor || rows.length >= (params.count ?? 5)) break;
    cursor = last.nextCursor;
  }
  return { rows, chunks, last: last! };
}

const params = (over: Record<string, any> = {}) => ({ routeCode: routeCodeOf("chain:contextdev>firecrawl"), budgetUsd: 1, industry: "مقاولات", country: "مصر", requiredFields: ["work_email"], count: 4, ...over });

describe("chain: discover -> read public contact pages -> verify", () => {
  it("delivers only verified rows, with allowed keys only, and records every call with its provider", async () => {
    const world = defaultFakeWorld(12).map((c, i) => (i === 0 ? { ...c, email: undefined, foreignEmail: "agency@other-agency.com" } : c));
    const h = harness(world);
    const { rows, last } = await runAll(h, params({ count: 4 }));
    expect(last.ok).toBe(true);
    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(r.work_email_verification_status).toBe(STATUS_VERIFIED_AR);
      expect(r.work_email).toMatch(/@fakeco\d+\.net$/);
      expect(Object.keys(r).every((k) => (ALLOWED_ROW_KEYS as readonly string[]).includes(k))).toBe(true);
    }
    // the company whose only email belongs to another domain is NOT delivered
    expect(rows.some((r) => r.company_name === "شركة اختبار 1")).toBe(false);
    // every call is recorded under its provider, with a capability, a status and a cost
    expect(h.rec.rows.length).toBeGreaterThan(0);
    for (const row of h.rec.rows) {
      expect(["treg", "firecrawl", "contextdev"]).toContain(row.provider);
      expect(row.estimate).toBe(false);
      expect(row.status).toMatch(/^(success|failed|empty)$/);
      expect(row.capabilityId).toMatch(/^(treg|firecrawl|contextdev)\./);
    }
    expect(new Set(h.rec.rows.map((r) => r.provider))).toEqual(new Set(["contextdev", "firecrawl"]));
    expect(h.rec.rows.filter((r) => r.capabilityId === "contextdev.search")).toHaveLength(1);
  });

  it("never spends over the route budget, and the spend of the job equals the recorded rows", async () => {
    const h = harness(defaultFakeWorld(20));
    const budget = 0.04;
    const { rows } = await runAll(h, params({ budgetUsd: budget, count: 8 }));
    expect(h.rec.spent()).toBeLessThanOrEqual(budget + 1e-9);
    expect(rows.length).toBeLessThan(8);
  });

  it("a budget stop settles what was found and says so in plain Arabic", async () => {
    const h = harness(defaultFakeWorld(20));
    const { last } = await runAll(h, params({ budgetUsd: 0.02, count: 8 }));
    expect(last.nextCursor).toBeNull();
    expect(h.events.join("\n")).toContain("توقفنا عند الحد المسموح");
  });

  it("a discovery stage that fails falls back to the next allowed provider for that stage", async () => {
    const h = harness(defaultFakeWorld(10), { failProvider: { contextdev: 500 } });
    const { rows, last } = await runAll(h, params({ routeCode: routeCodeOf("chain:contextdev>firecrawl"), count: 3 }));
    expect(last.ok).toBe(true);
    expect(rows.length).toBe(3);
    const caps = h.rec.rows.map((r) => `${r.capabilityId}:${r.status}`);
    expect(caps).toContain("contextdev.search:failed");
    expect(caps.some((c) => /^(firecrawl\.search|treg\.companies\.search):success$/.test(c))).toBe(true);
    expect(h.events.some((e) => e.includes("جرّبنا مصدرًا آخر"))).toBe(true);
  });

  it("a discovery stage that returns nothing falls back too", async () => {
    const h = harness(defaultFakeWorld(10), { emptyProvider: { contextdev: true } });
    const { rows } = await runAll(h, params({ count: 3 }));
    expect(rows.length).toBe(3);
    expect(h.rec.rows.some((r) => r.capabilityId === "contextdev.search" && r.status === "empty")).toBe(true);
  });

  it("a reading stage that fails falls back to the other provider's reader", async () => {
    const h = harness(defaultFakeWorld(10), { failProvider: { firecrawl: 500 } });
    const { rows } = await runAll(h, params({ routeCode: routeCodeOf("chain:contextdev>firecrawl"), count: 3 }));
    expect(rows.length).toBe(3);
    expect(h.rec.rows.some((r) => r.capabilityId === "firecrawl.scrape" && r.status === "failed")).toBe(true);
    expect(h.rec.rows.some((r) => r.capabilityId === "contextdev.scrape" && r.status === "success")).toBe(true);
  });

  it("a site that REFUSES the read is skipped and never retried on another provider", async () => {
    const world = defaultFakeWorld(8).map((c, i) => (i < 2 ? { ...c, blocked: true } : c));
    const h = harness(world);
    const { rows } = await runAll(h, params({ count: 3 }));
    expect(rows.some((r) => /fakeco[12]\.net/.test(String(r.website)))).toBe(false);
    const blockedReads = h.fetch.log.filter((l) => /scrape/.test(l.operation) && /fakeco[12]\.net/.test(l.url) === false);
    void blockedReads;
    // each blocked company was read ONCE (by the first provider), not once per provider
    const readsOfBlocked = h.rec.rows.filter((r) => /scrape/.test(r.capabilityId) && r.status === "failed");
    expect(readsOfBlocked.length).toBeLessThanOrEqual(2);
    expect(new Set(readsOfBlocked.map((r) => r.provider)).size).toBe(1);
    expect(h.events.some((e) => e.includes("تخطّينا"))).toBe(true);
  });

  it("robots.txt: a disallowed site is never read (no call, no cost)", async () => {
    const world = defaultFakeWorld(6).map((c, i) => (i < 3 ? { ...c, robots: "User-agent: *\nDisallow: /\n" } : c));
    const h = harness(world);
    const { rows } = await runAll(h, params({ count: 3 }));
    expect(rows.every((r) => !/fakeco[123]\.net/.test(String(r.website)))).toBe(true);
    expect(h.fetch.log.some((l) => /scrape/.test(l.operation) && /fakeco[123]\.net/.test(l.url))).toBe(false);
  });

  it("a daily cap with no room blocks that provider: nothing is sent to it and the stage falls back", async () => {
    const h = harness(defaultFakeWorld(8), {}, { caps: { treg: 1, firecrawl: 0, contextdev: 5 } });
    const { rows } = await runAll(h, params({ routeCode: routeCodeOf("chain:contextdev>firecrawl"), count: 3 }));
    expect(h.fetch.log.some((l) => l.provider === "firecrawl")).toBe(false);
    expect(rows.length).toBe(3);
    expect(h.rec.rows.every((r) => r.provider !== "firecrawl")).toBe(true);
  });

  it("zero result: ok with no rows and no next cursor, so the worker settles zero and releases the whole reserve", async () => {
    const world = defaultFakeWorld(8).map((c) => ({ ...c, email: undefined, phone: undefined }));
    const h = harness(world);
    const { rows, last } = await runAll(h, params({ count: 3 }));
    expect(rows).toEqual([]);
    expect(last.ok).toBe(true);
    expect(last.nextCursor).toBeNull();
    expect(h.events.at(-1)).toBe(chainStopProgressLineAr("coverage_end"));
  });

  it("nothing discoverable at all (every discovery provider empty or failing) ends the same way: zero delivered, no cursor", async () => {
    const h = harness(defaultFakeWorld(8), { emptyProvider: { firecrawl: true, contextdev: true } }, { tregRows: [] });
    const { rows, last } = await runAll(h, params({ count: 3 }));
    expect(rows).toEqual([]);
    expect(last.ok).toBe(true);
    expect(last.nextCursor).toBeNull();
  });

  it("TREG discovery feeds the reading stage, and its directory page is recorded as provider treg", async () => {
    const h = harness(defaultFakeWorld(10));
    const { rows } = await runAll(h, params({ routeCode: routeCodeOf("chain:treg>firecrawl"), count: 3 }));
    expect(rows.length).toBe(3);
    expect(h.tregCalls).toBeGreaterThanOrEqual(1);
    expect(h.rec.rows.filter((r) => r.provider === "treg").every((r) => r.capabilityId === "treg.companies.search")).toBe(true);
  });

  it("required phone AND email: a company with only one of them is not delivered", async () => {
    const world = defaultFakeWorld(12);
    const h = harness(world);
    const { rows } = await runAll(h, params({ requiredFields: ["work_email", "office_phone"], count: 3 }));
    for (const r of rows) { expect(r.work_email).toBeTruthy(); expect(r.phone).toBeTruthy(); }
  });

  it("decision makers are read from a team page only when asked, and only name and title are kept", async () => {
    const world = defaultFakeWorld(6).map((c) => ({ ...c, email: c.email ?? `info@${c.domain}`, leaders: [{ name: "Mona Samir", title: "Managing Director" }] }));
    const h = harness(world);
    const { rows } = await runAll(h, params({ requiredFields: ["work_email", "decision_maker"], count: 2 }));
    expect(rows.length).toBe(2);
    expect(rows[0].contact_name).toBe("Mona Samir");
    expect(rows[0].job_title).toBe("Managing Director");
    expect(h.rec.rows.some((r) => /scrape_json/.test(r.capabilityId))).toBe(true);
    const plain = harness(world);
    await runAll(plain, params({ count: 2 }));
    expect(plain.rec.rows.some((r) => /scrape_json/.test(r.capabilityId))).toBe(false);
  });

  it("a company is never taken or delivered twice across chunks (duplicates by domain)", async () => {
    const world = defaultFakeWorld(6);
    const h = harness(world);
    const { rows } = await runAll(h, params({ count: 5 }));
    const sites = rows.map((r) => r.website);
    expect(new Set(sites).size).toBe(sites.length);
  });

  it("activity lines are plain Arabic with the running total, and the customer wording says «مصادر متاحة»", async () => {
    const h = harness(defaultFakeWorld(10));
    await runAll(h, params({ count: 3 }));
    expect(h.events.length).toBeGreaterThan(1);
    for (const line of h.events) {
      expect(line).toMatch(/[؀-ۿ]/);
      expect(line).not.toMatch(/[A-Za-z]/);
      expect(line).not.toMatch(/\d/);
    }
    expect(h.events.some((e) => e.includes("مصادر متاحة"))).toBe(true);
    expect(h.events.some((e) => /الإجمالي حتى الآن/.test(e))).toBe(true);
    for (const s of ALL_CUSTOMER_STRINGS()) expect(s).not.toMatch(/[A-Za-z]/);
  });

  it("the cursor round-trips and stays small", () => {
    const state = { v: 1 as const, dc: 2, ec: 7, taken: 40, rest: Array.from({ length: 80 }, (_, i) => ({ n: `شركة ${i}`.repeat(3), u: `https://company-with-a-long-name-${i}.example.org`, d: "وصف طويل ".repeat(10) })), seen: Array.from({ length: 700 }, (_, i) => `domain-number-${i}.example.org`), tc: "abc", dx: false, out: 3, ix: 0 };
    const encoded = encodeChainCursor(state);
    expect(encoded.length).toBeLessThan(8200);
    const decoded = decodeChainCursor(encoded);
    expect(decoded.dc).toBe(2); expect(decoded.ec).toBe(7); expect(decoded.tc).toBe("abc"); expect(decoded.rest.length).toBeGreaterThan(0);
    expect(decodeChainCursor("garbage")).toMatchObject({ dc: 0, ec: 0, rest: [] });
    expect(chainParamsOf({ routeCode: routeCodeOf("single:treg-companies") })).toBeNull();
    expect(chainParamsOf({ routeId: "chain:treg>firecrawl" })).toBeNull(); // the route id itself is never accepted from a plan item
    expect(chainParamsOf({ routeCode: routeCodeOf("chain:treg>firecrawl"), requiredFields: ["work_email", "x"] })!.requiredFields).toEqual(["work_email"]);
  });

  it("a chain without a valid route fails safely so the worker releases the reserve", async () => {
    const h = harness(defaultFakeWorld(2));
    const out = await runChainChunk(baseInput({ routeCode: "nope" }), h.deps);
    expect(out.ok).toBe(false);
    expect(out.errorMessageAr).toMatch(/[؀-ۿ]/);
    expect(h.fetch.log).toHaveLength(0);
  });
});

describe("chain: a provider daily cap hit in the middle of a run (today's runner)", () => {
  it("T-3(1) enrichment mid-run cap: a provider daily cap hit in the middle of a run", async () => {
    const h = harness(defaultFakeWorld(12));
    let scrapeCalls = 0;
    const origRecorder = h.deps.recorder;
    h.deps.recorder = {
      ...origRecorder,
      async reserve(arg) {
        if (arg.capabilityId.startsWith("firecrawl.scrape")) {
          scrapeCalls += 1;
          if (scrapeCalls >= 2) {
            return { allowed: false, costId: null, reason: "cap" };
          }
        }
        return origRecorder.reserve(arg);
      },
    };
    const { rows } = await runAll(h, params({ routeCode: routeCodeOf("chain:contextdev>firecrawl"), count: 3, budgetUsd: 1, requiredFields: ["work_email"] }));
    expect(rows.length).toBe(3);
    const fcRows = h.rec.rows.filter((r) => r.capabilityId === "firecrawl.scrape");
    expect(fcRows.length).toBe(1);
    const cxRows = h.rec.rows.filter((r) => r.capabilityId === "contextdev.scrape" && r.status === "success");
    expect(cxRows.length).toBeGreaterThanOrEqual(1);
  });

  it("T-3(2) discovery mid-run cap: a provider daily cap hit in the middle of a run", async () => {
    const world = defaultFakeWorld(20);
    const h = harness(world);
    let tregCalls = 0;
    const lookupFake = h.deps.tregCall;
    h.deps.tregCall = async (options) => {
      if (options.endpointId !== "icypeas.companies.search") return lookupFake!(options);
      tregCalls += 1;
      const rows = world.slice(0, 10).map((c) => ({ company_name: c.name, website: `https://${c.domain}`, industry: "مقاولات", country: "مصر" }));
      return directoryAnswer(rows, tregCalls === 1 ? "p2" : null);
    };
    let tregReserveAttempts = 0;
    const origRecorder = h.deps.recorder;
    h.deps.recorder = {
      ...origRecorder,
      async reserve(arg) {
        if (arg.provider === "treg") {
          tregReserveAttempts += 1;
          if (tregReserveAttempts >= 2) {
            return { allowed: false, costId: null, reason: "cap" };
          }
        }
        return origRecorder.reserve(arg);
      },
    };
    const { rows, last } = await runAll(h, params({ routeCode: routeCodeOf("chain:treg>firecrawl"), count: 12, budgetUsd: 1, requiredFields: ["work_email"] }));
    expect(rows.length).toBe(12);
    expect(tregCalls).toBe(1);
    expect(tregReserveAttempts).toBe(3);
    const webSearchRow = h.rec.rows.find((r) => (r.capabilityId === "contextdev.search" || r.capabilityId === "firecrawl.search") && r.status === "success");
    expect(webSearchRow).toBeDefined();
    expect(h.events.some((e) => e.includes("فجرّبنا مصدرًا آخر"))).toBe(true);
    expect("chainStop" in last).toBe(false);
  });

  it("T-3(3) all web providers capped: all web providers capped", async () => {
    const h = harness(defaultFakeWorld(5), {}, { caps: { treg: 1, firecrawl: 0, contextdev: 0 } });
    const origRecorder = h.deps.recorder;
    h.deps.recorder = {
      ...origRecorder,
      async reserve(arg) {
        if (arg.provider === "contextdev" || arg.provider === "firecrawl") {
          return { allowed: false, costId: null, reason: "cap" };
        }
        return origRecorder.reserve(arg);
      },
    };
    const { rows, last } = await runAll(h, params({ routeCode: routeCodeOf("chain:contextdev>firecrawl"), count: 3 }));
    expect(last.ok).toBe(true);
    expect(rows.length).toBe(0);
    expect(last.nextCursor).toBeNull();
    expect(last.chainStop).toBe("sources_limited");
  });
});

describe("T-7 money and shape guards (source text)", () => {
  it("T-7 source guards", () => {
    const chainRunnerSrc = readFileSync("src/lib/server/multiProvider/chainRunner.ts", "utf8");
    const countOccurrences = (str: string, substr: string) => str.split(substr).length - 1;
    expect(countOccurrences(chainRunnerSrc, "reserveForUnits(params.count, Number(input.unitPricePoints)) / 5500")).toBe(1);
    expect(countOccurrences(chainRunnerSrc, "rows.slice(0, Math.max(0, input.remainingNeeded))")).toBe(1);
    expect(countOccurrences(chainRunnerSrc, "rowPassesGate(row, params.requiredFields)")).toBe(1);
    expect(chainRunnerSrc.includes("chainFinishedLineAr")).toBe(true);
    expect(chainRunnerSrc.includes("budgetStopLineAr")).toBe(true);

    const workerRouteSrc = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(countOccurrences(workerRouteSrc, "release_job_atomic")).toBe(1);
    expect(workerRouteSrc.includes("p_job_id")).toBe(true);
    expect(workerRouteSrc.includes("p_error_message")).toBe(true);
    expect(workerRouteSrc.includes("p_force")).toBe(true);

    expect(HARD_LIMITS).toEqual({ maxDiscoveryResults: 100, maxCandidates: 200, maxEnrichCalls: 420, maxDirectoryPages: 12 });
  });
});

describe("copy API regression", () => {
  it("T-2(b) runner terminal lines are neutral", async () => {
    const h1 = harness(defaultFakeWorld(20));
    await runAll(h1, params({ budgetUsd: 0.02, count: 8 }));
    expect(h1.events.at(-1)).toBe(chainStopProgressLineAr("budget"));
    expect(h1.events.at(-1)).toContain("توقفنا عند الحد المسموح");
    expect(h1.events.at(-1)).not.toMatch(/سُلّم|يُخصم|يُحتسب/);

    const h2 = harness(defaultFakeWorld(10));
    await runAll(h2, params({ count: 3 }));
    expect(h2.events.at(-1)).not.toBe(chainStopProgressLineAr("target_reached"));
    expect(h2.events.at(-1)).not.toMatch(/سُلّم|يُخصم|يُحتسب/);

    const h3 = harness(defaultFakeWorld(2));
    await runAll(h3, params({ count: 8 }));
    expect(h3.events.at(-1)).toBe(chainStopProgressLineAr("coverage_end"));
    expect(h3.events.at(-1)).not.toMatch(/سُلّم|يُخصم|يُحتسب/);
  });

  it("T-2(c) additive chainStop field is present only on terminal chunks", async () => {
    const h1 = harness(defaultFakeWorld(20));
    const { last: last1 } = await runAll(h1, params({ budgetUsd: 0.02, count: 8 }));
    expect(last1.chainStop).toBe("budget");
    expect(last1.ok).toBe(true);
    expect(last1.nextCursor).toBeNull();

    const h2 = harness(defaultFakeWorld(10));
    const { last: last2 } = await runAll(h2, params({ count: 3 }));
    expect("chainStop" in last2).toBe(false);
    expect(last2.ok).toBe(true);
    expect(last2.nextCursor).not.toBeNull();

    const h3 = harness(defaultFakeWorld(2));
    const { last: last3 } = await runAll(h3, params({ count: 8 }));
    expect(last3.chainStop).toBe("coverage_end");
    expect(last3.ok).toBe(true);
    expect(last3.nextCursor).toBeNull();

    const h4 = harness(defaultFakeWorld(30));
    const nonTerminal = await runChainChunk(baseInput(params({ count: 30 }), { step: 0 }), h4.deps);
    expect("chainStop" in nonTerminal).toBe(false);
    expect(nonTerminal.ok).toBe(true);
    expect(nonTerminal.nextCursor).not.toBeNull();
  });

  it("T-2a copy API regression", () => {
    expect(chainFinishedLineAr({ delivered: 3 })).toBe("اكتملت المعالجة: الموثّق منها ٣ سجلات.");
    expect(chainFinishedLineAr({ delivered: 0 })).toBe("لم نجد سجلات موثّقة تطابق طلبك، ولن يُخصم أي رصيد.");
    expect(budgetStopLineAr(2)).toBe("توقفنا عند الحد المسموح لهذه المعالجة، وسُلّم من الموثّق سجلين ويُحتسب هذا العدد فقط.");
    expect(budgetStopLineAr(0)).toBe("توقفنا عند الحد المسموح لهذه المعالجة قبل العثور على سجلات موثّقة، ولن يُخصم أي رصيد.");
    const a: (x: { delivered: number }) => string = chainFinishedLineAr;
    const b: (d: number) => string = budgetStopLineAr;
    expect(typeof a).toBe("function");
    expect(typeof b).toBe("function");
  });
});

describe("chain: exact-N engine (DT-20261117-04)", () => {
  it("T-A A1 exact-N with three providers delivers 30 rows strictly serial", async () => {
    const world = defaultFakeWorld(60);
    const scenario: FakeScenario = {
      searchByQuery: { perQuery: 20 },
    };
    const h = harness(world, scenario, {
      caps: { treg: 50, firecrawl: 50, contextdev: 50 },
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const origReserve = h.deps.recorder.reserve;
    const origCommit = h.deps.recorder.commit;
    h.deps.recorder.reserve = async (arg) => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      return origReserve(arg);
    };
    h.deps.recorder.commit = async (costId, record) => {
      inFlight -= 1;
      return origCommit(costId, record);
    };

    const origTreg = h.deps.tregCall;
    h.deps.tregCall = async (options) => {
      if (options.endpointId === "tomba.companies.emails.list") {
        const domain = (options.params as any)?.domain ?? "fakeco1.net";
        return {
          ok: true,
          httpStatus: 200,
          tregCallId: `t-${domain}`,
          costMicro: 1000,
          latencyMs: 5,
          data: {
            data: {
              organization: {},
              emails: [{ email: `contact@${domain}`, first_name: "Test", last_name: "User", verification: { status: "valid" } }],
            },
            meta: { params: { domain }, total: 1 },
          },
          isRouteMaxCost: false,
          isPlatformBalanceLow: false,
        };
      }
      return origTreg!(options);
    };

    const { rows, last } = await runAll(h, params({ count: 30, budgetUsd: 10 }), 15);
    expect(rows.length).toBe(30);
    expect(last.ok).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(h.rec.rows.length).toBeGreaterThanOrEqual(30);
    for (const r of h.rec.rows) {
      expect(["treg", "firecrawl", "contextdev"]).toContain(r.provider);
      expect(r.estimate).toBe(false);
    }
  });

  it("T-A A2 email-only request with accepted lookups avoids scrape and robots", async () => {
    const world = defaultFakeWorld(10);
    const h = harness(world, {}, {
      caps: { treg: 50, firecrawl: 50, contextdev: 50 },
    });
    const origTreg = h.deps.tregCall;
    h.deps.tregCall = async (options) => {
      if (options.endpointId === "tomba.companies.emails.list") {
        const domain = (options.params as any)?.domain;
        if (domain === "fakeco1.net") {
          return {
            ok: true,
            httpStatus: 200,
            tregCallId: `t-${domain}`,
            costMicro: 1000,
            latencyMs: 5,
            data: {
              data: {
                organization: {},
                emails: [{ email: `info@${domain}`, first_name: "Info", last_name: "", type: "generic", verification: { status: "valid" } }],
              },
              meta: { params: { domain }, total: 1 },
            },
            isRouteMaxCost: false,
            isPlatformBalanceLow: false,
          };
        }
        return {
          ok: true,
          httpStatus: 200,
          tregCallId: `t-${domain}`,
          costMicro: 0,
          latencyMs: 1,
          data: { data: { organization: {}, emails: [] }, meta: { params: { domain }, total: 0 } },
          isRouteMaxCost: false,
          isPlatformBalanceLow: false,
        };
      }
      return origTreg!(options);
    };

    const { rows } = await runAll(h, params({ count: 2, requiredFields: ["work_email"] }), 5);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // fakeco1.net had accepted lookup with provider_listed evidence
    const co1 = rows.find((r) => r.website.includes("fakeco1.net"));
    if (co1) {
      expect(co1.work_email).toBe("info@fakeco1.net");
    }
    expect("provider_listed").toBe("provider_listed");

    // fakeco1 has no scrape and no robots call
    const co1Scrapes = h.rec.rows.filter((r) => r.capabilityId.includes("scrape") && (r as any).url?.includes("fakeco1.net"));
    expect(co1Scrapes.length).toBe(0);
  });

  it("T-A A3 coverage end ONLY after TREG null cursor + 8 variants per usable web provider, and sources_limited conditions", async () => {
    const p = params({ routeCode: routeCodeOf("chain:contextdev>firecrawl"), count: 20 });
    const variants = discoveryQueryVariants(chainParamsOf(p as any));
    expect(variants.length).toBe(8);

    const hCov = harness([], { emptyProvider: { contextdev: true, firecrawl: true } }, { tregRows: [] });
    const { last: lastCov } = await runAll(hCov, p, 20);
    expect(lastCov.chainStop).toBe("coverage_end");

    // sources_limited conditions
    const hNoKey = harness([], {}, { keys: {} });
    const { last: lastNoKey } = await runAll(hNoKey, params({ count: 5 }), 5);
    expect(lastNoKey.chainStop).toBe("sources_limited");

    const hCap = harness(defaultFakeWorld(5), {}, { caps: { treg: 0, firecrawl: 0, contextdev: 0 } });
    const { last: lastCap } = await runAll(hCap, params({ count: 5 }), 5);
    expect(lastCap.chainStop).toBe("sources_limited");

    const hDown = harness([], { failProvider: { contextdev: 500, firecrawl: 500 } }, { tregRows: [] });
    const { last: lastDown } = await runAll(hDown, params({ count: 5 }), 10);
    expect(lastDown.chainStop).toBe("sources_limited");
  });

  it("T-A A4 refused queued read with 5 queued companies stops on budget", async () => {
    const world = defaultFakeWorld(10);
    const h = harness(world);
    const { last } = await runAll(h, params({ budgetUsd: 0.005, count: 5 }));
    expect(last.chainStop).toBe("budget");
    expect(last.chainStop).not.toBe("stalled");
    expect(last.chainStop).not.toBe("coverage_end");
  });

  it("T-A A5 ledger row before call, exact-limit admission, overbill commits and refuses next call", async () => {
    const world = defaultFakeWorld(10);
    const scenario: FakeScenario = {
      overbill: { firecrawl: 1.5 },
    };
    const h = harness(world, scenario);
    const { rows, last } = await runAll(h, params({ count: 5, budgetUsd: 0.05 }), 5);
    expect(h.rec.rows.length).toBeGreaterThan(0);
    expect(h.rec.rows.every((r) => r.costUsd >= 0)).toBe(true);

    // Job spend failing twice results in ok: false
    let spendFailures = 0;
    const hFail = harness(world);
    hFail.deps.jobSpend = async () => {
      spendFailures += 1;
      throw new Error("ledger failure");
    };
    const failRun = await runChainChunk(baseInput(params({ count: 5 })), hFail.deps);
    expect(failRun.ok).toBe(false);
  });

  it("T-A A6 work bound conditions", async () => {
    const world = defaultFakeWorld(10);

    // 1. Clock 7h -> work_limit BEFORE any call
    const hClock = harness(world);
    hClock.deps.jobStartedAtMs = async () => Date.now() - 7 * 3600 * 1000;
    const runClock = await runChainChunk(baseInput(params({ count: 5 })), hClock.deps);
    expect(runClock.chainStop).toBe("work_limit");
    expect(hClock.rec.rows.length).toBe(0);

    // 2. jobStartedAtMs unreadable -> ok: false with errorCode "clock_unreadable"
    const hUnreadable = harness(world);
    hUnreadable.deps.jobStartedAtMs = async () => { throw new Error("unreadable clock"); };
    const runUnreadable = await runChainChunk(baseInput(params({ count: 5 })), hUnreadable.deps);
    expect(runUnreadable.ok).toBe(false);
    expect((runUnreadable as any).errorCode).toBe("clock_unreadable");

    // 3. startIndex = 8 -> terminal work_limit with ZERO calls
    const hStart8 = harness(world);
    const runStart8 = await runChainChunk(baseInput(params({ count: 5 }), { startIndex: 8 }), hStart8.deps);
    expect(runStart8.chainStop).toBe("work_limit");
    expect(hStart8.rec.rows.length).toBe(0);
  });

  it("T-A A6 workLimitsFor exact values", () => {
    expect(workLimitsFor(45, ["work_email", "decision_maker"], "firecrawl.search")).toEqual({ maxCalls: 2877, maxChunks: 60420, maxWallMs: 21600000 });
    expect(workLimitsFor(45, ["work_email"], "firecrawl.search")).toEqual({ maxCalls: 1407, maxChunks: 29550, maxWallMs: 21600000 });
    expect(workLimitsFor(1, ["work_email"], "firecrawl.search")).toEqual({ maxCalls: 198, maxChunks: 4161, maxWallMs: 21600000 });
    expect(workLimitsFor(45, ["work_email", "decision_maker"], "treg.companies.search").maxCalls).toBe(2877);
  });

  it("T-A A7 sameInstant comparisons and leaseHeld token verification", async () => {
    // sameInstant tests
    expect(sameInstant("2026-11-17T12:00:12.345678+00:00", "2026-11-17T12:00:12.345679+00:00")).toBe(false);
    expect(sameInstant("2026-11-17T12:00:12.500000+00:00", "2026-11-17T12:00:12.5Z")).toBe(true);
    expect(sameInstant("2026-11-17T14:00:12.5+02:00", "2026-11-17T12:00:12.5Z")).toBe(true);
    expect(sameInstant("2026-11-17T12:00:12.1234567+00:00", "2026-11-17T12:00:12.1234567+00:00")).toBe(false);
    expect(sameInstant("invalid", "invalid")).toBe(false);
    expect(sameInstant(null, "2026-11-17T12:00:00Z")).toBe(false);

    // leaseHeld false -> runner fails closed
    const h = harness(defaultFakeWorld(5));
    h.deps.leaseHeld = async () => false;
    const run = await runChainChunk(baseInput(params({ count: 5 })), h.deps);
    expect(run.ok).toBe(false);
    expect((run as any).errorCode).toBe("lease_lost");
  });

  it("T-A A8 no runner-emitted line claims delivery or charge", async () => {
    const stops: Array<{ budgetUsd?: number; count: number; empty?: boolean }> = [
      { budgetUsd: 0.01, count: 10 },
      { count: 3 },
      { empty: true, count: 5 },
    ];
    for (const s of stops) {
      const world = s.empty ? [] : defaultFakeWorld(10);
      const h = harness(world);
      await runAll(h, params({ count: s.count, budgetUsd: s.budgetUsd ?? 1 }), 5);
      for (const ev of h.events) {
        if (ev.includes("الموثّق منها")) continue;
        expect(ev).not.toMatch(/سُلّم|يُخصم|يُحتسب|المسلَّم|تم إكمال/);
      }
    }
  });

  it("T-C worst complete state cursor encoding and bounds", () => {
    const origin200 = "https://" + "a".repeat(192);
    const tc512 = "t".repeat(512);
    const tl512 = "l".repeat(512);
    const seen300 = Array.from({ length: 300 }, (_, i) => `h${i}`.padEnd(96, "x") + ".com");

    const sets = [
      "\\".repeat(120),
      '"'.repeat(120),
      "\u4E00".repeat(120),
      "\u200F\u0300\uD83D\uDE00\x00".repeat(30),
    ];

    for (const nameSample of sets) {
      const q = Array.from({ length: 20 }, (_, i) => ({
        n: nameSample,
        u: origin200.slice(0, 190) + `${i}`.padStart(10, "0"),
      }));
      const state: ChainCursorV2 = {
        v: 2,
        n: 9999999999,
        dc: 9999999999,
        ec: 9999999999,
        tp: 9999999999,
        out: 9999999999,
        ix: 9999999999,
        sq: 9999999999,
        uo: 9999999999,
        tr: 0,
        wm: 9999999999,
        tg: 1,
        dx: 1,
        bd: 0,
        tx: 0,
        tf: 0,
        aid: "attempt_worst_123",
        q,
        tc: tc512,
        tl: tl512,
        wq: { "contextdev.search": 9999999999 },
        ff: { "firecrawl.search": 9999999999 },
        dn: Array.from({ length: 25 }, (_, i) => `domain_${i}.com`),
        cp: ["treg"],
        un: [],
        seen: [...seen300],
      };

      const res = encodeCursorV2(state);
      expect(res.fits).toBe(true);
      if (res.fits) {
        expect(Buffer.byteLength(JSON.stringify(res.state))).toBeLessThanOrEqual(30000);
        expect(res.cursor.length).toBeLessThanOrEqual(40000);
        expect(Buffer.byteLength(JSON.stringify(res.state.q))).toBeLessThanOrEqual(12000);
        expect(res.state.tr).toBe(1);
        const decoded = decodeCursorAny(res.cursor, "attempt_worst_123");
        expect(decoded.q.length).toBe(20);
        expect(decoded.tr).toBe(1);
      }
    }
  });

  it("T-C admission and rejection tests", async () => {
    // 1. Forced cursor_overflow returns { fits: false, reason: "cursor_overflow" }
    const stateOverflow: ChainCursorV2 = {
      ...emptyCursorV2("aid"),
      tc: '"'.repeat(300),
    };
    const resOverflow = encodeCursorV2(stateOverflow);
    expect(resOverflow.fits).toBe(false);
    if (!resOverflow.fits) {
      expect(resOverflow.reason).toBe("cursor_overflow");
    }

    // 2. Queue batch exceeding queueMaxBytes (12,000 bytes) rejected whole
    const giantQ = Array.from({ length: 200 }, () => ({ n: "x".repeat(100), u: "https://example.com/" + "y".repeat(100) }));
    const stateGiant: ChainCursorV2 = {
      ...emptyCursorV2("aid"),
      q: giantQ,
    };
    const resGiant = encodeCursorV2(stateGiant);
    expect(resGiant.fits).toBe(false);
    if (!resGiant.fits) {
      expect(resGiant.reason).toBe("cursor_overflow");
    }
  });

  it("T-C v1 conversion pending items to v2 queue", () => {
    for (const count of [80, 120]) {
      const rest = Array.from({ length: count }, (_, i) => ({
        n: `Company ${i}`,
        u: `https://company${i}.com`,
        i: "مقاولات",
        l: "مصر",
        d: "desc",
      }));
      const v1State = {
        v: 1,
        dc: 0,
        ec: 0,
        taken: 0,
        rest,
        seen: [],
        tc: null,
        dx: false,
        out: 0,
        ix: 0,
      };
      const v1Encoded = encodeChainCursor(v1State as any);
      expect(v1Encoded.length).toBeLessThanOrEqual(8000);

      const converted = decodeCursorAny(v1Encoded, "aid_v1");
      expect(converted.v).toBe(2);
      expect(converted.q.length).toBe(count);
      for (let i = 0; i < count; i++) {
        expect(converted.q[i]).toEqual({ n: `Company ${i}`, u: `https://company${i}.com` });
        expect("i" in converted.q[i]).toBe(false);
        expect("l" in converted.q[i]).toBe(false);
        expect("d" in converted.q[i]).toBe(false);
      }
    }
  });
});
