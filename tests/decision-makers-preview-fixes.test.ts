import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import ExcelJS from "exceljs";

/**
 * Decision makers, preview live test of PR #253 (test account, 2026-10-26): the job delivered three people with no email and no phone, the Excel
 * had company columns only, an Egyptian company was sent to review as «outside the requested country», and the contact lookups returned nothing.
 * The leads are in the exact shape of the direct source's answer (the owner's live direct call); the worker runs against fake storage and a
 * fake database; no live call, no provider is paid.
 */
const tregCall = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  jobs: [] as any[], quotes: [] as any[],
  partials: new Map<string, Buffer>(), results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>, events: [] as any[], costs: [] as any[],
  step: 0, cursor: null as string | null, deliveredUnits: 0, targetVolumeMax: 5, unitPrice: 193, reserved: 1100,
}));

function builder(rows: () => any[]) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => rows().filter((row) => filters.every(([col, val]) => row[col] === val));
  const api: any = {
    select: () => api, eq: (c: string, v: unknown) => { filters.push([c, v]); return api; },
    in: () => api, or: () => api, not: () => api, order: () => api, limit: () => api,
    maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => Promise.resolve({ data: apply(), error: null }).then(resolve, reject),
  };
  return api;
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string, args: any) => {
      db.rpcCalls.push({ name, args });
      if (name === "claim_job_chunk") return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: "treg.people.search", unit_price: db.unitPrice }, error: null };
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: true, cost_id: 11 }, error: null };
      if (name === "commit_provider_spend" || name === "commit_provider_spend_v2") { db.costs.push({ provider: "treg", cost_usd: Number(args.p_actual_cost_usd) || 0 }); return { data: { success: true }, error: null }; }
      if (name === "complete_chunk") {
        db.step += 1; db.deliveredUnits = args.p_new_delivered_units; db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { current_cursor: db.cursor, delivered_units: db.deliveredUnits, status: "running" });
        return { data: { success: true, delivered_units: db.deliveredUnits }, error: null };
      }
      if (name === "settle_people_job_atomic" && String(args.p_job_id).startsWith("__diger_people_settlement_probe_")) {
        return { data: null, error: { code: "P0001", message: `Job ${args.p_job_id} not found` } };
      }
      if (name === "settle_people_job_atomic") {
        const charged = Math.min(args.p_base_units * 83 + args.p_email_units * 55 + args.p_phone_units * 55, db.reserved);
        return { data: { success: true, charged_credits: charged, refunded_credits: db.reserved - charged }, error: null };
      }
      if (name === "release_job_atomic") return { data: { success: true, released_credits: db.reserved }, error: null };
      return { data: { success: true }, error: null };
    }),
    storage: {
      from: (bucket: string) => {
        const store = bucket === "partials" ? db.partials : db.results;
        return {
          upload: async (path: string, body: any) => { store.set(path, Buffer.isBuffer(body) ? body : Buffer.from(String(body))); return { data: { path }, error: null }; },
          download: async (path: string) => { const buf = store.get(path); return buf ? { data: new Blob([new Uint8Array(buf)]), error: null } : { data: null, error: { message: "not_found" } }; },
          remove: async (paths: string[]) => { for (const p of paths) store.delete(p); return { data: paths, error: null }; },
        };
      },
    },
    from: (table: string) => {
      if (table === "jobs") return builder(() => db.jobs);
      if (table === "plans_quotes") return builder(() => db.quotes);
      if (table === "provider_costs") return builder(() => db.costs);
      if (table === "job_events" || table === "notifications" || table === "artifact_versions") {
        const base = builder(() => (table === "job_events" ? db.events : []));
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push(row); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
      }
      return builder(() => []);
    },
  })),
}));
vi.mock("../src/lib/server/providerGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server/providerGate")>()),
  getLiveProviderGateStatus: () => ({ isReady: true, reasonCode: "ready", messageAr: "" }),
}));
vi.mock("../src/functions/shared/tregClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/tregClient")>();
  return { ...actual, executeTregCall: tregCall };
});
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => undefined), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null), searchCatalog: vi.fn(async () => []),
}));

