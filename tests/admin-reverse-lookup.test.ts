import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createMemoryDb } from "./helpers/memoryDb";
import { stubGateway, type GatewayStub } from "./helpers/plannerKit";

const state = vi.hoisted(() => ({ admin: true as boolean, client: null as any }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin ? { ok: true, ctx: { adminId: "adm-1", audit: vi.fn(async () => undefined) } } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));

import { ADMIN_LOOKUP_DAILY_CAP_USD, ADMIN_LOOKUP_PURPOSE, classifyLookupInput, extractIdentity, lookupCandidates, phoneCountry, resetAdminLookupMemoryForTesting, runAdminLookup } from "../src/lib/server/adminLookup";
import { policyRuleOf } from "../src/lib/treg/dataPolicy";
import { loadTregCatalog } from "../src/lib/treg/catalog";

const catalog = loadTregCatalog();
let gateway: GatewayStub;
const person = { data: { person: { full_name: "Sara Ahmed", company: "Acme Co", job_title: "Head of Sales", linkedin_url: "https://www.linkedin.com/in/sara-ahmed" } } };

beforeEach(() => {
  process.env.TREG_TOKEN = "t";
  state.admin = true;
  state.client = createMemoryDb();
  resetAdminLookupMemoryForTesting();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const answers: Record<string, any> = {};
  for (const kind of ["phone", "email"] as const) for (const c of lookupCandidates(kind, catalog, policyRuleOf)) answers[c.id] = person;
  gateway = stubGateway(answers, Object.fromEntries(Object.keys(answers).map((id) => [id, 20_000])));
});
afterEach(() => { gateway.restore(); vi.restoreAllMocks(); });

