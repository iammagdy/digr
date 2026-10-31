import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyActions, draftSummary } from "../src/lib/invoices/chat/apply";
import { approxActions, importActions } from "../src/lib/invoices/chat/proposal";
import { emptyForm, type DocForm } from "../src/lib/invoices/form";
import { buildSheetModel } from "../src/lib/invoices/sheetModel";
import type { ItemTypeLite } from "../src/lib/invoices/sectors";
import type { CountResult } from "../src/lib/invoices/chat/types";
import type { DocView } from "../src/lib/invoices/types";

const panel = readFileSync("src/components/admin/invoices/InvoiceChatPanel.tsx", "utf8");
const builder = readFileSync("src/components/admin/invoices/InvoiceBuilder.tsx", "utf8");
const T = (n: number, nameAr: string, unitCc: number): ItemTypeLite => ({ id: `00000000-0000-4000-8000-00000000000${n}`, nameAr, unitCc });
const TYPES = [T(1, "شركة", 1200), T(2, "مدير", 3500), T(3, "بريد إلكتروني", 45), T(4, "رقم هاتف", 500)];
const CTX = { types: TYPES, creditValueE4: 1000, canChangeDocType: true };
const blank = (): DocForm => ({ ...emptyForm("invoice", "2026-10-31", { rateE4: null, payment: "" }), showUsd: true, showPoints: false, showEgp: false });

describe("what the files become: set_counts actions from the code's counts (the DEFAULT billing; the conversation in flow.ts builds the owner's choice)", () => {
  const sc = (sector: string, companies: number, managers: number, departments: number, emails = 0, phones = 0) => ({ sector, companies, managers, departments, emails, phones, duplicateCompanies: 0, duplicateContacts: 0, invalidEmails: 0, ignoredPhones: 0, contacts: [] });
  const count: CountResult = { sectors: [sc("كهروميكانيكا", 200, 601, 0, 601, 140), sc("فارغ", 0, 0, 0), sc("بترول", 149, 239, 32, 300, 95)], sheets: [], notes: [], duplicateCompanies: 0 };
  it("one set_counts per sector with companies, people and departments; e-mails and phones are information, never items; an empty sector adds nothing", () => {
    expect(importActions(count)).toEqual([
      { type: "set_counts", sector: "كهروميكانيكا", counts: { company: 200, manager: 601 } },
      { type: "set_counts", sector: "بترول", counts: { company: 149, manager: 239, department: 32 } },
    ]);
  });

  it("importing twice REPLACES the numbers (it never doubles them) and totals come from the money library", () => {
    const once = applyActions(blank(), importActions(count), CTX, new Map());
    const twice = applyActions(once.form, importActions(count), CTX, new Map());
    expect(twice.after.usd).toBe(once.after.usd);
    // 200 x 12c + 601 x 35c + 149 x 12c + 239 x 35c, the departments at 0
    expect(once.after.usd).toBe(2400 + 21035 + 1788 + 8365);
    expect(twice.form.batches).toHaveLength(2);
  });
});

describe("picture numbers are approximate and never overwrite a number that is already there", () => {
  const rows = [{ sector: "مقاولات", itemType: "company" as const, quantity: "42" }, { sector: "مقاولات", itemType: "manager" as const, quantity: "30" }, { sector: "جديد", itemType: "email" as const, quantity: "٧" }, { sector: "جديد", itemType: "phone" as const, quantity: "abc" }];

  it("into an EMPTY draft every number becomes an action (edited text is read, Arabic digits too, junk is ignored)", () => {
    const { actions, skipped } = approxActions(rows, blank(), TYPES);
    expect(skipped).toEqual([]);
    expect(actions).toEqual([{ type: "set_counts", sector: "مقاولات", counts: { company: 42, manager: 30 } }, { type: "set_counts", sector: "جديد", counts: { email: 7 } }]);
  });

  it("a cell that already holds a number (from a file or typed by the owner) is skipped and the owner is told; an empty cell of the same sector still fills", () => {
    const f = applyActions(blank(), [{ type: "set_counts", sector: "مقاولات", counts: { company: 120 } }], CTX, new Map()).form;
    const { actions, skipped } = approxActions(rows, f, TYPES);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("فيها رقم");
    expect(skipped[0]).toContain("١٢٠");
    expect(actions[0]).toEqual({ type: "set_counts", sector: "مقاولات", counts: { manager: 30 } });
    const after = applyActions(f, actions, CTX, new Map());
    expect(after.form.lines.find((l) => l.itemTypeName === "شركة")?.qty).toBe("120"); // the file's number is untouched
  });
});