import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { defaultTregAdapter, parseDirectPeopleRows, setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { detectCountryFromText } from "../src/lib/planParameters";
import { decisionMakerDeliveredUnits, markContactRowsForReview } from "../src/functions/shared/decisionMakerPricing";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { PEOPLE_COLUMNS, peopleContactCounts, peopleDeliverySentenceAr, peopleShortfallReasonAr, orderPeopleColumns } from "../src/lib/peopleColumns";
import { peopleDeliveryRow } from "../src/lib/server/peopleDelivery";

const PLAN_PARAMS = {
  limit: 5, title: "CEO", country: "EG", keywords: ["information technology", "software", "technology"],
  requiredContactFields: ["work_email", "phone"], contactFieldsToAttempt: ["work_email", "phone"],
};
const gate = (row: Record<string, any>, params: Record<string, any> = PLAN_PARAMS) =>
  evaluateResearchRowRelevance(row, { capabilitySlug: "professional-people-search", endpointId: "treg.people.search", params });

/** A lead with exactly the fields of the direct source's answer. */
const lead = (extra: Record<string, any>) => ({
  firstname: "", lastname: "", headline: "", description: "", profileUrl: "", lastJobTitle: "CEO", lastJobDescription: "", lastJobStartDate: "2019-03",
  address: "", lastCompanyName: "", lastCompanyUrl: "", lastCompanyWebsite: "", lastCompanyDescription: "", lastCompanySize: "11-50", lastCompanyIndustry: "", lastCompanyAddress: "",
  ...extra,
});
const MONA = lead({ firstname: "Mona", lastname: "Saleh", headline: "CEO at Delta Software", description: "Leading Delta Software. Write to mona.boss@delta-soft.example", profileUrl: "https://www.linkedin.com/in/mona-saleh-a", address: "Cairo, Egypt", lastCompanyName: "Delta Software", lastCompanyWebsite: "https://delta-soft.example", lastCompanyDescription: "Software development and cloud technology services", lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt" });
const OMAR = lead({ firstname: "Omar", lastname: "Hassan", profileUrl: "https://www.linkedin.com/in/omar-hassan-e", address: "Giza, Egypt", lastCompanyName: "Pyramid Cloud", lastCompanyWebsite: "https://pyramid-cloud.example", lastCompanyDescription: "Cloud software platform", lastCompanyIndustry: "Computer Software", lastCompanyAddress: "Giza, Egypt" });
/** The live false review: an Egyptian company whose address is written in Arabic. */
const ERNST = lead({ firstname: "Karim", lastname: "Ernst", profileUrl: "https://www.linkedin.com/in/karim-ernst-f", address: "Cairo, Egypt", lastCompanyName: "Ernst AI", lastCompanyWebsite: "https://ernst-ai.example", lastCompanyDescription: "Applied AI software for banks", lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "القاهرة مصر" });
const NOBODY = lead({ firstname: "Hana", lastname: "Gad", profileUrl: "https://www.linkedin.com/in/hana-gad-g", address: "Cairo, Egypt", lastCompanyName: "Sphinx Software", lastCompanyWebsite: "https://sphinx-soft.example", lastCompanyDescription: "Software products", lastCompanyIndustry: "Computer Software", lastCompanyAddress: "Cairo, Egypt" });
/** A person in Cairo at a company in Khartoum: the company is outside the request (review). */
const SUDAN = lead({ firstname: "Yusuf", lastname: "Ali", profileUrl: "https://www.linkedin.com/in/yusuf-ali-c", address: "Cairo, Egypt", lastCompanyName: "Sudan Tech Group", lastCompanyWebsite: "https://sudan-tech.example", lastCompanyDescription: "Software and technology", lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Khartoum, Sudan" });
/** The live direct call's person in Bahrain: refused outright (excluded, not reviewed). */
const BAHRAIN = lead({ firstname: "Sami", lastname: "Khalid", profileUrl: "https://www.linkedin.com/in/sami-khalid-h", address: "Manama, Bahrain", lastCompanyName: "Gulf Software", lastCompanyWebsite: "https://gulf-soft.example", lastCompanyDescription: "Software and technology", lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Manama, Bahrain" });
const LABEL_ONLY = lead({ firstname: "Nour", lastname: "Adel", profileUrl: "https://www.linkedin.com/in/nour-adel-b", address: "Cairo, Egypt", lastCompanyName: "Nile Advisory", lastCompanyWebsite: "https://nile-advisory.example", lastCompanyDescription: "", lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt" });
const ANSWER = { total: 2560, success: true, leads: [MONA, OMAR, ERNST, NOBODY, SUDAN, LABEL_ONLY, BAHRAIN], pagination: { token: "next", size: 15 } };

/** The adapter's rows as the worker receives them: the contact values the lookups found (Mona both, Omar an email, Ernst a phone, nobody else). */
function adapterRows(): Record<string, any>[] {
  const found: Record<string, Record<string, string>> = {
    "Mona Saleh": { work_email: "mona@delta-soft.example", phone: "+201000000001" },
    "Omar Hassan": { work_email: "omar@pyramid-cloud.example" },
    "Karim Ernst": { phone: "+201000000002" },
  };
  const rows = parseDirectPeopleRows(ANSWER).map((row) => {
    const values = found[String(row.contact_name)] || {};
    return {
      ...row, work_email: values.work_email || "", phone: values.phone || "",
      work_email_verification_status: values.work_email ? "لم يتوفر تأكيد" : "غير متاح", phone_verification_status: values.phone ? "لم يتوفر تأكيد" : "غير متاح",
      work_email_presence_status: values.work_email ? "موجود" : "غير موجود", phone_presence_status: values.phone ? "موجود" : "غير موجود",
    };
  });
  return markContactRowsForReview(rows, ["work_email", "phone"]);
}

describe("item 3: a company in Egypt is not «outside the requested country», in any of the ways its address is written", () => {
  const ADDRESSES = ["Cairo, Egypt", "القاهرة مصر", "القاهرة، مصر", "Égypte", "Le Caire", "Le Caire, Égypte", "Cairo", "Kairo, Ägypten", "El Cairo, Egipto", "Il Cairo, Egitto", "Cairo, Egypt; Berlin, Germany"];
  for (const address of ADDRESSES) {
    it(`company address «${address}», requested EG: not sent to review for its country`, () => {
      const verdict = gate({ ...parseDirectPeopleRows({ leads: [{ ...ERNST, lastCompanyAddress: address }] })[0], work_email: "k@ernst-ai.example", contact_review_status: "مكتمل حسب الحقول المطلوبة" });
      expect(verdict.reasonCode).not.toBe("out_of_scope");
      expect(verdict.decision).toBe("match");
    });
  }

  it("the same French, Spanish, Italian and German spellings are read as Egypt, so a request for another country sees them as foreign", () => {
    for (const written of ["Égypte", "Le Caire, Égypte", "El Cairo, Egipto", "Il Cairo, Egitto", "Kairo, Ägypten", "القاهرة مصر"]) {
      expect(detectCountryFromText(written)?.canonicalEnglish, written).toBe("Egypt");
    }
    const german = { ...parseDirectPeopleRows({ leads: [{ ...ERNST, lastCompanyAddress: "Le Caire, Égypte", address: "Berlin, Germany" }] })[0], work_email: "k@ernst-ai.example", contact_review_status: "x" };
    const verdict = gate(german, { ...PLAN_PARAMS, country: "DE" });
    expect(verdict.reasonCode).toBe("out_of_scope");
  });

  it("an address whose every named country is another country is still outside the request; an address with no country contradicts nothing", () => {
    const row = (address: string) => ({ ...parseDirectPeopleRows({ leads: [{ ...ERNST, lastCompanyAddress: address }] })[0], work_email: "k@ernst-ai.example", contact_review_status: "x" });
    expect(gate(row("Khartoum, Sudan; Dubai, UAE")).reasonCode).toBe("out_of_scope");
    expect(gate(row("Berlin, Germany")).reasonCode).toBe("out_of_scope");
    expect(gate(row("Smart Village, Km 28")).decision).toBe("match");
    expect(gate(row("")).decision).toBe("match");
  });
});

describe("item 4: a person with neither requested contact value is not delivered and not charged", () => {
  const person = (extra: Record<string, any>) => ({ ...parseDirectPeopleRows({ leads: [MONA] })[0], ...extra });
  it("after the lookups: no email and no phone goes to review (reason: no contact), one value is delivered", () => {
    const none = gate(person({ work_email: "", phone: "", contact_review_status: "مراجعة: لم يتوفر بريد مهني و رقم هاتف مهني" }));
    expect(none).toMatchObject({ decision: "uncertain", reasonCode: "no_contact" });
    expect(none.reasonAr).toContain("لم يتوفر لهذا الشخص بريد مهني ولا هاتف مهني");
    expect(gate(person({ work_email: "mona@delta-soft.example", phone: "", contact_review_status: "x" })).decision).toBe("match");
    expect(gate(person({ work_email: "", phone: "+201000000001", contact_review_status: "x" })).decision).toBe("match");
  });

  it("a value the source marked invalid is not a value: a person with only an invalid email goes to review", () => {
    const verdict = gate(person({ work_email: "bad@delta-soft.example", work_email_verification_status: "غير صالح", phone: "", contact_review_status: "x" }));
    expect(verdict.reasonCode).toBe("no_contact");
  });

  it("before the lookups (the people searched to decide whom to look up) nobody is judged by a contact value they cannot have yet", () => {
    expect(gate(person({})).decision).toBe("match");
  });

  it("a request with no contact field keeps its people (the rule applies only to requested contact fields)", () => {
    expect(gate(person({ work_email: "", phone: "", contact_review_status: "x" }), { ...PLAN_PARAMS, requiredContactFields: [] }).decision).toBe("match");
  });

  it("the charge is per field and never for an undelivered field: base only with a value, +55 per delivered email or phone", () => {
    const delivered = adapterRows().filter((row) => gate(row).decision === "match");
    expect(delivered.map((row) => row.contact_name)).toEqual(["Mona Saleh", "Omar Hassan", "Karim Ernst"]);
    expect(decisionMakerDeliveredUnits(delivered, ["work_email", "phone"])).toEqual({ baseUnits: 3, emailUnits: 2, phoneUnits: 2 });
  });
});

describe("item 5: the source's industry label alone is not evidence that a company does the requested activity", () => {
  const withContact = (extra: Record<string, any>) => ({ ...parseDirectPeopleRows({ leads: [{ ...MONA, ...extra }] })[0], work_email: "m@x.example", contact_review_status: "x" });
  it("«Information Technology & Services» with no description and a name that says nothing: review, not delivered", () => {
    const verdict = gate(withContact({ lastCompanyName: "Nile Advisory", lastCompanyDescription: "", lastCompanyIndustry: "Information Technology & Services" }));
    expect(verdict).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
    expect(verdict.reasonAr).toContain("تصنيف المصدر وحده لا يكفي");
  });
  it("a telecommunications label with a description that says nothing about technology: review", () => {
    const verdict = gate(withContact({ lastCompanyName: "Delta Mobile", lastCompanyDescription: "Mobile network operator and voice services", lastCompanyIndustry: "Telecommunications" }));
    expect(verdict).toMatchObject({ decision: "uncertain", reasonCode: "no_evidence" });
  });
  it("an untranslated label («Information Services») with no text of its own: review", () => {
    expect(gate(withContact({ lastCompanyName: "Atlas Group", lastCompanyDescription: "", lastCompanyIndustry: "Information Services" })).decision).toBe("uncertain");
  });
  it("the company's own name or description that names the activity delivers it, whatever the label", () => {
    expect(gate(withContact({ lastCompanyName: "Delta Software", lastCompanyDescription: "", lastCompanyIndustry: "Management Consulting" })).decision).toBe("match");
    expect(gate(withContact({ lastCompanyName: "Atlas Group", lastCompanyDescription: "Cloud software platform", lastCompanyIndustry: "" })).decision).toBe("match");
  });
});

describe("item 1: the lookups send everything known about the person", () => {
  const sent: Array<{ endpointId: string; params: Record<string, any> }> = [];
  beforeEach(() => { sent.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the email lookup carries the company domain with the full name (no profile link: the link finders answered with personal addresses); the phone lookup carries the profile link too and adds the email found", async () => {
    tregCall.mockReset();
    tregCall.mockImplementation(async (options: any) => {
      sent.push({ endpointId: options.endpointId, params: options.params });
      const base = { ok: true, httpStatus: 200, tregCallId: "id", costMicro: 0, latencyMs: 5, isRouteMaxCost: false, isPlatformBalanceLow: false };
      if (options.endpointId === "icypeas.people.search") return { ...base, costMicro: 1900, data: { total: 1, success: true, leads: [MONA] } } as any;
      if (options.endpointId === "treg.people.email.find") return { ...base, data: { output: { email: "mona@delta-soft.example" } } } as any;
      return { ...base, data: { output: { phone: "+201000000001" } } } as any;
    });
    const result = await defaultTregAdapter({
      jobId: "job_quote_identity", userId: "user_1", step: 0, endpointId: "treg.people.search", capabilitySlug: "professional-people-search", method: "POST",
      params: PLAN_PARAMS, paginationStrategy: "none", cursor: null, pageSize: 1, remainingNeeded: 1, targetVolumeMax: 1, deliveredSoFar: 0, decisionMakerSpendBudgetUsd: 0.04,
    } as any);
    const email = sent.find((call) => call.endpointId === "treg.people.email.find")!;
    expect(email.params).toEqual({ domain: "delta-soft.example", full_name: "Mona Saleh", first_name: "Mona", last_name: "Saleh" });
    const phone = sent.find((call) => call.endpointId === "treg.people.phone.find")!;
    expect(phone.params).toEqual({ linkedin_url: "https://www.linkedin.com/in/mona-saleh-a", domain: "delta-soft.example", full_name: "Mona Saleh", first_name: "Mona", last_name: "Saleh", email: "mona@delta-soft.example" });
    // the person's free profile text («mona.boss@…») is never a contact value
    expect(result.rows[0].work_email).toBe("mona@delta-soft.example");
  });
});

describe("item 2: the delivered file is a file of people, in the same columns as the results screen", () => {
  const delivered = () => adapterRows().filter((row) => gate(row).decision === "match").map(peopleDeliveryRow);
  const worker = (rows: Record<string, any>[]) => ({ metadata: { platform: "web", title: "صناع القرار في مصر", template: "professional-people-search", entityType: "people", collectedAt: "2026-10-26T09:13:00Z" }, rows });

  it("a row keeps the person's name and title, the employer's country, city, website and description, and never the person's own biography", () => {
    const [mona] = delivered();
    expect(mona).toEqual({
      contact_name: "Mona Saleh", job_title: "CEO", company_name: "Delta Software", country: "مصر", city: "القاهرة",
      work_email: "mona@delta-soft.example", work_email_verification_status: "لم يتوفر تأكيد", phone: "+201000000001", phone_verification_status: "لم يتوفر تأكيد",
      linkedin_url: "https://www.linkedin.com/in/mona-saleh-a", website: "https://delta-soft.example", industry: "تقنية المعلومات والخدمات التقنية",
      description: "Software development and cloud technology services",
    });
    expect(JSON.stringify(mona)).not.toContain("Leading Delta Software");
  });

  it("people with a company name and a website are still people: the file is the people workbook, not the company one", () => {
    expect(normalizeDataset(worker(delivered())).metadata.entityType).toBe("people");
  });

  it("the workbook has the shared columns in the shared order, one row per person, «غير متاح» where a person has no value", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await generateExcelReport(worker(delivered()))) as any);
    const sheet = workbook.getWorksheet("بيانات المهنيين")!;
    const headers = (sheet.getRow(4).values as any[]).slice(1);
    expect(headers).toEqual(["م", ...PEOPLE_COLUMNS.map((column) => column.titleAr)]);
    expect(headers).toEqual(expect.arrayContaining(["اسم جهة الاتصال", "المسمى الوظيفي", "الشركة", "الدولة", "المدينة", "البريد المهني", "حالة تحقق البريد المهني", "رقم الهاتف", "حالة تحقق الهاتف", "لينكد إن", "موقع الشركة", "وصف الشركة"]));
    const cell = (row: number, title: string) => { const value = sheet.getRow(row).getCell(headers.indexOf(title) + 1).value as any; return typeof value === "object" && value ? value.text ?? value.hyperlink : value; };
    expect(cell(5, "اسم جهة الاتصال")).toBe("Mona Saleh");
    expect(cell(5, "وصف الشركة")).toBe("Software development and cloud technology services");
    expect(cell(5, "موقع الشركة")).toBe("https://delta-soft.example");
    expect(cell(6, "رقم الهاتف")).toBe("غير متاح");
    expect(cell(6, "حالة تحقق الهاتف")).toBe("غير متاح");
    expect(cell(7, "البريد المهني")).toBe("غير متاح");
    expect(cell(7, "الشركة")).toBe("Ernst AI");
    expect(sheet.rowCount).toBe(7);
  });

  it("the review sheet says where the person and the company are, so a review row explains itself", async () => {
    const review = adapterRows().filter((row) => gate(row).decision === "uncertain").map((row) => ({ ...row, _relevance_reason: gate(row).reasonAr }));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await generateExcelReport({ ...worker(delivered()), uncertainRows: review })) as any);
    const sheet = workbook.worksheets.find((candidate) => candidate.name !== "بيانات المهنيين")!;
    const text = (sheet.getRow(3).values as any[]).join(" ");
    expect(text).toContain("عنوان الشركة: Cairo, Egypt");
    expect(text).toContain("عنوان الشخص: Cairo, Egypt");
  });

  it("the screen order is the workbook order", () => {
    expect(orderPeopleColumns(["description", "website", "phone", "contact_name", "extra", "country"])).toEqual(["contact_name", "country", "phone", "website", "description", "extra"]);
  });
});

describe("items 4 and 6: the sentences say what was delivered, in Arabic only, with Arabic-Indic digits", () => {
  const texts = [
    peopleDeliverySentenceAr({ people: 3, withEmail: 2, withPhone: 2 }, 5),
    peopleDeliverySentenceAr({ people: 3, withEmail: 3, withPhone: 0 }, 3),
    peopleDeliverySentenceAr({ people: 1, withEmail: 1, withPhone: 1 }, 1),
    peopleDeliverySentenceAr({ people: 0, withEmail: 0, withPhone: 0 }, 3),
    peopleShortfallReasonAr({ noContact: 3, outside: 1, noEvidence: 2 }),
    peopleShortfallReasonAr({ noContact: 1, outside: 0, noEvidence: 0 }),
    peopleShortfallReasonAr({ noContact: 0, outside: 0, noEvidence: 0 }),
  ];
  it("the completion sentence counts people and each contact value, never «سُلّم ٣ من ٣» for people without contact data", () => {
    expect(texts[0]).toBe("سُلّم ٣ أشخاص (المطلوب ٥)، اثنان منهم لهم بريد مهني واثنان منهم لهم هاتف مكتبي");
    expect(texts[1]).toBe("سُلّم ٣ أشخاص (المطلوب ٣)، لكل منهم بريد مهني وبلا هاتف مكتبي لأي منهم");
    expect(texts[2]).toBe("سُلّم شخص واحد (المطلوب ١)، له بريد مهني وله هاتف مكتبي");
    expect(texts[3]).toBe("لم يُسلَّم أي شخص");
    expect(peopleDeliverySentenceAr({ people: 2, withEmail: 1, withPhone: 2 })).toBe("سُلّم شخصان، واحد منهم له بريد مهني ولكل منهم هاتف مكتبي");
    expect(peopleContactCounts([{ work_email: "a@x.example", phone: "" }, { work_email: "", phone: "+20" }, { work_email: "غير متاح", phone: "" }])).toEqual({ people: 3, withEmail: 1, withPhone: 1 });
  });
  it("the shortfall sentence names what went to review and says none of it is charged", () => {
    expect(texts[4]).toBe("وُضع في ورقة المراجعة: ٣ أشخاص بلا بريد مهني ولا هاتف مهني، شخص واحد في شركة خارج الدولة المطلوبة، شخصان لا يؤكد اسم شركاتهم أو وصفها النشاط المطلوب؛ ولا يُحتسب عليك منهم أحد.");
    expect(texts[5]).toBe("وُضع في ورقة المراجعة: شخص واحد بلا بريد مهني ولا هاتف مهني؛ ولا يُحتسب عليك منهم أحد.");
    expect(texts[6]).toBe("لم يتوفر في المصدر عدد أكبر يطابق طلبك.");
  });
  it("no provider name, no USD, no id, no markdown, no emoji, no Latin digits, no Latin letters", () => {
    for (const text of texts) {
      expect(text, text).not.toMatch(/icypeas|treg|blitz|quickenrich|trykitt|linkedin|USD|\$|\bjob_|\bquote_|\*\*|`|#|\d/i);
      expect(text, text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text, text).not.toMatch(/[A-Za-z]/);
    }
    const reasons = [gate({ ...parseDirectPeopleRows({ leads: [MONA] })[0], work_email: "", phone: "", contact_review_status: "x" }).reasonAr, gate({ ...parseDirectPeopleRows({ leads: [LABEL_ONLY] })[0], work_email: "a@b.example", contact_review_status: "x" }).reasonAr, gate({ ...parseDirectPeopleRows({ leads: [SUDAN] })[0], work_email: "a@b.example", contact_review_status: "x" }).reasonAr];
    for (const text of reasons) {
      expect(text, text).not.toMatch(/icypeas|treg|USD|\$|\*\*|`|\d/i);
      expect(text, text).not.toMatch(/[A-Za-z]/);
    }
  });
});

describe("the worker end to end (fake storage, an injected source): 3 delivered of 5, 3 in review, the charge per field", () => {
  const JOB = jobIdForQuote("quote_people");
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "people-test-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
    db.jobs = [{ id: JOB, user_id: "user_1", status: "running", current_cursor: null, target_volume_max: 5, delivered_units: 0, created_at: new Date().toISOString() }];
    db.quotes = [{ id: "quote_people", user_id: "user_1", output_formats: ["xlsx", "csv"], items: [{ capabilitySlug: "professional-people-search", endpointId: "treg.people.search", targetVolumeMax: 5, paginationStrategy: "none", unitCostUsd: 0.01599, pricingUnit: "item", params: PLAN_PARAMS, requiredContactFields: ["work_email", "phone"] }] }];
    db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = []; db.costs = [];
    db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = 5;
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  it("settles base × 3, email × 2, phone × 2; the file is the people workbook; the review rows carry their reasons; the sentences are honest", async () => {
    const route = await import("../src/app/api/worker/chunk/route");
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: adapterRows(), nextCursor: null, costUsd: 0.0019, costMicro: 1900, tregCallId: "call_1", providerCallCount: 1 }));
    let last: any = null;
    for (let i = 0; i < 6; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST", headers: { authorization: "Bearer people-test-secret" },
        body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
      }));
      last = { status: res.status, json: await res.json() };
      if (last.json.done === true || last.json.released === true || last.status >= 400) break;
    }
    expect(last, JSON.stringify(last.json).slice(0, 600)).toMatchObject({ json: { done: true } });
    expect(last.json.deliveredUnits).toBe(3);

    const settle = db.rpcCalls.find((call) => call.name === "settle_people_job_atomic" && !String(call.args.p_job_id).startsWith("__diger_"))!;
    expect(settle.args).toMatchObject({ p_base_units: 3, p_email_units: 2, p_phone_units: 2 });

    const xlsx = [...db.results.entries()].find(([path]) => path.endsWith("result.xlsx"))!;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx[1] as any);
    const sheet = workbook.getWorksheet("بيانات المهنيين")!;
    expect(sheet, "the people workbook").toBeTruthy();
    expect(workbook.getWorksheet("بيانات الشركات")).toBeUndefined();
    const headers = (sheet.getRow(4).values as any[]).slice(1);
    expect(headers).toEqual(["م", ...PEOPLE_COLUMNS.map((column) => column.titleAr)]);
    const names = [5, 6, 7].map((row) => sheet.getRow(row).getCell(2).value);
    expect(names).toEqual(["Mona Saleh", "Omar Hassan", "Karim Ernst"]);
    const review = workbook.worksheets.find((candidate) => candidate.name !== "بيانات المهنيين")!;
    const reviewText = review.getSheetValues().flat().map((value: any) => (value && typeof value === "object" ? value.text ?? "" : String(value ?? ""))).join(" | ");
    expect(reviewText).toContain("لم يتوفر لهذا الشخص بريد مهني ولا هاتف مهني");
    expect(reviewText).toContain("شركة الشخص خارج النطاق الجغرافي المطلوب");
    expect(reviewText).toContain("تصنيف المصدر وحده لا يكفي");
    expect(reviewText).not.toContain("Ernst");
    expect(reviewText).not.toContain("Sami Khalid"); // the person in Bahrain is refused outright, not put to review

    const messages = db.events.map((event) => String(event.message));
    expect(messages).toContain("سُلّم ٣ أشخاص (المطلوب ٥)، اثنان منهم لهم بريد مهني واثنان منهم لهم هاتف مكتبي، وحُفظت ملفات النتائج.");
    expect(messages.some((message) => message.startsWith("المسلَّم ٣ من ٥ مطلوب. وُضع في ورقة المراجعة: شخص واحد بلا بريد مهني ولا هاتف مهني، شخص واحد في شركة خارج الدولة المطلوبة"))).toBe(true);
    expect(messages.some((message) => /سُلّم ٣ من ٣|تم إكمال استخراج/.test(message))).toBe(false);
  });

  it("the lookup log of the adapter becomes ONE internal job event (its own type, JSON, no personal value); the customer's events are unchanged", async () => {
    const route = await import("../src/app/api/worker/chunk/route");
    const lookupLog = {
      summary: { rows: 6, eligible: 3, noIdentity: 0, lookedUp: 3, lookupCalls: 6, skippedBudget: 0, skippedTime: 0, skippedEnough: 0, withContact: 3 },
      entries: [{ endpoint: "treg.people.email.find", step: "people_email_0_0", person: 0, rank: 0, keys: ["domain", "first_name", "full_name", "last_name", "linkedin_url"], status: 200, latencyMs: 2300, costUsd: 0.000495, servedBy: "provider-a", tried: 2, outcome: "hit" as const, emailPresent: true, phonePresent: false, calls: 1 }],
    };
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: adapterRows(), nextCursor: null, costUsd: 0.0019, costMicro: 1900, tregCallId: "call_1", providerCallCount: 7, lookupLog }));
    for (let i = 0; i < 6; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST", headers: { authorization: "Bearer people-test-secret" },
        body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
      }));
      const json: any = await res.json();
      if (json.done === true || json.released === true || res.status >= 400) break;
    }
    const logs = db.events.filter((event) => event.event_type === "lookup_log");
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(String(logs[0].message));
    expect(parsed).toMatchObject({ step: 0, summary: { lookedUp: 3, lookupCalls: 6 }, lookups: [{ endpoint: "treg.people.email.find", outcome: "hit", status: 200 }] });
    expect(String(logs[0].message)).not.toMatch(/@|Mona|Omar|linkedin\.com|\+20/);
    // the customer's own events never include it
    expect(db.events.filter((event) => event.event_type !== "lookup_log").every((event) => !/lookups|endpoint/.test(String(event.message)))).toBe(true);
  });
});
