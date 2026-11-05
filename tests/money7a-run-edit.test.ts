import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { editCard } from "../src/lib/agentMission/stage4/addonQuote";
import type { AddonRequest } from "../src/lib/agentMission/stage4/addonRow";
import { EDIT_NOT_SEARCHED_AR } from "../src/lib/agentMission/stage4/editVersion";
import { firstVersionFromCells, versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";
import { tregResult } from "./helpers/agentHarness";
import { runAddon, runAddonSafely } from "../agent/src/stage4/runAddon";
import { abortActiveRuns } from "../agent/src/sessions";
import { ADDON_DONE_AR } from "../agent/src/stage4/addonText";
import { checkAddonLedger } from "./helpers/addonWorld";
import { COMMENTS_SHEET, LOOKUP_COST_USD, LOOKUP_ENDPOINT, M12, VIDEOS_SHEET, addonRunWorld, nicknameAnswer, type Answers } from "./helpers/addonRunWorld";

/**
 * MONEY PR 7a, PHASE 2B-1: AN EDIT AND A REVIEW FIX ON THE WORKER (docs/MONEY-PR-7A.md sections 2, 3.2, 3.3 and 4), end to end on the stored real world of M12 with fake provider answers: the approval holds R (estimate + 15%), the worker
 * re-reads within a provider budget of R / 5,500 USD through the existing gateway, stores the new version PENDING, settles (res -R, rel +R, chg -C where C = addonChargePoints of the REAL cost and the cells that got a REAL value),
 * and only then publishes versions/v0002.json. Every scenario ends with the ledger invariant. `fetch` is stubbed to throw; the provider is a fake.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

type World = Awaited<ReturnType<typeof addonRunWorld>>;
const TOOL = { endpointId: LOOKUP_ENDPOINT, params: {}, bind: { param: "uniqueId", from: "صاحب التعليق" }, valueField: "user.nickname" };
const spent = (w: World) => w.providerRows.reduce((n, r) => n + (r.committedUsd ?? 0), 0);
const said = (w: World, id: string) => w.store.events.filter((e) => e.mission_id === id).map((e) => e.message_ar);
const versionOf = async (w: World, n: number): Promise<FileVersion> => JSON.parse((await w.store.getFile(M12, versionPathOf(n)))!);
const BALANCE = 100_000;

async function commentsEdit(w: World, over: { rowIds?: string[]; tools?: Array<typeof TOOL> } = {}) {
  const rowIds = over.rowIds ?? w.idsOf(COMMENTS_SHEET);
  const card = editCard({ kind: "edit", units: rowIds.length, tools: [{ catalogPerRowUsd: LOOKUP_COST_USD }] });
  if (!card.ok) throw new Error("no card");
  const request: AddonRequest = { kind: "edit", edit: { kind: "add_column", sheet: COMMENTS_SHEET, titleAr: "اسم القناة", rowIds, reread: { tools: over.tools ?? [TOOL] } } };
  return w.createApproved({ kind: "edit", request, pricing: card.pricing });
}
/** The charge by the formula, worked here independently of the code under test. */
const chargeBy = (real: number, filled: number, requested: number, hold: number) => Math.min(hold, Math.max(Math.ceil(Math.round(real * 1_000_000) * 5500 / 1_000_000 - 1e-9), Math.ceil((100 * filled) / requested)));

describe("an edit that adds a column to the comments of M12 (60 rows, a fake provider)", () => {
  it("res -R, rel +R, chg -C; v2 published once, v1 unchanged; the balance moved by exactly -C; every call inside the add-on's budget", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    expect(a.hold).toBeGreaterThan(300);
    expect(a.budgetUsd).toBeCloseTo(a.hold / 5500, 5);
    const v1bytes = await w.store.getFileBytes(M12, versionPathOf(1));
    await runAddonSafely(w.deps, a.row);

    const C = chargeBy(spent(w), 60, 60, a.hold);
    expect(spent(w)).toBeCloseTo(60 * LOOKUP_COST_USD, 9);
    expect(C).toBe(330);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: C })).toEqual([]);
    expect(w.money.balance()).toBe(BALANCE - C);
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "completed", charged_credits: C, reserved_credits: a.hold, unit_price: 1 });

    // every call within the add-on's own budget, none refused, each for its own comment's account
    expect(w.call).toHaveBeenCalledTimes(60);
    expect(spent(w)).toBeLessThanOrEqual(a.budgetUsd + 1e-9);
    expect(w.providerRows.every((r) => r.jobId === a.jobId)).toBe(true);
    const handles = new Set((w.call.mock.calls as Array<[{ params: Record<string, unknown> }]>).map(([o]) => String(o.params.uniqueId)));
    expect(handles.size).toBeGreaterThan(1);

    // v1 is the same bytes; v2 is published once, from the pending bytes, with the new column
    expect((await w.store.getFileBytes(M12, versionPathOf(1)))!.equals(v1bytes!)).toBe(true);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`, `${M12}/versions/v0002.json`]);
    const v2 = await versionOf(w, 2);
    const pending = await w.store.getFileBytes(M12, `addons/${a.id}/v0002.json`);
    expect((await w.store.getFileBytes(M12, versionPathOf(2)))!.equals(pending!)).toBe(true);
    expect(v2).toMatchObject({ version: 2, parent: 1, reason: "edit", missionId: M12 });
    expect(v2.digest).not.toBe(w.v1.digest);
    const sheet = v2.sheets.find((s) => s.nameAr === COMMENTS_SHEET)!;
    const at = sheet.headers.indexOf("اسم القناة");
    expect(at).toBeGreaterThan(-1);
    expect(sheet.headers.length).toBe(w.v1.sheets.find((s) => s.nameAr === COMMENTS_SHEET)!.headers.length + 1);
    expect(sheet.rows).toHaveLength(60);
    expect(sheet.rows.every((r) => /^قناة /.test(r.cells[at]))).toBe(true);
    expect(v2.sheets.filter((s) => s.nameAr !== COMMENTS_SHEET)).toEqual(w.v1.sheets.filter((s) => s.nameAr !== COMMENTS_SHEET));

    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: C, delivered_units: 60, error: null, worker_id: null, lease_until: null });
    expect(said(w, a.id)).toContain(ADDON_DONE_AR.versionDone(2, C));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the videos sheet (2 rows) works the same way, and a provider answer that holds a gap or nothing leaves «لم يكتمل البحث», not an empty cell", async () => {
    const answers: Answers = () => tregResult({ data: { user: { nickname: "" } } }, 0.001);
    const w = await addonRunWorld({ balance: BALANCE, answers });
    const rowIds = w.idsOf(VIDEOS_SHEET);
    const card = editCard({ kind: "edit", units: rowIds.length, tools: [{ catalogPerRowUsd: LOOKUP_COST_USD }] });
    if (!card.ok) throw new Error("no card");
    const a = await w.createApproved({ kind: "edit", pricing: card.pricing, request: { kind: "edit", edit: { kind: "add_column", sheet: VIDEOS_SHEET, titleAr: "اسم القناة", rowIds, reread: { tools: [{ ...TOOL, bind: { param: "uniqueId", from: "اسم المستخدم" } }] } } } });
    await runAddonSafely(w.deps, a.row);
    // both rows were searched and nothing real was found: nothing filled, the whole hold comes back, no version
    expect(w.call).toHaveBeenCalledTimes(2);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(w.money.balance()).toBe(BALANCE);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    expect([...w.store.files.keys()].filter((k) => k.includes("/addons/") && /\/v\d+\.json$/.test(k))).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "unserved", charged_points: 0, delivered_units: 0 });
    expect(said(w, a.id)).toContain(ADDON_DONE_AR.nothingFound);
  });

  it("some cells get a real value and some a stated gap: only the real ones are filled and charged for; the rest say «لم يكتمل البحث»", async () => {
    const answers: Answers = (o) => { const h = String((o.params as Record<string, unknown>).uniqueId); return tregResult({ data: { user: { nickname: h.charCodeAt(h.length - 1) % 2 === 0 ? `قناة ${h}` : "غير متوفر" } } }, LOOKUP_COST_USD); };
    const w = await addonRunWorld({ balance: BALANCE, answers });
    const a = await commentsEdit(w);
    await runAddonSafely(w.deps, a.row);
    const v2 = await versionOf(w, 2);
    const sheet = v2.sheets.find((s) => s.nameAr === COMMENTS_SHEET)!;
    const at = sheet.headers.indexOf("اسم القناة");
    const real = sheet.rows.filter((r) => /^قناة /.test(r.cells[at])).length;
    const gaps = sheet.rows.filter((r) => r.cells[at] === EDIT_NOT_SEARCHED_AR).length;
    expect(real + gaps).toBe(60);
    expect(real).toBeGreaterThan(0);
    expect(gaps).toBeGreaterThan(0);
    expect(sheet.rows.some((r) => r.cells[at].trim() === "غير متوفر")).toBe(false);
    const C = chargeBy(spent(w), real, 60, a.hold);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: C })).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", delivered_units: real, charged_points: C });
    expect(said(w, a.id)).toContain(ADDON_DONE_AR.versionPartial(2, C));
  });

  it("a tool that fails or answers nothing hands the unit to the next tool of the chain", async () => {
    const answers: Answers = (o) => (o.endpointId === LOOKUP_ENDPOINT ? tregResult({ error: "x" }, 0.001, { ok: false, httpStatus: 500 }) : tregResult({ data: { user: { nickname: "قناة بديلة" } } }, 0.001));
    const w = await addonRunWorld({ balance: BALANCE, answers });
    const second = { endpointId: "tikhub.tiktok.search.videos", params: {}, bind: { param: "keyword", from: "صاحب التعليق" }, valueField: "user.nickname" };
    const rowIds = w.idsOf(COMMENTS_SHEET).slice(0, 5);
    const card = editCard({ kind: "edit", units: 5, tools: [{ catalogPerRowUsd: 0.001 }, { catalogPerRowUsd: 0.001 }] });
    if (!card.ok) throw new Error("no card");
    const a = await w.createApproved({ kind: "edit", pricing: card.pricing, request: { kind: "edit", edit: { kind: "add_column", sheet: COMMENTS_SHEET, titleAr: "اسم القناة", rowIds, reread: { tools: [TOOL, second] } } } });
    await runAddonSafely(w.deps, a.row);
    expect(w.call).toHaveBeenCalledTimes(10);
    const v2 = await versionOf(w, 2);
    const sheet = v2.sheets.find((s) => s.nameAr === COMMENTS_SHEET)!;
    const at = sheet.headers.indexOf("اسم القناة");
    expect(sheet.rows.filter((r) => r.cells[at] === "قناة بديلة")).toHaveLength(5);
    expect(sheet.rows.filter((r) => r.cells[at] === EDIT_NOT_SEARCHED_AR)).toHaveLength(55);
    const C = chargeBy(spent(w), 5, 5, a.hold);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: C })).toEqual([]);
  });
});

describe("edits with no provider call still pay the 100-point minimum (decision D12): no free path", () => {
  const cases: Array<[string, (w: World) => AddonRequest, number]> = [
    ["a rename", () => ({ kind: "edit", edit: { kind: "rename_column", sheet: COMMENTS_SHEET, from: "نص التعليق", to: "محتوى التعليق" } }), 1],
    ["cells the customer typed", (w) => ({ kind: "edit", edit: { kind: "set_cells", sheet: COMMENTS_SHEET, cells: w.idsOf(COMMENTS_SHEET).slice(0, 3).map((rowId) => ({ rowId, column: "نص التعليق", value: "نص كتبه العميل" })) } }), 3],
  ];
  for (const [name, request, units] of cases) {
    it(name, async () => {
      const w = await addonRunWorld({ balance: BALANCE });
      const card = editCard({ kind: "edit", units, tools: [] });
      if (!card.ok) throw new Error("no card");
      const a = await w.createApproved({ kind: "edit", request: request(w), pricing: card.pricing });
      expect(a.hold).toBe(100);
      await runAddonSafely(w.deps, a.row);
      expect(w.call).not.toHaveBeenCalled();
      expect(checkAddonLedger(w.money, a.jobId, { reserved: 100, charged: 100 })).toEqual([]);
      expect(w.money.balance()).toBe(BALANCE - 100);
      expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`, `${M12}/versions/v0002.json`]);
      expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: 100 });
    });
  }
  it("the new version holds the rename, and the typed cells, as the customer asked", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const card = editCard({ kind: "edit", units: 1, tools: [] });
    if (!card.ok) throw new Error("no card");
    const a = await w.createApproved({ kind: "edit", pricing: card.pricing, request: { kind: "edit", edit: { kind: "rename_column", sheet: COMMENTS_SHEET, from: "نص التعليق", to: "محتوى التعليق" } } });
    await runAddonSafely(w.deps, a.row);
    const sheet = (await versionOf(w, 2)).sheets.find((s) => s.nameAr === COMMENTS_SHEET)!;
    expect(sheet.headers).toContain("محتوى التعليق");
    expect(sheet.headers).not.toContain("نص التعليق");
  });
  it("a request the file cannot carry out (an unknown column) fills nothing: the hold comes back whole, no version", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const card = editCard({ kind: "edit", units: 1, tools: [] });
    if (!card.ok) throw new Error("no card");
    const a = await w.createApproved({ kind: "edit", pricing: card.pricing, request: { kind: "edit", edit: { kind: "rename_column", sheet: COMMENTS_SHEET, from: "عمود غير موجود", to: "جديد" } } });
    await runAddonSafely(w.deps, a.row);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: 100, charged: "none" })).toEqual([]);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    expect(said(w, a.id)).toContain(ADDON_DONE_AR.nothingFound);
  });
});

