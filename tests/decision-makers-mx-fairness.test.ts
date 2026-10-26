import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Decision makers, mail-server check before the paid lookup, and the first-email timeline (follow-up to PR #253): SIMULATION only. The real client and adapter
 * run; `fetch` is stubbed with small real delays; the mail-server answer of each domain is injected (the real DNS interpretation is in final-fix).
 *   - a company domain with no mail server (no MX, a null MX, or an address record only) is not looked up: no call, no charge, the log says `no_mx` with the domain only
 *   - a DNS check that cannot answer does not stop a lookup (fail open)
 *   - the first work-email lookup of every eligible person starts before any check, phone or fallback lookup
 *   - the job's spend ceiling still holds when every first lookup is in flight
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

import { defaultTregAdapter, PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS, PEOPLE_LOOKUP_RESERVE_MS } from "../src/lib/server/tregAdapter";
import { setMailDomainResolverForTesting, type MailDomainStatus } from "../src/lib/server/mailDomainCheck";
import { decisionMakerJobSpendCeilingUsd } from "../src/lib/server/decisionMakerSpend";
import { WORKER_DISPATCH_TIMEOUT_MS } from "../src/lib/server/workerDispatch";

/** The mail-server status of each company domain in one test (the resolver's answer; «mx» for any domain not listed). */
const mailStatus: Record<string, MailDomainStatus> = {};
const statusOf = async (domain: string): Promise<MailDomainStatus> => mailStatus[domain] ?? "mx";

const PARAMS = { limit: 3, title: "CEO", country: "EG", keywords: ["information technology", "software", "technology"], requiredContactFields: ["work_email", "phone"], contactFieldsToAttempt: ["work_email", "phone"] };
const NAMES: Array<[string, string]> = [["Alaa", "Alpha"], ["Bassem", "Beta"], ["Carim", "Gamma"], ["Dina", "Delta"], ["Elias", "Epsilon"]];
const lead = (first: string, last: string) => ({
  firstname: first, lastname: last, headline: "", description: "", profileUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}`, lastJobTitle: "CEO", lastJobDescription: "", lastJobStartDate: "2019-03",
  address: "Cairo, Egypt", lastCompanyName: `${last} Software`, lastCompanyUrl: "", lastCompanyWebsite: `https://${last.toLowerCase()}-soft.example`, lastCompanyDescription: "Software and cloud technology", lastCompanySize: "11-50",
  lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt",
});
const LEADS = NAMES.map(([first, last]) => lead(first, last));
const answerOf = (leads: any[]) => ({ total: 2560, success: true, leads, pagination: { token: "next", size: leads.length } });
const input = (extra: Record<string, any> = {}) => ({
  jobId: "job_mx_fairness", userId: "user_mx_fairness", step: 0, endpointId: "treg.people.search", capabilitySlug: "professional-people-search", method: "POST" as const,
  params: PARAMS, paginationStrategy: "none" as const, cursor: null, pageSize: 3, remainingNeeded: 3, targetVolumeMax: 3, deliveredSoFar: 0, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(3), ...extra,
});

interface Call { endpoint: string; body: any; key: string; at: number; costMicro: number }
/** The gateway: every call is recorded with its start time, cost and idempotency key; a found address is on the company domain. */
function gateway(delayMs: (endpoint: string, body: any) => number = () => 0, emailCost = 20_000) {
  const calls: Call[] = [];
  const t0 = performance.now();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const endpoint = String(url).split("/call/")[1];
    const body = JSON.parse(String(init.body));
    const key = String((init.headers as Record<string, string>)["Idempotency-Key"] ?? "");
    const at = performance.now() - t0;
    await new Promise((resolve) => setTimeout(resolve, delayMs(endpoint, body)));
    let out: any;
    let cost = 0;
    if (endpoint === "icypeas.people.search") { out = answerOf(LEADS); cost = 380; }
    else if (endpoint === "treg.people.email.find") { out = { output: { email: `${String(body.first_name).toLowerCase()}@${body.domain}`, first_name: body.first_name, last_name: body.last_name }, _treg: { served_by: "p", tried: ["p"] } }; cost = emailCost; }
    else if (endpoint === "treg.people.email.verify") { out = { output: { status: "valid" }, _treg: { served_by: "contactout.people.email.verify", tried: ["contactout.people.email.verify"] } }; cost = 400; }
    else { out = { output: { phone: null }, _treg: { tried: ["p"] } }; cost = 0; }
    calls.push({ endpoint, body, key, at, costMicro: cost });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", "x-treg-call-id": `call_${calls.length}`, "x-treg-cost-micro": String(cost) } });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(mailStatus)) delete mailStatus[key];
  setMailDomainResolverForTesting(async () => "mx"); // the suite's default (see tests/setup/mailDomain.ts)
});

