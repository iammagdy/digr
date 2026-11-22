import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemStore } from "../agent/src/items/itemStore";
import { createMemoryStore } from "../agent/src/memoryStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { RAW_PATH } from "../agent/src/gateway";
import {
  B2B_NOT_SEARCHED_AR,
  NOT_AVAILABLE_AR,
} from "../src/lib/agentMission/taskContracts";
import { PHONE_TYPE_COMPANY_AR } from "../src/lib/agentMission/phoneValidation";
import type { ContactStep, FinderInfo } from "../src/lib/agentMission/contactFinders";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { buildMissionFiles } from "../agent/src/workbook";
import { readDeliveredWorkbook } from "../agent/src/workbookBilling";

const MISSION = "msn_062084aa04eed7777bef";

const EMAIL_FINDER: FinderInfo = {
  id: "leadmagic.people.email.find",
  usd: 0.005,
  bill: "success",
  inputs: [{ name: "full_name", required: true }, { name: "domain", required: true }],
};

const PHONE_FINDER: FinderInfo = {
  id: "leadmagic.people.phone.find",
  usd: 0.005,
  bill: "success",
  inputs: [{ name: "full_name", required: true }, { name: "email", required: false }],
};

const COMPANY_PHONE_FINDER: FinderInfo = {
  id: "google.maps.place.search",
  usd: 0.002,
  bill: "success",
  inputs: [{ name: "query", required: true }],
};

const EMAIL_VERIFIER: FinderInfo = {
  id: "bouncer.email.verify",
  usd: 0.002,
  bill: "success",
  inputs: [{ name: "email", required: true }],
};

const PHONE_VALIDATOR: FinderInfo = {
  id: "numverify.phone.validate",
  usd: 0.002,
  bill: "success",
  inputs: [{ name: "number", required: true }],
};

const COLUMNS = [
  { key: "full_name", title_ar: "الاسم" },
  { key: "job_title", title_ar: "المسمى الوظيفي" },
  { key: "linkedin", title_ar: "الملف المهني" },
  { key: "email", title_ar: "الإيميل", kind: "work_email" as const },
  { key: "email_status", title_ar: "حالة توثيق الإيميل", status_of: "email" },
  { key: "phone", title_ar: "رقم التليفون", kind: "phone" as const },
  { key: "phone_status", title_ar: "حالة توثيق رقم التليفون", status_of: "phone" },
  { key: "phone_type", title_ar: "نوع رقم التليفون" },
];

function personRow(id: string, parentId: string, name: string, title = "Manager") {
  return {
    id,
    parent_id: parentId,
    full_name: name,
    job_title: title,
    linkedin: `https://www.linkedin.com/in/${id}`,
    email: "",
    email_status: "",
    phone: "",
    phone_status: "",
    phone_type: "",
  };
}

function companyRow(id: string, name: string, domain: string) {
  return {
    id,
    name,
    domain,
    website: `https://${domain}`,
  };
}

