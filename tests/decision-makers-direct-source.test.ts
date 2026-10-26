import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/catalogClient")>();
  return { ...actual, getEndpointDetails: vi.fn(async () => null) };
});
vi.mock("../src/lib/server/providerGate", () => ({
  getLiveProviderGateStatus: () => ({ isReady: true, reasonCode: "ready", messageAr: "" }),
}));
vi.mock("../src/functions/shared/tregClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/tregClient")>();
  return { ...actual, executeTregCall: mocks.call };
});

import { defaultTregAdapter, icypeasPeopleBody, parseDirectPeopleRows, peopleDiscoverySize, PEOPLE_DISCOVERY_USD_PER_ROW } from "../src/lib/server/tregAdapter";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { DECISION_MAKER_UNIT_PRICES_POINTS, decisionMakerChargePoints, decisionMakerDeliveredUnits } from "../src/functions/shared/decisionMakerPricing";
import { DECISION_MAKER_ROUTE_COST_CAP_USD } from "../src/lib/server/decisionMakerSpend";
import { isDeterministicFailureAr, PROVIDER_TIMEOUT_AR } from "../src/lib/providerFailureText";

/** The params of the live plan as stored after PR #252 (read from plans_quotes): a title, a country, English keywords, a limit, the contact fields. */
const PLAN_PARAMS = {
  limit: 3, title: "CEO", country: "EG", keywords: ["information technology", "software", "technology"],
  requiredContactFields: ["work_email", "phone"], contactFieldsToAttempt: ["work_email", "phone"],
};

