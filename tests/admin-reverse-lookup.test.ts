import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { createMemoryDb } from "./helpers/memoryDb";

const state = vi.hoisted(() => ({ admin: true as boolean, client: null as any }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin ? { ok: true, ctx: { adminId: "adm-1", audit: vi.fn(async () => undefined) } } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));

import { ADMIN_LOOKUP_DAILY_CAP_USD, ADMIN_LOOKUP_PURPOSE, classifyLookupInput, extractIdentity, lookupCandidates, lookupPlan, phoneCountry, resetAdminLookupMemoryForTesting, runAdminLookup, runLookupAttempt } from "../src/lib/server/adminLookup";
import { policyRuleOf } from "../src/lib/treg/dataPolicy";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { EMAIL_REVERSE_ORDER, PHONE_REVERSE_ORDER, applyReverseOrder, isCompanyDomainEmail } from "../src/lib/treg/reverseOrder";
import { saveLookupHistory, sanitizeEntry, loadLookupHistory } from "../src/lib/server/adminLookupHistory";
import { FIELD_KEYS, mergeFields } from "../src/lib/adminLookupResult";
import { runProviderSync } from "../scripts/capabilities/sync-providers";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

const catalog = loadTregCatalog();
const person = { data: { person: { full_name: "Sara Ahmed", company: "Acme Co", job_title: "Head of Sales", linkedin_url: "https://www.linkedin.com/in/sara-ahmed", country: "Egypt" } } };
const nothing = { data: { person: null } };
const EG = "+201111113041";
const US = "+12025550143";

/** A stand-in for the gateway client: records every call's options and answers from `answers` (a body, or a function of the n-th call); an id with no answer is a 404. */
function fakeCall(answers: Record<string, any>, microOf: (id: string) => number = () => 20_000) {
  const calls: TregCallOptions[] = [];
  const call = async (o: TregCallOptions) => {
    calls.push(o);
    const a = answers[o.endpointId];
    if (a === undefined) return { ok: false, httpStatus: 404, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, isRouteMaxCost: false, isPlatformBalanceLow: false } as any;
    if (typeof a === "number") return { ok: false, httpStatus: a, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, isRouteMaxCost: false, isPlatformBalanceLow: false } as any;
    return { ok: true, httpStatus: 200, tregCallId: `c${calls.length}`, costMicro: a === nothing ? 0 : microOf(o.endpointId), latencyMs: 1, data: a, isRouteMaxCost: false, isPlatformBalanceLow: false } as any;
  };
  return { calls, call };
}

