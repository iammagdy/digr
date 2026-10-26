import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Decision makers, the lookups (PR #253, preview of 2026-10-26): four jobs billed 0 for their lookups and delivered nobody. Only about 3 of 9 people
 * were looked up (every lookup kept the whole 0.005 reservation even when it billed 0), the company domain was taken from link-in-bio and social
 * pages, and nothing recorded what a lookup did. The REAL client and adapter run against a stubbed `fetch` that answers like the gateway
 * (`X-Treg-Cost-Micro`, `{output, _treg}`); no network, nothing paid.
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

import { defaultTregAdapter } from "../src/lib/server/tregAdapter";
import { createDecisionMakerSpendBudget, DECISION_MAKER_PROVIDER_SPEND_CAP_USD } from "../src/lib/server/decisionMakerSpend";
import { NON_COMPANY_HOSTS, buildPeopleIdentity, companyDomainFromWebsite, identityScore, returnedPersonMatches, splitFullName } from "../src/lib/peopleIdentity";
import { isCustomerVisibleJobEvent, LOOKUP_LOG_EVENT_TYPE } from "../src/lib/reviewCostEvent";

const PARAMS = { limit: 3, title: "CEO", country: "EG", keywords: ["information technology", "software", "technology"], requiredContactFields: ["work_email", "phone"], contactFieldsToAttempt: ["work_email", "phone"] };

/** A lead with exactly the fields of the direct source's answer. */
const lead = (extra: Record<string, any>) => ({
  firstname: "", lastname: "", headline: "", description: "", profileUrl: "", lastJobTitle: "CEO", lastJobDescription: "", lastJobStartDate: "2019-03",
  address: "Cairo, Egypt", lastCompanyName: "", lastCompanyUrl: "", lastCompanyWebsite: "", lastCompanyDescription: "Software and cloud technology", lastCompanySize: "11-50",
  lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt", ...extra,
});
const NAMES: Array<[string, string]> = [["Mohamed", "Shoukry"], ["Rania", "Ayman"], ["Mohammed", "Mahjoub"], ["Rasha", "El-Azhry"], ["Omar", "Hassan"], ["Salma", "Farid"], ["Karim", "Nabil"], ["Hana", "Gad"], ["Youssef", "Adel"]];
const WEBSITES = ["http://www.talentstailor.com", "https://linktr.ee/niletech", "https://www.linkedin.com/services/mahjoub", "", "https://delta-soft.example", "https://in.linkedin.com/company/x", "https://www.instagram.com/horus", "https://sphinx-soft.example", "https://bit.ly/abc"];
const LEADS = NAMES.map(([firstname, lastname], at) => lead({
  firstname, lastname, profileUrl: `https://www.linkedin.com/in/${firstname.toLowerCase()}-${lastname.toLowerCase()}-${at}`,
  lastCompanyName: `${lastname} Software`, lastCompanyWebsite: WEBSITES[at],
}));
const SEARCH_ANSWER = { total: 2560, success: true, leads: LEADS, pagination: { token: "next", size: 9 } };

interface Call { endpoint: string; body: any; headers: Record<string, string> }

/** The gateway as the client sees it: a Response with the cost in a header and the answer in `{output, _treg}`. */
function gateway(handler: (call: Call) => { cost?: number; body: any; status?: number }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const call: Call = { endpoint: String(url).split("/call/")[1], body: JSON.parse(String(init.body)), headers: { ...(init.headers as Record<string, string>) } };
    calls.push(call);
    const out = handler(call);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { "content-type": "application/json", "x-treg-call-id": `call_${calls.length}`, "x-treg-cost-micro": String(out.cost ?? 0) } });
  }));
  return calls;
}
const searchOnly = (call: Call) => call.endpoint === "icypeas.people.search";
const miss = (call: Call) => ({ cost: 0, body: { output: call.endpoint.includes("email") ? { email: null } : { phone: null }, _treg: { served_by: "provider-a", tried: ["provider-a", "provider-b"] } } });

