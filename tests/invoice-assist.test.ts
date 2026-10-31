import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSIST_MAX_CALLS_PER_HOUR, ASSIST_MAX_CHARS, ASSIST_MAX_ENTRIES, ASSIST_MAX_SECTORS, ASSIST_MODEL, assistCostUsd, assistSystemPrompt, parseAssistReply,
} from "../src/lib/invoices/assist";
import { emptyForm, formToPreview } from "../src/lib/invoices/form";
import { buildSheetModel } from "../src/lib/invoices/sheetModel";
import { applyAssist, type ItemTypeLite } from "../src/lib/invoices/sectors";
import { runAssist, type AssistDeps } from "../src/lib/server/invoices/assist";
import { InvoiceDbModel } from "./helpers/invoiceDb";

const h = vi.hoisted(() => ({
  user: null as any,
  model: null as any,
  key: "sk-ant-TEST-SECRET-KEY-do-not-leak",
  fetchCalls: [] as Array<{ url: string; init: any }>,
  reply: "[]",
  status: 200,
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user }, error: null }) } }) }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : new Error("no session") })) } })),
  createAdminClient: () => h.model,
}));
vi.mock("../src/lib/server/providerKeys", () => ({
  resolveProviderKey: async () => ({ key: h.key, source: "env" }),
  reportProviderHttpStatus: () => {},
}));

const TYPES = [{ id: "t1", nameAr: "شركة" }, { id: "t2", nameAr: "مدير" }, { id: "t3", nameAr: "بريد إلكتروني" }, { id: "t4", nameAr: "رقم هاتف" }];
const OWNER_NOTE = "سحبت ٢٠٠ شركة كهروميكانيكا ومعاهم ٣٤٠ مدير، و٨٠ شركة بترول و١٢٠ شركة مقاولات";
const OWNER_REPLY = JSON.stringify([
  { sector: "كهروميكانيكا", item_type: "شركة", quantity: 200 }, { sector: "كهروميكانيكا", item_type: "مدير", quantity: 340 },
  { sector: "بترول", item_type: "شركة", quantity: 80 }, { sector: "مقاولات", item_type: "شركة", quantity: 120 },
]);

describe("the reply is accepted only as [{sector, item_type, quantity}] with known item types and whole quantities", () => {
  it("the owner's example reads as 3 sectors with the right counts", () => {
    const r = parseAssistReply(OWNER_REPLY, TYPES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sectors.map((s) => [s.sector, s.counts.map((c) => [c.itemTypeName, c.quantity])])).toEqual([
      ["كهروميكانيكا", [["شركة", 200], ["مدير", 340]]], ["بترول", [["شركة", 80]]], ["مقاولات", [["شركة", 120]]],
    ]);
  });

  it("a code fence is tolerated; a repeated sector and type are added together", () => {
    const r = parseAssistReply("```json\n" + JSON.stringify([{ sector: "بترول", item_type: "شركة", quantity: 30 }, { sector: "بترول", item_type: "شركة", quantity: 50 }]) + "\n```", TYPES);
    expect(r.ok && r.sectors[0].counts).toEqual([{ itemTypeId: "t1", itemTypeName: "شركة", quantity: 80 }]);
  });

  it("ANY price, total, currency or other extra field rejects the WHOLE reply (nothing is half-trusted)", () => {
    const base = { sector: "بترول", item_type: "شركة", quantity: 5 };
    for (const extra of [{ price: 99 }, { unit_price: 12 }, { total: 495 }, { amount: 5 }, { currency: "USD" }, { cost: 1 }, { points: 10 }, { rate: 50 }, { discount: 1 }, { tax: 1 }, { "سعر": 5 }, { note: "x" }, { unit: 1 }]) {
      const r = parseAssistReply(JSON.stringify([{ sector: "كهرباء", item_type: "مدير", quantity: 2 }, { ...base, ...extra }]), TYPES);
      expect(r.ok, JSON.stringify(extra)).toBe(false);
    }
    expect(parseAssistReply(JSON.stringify([{ ...base, price: 1 }]), TYPES)).toEqual({ ok: false, reason: "money_field" });
    expect(parseAssistReply(JSON.stringify([{ sector: "ب", quantity: 5 }]), TYPES)).toEqual({ ok: false, reason: "bad_entry" });
  });

  it("an unknown item type, a wrong quantity, prose, an object and an empty list are all rejected", () => {
    const one = (o: Record<string, unknown>) => parseAssistReply(JSON.stringify([{ sector: "ب", item_type: "شركة", quantity: 5, ...o }]), TYPES);
    expect(one({ item_type: "منتج" })).toEqual({ ok: false, reason: "unknown_type" });
    expect(one({ item_type: "الشركات" })).toEqual({ ok: false, reason: "unknown_type" });
    for (const q of [0, -3, 1.5, "200", null, 10_000_001, Number.NaN]) expect(one({ quantity: q }).ok, String(q)).toBe(false);
    expect(one({ quantity: 10_000_000 }).ok).toBe(true);
    expect(one({ sector: "" })).toEqual({ ok: false, reason: "bad_sector" });
    expect(parseAssistReply("هذه هي النتيجة: " + OWNER_REPLY, TYPES)).toEqual({ ok: false, reason: "not_json" });
    expect(parseAssistReply(JSON.stringify({ items: JSON.parse(OWNER_REPLY) }), TYPES)).toEqual({ ok: false, reason: "not_array" });
    expect(parseAssistReply("[]", TYPES)).toEqual({ ok: false, reason: "empty" });
  });

  it("at most 50 sectors and 200 entries", () => {
    const many = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ sector: `قطاع ${i}`, item_type: "شركة", quantity: 1 })));
    expect(parseAssistReply(many(ASSIST_MAX_SECTORS), TYPES).ok).toBe(true);
    expect(parseAssistReply(many(ASSIST_MAX_SECTORS + 1), TYPES)).toEqual({ ok: false, reason: "too_many_sectors" });
    expect(parseAssistReply(many(ASSIST_MAX_ENTRIES + 1), TYPES)).toEqual({ ok: false, reason: "too_many_entries" });
  });

  it("emoji and hidden direction marks in a sector name are removed", () => {
    const r = parseAssistReply(JSON.stringify([{ sector: "بترول \u{1F600}‮", item_type: "شركة", quantity: 5 }]), TYPES);
    expect(r.ok && r.sectors[0].sector).toBe("بترول");
  });
});

