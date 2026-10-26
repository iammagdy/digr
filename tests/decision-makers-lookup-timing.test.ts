import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Decision makers, lookup timing (PR #253): SIMULATION only (real client and adapter, stubbed `fetch` with small real delays, injected DNS check).
 *   - each person runs on their own: the email, then the deliverability check of the address found at the SAME TIME as the phone lookup; nobody waits for the
 *     slowest person of the group
 *   - the people lookups keep 12 s free before the worker's deadline (6 s before), so saving and settling finish inside it
 *   - the check is skipped (the address is delivered as «لم يتوفر تأكيد») when too little time is left; the DNS check is never skipped
 *   - the job's spend ceiling still holds when the check and the phone lookup reserve at the same time
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

import { defaultTregAdapter, PEOPLE_LOOKUP_RESERVE_MS, PEOPLE_VERIFY_MIN_TIME_MS } from "../src/lib/server/tregAdapter";
import { setMailDomainResolverForTesting } from "../src/lib/server/mailDomainCheck";
import { decisionMakerJobSpendCeilingUsd } from "../src/lib/server/decisionMakerSpend";

const PARAMS = { limit: 3, title: "CEO", country: "EG", keywords: ["information technology", "software", "technology"], requiredContactFields: ["work_email", "phone"], contactFieldsToAttempt: ["work_email", "phone"] };
const lead = (first: string, last: string) => ({
  firstname: first, lastname: last, headline: "", description: "", profileUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}`, lastJobTitle: "CEO", lastJobDescription: "", lastJobStartDate: "2019-03",
  address: "Cairo, Egypt", lastCompanyName: `${last} Software`, lastCompanyUrl: "", lastCompanyWebsite: `https://${last.toLowerCase()}-soft.example`, lastCompanyDescription: "Software and cloud technology", lastCompanySize: "11-50",
  lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt",
});
const answerOf = (leads: any[]) => ({ total: 2560, success: true, leads, pagination: { token: "next", size: leads.length } });
const input = (extra: Record<string, any> = {}) => ({
  jobId: "job_quote_timing", userId: "user_timing", step: 0, endpointId: "treg.people.search", capabilitySlug: "professional-people-search", method: "POST" as const,
  params: PARAMS, paginationStrategy: "none" as const, cursor: null, pageSize: 3, remainingNeeded: 3, targetVolumeMax: 3, deliveredSoFar: 0, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(3), ...extra,
});

interface Mark { what: string; at: number }
/** The gateway with a delay per endpoint and person; every call's start and end are marked in order. */
function timedGateway(delays: { email: Record<string, number>; verify: number; phone: number }, costs = { email: 8900, verify: 400, phone: 0 }) {
  const marks: Mark[] = [];
  const bodies: Array<{ endpoint: string; body: any }> = [];
  const t0 = performance.now();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const endpoint = String(url).split("/call/")[1];
    const body = JSON.parse(String(init.body));
    bodies.push({ endpoint, body });
    const who = body.first_name ?? String(body.email ?? "").split("@")[0];
    const tag = `${endpoint.replace("treg.people.", "")}:${who}`;
    marks.push({ what: `start ${tag}`, at: performance.now() - t0 });
    const wait = endpoint === "treg.people.email.find" ? delays.email[body.first_name] : endpoint === "treg.people.email.verify" ? delays.verify : endpoint === "treg.people.phone.find" ? delays.phone : 0;
    await new Promise((resolve) => setTimeout(resolve, wait));
    marks.push({ what: `end ${tag}`, at: performance.now() - t0 });
    let out: any;
    let cost = 0;
    if (endpoint === "icypeas.people.search") { out = answerOf([lead("Alaa", "Alpha"), lead("Bassem", "Beta"), lead("Carim", "Gamma")]); cost = 380; }
    else if (endpoint === "treg.people.email.find") { out = { output: { email: `${String(body.first_name).toLowerCase()}@${body.domain}`, first_name: body.first_name, last_name: body.last_name }, _treg: { served_by: "p", tried: ["p"] } }; cost = costs.email; }
    else if (endpoint === "treg.people.email.verify") { out = { output: { status: "valid" }, _treg: { served_by: "contactout.people.email.verify", tried: ["contactout.people.email.verify"] } }; cost = costs.verify; }
    else { out = { output: { phone: null }, _treg: { tried: Array(15).fill("p") } }; cost = costs.phone; }
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", "x-treg-call-id": `call_${marks.length}`, "x-treg-cost-micro": String(cost) } });
  }));
  const at = (what: string) => marks.findIndex((mark) => mark.what === what);
  const time = (what: string) => marks.find((mark) => mark.what === what)!.at;
  return { marks, bodies, at, time };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the constants", () => {
  it("12 s are kept free before the worker's deadline; a deliverability check needs 6 s left", () => {
    expect(PEOPLE_LOOKUP_RESERVE_MS).toBe(12_000);
    expect(PEOPLE_VERIFY_MIN_TIME_MS).toBe(6_000);
  });
});