describe("the admin reverse-lookup tool", () => {
  it("reads a phone number or an email address; anything else is refused", () => {
    expect(classifyLookupInput("+20 100 123 4567")).toEqual({ kind: "phone", value: "+201001234567" });
    expect(classifyLookupInput("0100-123-4567")).toEqual({ kind: "phone", value: "01001234567" });
    expect(classifyLookupInput("Sara@Acme.com")).toEqual({ kind: "email", value: "sara@acme.com" });
    for (const bad of ["", "hello", "12345", "https://x.com", "a@b", "@elonmusk"]) expect(classifyLookupInput(bad), bad).toBeNull();
  });

  it("the candidates are the sensitive reverse-lookup endpoints for the kind of input, CHEAPEST FIRST, each with the one value it needs", () => {
    for (const kind of ["phone", "email"] as const) {
      const list = lookupCandidates(kind, catalog, policyRuleOf);
      expect(list.length, kind).toBeGreaterThanOrEqual(2);
      expect(list.map((c) => c.costUsd)).toEqual([...list.map((c) => c.costUsd)].sort((a, b) => a - b));
      for (const c of list) {
        expect(policyRuleOf(c.id), c.id).toMatch(/^S[2-5]_/);
        expect(/phone|mobile/i.test(c.id), c.id).toBe(kind === "phone");
        expect(c.paramName.length).toBeGreaterThan(0);
        expect(c.costUsd).toBeGreaterThan(0);
      }
    }
  });

  it("runs the CHEAPEST endpoint that covers the number first; «بحث أعمق» starts at the next one; each lookup shows name, company, title, profile link and its real cost; no customer points, one audit row carrying the cost", async () => {
    const phone = lookupCandidates("phone", catalog, policyRuleOf);
    const first = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+12025550143", depth: 0 });
    expect(first).toMatchObject({ ok: true, endpointId: phone[0].id, depth: 0, found: true, costUsd: 0.02, attempts: [{ endpointId: phone[0].id, outcome: "found", costUsd: 0.02 }] });
    if (first.ok) expect(first.identity).toEqual({ name: "Sara Ahmed", company: "Acme Co", title: "Head of Sales", profileUrl: "https://www.linkedin.com/in/sara-ahmed" });
    const deeper = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+12025550143", depth: 1 });
    expect(deeper).toMatchObject({ ok: true, endpointId: phone[1].id, depth: 1 });
    expect(gateway.calls.map((c) => c.endpointId)).toEqual([phone[0].id, phone[1].id]);
    expect(gateway.calls[0].body).toEqual({ [phone[0].paramName]: "+12025550143" });
    // the audit: one row per lookup, the value masked, the account is the admin, the real cost on the row (the day's spend is read back from it)
    const audit = state.client.rows("sensitive_lookup_audit").filter((r: any) => r.outcome === "called");
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ account_id: "adm-1", is_admin: true, masked_value: "***143", endpoint_category: expect.any(String), cost_usd: 0.02 });
    expect(JSON.stringify(audit)).not.toContain("2025550");
    // no customer table is touched (provider_costs needs a real job id: nothing is written there)
    expect(state.client.rows("provider_costs")).toHaveLength(0);
    expect([...state.client.tables.keys()].filter((t: string) => /ledger|credit|quote|job/.test(t))).toEqual([]);
    // past the last candidate there is nothing deeper
    const none = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+12025550143", depth: phone.length });
    expect(none).toMatchObject({ ok: false, reason: "no_deeper" });
    expect(gateway.calls).toHaveLength(2);
  });

  it("a number's country decides which endpoints are tried: an endpoint the catalog limits to a US number is SKIPPED for +20 (no request), the next one answers; the attempts are listed", async () => {
    const phone = lookupCandidates("phone", catalog, policyRuleOf);
    expect(phone[0]).toMatchObject({ id: "blitzapi.people.phone.reverse", countries: ["US"] });
    expect(phone[1].countries).toBeNull();
    expect(phoneCountry("+201111113041")).toBe("EG");
    expect(phoneCountry("+12025550143")).toBe("US");
    expect(phoneCountry("01111113041")).toBeNull();
    const out = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+201111113041" });
    expect(out).toMatchObject({ ok: true, endpointId: phone[1].id, found: true });
    expect(out.ok && out.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([[phone[0].id, "skipped_country"], [phone[1].id, "found"]]);
    expect(gateway.calls.map((c) => c.endpointId)).toEqual([phone[1].id]);
  });

  it("an answer with no data moves on to the next endpoint, within the cap, and the attempts with their cost are returned (the screen shows them; a customer never does)", async () => {
    const phone = lookupCandidates("phone", catalog, policyRuleOf);
    gateway.restore();
    gateway = stubGateway({ [phone[0].id]: { data: { person: null } }, [phone[1].id]: person }, { [phone[0].id]: 0, [phone[1].id]: 20_000 });
    const out = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+12025550143" });
    expect(out).toMatchObject({ ok: true, endpointId: phone[1].id, found: true, costUsd: 0.02 });
    expect(out.ok && out.attempts.map((a) => [a.endpointId, a.outcome, a.costUsd])).toEqual([[phone[0].id, "no_data", 0], [phone[1].id, "found", 0.02]]);
    // when every endpoint answers with no data the result says so: nothing found, every attempt listed
    gateway.restore();
    gateway = stubGateway({ [phone[0].id]: { data: { person: null } }, [phone[1].id]: { data: { person: null } } });
    const none = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+12025550143" });
    expect(none).toMatchObject({ ok: true, found: false });
    expect(none.ok && none.attempts.map((a) => a.outcome)).toEqual(["no_data", "no_data"]);
  });

  it("an email is looked up by an email endpoint", async () => {
    const email = lookupCandidates("email", catalog, policyRuleOf);
    const out = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "sara@acme.com", depth: 0 });
    expect(out).toMatchObject({ ok: true, endpointId: email[0].id });
    expect(state.client.rows("sensitive_lookup_audit")[0].masked_value).toBe("*@acme.com");
    await expect(runAdminLookup({ client: state.client, adminId: "adm-1", text: "nonsense", depth: 0 })).resolves.toMatchObject({ ok: false, reason: "bad_input" });
  });

  it("the DAILY COST CAP (2 USD) stops the day's lookups: a lookup whose estimate lands exactly on the cap runs, the next is refused with zero requests; a new UTC day starts again", async () => {
    expect(ADMIN_LOOKUP_DAILY_CAP_USD).toBe(2);
    const first = lookupCandidates("phone", catalog, policyRuleOf)[0];
    const now = new Date("2026-10-27T10:00:00Z");
    // what the day already spent is read from the audit log (every admin lookup writes its real cost there)
    state.client.seed("sensitive_lookup_audit", [{ id: "old", account_id: "adm-1", is_admin: true, purpose: ADMIN_LOOKUP_PURPOSE, endpoint_id: "x", endpoint_category: "sensitive", masked_value: "***", job_id: "adminlookup_old", cost_usd: Number((2 - first.estimateUsd).toFixed(6)), outcome: "called", created_at: "2026-10-27T08:00:00.000Z" }]);
    const exact = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+12025550143", depth: 0, now });
    expect(exact.ok).toBe(true);
    expect(gateway.calls).toHaveLength(1);
    const over = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+12025550143", depth: 0, now });
    expect(over).toMatchObject({ ok: false, reason: "daily_cap", capUsd: 2 });
    expect(gateway.calls).toHaveLength(1);
    const tomorrow = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+12025550143", depth: 0, now: new Date("2026-10-28T00:00:01Z") });
    expect(tomorrow.ok).toBe(true);
  });

  it("without the audit table the admin lookup still runs (a structured log line carries the masked fields)", async () => {
    state.client = createMemoryDb({ missing: ["sensitive_lookup_audit"] });
    const out = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+201001234567", depth: 0 });
    expect(out.ok).toBe(true);
  });

  it("the identity is read from whatever shape the source answers (flat, nested, split first and last name)", () => {
    expect(extractIdentity({ first_name: "Sara", last_name: "Ahmed", employer: "Acme", headline: "CEO", linkedin_profile_url: "https://linkedin.com/in/s" })).toEqual({ name: "Sara Ahmed", company: "Acme", title: "CEO", profileUrl: "https://linkedin.com/in/s" });
    expect(extractIdentity({ result: { person: { name: "X Y" } } }).name).toBe("X Y");
    expect(extractIdentity(undefined)).toEqual({ name: "", company: "", title: "", profileUrl: "" });
  });
});

