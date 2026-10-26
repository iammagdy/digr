import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Decision makers: the work-email lookup runs at the 0.02 USD ceiling (at 0.005 the gateway skipped the providers that find emails: 0 of 6 found; at
 * 0.02, 6 of 6), with its own 25 s limit, a 409 read as "still running", personal mailboxes refused, and the price of a work email at 120 points
 * (83 + 120 + 55 = 258 a person). The REAL client and adapter run against a stubbed `fetch` that answers like the gateway; nothing is paid.
 */
const seen = vi.hoisted(() => ({ options: [] as any[] }));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()), getEndpointDetails: vi.fn(async () => null) }));
vi.mock("../src/lib/server/providerGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server/providerGate")>()),
  getLiveProviderGateStatus: () => ({ isReady: true, reasonCode: "ready", messageAr: "" }),
}));
vi.mock("../src/lib/server/providerKeys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server/providerKeys")>()),
  resolveProviderKey: vi.fn(async () => ({ key: "test-token-not-a-secret", source: "env", storeState: "absent" })),
}));
// the real client, observed: the options of every outbound call (the limit and the ceiling) are kept
vi.mock("../src/functions/shared/tregClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/tregClient")>();
  return { ...actual, executeTregCall: vi.fn(async (options: any) => { seen.options.push(options); return actual.executeTregCall(options); }) };
});

import { defaultTregAdapter, executeTregCallWithReplay, isInFlightResult, PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS, PEOPLE_PHONE_LOOKUP_TIMEOUT_MS } from "../src/lib/server/tregAdapter";
import {
  createDecisionMakerSpendBudget, decisionMakerJobSpendCeilingUsd, DECISION_MAKER_EMAIL_ROUTE_COST_CAP_USD, DECISION_MAKER_PROVIDER_SPEND_CAP_USD,
  DECISION_MAKER_ROUTE_COST_CAP_USD, estimateDecisionMakerChunkSpendUsd, remainingDecisionMakerSpendUsd,
} from "../src/lib/server/decisionMakerSpend";
import { PERSONAL_EMAIL_DOMAINS, emailDomain, isPersonalEmail } from "../src/lib/peopleIdentity";
import {
  contactValueDelivered, decisionMakerChargePoints, decisionMakerDeliveredUnits, decisionMakerQuotePoints, DECISION_MAKER_UNIT_PRICES_POINTS,
} from "../src/functions/shared/decisionMakerPricing";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { computePublicCalculatorQuote } from "../src/lib/calculatorPricing";
import { estimateMission } from "../src/lib/missionEstimate";
import { PEOPLE_PRICE_POINTS, capacityForPoints } from "../src/lib/pricingPage";
import { buildResultFollowupReply } from "../src/functions/shared/resultFollowup";
import { CONTACT_EMAIL_BILLING_AR } from "../src/lib/contactExpectation";

const PARAMS = { limit: 3, title: "CEO", country: "EG", keywords: ["information technology", "software", "technology"], requiredContactFields: ["work_email", "phone"], contactFieldsToAttempt: ["work_email", "phone"] };
const lead = (extra: Record<string, any>) => ({
  firstname: "", lastname: "", headline: "", description: "", profileUrl: "", lastJobTitle: "CEO", lastJobDescription: "", lastJobStartDate: "2019-03",
  address: "Cairo, Egypt", lastCompanyName: "", lastCompanyUrl: "", lastCompanyWebsite: "", lastCompanyDescription: "Software and cloud technology", lastCompanySize: "11-50",
  lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt", ...extra,
});
const NAMES: Array<[string, string]> = [["Mohamed", "Shoukry"], ["Rania", "Ayman"], ["Mohammed", "Mahjoub"], ["Rasha", "Azhry"], ["Omar", "Hassan"], ["Salma", "Farid"], ["Karim", "Nabil"], ["Hana", "Gad"], ["Youssef", "Adel"]];
const LEADS = NAMES.map(([firstname, lastname], at) => lead({
  firstname, lastname, profileUrl: `https://www.linkedin.com/in/${firstname.toLowerCase()}-${lastname.toLowerCase()}-${at}`,
  lastCompanyName: `${lastname} Software`, lastCompanyWebsite: `https://${lastname.toLowerCase()}-soft.example`,
}));
const SEARCH_ANSWER = { total: 2560, success: true, leads: LEADS, pagination: { token: "next", size: 9 } };