beforeEach(() => {
  process.env.TREG_TOKEN = "t";
  state.admin = true;
  state.client = createMemoryDb();
  resetAdminLookupMemoryForTesting();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("the admin reverse-lookup tool: the order live evidence gave", () => {
  it("reads a phone number or an email address; anything else is refused", () => {
    expect(classifyLookupInput("+20 100 123 4567")).toEqual({ kind: "phone", value: "+201001234567" });
    expect(classifyLookupInput("0100-123-4567")).toEqual({ kind: "phone", value: "01001234567" });
    expect(classifyLookupInput("Sara@Acme.com")).toEqual({ kind: "email", value: "sara@acme.com" });
    for (const bad of ["", "hello", "12345", "https://x.com", "a@b", "@elonmusk"]) expect(classifyLookupInput(bad), bad).toBeNull();
  });

  it("the e-mail endpoints are in the order the evidence gave, each with the one value it needs; the phone endpoints come free first, then the paid ones", () => {
    expect(EMAIL_REVERSE_ORDER).toEqual(["fiber-ai.people.identity.resolve", "blitzapi.people.email.reverse", "quickenrich.people.enrich", "aiark.people.enrich", "findymail.search.reverse-email", "treg.people.identity.resolve", "branddev.brand.retrieve-by-email", "companyenrich.people.lookup"]);
    const email = lookupCandidates("email", catalog, policyRuleOf);
    expect(email.slice(0, 8).map((c) => c.id)).toEqual([...EMAIL_REVERSE_ORDER]);
    expect(email.find((c) => c.id === "aiark.people.enrich")!.paramName).toBe("search");
    for (const c of email) { expect(c.paramName.length, c.id).toBeGreaterThan(0); expect(c.costUsd, c.id).toBeGreaterThan(0); }
    const phone = lookupCandidates("phone", catalog, policyRuleOf);
    expect(phone.slice(0, 3).map((c) => c.id)).toEqual([...PHONE_REVERSE_ORDER]);
    expect(phone[0]).toMatchObject({ id: "getleadsio.people.phone.lookup", costUsd: 0, paid: false });
    expect(phone.slice(1).every((c) => c.paid)).toBe(true);
    expect(phone.find((c) => c.id === "blitzapi.people.phone.reverse")!.countries).toEqual(["US"]);
  });

  it("an e-mail goes down the list IN ORDER and STOPS at the first useful answer: an empty answer moves on, the first answer with a name ends the search", async () => {
    const { calls, call } = fakeCall({ "fiber-ai.people.identity.resolve": nothing, "blitzapi.people.email.reverse": nothing, "quickenrich.people.enrich": person });
    const out = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "sara@acme.com", call });
    expect(calls.map((c) => c.endpointId)).toEqual(["fiber-ai.people.identity.resolve", "blitzapi.people.email.reverse", "quickenrich.people.enrich"]);
    expect(out).toMatchObject({ ok: true, found: true, endpointId: "quickenrich.people.enrich", hasDeeper: true });
    expect(out.ok && out.attempts.map((a) => a.outcome)).toEqual(["no_data", "no_data", "found"]);
    expect(out.ok && out.fields).toMatchObject({ name: { value: "Sara Ahmed", source: "quickenrich.people.enrich" }, company: { value: "Acme Co", source: "quickenrich.people.enrich" }, country: { value: "Egypt" } });
  });

  it("«بحث أعمق» continues from the next endpoint and MERGES: the fields already found stay with their source, only empty ones are filled by the next answer", async () => {
    const first = fakeCall({ "fiber-ai.people.identity.resolve": { data: { person: { full_name: "Sara Ahmed", country: "Egypt" } } } });
    const one = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "sara@acme.com", call: first.call });
    expect(one.ok && one.fields).toEqual({ name: { value: "Sara Ahmed", source: "fiber-ai.people.identity.resolve" }, country: { value: "Egypt", source: "fiber-ai.people.identity.resolve" } });
    expect(first.calls).toHaveLength(1);
    const second = fakeCall({ "blitzapi.people.email.reverse": { data: { person: { full_name: "Someone Else", company: "Acme Co", job_title: "Head of Sales" } } } });
    const two = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "sara@acme.com", depth: one.ok ? one.depth + 1 : 1, previous: one.ok ? one.fields : {}, call: second.call });
    expect(second.calls.map((c) => c.endpointId)).toEqual(["blitzapi.people.email.reverse"]);
    expect(two.ok && two.fields).toMatchObject({ name: { value: "Sara Ahmed", source: "fiber-ai.people.identity.resolve" }, company: { value: "Acme Co", source: "blitzapi.people.email.reverse" }, title: { value: "Head of Sales", source: "blitzapi.people.email.reverse" }, country: { source: "fiber-ai.people.identity.resolve" } });
    expect(mergeFields({ name: { value: "A", source: "x" } }, "y", { name: "B", company: "C", title: "", profileUrl: "", country: "" })).toEqual({ name: { value: "A", source: "x" }, company: { value: "C", source: "y" } });
  });

  it("the routed identity endpoint is called with «X-Treg-Route-Waterfall: 0» (no waterfall), and no other endpoint is", async () => {
    const { calls, call } = fakeCall({ "treg.people.identity.resolve": person });
    await runLookupAttempt({ client: state.client, adminId: "adm-1", text: "sara@acme.com", endpointId: "treg.people.identity.resolve", call });
    expect(calls[0].routeWaterfall).toBe(false);
    const other = fakeCall({ "quickenrich.people.enrich": person });
    await runLookupAttempt({ client: state.client, adminId: "adm-1", text: "sara@acme.com", endpointId: "quickenrich.people.enrich", call: other.call });
    expect(other.calls[0].routeWaterfall).toBeUndefined();
    const src = readFileSync("src/functions/shared/tregClient.ts", "utf-8");
    expect(src).toContain('headers["X-Treg-Route-Waterfall"] = "0"');
  });

  it("branddev (it answers about a COMPANY) is tried ONLY for a company domain: a public mailbox skips it with no call; a company address reaches it", async () => {
    expect(["a@outlook.com", "a@gmail.com", "a@hotmail.com", "a@yahoo.co.uk", "a@live.com", "a@icloud.com"].map(isCompanyDomainEmail)).toEqual([false, false, false, false, false, false]);
    expect(["a@acme.com", "a@acme.com.eg", "a@sub.firm.co"].map(isCompanyDomainEmail)).toEqual([true, true, true]);
    const planFree = lookupPlan("email", "sara@outlook.com", catalog);
    expect(planFree.find((p) => p.id === "branddev.brand.retrieve-by-email")).toMatchObject({ state: "skipped" });
    expect(lookupPlan("email", "sara@acme.com", catalog).find((p) => p.id === "branddev.brand.retrieve-by-email")!.state).toBe("auto");
    // everything before it answers nothing: a public mailbox never reaches branddev, a company address does and its brand record is read as a COMPANY
    const answers: Record<string, any> = Object.fromEntries(EMAIL_REVERSE_ORDER.filter((id) => id !== "branddev.brand.retrieve-by-email").map((id) => [id, nothing]));
    const free = fakeCall(answers);
    const outFree = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "sara@outlook.com", call: free.call });
    expect(free.calls.map((c) => c.endpointId)).not.toContain("branddev.brand.retrieve-by-email");
    expect(outFree.ok && outFree.attempts.find((a) => a.endpointId === "branddev.brand.retrieve-by-email")?.outcome).toBe("skipped");
    const co = fakeCall({ ...answers, "branddev.brand.retrieve-by-email": { data: { brand: { title: "Acme Industries", domain: "acme.com" } } } });
    const outCo = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "sara@acme.com", call: co.call });
    expect(co.calls.map((c) => c.endpointId)).toContain("branddev.brand.retrieve-by-email");
    expect(outCo.ok && outCo.fields).toEqual({ company: { value: "Acme Industries", source: "branddev.brand.retrieve-by-email" } });
  });

  it("a phone runs the FREE endpoints only by default: no paid endpoint is called by the automatic search, and a no-data answer from the free one ends it with nothing", async () => {
    const { calls, call } = fakeCall({ "getleadsio.people.phone.lookup": nothing });
    const out = await runAdminLookup({ client: state.client, adminId: "adm-1", text: EG, call });
    expect(calls.map((c) => c.endpointId)).toEqual(["getleadsio.people.phone.lookup"]);
    expect(out).toMatchObject({ ok: true, found: false, hasDeeper: false });
    expect(out.ok && out.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([["getleadsio.people.phone.lookup", "no_data"], ["blitzapi.people.phone.reverse", "skipped_country"], ["enrichlayer.contacts.reverse-phone", "needs_confirmation"]]);
    // the free endpoint answering 410 (as it did live) is a failed attempt, nothing paid runs, and the result says it failed
    const gone = fakeCall({ "getleadsio.people.phone.lookup": 410 });
    const failed = await runAdminLookup({ client: state.client, adminId: "adm-1", text: EG, call: gone.call });
    expect(gone.calls).toHaveLength(1);
    expect(failed).toMatchObject({ ok: false, reason: "failed" });
  });

  it("a PAID phone endpoint runs only after the admin confirmed its price: without it, or with less, nothing is called; with it the call is made and its real cost is recorded; the warning says coverage is unproven", async () => {
    const plan = lookupPlan("phone", EG, catalog);
    const paid = plan.find((p) => p.id === "enrichlayer.contacts.reverse-phone")!;
    expect(paid).toMatchObject({ state: "confirm", paid: true });
    expect(paid.warningAr).toContain("غير مثبتة");
    expect(plan.find((p) => p.id === "getleadsio.people.phone.lookup")).toMatchObject({ state: "auto", paid: false });
    const { calls, call } = fakeCall({ "enrichlayer.contacts.reverse-phone": person }, () => 300_000);
    const none = await runLookupAttempt({ client: state.client, adminId: "adm-1", text: EG, endpointId: "enrichlayer.contacts.reverse-phone", call });
    expect(none).toMatchObject({ ok: false, reason: "needs_confirmation", priceUsd: paid.usd });
    const less = await runLookupAttempt({ client: state.client, adminId: "adm-1", text: EG, endpointId: "enrichlayer.contacts.reverse-phone", confirmedUsd: 0.01, call });
    expect(less).toMatchObject({ ok: false, reason: "needs_confirmation" });
    expect(calls).toHaveLength(0);
    const yes = await runLookupAttempt({ client: state.client, adminId: "adm-1", text: EG, endpointId: "enrichlayer.contacts.reverse-phone", confirmedUsd: paid.usd, call });
    expect(yes).toMatchObject({ ok: true, found: true, attempt: { outcome: "found", costUsd: 0.3 } });
    expect(calls).toHaveLength(1);
    expect(state.client.rows("sensitive_lookup_audit").filter((r: any) => r.outcome === "called")[0]).toMatchObject({ cost_usd: 0.3, is_admin: true });
  });

  it("enrichlayer.contacts.reverse-phone is for US numbers: outside the US it is never automatic and carries the warning; for a US number it still needs the price confirmed", async () => {
    const eg = lookupPlan("phone", EG, catalog).find((p) => p.id === "enrichlayer.contacts.reverse-phone")!;
    expect(eg).toMatchObject({ state: "confirm" });
    expect(eg.warningAr).toContain("أمريكا");
    const us = lookupPlan("phone", US, catalog).find((p) => p.id === "enrichlayer.contacts.reverse-phone")!;
    expect(us.state).toBe("confirm");
    expect(us.warningAr).toBeUndefined();
    const { calls, call } = fakeCall({ "getleadsio.people.phone.lookup": nothing, "blitzapi.people.phone.reverse": nothing, "enrichlayer.contacts.reverse-phone": person });
    await runAdminLookup({ client: state.client, adminId: "adm-1", text: EG, call });
    await runAdminLookup({ client: state.client, adminId: "adm-1", text: US, call });
    expect(calls.map((c) => c.endpointId)).not.toContain("enrichlayer.contacts.reverse-phone");
    expect(phoneCountry(EG)).toBe("EG");
    expect(phoneCountry(US)).toBe("US");
  });

  it("an endpoint the catalog limits to a US number is SKIPPED for +20 with no request; the attempts are listed", async () => {
    const plan = lookupPlan("phone", EG, catalog);
    expect(plan.find((p) => p.id === "blitzapi.people.phone.reverse")).toMatchObject({ state: "skipped" });
    const { calls, call } = fakeCall({});
    const skipped = await runLookupAttempt({ client: state.client, adminId: "adm-1", text: EG, endpointId: "blitzapi.people.phone.reverse", call });
    expect(skipped).toMatchObject({ ok: false, reason: "skipped", attempt: { outcome: "skipped_country" } });
    expect(calls).toHaveLength(0);
  });

  it("no customer table is touched, one audit row per call carries the cost and a MASKED value; an unknown endpoint is refused", async () => {
    const { call } = fakeCall({ "fiber-ai.people.identity.resolve": person }, () => 40_000);
    await runAdminLookup({ client: state.client, adminId: "adm-1", text: "sara@acme.com", call });
    const audit = state.client.rows("sensitive_lookup_audit").filter((r: any) => r.outcome === "called");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ account_id: "adm-1", is_admin: true, masked_value: "*@acme.com", cost_usd: 0.04 });
    expect(JSON.stringify(audit)).not.toContain("sara");
    expect(state.client.rows("provider_costs")).toHaveLength(0);
    expect([...state.client.tables.keys()].filter((t: string) => /ledger|credit|quote|job/.test(t))).toEqual([]);
    const unknown = await runLookupAttempt({ client: state.client, adminId: "adm-1", text: "sara@acme.com", endpointId: "no.such.endpoint", call });
    expect(unknown).toMatchObject({ ok: false, reason: "unknown_endpoint" });
  });

  it("the DAILY COST CAP (2 USD) stops the day's lookups: a lookup whose estimate lands exactly on the cap runs, the next is refused with zero requests; a new UTC day starts again", async () => {
    expect(ADMIN_LOOKUP_DAILY_CAP_USD).toBe(2);
    const first = lookupCandidates("email", catalog, policyRuleOf)[0];
    const now = new Date("2026-10-27T10:00:00Z");
    state.client.seed("sensitive_lookup_audit", [{ id: "old", account_id: "adm-1", is_admin: true, purpose: ADMIN_LOOKUP_PURPOSE, endpoint_id: "x", endpoint_category: "sensitive", masked_value: "***", job_id: "adminlookup_old", cost_usd: Number((2 - first.estimateUsd).toFixed(6)), outcome: "called", created_at: "2026-10-27T08:00:00.000Z" }]);
    const a = fakeCall({ [first.id]: person }, () => Math.round(first.estimateUsd * 1_000_000));
    const exact = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "sara@acme.com", now, call: a.call });
    expect(exact.ok).toBe(true);
    expect(a.calls).toHaveLength(1);
    const over = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "sara@acme.com", now, call: a.call });
    expect(over).toMatchObject({ ok: false, reason: "daily_cap", capUsd: 2 });
    expect(a.calls).toHaveLength(1);
    const tomorrow = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "sara@acme.com", now: new Date("2026-10-28T00:00:01Z"), call: a.call });
    expect(tomorrow.ok).toBe(true);
  });

  it("PHASE 5, FAIL CLOSED: without the audit table the admin lookup is refused and NOTHING is called (the day's cost cannot be read or recorded)", async () => {
    // (before Phase 5 this ran with a log line only; the owner's Phase 5 brief requires audit records that fail closed)
    state.client = createMemoryDb({ missing: ["sensitive_lookup_audit"] });
    const { calls, call } = fakeCall({ "getleadsio.people.phone.lookup": person });
    const out = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "+201001234567", call });
    expect(out).toMatchObject({ ok: false, reason: "audit_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("the identity is read from whatever shape the source answers (flat, nested, split first and last name, with its country); a brand record is a COMPANY, its title is never a job title", () => {
    expect(extractIdentity({ first_name: "Sara", last_name: "Ahmed", employer: "Acme", headline: "CEO", linkedin_profile_url: "https://linkedin.com/in/s", country_code: "EG" })).toEqual({ name: "Sara Ahmed", company: "Acme", title: "CEO", workEmail: "", personalEmail: "", phone: "", profileUrl: "https://linkedin.com/in/s", country: "EG" });
    expect(extractIdentity({ result: { person: { name: "X Y" } } }).name).toBe("X Y");
    expect(extractIdentity(undefined)).toEqual({ name: "", company: "", title: "", workEmail: "", personalEmail: "", phone: "", profileUrl: "", country: "" });
    expect(extractIdentity({ title: "Acme Industries", domain: "acme.com" }, "branddev.brand.retrieve-by-email")).toMatchObject({ company: "Acme Industries", title: "", name: "" });
  });
});