describe("the provider's daily cap", () => {
  it("stops the re-read half way: a partial charge on the cells that were filled, «لم يكتمل البحث» in the rest, the Arabic text said", async () => {
    const w = await addonRunWorld({ balance: BALANCE, dailyCapUsd: 0.0305 });
    const a = await commentsEdit(w);
    await runAddonSafely(w.deps, a.row);
    expect(w.call).toHaveBeenCalledTimes(30);
    expect(w.providerRows).toHaveLength(30);
    const C = chargeBy(spent(w), 30, 60, a.hold);
    expect(C).toBe(165);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: C })).toEqual([]);
    const sheet = (await versionOf(w, 2)).sheets.find((s) => s.nameAr === COMMENTS_SHEET)!;
    const at = sheet.headers.indexOf("اسم القناة");
    expect(sheet.rows.filter((r) => /^قناة /.test(r.cells[at]))).toHaveLength(30);
    expect(sheet.rows.filter((r) => r.cells[at] === EDIT_NOT_SEARCHED_AR)).toHaveLength(30);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", delivered_units: 30, charged_points: C });
    const lines = said(w, a.id);
    expect(lines).toEqual(expect.arrayContaining([ADDON_DONE_AR.dailyCap, ADDON_DONE_AR.versionPartial(2, C)]));
    // the refused call is recorded as refused and cost nothing
    expect([...w.store.calls].filter((c) => c.mission_id === a.id && c.status === "refused").length).toBeGreaterThanOrEqual(1);
  });
  it("a cap of 0 gives nothing filled: res and rel only, no version, no pending version, the cap sentence and the nothing-found sentence", async () => {
    const w = await addonRunWorld({ balance: BALANCE, dailyCapUsd: 0 });
    const a = await commentsEdit(w);
    await runAddonSafely(w.deps, a.row);
    expect(w.call).not.toHaveBeenCalled();
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(w.money.balance()).toBe(BALANCE);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    expect([...w.store.files.keys()].filter((k) => /\/addons\/[^/]+\/v\d+\.json$/.test(k))).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "unserved", charged_points: 0, delivered_units: 0 });
    expect(said(w, a.id)).toEqual(expect.arrayContaining([ADDON_DONE_AR.dailyCap, ADDON_DONE_AR.nothingFound]));
  });
});