interface Call { endpoint: string; body: any; headers: Record<string, string> }
type Answer = { cost?: number; originalCost?: number; body: any; status?: number };

/** The gateway as the client sees it: a Response with the cost in a header and the answer in `{output, _treg}`. */
function gateway(handler: (call: Call, attempt: number) => Answer) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const call: Call = { endpoint: String(url).split("/call/")[1], body: JSON.parse(String(init.body)), headers: { ...(init.headers as Record<string, string>) } };
    calls.push(call);
    const key = call.headers["Idempotency-Key"] || `${call.endpoint}:${calls.length}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const out = handler(call, attempt);
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json", "x-treg-call-id": `call_${calls.length}`, "x-treg-cost-micro": String(out.cost ?? 0), ...(out.originalCost ? { "x-treg-original-cost-micro": String(out.originalCost) } : {}) },
    });
  }));
  return calls;
}
const isSearch = (call: Call) => call.endpoint === "icypeas.people.search";
const isEmail = (call: Call) => call.endpoint === "treg.people.email.find";
const isPhone = (call: Call) => call.endpoint === "treg.people.phone.find";
const emailAnswer = (call: Call, address?: string): Answer => ({
  cost: 20000, body: { output: { email: address ?? `${String(call.body.first_name).toLowerCase()}@${String(call.body.domain).toLowerCase()}`, first_name: call.body.first_name, last_name: call.body.last_name }, _treg: { served_by: "provider-a", tried: ["provider-a"] } },
});
const missAnswer = (call: Call): Answer => ({ cost: 0, body: { output: isEmail(call) ? { email: null } : { phone: null }, _treg: { served_by: "provider-a", tried: ["provider-a", "provider-b"] } } });

const input = (extra: Record<string, any> = {}) => ({
  jobId: "job_quote_email_cap", userId: "user_email_cap", step: 0, endpointId: "treg.people.search", capabilitySlug: "professional-people-search", method: "POST" as const,
  params: PARAMS, paginationStrategy: "none" as const, cursor: null, pageSize: 3, remainingNeeded: 3, targetVolumeMax: 3, deliveredSoFar: 0, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(3), ...extra,
});

/** The wait before a read is a timer: the test lets it pass at once (only `setTimeout` is faked, `Date.now` stays real). */
async function withFastWaits<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    const pending = run();
    await vi.advanceTimersByTimeAsync(150_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => { seen.options = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("(1) the work-email lookup is sent at the 0.02 ceiling; the search and the phone lookups keep 0.005", () => {
  it("the named constants", () => {
    expect(DECISION_MAKER_EMAIL_ROUTE_COST_CAP_USD).toBe(0.02);
    expect(DECISION_MAKER_ROUTE_COST_CAP_USD).toBe(0.005);
  });

  it("through the real client: X-Treg-Route-Max-Cost is 0.02 for treg.people.email.find ONLY, 0.005 for the search and for treg.people.phone.find", async () => {
    const calls = gateway((call) => (isSearch(call) ? { cost: 3420, body: SEARCH_ANSWER } : missAnswer(call)));
    await defaultTregAdapter(input() as any);
    expect(calls.some(isSearch) && calls.some(isEmail) && calls.some(isPhone)).toBe(true);
    for (const call of calls) expect(call.headers["X-Treg-Route-Max-Cost"], call.endpoint).toBe(isEmail(call) ? "0.02" : "0.005");
  });

  it("the people are looked up best identity first, together (at most three at a time): the emails of a group, then its phones", async () => {
    let live = 0;
    let peak = 0;
    const order: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const endpoint = String(url).split("/call/")[1];
      order.push(endpoint);
      live += 1; peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      const body = endpoint === "icypeas.people.search" ? SEARCH_ANSWER : { output: endpoint.includes("email") ? { email: null } : { phone: null } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-treg-cost-micro": endpoint === "icypeas.people.search" ? "3420" : "0" } });
    }));
    await defaultTregAdapter(input({ remainingNeeded: 3 }) as any);
    expect(peak).toBe(3);
    // the first group: the three emails together (company domain and names), then the profile-link fallback of each after its miss, then the three phones
    expect(order.slice(0, 10)).toEqual(["icypeas.people.search", ...Array(3).fill("treg.people.email.find"), ...Array(3).fill("treg.people.email.find"), ...Array(3).fill("treg.people.phone.find")]);
  });
});

describe("(2) the job's spend never passes its ceiling: 0.04 + (0.02 + 0.005) x people", () => {
  it("the ceiling formula: 1 person 0.065, 3 people 0.115, 10 people 0.29 USD (the 0.005 is the deliverability check of each person's email); never unbounded (it grows with the people asked for only)", () => {
    expect(DECISION_MAKER_PROVIDER_SPEND_CAP_USD).toBe(0.04);
    expect([1, 3, 10, 30].map(decisionMakerJobSpendCeilingUsd)).toEqual([0.065, 0.115, 0.29, 0.79]);
    expect(decisionMakerJobSpendCeilingUsd(0)).toBe(0.065);
    expect(decisionMakerJobSpendCeilingUsd(Number.NaN)).toBe(0.065);
    // the daily provider cap and the capacity gate reserve this worst case for the chunk
    expect(estimateDecisionMakerChunkSpendUsd(3)).toBe(0.115);
    expect(remainingDecisionMakerSpendUsd(0.025, decisionMakerJobSpendCeilingUsd(3))).toBeCloseTo(0.09);
    const route = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(route).toContain("remainingDecisionMakerSpendUsd(await readDecisionMakerSpendToDate(adminClient, jobId), decisionMakerJobSpendCeilingUsd(targetMax))");
    expect(route).toContain("estimateDecisionMakerChunkSpendUsd(");
  });

  it("every email bills the whole 0.02 and every phone 0.005 (nothing found): the three people asked for are looked up, and the job spends at most 0.115", async () => {
    const costs: number[] = [];
    const calls = gateway((call) => {
      const cost = isSearch(call) ? 3420 : isEmail(call) ? 20000 : 5000;
      costs.push(cost);
      return { cost, body: isSearch(call) ? SEARCH_ANSWER : { output: isEmail(call) ? { email: null } : { phone: null }, _treg: { tried: ["provider-b"] } } };
    });
    const result = await defaultTregAdapter(input() as any);
    const spent = costs.reduce((total, cost) => total + cost, 0);
    expect(result.costMicro).toBe(spent);
    expect(spent).toBeLessThanOrEqual(Math.round(decisionMakerJobSpendCeilingUsd(3) * 1e6));
    expect(calls.filter(isEmail).length).toBeGreaterThanOrEqual(3);
    expect(result.lookupLog!.summary.skippedBudget).toBeGreaterThan(0);
  });

  it("every email bills 0.02 AND is found: only the people still needed are looked up (3), the spend is 3 x 0.02 + the search", async () => {
    const calls = gateway((call) => (isSearch(call) ? { cost: 3420, body: SEARCH_ANSWER } : isEmail(call) ? emailAnswer(call) : missAnswer(call)));
    const result = await defaultTregAdapter(input() as any);
    expect(calls.filter(isEmail)).toHaveLength(3);
    expect(result.costMicro).toBe(3420 + 3 * 20000);
    expect(result.lookupLog!.summary).toMatchObject({ withContact: 3, skippedEnough: 6, skippedBudget: 0 });
    expect(result.rows.filter((row) => row.work_email).length).toBe(3);
  });

  it("the budget: an email reserves its own 0.02, a miss gives it back, a call with no answer yet keeps its reservation, and a search read (3 reservations) keeps only the first", () => {
    const budget = createDecisionMakerSpendBudget(0.05);
    expect(budget.reserveCall(0.02)).toBe(true);
    expect(budget.remainingUsd()).toBeCloseTo(0.03);
    budget.settleCall({ actualMicros: 0, costKnown: true, capUsd: 0.02 });
    expect(budget.remainingUsd()).toBeCloseTo(0.05);
    // a call and two reads (3 reservations): the answer is still in flight, so the source may have billed the first call
    for (let i = 0; i < 3; i++) expect(budget.reserveCall(0.01)).toBe(true);
    budget.settleCall({ calls: 3, actualMicros: 0, costKnown: false, capUsd: 0.01 });
    expect(budget.remainingUsd()).toBeCloseTo(0.04);
    expect(budget.reserveCall(0.05)).toBe(false);
  });
});

describe("(3) the work email waits up to 25 s, the phone 12 s; the worker's deadline is respected", () => {
  it("25 s for the email and 12 s for the phone (and the search keeps its own limit)", async () => {
    expect(PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS).toBe(25_000);
    expect(PEOPLE_PHONE_LOOKUP_TIMEOUT_MS).toBe(12_000);
    gateway((call) => (isSearch(call) ? { cost: 3420, body: SEARCH_ANSWER } : missAnswer(call)));
    await defaultTregAdapter(input({ deadlineMs: Date.now() + 100_000 }) as any);
    const timeouts = new Set(seen.options.filter((options) => options.endpointId === "treg.people.email.find").map((options) => options.timeoutMs));
    expect([...timeouts]).toEqual([25_000]);
    expect(new Set(seen.options.filter((options) => options.endpointId === "treg.people.phone.find").map((options) => options.timeoutMs))).toEqual(new Set([12_000]));
    expect(seen.options.find((options) => options.endpointId === "icypeas.people.search").timeoutMs).toBe(20_000);
  });

  it("a lookup never waits longer than the deadline leaves (minus 6 s kept for saving), and none starts with less than 3 s", async () => {
    gateway((call) => (isSearch(call) ? { cost: 3420, body: SEARCH_ANSWER } : missAnswer(call)));
    // 20 s left: the email gets 20 - 6 = 14 s (and the search, which runs first, spends a little of it)
    await defaultTregAdapter(input({ deadlineMs: Date.now() + 20_000 }) as any);
    const emailLimits = seen.options.filter((options) => options.endpointId === "treg.people.email.find").map((options) => options.timeoutMs);
    expect(emailLimits.length).toBeGreaterThan(0);
    for (const limit of emailLimits) { expect(limit).toBeLessThanOrEqual(14_000); expect(limit).toBeGreaterThan(10_000); }
    seen.options = [];
    const calls = gateway((call) => (isSearch(call) ? { cost: 3420, body: SEARCH_ANSWER } : missAnswer(call)));
    const result = await defaultTregAdapter(input({ deadlineMs: Date.now() + 8_000 }) as any);
    expect(calls.filter((call) => !isSearch(call))).toHaveLength(0);
    expect(result.lookupLog!.summary.skippedTime).toBeGreaterThan(0);
  });
});

describe("(4) HTTP 409 is «still running», never a failure and never a second charge", () => {
  it("the first call has no answer yet (409): after a wait the same key is read, the answer is delivered, and the call is charged ONCE", async () => {
    const calls = gateway((call, attempt) => {
      if (isSearch(call)) return { cost: 3420, body: SEARCH_ANSWER };
      if (isEmail(call) && attempt === 1) return { status: 409, body: { error: "in_flight" } };
      if (isEmail(call)) return { cost: 0, originalCost: 20000, ...{ body: emailAnswer(call).body } }; // the replay: cost 0, the first call's charge in the original-cost header
      return missAnswer(call);
    });
    const result = await withFastWaits(() => defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1), deadlineMs: Date.now() + 100_000 }) as any));
    expect(result.ok).toBe(true);
    const emailCalls = calls.filter(isEmail);
    expect(emailCalls.length).toBe(2); // one lookup: the call and its read, same idempotency key
    expect(emailCalls[1].headers["Idempotency-Key"]).toBe(emailCalls[0].headers["Idempotency-Key"]);
    expect(result.rows.filter((row) => row.work_email)).toHaveLength(1);
    expect(result.costMicro).toBe(3420 + 20000); // charged once, not 2 x 20000
    const entry = result.lookupLog!.entries.find((e) => e.endpoint === "treg.people.email.find")!;
    expect(entry).toMatchObject({ outcome: "hit", calls: 2, status: 200 });
  });

  it("still 409 after the reads: the outcome is «timeout», the job does not fail, nothing extra is charged, and the log says calls: 3", async () => {
    const calls = gateway((call) => (isSearch(call) ? { cost: 3420, body: SEARCH_ANSWER } : isEmail(call) ? { status: 409, body: { error: "in_flight" } } : missAnswer(call)));
    const result = await withFastWaits(() => defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1), deadlineMs: Date.now() + 100_000 }) as any));
    expect(result.ok).toBe(true);
    const entry = result.lookupLog!.entries.find((e) => e.endpoint === "treg.people.email.find")!;
    expect(entry).toMatchObject({ outcome: "timeout", status: 409, calls: 3 });
    expect(calls.filter(isEmail).length).toBeGreaterThanOrEqual(3);
    expect(result.costMicro).toBe(3420);
  });

  it("with no time left for a read the lookup ends as «timeout» after ONE call (no blind replay)", async () => {
    gateway((call) => (isSearch(call) ? { cost: 3420, body: SEARCH_ANSWER } : isEmail(call) ? { status: 409, body: { error: "in_flight" } } : missAnswer(call)));
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1), deadlineMs: Date.now() + 11_000 }) as any);
    const entry = result.lookupLog!.entries.find((e) => e.endpoint === "treg.people.email.find")!;
    expect(entry).toMatchObject({ outcome: "timeout", calls: 1 });
    expect(result.ok).toBe(true);
  });

  it("the helper: a call our limit cut is read after a wait (never at once), a 409 gets one more read, a refusal is never read again", async () => {
    const sleeps: number[] = [];
    const script = [{ ok: false, httpStatus: 503, timedOut: true }, { ok: false, httpStatus: 409 }, { ok: false, httpStatus: 409 }];
    let at = 0;
    const real = await import("../src/functions/shared/tregClient");
    const spy = vi.mocked(real.executeTregCall);
    spy.mockImplementation(async () => script[at++] as any);
    try {
      const out = await executeTregCallWithReplay({ endpointId: "treg.people.email.find", method: "POST", params: {}, userId: "u", jobId: "j", stepId: "s", page: 1, timeoutMs: 25_000 }, { sleep: async (ms) => { sleeps.push(ms); } });
      expect(out.calls).toBe(3);
      expect(sleeps).toEqual([4_000, 3_000]);
      expect(sleeps[0]).toBeGreaterThanOrEqual(3_000);
      at = 0; sleeps.length = 0;
      script.splice(0, 3, { ok: false, httpStatus: 422 } as any);
      expect((await executeTregCallWithReplay({ endpointId: "x", method: "POST", params: {}, userId: "u", jobId: "j", stepId: "s", page: 1 }, { sleep: async (ms) => { sleeps.push(ms); } })).calls).toBe(1);
      expect(sleeps).toEqual([]);
      expect([{ ok: false, timedOut: true, httpStatus: 503 }, { ok: false, httpStatus: 409 }].map(isInFlightResult)).toEqual([true, true]);
      expect([{ ok: true, httpStatus: 200 }, { ok: false, httpStatus: 402 }, { ok: false, httpStatus: 502 }].map(isInFlightResult)).toEqual([false, false, false]);
    } finally {
      spy.mockImplementation(async (options: any) => { seen.options.push(options); return (await vi.importActual<typeof import("../src/functions/shared/tregClient")>("../src/functions/shared/tregClient")).executeTregCall(options); });
    }
  });
});

describe("(5) a personal mailbox is not a work email: not delivered, not charged, not logged", () => {
  it("the list and its regional variants; company domains are never caught", () => {
    for (const address of ["a@gmail.com", "a@yahoo.com", "a@outlook.com", "a@hotmail.com", "a@live.com", "a@icloud.com", "a@aol.com", "a@proton.me", "a@protonmail.com", "a@gmx.com", "a@mail.com", "a@yandex.com",
      "a@yahoo.co.uk", "a@hotmail.fr", "a@outlook.sa", "a@live.com.au", "a@gmx.de", "a@yandex.ru", "A@GMAIL.COM", " a@Yahoo.com "]) {
      expect(isPersonalEmail(address), address).toBe(true);
    }
    for (const address of ["ceo@delta-soft.example", "a@gmail.company.com", "a@mygmail.com", "a@yahoo.company.com", "a@outlook.example.org", "not an address", "", undefined, null]) {
      expect(isPersonalEmail(address), String(address)).toBe(false);
    }
    expect(PERSONAL_EMAIL_DOMAINS).toEqual(expect.arrayContaining(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com"]));
    expect(emailDomain("Someone@Delta-Soft.example")).toBe("delta-soft.example");
  });

  it("a personal address is not delivered and not charged; a work address on a company domain is", () => {
    expect(contactValueDelivered({ work_email: "mona@gmail.com" }, "work_email")).toBe(false);
    expect(contactValueDelivered({ work_email: "mona@delta-soft.example" }, "work_email")).toBe(true);
    const rows = [{ work_email: "a@yahoo.com", phone: "" }, { work_email: "b@delta-soft.example", phone: "" }];
    expect(decisionMakerDeliveredUnits(rows, ["work_email", "phone"])).toEqual({ baseUnits: 1, emailUnits: 1, phoneUnits: 0 });
    expect(decisionMakerChargePoints(decisionMakerDeliveredUnits([rows[0]], ["work_email", "phone"]), DECISION_MAKER_UNIT_PRICES_POINTS)).toBe(0);
  });

  it("through the adapter: the lookup finds only a personal address: outcome «personal_email», the row has no work email, the log holds no address", async () => {
    gateway((call) => (isSearch(call) ? { cost: 3420, body: SEARCH_ANSWER } : isEmail(call) ? emailAnswer(call, "mona.private@gmail.com") : missAnswer(call)));
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1) }) as any);
    const entry = result.lookupLog!.entries.find((e) => e.endpoint === "treg.people.email.find")!;
    expect(entry).toMatchObject({ outcome: "personal_email", emailPresent: false });
    expect(result.rows.every((row) => row.work_email === "")).toBe(true);
    const kept = JSON.stringify(result.lookupLog);
    // only the mailbox DOMAIN of the discarded address is kept (see tests/decision-makers-smart-lookups.test.ts), never the address
    expect(entry.mailboxDomain).toBe("gmail.com");
    for (const secret of ["mona.private", "@"]) expect(kept, secret).not.toContain(secret);
    // a person with no other contact value goes to review as before (and is not charged)
    const verdicts = result.rows.map((row) => evaluateResearchRowRelevance(row, { capabilitySlug: "professional-people-search", endpointId: "treg.people.search", params: PARAMS }));
    expect(verdicts.filter((verdict) => verdict.decision === "match")).toEqual([]);
    expect(verdicts.some((verdict) => verdict.reasonCode === "no_contact")).toBe(true);
    expect(decisionMakerChargePoints(decisionMakerDeliveredUnits(result.rows, ["work_email", "phone"]), DECISION_MAKER_UNIT_PRICES_POINTS)).toBe(0);
  });

  it("a personal address on a person who also has an office phone: the phone is delivered and charged, the email is not", async () => {
    gateway((call) => {
      if (isSearch(call)) return { cost: 3420, body: SEARCH_ANSWER };
      if (isEmail(call)) return emailAnswer(call, "x@outlook.com");
      return { cost: 5000, body: { output: { phone: "+20 2 3333 4444" } } };
    });
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1) }) as any);
    const first = result.rows[0];
    expect(first.work_email).toBe("");
    expect(first.phone).not.toBe("");
    expect(decisionMakerDeliveredUnits([first], ["work_email", "phone"])).toEqual({ baseUnits: 1, emailUnits: 0, phoneUnits: 1 });
  });
});

describe("(6) one price source: 83 + 120 + 55 = 258 in the quote writer, the calculator, the estimate and the pages", () => {
  it("the shared constants and the arithmetic", () => {
    expect(DECISION_MAKER_UNIT_PRICES_POINTS).toEqual({ basePerson: 83, workEmail: 120, phone: 55 });
    const perPerson = 83 + 120 + 55;
    expect(perPerson).toBe(258);
    // the reserve of three people is ceil(3 x 258 x 1.15) = 891, under the job cap of 25,000
    expect(decisionMakerQuotePoints(3, ["work_email", "phone"], DECISION_MAKER_UNIT_PRICES_POINTS, 0.15, 25_000)).toBe(891);
    expect(Math.ceil(3 * 258 * 1.15)).toBe(891);
    // 3 people, 3 work emails, 1 phone: 3 x 83 + 3 x 120 + 1 x 55 = 664, never above the reserve
    const charge = decisionMakerChargePoints({ baseUnits: 3, emailUnits: 3, phoneUnits: 1 }, DECISION_MAKER_UNIT_PRICES_POINTS, 25_000);
    expect(charge).toBe(3 * 83 + 3 * 120 + 1 * 55);
    expect(charge).toBe(664);
    expect(charge).toBeLessThanOrEqual(891);
    // the field is charged only when it is delivered
    expect(decisionMakerChargePoints({ baseUnits: 3, emailUnits: 0, phoneUnits: 3 }, DECISION_MAKER_UNIT_PRICES_POINTS, 25_000)).toBe(3 * 83 + 3 * 55);
    expect(decisionMakerChargePoints({ baseUnits: 0, emailUnits: 0, phoneUnits: 0 }, DECISION_MAKER_UNIT_PRICES_POINTS, 25_000)).toBe(0);
  });

  it("the calculator, the estimate and the public pages read the same prices", () => {
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    expect(computePublicCalculatorQuote("professional-people-search", 3, 3).unitPricePoints).toBe(258);
    const estimate: any = estimateMission({ kind: "people", volume: 3 });
    expect(estimate.unitPricePoints).toBe(258);
    expect(estimate.reservePoints).toBe(891);
    expect(PEOPLE_PRICE_POINTS).toEqual({ basePerson: 83, workEmail: 120, phone: 55 });
    expect(capacityForPoints(25_800).find((line) => line.id === "people")!.records).toBe(100);
  });

  it("the assistant's offer names the 120 for the work email and the same totals", () => {
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    const quote = { items: [{ capabilitySlug: "company-research", endpointId: "icypeas.companies.search", targetVolumeMax: 3 }], targetVolumeMax: 3 };
    const reply = buildResultFollowupReply("الايميلات مش متاحه بردو", [
      { role: "user", content: "عايز ٣ شركات كهرباء في مصر", requestStatus: "accepted" },
      { role: "assistant", content: "خطة", quote },
      { role: "assistant", content: "تم إكمال استخراج ٣ شركات وحفظ ملف النتيجة." },
    ] as any, { platforms: ["companies"], targetVolume: 3 })!;
    expect(reply).toContain("١٢٠ للبريد المهني");
    expect(reply).toContain("السعر المتوقع ٧٧٤ نقطة");
    expect(reply).toContain("الحجز المتوقع ٨٩١ نقطة");
  });
});

describe("(7) the plan card says the work email is charged only when delivered", () => {
  it("one short Arabic sentence, no digits and no Latin letters, shown on the card and in the plan text", () => {
    expect(CONTACT_EMAIL_BILLING_AR).toBe("يُحتسب سعر البريد المهني فقط عند تسليمه فعلًا.");
    expect(/[A-Za-z0-9]/.test(CONTACT_EMAIL_BILLING_AR)).toBe(false);
    expect(readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8")).toContain("{CONTACT_AVAILABILITY_AR} {CONTACT_EMAIL_BILLING_AR}");
    const handler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    expect(handler.match(/CONTACT_EMAIL_BILLING_AR/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