const input = (extra: Record<string, any> = {}) => ({
  jobId: "job_quote_lookups", userId: "user_lookups", step: 0, endpointId: "treg.people.search", capabilitySlug: "professional-people-search", method: "POST" as const,
  params: PARAMS, paginationStrategy: "none" as const, cursor: null, pageSize: 3, remainingNeeded: 9, targetVolumeMax: 9, deliveredSoFar: 0, decisionMakerSpendBudgetUsd: DECISION_MAKER_PROVIDER_SPEND_CAP_USD, ...extra,
});
const spentMicro = (costs: number[]) => costs.reduce((total, cost) => total + cost, 0);

afterEach(() => { vi.unstubAllGlobals(); });

describe("(a) a miss bills 0 and gives its reservation back: every person is looked up inside the job ceiling", () => {
  it("9 people, every lookup a free miss: 18 lookups after the search, all 9 people looked up, the job still billed only the search", async () => {
    const calls = gateway((call) => (searchOnly(call) ? { cost: 3420, body: SEARCH_ANSWER } : miss(call)));
    const result = await defaultTregAdapter(input() as any);
    const lookups = calls.filter((call) => !searchOnly(call));
    expect(calls.filter(searchOnly)).toHaveLength(1);
    expect(lookups).toHaveLength(18);
    expect(lookups.filter((call) => call.endpoint === "treg.people.email.find")).toHaveLength(9);
    expect(lookups.filter((call) => call.endpoint === "treg.people.phone.find")).toHaveLength(9);
    expect(result.providerCallCount).toBe(19);
    expect(result.costMicro).toBe(3420); // 9 rows × 0.00038: the lookups billed nothing
    expect(result.lookupLog!.summary).toMatchObject({ rows: 9, eligible: 9, lookedUp: 9, lookupCalls: 18, skippedBudget: 0, withContact: 0 });
  });

  it("before this change the same 9 people stopped at 7 lookups: the reservation arithmetic (0.04 / 0.005 = 8 calls, the search included)", () => {
    const budget = createDecisionMakerSpendBudget(0.04);
    let reserved = 0;
    while (budget.reserveCall()) reserved += 1; // no settleCall: the old behaviour
    expect(reserved).toBe(8);
  });

  it("settleCall gives back only what a call did not spend; a call whose cost is unknown keeps its whole reservation", () => {
    const budget = createDecisionMakerSpendBudget(0.01);
    expect(budget.reserveCall()).toBe(true);
    budget.settleCall({ actualMicros: 0, costKnown: true });
    expect(budget.remainingUsd()).toBe(0.01);
    expect(budget.reserveCall()).toBe(true);
    budget.settleCall({ actualMicros: 495, costKnown: true });
    expect(budget.remainingUsd()).toBeCloseTo(0.009505, 6);
    expect(budget.reserveCall()).toBe(true);
    budget.settleCall({ actualMicros: 0, costKnown: false }); // timed out: the source may have billed it
    expect(budget.remainingUsd()).toBeCloseTo(0.004505, 6);
    expect(budget.reserveCall()).toBe(false); // less than one call's cap is left
  });
});

describe("(b) actual spend never passes the job ceiling or the per-call cap", () => {
  it("every lookup bills the whole 0.005 cap: no more than the ceiling is spent, and the remaining people are not looked up", async () => {
    const costs: number[] = [];
    const calls = gateway((call) => {
      const cost = searchOnly(call) ? 3420 : 5000;
      costs.push(cost);
      return searchOnly(call) ? { cost, body: SEARCH_ANSWER } : { cost, body: { output: call.endpoint.includes("email") ? { email: null } : { phone: null }, _treg: { served_by: "provider-b", tried: ["provider-b"] } } };
    });
    const result = await defaultTregAdapter(input() as any);
    expect(spentMicro(costs)).toBeLessThanOrEqual(Math.round(DECISION_MAKER_PROVIDER_SPEND_CAP_USD * 1e6));
    expect(result.costMicro).toBe(spentMicro(costs));
    expect(calls.filter((call) => !searchOnly(call))).toHaveLength(7);
    expect(result.lookupLog!.summary.skippedBudget).toBeGreaterThan(0);
    for (const call of calls) expect(call.headers["X-Treg-Route-Max-Cost"]).toBe("0.005");
  });

  it("a lookup that timed out keeps its reservation, so an unknown bill can never take the job over the ceiling", () => {
    const budget = createDecisionMakerSpendBudget(0.04);
    for (let i = 0; i < 8; i++) { expect(budget.reserveCall()).toBe(true); budget.settleCall({ actualMicros: 0, costKnown: false }); }
    expect(budget.reserveCall()).toBe(false);
  });
});

