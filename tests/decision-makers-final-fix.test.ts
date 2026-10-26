import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Decision makers, the final fix (PR #253): SIMULATION only. The REAL client and adapter run against a stubbed `fetch` (payload shapes of the live jobs), the
 * DNS check of a mail domain is injected: no network, nothing paid.
 *   A1 the first email lookup is the company domain and the names; the profile link only as a fallback
 *   A2 a domain with no mail server: the address is not delivered and not charged (`no_mx`)
 *   A3 the deliverability check of a found address (`treg.people.email.verify`): invalid is not delivered and not charged (`verify_invalid`)
 *   A4 technology activity from the person's title and headline and the company's name and description (never the label alone)
 *   A5 a lookup cut by our own limit: the first attempt is logged apart, the same key is read, a deadline that allows no read ends it as «timeout»
 *   A6 no personal value in the log; the new codes
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

import { defaultTregAdapter, emailVerdictOf, parseDirectPeopleRows, PEOPLE_LOOKUP_REPLAY_WAIT_MS } from "../src/lib/server/tregAdapter";
import { createCachedMailDomainResolver, currentMailDomainResolver, defaultMailDomainResolver, setMailDomainResolverForTesting, type MailDomainStatus } from "../src/lib/server/mailDomainCheck";
import { decisionMakerJobSpendCeilingUsd, DECISION_MAKER_VERIFY_ROUTE_COST_CAP_USD } from "../src/lib/server/decisionMakerSpend";
import { decisionMakerChargePoints, decisionMakerDeliveredUnits, DECISION_MAKER_UNIT_PRICES_POINTS } from "../src/functions/shared/decisionMakerPricing";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { isTechnologyRequest, technologyEvidenceOf, technologyFirmInTitle, technologySignalIn } from "../src/lib/server/technologyEvidence";
import { arabicVerificationStatus } from "../src/lib/contactVerification";
import { peopleDeliveryRow } from "../src/lib/server/peopleDelivery";

const PARAMS = { limit: 3, title: "CEO", country: "EG", keywords: ["information technology", "software", "technology"], requiredContactFields: ["work_email", "phone"], contactFieldsToAttempt: ["work_email", "phone"] };
const lead = (extra: Record<string, any>) => ({
  firstname: "", lastname: "", headline: "", description: "", profileUrl: "", lastJobTitle: "CEO", lastJobDescription: "", lastJobStartDate: "2019-03",
  address: "Cairo, Egypt", lastCompanyName: "", lastCompanyUrl: "", lastCompanyWebsite: "", lastCompanyDescription: "Software and cloud technology", lastCompanySize: "11-50",
  lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt", ...extra,
});
const person = (first: string, last: string, extra: Record<string, any> = {}) => lead({
  firstname: first, lastname: last, profileUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}`,
  lastCompanyName: `${last} Software`, lastCompanyWebsite: `https://${last.toLowerCase()}-soft.example`, ...extra,
});
const answerOf = (leads: any[]) => ({ total: 2560, success: true, leads, pagination: { token: "next", size: leads.length } });

interface Call { endpoint: string; body: any; headers: Record<string, string>; attempt: number }
type Answer = { cost?: number; originalCost?: number; body?: any; status?: number; timeout?: boolean };
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
const isVerify = (call: Call) => call.endpoint === "treg.people.email.verify";
const phoneMiss = { output: { phone: null }, _treg: { served_by: null, tried: Array(15).fill("p") } };
const emailBody = (call: Call, address: string | null) => ({
  output: { email: address, first_name: call.body.first_name, last_name: call.body.last_name },
  _treg: { served_by: "limadata.people.email.find.name", tried: ["quickenrich.people.email.find", "limadata.people.email.find.name"], charged_micro: 20000 },
});
const input = (extra: Record<string, any> = {}) => ({
  jobId: "job_quote_final", userId: "user_final", step: 0, endpointId: "treg.people.search", capabilitySlug: "professional-people-search", method: "POST" as const,
  params: PARAMS, paginationStrategy: "none" as const, cursor: null, pageSize: 3, remainingNeeded: 1, targetVolumeMax: 1, deliveredSoFar: 0, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(1), ...extra,
});
const isEntryEmail = (entry: { endpoint: string }) => entry.endpoint === "treg.people.email.find";
const isEntryVerify = (entry: { endpoint: string }) => entry.endpoint === "treg.people.email.verify";

