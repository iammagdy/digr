import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * DT-20261118-06 PR 2 (Megz D-0104): GET /api/admin/missions/[id]/inspect. ONE mission for the team's read-only admin account: the calls, the stages, the planner's decision, the events. The route is read-only by construction (GET only), answers by an
 * allow-list (a column that is not named does not appear), redacts every string, and records who looked once per opening of the page. The LEAK PROBE puts a customer's e-mail and phone, call inputs, a token, a key, sample rows, a ledger row and a private
 * setting into the fake database and walks every string of the response.
 */
const state = vi.hoisted(() => ({ admin: "admin" as "admin" | "user" | "none", audits: [] as any[], db: null as any }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin === "admin"
    ? { ok: true, ctx: { adminId: "adm-1", audit: async (...a: any[]) => { state.audits.push(a); } } }
    : { ok: false, response: NextResponse.json({ error: "x" }, { status: state.admin === "none" ? 401 : 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({ createServerSideClient: vi.fn(), createAdminClient: () => state.db }));

import * as route from "../src/app/api/admin/missions/[id]/inspect/route";
import { INSPECT_CALL_LIMIT } from "../src/lib/server/adminMissionInspector";

const ID = "msn_abcd1234";
const T0 = Date.parse("2026-11-19T09:00:00Z");
const at = (n: number) => new Date(T0 + n * 1000).toISOString();
const call = (n: number, over: Record<string, unknown> = {}) => ({ id: `${ID}:call_${String(n).padStart(4, "0")}`, mission_id: ID, phase: "planning", endpoint_id: "company.search", status: "ok", refused_reason: null, http_status: 200, rows_returned: 5, cost_usd: 0.0005, duration_ms: 300, params_digest: { query: "contracting", page: 1 }, created_at: at(n), ...over });
const PEOPLE = "blitzapi.people.employee-finder";
const LEAKS = ["customer.leak@example.com", "+20 100 555 0199", "Hossam Elgendy", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig123", "sk-live_ABCDEF123456", "lead@corp.example", "usr-secret-user-id", "ledger-secret-row", "provider-key-secret-value", "worker-secret-id", "sample-phone-+20 111 222 3333", "storage/secret/path.xlsx"];
function seed() {
  const db = createMemoryDb();
  db.seed("missions", [{
    id: ID, user_id: "usr-secret-user-id", worker_id: "worker-secret-id", lease_until: at(999), status: "failed", created_at: at(0), updated_at: at(100), secretcol: "never-named-column",
    request_text: "عايز شركتين مقاولات ومسؤوليهم، تواصل على customer.leak@example.com أو +20 100 555 0199", error: `admin: planning_failed class=internal reason=people_sources_failed detail=Invalid API key 'sk-live_ABCDEF123456' for Hossam Elgendy`,
    summary_ar: "لم نجد ما طلبته.", delivered_units: 0, charged_points: 0, reserved_points: 0, planning_llm_usd: 0.0123, files: [{ kind: "xlsx", name: "نتائج.xlsx", path: "storage/secret/path.xlsx" }],
    question_ar: "سؤال", plan_public: { sample: "x" },
    plan: { price: { deliveredRows: 15 }, stages: [
      { key: "companies", title_ar: "شركات المقاولات", endpoint_id: "company.search", parent_key: null, deliver: true, planned_rows: 5, sample_rows: [{ phone: "sample-phone-+20 111 222 3333" }] },
      { key: "people", title_ar: "الأشخاص", endpoint_id: PEOPLE, parent_key: "companies", deliver: true, planned_rows: 10, per_parent_rows: 2, estimated: true, sample_rows: [] },
      { key: "late", title_ar: "مرحلة لم تصل", endpoint_id: "never.called", parent_key: null, deliver: false, planned_rows: 1 },
    ], compiled: { llm: { understanding_ar: "شركتان ومعهما أشخاصهما.", steps: [{ key: "companies", platform: "companies", capability: "companies.search", source: null, topic: "مقاولات", period: null, terms: [] }] } } },
  }]);
  db.seed("mission_calls", [
    call(1), call(2, { endpoint_id: PEOPLE, status: "failed", http_status: 401, rows_returned: null, params_digest: { company_linkedin_url: "https://linkedin.example/c/x", email: "lead@corp.example", _failure: "Invalid API key 'sk-live_ABCDEF123456' for Hossam Elgendy Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig123" } }),
    call(3, { endpoint_id: PEOPLE, status: "empty", rows_returned: 0, cost_usd: 0 }), call(4, { status: "refused", refused_reason: "budget", rows_returned: null, http_status: null }),
  ]);
  db.seed("mission_events", [
    { id: 1, mission_id: ID, kind: "call", message_ar: "قياس داخلي: فهم النموذج للطلب: شركتان ومعهما أشخاصهما.", counts: { llm_planner: 1, steps: 2 }, created_at: at(1) },
    { id: 2, mission_id: ID, kind: "result", message_ar: "تواصل مع customer.leak@example.com", counts: {}, created_at: at(2) },
    { id: 3, mission_id: ID, kind: "call", message_ar: "علامة داخلية للمشرف: شيء.", counts: { adm_flag: 1 }, created_at: at(3) },
  ]);
  db.seed("credit_ledger", [{ id: "ledger-secret-row", user_id: "usr-secret-user-id", delta: -229 }]);
  db.seed("agent_settings", [{ key: "provider_key", value: "provider-key-secret-value" }]);
  state.db = db;
  return db;
}
const get = (id = ID, qs = "") => route.GET(new NextRequest(`http://x/api/admin/missions/${id}/inspect${qs}`), { params: Promise.resolve({ id }) });
const body = async (r: Response) => (await r.json()) as any;

beforeEach(() => { state.admin = "admin"; state.audits = []; seed(); });

describe("access: admin only, read only", () => {
  it("401 without a session, 403 for a non-admin; the route file exports GET and nothing else (no body is ever accepted)", async () => {
    state.admin = "none"; expect((await get()).status).toBe(401);
    state.admin = "user"; expect((await get()).status).toBe(403);
    expect(Object.keys(route).filter((k) => !["dynamic", "maxDuration"].includes(k))).toEqual(["GET"]);
  });
  it("a bad id is 400, an unknown id and an add-on row are 404 (nothing about them is said)", async () => {
    expect((await get("../etc/passwd")).status).toBe(400);
    expect((await get("msn_unknown99")).status).toBe(404);
    state.db.seed("missions", [{ id: "msn_addon0001", status: "plan_ready", plan: { addon: { of: ID } } }]);
    expect((await get("msn_addon0001")).status).toBe(404);
  });
  it("a read that fails is 500 with no detail", async () => {
    state.db.setMissing(["mission_events"]);
    const r = await get(); expect(r.status).toBe(500); expect(JSON.stringify(await body(r))).toBe('{"error":"read_failed"}');
  });
});

describe("the response is an allow-list", () => {
  it("has exactly these keys, and a column nobody named (user id, worker id, lease, question, public plan, a made-up column) is absent", async () => {
    const r = await get(); expect(r.status).toBe(200);
    const b = await body(r);
    expect(Object.keys(b).sort()).toEqual(["calls", "callTotals", "events", "files", "generatedAt", "judgedRows", "judgedRowsDropped", "mission", "ok", "planner", "stages", "truncated"].sort());
    expect(b.judgedRows).toEqual([]);
    expect(b.judgedRowsDropped).toBe(0);
    expect(Object.keys(b.mission).sort()).toEqual(["chargedPoints", "createdAt", "deliveredRows", "error", "id", "kind", "requestText", "requestedRows", "reservedPoints", "status", "summaryAr", "terminal", "updatedAt"].sort());
    expect(Object.keys(b.calls[0]).sort()).toEqual(["at", "durationMs", "endpointId", "failure", "httpStatus", "id", "paramKeys", "phase", "refusedReason", "rowsReturned", "costUsd", "status"].sort());
    expect(JSON.stringify(b)).not.toMatch(/secretcol|never-named-column|worker|lease|question_ar|plan_public/);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("judgedRows items hold only title, url, criterion, verdict, reason (Group B.2)", async () => {
    (state.db.storage as any).from = () => ({
      download: async () => ({
        data: {
          text: async () => JSON.stringify([
            { title: "منشور تجريبي", url: "https://x.com/post/123", criterion: "حساب إكس موثق", verdict: 1, reason: "مطابق للشروط", extra_disallowed_col: "strip_me" },
          ]),
        },
      }),
    });
    const r = await get();
    expect(r.status).toBe(200);
    const b = await body(r);
    expect(b.judgedRows.length).toBe(1);
    expect(Object.keys(b.judgedRows[0]).sort()).toEqual(["criterion", "reason", "title", "url", "verdict"]);
    expect(b.judgedRows[0]).toEqual({
      title: "منشور تجريبي",
      url: "https://x.com/post/123",
      criterion: "حساب إكس موثق",
      verdict: 1,
      reason: "مطابق للشروط",
    });
    expect(b.judgedRowsDropped).toBe(0);
  });
  it("realistic judgedRows are redacted and kept, while a row containing a secret/email is dropped without failing the inspection (DT-20261123 hotfix)", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
      origLog(...args);
    };
    try {
      (state.db.storage as any).from = () => ({
        download: async () => ({
          data: {
            text: async () => JSON.stringify([
              {
                title: "تغريدة جديدة عن المؤتمر الاقتصادي في مصر",
                url: "https://x.com/user/status/1859678493029485721",
                criterion: "حساب إكس موثق",
                verdict: 1,
                reason: "مطابق للشروط رقم 01001234567 للتواصل",
              },
              {
                title: "مقال إخباري مع معرف طويل",
                url: "https://news.example.com/articles/aHR0cHM6Ly9leGFtcGxlLmNvbS9zb21lL2xvbmcvc2x1Zy90aGF0L2lzLXZlcnktbG9uZw==",
                criterion: "أخبار معتمدة",
                verdict: 1,
                reason: "مطابق للمعايير",
              },
              {
                title: "منشور يحتوي بريد إلكتروني مسرب leaked@example.com يجب إسقاطه",
                url: "https://x.com/user/status/987",
                criterion: "تسريبات خاصة",
                verdict: 0,
                reason: "بريد شخصي",
              },
            ]),
          },
        }),
      });
      const r = await get();
      expect(r.status).toBe(200);
      const b = await body(r);
      expect(b.judgedRows.length).toBe(2);
      expect(b.judgedRowsDropped).toBe(1);
      // Row 1: social post url has 19-digit ID redacted, reason phone redacted
      expect(b.judgedRows[0]).toEqual({
        title: "تغريدة جديدة عن المؤتمر الاقتصادي في مصر",
        url: "https://x.com/user/status/[محجوب]",
        criterion: "حساب إكس موثق",
        verdict: 1,
        reason: "مطابق للشروط رقم [محجوب] للتواصل",
      });
      // Row 2: news url has long base64 slug redacted
      expect(b.judgedRows[1]).toEqual({
        title: "مقال إخباري مع معرف طويل",
        url: "https://news.example.com/articles/[محجوب]",
        criterion: "أخبار معتمدة",
        verdict: 1,
        reason: "مطابق للمعايير",
      });
      // Server log was emitted with mission id and dropped count
      expect(logs.some((l) => l.includes(`inspector_judged_rows_dropped mission=${ID} count=1`))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });
  it("LEAK PROBE: none of the planted secrets and customer data appears anywhere in the response (every string walked)", async () => {
    const text = JSON.stringify(await body(await get()));
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
    const b = JSON.parse(text);
    expect(b.mission.requestText).toContain("عايز شركتين مقاولات");
    expect(b.mission.requestText).not.toMatch(/@|555 0199/);
    expect(b.events.find((e: any) => e.id === 2).messageAr).not.toContain("@");
    expect(b.mission.error).toContain("class=internal reason=people_sources_failed");
    expect(b.planner.noCardReason).toEqual({ cls: "internal", reason: "people_sources_failed" });
  });
  it("param keys are names only; the failure text is cleaned; files are names only", async () => {
    const b = await body(await get());
    const failed = b.calls.find((c: any) => c.status === "failed");
    expect(failed.paramKeys).toEqual(["company_linkedin_url", "email"]);
    expect(failed.failure).toMatch(/Invalid API key/);
    expect(failed.failure).not.toMatch(/sk-live|Hossam|eyJ/);
    expect(b.files).toEqual([{ kind: "xlsx", name: "نتائج.xlsx" }]);
  });
});

describe("the reads are by named columns and the last guard holds", () => {
  it("no read asks for «*»: the mission is read by its named columns, the calls and the events too", async () => {
    const selects: Array<[string, unknown]> = [];
    const from = state.db.from.bind(state.db);
    state.db.from = (t: string) => { const b = from(t); const sel = b.select.bind(b); b.select = (...a: unknown[]) => { selects.push([t, a[0]]); return sel(...a); }; return b; };
    expect((await get()).status).toBe(200);
    expect(selects.map(([t]) => t).sort()).toEqual(["mission_calls", "mission_calls", "mission_events", "missions"]);
    for (const [t, cols] of selects) { expect(String(cols), t).not.toContain("*"); expect(String(cols)).toMatch(/^id/); }
    expect(String(selects.find(([t]) => t === "missions")![1])).not.toMatch(/user_id|worker_id|lease_until|question_ar|plan_public|answer_text/);
  });
  it("a string that escapes the redaction (an endpoint id that is an e-mail) trips the final walk: 500, and the secret is not in the answer", async () => {
    state.db.seed("mission_calls", [call(9, { endpoint_id: "leak@corp.example" })]);
    const r = await get();
    expect(r.status).toBe(500);
    expect(JSON.stringify(await body(r))).not.toContain("leak@corp.example");
  });
});

describe("what the inspector shows", () => {
  it("calls oldest first with their status, http status and rows; totals per status and per endpoint; the estimated stage is marked; a stage with no call is not_reached; the planner's understanding and its internal events are labelled", async () => {
    const b = await body(await get());
    expect(b.calls.map((c: any) => c.status)).toEqual(["ok", "failed", "empty", "refused"]);
    expect(b.calls[1]).toMatchObject({ httpStatus: 401, endpointId: PEOPLE, phase: "planning" });
    expect(b.callTotals).toMatchObject({ total: 4, shown: 4, byStatus: { ok: 1, empty: 1, failed: 1, refused: 1 } });
    expect(b.callTotals.byEndpoint[0]).toMatchObject({ endpointId: expect.any(String) });
    const stage = (k: string) => b.stages.find((s: any) => s.key === k);
    expect(stage("companies")).toMatchObject({ state: "done", callsOk: 1, callsRefused: 1, rowsReturned: 5, estimated: false });
    expect(stage("people")).toMatchObject({ state: "empty", callsFailed: 1, callsEmpty: 1, estimated: true, plannedRows: 10, perParentRows: 2 });
    expect(stage("late")).toMatchObject({ state: "not_reached", callsOk: 0 });
    expect(b.planner.understandingAr).toBe("شركتان ومعهما أشخاصهما.");
    expect(b.events.map((e: any) => [e.id, e.internal])).toEqual([[1, true], [2, false], [3, true]]);
    expect(b.planner.llmCalls).toBe(1);
  });
  it("a call that served two stages is counted in each and the stage says so (`sharedEndpoint`)", async () => {
    const row = state.db.rows("missions")[0];
    row.plan.stages.push({ key: "again", title_ar: "مرحلة ثانية", endpoint_id: "company.search", parent_key: null, deliver: false, planned_rows: 1 });
    const b = await body(await get());
    expect(b.stages.find((s: any) => s.key === "again")).toMatchObject({ sharedEndpoint: true, callsOk: 1 });
    expect(b.stages.find((s: any) => s.key === "companies").sharedEndpoint).toBe(true);
    expect(b.stages.find((s: any) => s.key === "people").sharedEndpoint).toBe(false);
  });
  it("at most 500 calls are returned and `truncated` says so; the total is the real one (Gate 1 P2-3)", async () => {
    state.db.seed("mission_calls", Array.from({ length: 520 }, (_, i) => call(10 + i)));
    const b = await body(await get());
    expect(b.calls.length).toBe(INSPECT_CALL_LIMIT);
    expect(b.truncated).toBe(true);
  });
});

describe("the audit (Gate 1 P1-1): once per opening of the page, never per poll, never for a refused or unknown id", () => {
  it("?first=1 writes one «inspect» row; a poll without it writes none; 400, 403 and 404 write none", async () => {
    await get(ID, "?first=1");
    expect(state.audits).toEqual([["inspect", "فحص تفاصيل مهمة", ID]]);
    await get(); await get(); await get(ID, "?after=5");
    expect(state.audits.length).toBe(1);
    await get("bad id", "?first=1"); await get("msn_unknown99", "?first=1");
    state.admin = "user"; await get(ID, "?first=1");
    expect(state.audits.length).toBe(1);
  });
});