describe("a provider that charges MORE than its estimate", () => {
  it("double (and a thousand times): the re-read stops at the add-on's budget, the charge is never above the hold, the ledger is balanced", async () => {
    for (const factor of [2, 1000]) {
      const w = await addonRunWorld({ balance: BALANCE, answers: nicknameAnswer(LOOKUP_COST_USD * factor) });
      const a = await commentsEdit(w);
      await runAddonSafely(w.deps, a.row);
      const row = w.money.jobs.get(a.jobId)!;
      expect(row.charged_credits).toBeLessThanOrEqual(a.hold);
      expect(w.call.mock.calls.length).toBeLessThan(60);
      // the overshoot of the last call is the platform's: the charge is clipped at the hold
      expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: row.charged_credits! })).toEqual([]);
      expect(row.charged_credits).toBe(a.hold);
    }
  });
});

describe("a review fix corrects EVERY cell of its issue, not the first 20", () => {
  const sheetOf = (n: number) => ({ "ورقة": [["الاسم", "الإيميل", "المعرّف"], ...Array.from({ length: n }, (_, i) => [`شركة ${i + 1}`, "", `r${i + 1}`])] });
  const base = firstVersionFromCells({ missionId: M12, cells: sheetOf(30), createdAt: "2026-11-04T09:00:00.000Z" });
  const mail: Answers = (o) => { const n = Number(String((o.params as Record<string, unknown>).keyword).replace(/\D/g, "")); return tregResult({ data: { email: n <= 25 ? `info${n}@example.com` : "" } }, LOOKUP_COST_USD); };
  const recipe = { tools: [{ endpointId: "tikhub.tiktok.search.videos", params: {}, bind: { param: "keyword", from: "الاسم" }, valueField: "email" }] };

  it("30 empty e-mails: 30 are asked (never 20), 25 are filled, 5 say «لم يكتمل البحث»; the version is a review_fix; charged like an edit", async () => {
    const w = await addonRunWorld({ balance: BALANCE, version: base, answers: mail });
    const card = editCard({ kind: "review_fix", units: 30, tools: [{ catalogPerRowUsd: LOOKUP_COST_USD }] });
    if (!card.ok) throw new Error("no card");
    const a = await w.createApproved({ kind: "review_fix", pricing: card.pricing, request: { kind: "review_fix", issue: { code: "empty_cells", sheet: "ورقة", column: "الإيميل" }, reread: recipe } });
    await runAddonSafely(w.deps, a.row);
    expect(w.call).toHaveBeenCalledTimes(30);
    const v2 = await versionOf(w, 2);
    expect(v2).toMatchObject({ version: 2, parent: 1, reason: "review_fix" });
    const cells = v2.sheets[0].rows.map((r) => r.cells[1]);
    expect(cells.filter((c) => /@example\.com$/.test(c))).toHaveLength(25);
    expect(cells.filter((c) => c === EDIT_NOT_SEARCHED_AR)).toHaveLength(5);
    expect(cells.filter((c) => c === "")).toHaveLength(0);
    const C = chargeBy(spent(w), 25, 30, a.hold);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: C })).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", delivered_units: 25 });
    expect(w.money.jobs.get(a.jobId)!.endpoint_id).toBe("agent-fix");
  });
  it("duplicates are never fixed (rows are never removed): the hold comes back whole", async () => {
    const dup = firstVersionFromCells({ missionId: M12, cells: { "ورقة": [["الاسم", "المعرّف"], ["س", "r1"], ["س", "r2"]] }, createdAt: "2026-11-04T09:00:00.000Z" });
    const w = await addonRunWorld({ balance: BALANCE, version: dup });
    const card = editCard({ kind: "review_fix", units: 1, tools: [] });
    if (!card.ok) throw new Error("no card");
    const a = await w.createApproved({ kind: "review_fix", pricing: card.pricing, request: { kind: "review_fix", issue: { code: "exact_duplicate", sheet: "ورقة", column: "ورقة" } } });
    await runAddonSafely(w.deps, a.row);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
  });
});