const emailCalls = (calls: Call[]) => calls.filter((call) => call.endpoint === "treg.people.email.find");
const firstEmailCalls = (calls: Call[]) => emailCalls(calls).filter((call) => !call.key.includes("people_email_link_"));

describe("the mail-server check comes BEFORE the paid email lookup (the resolver's answer per company domain)", () => {
  it("a company domain with an address record only (no MX): no paid lookup for its person, nothing charged, the log says no_mx with the domain only", async () => {
    mailStatus["beta-soft.example"] = "a"; // no MX, an address record
    setMailDomainResolverForTesting(statusOf);
    const calls = gateway();
    const result = await defaultTregAdapter(input() as any);
    expect(emailCalls(calls).some((call) => call.body.domain === "beta-soft.example")).toBe(false);
    expect(emailCalls(calls)).toHaveLength(4);
    const entry = result.lookupLog!.entries.find((e) => e.endpoint === "treg.people.email.find" && e.mailboxDomain === "beta-soft.example")!;
    expect(entry).toMatchObject({ outcome: "no_mx", mailServer: "a", mailboxDomain: "beta-soft.example", calls: 0, status: 0, costUsd: 0, attempt: "domain_and_name" });
    expect(result.lookupLog!.summary).toMatchObject({ noMx: 1 });
    expect(result.rows.filter((row) => row.work_email)).toHaveLength(3);
    // the charge: the search, four first lookups (20 000 each, found), and three checks (400 each); the no-MX person adds nothing
    expect(result.costMicro).toBe(380 + 4 * 20_000 + 3 * 400);
    expect(JSON.stringify(result.lookupLog)).not.toContain("@");
  });

  it("a null MX («0 .») is no mail server either: no paid lookup", async () => {
    mailStatus["beta-soft.example"] = "none"; // a null MX («0 .»): the resolver answers none
    setMailDomainResolverForTesting(statusOf);
    const calls = gateway();
    const result = await defaultTregAdapter(input() as any);
    expect(emailCalls(calls).some((call) => call.body.domain === "beta-soft.example")).toBe(false);
    expect(result.lookupLog!.entries.find((e) => e.mailboxDomain === "beta-soft.example")).toMatchObject({ outcome: "no_mx", calls: 0 });
    expect(result.lookupLog!.entries.find((e) => e.mailboxDomain === "beta-soft.example")).not.toHaveProperty("mailServer");
  });

  it("a company domain WITH a mail server (MX): the paid lookup proceeds, and the address is delivered", async () => {
    setMailDomainResolverForTesting(statusOf);
    const calls = gateway();
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1) }) as any);
    expect(firstEmailCalls(calls).map((call) => call.body.domain)).toContain("alpha-soft.example");
    expect(result.rows.find((row) => row.work_email)?.work_email).toBe("alaa@alpha-soft.example");
  });

  it("the address that comes back is checked the same way: a found address on a domain with an address record only is kept out (charged by the provider, not delivered)", async () => {
    setMailDomainResolverForTesting(async (domain) => (domain === "other-mail.example" ? "a" : "mx"));
    const endpoints: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const endpoint = String(url).split("/call/")[1];
      const body = JSON.parse(String(init.body));
      endpoints.push(endpoint);
      const out = endpoint === "icypeas.people.search" ? answerOf([LEADS[0]])
        : endpoint === "treg.people.email.find" ? { output: { email: "alaa@other-mail.example", first_name: body.first_name, last_name: body.last_name } }
        : { output: { phone: null } };
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", "x-treg-call-id": "c", "x-treg-cost-micro": "0" } });
    }));
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1) }) as any);
    expect(result.rows[0].work_email).toBe("");
    expect(result.lookupLog!.entries.find((e) => e.endpoint === "treg.people.email.find")).toMatchObject({ outcome: "no_mx", mailServer: "a", mailboxDomain: "other-mail.example", calls: 1 });
    expect(result.lookupLog!.summary).toMatchObject({ noMx: 1, verifyCalls: 0 });
    expect(endpoints.includes("treg.people.email.verify")).toBe(false);
  });
});