describe("the same ordering for a verified business customer (the planner's candidate list)", () => {
  it("applyReverseOrder puts the listed endpoints in evidence order inside the places they already hold; every other id keeps its place", () => {
    const shuffled = ["x.a", "quickenrich.people.enrich", "x.b", "fiber-ai.people.identity.resolve", "companyenrich.people.lookup", "blitzapi.people.email.reverse"];
    expect(applyReverseOrder(shuffled, (s) => s)).toEqual(["x.a", "fiber-ai.people.identity.resolve", "x.b", "blitzapi.people.email.reverse", "quickenrich.people.enrich", "companyenrich.people.lookup"]);
    expect(applyReverseOrder(["b", "a"], (s) => s)).toEqual(["b", "a"]);
  });

  it("catalog_search for a verified business lists the e-mail endpoints in that order (not by cost); for an account that is not verified none of them is listed", async () => {
    const { toolCatalogSearch } = await import("../src/lib/modelPlanner/tools");
    const verified = toolCatalogSearch({ words: ["email", "identity", "resolve"], limit: 10 }, { isAdmin: false, verifiedBusiness: true }, catalog);
    const ids = verified.hits.map((h) => String(h.id)).filter((id) => EMAIL_REVERSE_ORDER.includes(id));
    expect(ids).toEqual(["fiber-ai.people.identity.resolve", "findymail.search.reverse-email", "treg.people.identity.resolve"]);
    expect(ids).toEqual(EMAIL_REVERSE_ORDER.filter((id) => ids.includes(id)));
    const plain = toolCatalogSearch({ words: ["email", "identity", "resolve"], limit: 10 }, { isAdmin: false, verifiedBusiness: false }, catalog);
    expect(plain.hits.map((h) => String(h.id)).filter((id) => categoryIsSensitive(id))).toHaveLength(3);
  });
});

