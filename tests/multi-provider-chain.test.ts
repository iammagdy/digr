import { describe, expect, it } from "vitest";
import { chainParamsOf, decodeChainCursor, encodeChainCursor, runChainChunk, type ChainDeps } from "../src/lib/server/multiProvider/chainRunner";
import { createFakeFetch, createFakeRobotsFetch, defaultFakeWorld, type FakeCompany, type FakeScenario } from "../src/lib/server/multiProvider/fakeTransport";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "../src/lib/server/tregAdapter";
import { createMemoryRecorder } from "./helpers/multiProviderFakes";
import { routeCodeOf } from "../src/lib/multiProvider/routes";
import { ALL_CUSTOMER_STRINGS } from "../src/lib/multiProvider/copy";
import { STATUS_VERIFIED_AR, ALLOWED_ROW_KEYS } from "../src/lib/multiProvider/policy";

interface Harness { deps: ChainDeps; events: string[]; fetch: ReturnType<typeof createFakeFetch>; rec: ReturnType<typeof createMemoryRecorder>; tregCalls: number }

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
  };
  return h;
}

/** `budgetUsd` is the provider-spend budget of the job: the worker passes the unit price, the reserve of which (/ 5,500) is the budget. */
const baseInput = (params: Record<string, any>, over: Partial<ProviderAdapterCallInput> = {}): ProviderAdapterCallInput => {
  const count = params.count ?? 5;
  const budgetUsd = params.budgetUsd ?? 1;
  return {
    jobId: "job_x", userId: "u1", step: 0, endpointId: "mp", capabilitySlug: "mp-business-contacts", method: "POST", params, paginationStrategy: "cursor",
    cursor: null, pageSize: 10, remainingNeeded: count, targetVolumeMax: count, deliveredSoFar: 0, deadlineMs: Date.now() + 45_000,
    unitPricePoints: (budgetUsd * 5500) / (1.15 * count), ...over,
  };
};

async function runAll(h: Harness, params: Record<string, any>, maxChunks = 12) {
  const rows: Record<string, any>[] = [];
  let cursor: string | null = null;
  let chunks = 0;
  let last: ProviderAdapterCallOutput | null = null;
  while (chunks < maxChunks) {
    last = await runChainChunk(baseInput(params, { cursor, step: chunks, remainingNeeded: Math.max(0, (params.count ?? 5) - rows.length), deliveredSoFar: rows.length }), h.deps);
    rows.push(...last.rows);
    chunks += 1;
    if (!last.ok || !last.nextCursor) break;
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
    expect(h.events.at(-1)).toContain("ولن يُخصم أي رصيد");
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