describe("each person on their own: the check of the address runs at the same time as the phone lookup", () => {
  it("the fast person's check and phone start together right after their email, while the slow person's email is still running; nobody waits for the group", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const g = timedGateway({ email: { Alaa: 10, Bassem: 220, Carim: 90 }, verify: 120, phone: 40 });
    const result = await defaultTregAdapter(input() as any);
    // Alaa: email ends, then the check AND the phone start (together), both before Bassem's email ends
    expect(g.at("end email.find:Alaa")).toBeLessThan(g.at("start email.verify:alaa"));
    expect(g.at("end email.find:Alaa")).toBeLessThan(g.at("start phone.find:Alaa"));
    expect(Math.abs(g.time("start email.verify:alaa") - g.time("start phone.find:Alaa"))).toBeLessThan(40);
    expect(g.at("start phone.find:Alaa")).toBeLessThan(g.at("end email.find:Bassem"));
    expect(g.at("start email.verify:alaa")).toBeLessThan(g.at("end email.find:Bassem"));
    // the check and the phone of one person overlap in time (the phone, shorter, ends inside the check)
    expect(g.at("start phone.find:Alaa")).toBeLessThan(g.at("end email.verify:alaa"));
    // all three delivered, each with the verified status; the log keeps one fixed order per person: finds, then the check, then the phone
    expect(result.rows.filter((row) => row.work_email)).toHaveLength(3);
    expect(result.rows.every((row) => !row.work_email || row.work_email_verification_status === "متحقق")).toBe(true);
    const mine = result.lookupLog!.entries.filter((entry) => entry.person === result.lookupLog!.entries[0].person);
    expect(mine.map((entry) => entry.endpoint)).toEqual(["treg.people.email.find", "treg.people.email.verify", "treg.people.phone.find"]);
    expect(result.lookupLog!.entries.filter((entry) => entry.endpoint === "treg.people.email.find").every((entry) => entry.emailPresent)).toBe(true);
  });

  it("the phone lookup carries the address found (it does not wait for its check)", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const g = timedGateway({ email: { Alaa: 5, Bassem: 5, Carim: 5 }, verify: 60, phone: 5 });
    await defaultTregAdapter(input() as any);
    const phones = g.bodies.filter((entry) => entry.endpoint === "treg.people.phone.find").map((entry) => entry.body.email);
    expect(phones.sort()).toEqual(["alaa@alpha-soft.example", "bassem@beta-soft.example", "carim@gamma-soft.example"]);
  });

  it("an invalid verdict still keeps the address out (not delivered, not charged) when the phone ran at the same time", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const endpoint = String(url).split("/call/")[1];
      const body = JSON.parse(String(init.body));
      const out = endpoint === "icypeas.people.search" ? answerOf([lead("Alaa", "Alpha")])
        : endpoint === "treg.people.email.find" ? { output: { email: "alaa@alpha-soft.example", first_name: "Alaa", last_name: "Alpha" } }
        : endpoint === "treg.people.email.verify" ? { output: { status: "invalid", reason: "invalid_dns" } } : { output: { phone: "+201000000001" } };
      void body;
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", "x-treg-call-id": "c", "x-treg-cost-micro": "0" } });
    }));
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1) }) as any);
    expect(result.rows[0].work_email).toBe("");
    expect(result.rows[0].phone).toBe("+201000000001"); // the phone found is delivered by itself
    expect(result.lookupLog!.rows![0]).toMatchObject({ finalReason: "contact" }); // a delivered phone is a contact
    expect(result.lookupLog!.entries.find((entry) => entry.endpoint === "treg.people.email.find")).toMatchObject({ outcome: "verify_invalid", emailPresent: false, mailboxDomain: "alpha-soft.example" });
    expect(result.lookupLog!.summary).toMatchObject({ verifyInvalid: 1 });
  });
});

