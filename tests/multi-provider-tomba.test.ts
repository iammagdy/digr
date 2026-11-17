import { vi } from "vitest";
import { runChainChunk, decodeCursorAny, type ChainDeps, type ChainChunkInput } from "../src/lib/server/multiProvider/chainRunner";
import { createFakeFetch, createFakeRobotsFetch, defaultFakeWorld, type FakeCompany, type FakeScenario } from "../src/lib/server/multiProvider/fakeTransport";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "../src/lib/server/tregAdapter";
import type { TregCallResult } from "../src/functions/shared/tregClient";
import { createMemoryRecorder } from "./helpers/multiProviderFakes";
import { routeCodeOf } from "../src/lib/multiProvider/routes";
/**
 * ALL fixtures in this file are SYNTHETIC (built from the catalog's trimmed example plus
 * ASSUMED element fields) and prove only the reader's fail-closed behaviour, NOT that Tomba
 * returns these fields.
 */

import { describe, expect, it } from "vitest";
import { readTombaMailbox, tombaAnswerKind } from "../src/lib/multiProvider/tregContacts";

function makeSyntheticFixture(domain: string, emailOverrides: Record<string, any> = {}) {
  return {
    meta: {
      params: { domain },
      total: 1,
    },
    data: {
      organization: {
        disposable: false,
        webmail: false,
        accept_all: false,
      },
      emails: [
        {
          email: `info@${domain}`,
          type: "generic",
          verification: { status: "valid" },
          ...emailOverrides,
        },
      ],
    },
  };
}

