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
  it("default deny: zero requests, whoever calls", async () => {
    const r = await call();
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe("sensitive_not_allowed");
    expect(r.error).toBe("endpoint_blocked");
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("an UNVERIFIED account never reaches a sensitive endpoint: zero requests, one refused row, the customer sentence", async () => {
    const db = createMemoryDb();
    const { invoke, run } = make(db, nobody);
    const out = await run();
    expect(out).toMatchObject({ ok: false, refused: "sensitive_not_allowed" });
    expect(invoke).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.rows("sensitive_lookup_audit")).toHaveLength(1);
    expect(db.rows("sensitive_lookup_audit")[0]).toMatchObject({ outcome: "refused_access", account_id: "acct-1" });
    expect(sensitiveRefusalAr("sensitive_not_allowed")).toBe("هذه الخدمة متاحة لحسابات الأعمال الموثّقة فقط؛ تواصل مع الدعم لتوثيق حسابك، ولم يُحجز أي رصيد.");
  });

  it("a VERIFIED account must give a purpose: without one nothing is called", async () => {
    const db = createMemoryDb();
    for (const purpose of [undefined, "", "  ", "abc"]) {
      const { invoke, run } = make(db, verified, { purpose });
      expect(await run()).toMatchObject({ ok: false, refused: "purpose_required" });
      expect(invoke).not.toHaveBeenCalled();
    }
    expect(sensitiveRefusalAr("purpose_required")).toContain("الغرض");
  });

  it("EVERY sensitive call writes exactly ONE audit row: account, endpoint and category, the value MASKED, the purpose, the job, the time, the cost", async () => {
    const db = createMemoryDb();
    const { invoke } = make(db);
    const now = new Date("2026-10-27T12:00:00Z");
    const result = await runSensitiveCall({ client: db, account: { userId: "acct-1", access: verified }, endpointId: SENSITIVE_PHONE, params, purpose: "التواصل مع عميل محتمل لخدمة أقدمها", jobId: "job_1", now, call: invoke });
    expect(result.ok).toBe(true);
    const rows = db.rows("sensitive_lookup_audit").filter((r) => r.created_at === now.toISOString());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: "acct-1", is_admin: false, endpoint_id: SENSITIVE_PHONE, endpoint_category: "reverse_lookup", masked_value: "***567", purpose: "التواصل مع عميل محتمل لخدمة أقدمها", job_id: "job_1", cost_usd: 0.02, outcome: "called" });
    // the looked-up value is nowhere in the row
    expect(JSON.stringify(rows[0])).not.toContain("1001234");
    expect(JSON.stringify(rows[0])).not.toContain("+2010");
    expect(sensitiveCategoryLabel(SENSITIVE_PHONE)).toBe("reverse_lookup");
    expect(sensitiveCategoryLabel("treg.people.email.find.personal")).toBe("personal_contact");
    expect(sensitiveCategoryLabel("moltsets.people.audiences.maid")).toBe("advertising_ids");
    expect(sensitiveCategoryLabel("aiark.people.personality.analyze")).toBe("personality");
  });

  it("a failed call is audited as failed with its cost", async () => {
    const db = createMemoryDb();
    const { run } = make(db, verified, { call: async () => ({ result: "E", costUsd: 0.01, ok: false }) });
    await run();
    expect(db.rows("sensitive_lookup_audit").at(-1)).toMatchObject({ outcome: "failed", cost_usd: 0.01 });
  });

  it("the DAILY LIMIT stops the 51st lookup of an account (the 50 before it ran); another account and the next UTC day are not affected", async () => {
    expect(SENSITIVE_DAILY_LIMIT).toBe(50);
    const db = createMemoryDb();
    const now = new Date("2026-10-27T10:00:00Z");
    const invoke = vi.fn(async () => ({ result: "R", costUsd: 0.001, ok: true }));
    const run = (account = "acct-1", at = now) => runSensitiveCall({ client: db, account: { userId: account, access: verified }, endpointId: SENSITIVE_PHONE, params, purpose: "التواصل مع عميل محتمل", jobId: "j", now: at, call: invoke });
    for (let i = 0; i < 50; i++) expect((await run()).ok, `lookup ${i + 1}`).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(50);
    expect(await countSensitiveLookupsToday(db, "acct-1", now)).toBe(50);
    const blocked = await run();
    expect(blocked).toMatchObject({ ok: false, refused: "daily_limit" });
    expect(invoke).toHaveBeenCalledTimes(50);
    expect(db.rows("sensitive_lookup_audit").filter((r) => r.outcome === "refused_limit")).toHaveLength(1);
    expect((await run("acct-2")).ok).toBe(true);
    expect((await run("acct-1", new Date("2026-10-28T00:00:01Z"))).ok).toBe(true);
    expect(sensitiveRefusalAr("daily_limit")).not.toMatch(/[A-Za-z]|\d/);
  });

  it("without the audit table a CUSTOMER lookup is refused (it cannot be audited); an ADMIN lookup goes ahead with a structured log line", async () => {
    const db = createMemoryDb({ missing: ["sensitive_lookup_audit"] });
    const customer = make(db, verified);
    expect(await customer.run()).toMatchObject({ ok: false, refused: "audit_unavailable" });
    expect(customer.invoke).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adminRun = make(db, admin, { purpose: "" });
    const out = await adminRun.run();
    expect(out).toMatchObject({ ok: true, auditWritten: false });
    expect(adminRun.invoke).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("sensitive_audit_unavailable"));
    expect(line).toBeTruthy();
    expect(line).toContain("***567");
    expect(line).not.toContain("1001234");
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

describe("approval: a stored model plan with a sensitive step is accepted only for an allowed account that gave a purpose", () => {
  const item = (purpose?: string, endpointId = SENSITIVE_EMAIL) => ({
    capabilitySlug: MODEL_PLAN_SLUG,
    params: { [MODEL_PLAN_PARAM]: { v: 1, steps: [{ endpointId, facts: { scope: "any_account" } }] }, ...(purpose !== undefined ? { [MODEL_PLAN_PURPOSE_PARAM]: purpose } : {}) },
  });
  it("unverified: 403 with the verified-business sentence; verified without a purpose: 409; verified with a purpose and the admin: accepted; blocked step: 403", async () => {
    const db = createMemoryDb();
    db.seed("verified_business_accounts", [{ user_id: "v1", verified: true }]);
    db.admins.add("adm");
    expect(await modelPlanAcceptRefusal(db, "plain", [item("التواصل مع عميل محتمل")])).toMatchObject({ status: 403, error: sensitiveRefusalAr("sensitive_not_allowed") });
    expect(await modelPlanAcceptRefusal(db, "v1", [item()])).toMatchObject({ status: 409 });
    expect(await modelPlanAcceptRefusal(db, "v1", [item("ok")])).toMatchObject({ status: 409 });
    expect(await modelPlanAcceptRefusal(db, "v1", [item("التواصل مع عميل محتمل")])).toBeNull();
    expect(await modelPlanAcceptRefusal(db, "adm", [item()])).toBeNull();
    expect(await modelPlanAcceptRefusal(db, "adm", [item("x", "apollo.people.search")])).toMatchObject({ status: 403 });
    // a plan of the old path is not looked at
    expect(await modelPlanAcceptRefusal(db, "plain", [{ capabilitySlug: "social-x-posts", params: { channel: "@x" } }])).toBeNull();
    expect(PURPOSE_QUESTION_AR).not.toMatch(/[A-Za-z]|\d/);
  });
});

describe("raw capture of a SENSITIVE endpoint keeps no personal value", () => {
  const body = { person: { name: "Ahmed Ali", email: "ahmed@company.com", phone: "+201001234567", followers: 1200, verified: true }, results: [{ name: "Sara", age: 31 }], count: 7 };
  it("every string is masked and every number is 0 (keys, nesting and booleans stay); a public endpoint keeps its usual (partly masked) capture", async () => {
    const page = buildRawFirstPage({ jobId: "j", endpointId: SENSITIVE_PHONE, httpStatus: 200, page: 1, body, maskAll: true });
    expect(JSON.stringify(page.body)).not.toMatch(/Ahmed|Sara|company\.com|2010|1200|31/);
    expect(page.body).toEqual({ person: { name: "***", email: "***", phone: "***", followers: 0, verified: true }, results: [{ name: "***", age: 0 }], count: 0 });
    const uploads: Array<{ path: string; body: any }> = [];
    const capture = createFirstPageCapture({ upload: async (p: string, b: any) => { uploads.push({ path: p, body: JSON.parse(Buffer.from(b).toString("utf-8")) }); } }, "job_s");
    await capture({ endpointId: SENSITIVE_PHONE, httpStatus: 200, page: 1, body });
    expect(JSON.stringify(uploads[0].body)).not.toMatch(/Ahmed|Sara|company\.com|1001234|1200/);
    const publicCapture = createFirstPageCapture({ upload: async (p: string, b: any) => { uploads.push({ path: p, body: JSON.parse(Buffer.from(b).toString("utf-8")) }); } }, "job_p");
    await publicCapture({ endpointId: "anyapi.x.user.posts", httpStatus: 200, page: 1, body: { rows: [{ text: "hello", likes: 5 }] } });
    expect(uploads[1].body.body.rows[0]).toEqual({ text: "hello", likes: 5 });
  });
});