describe("the zombie case: another object already holds the version's path", () => {
  it("before the run: nothing is spent, the hold comes back whole, the other object is never overwritten, the admin is told", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    await w.store.putNew(M12, versionPathOf(2), "{\"zombie\":true}", "application/json");
    const a = await commentsEdit(w);
    await runAddonSafely(w.deps, a.row);
    expect(w.call).not.toHaveBeenCalled();
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(await w.store.getFile(M12, versionPathOf(2))).toBe("{\"zombie\":true}");
    expect(w.rowOf(a.id)).toMatchObject({ status: "unserved", charged_points: 0 });
    expect(said(w, a.id)).toContain(ADDON_DONE_AR.versionExists);
    expect(w.store.events.some((e) => e.mission_id === a.id && e.message_ar.startsWith("علامة داخلية للمشرف"))).toBe(true);
  });
  it("during the run (it appears after the work is stored): released, no charge, nothing overwritten, the pending version is never published", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const put = w.store.putNewStrict.bind(w.store);
    w.store.putNewStrict = async (m, p, c, t) => { if (p.endsWith("outcome.json")) await w.store.putNew(M12, versionPathOf(2), "{\"zombie\":true}", "application/json"); return put(m, p, c, t); };
    await runAddonSafely(w.deps, a.row);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(await w.store.getFile(M12, versionPathOf(2))).toBe("{\"zombie\":true}");
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`, `${M12}/versions/v0002.json`]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "unserved", charged_points: 0, error: "version_exists" });
    expect(said(w, a.id)).toContain(ADDON_DONE_AR.versionExists);
  });
});

describe("the worker is killed (a throw out of runAddon, as a dead process): a second run resumes and the ledger stays balanced", () => {
  /** The invariant at the end: one res, one rel, one chg, v2 published exactly once, the budget kept. */
  async function finishAndCheck(w: World, a: Awaited<ReturnType<typeof commentsEdit>>, expectCharge?: number) {
    w.expireLease(a.id);
    const again = await w.reclaim();
    await runAddonSafely(w.deps, again);
    const C = expectCharge ?? chargeBy(spent(w), 60, 60, a.hold);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: C })).toEqual([]);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`, `${M12}/versions/v0002.json`]);
    const pending = await w.store.getFileBytes(M12, `addons/${a.id}/v0002.json`);
    expect((await w.store.getFileBytes(M12, versionPathOf(2)))!.equals(pending!)).toBe(true);
    expect(spent(w)).toBeLessThanOrEqual(a.budgetUsd + 0.002 + 1e-9);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: C });
  }

  it("after the hold, before anything ran", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve"]);
    await finishAndCheck(w, a);
    expect(w.call).toHaveBeenCalledTimes(60);
  });
  it("after the first provider call: the units already finished are not paid for again", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    let writes = 0;
    const put = w.store.putNew.bind(w.store);
    w.store.putNew = async (m, p, c, t) => { if (p.includes("/rows/") && ++writes === 4) throw new Error("the worker died"); return put(m, p, c, t); };
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("the worker died");
    expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve"]);
    const before = w.call.mock.calls.length;
    expect(before).toBe(4);
    w.store.putNew = put;
    await finishAndCheck(w, a, chargeBy(61 * LOOKUP_COST_USD, 60, 60, a.hold));
    // 3 finished units were kept; the unit that was cut is read again: 60 + 1 calls in all, never more
    expect(w.call).toHaveBeenCalledTimes(61);
  });
  it("after the work is stored pending (before the outcome)", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const put = w.store.putNewStrict.bind(w.store);
    w.store.putNewStrict = async (m, p, c, t) => { if (p.endsWith("outcome.json")) throw new Error("the worker died"); return put(m, p, c, t); };
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("the worker died");
    expect(await w.store.getFile(M12, `addons/${a.id}/v0002.json`)).not.toBeNull();
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve"]);
    w.store.putNewStrict = put;
    await finishAndCheck(w, a);
    expect(w.call).toHaveBeenCalledTimes(60);
  });
  it("after the outcome, before the settlement", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    w.money.inject("settle_job_atomic", "before");
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("before it ran");
    expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve"]);
    await finishAndCheck(w, a);
    expect(w.call).toHaveBeenCalledTimes(60);
  });
  it("after the charge, before publishing: the retry only publishes (no second charge, no second re-read)", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const put = w.store.putNewStrict.bind(w.store);
    w.store.putNewStrict = async (m, p, c, t) => { if (p.startsWith("versions/")) throw new Error("the worker died"); return put(m, p, c, t); };
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("the worker died");
    expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve", "release", "charge"]);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    w.store.putNewStrict = put;
    const rows = JSON.stringify(w.money.ledger);
    await finishAndCheck(w, a);
    expect(JSON.stringify(w.money.ledger)).toBe(rows);
    expect(w.call).toHaveBeenCalledTimes(60);
  });
  it("after the charge, the answer of the settlement is lost: the retry finds it settled and charges nothing more", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    w.money.inject("settle_job_atomic", "after");
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("was lost");
    expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve", "release", "charge"]);
    await finishAndCheck(w, a);
  });
});

