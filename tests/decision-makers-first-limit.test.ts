import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Decision makers, the first-email limit, the one later read, and no paid profile-link first lookup (follow-up to PR #254): SIMULATION only. The real client
 * and adapter run; `fetch` is stubbed; the clock (`setTimeout`, `Date`) and the per-call time limit (`AbortSignal.timeout`) are faked together, so a call
 * that never answers is cut at exactly the limit the adapter gave it. The mail-server answer of each domain is injected.
 *   - a first lookup slower than PEOPLE_FIRST_EMAIL_LOOKUP_TIMEOUT_MS is cut at that limit; the check of a person already found still runs
 *   - a cut lookup gets at most ONE later read, with the same idempotency key, and only while the window leaves the verify minimum after it
 *   - a person with no company domain gets no paid email lookup (the profile link alone is never a first lookup); the phone lookup still runs
 *   - the spend ceiling holds with cut lookups and their later reads
 */
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()), getEndpointDetails: vi.fn(async () => null) }));
vi.mock("../src/lib/server/providerGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server/providerGate")>()),
  getLiveProviderGateStatus: () => ({ isReady: true, reasonCode: "ready", messageAr: "" }),
}));
vi.mock("../src/lib/server/providerKeys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server/providerKeys")>()),
  resolveProviderKey: vi.fn(async () => ({ key: "test-token-not-a-secret", source: "env", storeState: "absent" })),
}));

import {
  defaultTregAdapter,
  PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS,
  PEOPLE_FIRST_EMAIL_LOOKUP_TIMEOUT_MS,
  PEOPLE_FIRST_EMAIL_RETRY_MIN_MS,
  PEOPLE_LOOKUP_RESERVE_MS,
  PEOPLE_VERIFY_MIN_TIME_MS,
} from "../src/lib/server/tregAdapter";
import { setMailDomainResolverForTesting } from "../src/lib/server/mailDomainCheck";
import { decisionMakerJobSpendCeilingUsd } from "../src/lib/server/decisionMakerSpend";
import { WORKER_DISPATCH_TIMEOUT_MS } from "../src/lib/server/workerDispatch";