/** One person whose first email lookup answers an address, and a verify answer chosen by the test. */
async function oneEmailJob(address: string, verify: Answer, mail: MailDomainStatus = "mx", extraInput: Record<string, any> = {}) {
  setMailDomainResolverForTesting(async () => mail);
  const mona = person("Mona", "Delta");
  const calls = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([mona]) } : isEmail(call) ? { cost: 8900, body: emailBody(call, address) } : isVerify(call) ? verify : { body: phoneMiss }));
  const result = await defaultTregAdapter(input(extraInput) as any);
  return { calls, result };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("A2: the mail-server check of the address's domain", () => {
  it("no test touches the network: the setup file puts a resolver in force before every test", async () => {
    expect(currentMailDomainResolver()).not.toBe(defaultMailDomainResolver);
    expect(await currentMailDomainResolver()("anything.example")).toBe("mx");
  });

  it("a domain with NO mail server: the address is not delivered and not charged, no paid check is made, the log says no_mx with the domain only", async () => {
    const { calls, result } = await oneEmailJob("mona@gate-eight.example", { body: { output: { status: "valid" } } }, "none");
    expect(calls.filter(isVerify)).toHaveLength(0); // the free check came first: nothing paid for an address that cannot receive
    expect(result.rows[0].work_email).toBe("");
    const entry = result.lookupLog!.entries.find(isEntryEmail)!;
    expect(entry).toMatchObject({ outcome: "no_mx", mailboxDomain: "gate-eight.example", emailPresent: false });
    expect(result.lookupLog!.rows![0]).toMatchObject({ gate: "match", lookedUp: true, finalReason: "no_mx" });
    expect(result.lookupLog!.summary).toMatchObject({ noMx: 1, withContact: 0, verifyCalls: 0 });
    // the customer is charged nothing for the person: no delivered value
    expect(decisionMakerDeliveredUnits(result.rows.filter((row) => row.work_email || row.phone), ["work_email", "phone"])).toEqual({ baseUnits: 0, emailUnits: 0, phoneUnits: 0 });
    expect(result.rows[0]).toMatchObject({ work_email_presence_status: "غير موجود" });
    expect(JSON.stringify(result.lookupLog)).not.toContain("mona@");
  });

  it("«a» (no MX, an address record), «mx» and «unknown» (the check itself failed) do not keep an address out: the deliverability check decides", async () => {
    for (const mail of ["mx", "a", "unknown"] as const) {
      const { calls, result } = await oneEmailJob("mona@delta-soft.example", { body: { output: { status: "valid" } } }, mail);
      expect(calls.filter(isVerify), mail).toHaveLength(1);
      expect(result.rows[0].work_email, mail).toBe("mona@delta-soft.example");
      const entry = result.lookupLog!.entries.find(isEntryEmail)!;
      expect(entry, mail).toMatchObject({ outcome: "hit", mailServer: mail });
    }
  });

  it("the answer is remembered for the request: two addresses on one domain ask the resolver once", async () => {
    const asked: string[] = [];
    const cached = createCachedMailDomainResolver(async (domain) => { asked.push(domain); return "mx"; });
    expect(await Promise.all([cached("Delta-Soft.example"), cached("delta-soft.example"), cached("other.example")])).toEqual(["mx", "mx", "mx"]);
    expect(asked).toEqual(["delta-soft.example", "other.example"]);
    const failing = createCachedMailDomainResolver(async () => { throw new Error("boom"); });
    expect(await failing("x.example")).toBe("unknown");
  });

  it("the real resolver, with the DNS answers stubbed: MX records, an address record only, nothing, a null MX, and a resolver failure", async () => {
    const dnsAnswer = { mx: null as any, a: null as any, aaaa: null as any };
    vi.doMock("node:dns", () => ({
      promises: {
        resolveMx: async () => { if (dnsAnswer.mx instanceof Error) throw dnsAnswer.mx; return dnsAnswer.mx; },
        resolve4: async () => { if (dnsAnswer.a instanceof Error) throw dnsAnswer.a; return dnsAnswer.a; },
        resolve6: async () => { if (dnsAnswer.aaaa instanceof Error) throw dnsAnswer.aaaa; return dnsAnswer.aaaa; },
      },
    }));
    const { defaultMailDomainResolver: real } = await import("../src/lib/server/mailDomainCheck");
    const code = (name: string) => Object.assign(new Error(name), { code: name });
    const cases: Array<[any, any, any, MailDomainStatus]> = [
      [[{ exchange: "mx1.mail.example", priority: 10 }], [], [], "mx"],
      [code("ENODATA"), ["203.0.113.9"], [], "a"],
      [code("ENODATA"), code("ENODATA"), ["2001:db8::1"], "a"],
      [code("ENODATA"), code("ENODATA"), code("ENODATA"), "none"],
      [code("ENOTFOUND"), code("ENOTFOUND"), code("ENOTFOUND"), "none"],
      [[{ exchange: "", priority: 0 }], [], [], "none"], // a null MX: «0 .»
      [code("ESERVFAIL"), [], [], "unknown"],
      [code("ETIMEOUT"), [], [], "unknown"],
    ];
    for (const [mx, a, aaaa, expected] of cases) {
      dnsAnswer.mx = mx; dnsAnswer.a = a; dnsAnswer.aaaa = aaaa;
      expect(await real("gate-eight.example"), JSON.stringify(expected)).toBe(expected);
    }
    vi.doUnmock("node:dns");
  });
});

