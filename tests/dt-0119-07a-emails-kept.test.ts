import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import * as contactFinders from "../src/lib/agentMission/contactFinders";
import type { ContactStep, FinderInfo } from "../src/lib/agentMission/contactFinders";
import { createJobCallBudget } from "../src/lib/server/callBudget";

const MISSION = "msn_emails_kept";
const EMAIL_A: FinderInfo = { id: "cheap.people.email.find", usd: 0.0005, inputs: [{ name: "person_linkedin_url", required: true }] };
const EMAIL_B: FinderInfo = { id: "dear.people.email.find", usd: 0.0089, inputs: [{ name: "domain", required: true }, { name: "full_name", required: false }] };
const VERIFIER_A: FinderInfo = { id: "cheap.email.verify", usd: 0.001, inputs: [{ name: "email", required: true }] };
const COMPANY_LISTER: FinderInfo = { id: "company.mailbox.lister", usd: 0.005, inputs: [{ name: "domain", required: true }] };
const PHONE_A: FinderInfo = { id: "cheap.people.phone.find", usd: 0.0005, inputs: [{ name: "person_linkedin_url", required: true }] };

const columns = [
  { key: "full_name", title_ar: "الاسم" },
  { key: "job_title", title_ar: "المسمى الوظيفي" },
  { key: "linkedin", title_ar: "الملف المهني" },
  { key: "email", title_ar: "الإيميل", kind: "work_email" as const },
  { key: "email_status", title_ar: "حالة توثيق الإيميل", status_of: "email" },
  { key: "phone", title_ar: "رقم التليفون", kind: "phone" as const },
  { key: "phone_status", title_ar: "حالة توثيق رقم التليفون", status_of: "phone" },
];

const person = (i: number, title: string, extra: Record<string, unknown> = {}) => ({
  id: `p${i}`,
  parent_id: "c1",
  full_name: `Person${i} Name${i}`,
  job_title: title,
  linkedin: `https://www.linkedin.com/in/person${i}`,
  email: "",
  phone: "",
  ...extra,
});

const companyColumns = [
  { key: "name", title_ar: "الاسم" },
  { key: "website", title_ar: "الموقع" },
  { key: "company_email", title_ar: "الإيميل العام", kind: "company_email" as const },
  { key: "company_email_status", title_ar: "حالة توثيق الإيميل العام", status_of: "company_email" },
];

async function world(opts: {
  answers: (endpoint: string, params: Record<string, unknown>) => unknown | "refuse" | "fail";
  steps?: ContactStep[];
  ceilingUsd?: number;
  people?: Array<ReturnType<typeof person> & Record<string, unknown>>;
  companyEmail?: string;
  companyWebsite?: string;
  stages?: any[];
  verifiers?: FinderInfo[];
  perPersonUsd?: number;
  companyEmailStatus?: string;
}) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, MISSION);
  await items.commit([
    {
      t: "item",
      stage: "companies",
      id: "c1",
      state: "accepted",
      by: "rule",
      row: {
        id: "c1",
        name: "Orascom EM",
        website: opts.companyWebsite ?? "https://www.orascom-em.com.eg/home",
        ...(opts.companyEmail ? { company_email: opts.companyEmail } : {}),
        ...(opts.companyEmailStatus ? { company_email_status: opts.companyEmailStatus } : {}),
      },
    },
    ...(opts.people ?? [person(1, "Site Engineer")]).map((p) => ({
      t: "item" as const,
      stage: "people",
      id: p.id,
      state: "accepted" as const,
      by: "rule" as const,
      row: { ...p },
    })),
  ]);

  const steps: ContactStep[] = opts.steps ?? [
    {
      kind: "email",
      stage_key: "people",
      column_key: "email",
      status_key: "email_status",
      per_person_usd: opts.perPersonUsd ?? 0.02,
      finders: [EMAIL_A, EMAIL_B],
      ...(opts.verifiers ? { verifiers: opts.verifiers } : {}),
    },
  ];

  const plan: any = {
    stages: opts.stages ?? [
      { key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: companyColumns, planned_rows: 1 },
      { key: "people", parent_key: "companies", title_ar: "موظفو كل شركة", deliver: true, columns, planned_rows: (opts.people ?? [person(1, "Site Engineer")]).length, role_preference: { role: "manager" } },
    ],
    contact_steps: steps,
  };

  const budget = createJobCallBudget({ ceilingUsd: opts.ceilingUsd ?? 1, spentUsd: 0 });
  const calls: Array<{ endpoint: string; params: Record<string, unknown> }> = [];
  let n = 0;
  const priced = new Map([
    [EMAIL_A.id, EMAIL_A.usd],
    [EMAIL_B.id, EMAIL_B.usd],
    [VERIFIER_A.id, VERIFIER_A.usd],
    [COMPANY_LISTER.id, COMPANY_LISTER.usd],
    [PHONE_A.id, PHONE_A.usd],
  ]);

  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      calls.push({ endpoint: a.endpoint_id, params: a.params });
      const out = opts.answers(a.endpoint_id, a.params);
      if (out === "refuse") return { ok: false, call_id: `call_${++n}`, refused: "over_budget", message: "no" };
      if (out === "fail") return { ok: false, call_id: `call_${++n}`, failed: true, http_status: 500, message: "x" };
      const id = `call_${String(++n).padStart(4, "0")}`;
      const hit = out !== null;
      await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json");
      if (hit) budget.settle(0, priced.get(a.endpoint_id) ?? 0.001);
      return { ok: true, call_id: id, http_status: 200, rows_in_page: hit ? 1 : 0, has_more: false, next_cursor: null };
    },
  };

  const events: any[] = [];
  const run = () =>
    runContactEnrichment({
      items,
      store,
      plan,
      missionId: MISSION,
      gateway,
      addEvent: async (e: any) => {
        events.push(e);
      },
      budget,
      deadlineMs: Date.now() + 60_000,
    });

  return { store, items, plan, budget, calls, events, run };
}

