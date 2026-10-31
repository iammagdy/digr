import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MAX_CALLS_PER_HOUR, AGENT_MAX_CHARS, AGENT_MODEL, agentCostUsd } from "../src/lib/invoices/chat/limits";
import { AGENT_SYSTEM_PROMPT, buildAgentRequest, cleanHistory, estimateTextTokens } from "../src/lib/invoices/chat/prompt";
import { runAgent, sanitizeDraft, type AgentDeps } from "../src/lib/server/invoices/chat/run";
import { InvoiceDbModel } from "./helpers/invoiceDb";
import { fakeAgentReply } from "./helpers/agentFakeModel";
import { fixtureElectro, fixtureMixedSectors, fixturePetrol, PNG_1X1 } from "./helpers/agentFixtures";

const h = vi.hoisted(() => ({ user: null as any, model: null as any, key: "sk-ant-TEST-SECRET-KEY-do-not-leak", fetchCalls: [] as Array<{ url: string; init: any }>, replyFn: null as null | ((content: any[]) => string), status: 200 }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user }, error: null }) } }) }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : new Error("no session") })) } })),
  createAdminClient: () => h.model,
}));
vi.mock("../src/lib/server/providerKeys", () => ({ resolveProviderKey: async () => ({ key: h.key, source: "env" }), reportProviderHttpStatus: () => {} }));

const DRAFT = { doc_type: "invoice", currencies: { usd: true, points: false, egp: false }, rate_set: false, discount: "none", client: "", sectors: [], lines: [], lines_listed: true };
const TYPE_NAMES = ["شركة", "مدير", "بريد إلكتروني", "رقم هاتف"];

const deps = (over: Partial<AgentDeps> = {}) => {
  const log = { counted: 0, recorded: 0, calls: 0, requests: [] as Array<{ system: string; content: any[] }> };
  const d: AgentDeps = {
    now: () => new Date("2026-10-31T10:00:00Z"),
    countAttempts: async () => { log.counted += 1; return log.recorded; },
    recordAttempt: async () => { log.recorded += 1; return true; },
    callModel: async (system, content) => { log.calls += 1; log.requests.push({ system, content }); return { ok: true, text: fakeAgentReply(content), inputTokens: 3000, outputTokens: 400, stopReason: "end_turn" }; },
    ...over,
  };
  return { d, log };
};
const input = (over: Record<string, unknown> = {}) => ({ adminId: "a", message: "اعمل فاتورة للشركة دي، الدولار النهارده ٥٦ جنيه", history: [], draft: DRAFT, files: [] as Array<{ name: string; bytes: Uint8Array }>, itemTypeNames: TYPE_NAMES, ...over });
const asFile = (f: { name: string; bytes: Uint8Array }) => ({ name: f.name, bytes: f.bytes });

describe("the owner's flow, end to end through the real runner (scripted model)", () => {
  it("3 attached xlsx files: the model maps columns from the masked profiles, CODE counts the real cells", async () => {
    const [a, b, c] = [await fixtureElectro(), await fixturePetrol(), await fixtureMixedSectors()];
    const { d } = deps();
    const r = await runAgent(input({ files: [asFile(a), asFile(b), asFile(c)] }), d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count?.sectors.map((s) => [s.sector, s.companies, s.managers, s.emails, s.phones])).toEqual([
      ["كهروميكانيكا", 200, 312, 287, 140], ["بترول", 150, 190, 120, 95], ["مقاولات", 120, 120, 100, 70], ["عقارات", 60, 50, 45, 30],
    ]);
    expect(r.unmapped).toEqual([{ file: "كهروميكانيكا.xlsx", sheet: "ملاحظات", rows: 2, columns: 1, status: "ignored" }]); // a two-line note is listed, never skipped silently
    expect(r.actions).toEqual([{ type: "set_rate", rateE4: 560000 }, { type: "set_doc_type", docType: "invoice" }]);
    expect(r.files.map((f) => f.name)).toEqual(["كهروميكانيكا.xlsx", "بترول.xlsx", "مقاولات وعقارات.xlsx"]);
    expect(r.usage.model).toBe("claude-haiku-5-5");
  });

  it("counts do not depend on the model: a model that maps the wrong column gets different numbers, from the SAME code", async () => {
    const a = await fixtureElectro();
    const wrong = deps({ callModel: async () => ({ ok: true, text: JSON.stringify({ mapping: [{ file: a.name, sheet: "الشركات", sector_name: "ك", columns: { company: "C" } }] }), inputTokens: 1, outputTokens: 1, stopReason: "end_turn" }) });
    const r = await runAgent(input({ files: [asFile(a)] }), wrong.d);
    expect(r.ok).toBe(true);
    // column C holds managers: 312 distinct manager names, not 200 companies: code counted what it was told to count
    expect(r.ok && r.count?.sectors[0].companies).toBe(312);
  });
});