describe("A3: the deliverability check of a found work email", () => {
  it("the call: treg.people.email.verify, the body is only {email}, ceiling 0.005, its own step and idempotency key, no prefer/exclude header", async () => {
    const { calls } = await oneEmailJob("mona@delta-soft.example", { body: { output: { status: "valid" } } });
    const verify = calls.filter(isVerify);
    expect(verify).toHaveLength(1);
    expect(verify[0].body).toEqual({ email: "mona@delta-soft.example" });
    expect(verify[0].headers["X-Treg-Route-Max-Cost"]).toBe("0.005");
    expect(DECISION_MAKER_VERIFY_ROUTE_COST_CAP_USD).toBe(0.005);
    expect(verify[0].headers["Idempotency-Key"]).toContain("people_verify_0_");
    expect(Object.keys(verify[0].headers).some((name) => /prefer|exclude/i.test(name))).toBe(false);
  });

  it("INVALID: the address is not delivered and not charged; the log says verify_invalid with the domain only; the person goes to review", async () => {
    const { result } = await oneEmailJob("mona@gate-eight.example", { cost: 400, body: { output: { status: "invalid", reason: "invalid_dns" } } });
    expect(result.rows[0].work_email).toBe("");
    expect(result.rows[0].work_email_presence_status).toBe("غير موجود");
    const entries = result.lookupLog!.entries;
    expect(entries.find(isEntryEmail)).toMatchObject({ outcome: "verify_invalid", mailboxDomain: "gate-eight.example", emailPresent: false });
    expect(entries.find(isEntryVerify)).toMatchObject({ outcome: "verify_invalid", verdict: "invalid", costUsd: 0.0004, mailboxDomain: "gate-eight.example" });
    expect(result.lookupLog!.rows![0]).toMatchObject({ lookedUp: true, finalReason: "verify_invalid" });
    expect(result.lookupLog!.summary).toMatchObject({ verifyInvalid: 1, verifyCalls: 1, withContact: 0 });
    expect(decisionMakerDeliveredUnits(result.rows.filter((row) => row.work_email || row.phone), ["work_email", "phone"])).toEqual({ baseUnits: 0, emailUnits: 0, phoneUnits: 0 });
    // the provider billed the find and the check: the cost is recorded, only the customer is not charged
    expect(result.costMicro).toBe(380 + 8900 + 400);
    expect(JSON.stringify(result.lookupLog)).not.toContain("mona@");
  });

  it("valid, risky, catch-all and unknown are delivered, each with its honest status in the status column (never a claim of certainty beyond the source)", async () => {
    const table: Array<[any, string]> = [
      [{ status: "valid" }, "متحقق"],
      [{ status: "valid", reason: "risky" }, "يحتاج مراجعة"],
      [{ status: "valid-risky" }, "يحتاج مراجعة"],
      [{ status: "accept_all" }, "يحتاج مراجعة"],
      [{ status: "unknown" }, "لم يتوفر تأكيد"],
      [{}, "لم يتوفر تأكيد"],
    ];
    for (const [output, label] of table) {
      const { result } = await oneEmailJob("mona@delta-soft.example", { body: { output } });
      expect(result.rows[0].work_email, JSON.stringify(output)).toBe("mona@delta-soft.example");
      expect(result.rows[0].work_email_verification_status, JSON.stringify(output)).toBe(label);
      // the Excel and the results screen read this same status column
      expect(peopleDeliveryRow(result.rows[0]).work_email_verification_status).toBe(label);
    }
  });

  it("a check that could not be made (an error, a timeout, a miss) does not keep the address out: it is delivered as «لم يتوفر تأكيد»", async () => {
    for (const verify of [{ status: 502, body: { error: "bad_gateway" } }, { status: 503, body: { error: "unavailable" } }, { timeout: true as const }]) {
      const { result } = await oneEmailJob("mona@delta-soft.example", verify);
      expect(result.rows[0].work_email).toBe("mona@delta-soft.example");
      expect(result.rows[0].work_email_verification_status).toBe("لم يتوفر تأكيد");
    }
  });

  it("emailVerdictOf reads the usual fields of the routed answer and says nothing when there is none", () => {
    const of = (output: any) => emailVerdictOf({ output });
    expect(of({ status: "valid" })).toBe("valid");
    expect(of({ result: "deliverable" })).toBe("valid");
    expect(of({ deliverability: "DELIVERABLE" })).toBe("valid");
    expect(of({ status: "invalid", reason: "invalid_dns" })).toBe("invalid");
    expect(of({ status: "undeliverable" })).toBe("invalid");
    expect(of({ status: "disposable" })).toBe("invalid");
    expect(of({ status: "risky" })).toBe("risky");
    expect(of({ status: "valid", reason: "risky" })).toBe("risky");
    expect(of({ status: "catch-all" })).toBe("catch_all");
    expect(of({ status: "valid", sub_status: "catch_all" })).toBe("catch_all");
    expect(of({ status: "unknown" })).toBe("unknown");
    expect(of({ valid: true })).toBe("valid");
    expect(of({ valid: false })).toBe("invalid");
    expect(of({})).toBeNull();
    expect(emailVerdictOf(null)).toBeNull();
    expect(arabicVerificationStatus("risky", true)).toBe("يحتاج مراجعة");
  });

  it("the verify cost is inside the job ceiling: three people found and checked at the full 0.02 + 0.005 stay at or under 0.115", async () => {
    const people = ["Mona", "Nour", "Omar", "Salma"].map((first, at) => person(first, `Lastname${at}`));
    const costs: number[] = [];
    const calls = gateway((call) => {
      const cost = isSearch(call) ? 3420 : isEmail(call) ? 20000 : isVerify(call) ? 5000 : 0;
      costs.push(cost);
      if (isSearch(call)) return { cost, body: answerOf(people) };
      if (isEmail(call)) return { cost, body: emailBody(call, `${String(call.body.first_name).toLowerCase()}@${String(call.body.domain)}`) };
      if (isVerify(call)) return { cost, body: { output: { status: "valid" } } };
      return { body: phoneMiss };
    });
    const result = await defaultTregAdapter(input({ remainingNeeded: 3, targetVolumeMax: 3, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(3) }) as any);
    const spent = costs.reduce((total, cost) => total + cost, 0);
    expect(result.costMicro).toBe(spent);
    expect(spent).toBeLessThanOrEqual(Math.round(decisionMakerJobSpendCeilingUsd(3) * 1e6));
    expect(calls.filter(isVerify)).toHaveLength(3);
    expect(result.rows.filter((row) => row.work_email)).toHaveLength(3);
    expect(spent).toBe(3420 + 3 * 20000 + 3 * 5000);
  });

  it("the money rules did not move: 83 + 120 + 55, per delivered field, nothing for an undelivered one", () => {
    expect(DECISION_MAKER_UNIT_PRICES_POINTS).toEqual({ basePerson: 83, workEmail: 120, phone: 55 });
    expect(decisionMakerChargePoints({ baseUnits: 2, emailUnits: 2, phoneUnits: 0 }, DECISION_MAKER_UNIT_PRICES_POINTS)).toBe(406);
  });
});