describe("(c) the company domain is a real one, and the first and last names are sent", () => {
  it("link-in-bio, social, messenger and shortener hosts (and their subdomains) give no domain; empty and malformed values give none; a real site gives its host", () => {
    for (const website of ["https://linktr.ee/niletech", "linktr.ee/x", "https://www.linkedin.com/services/mahjoub", "https://in.linkedin.com/company/x", "https://www.facebook.com/page", "https://instagram.com/x", "https://x.com/y", "https://twitter.com/y", "https://wa.me/20100", "https://bit.ly/abc", "https://beacons.ai/x", "https://carrd.co", "", "   ", "not a url", undefined, null]) {
      expect(companyDomainFromWebsite(website), String(website)).toBe("");
    }
    expect(companyDomainFromWebsite("http://www.talentstailor.com")).toBe("talentstailor.com");
    expect(companyDomainFromWebsite("https://delta-soft.example/about?x=1")).toBe("delta-soft.example");
    expect(companyDomainFromWebsite("https://box.com")).toBe("box.com"); // not «x.com»
    expect(NON_COMPANY_HOSTS).toEqual(expect.arrayContaining(["linktr.ee", "linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "wa.me", "bit.ly", "beacons.ai", "carrd.co"]));
  });

  it("the identity: profile link + real domain + name + its parts; a blocked or empty website leaves the link and the name; null only with nothing to match on", () => {
    expect(buildPeopleIdentity({ linkedin_url: "https://www.linkedin.com/in/mohamed-shoukry-0", website: "http://www.talentstailor.com", contact_name: "Mohamed Shoukry" })).toEqual({
      linkedin_url: "https://www.linkedin.com/in/mohamed-shoukry-0", domain: "talentstailor.com", full_name: "Mohamed Shoukry", first_name: "Mohamed", last_name: "Shoukry",
    });
    expect(buildPeopleIdentity({ linkedin_url: "https://www.linkedin.com/in/rania-ayman-1", website: "https://linktr.ee/niletech", contact_name: "Rania Ayman" })).toEqual({
      linkedin_url: "https://www.linkedin.com/in/rania-ayman-1", full_name: "Rania Ayman", first_name: "Rania", last_name: "Ayman",
    });
    expect(buildPeopleIdentity({ linkedin_url: "https://www.linkedin.com/in/x", website: "", contact_name: "Salma" })).toEqual({ linkedin_url: "https://www.linkedin.com/in/x", full_name: "Salma", first_name: "Salma" });
    expect(buildPeopleIdentity({ website: "https://delta-soft.example", contact_name: "Omar Hassan" })).toEqual({ domain: "delta-soft.example", full_name: "Omar Hassan", first_name: "Omar", last_name: "Hassan" });
    expect(buildPeopleIdentity({ website: "https://linktr.ee/x", contact_name: "Omar Hassan" })).toBeNull();
    expect(buildPeopleIdentity({ website: "https://delta-soft.example", contact_name: "" })).toBeNull();
    expect(splitFullName("Mohamed Ali Shoukry")).toEqual({ first: "Mohamed", last: "Ali Shoukry" });
    expect(identityScore(buildPeopleIdentity({ linkedin_url: "https://x", website: "https://a.example", contact_name: "A B" }))).toBeGreaterThan(identityScore(buildPeopleIdentity({ linkedin_url: "https://x", contact_name: "A B" })));
    expect(identityScore(null)).toBe(-1);
  });

  it("through the real client: the lookups of the nine leads carry the names, a real domain only where the website is one, never linktr.ee or linkedin.com", async () => {
    const calls = gateway((call) => (searchOnly(call) ? { cost: 3420, body: SEARCH_ANSWER } : miss(call)));
    await defaultTregAdapter(input() as any);
    const emails = calls.filter((call) => call.endpoint === "treg.people.email.find").map((call) => call.body);
    expect(emails).toHaveLength(9);
    for (const body of emails) {
      expect(body.full_name).toBe(`${body.first_name} ${body.last_name}`);
      expect(String(body.linkedin_url)).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
      expect(body.domain ?? "").not.toMatch(/linktr\.ee|linkedin\.com|instagram\.com|bit\.ly/);
    }
    const byName = (first: string) => emails.find((body) => body.first_name === first);
    expect(byName("Mohamed").domain).toBe("talentstailor.com");
    expect(byName("Rania")).not.toHaveProperty("domain");
    expect(byName("Mohammed")).not.toHaveProperty("domain");
    expect(byName("Rasha")).not.toHaveProperty("domain"); // an empty website
    expect(byName("Omar").domain).toBe("delta-soft.example");
    expect(byName("Rasha").last_name).toBe("El-Azhry");
  });

  it("the best identities are looked up first (a profile link with a real domain before a link alone)", async () => {
    const calls = gateway((call) => (searchOnly(call) ? { cost: 3420, body: SEARCH_ANSWER } : miss(call)));
    await defaultTregAdapter(input() as any);
    const order = calls.filter((call) => call.endpoint === "treg.people.email.find").map((call) => Boolean(call.body.domain));
    expect(order).toEqual([...order].sort((a, b) => Number(b) - Number(a)));
    expect(order[0]).toBe(true);
    expect(order[order.length - 1]).toBe(false);
  });

  it("once the people still needed have a contact value no further person is looked up", async () => {
    const calls = gateway((call) => {
      if (searchOnly(call)) return { cost: 3420, body: SEARCH_ANSWER };
      return call.endpoint.includes("email")
        ? { cost: 495, body: { output: { email: `${String(call.body.first_name).toLowerCase()}@company.example`, first_name: call.body.first_name, last_name: call.body.last_name }, _treg: { served_by: "provider-a", tried: ["provider-a"] } } }
        : { cost: 0, body: { output: { phone: null } } };
    });
    const result = await defaultTregAdapter(input({ remainingNeeded: 3, targetVolumeMax: 3 }) as any);
    expect(calls.filter((call) => call.endpoint === "treg.people.email.find")).toHaveLength(3);
    expect(result.lookupLog!.summary).toMatchObject({ lookedUp: 3, withContact: 3, skippedEnough: 6 });
  });
});

describe("(d) every lookup is logged, with no personal value", () => {
  it("each entry has the endpoint, step key, the NAMES of the identity keys, status, latency, cost, served_by, outcome and the presence flags", async () => {
    const calls = gateway((call) => {
      if (searchOnly(call)) return { cost: 3420, body: SEARCH_ANSWER };
      if (call.endpoint.includes("email") && call.body.first_name === "Omar") return { cost: 495, body: { output: { email: "omar@delta-soft.example", first_name: "Omar", last_name: "Hassan", confidence: 0.9 }, _treg: { served_by: "provider-c", tried: ["provider-a", "provider-c"] } } };
      if (call.body.first_name === "Salma") return { status: 502, body: { error: "bad_gateway", detail: "salma.farid@secret.example could not be found" } };
      return miss(call);
    });
    const result = await defaultTregAdapter(input() as any);
    const { entries, summary } = result.lookupLog!;
    expect(entries.length).toBe(calls.filter((call) => !searchOnly(call)).length);
    const hit = entries.find((entry) => entry.outcome === "hit" && entry.endpoint === "treg.people.email.find")!;
    expect(hit).toMatchObject({ endpoint: "treg.people.email.find", status: 200, costUsd: 0.000495, servedBy: "provider-c", tried: 2, emailPresent: true, phonePresent: false, calls: 1 });
    expect(hit.step).toMatch(/^people_email_0_\d+$/);
    expect(hit.keys).toEqual(["domain", "first_name", "full_name", "last_name", "linkedin_url"]);
    expect(typeof hit.latencyMs).toBe("number");
    const error = entries.find((entry) => entry.outcome === "error")!;
    expect(error).toMatchObject({ status: 502, error: "bad_gateway" });
    expect(entries.some((entry) => entry.outcome === "miss")).toBe(true);
    expect(summary.lookedUp).toBe(9);
    // nothing personal and no token in what is kept
    const kept = JSON.stringify(result.lookupLog);
    for (const secret of ["omar@delta-soft.example", "salma.farid", "secret.example", "Omar", "Hassan", "Shoukry", "linkedin.com", "delta-soft.example", "talentstailor", "test-token-not-a-secret", "+20"]) {
      expect(kept, secret).not.toContain(secret);
    }
  });

  it("the log is its own internal event type: the customer's activity list never shows it", () => {
    expect(LOOKUP_LOG_EVENT_TYPE).toBe("lookup_log");
    expect(isCustomerVisibleJobEvent(LOOKUP_LOG_EVENT_TYPE)).toBe(false);
    expect(isCustomerVisibleJobEvent("progress")).toBe(true);
    expect(isCustomerVisibleJobEvent("info")).toBe(true);
  });
});

describe("(e) a contact returned for another person is discarded, not delivered and not charged", () => {
  it("returnedPersonMatches: the first and last name must match; accents, case, hyphens and spaces are ignored; an answer with no name is accepted", () => {
    expect(returnedPersonMatches("Rasha El-Azhry", { first: "Rasha", last: "El-Azhry" })).toBe(true);
    expect(returnedPersonMatches("Rasha El-Azhry", { first: "rásha", last: "el azhry" })).toBe(true);
    expect(returnedPersonMatches("Rasha El-Azhry", { full: "Rasha El Azhry" })).toBe(true);
    expect(returnedPersonMatches("Rasha El-Azhry", { first: "Ahmed", last: "Hassan" })).toBe(false);
    expect(returnedPersonMatches("Rasha El-Azhry", { first: "Rasha", last: "Hassan" })).toBe(false);
    expect(returnedPersonMatches("Rasha El-Azhry", { full: "Someone Else" })).toBe(false);
    expect(returnedPersonMatches("Rasha El-Azhry", {})).toBe(true);
    expect(returnedPersonMatches("Rasha El-Azhry", { first: "", last: "", full: "" })).toBe(true);
  });

  it("the live case: a lookup for Rasha El-Azhry answers an email of another person with confidence 1.0: no email on the row, the log says «mismatch», the phone lookup does not use it", async () => {
    const calls = gateway((call) => {
      if (searchOnly(call)) return { cost: 3420, body: { total: 1, success: true, leads: [LEADS[3]] } };
      if (call.endpoint === "treg.people.email.find") return { cost: 495, body: { output: { email: "er@vodafone.example", confidence: 1, first_name: "Esraa", last_name: "Rashad" }, _treg: { served_by: "provider-a", tried: ["provider-a"] } } };
      return { cost: 0, body: { output: { phone: null } } };
    });
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1 }) as any);
    const row = result.rows[0];
    expect(row.contact_name).toBe("Rasha El-Azhry");
    expect(row.work_email).toBe("");
    expect(row.work_email_presence_status).toBe("غير موجود");
    expect(result.lookupLog!.entries[0]).toMatchObject({ endpoint: "treg.people.email.find", outcome: "mismatch", emailPresent: false });
    const phone = calls.find((call) => call.endpoint === "treg.people.phone.find")!;
    expect(phone.body).not.toHaveProperty("email");
    expect(JSON.stringify(result.lookupLog)).not.toContain("vodafone");
  });

  it("an email returned for the right person (accents and case aside) is delivered and feeds the phone lookup", async () => {
    const calls = gateway((call) => {
      if (searchOnly(call)) return { cost: 3420, body: { total: 1, success: true, leads: [LEADS[3]] } };
      if (call.endpoint === "treg.people.email.find") return { cost: 495, body: { output: { email: "rasha@company.example", first_name: "RASHA", last_name: "el azhry" } } };
      return { cost: 0, body: { output: { phone: "+201000000009" } } };
    });
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1 }) as any);
    expect(result.rows[0]).toMatchObject({ work_email: "rasha@company.example", phone: "+201000000009" });
    expect(calls.find((call) => call.endpoint === "treg.people.phone.find")!.body.email).toBe("rasha@company.example");
  });
});
