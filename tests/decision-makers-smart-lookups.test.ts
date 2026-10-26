import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Decision makers, smarter lookups (PR #253): SIMULATION only. The REAL client and adapter run against a stubbed `fetch` that answers in the payload shapes
 * the live jobs showed (`{output, raw, _treg: {served_by, tried, charged_micro}}`, the charge in `X-Treg-Cost-Micro`, a replay's charge in
 * `X-Treg-Original-Cost-Micro`, HTTP 409 while the first call is still running). No network, nothing paid.
 *   (a) a personal address first, a company-domain address on the one retry without the profile link
 *   (b) 409 then success on a later read: delivered once, charged once; the first attempt is logged apart
 *   (c) per-row reason codes in the log, with no personal value
 *   (d) the budget ceiling is never passed by the retry
 *   (e) the mailbox DOMAIN of a discarded personal address is logged, never the address
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

import { defaultTregAdapter, PEOPLE_LOOKUP_REPLAY_WAIT_MS, PEOPLE_LOOKUP_REREAD_WAIT_MS } from "../src/lib/server/tregAdapter";
import { decisionMakerJobSpendCeilingUsd } from "../src/lib/server/decisionMakerSpend";
import { decisionMakerChargePoints, decisionMakerDeliveredUnits, DECISION_MAKER_UNIT_PRICES_POINTS } from "../src/functions/shared/decisionMakerPricing";

const PARAMS = { limit: 3, title: "CEO", country: "EG", keywords: ["information technology", "software", "technology"], requiredContactFields: ["work_email", "phone"], contactFieldsToAttempt: ["work_email", "phone"] };
const lead = (extra: Record<string, any>) => ({
  firstname: "", lastname: "", headline: "", description: "", profileUrl: "", lastJobTitle: "CEO", lastJobDescription: "", lastJobStartDate: "2019-03",
  address: "Cairo, Egypt", lastCompanyName: "", lastCompanyUrl: "", lastCompanyWebsite: "", lastCompanyDescription: "Software and cloud technology", lastCompanySize: "11-50",
  lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt", ...extra,
});
const profile = (first: string, last: string) => `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}`;
const person = (first: string, last: string, extra: Record<string, any> = {}) => lead({
  firstname: first, lastname: last, profileUrl: profile(first, last), lastCompanyName: `${last} Software`, lastCompanyWebsite: `https://${last.toLowerCase()}-soft.example`, ...extra,
});
const answerOf = (leads: any[]) => ({ total: 2560, success: true, leads, pagination: { token: "next", size: leads.length } });

interface Call { endpoint: string; body: any; headers: Record<string, string>; attempt: number }
type Answer = { cost?: number; originalCost?: number; body?: any; status?: number; timeout?: boolean };

/** The gateway as the client sees it. `attempt` counts the calls with the same idempotency key (a read of the same key is attempt 2, 3, ...). */
function gateway(handler: (call: Call) => Answer) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const headers = { ...(init.headers as Record<string, string>) };
    const key = headers["Idempotency-Key"] || `${url}:${calls.length}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const call: Call = { endpoint: String(url).split("/call/")[1], body: JSON.parse(String(init.body)), headers, attempt };
    calls.push(call);
    const out = handler(call);
    if (out.timeout) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json", "x-treg-call-id": `call_${calls.length}`, "x-treg-cost-micro": String(out.cost ?? 0), ...(out.originalCost ? { "x-treg-original-cost-micro": String(out.originalCost) } : {}) },
    });
  }));
  return calls;
}
const isSearch = (call: Call) => call.endpoint === "icypeas.people.search";
const isEmail = (call: Call) => call.endpoint === "treg.people.email.find";
const isPhone = (call: Call) => call.endpoint === "treg.people.phone.find";
const emailBody = (call: Call, address: string | null, servedBy: string, charged: number) => ({
  output: { email: address, first_name: call.body.first_name, last_name: call.body.last_name },
  raw: { status: address ? "valid" : "none" },
  _treg: { served_by: servedBy, tried: ["quickenrich.people.email.find", servedBy], charged_micro: charged },
});
const phoneMiss = { output: { phone: null }, _treg: { served_by: null, tried: Array(15).fill("p") } };

const input = (extra: Record<string, any> = {}) => ({
  jobId: "job_quote_smart", userId: "user_smart", step: 0, endpointId: "treg.people.search", capabilitySlug: "professional-people-search", method: "POST" as const,
  params: PARAMS, paginationStrategy: "none" as const, cursor: null, pageSize: 3, remainingNeeded: 1, targetVolumeMax: 1, deliveredSoFar: 0, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1), ...extra,
});

/** The wait before a read is a timer: the test lets it pass at once and records its length (only `setTimeout` is faked, `Date.now` stays real). */
async function withFastWaits<T>(run: () => Promise<T>): Promise<{ value: T; waits: number[] }> {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const waits: number[] = [];
  const fake = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: any, ms?: number, ...rest: any[]) => { if ((ms ?? 0) >= 1_000) waits.push(ms!); return (fake as any)(handler, ms, ...rest); }) as any;
  try {
    const pending = run();
    await vi.advanceTimersByTimeAsync(60_000);
    return { value: await pending, waits };
  } finally {
    globalThis.setTimeout = fake;
    vi.useRealTimers();
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("(a) a personal address first, a company-domain address on the one retry without the profile link", () => {
  const mona = person("Mona", "Delta");
  const run = async () => {
    const calls = gateway((call) => {
      if (isSearch(call)) return { cost: 380, body: answerOf([mona]) };
      if (isEmail(call) && call.body.linkedin_url) return { cost: 8900, body: emailBody(call, "mona.private@gmail.com", "tomba.people.email.find.linkedin", 8900) };
      if (isEmail(call)) return { cost: 8900, body: emailBody(call, "mona@delta-soft.example", "tomba.people.email.find", 8900) };
      return { body: phoneMiss };
    });
    const result = await defaultTregAdapter(input() as any);
    return { calls, result };
  };

  it("the profile-link lookup is answered with a personal address, the retry (domain + names, no link) with a company address: delivered once", async () => {
    const { calls, result } = await run();
    const emailCalls = calls.filter(isEmail);
    expect(emailCalls).toHaveLength(2);
    expect(Object.keys(emailCalls[0].body).sort()).toEqual(["domain", "first_name", "full_name", "last_name", "linkedin_url"]);
    expect(Object.keys(emailCalls[1].body).sort()).toEqual(["domain", "first_name", "full_name", "last_name"]);
    // a different idempotency key and step key; the same ceiling; no prefer/exclude header
    expect(emailCalls[1].headers["Idempotency-Key"]).not.toBe(emailCalls[0].headers["Idempotency-Key"]);
    expect(emailCalls[0].headers["Idempotency-Key"]).toContain("people_email_0_");
    expect(emailCalls[1].headers["Idempotency-Key"]).toContain("people_email_retry_0_");
    for (const call of emailCalls) {
      expect(call.headers["X-Treg-Route-Max-Cost"]).toBe("0.02");
      expect(Object.keys(call.headers).some((name) => /prefer|exclude/i.test(name))).toBe(false);
    }
    const row = result.rows[0];
    expect(row.work_email).toBe("mona@delta-soft.example");
    expect(result.rows.filter((r) => r.work_email)).toHaveLength(1);
    // the provider billed both lookups (380 search + 2 x 8,900); the customer is charged for ONE delivered email by the existing per-field rule
    expect(result.costMicro).toBe(380 + 2 * 8900);
    const units = decisionMakerDeliveredUnits([row], ["work_email", "phone"]);
    expect(units).toEqual({ baseUnits: 1, emailUnits: 1, phoneUnits: 0 });
    expect(decisionMakerChargePoints(units, DECISION_MAKER_UNIT_PRICES_POINTS)).toBe(83 + 120);
  });

  it("the log: the personal lookup (with its mailbox domain), then the retry flagged and a hit; the summary counts the retry", async () => {
    const { result } = await run();
    const emails = result.lookupLog!.entries.filter((e) => e.endpoint === "treg.people.email.find");
    expect(emails).toHaveLength(2);
    expect(emails[0]).toMatchObject({ outcome: "personal_email", mailboxDomain: "gmail.com", servedBy: "tomba.people.email.find.linkedin", costUsd: 0.0089, emailPresent: false });
    expect(emails[0].keys).toEqual(["domain", "first_name", "full_name", "last_name", "linkedin_url"]);
    expect(emails[0]).not.toHaveProperty("attempt");
    expect(emails[1]).toMatchObject({ outcome: "hit", attempt: "retry_without_profile_link", servedBy: "tomba.people.email.find", costUsd: 0.0089, emailPresent: true });
    expect(emails[1].keys).toEqual(["domain", "first_name", "full_name", "last_name"]);
    expect(emails[1].step).toMatch(/^people_email_retry_0_\d+$/);
    expect(result.lookupLog!.summary).toMatchObject({ personalRetries: 1, withContact: 1 });
    const kept = JSON.stringify(result.lookupLog);
    for (const secret of ["mona.private", "mona@", "delta-soft", "Mona", "Delta", "linkedin.com", "test-token-not-a-secret"]) expect(kept, secret).not.toContain(secret);
  });

  it("no retry after any other outcome (a miss, a mismatch), nor when the person has no company domain or the answer is already a work address", async () => {
    const noDomain = person("Rania", "Ayman", { lastCompanyWebsite: "https://linktr.ee/x" });
    const calls = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([noDomain]) } : isEmail(call) ? { cost: 8900, body: emailBody(call, "rania.private@yahoo.co.uk", "tomba.people.email.find.linkedin", 8900) } : { body: phoneMiss }));
    const result = await defaultTregAdapter(input() as any);
    expect(calls.filter(isEmail)).toHaveLength(1); // personal, but no domain and name to retry with
    expect(result.lookupLog!.entries.find(isEntryEmail)).toMatchObject({ outcome: "personal_email", mailboxDomain: "yahoo.co.uk" });
    expect(result.lookupLog!.summary.personalRetries ?? 0).toBe(0);

    const missed = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([mona]) } : isEmail(call) ? { body: emailBody(call, null, "x", 0) } : { body: phoneMiss }));
    await defaultTregAdapter(input() as any);
    expect(missed.filter(isEmail)).toHaveLength(1);

    const wrong = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([mona]) } : isEmail(call) ? { cost: 8900, body: { output: { email: "someone@other.example", first_name: "Karim", last_name: "Nabil" } } } : { body: phoneMiss }));
    const wrongResult = await defaultTregAdapter(input() as any);
    expect(wrong.filter(isEmail)).toHaveLength(1);
    expect(wrongResult.lookupLog!.entries.find(isEntryEmail)!.outcome).toBe("mismatch");
  });
});
const isEntryEmail = (entry: { endpoint: string }) => entry.endpoint === "treg.people.email.find";

describe("(b) 409 then success on a later read: delivered once, charged once; the first attempt is logged apart", () => {
  const mona = person("Mona", "Delta");
  it("the waits of a person lookup: 8 s before the first read, 4 s before one more after a 409", () => {
    expect([PEOPLE_LOOKUP_REPLAY_WAIT_MS, PEOPLE_LOOKUP_REREAD_WAIT_MS]).toEqual([8_000, 4_000]);
  });

  it("the first call is cut by OUR limit, the first read says 409 (still running), the second read has the answer: one email, charged once, never a failure", async () => {
    const calls = gateway((call) => {
      if (isSearch(call)) return { cost: 380, body: answerOf([mona]) };
      if (isPhone(call)) return { body: phoneMiss };
      if (call.attempt === 1) return { timeout: true };
      if (call.attempt === 2) return { status: 409, body: { error: "in_flight" } };
      // the stored result: cost 0, the first call's charge in the original-cost header
      return { cost: 0, originalCost: 8900, body: emailBody(call, "mona@delta-soft.example", "tomba.people.email.find", 8900) };
    });
    const { value: result, waits } = await withFastWaits(() => defaultTregAdapter(input({ deadlineMs: Date.now() + 100_000 }) as any));
    expect(result.ok).toBe(true);
    const emailCalls = calls.filter(isEmail);
    expect(emailCalls).toHaveLength(3);
    expect(new Set(emailCalls.map((call) => call.headers["Idempotency-Key"])).size).toBe(1); // the same key: read, never bought again
    expect(waits).toEqual([PEOPLE_LOOKUP_REPLAY_WAIT_MS, PEOPLE_LOOKUP_REREAD_WAIT_MS]);
    expect(result.rows[0].work_email).toBe("mona@delta-soft.example");
    expect(result.costMicro).toBe(380 + 8900); // charged once
    const entry = result.lookupLog!.entries.find(isEntryEmail)!;
    expect(entry).toMatchObject({ outcome: "hit", status: 200, calls: 3, emailPresent: true });
    expect(entry.firstAttempt).toMatchObject({ cut: true });
    expect(entry.reads!.map((read) => read.status)).toEqual([409, 200]);
    expect(decisionMakerChargePoints(decisionMakerDeliveredUnits(result.rows, ["work_email", "phone"]), DECISION_MAKER_UNIT_PRICES_POINTS)).toBe(83 + 120);
  });

  it("a 409 on the FIRST call (not cut by us) is logged as such, and 409 on every read ends as «timeout»: no failure, no charge", async () => {
    gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([mona]) } : isEmail(call) ? { status: 409, body: { error: "in_flight" } } : { body: phoneMiss }));
    const { value: result } = await withFastWaits(() => defaultTregAdapter(input({ deadlineMs: Date.now() + 100_000 }) as any));
    expect(result.ok).toBe(true);
    const entry = result.lookupLog!.entries.find(isEntryEmail)!;
    expect(entry).toMatchObject({ outcome: "timeout", status: 409, calls: 3 });
    expect(entry.firstAttempt).toMatchObject({ status: 409, cut: false });
    expect(entry.reads).toHaveLength(2);
    expect(result.costMicro).toBe(380);
    expect(result.rows.every((row) => row.work_email === "")).toBe(true);
  });

  it("the worker's deadline is respected: with too little time left there is no read after the first call (a read needs 8 s + 3 s and 6 s are kept for saving)", async () => {
    const calls = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([mona]) } : isEmail(call) ? { status: 409, body: { error: "in_flight" } } : { body: phoneMiss }));
    const result = await defaultTregAdapter(input({ deadlineMs: Date.now() + 15_000 }) as any);
    expect(calls.filter(isEmail)).toHaveLength(1);
    expect(result.lookupLog!.entries.find(isEntryEmail)).toMatchObject({ outcome: "timeout", calls: 1 });
    expect(result.lookupLog!.entries.find(isEntryEmail)).not.toHaveProperty("reads");
  });
});

describe("(c) per-row reason codes in the log, with no personal value", () => {
  // nine people with the shapes of the live answer: three that can be looked up, and the six reasons a row is turned away or ends with nothing
  const LEADS = [
    person("Mona", "Delta"), //                                                    0 looked up, work email found
    person("Nour", "Adel"), //                                                     1 looked up, nothing found -> no_contact
    person("Omar", "Hassan"), //                                                   2 looked up, an address of someone else -> mismatch
    person("Salma", "Farid", { lastCompanyAddress: "Dubai, United Arab Emirates" }), // 3 company in another country -> out_of_scope
    person("Yusuf", "Ali", { lastCompanyName: "Ali Academy", lastCompanyDescription: "Schools and training programmes" }), // 4 no sign of the activity -> no_evidence
    person("Hana", "Gad", { lastCompanyName: "Gad Group", lastCompanyDescription: "" }), //                        5 nothing to judge by -> no_evidence
    person("Karim", "Nabil", { address: "Manama, Bahrain" }), //                     6 the person's own address is another country -> out_of_scope
    person("Rasha", "Azhry", { profileUrl: "", lastCompanyWebsite: "" }), //         7 matches, but no profile link and no domain -> identity_null
    person("Youssef", "Sami"), //                                                  8 looked up, a personal address (and no domain-based answer) -> personal_email
  ];
  const run = async () => {
    const calls = gateway((call) => {
      if (isSearch(call)) return { cost: 3420, body: answerOf(LEADS) };
      if (isPhone(call)) return { body: phoneMiss };
      const first = call.body.first_name;
      if (first === "Mona") return { cost: 8900, body: emailBody(call, "mona@delta-soft.example", "tomba.people.email.find", 8900) };
      if (first === "Omar") return { cost: 8900, body: { output: { email: "x@other.example", first_name: "Karim", last_name: "Nabil" } } };
      if (first === "Youssef") return { cost: 8900, body: emailBody(call, "y.private@outlook.com", "tomba.people.email.find.linkedin", 8900) };
      return { body: emailBody(call, null, "none", 0) };
    });
    const result = await defaultTregAdapter(input({ remainingNeeded: 9, targetVolumeMax: 9, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(9) }) as any);
    return { calls, result };
  };

  it("every row has the person index, the gate verdict, the rule that kept it out, the identity booleans and its final reason", async () => {
    const { result } = await run();
    const rows = result.lookupLog!.rows!;
    expect(rows).toHaveLength(9);
    const by = (at: number) => rows.find((row) => row.person === at)!;
    expect(by(0)).toMatchObject({ gate: "match", hasDomain: true, hasProfileLink: true, identityNull: false, lookedUp: true, finalReason: "contact" });
    expect(by(1)).toMatchObject({ gate: "match", lookedUp: true, finalReason: "no_contact" });
    expect(by(2)).toMatchObject({ gate: "match", lookedUp: true, finalReason: "mismatch" });
    expect(by(3)).toMatchObject({ gate: "uncertain", reasonCode: "out_of_scope", lookedUp: false, finalReason: "out_of_scope" });
    expect(by(4)).toMatchObject({ gate: "uncertain", reasonCode: "no_evidence", lookedUp: false, finalReason: "no_evidence" });
    expect(by(5)).toMatchObject({ gate: "uncertain", reasonCode: "no_evidence", lookedUp: false, finalReason: "no_evidence" });
    expect(by(6)).toMatchObject({ gate: "no_match", reasonCode: "out_of_scope", lookedUp: false, finalReason: "out_of_scope" });
    expect(by(7)).toMatchObject({ gate: "match", hasDomain: false, hasProfileLink: false, identityNull: true, lookedUp: false, finalReason: "identity_null" });
    expect(by(8)).toMatchObject({ gate: "match", lookedUp: true, finalReason: "personal_email" });
    expect(result.lookupLog!.summary).toMatchObject({ rows: 9, eligible: 5, noIdentity: 1, lookedUp: 4, withContact: 1 });
  });

  it("nothing personal is kept: no name, address, domain, link or token; only codes, booleans, indexes and the mailbox domain of a discarded personal address", async () => {
    const { result } = await run();
    const kept = JSON.stringify(result.lookupLog);
    for (const secret of ["Mona", "Delta", "Nour", "Adel", "Omar", "Hassan", "Youssef", "Sami", "mona@", "y.private", "x@other", "delta-soft", "linkedin.com", "Cairo", "Dubai", "test-token-not-a-secret"]) {
      expect(kept, secret).not.toContain(secret);
    }
    expect(result.lookupLog!.entries.find((e) => e.outcome === "personal_email")!.mailboxDomain).toBe("outlook.com");
    for (const row of result.lookupLog!.rows!) expect(Object.keys(row).sort()).toEqual(expect.arrayContaining(["finalReason", "gate", "hasDomain", "hasProfileLink", "identityNull", "lookedUp", "person"]));
  });

  it("the worker stores the rows in the same internal event (never shown to a customer)", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/app/api/worker/chunk/route.ts", "utf8")).toContain("rows: rawAdapterResult.lookupLog.rows ?? []");
  });
});

describe("(d) the job's budget ceiling is never passed, retries included", () => {
  const TEN = ["Mona", "Nour", "Omar", "Salma", "Yusuf", "Hana", "Karim", "Rasha", "Youssef"].map((first, at) => person(first, `Lastname${at}`));

  it("every email is a personal address billing the whole 0.02 and every retry too: the spend stays at or under 0.04 + 0.02 x 3 = 0.10 USD and the rest are skipped for budget", async () => {
    const costs: number[] = [];
    const calls = gateway((call) => {
      const cost = isSearch(call) ? 3420 : isEmail(call) ? 20000 : 0;
      costs.push(cost);
      if (isSearch(call)) return { cost, body: answerOf(TEN) };
      if (isEmail(call)) return { cost, body: emailBody(call, `${String(call.body.first_name).toLowerCase()}@gmail.com`, "tomba.people.email.find.linkedin", cost) };
      return { body: phoneMiss };
    });
    const result = await defaultTregAdapter(input({ remainingNeeded: 3, targetVolumeMax: 3, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(3) }) as any);
    const spent = costs.reduce((total, cost) => total + cost, 0);
    expect(result.costMicro).toBe(spent);
    expect(spent).toBeLessThanOrEqual(Math.round(decisionMakerJobSpendCeilingUsd(3) * 1e6));
    expect(calls.filter(isEmail).some((call) => !call.body.linkedin_url)).toBe(true); // retries were made while the budget allowed
    expect(result.lookupLog!.summary.skippedBudget).toBeGreaterThan(0);
    expect(result.lookupLog!.summary.personalRetries).toBeGreaterThan(0);
  });

  it("with a budget that holds the first lookup but not the retry, the retry is skipped (never reserved above the ceiling) and counted as skipped for budget", async () => {
    const calls = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([TEN[0]]) } : isEmail(call) ? { cost: 8900, body: emailBody(call, "x@gmail.com", "tomba.people.email.find.linkedin", 8900) } : { body: phoneMiss }));
    // a ceiling of 0.025: after the search (0.00038) and the first email (0.0089 spent) 0.0157 is left, which cannot hold the retry's own 0.02 ceiling
    const result = await defaultTregAdapter(input({ decisionMakerSpendBudgetUsd: 0.025 }) as any);
    const spent = result.costMicro;
    expect(spent).toBeLessThanOrEqual(25_000);
    expect(calls.filter(isEmail)).toHaveLength(1);
    expect(result.lookupLog!.summary.personalRetries).toBe(1);
    expect(result.lookupLog!.summary.skippedBudget).toBeGreaterThanOrEqual(1);
  });
});

describe("(e) the mailbox domain of a discarded personal address is logged, never the address", () => {
  it("gmail.com, yahoo.co.uk and outlook.com are kept as domains only", async () => {
    for (const [address, domain] of [["a.b@gmail.com", "gmail.com"], ["a.b@Yahoo.co.uk", "yahoo.co.uk"], ["a.b@outlook.com", "outlook.com"]] as const) {
      gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([person("Mona", "Delta", { lastCompanyWebsite: "" })]) } : isEmail(call) ? { cost: 8900, body: emailBody(call, address, "tomba.people.email.find.linkedin", 8900) } : { body: phoneMiss }));
      const result = await defaultTregAdapter(input() as any);
      const entry = result.lookupLog!.entries.find(isEntryEmail)!;
      expect(entry).toMatchObject({ outcome: "personal_email", mailboxDomain: domain });
      expect(JSON.stringify(result.lookupLog)).not.toContain("a.b");
    }
  });
});