function categoryIsSensitive(id: string): boolean { return /fiber-ai\.people\.identity|reverse|treg\.people\.identity|branddev\.brand\.retrieve-by-email|companyenrich\.people\.lookup/.test(id); }

describe("the admin API route: admin only, plan / attempt / save, the history", () => {
  const post = (body: unknown) => import("../src/app/api/admin/reverse-lookup/route").then((m) => m.POST(new NextRequest("http://127.0.0.1:3000/api/admin/reverse-lookup", { method: "POST", body: JSON.stringify(body) })));
  const get = () => import("../src/app/api/admin/reverse-lookup/route").then((m) => m.GET(new NextRequest("http://127.0.0.1:3000/api/admin/reverse-lookup")));

  it("a non-admin gets 403 and NOTHING is asked of any source; bad input gets 400", async () => {
    state.admin = false;
    expect((await post({ input: "+201001234567" })).status).toBe(403);
    expect((await post({ action: "plan", input: "sara@acme.com" })).status).toBe(403);
    expect((await get()).status).toBe(403);
    state.admin = true;
    expect((await post({ input: "hello" })).status).toBe(400);
    expect((await post({ action: "plan", input: "hello" })).status).toBe(400);
  });

  it("«plan» returns the ordered endpoints with their state and price and calls nothing", async () => {
    const res = await post({ action: "plan", input: EG });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.plan.map((p: any) => [p.id, p.state])).toEqual([["getleadsio.people.phone.lookup", "auto"], ["blitzapi.people.phone.reverse", "skipped"], ["enrichlayer.contacts.reverse-phone", "confirm"], ...body.plan.slice(3).map((p: any) => [p.id, p.state])]);
    expect(body.capUsd).toBe(2);
  });

  it("«attempt» for a paid phone endpoint without a confirmed price is refused (200 with needs_confirmation) and makes no request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post({ action: "attempt", input: EG, endpointId: "enrichlayer.contacts.reverse-phone" });
    expect(await res.json()).toMatchObject({ ok: false, reason: "needs_confirmation", priceUsd: 0.3 });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("«save» stores a finished lookup with the typed value MASKED and the source of each field; the history lists it and reopening needs no call; without the table the answer says so (the browser keeps it)", async () => {
    const result = { fields: { name: { value: "Sara Ahmed", source: "fiber-ai.people.identity.resolve" }, bogus: { value: "x", source: "y" } }, attempts: [{ endpointId: "fiber-ai.people.identity.resolve", outcome: "found", costUsd: 0.04, note: "" }] };
    const saved = await (await post({ action: "save", input: "sara@acme.com", result })).json();
    expect(saved).toMatchObject({ ok: true, stored: true });
    expect(saved.entry).toMatchObject({ kind: "email", maskedInput: "*@acme.com", found: true, costUsd: 0.04, fields: { name: { value: "Sara Ahmed", source: "fiber-ai.people.identity.resolve" } } });
    expect(saved.entry.fields.bogus).toBeUndefined();
    const stored = state.client.rows("admin_lookup_history");
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("sara@acme.com");
    const listed = await (await get()).json();
    expect(listed.historyAvailable).toBe(true);
    expect(listed.history[0]).toMatchObject({ maskedInput: "*@acme.com", fields: { name: { value: "Sara Ahmed" } } });
    state.client = createMemoryDb({ missing: ["admin_lookup_history"] });
    expect(await (await post({ action: "save", input: "sara@acme.com", result })).json()).toMatchObject({ ok: true, stored: false });
    expect(await (await get()).json()).toMatchObject({ historyAvailable: false, history: [] });
  });

  it("the server table is a proposal NOT APPLIED, written under docs/proposals with its rollback", () => {
    const sql = readFileSync("docs/proposals/admin-lookup-history/01_admin_lookup_history.sql", "utf-8");
    expect(sql).toContain("NOT APPLIED");
    expect(sql).toContain("admin_lookup_history");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(readFileSync("docs/proposals/admin-lookup-history/01_admin_lookup_history.rollback.sql", "utf-8")).toContain("DROP TABLE IF EXISTS public.admin_lookup_history");
  });

  it("the page: a loading state and a disabled button, live progress per attempt, a paid-confirmation step with the warning, a result card with the source of each field, and a history that reopens a stored result without a call; the nav entry exists; the cost in dollars is on this admin-only screen", () => {
    const page = readFileSync("src/app/admin/reverse-lookup/page.tsx", "utf-8");
    for (const needle of ["بحث عكسي", "بحث أعمق", "دولار", "جارٍ البحث", "disabled={busy", "aria-busy", "يعمل الآن", "lookup-running", "lookup-paid", "أؤكد دفع", "warningAr", "field-", "source", "سجل البحث", "بلا مكالمة جديدة", "localStorage", "action: \"attempt\"", "action: \"plan\"", "action: \"save\""]) expect(page, needle).toContain(needle);
    expect(readFileSync("src/components/admin/icons.tsx", "utf-8")).toContain('["reverse-lookup", "بحث عكسي"]');
  });
});