describe("A4: technology activity from the person's title and headline and the company's name and description", () => {
  const gate = (extra: Record<string, any>, params: Record<string, any> = PARAMS) => {
    const [row] = parseDirectPeopleRows({ leads: [lead({ firstname: "Sara", lastname: "Test", profileUrl: "https://www.linkedin.com/in/sara-test", ...extra })] });
    return evaluateResearchRowRelevance({ ...row, work_email: "s@x.example", contact_review_status: "x" }, { capabilitySlug: "professional-people-search", endpointId: "treg.people.search", params });
  };

  it("IDV Digital (web development, VR, e-commerce; a generic label): eligible", () => {
    expect(gate({ lastCompanyName: "IDV Digital", lastCompanyDescription: "Web development, VR experiences and e-commerce", lastCompanyIndustry: "Marketing & Advertising" }).decision).toBe("match");
    // the name alone is enough, and so is the description alone
    expect(gate({ lastCompanyName: "IDV Digital", lastCompanyDescription: "", lastCompanyIndustry: "" }).decision).toBe("match");
    expect(gate({ lastCompanyName: "IDV", lastCompanyDescription: "We build e-commerce stores and mobile apps", lastCompanyIndustry: "" }).decision).toBe("match");
  });

  it("ARIZONA Engineering & Supplies (industrial machinery, compressed air): not eligible, however the label reads", () => {
    const verdict = gate({ lastCompanyName: "ARIZONA Engineering & Supplies", lastCompanyDescription: "Suppliers of industrial machinery, compressed air systems and spare parts", lastCompanyIndustry: "Information Technology & Services" });
    expect(verdict).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
  });

  it("International Union for Studies and Development (training and community studies): not eligible («development» alone is no signal)", () => {
    const verdict = gate({ lastCompanyName: "International Union for Studies and Development", lastCompanyDescription: "Training, community studies and research for civil society development", lastCompanyIndustry: "Education Management" });
    expect(verdict).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
  });

  it("Consulting Organization with the title «CEO - IT Consultancy & Management Firm»: eligible, because the title names a FIRM's technology activity; «IT Manager» and «Head of IT» alone are not", () => {
    expect(gate({ lastCompanyName: "Consulting Organization", lastCompanyDescription: "", lastJobTitle: "CEO - IT Consultancy & Management Firm" }).decision).toBe("match");
    expect(gate({ lastCompanyName: "Consulting Organization", lastCompanyDescription: "", lastJobTitle: "Founder", headline: "Founder | web development agency" }).decision).toBe("match");
    expect(gate({ lastCompanyName: "Consulting Organization", lastCompanyDescription: "", lastJobTitle: "IT Manager" })).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
    expect(gate({ lastCompanyName: "Consulting Organization", lastCompanyDescription: "", lastJobTitle: "Head of IT" })).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
    expect(gate({ lastCompanyName: "Nile Hospital", lastCompanyDescription: "", lastJobTitle: "CIO", headline: "Chief Information Officer" }).decision).toBe("uncertain");
  });

  it("the industry label alone is still never evidence; a person's own bio does not make the company a technology company", () => {
    expect(gate({ lastCompanyName: "Nile Advisory", lastCompanyDescription: "", lastCompanyIndustry: "Information Technology & Services" })).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
    expect(gate({ lastCompanyName: "Nile Advisory", lastCompanyDescription: "", lastCompanyIndustry: "", description: "I love software and cloud computing" }).decision).toBe("uncertain");
  });

  it("Arabic: a name or description with a technology word delivers; an industrial description does not", () => {
    expect(gate({ lastCompanyName: "شركة النيل", lastCompanyDescription: "حلول برمجية وتطبيقات الهاتف", lastCompanyIndustry: "" }).decision).toBe("match");
    expect(gate({ lastCompanyName: "الحلول الرقمية", lastCompanyDescription: "", lastCompanyIndustry: "" }).decision).toBe("match");
    expect(gate({ lastCompanyName: "شركة اتصالات الدلتا", lastCompanyDescription: "", lastCompanyIndustry: "" }).decision).toBe("match");
    expect(gate({ lastCompanyName: "أريزونا للتوريدات", lastCompanyDescription: "توريد المعدات الصناعية وضواغط الهواء", lastCompanyIndustry: "" }).decision).toBe("uncertain");
    expect(gate({ lastCompanyName: "شركة النيل", lastCompanyDescription: "", lastJobTitle: "الرئيس التنفيذي - شركة حلول تقنية" }).decision).toBe("match");
  });

  it("only a request for technology companies gets the wider rule: a real-estate request still needs its own words", () => {
    const realEstate = { ...PARAMS, keywords: ["real estate", "property development"] };
    expect(gate({ lastCompanyName: "Delta Digital", lastCompanyDescription: "Web development", lastCompanyIndustry: "" }, realEstate)).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
    expect(isTechnologyRequest(realEstate.keywords)).toBe(false);
    expect(isTechnologyRequest(["information technology"])).toBe(true);
    expect(isTechnologyRequest([], "تقنية المعلومات")).toBe(true);
  });

  it("the signal list: one clear signal in English and Arabic, and the generic words that are NOT signals", () => {
    for (const text of ["software house", "IT services", "AI lab", "Cloud hosting", "telecom operator", "web agency", "e-commerce store", "VR studio", "mobile apps", "ERP solutions", "web portal", "fintech", "Digital transformation", "software development", "data center", "تقنية المعلومات", "برمجيات", "رقمي", "اتصالات", "بوابة الكترونية"]) {
      expect(technologySignalIn(text), text).toBe(true);
    }
    for (const text of ["community development", "studies and development", "compressed air systems", "industrial automation", "electronic components", "mobile network operator", "it is a family firm", "training programmes", "ضواغط الهواء", "توريد معدات"]) {
      expect(technologySignalIn(text), text).toBe(false);
    }
    expect(technologyEvidenceOf({ company_name: "Smartec Systems" })).toBe("company");
    expect(technologyEvidenceOf({ company_name: "Atlas", industry_description: "valves and compressed air systems" })).toBeNull();
    expect(technologyFirmInTitle("CEO - IT Consultancy & Management Firm")).toBe(true);
    expect(technologyFirmInTitle("IT Manager")).toBe(false);
  });
});