describe("the chat panel: collapsible, phone-first, and it can only do what the actions allow", () => {
  it("is in the builder, open for a new document, with a toggle, a log, an input, an attach button and example requests", () => {
    expect(builder).toContain("<InvoiceChatPanel");
    expect(builder).toMatch(/useState\(!loaded\)/);
    for (const id of ["agent-panel", "agent-toggle", "agent-log", "agent-input", "agent-send", "agent-attach", "agent-file-input", "agent-confirm", "agent-cancel", "agent-undo", "agent-approx-badge", "agent-before-after"]) expect(panel, id).toContain(`data-testid="${id}"`);
    expect(panel).toContain("aria-expanded={p.open}");
    expect(panel).toContain('role="log"');
    expect(panel).toContain("تقريبي");
    expect(panel).toContain('accept={ACCEPT}');
    expect(panel).toContain('".xlsx,.csv,.png,.jpg,.jpeg"');
  });

  it("talks to ONE route only; it never saves a document, never changes a status, never sends an invoice", () => {
    const urls = [...panel.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
    expect(urls).toEqual(["/api/admin/invoices/agent"]);
    expect(panel).not.toMatch(/\/status|\/convert|\/duplicate|method: "PUT"|method: "DELETE"|"mark-paid"|changeStatus|onSave|askSend/);
    expect(panel).not.toMatch(/api\.anthropic\.com|x-api-key|ANTHROPIC|sk-ant|providerKeys/i);
    expect(panel).not.toMatch(/localStorage|sessionStorage|indexedDB/); // the chat and the files live in memory only
  });

  it("a money-changing proposal waits for «تمام»; the draft is only changed through the one executor and can be undone", () => {
    expect(panel).toContain("needsConfirm(");
    expect(panel).toContain("applyActions(");
    expect(panel).toMatch(/const mustConfirm = pr\.imageRows\.length > 0 \|\| needsConfirm\(/);
    expect(panel).toContain("doUndo");
    expect(panel).toContain("p.onPhaseSummary(undo[at].phase)");
  });

  it("the count separator is the Arabic comma (the middle dot looks like the Arabic zero in this font); no emoji", () => {
    expect(panel).not.toContain("·");
    for (const src of [panel, builder]) expect(src).not.toMatch(/(?![©®™])\p{Extended_Pictographic}/u);
  });

  it("the page fit uses the real measurement: only a plan that belongs to the CURRENT model is trusted, and it is capped", () => {
    expect(builder).toContain("shownModel !== model || !x.settled");
    expect(builder).toContain("fit.steps < 60");
    expect(builder).toContain("nextFitStep(form)");
  });

  it("the older «رتّبهالي» box moved under «خيارات إضافية» (one AI box at the top, not two)", () => {
    const more = builder.indexOf('data-testid="more-options"');
    expect(builder.indexOf('data-testid="assist-section"')).toBeGreaterThan(more);
    expect(builder.indexOf("<InvoiceChatPanel")).toBeLessThan(builder.indexOf('data-testid="sectors-section"'));
  });
});

describe("the sector summary table is a display option, never stored", () => {
  const seller = { name: "ديجر", email: "support@diger.tech", website: "diger.tech", taxNumber: "", commercialRegister: "" };
  const doc = (): DocView => ({
    id: "x", docType: "invoice", number: "INV-2026-0001", status: "draft", revision: 1,
    client: { id: null, company: "ش", contact: "", email: "", phone: "", address: "" }, issueDate: "2026-10-31", dueDate: null, show: { usd: true, points: false, egp: false }, rateE4: null, creditValueE4: 1000,
    discountKind: "none", discountValue: 0, taxEnabled: false, taxLabel: "ضريبة", taxBp: 0, notes: "", paymentInstructions: "", instapayAddress: "", showInstapayQr: false, paidAt: null, paymentReference: "", convertedFromId: null, duplicatedFromId: null, lockedAt: null,
    batches: [{ key: "b1", title: "بترول", summaryOnly: false }], lines: [{ key: "l", batchKey: "b1", itemTypeId: null, itemTypeName: "شركة", description: "", quantity: 10, unitCc: 1200, hidden: false }], frozen: null,
  });
  it("shown by default (as before), hidden only when asked, and the totals do not change either way", () => {
    const on = buildSheetModel(doc(), seller);
    const off = buildSheetModel(doc(), seller, undefined, { phaseSummary: false });
    expect(on.groupSummary).not.toBeNull();
    expect(off.groupSummary).toBeNull();
    expect(off.totalRows).toEqual(on.totalRows);
    expect(buildSheetModel(doc(), seller, undefined, { phaseSummary: true }).groupSummary).not.toBeNull();
  });
});

describe("adminFetch lets a file upload set its own multipart header", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock("../src/lib/supabase/client"); });
  it("a FormData body gets no JSON Content-Type; a JSON body still does", async () => {
    vi.doMock("../src/lib/supabase/client", () => ({ createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } }) }));
    const calls: Array<{ headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => { calls.push(init); return new Response("{}", { status: 200 }); }));
    const { adminFetch } = await import("../src/lib/adminApi");
    await adminFetch("/x", { method: "POST", body: new FormData() });
    await adminFetch("/y", { method: "POST", body: "{}" });
    expect(calls[0].headers["Content-Type"]).toBeUndefined();
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(calls[1].headers["Content-Type"]).toBe("application/json");
  });
});

describe("the agent's code lives where the isolation tests can see it, and logs nothing", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
  it("no console call and no file write anywhere in the chat code, the runner or the route; no stored file", () => {
    for (const f of [...walk("src/lib/invoices/chat"), ...walk("src/lib/server/invoices/chat"), "src/app/api/admin/invoices/agent/route.ts", "src/components/admin/invoices/InvoiceChatPanel.tsx"]) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/console\.(log|info|warn|error|debug)|writeFile|createWriteStream|\.storage\b|\.upload\(|from\("storage|appendFile/);
    }
  });

  it("the draft summary sent to the model never carries a price field name", () => {
    const f = applyActions(blank(), [{ type: "add_sector", name: "س", counts: { company: 3 } }], CTX, new Map()).form;
    expect(JSON.stringify(draftSummary(f, TYPES).summary)).not.toMatch(/price|unit|total|amount|usd":\d/);
  });
});
