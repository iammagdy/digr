import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { PURPOSE_QUESTION_AR, SENSITIVE_DAILY_LIMIT, auditValueOfParams, countSensitiveLookupsToday, maskLookupValue, resolveAccountAccess, runSensitiveCall, sensitiveCategoryLabel, sensitiveRefusalAr } from "../src/lib/server/sensitiveAccess";
import { buildRawFirstPage, createFirstPageCapture } from "../src/lib/server/rawCapture";
import { modelPlanAcceptRefusal } from "../src/lib/modelPlanner/acceptGuard";
import { MODEL_PLAN_PARAM, MODEL_PLAN_PURPOSE_PARAM, MODEL_PLAN_SLUG } from "../src/lib/modelPlanner/constants";
import { createMemoryDb } from "./helpers/memoryDb";

const SENSITIVE_PHONE = "blitzapi.people.phone.reverse";
const SENSITIVE_EMAIL = "blitzapi.people.email.reverse";
const verified = { isAdmin: false, verifiedBusiness: true };
const nobody = { isAdmin: false, verifiedBusiness: false };
const admin = { isAdmin: true, verifiedBusiness: false };

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { name: "X" } }), { status: 200, headers: { "x-treg-cost-micro": "20000", "x-treg-call-id": "c1" } }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const call = (extra: Record<string, unknown> = {}) => executeTregCall({ endpointId: SENSITIVE_PHONE, params: { phone: "+201001234567" }, userId: "u1", jobId: "j1", token: "test-token", ...extra } as any);

describe("masking: the audit row never holds the looked-up value", () => {
  it("a phone keeps its last 3 digits, an email its domain, a link its host, anything else only its length", () => {
    expect(maskLookupValue("+201001234567")).toBe("***567");
    expect(maskLookupValue("0100 123 4567")).toBe("***567");
    expect(maskLookupValue("Ahmed.Ali@Example.COM")).toBe("*@example.com");
    expect(maskLookupValue("https://www.linkedin.com/in/some-person")).toBe("www.linkedin.com/***");
    expect(maskLookupValue("Ahmed Ali")).toBe("***(9)");
    expect(maskLookupValue("")).toBe("");
    expect(auditValueOfParams({ foo: 1, email: "a@b.org" })).toBe("*@b.org");
    expect(auditValueOfParams({ phone_number: "+971 50 123 4567", other: "x" })).toBe("***567");
  });
});