describe("the time reserve and the checks that are skipped for time", () => {
  it("12 s before the deadline no lookup starts: with 14 s left (2 s after the reserve) nothing is looked up, with 16 s left (4 s) the lookups run", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const none = timedGateway({ email: { Alaa: 1, Bassem: 1, Carim: 1 }, verify: 1, phone: 1 });
    const early = await defaultTregAdapter(input({ deadlineMs: Date.now() + 14_000 }) as any);
    expect(none.bodies.filter((entry) => entry.endpoint !== "icypeas.people.search")).toHaveLength(0);
    expect(early.lookupLog!.summary.skippedTime).toBeGreaterThan(0);
    vi.unstubAllGlobals();
    const some = timedGateway({ email: { Alaa: 1, Bassem: 1, Carim: 1 }, verify: 1, phone: 1 });
    await defaultTregAdapter(input({ deadlineMs: Date.now() + 16_000 }) as any);
    expect(some.bodies.filter((entry) => entry.endpoint === "treg.people.email.find").length).toBeGreaterThan(0);
  });

  it("with less than 6 s left after the email, the check is skipped: the address is delivered as «لم يتوفر تأكيد», and the DNS check still ran", async () => {
    const asked: string[] = [];
    setMailDomainResolverForTesting(async (domain) => { asked.push(domain); return "mx"; });
    const g = timedGateway({ email: { Alaa: 1, Bassem: 1, Carim: 1 }, verify: 1, phone: 1 });
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1), deadlineMs: Date.now() + 17_500 }) as any);
    expect(g.bodies.filter((entry) => entry.endpoint === "treg.people.email.verify")).toHaveLength(0);
    expect(asked.length).toBeGreaterThan(0); // never skipped
    expect(result.lookupLog!.summary.verifySkippedTime).toBeGreaterThan(0);
    const delivered = result.rows.filter((row) => row.work_email);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.every((row) => row.work_email_verification_status === "لم يتوفر تأكيد")).toBe(true);
  });

  it("with time to spare the check is made; and a domain with no mail server is refused even when the check would be skipped for time", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const roomy = timedGateway({ email: { Alaa: 1, Bassem: 1, Carim: 1 }, verify: 1, phone: 1 });
    await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1), deadlineMs: Date.now() + 30_000 }) as any);
    expect(roomy.bodies.filter((entry) => entry.endpoint === "treg.people.email.verify").length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
    setMailDomainResolverForTesting(async () => "none");
    const tight = timedGateway({ email: { Alaa: 1, Bassem: 1, Carim: 1 }, verify: 1, phone: 1 });
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1), deadlineMs: Date.now() + 17_500 }) as any);
    expect(tight.bodies.filter((entry) => entry.endpoint === "treg.people.email.verify")).toHaveLength(0);
    expect(result.rows.filter((row) => row.work_email)).toHaveLength(0);
    expect(result.lookupLog!.summary.noMx).toBeGreaterThan(0);
  });
});

describe("the ceiling holds when the check and the phone lookup reserve together", () => {
  it("a budget that holds the email and the check but not the phone as well: the check is made, the phone is skipped for budget, and the spend stays under the budget", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const costs: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const endpoint = String(url).split("/call/")[1];
      const body = JSON.parse(String(init.body));
      const cost = endpoint === "icypeas.people.search" ? 380 : endpoint === "treg.people.email.find" ? 20_000 : endpoint === "treg.people.email.verify" ? 400 : 0;
      costs.push(cost);
      const out = endpoint === "icypeas.people.search" ? answerOf([lead("Alaa", "Alpha")])
        : endpoint === "treg.people.email.find" ? { output: { email: "alaa@alpha-soft.example", first_name: body.first_name, last_name: body.last_name } }
        : endpoint === "treg.people.email.verify" ? { output: { status: "valid" } } : { output: { phone: null } };
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", "x-treg-call-id": "c", "x-treg-cost-micro": String(cost) } });
    }));
    // the search reserves 0.005 and gives back what it did not spend (0.00038): 0.0255 - 0.00038 = 0.02512; the email reserves 0.02 (0.00512 left);
    // the check reserves 0.005 (0.00012 left): the phone lookup's 0.005 does not fit
    const budget = 0.0255;
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: budget }) as any);
    const spent = costs.reduce((total, cost) => total + cost, 0);
    expect(spent).toBeLessThanOrEqual(Math.round(budget * 1e6));
    expect(result.costMicro).toBe(spent);
    expect(result.lookupLog!.summary).toMatchObject({ verifyCalls: 1, skippedBudget: 1 });
    expect(result.rows[0].work_email_verification_status).toBe("متحقق");
  });

  it("three people, every email at the full 0.02 and every check at the full 0.005: the total stays at or under 0.04 + 3 x 0.025 = 0.115", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const g = timedGateway({ email: { Alaa: 5, Bassem: 5, Carim: 5 }, verify: 5, phone: 5 }, { email: 20_000, verify: 5_000, phone: 0 });
    const result = await defaultTregAdapter(input() as any);
    expect(result.costMicro).toBeLessThanOrEqual(Math.round(decisionMakerJobSpendCeilingUsd(3) * 1e6));
    expect(result.costMicro).toBe(380 + 3 * 20_000 + 3 * 5_000);
    expect(g.bodies.filter((entry) => entry.endpoint === "treg.people.email.verify")).toHaveLength(3);
  });
});
