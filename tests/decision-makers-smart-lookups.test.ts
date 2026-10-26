import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Decision makers, smarter lookups (PR #253): SIMULATION only. The REAL client and adapter run against a stubbed `fetch` that answers in the payload shapes
 * the live jobs showed (`{output, raw, _treg: {served_by, tried, charged_micro}}`, the charge in `X-Treg-Cost-Micro`, a replay's charge in
 * `X-Treg-Original-Cost-Micro`, HTTP 409 while the first call is still running). No network, nothing paid.
 *   (a) the first email lookup is made from the company domain and the names (no profile link); the profile link only after a miss, or when no domain exists
 *   (b) 409 then success on a later read: delivered once, charged once; the first attempt is logged apart
 *   (c) per-row reason codes in the log, with no personal value
 *   (d) the budget ceiling is never passed by the profile-link fallback
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
const isVerify = (call: Call) => call.endpoint === "treg.people.email.verify";
/** The deliverability check of a found address: valid (free in these fixtures, so the lookup charges stay exact). */
const validAnswer = { body: { output: { status: "valid" } } };
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

describe("(a) the first email lookup is the company domain and the names; the profile link only after a miss, or when no domain exists", () => {
  const mona = person("Mona", "Delta");
  const KEYS_NO_LINK = ["domain", "first_name", "full_name", "last_name"];
  const KEYS_WITH_LINK = ["domain", "first_name", "full_name", "last_name", "linkedin_url"];

  it("the first lookup carries the domain and the names (no profile link) and is answered with a work address: ONE email lookup, delivered once, charged by the per-field rule", async () => {
    const calls = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([mona]) } : isEmail(call) ? { cost: 8900, body: emailBody(call, "mona@delta-soft.example", "tomba.people.email.find", 8900) } : isVerify(call) ? validAnswer : { body: phoneMiss }));
    const result = await defaultTregAdapter(input() as any);
    const emailCalls = calls.filter(isEmail);
    expect(emailCalls).toHaveLength(1);
    expect(Object.keys(emailCalls[0].body).sort()).toEqual(KEYS_NO_LINK);
    expect(emailCalls[0].headers["Idempotency-Key"]).toContain("people_email_0_");
    expect(emailCalls[0].headers["X-Treg-Route-Max-Cost"]).toBe("0.02");
    expect(Object.keys(emailCalls[0].headers).some((name) => /prefer|exclude/i.test(name))).toBe(false);
    expect(result.rows.filter((r) => r.work_email)).toHaveLength(1);
    expect(result.rows[0].work_email).toBe("mona@delta-soft.example");
    expect(result.costMicro).toBe(380 + 8900);
    const units = decisionMakerDeliveredUnits([result.rows[0]], ["work_email", "phone"]);
    expect(units).toEqual({ baseUnits: 1, emailUnits: 1, phoneUnits: 0 });
    expect(decisionMakerChargePoints(units, DECISION_MAKER_UNIT_PRICES_POINTS)).toBe(83 + 120);
    expect(result.lookupLog!.summary).toMatchObject({ linkFallbacks: 0, withContact: 1 });
  });

  const missThenLink = async () => {
    const calls = gateway((call) => {
      if (isSearch(call)) return { cost: 380, body: answerOf([mona]) };
      if (isEmail(call) && !call.body.linkedin_url) return { body: emailBody(call, null, "none", 0) }; // a free miss
      if (isEmail(call)) return { cost: 8900, body: emailBody(call, "mona@delta-soft.example", "tomba.people.email.find.linkedin", 8900) };
      return isVerify(call) ? validAnswer : { body: phoneMiss };
    });
    const result = await defaultTregAdapter(input() as any);
    return { calls, result };
  };

  it("after a MISS the profile-link lookup follows: its own idempotency key, the same ceiling, no prefer/exclude header; delivered once", async () => {
    const { calls, result } = await missThenLink();
    const emailCalls = calls.filter(isEmail);
    expect(emailCalls).toHaveLength(2);
    expect(Object.keys(emailCalls[0].body).sort()).toEqual(KEYS_NO_LINK);
    expect(Object.keys(emailCalls[1].body).sort()).toEqual(KEYS_WITH_LINK);
    expect(emailCalls[1].headers["Idempotency-Key"]).not.toBe(emailCalls[0].headers["Idempotency-Key"]);
    expect(emailCalls[0].headers["Idempotency-Key"]).toContain("people_email_0_");
    expect(emailCalls[1].headers["Idempotency-Key"]).toContain("people_email_link_0_");
    for (const call of emailCalls) {
      expect(call.headers["X-Treg-Route-Max-Cost"]).toBe("0.02");
      expect(Object.keys(call.headers).some((name) => /prefer|exclude/i.test(name))).toBe(false);
    }
    expect(result.rows.filter((r) => r.work_email)).toHaveLength(1);
    expect(result.costMicro).toBe(380 + 8900);
  });

  it("the log: the first lookup (domain_and_name, a miss), then the fallback (profile_link_fallback, a hit); the summary counts the fallback", async () => {
    const { result } = await missThenLink();
    const emails = result.lookupLog!.entries.filter((e) => e.endpoint === "treg.people.email.find");
    expect(emails).toHaveLength(2);
    expect(emails[0]).toMatchObject({ outcome: "miss", attempt: "domain_and_name", emailPresent: false });
    expect(emails[0].keys).toEqual(KEYS_NO_LINK);
    expect(emails[1]).toMatchObject({ outcome: "hit", attempt: "profile_link_fallback", servedBy: "tomba.people.email.find.linkedin", costUsd: 0.0089, emailPresent: true });
    expect(emails[1].keys).toEqual(KEYS_WITH_LINK);
    expect(emails[1].step).toMatch(/^people_email_link_0_\d+$/);
    expect(result.lookupLog!.summary).toMatchObject({ linkFallbacks: 1, withContact: 1 });
    const kept = JSON.stringify(result.lookupLog);
    for (const secret of ["mona@", "delta-soft", "Mona", "Delta", "linkedin.com", "test-token-not-a-secret"]) expect(kept, secret).not.toContain(secret);
  });

  it("a PERSONAL address from the first lookup is billed and discarded and never retried; no domain means the profile link is the first lookup; a mismatch is not retried either", async () => {
    const personal = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([mona]) } : isEmail(call) ? { cost: 8900, body: emailBody(call, "mona.private@gmail.com", "tomba.people.email.find", 8900) } : { body: phoneMiss }));
    const personalResult = await defaultTregAdapter(input() as any);
    expect(personal.filter(isEmail)).toHaveLength(1);
    expect(personal.filter(isVerify)).toHaveLength(0); // a personal address is never checked
    expect(personalResult.lookupLog!.entries.find(isEntryEmail)).toMatchObject({ outcome: "personal_email", mailboxDomain: "gmail.com", attempt: "domain_and_name" });
    expect(personalResult.rows[0].work_email).toBe("");
    expect(personalResult.lookupLog!.summary.linkFallbacks ?? 0).toBe(0);

    const noDomain = person("Rania", "Ayman", { lastCompanyWebsite: "https://linktr.ee/x" });
    const linkFirst = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([noDomain]) } : isEmail(call) ? { cost: 8900, body: emailBody(call, "rania.private@yahoo.co.uk", "tomba.people.email.find.linkedin", 8900) } : { body: phoneMiss }));
    const linkResult = await defaultTregAdapter(input() as any);
    expect(linkFirst.filter(isEmail)).toHaveLength(1);
    expect(Object.keys(linkFirst.filter(isEmail)[0].body).sort()).toEqual(["first_name", "full_name", "last_name", "linkedin_url"]); // all there is
    expect(linkResult.lookupLog!.entries.find(isEntryEmail)).toMatchObject({ outcome: "personal_email", mailboxDomain: "yahoo.co.uk", attempt: "profile_link" });

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
      if (isVerify(call)) return validAnswer;
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

  it("the worker's deadline is respected: with too little time left there is no read after the first call (a read needs 8 s + 3 s and 12 s are kept for saving and settling)", async () => {
    const calls = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([mona]) } : isEmail(call) ? { status: 409, body: { error: "in_flight" } } : { body: phoneMiss }));
    const result = await defaultTregAdapter(input({ deadlineMs: Date.now() + 21_000 }) as any);
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
      if (isVerify(call)) return validAnswer;
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