describe("the exact request sent to the model holds no raw customer data", () => {
  it("not one raw cell value (4+ characters) of the three fixtures appears anywhere in the system prompt or the user payload", async () => {
    const fixtures = [await fixtureElectro(), await fixturePetrol(), await fixtureMixedSectors()];
    const { d, log } = deps();
    const r = await runAgent(input({ files: fixtures.map(asFile) }), d);
    expect(r.ok).toBe(true);
    const wire = JSON.stringify([log.requests[0].system, log.requests[0].content]);
    let checked = 0;
    // what the model is ALLOWED to see in clear: file names, sheet names and headers (a cell that equals one of those words is not a leak)
    const allowed = fixtures.map((f) => `${f.name} ${f.rows[0].join(" ")}`).join(" ") + " ملاحظات الشركات الكل بيانات";
    for (const f of fixtures) for (const row of f.rows.slice(1)) for (const cell of row) {
      if (cell.length < 4 || allowed.includes(cell)) continue;
      checked++;
      expect(wire.includes(cell), `raw «${cell}» (${f.name}) is in the request`).toBe(false);
    }
    expect(checked).toBeGreaterThan(2000);
    expect(wire).not.toMatch(/user[EPCR]\d+@/);
    expect(wire).not.toMatch(/\b01[0125]\d{8}\b/);
  });

  it("the payload has the file name, sheet names, headers, row counts and at most 5 masked samples per column; no price, total or rate value", async () => {
    const f = await fixtureElectro();
    const { d, log } = deps();
    await runAgent(input({ files: [asFile(f)], draft: { ...DRAFT, rate_set: true } }), d);
    const payload = JSON.parse(log.requests[0].content[0].text);
    expect(Object.keys(payload).sort()).toEqual(["draft", "files", "history", "images", "item_types", "owner_message"]);
    const sheet = payload.files[0].sheets[0];
    expect(payload.files[0].file).toBe("كهروميكانيكا.xlsx");
    expect(sheet.rows).toBe(316);
    expect(sheet.columns.map((c: any) => c.header)).toEqual(["م", "اسم الشركة", "المدير المسؤول", "البريد الإلكتروني", "الهاتف"]);
    for (const c of sheet.columns) expect(c.samples.length).toBeLessThanOrEqual(5);
    expect(payload.item_types).toEqual(TYPE_NAMES);
    expect(JSON.stringify(payload)).not.toMatch(/unit_price|"price"|"total"|1200|3500/);
    expect(AGENT_SYSTEM_PROMPT).not.toMatch(/1200|3500|12\.00/);
  });

  it("images are sent as pictures (vision), each labelled by name", async () => {
    const { d, log } = deps();
    const r = await runAgent(input({ message: "اقرأ الصورة", files: [{ name: "scan.png", bytes: PNG_1X1 }] }), d);
    expect(r.ok).toBe(true);
    const blocks = log.requests[0].content;
    expect(blocks.map((b: any) => b.type)).toEqual(["text", "text", "image"]);
    expect(blocks[2].source).toMatchObject({ type: "base64", media_type: "image/png" });
    expect(r.ok && r.imageCounts).toEqual([{ image: "scan.png", sector: "مقاولات", itemType: "company", quantity: 42 }, { image: "scan.png", sector: "مقاولات", itemType: "manager", quantity: 30 }]);
  });

  it("history: the owner's words go back, the assistant's own digit-free sentences too, a sentence with a number never does", () => {
    const hist = cleanHistory([{ role: "owner", text: "الدولار ٥٦" }, { role: "assistant", text: "تمام، سجلت السعر." }, { role: "assistant", text: "الإجمالي ١٧ دولار" }, { role: "system", text: "x" }, { role: "owner" }, null]);
    expect(hist).toEqual([{ role: "owner", text: "الدولار ٥٦" }, { role: "assistant", text: "تمام، سجلت السعر." }]);
    expect(cleanHistory(Array.from({ length: 20 }, (_, i) => ({ role: "owner", text: `m${i}` })))).toHaveLength(6);
  });

  it("buildAgentRequest is pure: same input, same request", () => {
    const a = buildAgentRequest({ message: "x", history: [], draft: DRAFT as any, profiles: [], images: [], itemTypeNames: TYPE_NAMES });
    expect(a).toEqual(buildAgentRequest({ message: "x", history: [], draft: DRAFT as any, profiles: [], images: [], itemTypeNames: TYPE_NAMES }));
  });
});