describe("the watchdog released the hold first: no charge and no publish", () => {
  const watchdog = (w: World, jobId: string) => w.money.client.rpc("release_job_atomic", { p_job_id: jobId, p_error_message: "x", p_force: true });
  it("before the run: nothing is spent, nothing is published, the row ends failed with the sentence of a released hold", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    await watchdog(w, a.jobId);
    await runAddonSafely(w.deps, a.row);
    expect(w.call).not.toHaveBeenCalled();
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "failed", charged_points: 0 });
    expect(said(w, a.id)).toContain(ADDON_DONE_AR.releasedEarlier);
  });
  it("after the work was stored (the settlement was cut): the pending version is never published", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    w.money.inject("settle_job_atomic", "before");
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("before it ran");
    await watchdog(w, a.jobId);
    w.expireLease(a.id);
    await runAddonSafely(w.deps, await w.reclaim());
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    expect(await w.store.getFile(M12, `addons/${a.id}/v0002.json`)).not.toBeNull();
    expect(w.rowOf(a.id)).toMatchObject({ status: "failed", charged_points: 0 });
  });
});

describe("the platform stops the run (a deploy, or the memory limit): the row goes back to «approved» with everything it saved", () => {
  for (const cause of ["restart", "memory"] as const) {
    it(`${cause}: the finished units are kept, the hold stands, the next worker finishes it without paying twice`, async () => {
      let calls = 0;
      const base = nicknameAnswer();
      const w = await addonRunWorld({ balance: BALANCE, answers: (o) => { calls += 1; if (calls === 3) abortActiveRuns(cause); return base(o); } });
      const a = await commentsEdit(w);
      await runAddonSafely(w.deps, a.row);
      expect(w.rowOf(a.id)).toMatchObject({ status: "approved", worker_id: null, lease_until: null });
      expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve"]);
      expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
      expect(said(w, a.id)).toContain(ADDON_DONE_AR.requeued);
      const again = await w.store.claimMission("worker-2", 120);
      await runAddonSafely(w.deps, again!);
      // 3 units were finished before the stop: 57 are read now, 60 calls in all
      expect(w.call).toHaveBeenCalledTimes(60);
      expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: chargeBy(spent(w), 60, 60, a.hold) })).toEqual([]);
      expect(w.rowOf(a.id)).toMatchObject({ status: "completed", delivered_units: 60 });
    });
  }
});