describe("the admin API route: admin only", () => {
  const post = (body: unknown) => import("../src/app/api/admin/reverse-lookup/route").then((m) => m.POST(new NextRequest("http://127.0.0.1:3000/api/admin/reverse-lookup", { method: "POST", body: JSON.stringify(body) })));
  const get = () => import("../src/app/api/admin/reverse-lookup/route").then((m) => m.GET(new NextRequest("http://127.0.0.1:3000/api/admin/reverse-lookup")));

  it("a non-admin gets 403 and NOTHING is asked of any source; an admin gets the result", async () => {
    state.admin = false;
    expect((await post({ input: "+201001234567" })).status).toBe(403);
    expect((await get()).status).toBe(403);
    expect(gateway.calls).toHaveLength(0);
    state.admin = true;
    const res = await post({ input: "+201001234567", depth: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, found: true });
    const bad = await post({ input: "hello" });
    expect(bad.status).toBe(400);
    expect(await (await get()).json()).toEqual({ capUsd: 2, spentTodayUsd: 0.02 });
  });

  it("the page and its nav entry exist, in Arabic, and the cost in dollars is shown on this admin-only screen only", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/admin/reverse-lookup/page.tsx", "utf-8");
    expect(page).toContain("بحث عكسي");
    expect(page).toContain("بحث أعمق");
    expect(page).toContain("دولار");
    const icons = readFileSync("src/components/admin/icons.tsx", "utf-8");
    expect(icons).toContain('["reverse-lookup", "بحث عكسي"]');
  });
});