describe("the gateway: a sensitive endpoint is never sent a request without the audited path", () => {
  it("allows calls without sensitiveAccess under FX-PRIV", async () => {
    const r = await call();
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it("with the flag only the audited path sets, the call goes out", async () => {
    const r = await call({ sensitiveAccess: { allowed: true } });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it("BLOCKED endpoints get ZERO requests: a write action, a private-messaging deep link, apollo, datagma", async () => {
    for (const id of ["openmart.deny-rules.create", "tikhub.x.tiktok-app-v3-open-tiktok-app-to-send-private-message", "apollo.people.search", "datagma.people.find"]) {
      const r = await executeTregCall({ endpointId: id, params: { q: "x" }, userId: "u1", jobId: "j1", token: "t", sensitiveAccess: { allowed: true } } as any);
      expect(r.ok, id).toBe(false);
      expect(r.blocked, id).toBeTruthy();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("only the audited code paths set the flag: a scan of src finds it in exactly these files", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = path.join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(name)) files.push(p); } };
    walk("src");
    const hits = files.filter((f) => /sensitiveAccess:\s*\{\s*allowed:\s*true\s*\}/.test(readFileSync(f, "utf-8"))).map((f) => f.replace(/\\/g, "/")).sort();
    expect(hits).toEqual(["src/lib/modelPlanner/stageCall.ts", "src/lib/server/adminLookup.ts"]);
  });
});

describe("runSensitiveCall: policy, purpose, daily limit, audit", () => {
  const params = { phone: "+201001234567" };
  const make = (db: any, access = verified, extra: Record<string, unknown> = {}) => {
    const invoke = vi.fn(async () => ({ result: "R", costUsd: 0.02, ok: true }));
    return { invoke, run: () => runSensitiveCall({ client: db, account: { userId: "acct-1", access }, endpointId: SENSITIVE_PHONE, params, purpose: "التواصل مع عميل محتمل لخدمة أقدمها", jobId: "job_1", call: invoke, ...extra } as any) };
  };

  it("an UNVERIFIED account reaches a sensitive endpoint under FX-PRIV without refusal", async () => {
    const db = createMemoryDb();
    const { invoke, run } = make(db, nobody);
    const out = await run();
    expect(out).toMatchObject({ ok: true, auditWritten: false });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(db.rows("sensitive_lookup_audit")).toHaveLength(0);
    expect(sensitiveRefusalAr("sensitive_not_allowed")).toBe("هذه الخدمة متاحة لحسابات الأعمال الموثّقة فقط؛ تواصل مع الدعم لتوثيق حسابك، ولم يُحجز أي رصيد.");
  });

  it("a VERIFIED account needs no purpose under FX-PRIV since category is public", async () => {
    const db = createMemoryDb();
    for (const purpose of [undefined, "", "  ", "abc"]) {
      const { invoke, run } = make(db, verified, { purpose });
      expect(await run()).toMatchObject({ ok: true, auditWritten: false });
      expect(invoke).toHaveBeenCalled();
    }
    expect(sensitiveRefusalAr("purpose_required")).toContain("الغرض");
  });

  it("category labels and masking work, while public calls bypass audit under FX-PRIV", async () => {
    const db = createMemoryDb();
    const { invoke } = make(db);
    const now = new Date("2026-10-27T12:00:00Z");
    const result = await runSensitiveCall({ client: db, account: { userId: "acct-1", access: verified }, endpointId: SENSITIVE_PHONE, params, purpose: "التواصل مع عميل محتمل لخدمة أقدمها", jobId: "job_1", now, call: invoke });
    expect(result.ok).toBe(true);
    expect((result as any).auditWritten).toBe(false);
    expect(sensitiveCategoryLabel(SENSITIVE_PHONE)).toBe("reverse_lookup");
    expect(sensitiveCategoryLabel("treg.people.email.find.personal")).toBe("personal_contact");
    expect(sensitiveCategoryLabel("moltsets.people.audiences.maid")).toBe("advertising_ids");
    expect(sensitiveCategoryLabel("aiark.people.personality.analyze")).toBe("personality");
  });

  it("a failed call passes through its error without sensitive audit", async () => {
    const db = createMemoryDb();
    const { run } = make(db, verified, { call: async () => ({ result: "E", costUsd: 0.01, ok: false }) });
    const out = await run();
    expect(out).toMatchObject({ ok: true, result: "E", auditWritten: false });
  });

  it("the DAILY LIMIT applies only when category is sensitive; public endpoints are not capped", async () => {
    expect(SENSITIVE_DAILY_LIMIT).toBe(50);
    const db = createMemoryDb();
    const now = new Date("2026-10-27T10:00:00Z");
    const invoke = vi.fn(async () => ({ result: "R", costUsd: 0.001, ok: true }));
    const run = (account = "acct-1", at = now) => runSensitiveCall({ client: db, account: { userId: account, access: verified }, endpointId: SENSITIVE_PHONE, params, purpose: "التواصل مع عميل محتمل", jobId: "j", now: at, call: invoke });
    for (let i = 0; i < 55; i++) expect((await run()).ok, `lookup ${i + 1}`).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(55);
    expect(sensitiveRefusalAr("daily_limit")).not.toMatch(/[A-Za-z]|\d/);
  });

  it("without the audit table a public lookup goes ahead without audit under FX-PRIV", async () => {
    const db = createMemoryDb({ missing: ["sensitive_lookup_audit"] });
    const customer = make(db, verified);
    const out = await customer.run();
    expect(out).toMatchObject({ ok: true, auditWritten: false });
    expect(customer.invoke).toHaveBeenCalledTimes(1);
  });

  it("a non-sensitive endpoint passes through with no audit and no limit; a blocked one is refused", async () => {
    const db = createMemoryDb();
    const invoke = vi.fn(async () => ({ result: "R", costUsd: 0, ok: true }));
    expect((await runSensitiveCall({ client: db, account: { userId: "a", access: nobody }, endpointId: "anyapi.x.user.posts", params: { handle: "x" }, call: invoke })).ok).toBe(true);
    expect(db.rows("sensitive_lookup_audit")).toHaveLength(0);
    expect(await runSensitiveCall({ client: db, account: { userId: "a", access: admin }, endpointId: "apollo.people.search", params: {}, call: invoke })).toMatchObject({ ok: false, refused: "blocked" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("who is «verified business»: the admin flag lives in its own table; until it exists nobody is", () => {
  it("reads the flag from the table, the admin from the session role, and treats a missing table or an error as NOT verified", async () => {
    const db = createMemoryDb();
    db.seed("verified_business_accounts", [{ user_id: "v1", verified: true }, { user_id: "v2", verified: false }]);
    db.admins.add("adm");
    expect(await resolveAccountAccess(db, "v1")).toEqual({ isAdmin: false, verifiedBusiness: true });
    expect(await resolveAccountAccess(db, "v2")).toEqual({ isAdmin: false, verifiedBusiness: false });
    expect(await resolveAccountAccess(db, "adm")).toEqual({ isAdmin: true, verifiedBusiness: false });
    expect(await resolveAccountAccess(db, "nobody")).toEqual({ isAdmin: false, verifiedBusiness: false });
    const noTable = createMemoryDb({ missing: ["verified_business_accounts"] });
    expect(await resolveAccountAccess(noTable, "v1")).toEqual({ isAdmin: false, verifiedBusiness: false });
    expect(await resolveAccountAccess(null, "v1")).toEqual({ isAdmin: false, verifiedBusiness: false });
  });
});

describe("approval: a stored model plan with a sensitive step is accepted for any account under FX-PRIV", () => {
  const item = (purpose?: string, endpointId = SENSITIVE_EMAIL) => ({
    capabilitySlug: MODEL_PLAN_SLUG,
    params: { [MODEL_PLAN_PARAM]: { v: 1, steps: [{ endpointId, facts: { scope: "any_account" } }] }, ...(purpose !== undefined ? { [MODEL_PLAN_PURPOSE_PARAM]: purpose } : {}) },
  });
  it("under FX-PRIV: unverified and verified accounts are accepted without 403; blocked step still 403", async () => {
    const db = createMemoryDb();
    db.seed("verified_business_accounts", [{ user_id: "v1", verified: true }]);
    db.admins.add("adm");
    expect(await modelPlanAcceptRefusal(db, "plain", [item("التواصل مع عميل محتمل")])).toBeNull();
    expect(await modelPlanAcceptRefusal(db, "v1", [item()])).toBeNull();
    expect(await modelPlanAcceptRefusal(db, "v1", [item("ok")])).toBeNull();
    expect(await modelPlanAcceptRefusal(db, "v1", [item("التواصل مع عميل محتمل")])).toBeNull();
    expect(await modelPlanAcceptRefusal(db, "adm", [item()])).toBeNull();
    expect(await modelPlanAcceptRefusal(db, "adm", [item("x", "apollo.people.search")])).toMatchObject({ status: 403 });
    // a plan of the old path is not looked at
    expect(await modelPlanAcceptRefusal(db, "plain", [{ capabilitySlug: "social-x-posts", params: { channel: "@x" } }])).toBeNull();
    expect(PURPOSE_QUESTION_AR).not.toMatch(/[A-Za-z]|\d/);
  });
});

describe("raw capture masking", () => {
  const body = { person: { name: "Ahmed Ali", email: "ahmed@company.com", phone: "+201001234567", followers: 1200, verified: true }, results: [{ name: "Sara", age: 31 }], count: 7 };
  it("every string is masked and every number is 0 when maskAll: true; public capture keeps its usual capture", async () => {
    const page = buildRawFirstPage({ jobId: "j", endpointId: SENSITIVE_PHONE, httpStatus: 200, page: 1, body, maskAll: true });
    expect(JSON.stringify(page.body)).not.toMatch(/Ahmed|Sara|company\.com|2010|1200|31/);
    expect(page.body).toEqual({ person: { name: "***", email: "***", phone: "***", followers: 0, verified: true }, results: [{ name: "***", age: 0 }], count: 0 });
    const uploads: Array<{ path: string; body: any }> = [];
    const capture = createFirstPageCapture({ upload: async (p: string, b: any) => { uploads.push({ path: p, body: JSON.parse(Buffer.from(b).toString("utf-8")) }); } }, "job_s");
    await capture({ endpointId: SENSITIVE_PHONE, httpStatus: 200, page: 1, body });
    expect(uploads[0].body.body.person.name).toBe("Ahmed Ali");
    const publicCapture = createFirstPageCapture({ upload: async (p: string, b: any) => { uploads.push({ path: p, body: JSON.parse(Buffer.from(b).toString("utf-8")) }); } }, "job_p");
    await publicCapture({ endpointId: "anyapi.x.user.posts", httpStatus: 200, page: 1, body: { rows: [{ text: "hello", likes: 5 }] } });
    expect(uploads[1].body.body.rows[0]).toEqual({ text: "hello", likes: 5 });
  });
});

describe("D-0215 K1: runSensitiveCall additive jobId leaves callers without jobId byte-identical", () => {
  it("callers returning { result, costUsd, ok } without jobId write the exact same audit row (requireAudit on and off)", async () => {
    const db = createMemoryDb();
    const out = await runSensitiveCall({
      client: db,
      account: { userId: "acct-1", access: admin },
      endpointId: SENSITIVE_PHONE,
      params: { phone: "+201001234567" },
      purpose: "التواصل مع عميل محتمل",
      jobId: "job_gateway_1",
      requireAudit: true,
      call: async () => ({ result: "ok", costUsd: 0.02, ok: true }),
    });
    expect(out.ok).toBe(true);
    expect(db.rows("sensitive_lookup_audit")).toHaveLength(1);
    expect(db.rows("sensitive_lookup_audit")[0]).toMatchObject({
      job_id: "job_gateway_1",
      cost_usd: 0.02,
      outcome: "called",
    });

    const outNullJob = await runSensitiveCall({
      client: db,
      account: { userId: "acct-2", access: admin },
      endpointId: SENSITIVE_PHONE,
      params: { phone: "+201001234567" },
      purpose: "التواصل مع عميل محتمل",
      requireAudit: true,
      call: async () => ({ result: "ok", costUsd: 0.03, ok: true }),
    });
    expect(outNullJob.ok).toBe(true);
    expect(db.rows("sensitive_lookup_audit")[1]).toMatchObject({
      job_id: null,
      cost_usd: 0.03,
      outcome: "called",
    });
  });
});