describe("a DNS check that cannot answer never blocks a lookup (fail open)", () => {
  it("the check times out (unknown): the lookup is made and the address delivered; the real resolver's timeout is «unknown» in tests/decision-makers-final-fix.test.ts", async () => {
    mailStatus["alpha-soft.example"] = "unknown"; // the check timed out: unknown, never a reason to keep the address out
    setMailDomainResolverForTesting(statusOf);
    const calls = gateway();
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1) }) as any);
    expect(firstEmailCalls(calls).map((call) => call.body.domain)).toContain("alpha-soft.example");
    expect(result.rows.find((row) => row.work_email)?.work_email).toBe("alaa@alpha-soft.example");
    expect(result.lookupLog!.entries.find((e) => e.endpoint === "treg.people.email.find")).toMatchObject({ outcome: "hit", mailServer: "unknown" });
  });

  it("the check itself throws for every domain: the lookups are made, the addresses are delivered, nothing is logged as no_mx", async () => {
    setMailDomainResolverForTesting(async () => { throw new Error("resolver down"); });
    const calls = gateway();
    const result = await defaultTregAdapter(input() as any);
    expect(emailCalls(calls)).toHaveLength(5);
    expect(result.rows.filter((row) => row.work_email)).toHaveLength(3);
    expect(result.lookupLog!.summary).toMatchObject({ noMx: 0 });
  });
});

describe("the first email of every eligible person comes first: five eligible, three wanted", () => {
  it("all five first lookups start together, before any check, phone or fallback; the slow one does not hold the others", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    // Elias's email is the slow one (120 ms); the check and the phone of the others must wait for it, as the first emails of all five come first
    const calls = gateway((endpoint, body) => (endpoint === "treg.people.email.find" && body.first_name === "Elias" ? 120 : 10));
    await defaultTregAdapter(input() as any);
    const firsts = firstEmailCalls(calls);
    expect(firsts).toHaveLength(5);
    const checksAndPhones = calls.filter((call) => call.endpoint === "treg.people.email.verify" || call.endpoint === "treg.people.phone.find");
    expect(checksAndPhones.length).toBeGreaterThan(0);
    // the checks and phones start only after the slow first email (120 ms) has ended
    expect(Math.min(...checksAndPhones.map((call) => call.at))).toBeGreaterThanOrEqual(110);
    expect(Math.max(...firsts.map((call) => call.at))).toBeLessThan(Math.min(...checksAndPhones.map((call) => call.at)));
    const lastFirstStart = Math.max(...firsts.map((call) => call.at));
    // all five start within a few milliseconds of each other: none waits for another's answer before its first try
    expect(lastFirstStart - Math.min(...firsts.map((call) => call.at))).toBeLessThan(60);
  });

  it("every first lookup is made with the time it needs: the timeline constants leave the first emails their window", () => {
    // Worst case, all five first lookups wait the whole email limit: they start at 0 and end by PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS (25 s); the people lookups stop
    // starting at 45 s - 12 s = 33 s, so the first lookups fit with 8 s to spare for the checks and phones of the three still needed.
    expect(PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS).toBe(25_000);
    expect(PEOPLE_LOOKUP_RESERVE_MS).toBe(12_000);
    const route = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(route).toContain("const deadlineMs = routeStart + 45_000;");
    expect(route).toContain("export const maxDuration = 60;");
    // no limit is raised: the dispatcher still waits 55 s, below the accept route's 60 s
    expect(WORKER_DISPATCH_TIMEOUT_MS).toBe(55_000);
    expect(45_000 - PEOPLE_LOOKUP_RESERVE_MS).toBeGreaterThanOrEqual(PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS);
  });
});

describe("the spend ceiling holds with every first lookup in flight", () => {
  it("five first lookups at the full 0.02 ceiling, every one found, every check at 0.005: the job stays at or under 0.115 USD", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const calls = gateway(() => 0, 20_000);
    const result = await defaultTregAdapter(input() as any);
    const ceiling = Math.round(decisionMakerJobSpendCeilingUsd(3) * 1e6);
    expect(result.costMicro).toBeLessThanOrEqual(ceiling);
    expect(result.costMicro).toBe(calls.reduce((total, call) => total + call.costMicro, 0));
    expect(firstEmailCalls(calls)).toHaveLength(5);
    expect(result.lookupLog!.summary.skippedBudget).toBeGreaterThanOrEqual(0);
  });
});