describe("the model never decides money: prices come from the item-type table, totals from the money library", () => {
  const PRICED: ItemTypeLite[] = [{ id: "t1", nameAr: "شركة", unitCc: 1200 }, { id: "t2", nameAr: "مدير", unitCc: 3500 }];
  const SELLER = { name: "ديجر", email: "support@diger.tech", website: "diger.tech", taxNumber: "", commercialRegister: "" };

  it("a reply carrying its own price/total is rejected, so its figures can never reach a document", () => {
    const sneaky = JSON.stringify([{ sector: "بترول", item_type: "شركة", quantity: 80, unit_price_usd: 1, total: 80 }]);
    expect(parseAssistReply(sneaky, PRICED).ok).toBe(false);
  });

  it("an accepted reply becomes a draft with the TABLE prices; the total is exactly quantity x table price (80 x 12 cents = $9.60)", () => {
    const r = parseAssistReply(JSON.stringify([{ sector: "بترول", item_type: "شركة", quantity: 80 }]), PRICED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const form = applyAssist({ ...emptyForm("invoice", "2026-10-31", { rateE4: null, payment: "" }), company: "x" }, r.sectors, PRICED);
    expect(form.lines.map((l) => [l.qty, l.unit])).toEqual([["80", "0.12"]]);
    const total = buildSheetModel(formToPreview(form, { id: null, number: "", status: "draft", revision: 1, instapayAddress: "" }), SELLER).totalRows.at(-1)!.amounts;
    expect(total).toEqual(["٩.٦٠"]);
  });

  it("the instruction lists item-type NAMES only: no price and no digit of one is ever sent to the model", () => {
    const prompt = assistSystemPrompt(PRICED.map((t) => t.nameAr));
    expect(prompt).toContain('["شركة","مدير"]');
    expect(prompt).not.toMatch(/1200|3500|12\.00|0\.12/);
    expect(prompt).toMatch(/Never output a price/);
  });

  it("the cost estimate follows the model's list prices ($0.10 in / $0.50 out per million tokens)", () => {
    expect(ASSIST_MODEL).toBe("claude-haiku-5-5");
    expect(assistCostUsd(1_000_000, 0)).toBeCloseTo(0.1, 10);
    expect(assistCostUsd(0, 1_000_000)).toBeCloseTo(0.5, 10);
    expect(assistCostUsd(700, 500)).toBeCloseTo(0.00032, 8); // a typical call
    expect(assistCostUsd(1500, 4000)).toBeCloseTo(0.00215, 8); // the worst case allowed by the limits
  });
});

describe("runAssist: limits are taken before the model is called", () => {
  const deps = (over: Partial<AssistDeps> = {}) => {
    const log = { counted: 0, recorded: 0, calls: 0 };
    const d: AssistDeps = {
      now: () => new Date("2026-10-31T10:00:00Z"),
      countAttempts: async () => { log.counted += 1; return log.recorded; },
      recordAttempt: async () => { log.recorded += 1; return true; },
      callModel: async () => { log.calls += 1; return { ok: true, text: OWNER_REPLY, inputTokens: 700, outputTokens: 300, stopReason: "end_turn" }; },
      ...over,
    };
    return { d, log };
  };

  it("2,000 characters are fine, 2,001 are refused before anything is recorded or sent", async () => {
    const { d, log } = deps();
    expect((await runAssist({ adminId: "a", text: "ش".repeat(ASSIST_MAX_CHARS), types: TYPES }, d)).ok).toBe(true);
    const long = await runAssist({ adminId: "a", text: "ش".repeat(ASSIST_MAX_CHARS + 1), types: TYPES }, d);
    expect(long).toMatchObject({ ok: false, status: 400, code: "too_long" });
    expect(log.recorded).toBe(1);
    expect(log.calls).toBe(1);
    expect(await runAssist({ adminId: "a", text: "   ", types: TYPES }, d)).toMatchObject({ ok: false, status: 400, code: "empty" });
  });

  it("20 calls an hour, the 21st is refused with no model call; the slot is taken BEFORE the call (a failed call still counts)", async () => {
    const { d, log } = deps({ callModel: async () => ({ ok: false, code: "network" }) });
    for (let i = 0; i < ASSIST_MAX_CALLS_PER_HOUR; i++) expect(await runAssist({ adminId: "a", text: OWNER_NOTE, types: TYPES }, d)).toMatchObject({ ok: false, status: 502, code: "failed" });
    expect(log.recorded).toBe(20);
    const blocked = await runAssist({ adminId: "a", text: OWNER_NOTE, types: TYPES }, d);
    expect(blocked).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
    expect(log.recorded).toBe(20);
  });

  it("if the attempt cannot be recorded, nothing is sent (it fails closed)", async () => {
    let calls = 0;
    const { d } = deps({ recordAttempt: async () => false, callModel: async () => { calls += 1; return { ok: false, code: "network" }; } });
    expect(await runAssist({ adminId: "a", text: OWNER_NOTE, types: TYPES }, d)).toMatchObject({ ok: false, status: 503 });
    expect(calls).toBe(0);
  });

  it("an unreadable or empty reply gives a short Arabic message and no sectors; the model's text is never passed on", async () => {
    const bad = deps({ callModel: async () => ({ ok: true, text: "Sure! Here you go: price 100 USD", inputTokens: 5, outputTokens: 5, stopReason: "end_turn" }) });
    const r = await runAssist({ adminId: "a", text: OWNER_NOTE, types: TYPES }, bad.d);
    expect(r).toMatchObject({ ok: false, status: 422, code: "unreadable" });
    expect(JSON.stringify(r)).not.toMatch(/Sure|USD|price 100/);
    const none = deps({ callModel: async () => ({ ok: true, text: "[]", inputTokens: 5, outputTokens: 5, stopReason: "end_turn" }) });
    expect(await runAssist({ adminId: "a", text: "مرحبا", types: TYPES }, none.d)).toMatchObject({ ok: false, status: 422, code: "nothing" });
  });
});

describe("the route: admin only, the key stays on the server, nothing is saved", () => {
  const admin: any = { id: "11111111-1111-4111-8111-111111111111", email: "a@b.c", app_metadata: { role: "admin" }, user_metadata: {} };
  const logs: string[] = [];
  const call = async (text: unknown, user = admin) => {
    h.user = user;
    const route = await import("../src/app/api/admin/invoices/assist/route");
    const res = await route.POST(new NextRequest("http://x/api/admin/invoices/assist", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ text }) }));
    return { status: res.status, text: await res.text() };
  };

  beforeEach(() => {
    h.model = new InvoiceDbModel();
    h.model.now = () => new Date(); // the route counts the last hour on the REAL clock; a fixed model clock made this test pass only within an hour of 10:00Z on 2026-10-31
    h.model.tables.invoice_item_types.forEach((t: any) => { t.default_unit_price_usd_centi_cents = t.name_ar === "شركة" ? 1234 : 5678; });
    h.user = null; h.key = "sk-ant-TEST-SECRET-KEY-do-not-leak"; h.fetchCalls = []; h.reply = OWNER_REPLY; h.status = 200; logs.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock";
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      h.fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ content: [{ type: "text", text: h.reply }], usage: { input_tokens: 700, output_tokens: 300 }, stop_reason: "end_turn" }), { status: h.status });
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("no session: 401; a customer: 403; the model is never called and the key is never used", async () => {
    expect((await call(OWNER_NOTE, null as any)).status).toBe(401);
    for (const role of [undefined, "user", "support"]) expect((await call(OWNER_NOTE, { ...admin, app_metadata: role ? { role } : {} })).status, String(role)).toBe(403);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.model.touched).toEqual([]);
  });

  it("the owner's note: 4 sectors' counts come back; ONE call to the Messages API with the server key, the cheap model, the note and names, no price", async () => {
    const r = await call(OWNER_NOTE);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text);
    expect(body.sectors.map((s: any) => s.sector)).toEqual(["كهروميكانيكا", "بترول", "مقاولات"]);
    expect(body.sectors[0].counts.map((c: any) => [c.itemTypeName, c.quantity])).toEqual([["شركة", 200], ["مدير", 340]]);
    expect(h.fetchCalls).toHaveLength(1);
    const { url, init } = h.fetchCalls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe(h.key);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.max_tokens).toBe(4000);
    expect(sent.messages).toEqual([{ role: "user", content: OWNER_NOTE }]);
    expect(sent.system).toContain("شركة");
    expect(init.body).not.toMatch(/1234|5678|12\.34|56\.78/); // the table prices (12.34 and 56.78 cents here) never reach the model
    expect(body.cost).toEqual({ model: "claude-haiku-5-5", inputTokens: 700, outputTokens: 300 });
  });

  it("the key is never in a response or a log line; nothing is saved (no document, no write outside the audit rows)", async () => {
    const ok = await call(OWNER_NOTE);
    h.status = 500;
    const failed = await call(OWNER_NOTE);
    expect(failed.status).toBe(502);
    for (const out of [ok.text, failed.text, ...logs]) expect(out).not.toContain(h.key);
    expect(h.model.tables.invoice_documents).toHaveLength(0);
    expect(h.model.touched.filter((t: any) => t.op !== "select").map((t: any) => t.name)).toEqual(["admin_audit_log", "admin_audit_log", "admin_audit_log"]); // attempt, usage, attempt
  });

  it("a reply with a price or total is refused (422): the response carries no sectors and none of its figures", async () => {
    h.reply = JSON.stringify([{ sector: "بترول", item_type: "شركة", quantity: 80, unit_price: 1, total: 80 }]);
    const r = await call(OWNER_NOTE);
    expect(r.status).toBe(422);
    const body = JSON.parse(r.text);
    expect(body.sectors).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/unit_price|total/);
    expect(body.error).toMatch(/نصك لم يُمسح/);
  });

  it("20 an hour per admin through the route: the 21st is a 429 with no model call; another admin has their own allowance; an hour later it opens again", async () => {
    for (let i = 0; i < ASSIST_MAX_CALLS_PER_HOUR; i++) expect((await call(OWNER_NOTE)).status).toBe(200);
    expect(h.fetchCalls).toHaveLength(20);
    const blocked = await call(OWNER_NOTE);
    expect(blocked.status).toBe(429);
    expect(JSON.parse(blocked.text).error).toMatch(/٢٠ مرة في الساعة/);
    expect(h.fetchCalls).toHaveLength(20);
    expect((await call(OWNER_NOTE, { ...admin, id: "22222222-2222-4222-8222-222222222222" })).status).toBe(200);
    for (const row of h.model.extra.admin_audit_log) row.created_at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect((await call(OWNER_NOTE)).status).toBe(200);
  });

  it("2,001 characters: 400 and nothing recorded or sent; a missing key: a plain 503 and nothing sent", async () => {
    expect((await call("ش".repeat(2001))).status).toBe(400);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.model.extra.admin_audit_log ?? []).toHaveLength(0);
    h.key = "";
    const r = await call(OWNER_NOTE);
    expect(r.status).toBe(503);
    expect(h.fetchCalls).toHaveLength(0);
  });
});