const PARAMS = { limit: 3, title: "CEO", country: "EG", keywords: ["information technology", "software", "technology"], requiredContactFields: ["work_email", "phone"], contactFieldsToAttempt: ["work_email", "phone"] };
const lead = (first: string, last: string, website = `https://${last.toLowerCase()}-soft.example`) => ({
  firstname: first, lastname: last, headline: "", description: "", profileUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}`, lastJobTitle: "CEO", lastJobDescription: "", lastJobStartDate: "2019-03",
  address: "Cairo, Egypt", lastCompanyName: `${last} Software`, lastCompanyUrl: "", lastCompanyWebsite: website, lastCompanyDescription: "Software and cloud technology", lastCompanySize: "11-50",
  lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt",
});
const answerOf = (leads: any[]) => ({ total: 2560, success: true, leads, pagination: { token: "next", size: leads.length } });

interface Call { endpoint: string; body: any; key: string; at: number; limitMs?: number; charged: number }
interface Scenario {
  leads: any[];
  /** Email lookups of these first names never answer: our limit cuts them. */
  stalled?: string[];
  /** Email lookups of these first names answer with a work address (the rest answer with no address). */
  found?: string[];
  deadlineMs?: number;
  wanted: number;
}

const limitOf = new WeakMap<AbortSignal, number>();
const realAbortTimeout = AbortSignal.timeout;

/** Runs the real adapter on a fake clock; every call is recorded with its time, idempotency key, limit and charge. */
async function run(scenario: Scenario) {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  const start = Date.now();
  const calls: Call[] = [];
  AbortSignal.timeout = ((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), ms);
    limitOf.set(controller.signal, ms);
    return controller.signal;
  }) as typeof AbortSignal.timeout;
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const endpoint = String(url).split("/call/")[1];
    const body = JSON.parse(String(init.body));
    const signal = init.signal as AbortSignal | undefined;
    const call: Call = { endpoint, body, key: String((init.headers as Record<string, string>)["Idempotency-Key"] ?? ""), at: Date.now() - start, limitMs: signal ? limitOf.get(signal) : undefined, charged: 0 };
    calls.push(call);
    if (endpoint === "treg.people.email.find" && scenario.stalled?.includes(body.first_name)) {
      signal?.addEventListener("abort", () => reject(signal.reason));
      return;
    }
    let out: any;
    let cost = 0;
    if (endpoint === "icypeas.people.search") { out = answerOf(scenario.leads); cost = 380; }
    else if (endpoint === "treg.people.email.find") {
      const found = scenario.found?.includes(body.first_name) ?? false;
      out = { output: { email: found ? `${String(body.first_name).toLowerCase()}@${body.domain}` : null, first_name: body.first_name, last_name: body.last_name }, _treg: { served_by: "p", tried: ["p"] } };
      cost = found ? 20_000 : 0;
    }
    else if (endpoint === "treg.people.email.verify") { out = { output: { status: "valid" }, _treg: { served_by: "contactout.people.email.verify", tried: ["contactout.people.email.verify"] } }; cost = 400; }
    else { out = { output: { phone: null }, _treg: { tried: ["p"] } }; cost = 0; }
    call.charged = cost;
    resolve(new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", "x-treg-call-id": `call_${calls.length}`, "x-treg-cost-micro": String(cost) } }));
  })));
  const deadlineMs = Date.now() + (scenario.deadlineMs ?? 45_000);
  const pending = defaultTregAdapter({
    jobId: "job_first_limit", userId: "user_first_limit", step: 0, endpointId: "treg.people.search", capabilitySlug: "professional-people-search", method: "POST" as const,
    params: PARAMS, paginationStrategy: "none" as const, cursor: null, pageSize: 3, remainingNeeded: scenario.wanted, targetVolumeMax: scenario.wanted, deliveredSoFar: 0,
    decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(scenario.wanted), deadlineMs,
  } as any);
  await vi.advanceTimersByTimeAsync(120_000);
  const result = await pending;
  return { result, calls, start };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  AbortSignal.timeout = realAbortTimeout;
});

describe("the timeline constants: the first lookups, the later read, and the limits that are not raised", () => {
  it("14 s for a first email; a check needs 6 s; the window closes at 33 s (45 s minus a 12 s reserve); the later read needs 4 s and leaves the check its 6 s", () => {
    expect(PEOPLE_FIRST_EMAIL_LOOKUP_TIMEOUT_MS).toBe(14_000);
    expect(PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS).toBe(25_000);
    expect(PEOPLE_VERIFY_MIN_TIME_MS).toBe(6_000);
    expect(PEOPLE_LOOKUP_RESERVE_MS).toBe(12_000);
    expect(PEOPLE_FIRST_EMAIL_RETRY_MIN_MS).toBe(4_000);
    const window = 45_000 - PEOPLE_LOOKUP_RESERVE_MS;
    expect(window).toBe(33_000);
    // a first step that runs to its limit leaves 19 s for the checks and phones, and a later read of at least 4 s after them still fits with a 6 s check
    expect(window - PEOPLE_FIRST_EMAIL_LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(PEOPLE_VERIFY_MIN_TIME_MS + PEOPLE_FIRST_EMAIL_RETRY_MIN_MS);
  });

  it("nothing is raised: the worker deadline is 45 s, maxDuration is 60 s, the dispatcher waits 55 s", () => {
    const route = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(route).toContain("const deadlineMs = routeStart + 45_000;");
    expect(route).toContain("export const maxDuration = 60;");
    expect(WORKER_DISPATCH_TIMEOUT_MS).toBe(55_000);
  });
});

describe("a first lookup slower than its limit is cut there; the check of a person already found still runs", () => {
  it("the stalled first email is cut at 14 s; the found person's check starts after the first step and is made; the stalled person gets ONE later read with the same key", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const { result, calls } = await run({
      leads: [lead("Alaa", "Alpha"), lead("Bassem", "Beta")],
      stalled: ["Bassem"], found: ["Alaa"], wanted: 2,
    });
    // the first emails run together, each with the first limit
    const firsts = calls.filter((call) => call.endpoint === "treg.people.email.find");
    expect(firsts.filter((call) => call.limitMs === PEOPLE_FIRST_EMAIL_LOOKUP_TIMEOUT_MS).length).toBeGreaterThanOrEqual(2);
    // Alaa's check is made, and it starts only after the cut at 14 s, with the verify minimum left
    const check = calls.find((call) => call.endpoint === "treg.people.email.verify")!;
    expect(check.body).toEqual({ email: "alaa@alpha-soft.example" });
    expect(check.at).toBeGreaterThanOrEqual(PEOPLE_FIRST_EMAIL_LOOKUP_TIMEOUT_MS);
    expect(check.at).toBeLessThanOrEqual(45_000 - PEOPLE_LOOKUP_RESERVE_MS - PEOPLE_VERIFY_MIN_TIME_MS);
    expect(result.rows.find((row) => row.work_email)).toMatchObject({ work_email: "alaa@alpha-soft.example", work_email_verification_status: "متحقق" });
    // Bassem: cut at 14 s, then ONE later read with the same key (no new charge), cut again by the limit it was given
    const bassem = calls.filter((call) => call.endpoint === "treg.people.email.find" && call.body.first_name === "Bassem");
    expect(bassem).toHaveLength(2);
    expect(new Set(bassem.map((call) => call.key)).size).toBe(1);
    expect(bassem[1].at).toBeGreaterThan(bassem[0].at);
    expect(bassem[1].limitMs!).toBeLessThanOrEqual(PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS);
    // the later read ends by 27 s (the window's 33 s minus the check's 6 s), so an address it finds can still be checked
    expect(bassem[1].at + bassem[1].limitMs!).toBeLessThanOrEqual(33_000 - PEOPLE_VERIFY_MIN_TIME_MS);
    expect(result.lookupLog!.summary).toMatchObject({ firstEmailCut: 1, firstEmailRetries: 1 });
    expect(result.lookupLog!.entries.find((entry) => entry.retry)).toMatchObject({ endpoint: "treg.people.email.find", outcome: "timeout", calls: 1, retry: true });
  });

  it("with the window closed before the step ends (the first limit uses it all), the cut person gets NO later read", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const { calls, result } = await run({ leads: [lead("Alaa", "Alpha"), lead("Bassem", "Beta")], stalled: ["Bassem"], found: ["Alaa"], wanted: 2, deadlineMs: 26_000 });
    const bassem = calls.filter((call) => call.endpoint === "treg.people.email.find" && call.body.first_name === "Bassem");
    expect(bassem).toHaveLength(1);
    expect(result.lookupLog!.entries.find((entry) => entry.retry)).toBeUndefined();
    expect(result.lookupLog!.summary.firstEmailCut).toBe(1);
    expect(result.lookupLog!.summary.firstEmailRetries ?? 0).toBe(0);
  });
});

describe("a person with no company domain gets no paid email lookup (the profile link alone is never a first lookup)", () => {
  it("the domain people's first lookups go out before any phone lookup; the no-domain person gets no email lookup and still gets the phone lookup", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const { calls, result } = await run({
      leads: [lead("Alaa", "Alpha"), lead("Bassem", "Beta"), lead("Carim", "Gamma", "")],
      wanted: 3,
    });
    const emails = calls.filter((call) => call.endpoint === "treg.people.email.find");
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((call) => Boolean(call.body.domain))).toBe(true);
    expect(emails.some((call) => call.body.first_name === "Carim")).toBe(false);
    const phones = calls.filter((call) => call.endpoint === "treg.people.phone.find");
    expect(phones.some((call) => call.body.first_name === "Carim")).toBe(true);
    // the first lookups (the company domain and the names; the profile-link fallbacks come after the phones) all start before the first phone lookup
    const firsts = emails.filter((call) => !call.body.linkedin_url);
    expect(firsts.length).toBe(2);
    expect(Math.max(...firsts.map((call) => call.at))).toBeLessThanOrEqual(Math.min(...phones.map((call) => call.at)));
    expect(result.lookupLog!.summary).toMatchObject({ linkOnlySkipped: 1 });
  });
});

describe("the spend ceiling holds with cut lookups and their later reads", () => {
  it("five people, wanted 3: two first lookups are cut and read once more, the total stays at or under 0.04 + 3 x 0.025 = 0.115 USD", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const { result, calls } = await run({
      leads: [lead("Alaa", "Alpha"), lead("Bassem", "Beta"), lead("Carim", "Gamma"), lead("Dina", "Delta"), lead("Elias", "Epsilon")],
      stalled: ["Bassem", "Elias"], found: ["Alaa", "Carim"], wanted: 3,
    });
    const ceiling = Math.round(decisionMakerJobSpendCeilingUsd(3) * 1e6);
    expect(result.costMicro).toBeLessThanOrEqual(ceiling);
    // what the calls were charged is what the job records (the cut calls billed nothing that we know of)
    expect(result.costMicro).toBe(calls.reduce((total, call) => total + call.charged, 0));
    // two people still needed after the checks: the cut ones are read again, Bassem once (its later read is cut too); the window does not leave time for Elias's
    expect(calls.filter((call) => call.endpoint === "treg.people.email.find" && call.body.first_name === "Bassem")).toHaveLength(2);
    expect(calls.filter((call) => call.endpoint === "treg.people.email.find" && call.body.first_name === "Elias").length).toBeLessThanOrEqual(2);
  });
});