/** Lead objects with exactly the fields of the direct source's answer (the owner's live direct call). */
const lead = (extra: Record<string, any>) => ({
  firstname: "", lastname: "", headline: "", description: "", profileUrl: "", lastJobTitle: "CEO", lastJobDescription: "", lastJobStartDate: "2019-03",
  address: "", lastCompanyName: "", lastCompanyUrl: "", lastCompanyWebsite: "", lastCompanyDescription: "", lastCompanySize: "11-50", lastCompanyIndustry: "", lastCompanyAddress: "",
  ...extra,
});
const A = lead({ firstname: "Mona", lastname: "Saleh", headline: "CEO at Delta Software", description: "Leading Delta Software. Write to mona.boss@delta-soft.example", profileUrl: "https://www.linkedin.com/in/mona-saleh-a", address: "Cairo, Egypt", lastCompanyName: "Delta Software", lastCompanyUrl: "https://www.linkedin.com/company/delta-software", lastCompanyWebsite: "https://delta-soft.example", lastCompanyDescription: "Software development and cloud technology services", lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt" });
const B = lead({ firstname: "Nour", lastname: "Adel", headline: "Managing partner", profileUrl: "https://www.linkedin.com/in/nour-adel-b", address: "Cairo, Egypt", lastCompanyName: "Nile Advisory", lastCompanyWebsite: "https://nile-advisory.example", lastCompanyDescription: "Business strategy consulting for family firms", lastCompanyIndustry: "Management Consulting", lastCompanyAddress: "Cairo, Egypt" });
const C = lead({ firstname: "Yusuf", lastname: "Ali", headline: "CEO", profileUrl: "https://www.linkedin.com/in/yusuf-ali-c", address: "Manama, Bahrain", lastCompanyName: "Sudan Tech Group", lastCompanyWebsite: "https://sudan-tech.example", lastCompanyDescription: "Software and technology", lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Khartoum, Sudan" });
const D = lead({ firstname: "Salma", lastname: "Farid", headline: "Director", profileUrl: "https://www.linkedin.com/in/salma-farid-d", address: "Cairo, Egypt", lastCompanyName: "Horus Academy", lastCompanyWebsite: "https://horus-academy.example", lastCompanyDescription: "Schools and training programmes", lastCompanyIndustry: "Education Management", lastCompanyAddress: "Cairo, Egypt" });
const E = lead({ firstname: "Omar", lastname: "Hassan", headline: "CEO", profileUrl: "https://www.linkedin.com/in/omar-hassan-e", address: "Giza, Egypt", lastCompanyName: "Pyramid Cloud", lastCompanyWebsite: "https://pyramid-cloud.example", lastCompanyDescription: "Cloud software platform", lastCompanyIndustry: "Computer Software", lastCompanyAddress: "Giza, Egypt" });
const DIRECT_ANSWER = { total: 2560, success: true, leads: [A, B, C, D, E], pagination: { token: "next", size: 9 } };

const res = (extra: Record<string, any>) => ({ ok: true, httpStatus: 200, tregCallId: "id", costMicro: 0, latencyMs: 5, isRouteMaxCost: false, isPlatformBalanceLow: false, ...extra });
const TIMED_OUT = { ok: false, httpStatus: 503, tregCallId: "err_1792997613504", costMicro: 0, latencyMs: 30005, data: null, error: "network_failure", errorDetails: "The operation was aborted due to timeout", isRouteMaxCost: false, isPlatformBalanceLow: false, timedOut: true };

/** The source: the direct search answers the leads; the email lookup answers for two people; the phone lookup for the first only. */
const source = (search: any = res({ costMicro: 1900, tregCallId: "search_1", data: DIRECT_ANSWER })) => async (options: { endpointId: string; params: Record<string, any> }) => {
  if (options.endpointId === "icypeas.people.search") return search;
  const link = String(options.params?.linkedin_url || "");
  if (options.endpointId === "treg.people.email.find") {
    if (link.endsWith("mona-saleh-a")) return res({ costMicro: 20, data: { output: { work_email: "mona@delta-soft.example" } } });
    if (link.endsWith("omar-hassan-e")) return res({ costMicro: 20, data: { output: { work_email: "omar@pyramid-cloud.example" } } });
    return res({ costMicro: 20, data: { output: {} } });
  }
  return String(options.params?.email || "").startsWith("mona@")
    ? res({ costMicro: 30, data: { output: { phone_number: "+201000000001" } } })
    : res({ costMicro: 30, data: { output: {} } });
};

const input = (extra: Record<string, any> = {}) => ({
  jobId: "job_quote_direct", userId: "user_direct", step: 0,
  endpointId: "treg.people.search", capabilitySlug: "professional-people-search", method: "POST" as const, params: PLAN_PARAMS,
  paginationStrategy: "none" as const, cursor: null, pageSize: 3, remainingNeeded: 3, targetVolumeMax: 3, deliveredSoFar: 0, decisionMakerSpendBudgetUsd: 0.04, ...extra,
});
const gate = (row: Record<string, any>) => evaluateResearchRowRelevance(row, { capabilitySlug: "professional-people-search", endpointId: "treg.people.search", params: PLAN_PARAMS });
const names = (rows: Record<string, any>[]) => rows.map((row) => row.contact_name);

describe("the direct people source: the body, the size and the cost ceiling", () => {
  it("the stored live plan becomes the body that worked on a direct call (title, alpha-2 location, keywords, size), nothing else", () => {
    expect(icypeasPeopleBody(PLAN_PARAMS, peopleDiscoverySize(3))).toEqual({
      query: { currentJobTitle: { include: ["CEO"] }, location: { include: ["EG"] }, keyword: { include: ["information technology", "software", "technology"] } },
      pagination: { size: 9 },
    });
  });

  it("a country written as a name becomes its code, Arabic keywords never reach the source, a company site and a free-text query are carried", () => {
    expect(icypeasPeopleBody({ country: "Egypt", title: "Director", keywords: ["شركات", "software"] }, 5).query).toEqual({
      currentJobTitle: { include: ["Director"] }, location: { include: ["EG"] }, keyword: { include: ["software"] },
    });
    expect(icypeasPeopleBody({ q: "chief executives", company_domain: "https://www.example.com/about", country: "EG" }, 5).query).toEqual({
      location: { include: ["EG"] }, currentCompanyWebsite: { include: ["example.com"] }, keyword: { include: ["chief executives"] },
    });
  });

  it("the rows asked for are three times the people wanted and never more than the per-call ceiling pays for", () => {
    expect(peopleDiscoverySize(1)).toBe(3);
    expect(peopleDiscoverySize(3)).toBe(9);
    expect(peopleDiscoverySize(4)).toBe(11);
    expect(peopleDiscoverySize(50)).toBe(11);
    expect(peopleDiscoverySize(50) * PEOPLE_DISCOVERY_USD_PER_ROW).toBeLessThan(DECISION_MAKER_ROUTE_COST_CAP_USD);
  });
});

describe("the direct answer is read and judged: only people who match the request are looked up, delivered and charged", () => {
  beforeEach(() => { mocks.call.mockReset(); });

  it("the leads become rows with their company, address and activity, and no contact value is taken from free profile text", () => {
    const rows = parseDirectPeopleRows(DIRECT_ANSWER);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      contact_name: "Mona Saleh", job_title: "CEO", company_name: "Delta Software", website: "https://delta-soft.example",
      linkedin_url: "https://www.linkedin.com/in/mona-saleh-a", location: "Cairo, Egypt", company_address: "Cairo, Egypt",
      industry: "Information Technology & Services", people_source: "icypeas", work_email: "", phone: "",
    });
    // the profile text names an email; it is text, not a delivered work email
    expect(String(A.description)).toContain("@");
    expect(rows[0].work_email).toBe("");
    expect(rows[0].work_email_presence_status).toBe("غير موجود");
  });

  it("the gate keeps the two Egyptian technology companies, sends the consulting firm and the school to review, and refuses the person in Bahrain", () => {
    const decisions = parseDirectPeopleRows(DIRECT_ANSWER).map((row) => [row.contact_name, gate(row).decision]);
    expect(decisions).toEqual([
      ["Mona Saleh", "match"], ["Nour Adel", "uncertain"], ["Yusuf Ali", "no_match"], ["Salma Farid", "uncertain"], ["Omar Hassan", "match"],
    ]);
    const bahrain = gate(parseDirectPeopleRows(DIRECT_ANSWER)[2]);
    expect(bahrain.reasonAr).toBe("الشخص خارج النطاق الجغرافي المطلوب");
    expect(gate(parseDirectPeopleRows(DIRECT_ANSWER)[1]).reasonAr).toContain("أُحيل السجل للمراجعة ولم يُحتسب");
  });

  it("a company in another country makes the row a review row even when the person's own address says Egypt", () => {
    const row = parseDirectPeopleRows({ leads: [{ ...A, lastCompanyAddress: "Dubai, United Arab Emirates" }] })[0];
    expect(gate(row)).toMatchObject({ decision: "uncertain", reasonAr: "شركة الشخص خارج النطاق الجغرافي المطلوب؛ أُحيل السجل للمراجعة ولم يُحتسب" });
  });

  it("rows of any other source are judged as before: only an explicit foreign country refuses them", () => {
    expect(gate({ contact_name: "Someone", company_name: "Unknown", industry: "Education Management" }).decision).toBe("match");
    expect(gate({ contact_name: "Someone", country: "Bahrain" }).decision).toBe("no_match");
  });

  it("through the adapter: one search, lookups only for the two matching people, the others kept for review and never looked up", async () => {
    mocks.call.mockImplementation(source());
    const result = await defaultTregAdapter(input());
    expect(result.ok).toBe(true);
    const sent = mocks.call.mock.calls.map(([call]: any[]) => call);
    expect(sent.map((call: any) => call.endpointId)).toEqual([
      "icypeas.people.search", "treg.people.email.find", "treg.people.phone.find", "treg.people.email.find", "treg.people.phone.find",
    ]);
    expect(sent[0].params).toEqual({
      query: { currentJobTitle: { include: ["CEO"] }, location: { include: ["EG"] }, keyword: { include: ["information technology", "software", "technology"] } },
      pagination: { size: 9 },
    });
    expect(sent.every((call: any) => call.routeMaxCostUsd === "0.005")).toBe(true);
    const looked = sent.filter((call: any) => call.endpointId === "treg.people.email.find").map((call: any) => call.params.linkedin_url);
    expect(looked).toEqual(["https://www.linkedin.com/in/mona-saleh-a", "https://www.linkedin.com/in/omar-hassan-e"]);
    // the people who match come first, with their contact values; the others follow and wait for review
    expect(names(result.rows)).toEqual(["Mona Saleh", "Omar Hassan", "Nour Adel", "Yusuf Ali", "Salma Farid"]);
    expect(result.rows[0]).toMatchObject({ work_email: "mona@delta-soft.example", phone: "+201000000001" });
    expect(result.rows[1]).toMatchObject({ work_email: "omar@pyramid-cloud.example", phone: "", phone_presence_status: "غير موجود" });
    expect(result.rows.slice(2).every((row) => row.work_email === "" && row.phone === "")).toBe(true);
    expect(result.providerCallCount).toBe(5);
    expect(result.costMicro).toBe(1900 + 20 + 30 + 20 + 30);
  });

  it("what is delivered and charged: the two matching people, their own fields only (a phone that was not found is not charged)", async () => {
    mocks.call.mockImplementation(source());
    const result = await defaultTregAdapter(input());
    const delivered = result.rows.filter((row) => gate(row).decision === "match");
    expect(names(delivered)).toEqual(["Mona Saleh", "Omar Hassan"]);
    const units = decisionMakerDeliveredUnits(delivered, ["work_email", "phone"]);
    expect(units).toEqual({ baseUnits: 2, emailUnits: 2, phoneUnits: 1 });
    expect(decisionMakerChargePoints(units, DECISION_MAKER_UNIT_PRICES_POINTS)).toBe(2 * 83 + 2 * 55 + 1 * 55);
  });

  it("when no contact value is found the people are NOT delivered: they go to review and nothing is charged", async () => {
    mocks.call.mockImplementation(async (options: any) => options.endpointId === "icypeas.people.search" ? res({ costMicro: 1900, data: DIRECT_ANSWER }) : res({ costMicro: 20, data: { output: {} } }));
    const result = await defaultTregAdapter(input());
    // the lookups ran and found nothing: every person is still a row of the adapter's answer, with the status of each contact field
    expect(result.rows.every((row) => row.work_email === "" && row.phone === "")).toBe(true);
    expect(result.rows[0].work_email_presence_status).toBe("غير موجود");
    expect(result.rows[0].contact_review_status).toContain("لم يتوفر");
    // the gate sends a person with NEITHER requested contact value to review (was: delivered with a charge of 0)
    const verdicts = result.rows.map((row) => gate(row));
    expect(verdicts.filter((verdict) => verdict.decision === "match")).toEqual([]);
    expect(verdicts.filter((verdict) => verdict.reasonCode === "no_contact").length).toBeGreaterThan(0);
    const delivered = result.rows.filter((row) => gate(row).decision === "match");
    expect(decisionMakerChargePoints(decisionMakerDeliveredUnits(delivered, ["work_email", "phone"]), DECISION_MAKER_UNIT_PRICES_POINTS)).toBe(0);
  });
});

describe("a slow source: the answer is read once the source has it, never bought twice, and a timeout is told honestly", () => {
  beforeEach(() => { mocks.call.mockReset(); });

  it("the source answers 200 after the 30 s limit: the replay (same step, page, key and body) reads it, and the call is charged once", async () => {
    let searches = 0;
    mocks.call.mockImplementation(async (options: any) => {
      if (options.endpointId === "icypeas.people.search") {
        searches += 1;
        // the first call was cut at our limit (30,005 ms in the live run); the replay answers from the stored result: cost 0, the first call's charge in the original-cost header
        return searches === 1 ? TIMED_OUT : res({ costMicro: 0, originalCostMicro: 1900, tregCallId: "callref", data: DIRECT_ANSWER });
      }
      return source()(options);
    });
    const result = await defaultTregAdapter(input({ deadlineMs: Date.now() + 45_000 }));
    expect(result.ok).toBe(true);
    expect(names(result.rows).slice(0, 2)).toEqual(["Mona Saleh", "Omar Hassan"]);
    const searchCalls = mocks.call.mock.calls.map(([call]: any[]) => call).filter((call: any) => call.endpointId === "icypeas.people.search");
    expect(searchCalls).toHaveLength(2);
    expect({ ...searchCalls[1], timeoutMs: undefined }).toEqual({ ...searchCalls[0], timeoutMs: undefined });
    expect(searchCalls[0].timeoutMs).toBe(20_000);
    expect(searchCalls[1].timeoutMs).toBeGreaterThanOrEqual(5_000);
    // the search is paid once (1,900 micro-USD, the first call's charge), plus the four lookups: no double billing
    expect(result.costMicro).toBe(1900 + 100);
    expect(result.providerCallCount).toBe(2 + 4);
    expect(result.tregCallId).toContain("callref");
  });

  it("a replay that also times out ends the job honestly: the timeout sentence, a retry stays possible, no lookups, no cost", async () => {
    mocks.call.mockResolvedValue(TIMED_OUT);
    const result = await defaultTregAdapter(input({ deadlineMs: Date.now() + 45_000 }));
    expect(result.ok).toBe(false);
    expect(result.errorMessageAr).toBe(PROVIDER_TIMEOUT_AR);
    expect(isDeterministicFailureAr(result.errorMessageAr)).toBe(false);
    expect(/[A-Za-z]/.test(result.errorMessageAr || "")).toBe(false);
    expect(result.providerCallCount).toBe(2);
    expect(result.costMicro).toBe(0);
    expect(mocks.call).toHaveBeenCalledTimes(2);
  });

  it("with the worker deadline close there is no replay (one call), and the sentence is still the honest one", async () => {
    mocks.call.mockResolvedValue(TIMED_OUT);
    const result = await defaultTregAdapter(input({ deadlineMs: Date.now() + 13_000 }));
    expect(result.ok).toBe(false);
    expect(result.errorMessageAr).toBe(PROVIDER_TIMEOUT_AR);
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(result.providerCallCount).toBe(1);
  });

  it("a refusal that is not a timeout keeps its own sentence and is not replayed", async () => {
    mocks.call.mockResolvedValue({ ok: false, httpStatus: 422, tregCallId: "", costMicro: 0, latencyMs: 360, data: null, error: "http_422", isRouteMaxCost: false, isPlatformBalanceLow: false });
    const result = await defaultTregAdapter(input({ deadlineMs: Date.now() + 45_000 }));
    expect(result.ok).toBe(false);
    expect(isDeterministicFailureAr(result.errorMessageAr)).toBe(true);
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
});