describe("limits are taken before the model is called", () => {
  it("4,000 characters are fine, 4,001 are refused before anything is read, recorded or sent; empty and 6 files too", async () => {
    const { d, log } = deps();
    expect((await runAgent(input({ message: "ش".repeat(AGENT_MAX_CHARS) }), d)).ok).toBe(true);
    expect(await runAgent(input({ message: "ش".repeat(AGENT_MAX_CHARS + 1) }), d)).toMatchObject({ ok: false, status: 400, code: "too_long" });
    expect(await runAgent(input({ message: "  " }), d)).toMatchObject({ ok: false, status: 400, code: "empty" });
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.csv`, bytes: new TextEncoder().encode("a,b\n1,2") }));
    expect(await runAgent(input({ files: six }), d)).toMatchObject({ ok: false, status: 400, code: "too_many_files" });
    expect(log.recorded).toBe(1);
    expect(log.calls).toBe(1);
  });

  it("30 an hour: the 31st is a 429 with no model call; the slot is taken BEFORE the call (a failed call still counts); fails closed if it cannot be recorded", async () => {
    const failing = deps({ callModel: async () => ({ ok: false, code: "network" }) });
    for (let i = 0; i < AGENT_MAX_CALLS_PER_HOUR; i++) expect(await runAgent(input(), failing.d)).toMatchObject({ ok: false, status: 502, code: "failed" });
    expect(failing.log.recorded).toBe(30);
    expect(await runAgent(input(), failing.d)).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
    expect(failing.log.recorded).toBe(30);
    let calls = 0;
    const closed = deps({ recordAttempt: async () => false, callModel: async () => { calls++; return { ok: false, code: "network" }; } });
    expect(await runAgent(input(), closed.d)).toMatchObject({ ok: false, status: 503 });
    expect(calls).toBe(0);
  });

  it("an unreadable file is the owner's to fix: no model call and NO allowance used", async () => {
    const { d, log } = deps();
    for (const bad of [{ name: "old.xls", bytes: PNG_1X1 }, { name: "x.docx", bytes: PNG_1X1 }, { name: "x.xlsx", bytes: PNG_1X1 }]) {
      const r = await runAgent(input({ files: [bad] }), d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/[؀-ۿ]/);
    }
    expect(log.recorded).toBe(0);
    expect(log.calls).toBe(0);
  });

  it("a reply the code does not accept (prose, an unknown action, a money field) gives one Arabic sentence and nothing is applied or counted", async () => {
    const f = await fixturePetrol();
    for (const text of ["تمام يا فندم", JSON.stringify({ actions: [{ action: "send_invoice" }] }), JSON.stringify({ total: 17 }), JSON.stringify({ mapping: [{ file: "ghost.xlsx", sheet: "x", columns: { company: "A" } }] })]) {
      const { d } = deps({ callModel: async () => ({ ok: true, text, inputTokens: 5, outputTokens: 5, stopReason: "end_turn" }) });
      const r = await runAgent(input({ files: [asFile(f)] }), d);
      expect(r).toMatchObject({ ok: false, status: 422 });
      expect(JSON.stringify(r)).not.toMatch(/send_invoice|ghost|تمام يا فندم/);
    }
  });

  it("sanitizeDraft rebuilds the draft field by field and refuses a bad shape", () => {
    expect(sanitizeDraft(DRAFT)?.summary.doc_type).toBe("invoice");
    expect(sanitizeDraft({ ...DRAFT, doc_type: "x" })).toBeNull();
    expect(sanitizeDraft({ ...DRAFT, lines: [{ id: "bad id", sector: "", item_type: "", hidden: false }] })).toBeNull();
    expect(sanitizeDraft({ ...DRAFT, sectors: [{ name: "a", counts: { company: -1 } }] })).toBeNull();
    const clean = sanitizeDraft({ ...DRAFT, price: 5, sectors: [{ name: "ب", summary_only: false, counts: { company: 3, price: 9 } }] });
    expect(JSON.stringify(clean?.summary)).not.toContain("price");
    expect(sanitizeDraft(null)).toBeNull();
  });

  it("the cost: haiku 5.5 list prices; a typical call and the heaviest call the limits allow", () => {
    expect(AGENT_MODEL).toBe("claude-haiku-5-5");
    expect(agentCostUsd(1_000_000, 0)).toBeCloseTo(0.1, 10);
    expect(agentCostUsd(0, 1_000_000)).toBeCloseTo(0.5, 10);
    expect(agentCostUsd(4000, 500)).toBeCloseTo(0.00065, 8);
    expect(agentCostUsd(12_000, 6000)).toBeCloseTo(0.0042, 8);
    expect(estimateTextTokens("x".repeat(3200))).toBe(1000);
  });
});

describe("the route: admin only, the key and the files stay on the server, nothing is stored", () => {
  const admin: any = { id: "11111111-1111-4111-8111-111111111111", email: "a@b.c", app_metadata: { role: "admin" }, user_metadata: {} };
  const logs: string[] = [];
  const post = async (fields: { message?: string; draft?: unknown; files?: Array<{ name: string; bytes: Uint8Array }> }, user = admin) => {
    h.user = user;
    const fd = new FormData();
    fd.set("message", fields.message ?? "اعمل فاتورة، الدولار ٥٦");
    fd.set("history", "[]");
    fd.set("draft", JSON.stringify(fields.draft ?? DRAFT));
    for (const f of fields.files ?? []) fd.append("files", new File([f.bytes as BlobPart], f.name));
    const route = await import("../src/app/api/admin/invoices/agent/route");
    const res = await route.POST(new NextRequest("http://x/api/admin/invoices/agent", { method: "POST", headers: { authorization: "Bearer t" }, body: fd }));
    return { status: res.status, text: await res.text() };
  };

  beforeEach(() => {
    h.model = new InvoiceDbModel();
    h.model.now = () => new Date();
    h.user = null; h.key = "sk-ant-TEST-SECRET-KEY-do-not-leak"; h.fetchCalls = []; h.replyFn = null; h.status = 200; logs.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock";
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      h.fetchCalls.push({ url, init });
      const content = JSON.parse(init.body).messages[0].content;
      return new Response(JSON.stringify({ content: [{ type: "text", text: (h.replyFn ?? fakeAgentReply)(typeof content === "string" ? [{ type: "text", text: content }] : content) }], usage: { input_tokens: 3100, output_tokens: 420 }, stop_reason: "end_turn" }), { status: h.status });
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("no session: 401; a customer, support or no role: 403; the model is never called and the key is never used", async () => {
    expect((await post({}, null as any)).status).toBe(401);
    for (const role of [undefined, "user", "support"]) expect((await post({}, { ...admin, app_metadata: role ? { role } : {} })).status, String(role)).toBe(403);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.model.touched).toEqual([]);
  });

  it("an admin's multipart turn: counts come back, the Anthropic request has no raw cell, the key is only in the header, nothing is written but audit rows", async () => {
    const f = await fixtureElectro();
    const r = await post({ files: [f] });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text);
    expect(body.count.sectors[0]).toMatchObject({ sector: "كهروميكانيكا", companies: 200, managers: 312, emails: 287, phones: 140 });
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(h.fetchCalls[0].init.headers["x-api-key"]).toBe(h.key);
    const sent = h.fetchCalls[0].init.body as string;
    const parsed = JSON.parse(sent);
    expect(parsed.model).toBe("claude-haiku-5-5");
    expect(parsed.max_tokens).toBe(6000);
    expect(sent).not.toContain(h.key);
    for (const row of f.rows.slice(1, 60)) for (const cell of row) if (cell.length >= 4) expect(sent.includes(cell), cell).toBe(false);
    expect(r.text).not.toContain(h.key);
    expect(logs.join("\n")).not.toContain(h.key);
    const audit = h.model.extra.admin_audit_log as any[];
    expect(audit.map((a) => a.target_id).sort()).toEqual(["attempt", "usage"]);
    expect(JSON.stringify(audit)).not.toMatch(/كهروميكانيكا|xlsx|user[EPCR]\d/);
    expect(audit.find((a) => a.target_id === "attempt").details).toMatchObject({ files: 1 });
  });

  it("30 an hour through the route: the 31st is a 429 with no model call; another admin has their own allowance", async () => {
    for (let i = 0; i < AGENT_MAX_CALLS_PER_HOUR; i++) expect((await post({})).status).toBe(200);
    expect(h.fetchCalls).toHaveLength(30);
    const blocked = await post({});
    expect(blocked.status).toBe(429);
    expect(JSON.parse(blocked.text).error).toMatch(/٣٠ رسالة/);
    expect(h.fetchCalls).toHaveLength(30);
    expect((await post({}, { ...admin, id: "22222222-2222-4222-8222-222222222222" })).status).toBe(200);
  });

  it("5 files and 10 MB each: 6 files and an 11 MB file are refused before anything is read or sent", async () => {
    const small = { name: "a.csv", bytes: new TextEncoder().encode("الشركة\nأ") };
    expect((await post({ files: Array.from({ length: 6 }, () => small) })).status).toBe(400);
    expect((await post({ files: [{ name: "big.csv", bytes: new Uint8Array(10 * 1024 * 1024 + 1).fill(97) }] })).status).toBe(400);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.model.extra.admin_audit_log ?? []).toHaveLength(0);
  });

  it("a missing key is a plain 503 and nothing is sent; a provider error is a 502 with no provider text", async () => {
    h.key = "";
    expect((await post({})).status).toBe(503);
    expect(h.fetchCalls).toHaveLength(0);
    h.key = "sk-ant-TEST-SECRET-KEY-do-not-leak"; h.status = 500;
    const r = await post({});
    expect(r.status).toBe(502);
    expect(r.text).not.toMatch(/anthropic|sk-ant/i);
  });
});