describe("T-E readTombaMailbox (synthetic fixtures)", () => {
  it("T-E accepted: valid role mailbox with generic type and valid verification is accepted", () => {
    const fixture = makeSyntheticFixture("fakeco1.net");
    const result = readTombaMailbox(fixture, "fakeco1.net");
    expect(result).toEqual({
      value: "info@fakeco1.net",
      status: "verified",
      evidence: "provider_listed",
    });
  });

  it("T-E status cases: missing, unknown, or invalid verification status results in MISS", () => {
    // Missing verification.status
    const missingStatus = makeSyntheticFixture("fakeco1.net", { verification: {} });
    expect(readTombaMailbox(missingStatus, "fakeco1.net")).toBeNull();

    const noVerification = makeSyntheticFixture("fakeco1.net", { verification: undefined });
    expect(readTombaMailbox(noVerification, "fakeco1.net")).toBeNull();

    // verification.status === "unknown"
    const unknownStatus = makeSyntheticFixture("fakeco1.net", { verification: { status: "unknown" } });
    expect(readTombaMailbox(unknownStatus, "fakeco1.net")).toBeNull();

    // verification.status === "invalid"
    const invalidStatus = makeSyntheticFixture("fakeco1.net", { verification: { status: "invalid" } });
    expect(readTombaMailbox(invalidStatus, "fakeco1.net")).toBeNull();
  });
it("T-E address rules: personal address, subdomains, other domain, personal domain, placeholder, masked, domain mismatch, and org flags result in MISS", () => {
    const domain = "fakeco1.net";

    // 1. Person's address (not generic type, not role mailbox)
    const person = makeSyntheticFixture(domain, { email: `john.doe@${domain}`, type: "personal" });
    expect(readTombaMailbox(person, domain)).toBeNull();

    // 2. Subdomain
    const subdomain = makeSyntheticFixture(domain, { email: `info@sub.${domain}` });
    expect(readTombaMailbox(subdomain, domain)).toBeNull();

    // 3. Another domain
    const anotherDomain = makeSyntheticFixture(domain, { email: "info@anotherdomain.com" });
    expect(readTombaMailbox(anotherDomain, domain)).toBeNull();

    // 4. Personal domain
    const personalDomain = makeSyntheticFixture("gmail.com", { email: "info@gmail.com" });
    expect(readTombaMailbox(personalDomain, "gmail.com")).toBeNull();

    // 5. Placeholder address
    // The ONE case that needs a placeholder DOMAIN (example.com is in PLACEHOLDER_DOMAINS, policy.ts): `email@<real domain>` is accepted by readTombaMailbox. Every other fixture of this file uses a real-looking domain, so that its null does not come from this rule.
    const placeholder = makeSyntheticFixture("example.com", { email: "email@example.com" });
    expect(readTombaMailbox(placeholder, "example.com")).toBeNull();

    // 6. Masked * address
    const masked = makeSyntheticFixture(domain, { email: `in*o@${domain}` });
    expect(readTombaMailbox(masked, domain)).toBeNull();

    // 7. meta.params.domain different
    const diffDomainFixture = makeSyntheticFixture("otherdomain.com");
    expect(readTombaMailbox(diffDomainFixture, domain)).toBeNull();

    // 8. accept_all true => MISS
    const acceptAll = makeSyntheticFixture(domain);
    acceptAll.data.organization.accept_all = true;
    expect(readTombaMailbox(acceptAll, domain)).toBeNull();

    // 9. webmail true => MISS
    const webmail = makeSyntheticFixture(domain);
    webmail.data.organization.webmail = true;
    expect(readTombaMailbox(webmail, domain)).toBeNull();

    // 10. disposable true => MISS
    const disposable = makeSyntheticFixture(domain);
    disposable.data.organization.disposable = true;
    expect(readTombaMailbox(disposable, domain)).toBeNull();
  });
it("T-E malformed shapes: invalid data types, large lists, prototype pollution, hidden fields and error bodies result in MISS", () => {
    const domain = "fakeco1.net";

    // 1. data.emails not an array
    const notArray = makeSyntheticFixture(domain);
    (notArray.data as any).emails = "not an array";
    expect(readTombaMailbox(notArray, domain)).toBeNull();

    // 2. elements not objects
    const notObjects = makeSyntheticFixture(domain);
    notObjects.data.emails = ["string_element", null, 12345] as any;
    expect(readTombaMailbox(notObjects, domain)).toBeNull();

    // 3. email not a string
    const emailNotString = makeSyntheticFixture(domain);
    (emailNotString.data.emails[0] as any).email = 12345;
    expect(readTombaMailbox(emailNotString, domain)).toBeNull();

    // 4. 5,000 elements
    const largeList = makeSyntheticFixture(domain);
    largeList.data.emails = Array.from({ length: 5000 }, (_, i) => ({
      email: `other_${i}@${domain}`,
      type: "personal",
      verification: { status: "invalid" },
    }));
    expect(readTombaMailbox(largeList, domain)).toBeNull();

    // 5. Prototype-pollution keys (__proto__, constructor)
    const jsonWithPollution = `{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"meta":{"params":{"domain":"${domain}"},"total":0},"data":{"organization":{"disposable":false,"webmail":false,"accept_all":false},"emails":[]}}`;
    const parsedPollution = JSON.parse(jsonWithPollution);
    expect(readTombaMailbox(parsedPollution, domain)).toBeNull();
    expect((Object.prototype as any).polluted).toBeUndefined();

    // 6. E-mail addresses hidden in other fields (description, sources, organization) are NOT read
    const hiddenInFields = makeSyntheticFixture(domain);
    hiddenInFields.data.emails = [];
    (hiddenInFields.data as any).description = `Contact support at info@${domain}`;
    (hiddenInFields.data as any).sources = [`https://${domain}/contact/info@${domain}`];
    (hiddenInFields.data.organization as any).email = `info@${domain}`;
    expect(readTombaMailbox(hiddenInFields, domain)).toBeNull();

    // 7. Malformed JSON and HTTP 200 with an error body => MISS (plus tombaAnswerKind checks)
    expect(readTombaMailbox(null, domain)).toBeNull();
    expect(readTombaMailbox("not json string", domain)).toBeNull();
    expect(readTombaMailbox({ error: "rate_limit_exceeded" }, domain)).toBeNull();

    expect(tombaAnswerKind(null)).toBe("unparsable");
    expect(tombaAnswerKind("malformed")).toBe("unparsable");
    expect(tombaAnswerKind({ error: "bad_request" })).toBe("unparsable");
    expect(tombaAnswerKind({ data: { emails: [] }, meta: { total: 0 } })).toBe("empty");
    expect(tombaAnswerKind({ data: { emails: [{ email: `info@${domain}` }] }, meta: { total: 1 } })).toBe("non_empty");
  });
interface Harness {
  deps: ChainDeps;
  events: string[];
  fetch: ReturnType<typeof createFakeFetch>;
  rec: ReturnType<typeof createMemoryRecorder>;
  tregCalls: number;
}

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

function chainHarness(world: FakeCompany[], scenario: FakeScenario = {}, opts: { caps?: any; keys?: ChainDeps["providerKeys"] } = {}): Harness {
  const events: string[] = [];
  const fetch = createFakeFetch(world, scenario);
  const rec = createMemoryRecorder(opts.caps ?? { treg: 50, firecrawl: 50, contextdev: 50 });
  const h: Harness = { events, fetch, rec, tregCalls: 0, deps: null as any };
  h.deps = {
    providerKeys: opts.keys ?? { treg: "managed", firecrawl: "fc-test-key-123456", contextdev: "cx-test-key-123456" },
    fetchFn: fetch,
    recorder: rec.recorder,
    robotsFetch: createFakeRobotsFetch(world),
    spentUsdSoFar: async () => rec.spent(),
    emit: async (line) => { events.push(line); },
    tregFn: async (_input: ProviderAdapterCallInput): Promise<ProviderAdapterCallOutput> => {
      h.tregCalls += 1;
      const rows = world.map((c) => ({ company_name: c.name, website: `https://${c.domain}`, industry: "مقاولات", country: "مصر" })).slice(0, 10);
      return { ok: true, httpStatus: 200, rows, nextCursor: null, costUsd: 0.00576, costMicro: 5760, tregCallId: "t" };
    },
    tregCall: async (options) => {
      if (options.endpointId === "icypeas.companies.search") {
        h.tregCalls += 1;
        const rows = world.map((c) => ({ company_name: c.name, website: `https://${c.domain}`, industry: "مقاولات", country: "مصر" })).slice(0, 10);
        return directoryAnswer(rows, null);
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

const baseInput = (params: Record<string, any>, over: Partial<ChainChunkInput> = {}): ChainChunkInput => {
  const count = params.count ?? 5;
  const budgetUsd = params.budgetUsd ?? 5;
  return {
    jobId: "job_x", userId: "u1", step: 0, endpointId: "mp", capabilitySlug: "mp-business-contacts", method: "POST", params, paginationStrategy: "cursor",
    cursor: null, pageSize: 10, remainingNeeded: count, targetVolumeMax: count, deliveredSoFar: 0, deadlineMs: Date.now() + 45_000,
    unitPricePoints: (budgetUsd * 5500) / (1.15 * count), claimLeaseUntil: "2026-11-17T12:00:00.000000+00:00", startIndex: 0, ...over,
  };
};

const chainParams = (over: Record<string, any> = {}) => ({
  routeCode: routeCodeOf("chain:treg>firecrawl"),
  budgetUsd: 5,
  industry: "مقاولات",
  country: "مصر",
  requiredFields: ["work_email"],
  count: 12,
  ...over,
});

  it("T-E fallback and breaker: billed MISS runs website fallback and increments wm; accepted lookup resets wm; 8 consecutive billed misses turns lookups off; no leak", async () => {
    const consoleLog = vi.spyOn(console, "log");
    const consoleWarn = vi.spyOn(console, "warn");
    const consoleInfo = vi.spyOn(console, "info");

    const world = defaultFakeWorld(25);
    const h = chainHarness(world, {}, {
      caps: { treg: 50, firecrawl: 50, contextdev: 50 },
    });

    let tombaLookupCount = 0;
    const scrapedDomains: string[] = [];
    const origFetch = h.deps.fetchFn;
    h.deps.fetchFn = async (url: string, init?: any) => {
      if (url.includes("/scrape")) {
        try {
          const body = JSON.parse(String(init?.body ?? "{}"));
          if (body.url) scrapedDomains.push(body.url);
        } catch {}
      }
      return origFetch(url, init);
    };

    const origTreg = h.deps.tregCall;
    h.deps.tregCall = async (options) => {
      if (options.endpointId === "tomba.companies.emails.list") {
        tombaLookupCount++;
        const domain = (options.params as any)?.domain;

        if (tombaLookupCount === 1) {
          // 1. First call: Billed MISS (returns valid response shape with no accepted mailbox, but billed 8900 micro)
          return {
            ok: true,
            httpStatus: 200,
            tregCallId: `t-${domain}`,
            costMicro: 8900,
            latencyMs: 5,
            data: {
              data: {
                organization: { disposable: false, webmail: false, accept_all: false },
                emails: [{ email: `person@${domain}`, type: "personal", verification: { status: "invalid" }, secret_field: "SECRET_LEAK_12345", phone: "+999111222" }],
              },
              meta: { params: { domain }, total: 1 },
            },
            isRouteMaxCost: false,
            isPlatformBalanceLow: false,
          };
        } else if (tombaLookupCount === 2) {
          // 2. Second call: Accepted lookup (resets wm to 0)
          return {
            ok: true,
            httpStatus: 200,
            tregCallId: `t-${domain}`,
            costMicro: 8900,
            latencyMs: 5,
            data: {
              data: {
                organization: { disposable: false, webmail: false, accept_all: false },
                emails: [{ email: `info@${domain}`, type: "generic", verification: { status: "valid" }, secret_field: "SECRET_LEAK_12345" }],
              },
              meta: { params: { domain }, total: 1 },
            },
            isRouteMaxCost: false,
            isPlatformBalanceLow: false,
          };
        } else {
          // 3. Subsequent calls: Billed MISSes (8 consecutive misses trigger the waste breaker)
          return {
            ok: true,
            httpStatus: 200,
            tregCallId: `t-${domain}`,
            costMicro: 8900,
            latencyMs: 5,
            data: {
              data: {
                organization: { disposable: false, webmail: false, accept_all: false },
                emails: [{ email: `unverified@${domain}`, type: "personal", verification: { status: "invalid" }, secret_field: "SECRET_LEAK_12345" }],
              },
              meta: { params: { domain }, total: 1 },
            },
            isRouteMaxCost: false,
            isPlatformBalanceLow: false,
          };
        }
      }
      return origTreg!(options);
    };

    // Run chunk 1: 1st company experiences billed MISS => website fallback runs and wm increments to 1
    const resChunk1 = await runChainChunk(baseInput(chainParams({ count: 12 }), { step: 0 }), h.deps);
    expect(resChunk1.ok).toBe(true);
    expect(tombaLookupCount).toBeGreaterThanOrEqual(1);
    expect(scrapedDomains.length).toBeGreaterThanOrEqual(1);

    // Run remaining chunks until breaker trips (8 consecutive misses)
    let cursor = resChunk1.nextCursor;
    let step = 1;
    while (cursor && step < 12 && tombaLookupCount < 15) {
      const nextChunk = await runChainChunk(baseInput(chainParams({ count: 12 }), { cursor, step }), h.deps);
      cursor = nextChunk.nextCursor;
      step++;
      if (!nextChunk.ok) break;
    }

    // Breaker verification: Lookups turned OFF after 8 consecutive billed misses
    expect(tombaLookupCount).toBe(10);

    if (cursor) {
      const state = decodeCursorAny(cursor, "aid_tomba");
      expect(state.wm).toBeGreaterThanOrEqual(8);
      expect(state.tg).toBe(1);
    }

    // Privacy verification: no non-allowlisted value is stored, logged or emitted
    for (const event of h.events) {
      expect(event).not.toContain("SECRET_LEAK_12345");
      expect(event).not.toContain("+999111222");
    }
    const allLogs = [
      ...consoleLog.mock.calls.map((c) => c.join(" ")),
      ...consoleWarn.mock.calls.map((c) => c.join(" ")),
      ...consoleInfo.mock.calls.map((c) => c.join(" ")),
    ].join(" ");
    expect(allLogs).not.toContain("SECRET_LEAK_12345");
    expect(allLogs).not.toContain("+999111222");

    consoleLog.mockRestore();
    consoleWarn.mockRestore();
    consoleInfo.mockRestore();
  });
});