describe("DT-20261125-people-search-admin: admin-only treg.people.enrich & social_url (A1-A3, D1-D4, M1-M7, C1-C5)", () => {
  it("M1 & A3: email candidates/plan on the real catalog preserve EMAIL_REVERSE_ORDER first and place treg.people.enrich immediately after them and before catalog others in confirm state ($0.28)", () => {
    const listedIds = EMAIL_REVERSE_ORDER.filter((id) => catalog.byId.has(id));
    const candidates = lookupCandidates("email", catalog, policyRuleOf);
    expect(candidates.slice(0, listedIds.length).map((c) => c.id)).toEqual(listedIds);
    expect(candidates[listedIds.length]).toMatchObject({ id: "treg.people.enrich", paramName: "email", costUsd: 0.28, paid: true, confirm: true, waterfall: true });

    const plan = lookupPlan("email", "sara@acme.com", catalog, policyRuleOf);
    expect(plan.slice(0, listedIds.length).map((p) => p.state)).toEqual(listedIds.map(() => "auto"));
    expect(plan[listedIds.length]).toEqual({ id: "treg.people.enrich", paramName: "email", usd: 0.28, paid: true, state: "confirm" });
    expect(candidates.map((c) => c.id)).toEqual([...listedIds, "treg.people.enrich"]);
    expect(readFileSync("src/lib/server/adminLookup.ts", "utf-8")).toContain("return [...out, ...adminOnly, ...others];");
  });

  it("M2 & C4: LinkedIn /in/ profile URLs normalize cleanly as social_url and plan ONLY treg.people.enrich; other URLs/company pages are refused at 0 cost", async () => {
    for (const raw of [
      "https://www.linkedin.com/in/sara-ahmed",
      "https://linkedin.com/in/sara-ahmed/",
      "https://www.linkedin.com/in/sara-ahmed?trk=qa#profile",
      "http://www.linkedin.com/in/sara-ahmed",
    ]) {
      expect(classifyLookupInput(raw), raw).toEqual({ kind: "social_url", value: raw.replace(/^http:\/\//i, "https://").replace(/[?#].*$/, "").replace(/\/+$/, "") });
    }
    for (const bad of ["https://x.com/someone", "https://www.linkedin.com/company/acme", "https://www.linkedin.com/in/", "https://evil.linkedin.com/in/sara", "ftp://www.linkedin.com/in/sara"]) {
      expect(classifyLookupInput(bad), bad).toBeNull();
    }

    const plan = lookupPlan("social_url", "https://www.linkedin.com/in/sara-ahmed", catalog, policyRuleOf);
    expect(plan).toEqual([{ id: "treg.people.enrich", paramName: "linkedin_url", usd: 0.28, paid: true, state: "confirm" }]);

    const autoOut = await runAdminLookup({ client: state.client, adminId: "adm-1", text: "https://www.linkedin.com/in/sara-ahmed", call: async () => { throw new Error("should not call"); } });
    expect(autoOut).toMatchObject({ ok: false, reason: "no_endpoint" });
  });

  it("M3 & C1: phone plan and customer reverseOrder remain unchanged (treg.people.enrich absent)", () => {
    expect(lookupCandidates("phone", catalog, policyRuleOf).map((c) => c.id)).not.toContain("treg.people.enrich");
    expect(EMAIL_REVERSE_ORDER).not.toContain("treg.people.enrich");
    expect(PHONE_REVERSE_ORDER).not.toContain("treg.people.enrich");
    expect(applyReverseOrder(["x.a", "treg.people.enrich", "quickenrich.people.enrich"], (s) => s)).toEqual(["x.a", "treg.people.enrich", "quickenrich.people.enrich"]);
  });

  it("M4 & M5: extractIdentity & attempt capture workEmail, personalEmail, phone with source, and miss reports $0 no_data", async () => {
    expect(FIELD_KEYS).toContain("workEmail");
    expect(FIELD_KEYS).toContain("personalEmail");
    expect(FIELD_KEYS).toContain("phone");
    const enriched = { data: { person: { full_name: "Sara Ahmed", company: "Acme Co", job_title: "CTO", work_email: "sara@acme.com", personal_email: "sara.personal@gmail.com", phone_number: "+201001112233", linkedin_url: "https://www.linkedin.com/in/sara-ahmed", country: "Egypt" } } };
    const { calls, call } = fakeCall({ "treg.people.enrich": enriched }, () => 950);
    const out = await runLookupAttempt({ client: state.client, adminId: "adm-1", text: "https://www.linkedin.com/in/sara-ahmed", endpointId: "treg.people.enrich", confirmedUsd: 0.28, call });
    expect(out.ok && out.found).toBe(true);
    expect(out.ok && out.fields).toMatchObject({
      name: { value: "Sara Ahmed", source: "treg.people.enrich" },
      workEmail: { value: "sara@acme.com", source: "treg.people.enrich" },
      personalEmail: { value: "sara.personal@gmail.com", source: "treg.people.enrich" },
      phone: { value: "+201001112233", source: "treg.people.enrich" },
    });
    expect(calls[0].params).toEqual({ linkedin_url: "https://www.linkedin.com/in/sara-ahmed" });

    const miss = fakeCall({ "treg.people.enrich": nothing }, () => 0);
    const missOut = await runLookupAttempt({ client: state.client, adminId: "adm-1", text: "https://www.linkedin.com/in/missing-person", endpointId: "treg.people.enrich", confirmedUsd: 0.28, call: miss.call });
    expect(missOut).toMatchObject({ ok: true, found: false, attempt: { outcome: "no_data", costUsd: 0 } });
  });

  it("M6 & A1: confirmation gate refuses < 0.28, and confirmed call enables waterfall (no X-Treg-Route-Waterfall: 0 header) bounded by routeMaxCostUsd <= confirmedUsd <= 0.28", async () => {
    const { calls, call } = fakeCall({ "treg.people.enrich": person }, () => 120_000);
    const low = await runLookupAttempt({ client: state.client, adminId: "adm-1", text: "sara@acme.com", endpointId: "treg.people.enrich", confirmedUsd: 0.2, call });
    expect(low).toMatchObject({ ok: false, reason: "needs_confirmation", priceUsd: 0.28 });
    expect(calls).toHaveLength(0);

    const okRun = await runLookupAttempt({ client: state.client, adminId: "adm-1", text: "sara@acme.com", endpointId: "treg.people.enrich", confirmedUsd: 0.28, call });
    expect(okRun).toMatchObject({ ok: true, found: true, attempt: { outcome: "found", costUsd: 0.12 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].routeWaterfall).toBeUndefined();
    expect(calls[0].routeMaxCostUsd).toBeLessThanOrEqual(0.28);
  });

  it("M7 & A2: history sanitizeEntry/loadLookupHistory/saveLookupHistory accept social_url & contact fields, and DB CHECK rejection falls back cleanly with stored: false", async () => {
    const rawResult = { fields: { workEmail: { value: "sara@acme.com", source: "treg.people.enrich" }, phone: { value: "+201001112233", source: "treg.people.enrich" } }, attempts: [{ endpointId: "treg.people.enrich", outcome: "found", costUsd: 0.05, note: "" }] };
    const clean = sanitizeEntry(rawResult, "https://www.linkedin.com/in/sara-ahmed?trk=1");
    expect(clean).toMatchObject({ kind: "social_url", maskedInput: "www.linkedin.com/***", found: true, costUsd: 0.05, fields: rawResult.fields });

    state.client.seed("admin_lookup_history", [{ id: "row-1", created_at: "2026-11-25T10:00:00Z", kind: "social_url", masked_input: "www.linkedin.com/***", found: true, result: rawResult, cost_usd: 0.05 }]);
    const loaded = await loadLookupHistory(state.client);
    expect(loaded.available).toBe(true);
    expect(loaded.rows[0]).toMatchObject({ id: "row-1", kind: "social_url", maskedInput: "www.linkedin.com/***", fields: rawResult.fields });

    // Counter-case A2: server table CHECK constraint rejects social_url -> save returns stored: false without throwing
    const rejectingClient = { from: () => ({ insert: async () => ({ data: null, error: { message: "new row violates check constraint admin_lookup_history_kind_check" } }) }) };
    await expect(saveLookupHistory(rejectingClient, "adm-1", clean!)).resolves.toEqual({ stored: false, id: null });
  });

  it("D3: runProviderSync preserves treg.reverseLookup in baselineNext", async () => {
    const metadata = JSON.parse(readFileSync("data/capabilities/provider-metadata.json", "utf-8"));
    const writeIds = new Set((JSON.parse(readFileSync("data/treg/treg_write_actions.json", "utf-8")) as Array<{ id: string }>).map((w) => w.id));
    const snapshot = (JSON.parse(readFileSync("data/treg/treg_catalog_sellable.json", "utf-8")) as { endpoints: any[] }).endpoints;
    const registry = JSON.parse(readFileSync("data/capabilities/registry.json", "utf-8"));
    const out = await runProviderSync({
      registry,
      snapshot,
      writeIds,
      baseline: metadata,
      fetchText: async () => ({ ok: false, error: "offline" }),
      date: "2026-11-25",
    });
    expect(out.baselineNext.treg.reverseLookup).toEqual(metadata.treg.reverseLookup);
  });

  it("C3 & route social_url plan: API authenticates admin before plan/attempt/save for social_url", async () => {
    const post = (body: unknown) => import("../src/app/api/admin/reverse-lookup/route").then((m) => m.POST(new NextRequest("http://127.0.0.1:3000/api/admin/reverse-lookup", { method: "POST", body: JSON.stringify(body) })));
    state.admin = false;
    expect((await post({ action: "plan", input: "https://www.linkedin.com/in/sara-ahmed" })).status).toBe(403);
    state.admin = true;
    const res = await post({ action: "plan", input: "https://www.linkedin.com/in/sara-ahmed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, kind: "social_url", plan: [{ id: "treg.people.enrich", paramName: "linkedin_url", usd: 0.28, paid: true, state: "confirm" }] });
    expect((await post({ action: "plan", input: "https://www.linkedin.com/company/acme" })).status).toBe(400);
  });
});