describe("A1 and A5: the order of the lookups, and a lookup cut by our own limit", () => {
  it("with a domain, the first lookup sends {domain, full_name, first_name, last_name}; the profile link is in the payload only of the fallback after a miss", async () => {
    const mona = person("Mona", "Delta");
    const calls = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([mona]) } : isEmail(call) ? { body: emailBody(call, null) } : { body: phoneMiss }));
    await defaultTregAdapter(input() as any);
    const emails = calls.filter(isEmail).map((call) => call.body);
    expect(emails[0]).toEqual({ domain: "delta-soft.example", full_name: "Mona Delta", first_name: "Mona", last_name: "Delta" });
    expect(emails[1]).toEqual({ linkedin_url: "https://www.linkedin.com/in/mona-delta", domain: "delta-soft.example", full_name: "Mona Delta", first_name: "Mona", last_name: "Delta" });
    expect(emails).toHaveLength(2);
  });

  it("a person with no domain is looked up by the profile link (all there is) and not twice", async () => {
    const rania = person("Rania", "Ayman", { lastCompanyWebsite: "" });
    const calls = gateway((call) => (isSearch(call) ? { cost: 380, body: answerOf([rania]) } : isEmail(call) ? { body: emailBody(call, null) } : { body: phoneMiss }));
    await defaultTregAdapter(input() as any);
    const emails = calls.filter(isEmail).map((call) => call.body);
    expect(emails).toEqual([{ linkedin_url: "https://www.linkedin.com/in/rania-ayman", full_name: "Rania Ayman", first_name: "Rania", last_name: "Ayman" }]);
  });

  async function withFastWaits<T>(run: () => Promise<T>): Promise<{ value: T; waits: number[] }> {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const waits: number[] = [];
    const fake = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: any, ms?: number, ...rest: any[]) => { if ((ms ?? 0) >= 1_000) waits.push(ms!); return (fake as any)(handler, ms, ...rest); }) as any;
    try {
      const pending = run();
      await vi.advanceTimersByTimeAsync(120_000);
      return { value: await pending, waits };
    } finally {
      globalThis.setTimeout = fake;
      vi.useRealTimers();
    }
  }

  it("cut by our own limit: the first attempt is logged apart (cut: true), one wait, the same key is read, the answer is delivered and charged once", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const mona = person("Mona", "Delta");
    const calls = gateway((call) => {
      if (isSearch(call)) return { cost: 380, body: answerOf([mona]) };
      if (isVerify(call)) return { body: { output: { status: "valid" } } };
      if (!isEmail(call)) return { body: phoneMiss };
      return call.attempt === 1 ? { timeout: true } : { cost: 0, originalCost: 8900, body: emailBody(call, "mona@delta-soft.example") };
    });
    const { value: result, waits } = await withFastWaits(() => defaultTregAdapter(input({ deadlineMs: Date.now() + 100_000 }) as any));
    const emailCalls = calls.filter(isEmail);
    expect(emailCalls).toHaveLength(2);
    expect(new Set(emailCalls.map((call) => call.headers["Idempotency-Key"])).size).toBe(1);
    expect(waits).toEqual([PEOPLE_LOOKUP_REPLAY_WAIT_MS]);
    expect(result.rows[0].work_email).toBe("mona@delta-soft.example");
    expect(result.costMicro).toBe(380 + 8900);
    const entry = result.lookupLog!.entries.find(isEntryEmail)!;
    expect(entry).toMatchObject({ outcome: "hit", calls: 2, attempt: "domain_and_name" });
    expect(entry.firstAttempt).toMatchObject({ cut: true });
    expect(entry.reads).toHaveLength(1);
  });

  it("a deadline that allows no read: the lookup ends as «timeout» after ONE call, no fallback is made for it, and the next person is still looked up", async () => {
    setMailDomainResolverForTesting(async () => "mx");
    const people = [person("Mona", "Delta"), person("Nour", "Adel")];
    const calls = gateway((call) => {
      if (isSearch(call)) return { cost: 380, body: answerOf(people) };
      if (isEmail(call) && call.body.first_name === "Mona") return { timeout: true };
      if (isEmail(call)) return { cost: 8900, body: emailBody(call, "nour@adel-soft.example") };
      if (isVerify(call)) return { body: { output: { status: "valid" } } };
      return { body: phoneMiss };
    });
    // 18 s left: 12 s are kept for saving and settling, so a 25 s lookup is cut to the 6 s that are left and no wait + read fits
    const result = await defaultTregAdapter(input({ remainingNeeded: 1, targetVolumeMax: 1, deadlineMs: Date.now() + 18_000 }) as any);
    const entries = result.lookupLog!.entries.filter(isEntryEmail);
    expect(entries[0]).toMatchObject({ outcome: "timeout", calls: 1 });
    expect(entries[0]).not.toHaveProperty("reads");
    expect(calls.filter((call) => isEmail(call) && call.body.first_name === "Mona")).toHaveLength(1); // no fallback after a timeout
    expect(result.ok).toBe(true);
  });
});