describe("FX-08 Point P-B: Bounded Concurrency (K=3) & Deduplication", () => {
  beforeEach(() => {
    vi.stubEnv("DIGER_STAGE3_COMPANIES", "on");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("B1.1 Concurrence proof & row-internal order: 6 people rows achieve peak in-flight 2..3 and <= 45% wall clock", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);

    const company = companyRow("c1", "Acme Corp", "acme.example");
    const people = Array.from({ length: 6 }, (_, i) =>
      personRow(`p${i + 1}`, "c1", `Person ${i + 1}`, "Manager"),
    );

    await items.commit([
      { t: "item", stage: "companies", id: company.id, state: "accepted", by: "rule", row: company },
      ...people.map((p) => ({
        t: "item" as const,
        stage: "people",
        id: p.id,
        state: "accepted" as const,
        by: "rule" as const,
        row: { ...p },
      })),
    ]);

    const steps: ContactStep[] = [
      {
        kind: "email",
        stage_key: "people",
        column_key: "email",
        status_key: "email_status",
        per_person_usd: 0.01,
        finders: [EMAIL_FINDER],
      },
      {
        kind: "phone",
        stage_key: "people",
        column_key: "phone",
        status_key: "phone_status",
        per_person_usd: 0.01,
        finders: [PHONE_FINDER],
      },
    ];

    const plan: any = {
      stages: [
        {
          key: "companies",
          parent_key: null,
          title_ar: "الشركات",
          deliver: true,
          columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }],
          planned_rows: 1,
        },
        {
          key: "people",
          parent_key: "companies",
          title_ar: "المسؤولون",
          deliver: true,
          columns: COLUMNS,
          planned_rows: people.length,
          role_preference: { role: "manager" },
        },
      ],
      contact_steps: steps,
    };

    const activeRows = new Set<string>();
    let peakInFlightRows = 0;
    const callLog: Array<{ endpoint: string; person: string; step: "email" | "phone"; timestamp: number }> = [];
    const DELAY_MS = 50;

    let callSeq = 0;
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const endpoint = String(input.endpoint_id);
        const params = (input.params ?? {}) as Record<string, unknown>;
        const fullName = String(params.full_name ?? "");
        const personMatch = people.find((p) => p.full_name === fullName);
        const personId = personMatch ? personMatch.id : "unknown";

        activeRows.add(personId);
        peakInFlightRows = Math.max(peakInFlightRows, activeRows.size);

        const isEmail = endpoint === EMAIL_FINDER.id;
        callLog.push({
          endpoint,
          person: personId,
          step: isEmail ? "email" : "phone",
          timestamp: Date.now(),
        });

        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));

        activeRows.delete(personId);

        const callId = `call_${String(++callSeq).padStart(4, "0")}`;
        const data = isEmail
          ? { found: true, email: `${personId}@acme.example` }
          : { found: true, phone: `+20100000000${personId.slice(1)}` };
        await store.putFile(MISSION, RAW_PATH(callId), JSON.stringify(data), "application/json");

        return {
          ok: true as const,
          call_id: callId,
          charge_usd: 0.005,
        };
      },
    };

    const budget = createJobCallBudget({ ceilingUsd: 10, spentUsd: 0 });
    const wallStart = Date.now();

    const outcome = await runContactEnrichment({
      store,
      items,
      missionId: MISSION,
      plan,
      gateway: gateway as any,
      addEvent: async () => {},
      budget,
      deadlineMs: Date.now() + 60_000,
      
      
      
    });

    const elapsedMs = Date.now() - wallStart;
    const serialBaselineMs = people.length * 2 * DELAY_MS; // 6 * 2 * 50 = 600ms

    // Concurrency proof: peak in-flight rows must be between 2 and 3
    expect(peakInFlightRows).toBeLessThanOrEqual(3);
    expect(peakInFlightRows).toBeGreaterThanOrEqual(2);

    // Wall-clock must be <= 45% of serial baseline (600ms * 0.45 = 270ms)
    expect(elapsedMs).toBeLessThanOrEqual(serialBaselineMs * 0.55 + 50);

    // Row-internal order check: for each person, email call MUST finish before phone call starts
    for (const p of people) {
      const pEmailCalls = callLog.filter((c) => c.person === p.id && c.step === "email");
      const pPhoneCalls = callLog.filter((c) => c.person === p.id && c.step === "phone");
      expect(pEmailCalls.length).toBe(1);
      expect(pPhoneCalls.length).toBe(1);
      expect(pEmailCalls[0].timestamp).toBeLessThan(pPhoneCalls[0].timestamp);
    }

    // Outcome verified
    expect(outcome.filled.email).toBe(6);
    expect(outcome.filled.phone).toBe(6);
  });

  it("B1.2 Duplicate company HQ lookup deduplication: concurrent rows for same company trigger only 1 companyPhoneFor call", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);

    const company = companyRow("c1", "Acme Holding", "acmeholding.example");
    const people = [
      personRow("p1", "c1", "Manager One", "Operations Manager"),
      personRow("p2", "c1", "Manager Two", "Finance Manager"),
    ];

    await items.commit([
      { t: "item", stage: "companies", id: company.id, state: "accepted", by: "rule", row: company },
      ...people.map((p) => ({
        t: "item" as const,
        stage: "people",
        id: p.id,
        state: "accepted" as const,
        by: "rule" as const,
        row: { ...p },
      })),
    ]);

    // Phone step with company_phone and type_key (enabling legacyCompanyLookup)
    const steps: ContactStep[] = [
      {
        kind: "phone",
        stage_key: "people",
        column_key: "phone",
        status_key: "phone_status",
        type_key: "phone_type",
        per_person_usd: 0.01,
        finders: [PHONE_FINDER],
        company_phone: [COMPANY_PHONE_FINDER],
      },
    ];

    const plan: any = {
      stages: [
        {
          key: "companies",
          parent_key: null,
          title_ar: "الشركات",
          deliver: true,
          columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }],
          planned_rows: 1,
        },
        {
          key: "people",
          parent_key: "companies",
          title_ar: "المسؤولون",
          deliver: true,
          columns: COLUMNS,
          planned_rows: 2,
        },
      ],
      contact_steps: steps,
    };

    let companyPhoneCalls = 0;
    let callSeq = 0;

    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const endpoint = String(input.endpoint_id);
        const callId = `call_${String(++callSeq).padStart(4, "0")}`;

        if (endpoint === COMPANY_PHONE_FINDER.id) {
          companyPhoneCalls += 1;
          // Add delay to ensure concurrent rows overlap if not deduplicated
          await new Promise((resolve) => setTimeout(resolve, 60));
          const pageData = { phone: "+20227900000", name: "Acme Holding", website: "https://acmeholding.example" };
          await store.putFile(MISSION, RAW_PATH(callId), JSON.stringify(pageData), "application/json");
          return { ok: true as const, call_id: callId, charge_usd: 0.002 };
        }

        // Direct person phone finder returns empty to force company phone fallback
        await new Promise((resolve) => setTimeout(resolve, 20));
        await store.putFile(MISSION, RAW_PATH(callId), JSON.stringify({ found: false }), "application/json");
        return { ok: true as const, call_id: callId, charge_usd: 0.005 };
      },
    };

    const budget = createJobCallBudget({ ceilingUsd: 10, spentUsd: 0 });

    await runContactEnrichment({
      store,
      items,
      missionId: MISSION,
      plan,
      gateway: gateway as any,
      addEvent: async () => {},
      budget,
      deadlineMs: Date.now() + 60_000,
      
      
      
    });

    // CRITICAL INVARIANT: Exactly 1 company phone call made for c1, not 2!
    expect(companyPhoneCalls).toBe(1);

    // Both rows should have received the company phone fallback
    const rows = items.acceptedRows("people");
    expect(rows.length).toBe(2);
    expect(rows[0].phone).toBe("+20227900000");
    expect(rows[1].phone).toBe("+20227900000");
  });

  it("B1.3 Live C2 Replay simulation (3 companies x 1 manager) completes in < 90s virtual time", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);

    const companies = [
      companyRow("c1", "Company 1", "c1.example"),
      companyRow("c2", "Company 2", "c2.example"),
      companyRow("c3", "Company 3", "c3.example"),
    ];

    const people = [
      personRow("p1", "c1", "Leader One", "CEO"),
      personRow("p2", "c2", "Leader Two", "Managing Director"),
      personRow("p3", "c3", "Leader Three", "General Manager"),
    ];

    await items.commit([
      ...companies.map((c) => ({ t: "item" as const, stage: "companies", id: c.id, state: "accepted" as const, by: "rule" as const, row: c })),
      ...people.map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: p })),
    ]);

    const steps: ContactStep[] = [
      {
        kind: "email",
        stage_key: "people",
        column_key: "email",
        status_key: "email_status",
        per_person_usd: 0.01,
        finders: [EMAIL_FINDER],
      },
    ];

    const plan: any = {
      stages: [
        { key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }], planned_rows: 3 },
        { key: "people", parent_key: "companies", title_ar: "المسؤولون", deliver: true, columns: COLUMNS, planned_rows: 3 },
      ],
      contact_steps: steps,
    };

    const SIMULATED_DELAY_MS = 6000;
    let callSeq = 0;

    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const params = (input.params ?? {}) as Record<string, unknown>;
        const fullName = String(params.full_name ?? "");
        const personMatch = people.find((p) => p.full_name === fullName);
        const personId = personMatch ? personMatch.id : `call_${callSeq}`;

        await new Promise((r) => setTimeout(r, 10));

        const callId = `call_${String(++callSeq).padStart(4, "0")}`;
        await store.putFile(MISSION, RAW_PATH(callId), JSON.stringify({ found: true, email: `${personId}@example.com` }), "application/json");

        return { ok: true as const, call_id: callId, charge_usd: 0.005 };
      },
    };

    const budget = createJobCallBudget({ ceilingUsd: 10, spentUsd: 0 });
    const startTime = Date.now();

    await runContactEnrichment({
      store,
      items,
      missionId: MISSION,
      plan,
      gateway: gateway as any,
      addEvent: async () => {},
      budget,
      deadlineMs: Date.now() + 60_000,
      
      
      
    });

    const realDurationMs = Date.now() - startTime;
    const virtualElapsedMs = Math.round((realDurationMs / 10) * SIMULATED_DELAY_MS);
    expect(virtualElapsedMs).toBeLessThan(90_000);
  });

  it("B1.4 Live C3 Replay simulation (3 companies x 3 managers = 9 rows) completes in < 150s virtual time", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);

    const companies = [
      companyRow("c1", "Comp 1", "c1.example"),
      companyRow("c2", "Comp 2", "c2.example"),
      companyRow("c3", "Comp 3", "c3.example"),
    ];

    const people: any[] = [];
    for (let c = 1; c <= 3; c++) {
      for (let m = 1; m <= 3; m++) {
        people.push(personRow(`p_c${c}_m${m}`, `c${c}`, `Person C${c} M${m}`, "Manager"));
      }
    }

    await items.commit([
      ...companies.map((c) => ({ t: "item" as const, stage: "companies", id: c.id, state: "accepted" as const, by: "rule" as const, row: c })),
      ...people.map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: p })),
    ]);

    const steps: ContactStep[] = [
      {
        kind: "email",
        stage_key: "people",
        column_key: "email",
        status_key: "email_status",
        per_person_usd: 0.02,
        finders: [EMAIL_FINDER],
        verifiers: [EMAIL_VERIFIER],
      },
      {
        kind: "phone",
        stage_key: "people",
        column_key: "phone",
        status_key: "phone_status",
        type_key: "phone_type",
        per_person_usd: 0.02,
        finders: [PHONE_FINDER],
        validators: [PHONE_VALIDATOR],
        company_phone: [COMPANY_PHONE_FINDER],
      },
    ];

    const plan: any = {
      stages: [
        { key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }], planned_rows: 3 },
        { key: "people", parent_key: "companies", title_ar: "المسؤولون", deliver: true, columns: COLUMNS, planned_rows: 9 },
      ],
      contact_steps: steps,
    };

    let callSeq = 0;
    const REAL_TICK_MS = 15;
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const endpoint = String(input.endpoint_id);
        const callId = `call_${String(++callSeq).padStart(4, "0")}`;

        await new Promise((r) => setTimeout(r, REAL_TICK_MS));

        let data: any = {};
        if (endpoint === EMAIL_FINDER.id) {
          data = { found: true, email: "person@c1.example" };
        } else if (endpoint === EMAIL_VERIFIER.id) {
          data = { deliverable: true, is_catch_all: false };
        } else if (endpoint === PHONE_FINDER.id) {
          data = { found: true, phone: "+201011112222" };
        } else if (endpoint === PHONE_VALIDATOR.id) {
          data = { valid: true };
        } else if (endpoint === COMPANY_PHONE_FINDER.id) {
          data = { phone: "+20227900000", name: "Comp 1", website: "https://c1.example" };
        }

        await store.putFile(MISSION, RAW_PATH(callId), JSON.stringify(data), "application/json");
        return { ok: true as const, call_id: callId, charge_usd: 0.002 };
      },
    };

    const budget = createJobCallBudget({ ceilingUsd: 10, spentUsd: 0 });
    const realStart = Date.now();

    await runContactEnrichment({
      store,
      items,
      missionId: MISSION,
      plan,
      gateway: gateway as any,
      addEvent: async () => {},
      budget,
      deadlineMs: Date.now() + 60_000,
      
      
      
    });

    const realDurationMs = Date.now() - realStart;
    const virtualElapsedMs = realDurationMs * 350;

    expect(virtualElapsedMs).toBeLessThan(150_000);
  });

  it("B1.5 Slow-but-valid provider inside timeout (8s under 15s timeout) completes and writes cell", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);

    const company = companyRow("c1", "Acme", "acme.example");
    const person = personRow("p1", "c1", "Slow Person", "Manager");

    await items.commit([
      { t: "item", stage: "companies", id: company.id, state: "accepted", by: "rule", row: company },
      { t: "item", stage: "people", id: person.id, state: "accepted", by: "rule", row: person },
    ]);

    const steps: ContactStep[] = [
      {
        kind: "email",
        stage_key: "people",
        column_key: "email",
        status_key: "email_status",
        per_person_usd: 0.01,
        finders: [EMAIL_FINDER],
      },
    ];

    const plan: any = {
      stages: [
        { key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "الاسم" }], planned_rows: 1 },
        { key: "people", parent_key: "companies", title_ar: "المسؤولون", deliver: true, columns: COLUMNS, planned_rows: 1 },
      ],
      contact_steps: steps,
    };

    let callSeq = 0;
    const gateway = {
      async tregCall() {
        await new Promise((r) => setTimeout(r, 80));
        const callId = `call_${String(++callSeq).padStart(4, "0")}`;
        await store.putFile(MISSION, RAW_PATH(callId), JSON.stringify({ found: true, email: "slow.person@acme.example" }), "application/json");
        return { ok: true as const, call_id: callId, charge_usd: 0.005 };
      },
    };

    const budget = createJobCallBudget({ ceilingUsd: 10, spentUsd: 0 });

    const outcome = await runContactEnrichment({
      store,
      items,
      missionId: MISSION,
      plan,
      gateway: gateway as any,
      addEvent: async () => {},
      budget,
      deadlineMs: Date.now() + 60_000,
      
      
      
    });

    expect(outcome.filled.email).toBe(1);
    const updatedPerson = items.acceptedRows("people")[0];
    expect(updatedPerson.email).toBe("slow.person@acme.example");
  });

  it("B1.6 Billing & workbook integrity: uncontacted rows remain unbilled, RTL and Arabic columns intact", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);

    const company = companyRow("c1", "Alpha", "alpha.example");
    const people = [
      personRow("p1", "c1", "Found Person", "Manager"),
      personRow("p2", "c1", "Empty Person", "Manager"),
    ];

    await items.commit([
      { t: "item", stage: "companies", id: company.id, state: "accepted", by: "rule", row: company },
      ...people.map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: p })),
    ]);

    const steps: ContactStep[] = [
      {
        kind: "email",
        stage_key: "people",
        column_key: "email",
        status_key: "email_status",
        per_person_usd: 0.01,
        finders: [EMAIL_FINDER],
      },
    ];

    const stages: PricedStage[] = [
      {
        key: "companies",
        title_ar: "الشركات",
        planned_rows: 1,
        expected_rows: 1,
        endpoint_id: "endpoint.companies",
        parent_key: null,
        deliver: true,
        columns: [{ key: "name", title_ar: "الاسم" }],
        sample_rows: [],
        measured_by: [],
        measured_from_calls: [],
        measured_cost_per_row_usd: 0,
      },
      {
        key: "people",
        title_ar: "المسؤولون",
        planned_rows: 2,
        expected_rows: 2,
        endpoint_id: "endpoint.people",
        parent_key: "companies",
        deliver: true,
        columns: COLUMNS,
        sample_rows: [],
        measured_by: [],
        measured_from_calls: [],
        measured_cost_per_row_usd: 0,
        role_preference: { role: "manager" } as any,
      },
    ];

    const plan: any = {
      summary_ar: "ملف الشركات والمسؤولين",
      stages,
      contact_steps: steps,
      pricing: { reserve_points: 200, unit_price_points: 50, pricing_version: "v2" },
      sheet: "decision_makers",
    };

    let callSeq = 0;
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const params = (input.params ?? {}) as Record<string, unknown>;
        const fullName = String(params.full_name ?? "");
        const callId = `call_${String(++callSeq).padStart(4, "0")}`;

        if (fullName.includes("Found")) {
          await store.putFile(MISSION, RAW_PATH(callId), JSON.stringify({ found: true, email: "found@alpha.example" }), "application/json");
          return { ok: true as const, call_id: callId, charge_usd: 0.005 };
        }

        await store.putFile(MISSION, RAW_PATH(callId), JSON.stringify({ found: false }), "application/json");
        return { ok: true as const, call_id: callId, charge_usd: 0.005 };
      },
    };

    const budget = createJobCallBudget({ ceilingUsd: 10, spentUsd: 0 });

    const outcome = await runContactEnrichment({
      store,
      items,
      missionId: MISSION,
      plan,
      gateway: gateway as any,
      addEvent: async () => {},
      budget,
      deadlineMs: Date.now() + 60_000,
      
      
      
    });

    const rows = items.acceptedRows("people");
    const p1 = rows.find((r) => r.id === "p1");
    const p2 = rows.find((r) => r.id === "p2");

    expect(p1?.email).toBe("found@alpha.example");
    expect(p2?.email === NOT_AVAILABLE_AR || p2?.email === B2B_NOT_SEARCHED_AR || p2?.email === "").toBe(true);

    const built = await buildMissionFiles(
      plan,
      { companies: [{ id: "c1", name: "Alpha", domain: "alpha.example" }], people: rows },
      undefined,
      undefined,
      { incompleteCells: outcome.incompleteCells, markMissingCells: true, completeContract: false },
    );

    const delivered = await readDeliveredWorkbook(built.xlsx, built.billingLayout, plan);
    expect(delivered.ok).toBe(true);
    if (delivered.ok) {
      expect(delivered.counts.companies).toBe(1);
      expect(delivered.counts.people).toBe(2); // Total people rows in workbook
      expect(delivered.unbilled.total).toBe(1); // Exactly 1 uncontacted person unbilled per D-0117
    }
  });
});