describe("(d) the job's budget ceiling is never passed, profile-link fallbacks included", () => {
  const TEN = ["Mona", "Nour", "Omar", "Salma", "Yusuf", "Hana", "Karim", "Rasha", "Youssef"].map((first, at) => person(first, `Lastname${at}`));

  it("every email lookup bills the whole 0.02 and finds nothing, so every profile-link fallback is made too: the spend stays at or under 0.04 + (0.02 + 0.005) x 3 = 0.115 USD and the rest are skipped for budget", async () => {
    const costs: number[] = [];
    const calls = gateway((call) => {
      const cost = isSearch(call) ? 3420 : isEmail(call) ? 20000 : 0;
      costs.push(cost);
      if (isSearch(call)) return { cost, body: answerOf(TEN) };
      if (isEmail(call)) return { cost, body: emailBody(call, null, "none", cost) };
      return { body: phoneMiss };
    });
    const result = await defaultTregAdapter(input({ remainingNeeded: 3, targetVolumeMax: 3, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(3) }) as any);
    const spent = costs.reduce((total, cost) => total + cost, 0);
    expect(result.costMicro).toBe(spent);
    expect(spent).toBeLessThanOrEqual(Math.round(decisionMakerJobSpendCeilingUsd(3) * 1e6));
    expect(calls.filter(isEmail).some((call) => call.body.linkedin_url)).toBe(true); // fallbacks were made while the budget allowed
    expect(result.lookupLog!.summary.skippedBudget).toBeGreaterThan(0);
    expect(result.lookupLog!.summary.linkFallbacks).toBeGreaterThan(0);
  });

  it("with a budget that holds the first lookup but not the fallback, the fallback is skipped (never reserved above the ceiling) and counted as skipped for budget", async () => {
    const calls = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([TEN[0]]) } : isEmail(call) ? { cost: 8900, body: emailBody(call, null, "none", 8900) } : { body: phoneMiss }));
    // a ceiling of 0.025: after the search (0.00038) and the first email (0.0089 spent) 0.0157 is left, which cannot hold the fallback's own 0.02 ceiling
    const result = await defaultTregAdapter(input({ decisionMakerSpendBudgetUsd: 0.025 }) as any);
    const spent = result.costMicro;
    expect(spent).toBeLessThanOrEqual(25_000);
    expect(calls.filter(isEmail)).toHaveLength(1);
    expect(result.lookupLog!.summary.linkFallbacks).toBe(1);
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