describe("A6: the log keeps codes only", () => {
  it("no name, address, link, company domain or token anywhere in the log of a job with a no_mx person, an invalid one and a delivered one", async () => {
    const people = [person("Mona", "Delta"), person("Nour", "Adel"), person("Omar", "Hassan")];
    setMailDomainResolverForTesting(async (domain) => (domain === "nomail.example" ? "none" : "mx"));
    gateway((call) => {
      if (isSearch(call)) return { cost: 3420, body: answerOf(people) };
      if (isEmail(call)) {
        const first = call.body.first_name;
        return { cost: 8900, body: emailBody(call, first === "Mona" ? "mona@nomail.example" : first === "Nour" ? "nour@dead-box.example" : "omar@omar-soft.example") };
      }
      if (isVerify(call)) return String(call.body.email).startsWith("nour@") ? { cost: 400, body: { output: { status: "invalid" } } } : { cost: 400, body: { output: { status: "valid" } } };
      return { body: phoneMiss };
    });
    const result = await defaultTregAdapter(input({ remainingNeeded: 3, targetVolumeMax: 3, decisionMakerSpendBudgetUsd: decisionMakerJobSpendCeilingUsd(3) }) as any);
    const outcomes = result.lookupLog!.entries.map((entry) => entry.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(["no_mx", "verify_invalid", "hit"]));
    const kept = JSON.stringify(result.lookupLog);
    for (const secret of ["Mona", "Nour", "Omar", "Delta", "Adel", "Hassan", "mona@", "nour@", "omar@", "omar-soft", "delta-soft", "linkedin.com", "test-token-not-a-secret"]) expect(kept, secret).not.toContain(secret);
    // the discarded addresses leave their mailbox DOMAIN only
    expect(kept).toContain("nomail.example");
    expect(kept).toContain("dead-box.example");
    expect(result.lookupLog!.rows!.map((row) => row.finalReason).sort()).toEqual(["contact", "no_mx", "verify_invalid"]);
  });

  it("the worker keeps storing the rows in the internal lookup_log event", () => {
    expect(readFileSync("src/app/api/worker/chunk/route.ts", "utf8")).toContain("rows: rawAdapterResult.lookupLog.rows ?? []");
  });
});