describe("the worker runs an approved add-on whatever the Stage 4 flags say (they gate creation and approval, so a hold is never stranded)", () => {
  for (const value of ["off", "test", "on", ""]) {
    it(`DIGER_STAGE4_EDITS and DIGER_STAGE4_REVIEW = «${value}»`, async () => {
      vi.stubEnv("DIGER_STAGE4_EDITS", value);
      vi.stubEnv("DIGER_STAGE4_REVIEW", value);
      vi.stubEnv("DIGER_STAGE4_VERSIONS", value);
      try {
        const w = await addonRunWorld({ balance: BALANCE });
        const a = await commentsEdit(w);
        await runAddonSafely(w.deps, a.row);
        expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 330 })).toEqual([]);
        expect(w.rowOf(a.id).status).toBe("completed");
      } finally { vi.unstubAllEnvs(); }
    });
  }
});

describe("the runner never throws to the worker loop", () => {
  it("a store that fails: the row goes back to «approved» (counted); after the requeues are used up the hold is released whole", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    w.store.listCalls = async () => { throw new Error("the database is down"); };
    await expect(runAddonSafely(w.deps, a.row)).resolves.toBeUndefined();
    expect(w.rowOf(a.id)).toMatchObject({ status: "approved", worker_id: null, lease_until: null });
    expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve"]);
    for (let i = 0; i < 2; i += 1) { const again = await w.store.claimMission("worker-3", 120); await expect(runAddonSafely(w.deps, again!)).resolves.toBeUndefined(); }
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "failed", charged_points: 0 });
    expect(w.call).not.toHaveBeenCalled();
    expect(w.money.balance()).toBe(BALANCE);
  });
  it("a plan that is not what the code computes (a tampered hold) is released whole and nothing is run", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    (w.rowOf(a.id).plan as any).addon.pricing.costPerRowUsd = 0.05;
    await runAddonSafely(w.deps, w.rowOf(a.id));
    expect(w.call).not.toHaveBeenCalled();
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "failed" });
    expect(said(w, a.id)).toContain(ADDON_DONE_AR.planMismatch);
  });
});

describe("every sentence the runner says passes the customer-text check, and every event kept its own text", () => {
  it("the fixed sentences", () => {
    const fixed = Object.values(ADDON_DONE_AR).map((v) => (typeof v === "function" ? (v as (a: number, b: number) => string)(2, 330) : v));
    for (const s of fixed) { expect(checkCustomerText(s).issues).toEqual([]); expect(s).not.toMatch(/[0-9]/); expect(s).not.toMatch(/\p{Extended_Pictographic}/u); expect(s).not.toMatch(/USD|دولار|apify|treg|tikhub/i); }
  });
  it("a whole run: no event text was replaced by the guard's fallback line", async () => {
    const w = await addonRunWorld({ balance: BALANCE, dailyCapUsd: 0.0305 });
    const a = await commentsEdit(w);
    await runAddonSafely(w.deps, a.row);
    const results = w.store.events.filter((e) => e.mission_id === a.id && e.kind === "result").map((e) => e.message_ar);
    expect(results.length).toBeGreaterThan(0);
    for (const line of results) expect(Object.values(ADDON_DONE_AR).some((v) => typeof v === "string" && v === line) || /^(أُنشئت|توقّف)/.test(line)).toBe(true);
  });
});