const cellsOf = (items: ItemStore, id: string) => {
  const r = items.acceptedRows("people").find((x) => x.id === id)!;
  return {
    email: String(r.email ?? ""),
    email_status: String(r.email_status ?? ""),
    phone: String(r.phone ?? ""),
    phone_status: String(r.phone_status ?? ""),
  };
};

const companyCellsOf = (items: ItemStore, id: string) => {
  const r = items.acceptedRows("companies").find((x) => x.id === id)!;
  return {
    company_email: String(r.company_email ?? ""),
    company_email_status: String(r.company_email_status ?? ""),
  };
};

describe("DT-20261119-07 PR-A: e-mails kept and labelled", () => {
  // Case a
  it("a. personal mailbox only: finder returns gmail address -> cell filled, status «غير موثّق — إيميل شخصي», delivered, filled.email 1", async () => {
    const w = await world({
      answers: (ep) => (ep === EMAIL_A.id ? { found: true, email: "person1.private@gmail.com" } : null),
    });
    const out = await w.run();
    expect(cellsOf(w.items, "p1")).toMatchObject({
      email: "person1.private@gmail.com",
      email_status: "غير موثّق — إيميل شخصي",
    });
    expect(out.filled.email).toBe(1);
    expect(w.events.some((e) => e.message_ar?.includes("وُجد لـ ١ من ١"))).toBe(true);
    const attemptsRaw = await w.store.getFile(MISSION, "contacts/attempts_people_email.json");
    expect(attemptsRaw).not.toBeNull();
    const attempts = JSON.parse(attemptsRaw!);
    expect(attempts.outcomes?.["cheap.people.email.find|value"]).toBe(1);
  });

  // Case b
  it("b. personal first, work later: A gmail, B work -> cell = work address, status «غير موثّق — إيميل شخصي: person1.private@gmail.com», withheld.personal_email 1", async () => {
    const w = await world({
      answers: (ep, p) => {
        if (ep === EMAIL_A.id) return { found: true, email: "person1.private@gmail.com" };
        if (ep === EMAIL_B.id) return { found: true, email: "person1@orascom-em.com.eg" };
        return null;
      },
    });
    const out = await w.run();
    expect(cellsOf(w.items, "p1")).toMatchObject({
      email: "person1@orascom-em.com.eg",
      email_status: "غير موثّق — إيميل شخصي: person1.private@gmail.com",
    });
    expect(out.withheld.personal_email).toBe(1);
    expect(out.filled.email).toBe(1);
  });

  // Case c
  it("c. one answer holding a professional AND a gmail address: professional in cell, gmail in note; gmail listed first does not hide professional", async () => {
    const w = await world({
      answers: (ep) =>
        ep === EMAIL_A.id
          ? {
              emails: ["person1.private@gmail.com", "person1@orascom-em.com.eg"],
            }
          : null,
    });
    const out = await w.run();
    expect(cellsOf(w.items, "p1")).toMatchObject({
      email: "person1@orascom-em.com.eg",
      email_status: "غير موثّق — إيميل شخصي: person1.private@gmail.com",
    });
    expect(out.filled.email).toBe(1);
  });

  // Case d
  it("d. company address given by source (or finder) and nothing better -> kept with «غير موثّق — إيميل الشركة»; work address later wins without company note", async () => {
    // d1: source gave company row address, finders return nothing
    const w1 = await world({
      companyEmail: "info@orascom-em.com.eg",
      people: [person(1, "Manager", { email: "info@orascom-em.com.eg" })],
      answers: () => null,
    });
    await w1.run();
    expect(cellsOf(w1.items, "p1")).toMatchObject({
      email: "info@orascom-em.com.eg",
      email_status: "غير موثّق — إيميل الشركة",
    });

    // d2: finder returns company address and nothing better
    const w2 = await world({
      companyEmail: "info@orascom-em.com.eg",
      people: [person(1, "Manager")],
      answers: (ep) => (ep === EMAIL_A.id ? { email: "info@orascom-em.com.eg" } : null),
    });
    await w2.run();
    expect(cellsOf(w2.items, "p1")).toMatchObject({
      email: "info@orascom-em.com.eg",
      email_status: "غير موثّق — إيميل الشركة",
    });

    // d3: finder A returns company address, finder B returns work address
    const w3 = await world({
      companyEmail: "info@orascom-em.com.eg",
      people: [person(1, "Manager")],
      answers: (ep) => {
        if (ep === EMAIL_A.id) return { email: "info@orascom-em.com.eg" };
        if (ep === EMAIL_B.id) return { email: "person1@orascom-em.com.eg" };
        return null;
      },
    });
    await w3.run();
    expect(cellsOf(w3.items, "p1")).toMatchObject({
      email: "person1@orascom-em.com.eg",
      email_status: "غير موثّق",
    });
  });

  // Case e
  it("e. both a personal mailbox and a company address, nothing better -> personal mailbox in cell with «إيميل شخصي» only", async () => {
    const w = await world({
      companyEmail: "info@orascom-em.com.eg",
      people: [person(1, "Manager")],
      answers: (ep) => {
        if (ep === EMAIL_A.id) return { email: "info@orascom-em.com.eg" };
        if (ep === EMAIL_B.id) return { email: "person1.private@gmail.com" };
        return null;
      },
    });
    await w.run();
    expect(cellsOf(w.items, "p1")).toMatchObject({
      email: "person1.private@gmail.com",
      email_status: "غير موثّق — إيميل شخصي",
    });
  });

  // Case f
  it("f. shared address: two people of one company keep it with «مشترك»; final «موثّق» keep «موثّق — مشترك»; stopped run still labels", async () => {
    const SHARED = "team@orascom-em.com.eg";
    // f1: two people find the same address
    const w1 = await world({
      people: [person(1, "Manager"), person(2, "CEO")],
      answers: (ep) => (ep === EMAIL_A.id ? { email: SHARED } : null),
    });
    const out1 = await w1.run();
    expect(cellsOf(w1.items, "p1")).toMatchObject({
      email: SHARED,
      email_status: "غير موثّق — مشترك",
    });
    expect(cellsOf(w1.items, "p2")).toMatchObject({
      email: SHARED,
      email_status: "غير موثّق — مشترك",
    });
    expect(out1.filled.email).toBe(2);

    // f2: two people already have final «موثّق» address, third has own
    const w2 = await world({
      people: [
        person(1, "Manager", { email: SHARED, email_status: "موثّق" }),
        person(2, "CEO", { email: SHARED, email_status: "موثّق" }),
        person(3, "Accountant", { email: "own3@orascom-em.com.eg", email_status: "موثّق" }),
      ],
      answers: () => null,
    });
    await w2.run();
    expect(cellsOf(w2.items, "p1")).toMatchObject({
      email: SHARED,
      email_status: "موثّق — مشترك",
    });
    expect(cellsOf(w2.items, "p2")).toMatchObject({
      email: SHARED,
      email_status: "موثّق — مشترك",
    });
    expect(cellsOf(w2.items, "p3")).toMatchObject({
      email: "own3@orascom-em.com.eg",
      email_status: "موثّق",
    });

    // f3: run stopped on first person still labels address shared by unreached people
    const w3 = await world({
      people: [
        person(1, "Manager"),
        person(2, "CEO", { email: SHARED, email_status: "غير موثّق" }),
        person(3, "Accountant", { email: SHARED, email_status: "غير موثّق" }),
      ],
      answers: () => "refuse",
    });
    await w3.run();
    expect(cellsOf(w3.items, "p2")).toMatchObject({
      email: SHARED,
      email_status: "غير موثّق — مشترك",
    });
    expect(cellsOf(w3.items, "p3")).toMatchObject({
      email: SHARED,
      email_status: "غير موثّق — مشترك",
    });
  });

  // Case g
  it("g. RE-RUN: second run appends no label twice (idempotent) and does not verify again a row whose status is «موثّق — مشترك» / «موثّق — إيميل شخصي»", async () => {
    const SHARED = "team@orascom-em.com.eg";
    let verifyCalls = 0;
    const companyStep: ContactStep = {
      kind: "email",
      level: "company",
      stage_key: "companies",
      column_key: "company_email",
      status_key: "company_email_status",
      per_person_usd: COMPANY_LISTER.usd,
      finders: [COMPANY_LISTER],
      verifiers: [VERIFIER_A],
    };
    const peopleStep: ContactStep = {
      kind: "email",
      stage_key: "people",
      column_key: "email",
      status_key: "email_status",
      per_person_usd: 0.02,
      finders: [EMAIL_A, EMAIL_B],
      verifiers: [VERIFIER_A],
    };
    const w = await world({
      steps: [companyStep, peopleStep],
      companyEmail: "company@orascom-em.com.eg",
      companyEmailStatus: "موثّق — إيميل على نطاق الشركة",
      people: [
        person(1, "Manager", { email: SHARED, email_status: "موثّق — مشترك" }),
        person(2, "CEO", { email: "p2@orascom-em.com.eg", email_status: "موثّق — إيميل شخصي" }),
      ],
      answers: (ep) => {
        if (ep === VERIFIER_A.id) {
          verifyCalls++;
          return { status: "safe", deliverable: true };
        }
        return null;
      },
    });
    await w.run();
    expect(verifyCalls).toBe(0);
    expect(companyCellsOf(w.items, "c1").company_email_status).toBe("موثّق — إيميل على نطاق الشركة");
    expect(cellsOf(w.items, "p1").email_status).toBe("موثّق — مشترك");
    expect(cellsOf(w.items, "p2").email_status).toBe("موثّق — إيميل شخصي");

    // run again on the same store
    await w.run();
    expect(verifyCalls).toBe(0);
    expect(companyCellsOf(w.items, "c1").company_email_status).toBe("موثّق — إيميل على نطاق الشركة");
    expect(cellsOf(w.items, "p1").email_status).toBe("موثّق — مشترك");
    expect(cellsOf(w.items, "p2").email_status).toBe("موثّق — إيميل شخصي");
  });

  // Case h (P8)
  it("h. P8: company lister answer with no role mailbox and address on company domain -> kept as «غير موثّق — إيميل على نطاق الشركة»; other domain ignored; role mailbox wins; fromPeople behaves same", async () => {
    const step: ContactStep = {
      kind: "email",
      level: "company",
      stage_key: "companies",
      column_key: "company_email",
      status_key: "company_email_status",
      per_person_usd: COMPANY_LISTER.usd,
      finders: [COMPANY_LISTER],
    };

    // h1: address on company domain
    const w1 = await world({
      steps: [step],
      answers: (ep) =>
        ep === COMPANY_LISTER.id ? { emails: ["general.worker@orascom-em.com.eg"] } : null,
    });
    await w1.run();
    expect(companyCellsOf(w1.items, "c1")).toMatchObject({
      company_email: "general.worker@orascom-em.com.eg",
      company_email_status: "غير موثّق — إيميل على نطاق الشركة",
    });

    // h2: address on other domain stays out
    const w2 = await world({
      steps: [step],
      answers: (ep) =>
        ep === COMPANY_LISTER.id ? { emails: ["general.worker@otherdomain.com"] } : null,
    });
    await w2.run();
    expect(companyCellsOf(w2.items, "c1").company_email).toBe("غير متوفر");
    expect(companyCellsOf(w2.items, "c1").company_email).not.toBe("general.worker@otherdomain.com");

    // h3: role mailbox wins and carries no label
    const w3 = await world({
      steps: [step],
      answers: (ep) =>
        ep === COMPANY_LISTER.id
          ? { emails: ["general.worker@orascom-em.com.eg", "info@orascom-em.com.eg"] }
          : null,
    });
    await w3.run();
    expect(companyCellsOf(w3.items, "c1")).toMatchObject({
      company_email: "info@orascom-em.com.eg",
      company_email_status: "غير موثّق",
    });

    // h4: fromPeople case
    const w4 = await world({
      steps: [step],
      answers: () => null,
    });
    await w4.items.commit([
      {
        t: "item",
        stage: "people",
        id: "p_ex1",
        state: "excluded",
        reason: "not_a_person",
        by: "rule",
        row: person(99, "Worker", { id: "p_ex1", parent_id: "c1", email: "worker@orascom-em.com.eg" }),
      },
    ]);
    await w4.run();
    expect(companyCellsOf(w4.items, "c1")).toMatchObject({
      company_email: "worker@orascom-em.com.eg",
      company_email_status: "غير موثّق — إيميل على نطاق الشركة",
    });
  });

  // Case i (counters / controls - pass on main)
  it("i. counters: empty finder answer stays empty; hit makes no further calls; plan with no contact step makes no calls", async () => {
    // empty stays empty
    const w1 = await world({
      answers: () => null,
    });
    await w1.run();
    expect(cellsOf(w1.items, "p1")).toMatchObject({
      email: "",
      email_status: "",
    });

    // hit in chain makes no further call
    const w2 = await world({
      answers: (ep) => (ep === EMAIL_A.id ? { found: true, email: "person1@orascom-em.com.eg" } : null),
    });
    await w2.run();
    expect(w2.calls.map((c) => c.endpoint)).toEqual([EMAIL_A.id]);

    // no contact step makes no calls
    const w3 = await world({
      steps: [],
      answers: () => ({ email: "test@orascom-em.com.eg" }),
    });
    await w3.run();
    expect(w3.calls.length).toBe(0);

    // personal or company address is not learned for the phone step (M15)
    const PHONE_BY_EMAIL: FinderInfo = { id: "phone.by.email", usd: 0.0005, inputs: [{ name: "email", required: true }] };
    const emailStep: ContactStep = {
      kind: "email",
      stage_key: "people",
      column_key: "email",
      status_key: "email_status",
      per_person_usd: 0.02,
      finders: [EMAIL_A],
    };
    const phoneStep: ContactStep = {
      kind: "phone",
      stage_key: "people",
      column_key: "phone",
      status_key: "phone_status",
      per_person_usd: 0.02,
      finders: [PHONE_BY_EMAIL],
    };
    const w4 = await world({
      steps: [emailStep, phoneStep],
      answers: (ep) => (ep === EMAIL_A.id ? { email: "person1.private@gmail.com" } : null),
    });
    await w4.run();
    expect(w4.calls.some((c) => c.endpoint === "phone.by.email")).toBe(false);
  });

  // Case j (pure)
  it("j. pure: labelledStatus and statusHead behave as specified", () => {
    const labelledStatus = (contactFinders as any).labelledStatus;
    const statusHead = (contactFinders as any).statusHead;
    const EMAIL_LABEL_SHARED_AR = (contactFinders as any).EMAIL_LABEL_SHARED_AR ?? "مشترك";

    expect(typeof labelledStatus).toBe("function");
    expect(typeof statusHead).toBe("function");

    expect(labelledStatus("", EMAIL_LABEL_SHARED_AR)).toBe("مشترك");
    expect(labelledStatus("غير موثّق", EMAIL_LABEL_SHARED_AR)).toBe("غير موثّق — مشترك");
    expect(labelledStatus("غير موثّق — مشترك", EMAIL_LABEL_SHARED_AR)).toBe("غير موثّق — مشترك");
    expect(statusHead("موثّق — مشترك")).toBe("موثّق");
    expect(statusHead("موثّق")).toBe("موثّق");
  });
});
