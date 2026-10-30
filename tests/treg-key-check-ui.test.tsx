import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KeyCheckResult, TregKeyPool, lastOkLine, statusView } from "../src/components/admin/TregKeyPool";
import type { PoolKeyView, PoolOverview, PublicKeyCheckReport } from "../src/lib/server/tregPoolAdmin";

/**
 * What the admin sees: «متصل» alone never hides a dead key (the incident of 2026-10-30), the last answered data call is on every row, each pool key has «افحص الآن», and the
 * checker box takes a pasted key and clears it the moment it is sent.
 */
const NOW = new Date("2026-10-30T16:30:00Z").getTime();
// the component's «منذ …» reads Date.now(): pinned, so no assertion here depends on the real clock
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const key = (over: Partial<PoolKeyView> & { number: number }): PoolKeyView => ({
  id: `id-${over.number}`, label: `اختبار-${over.number}`, isMain: false, inChain: true, chainPosition: over.number, isActive: false, last4: `k${over.number}x${over.number}`, accountEmail: `k${over.number}@example.test`,
  status: "connected", statusReason: null, statusCheckedAt: ago(120_000), balanceUsd: 0.91, balanceCheckedAt: null, spend: { calls: 0, usd: 0, todayUsd: 0, lastCallAt: null }, ...over,
});
const overview = (keys: PoolKeyView[], over: Partial<PoolOverview> = {}): PoolOverview => ({
  ready: true, rolloutOn: true, generation: 0, minBalanceUsd: 0.01, lastHealthRunAt: null, events: [], legacy: { source: "env", last4: "Az7w" }, workerEnvLast4: null, workerSeenAt: null, workerMismatch: false, noticesAr: [],
  keys, activeKeyId: keys.find((k) => k.isActive)?.id ?? null, callHealthReady: true, ...over,
});
const html = (ov: PoolOverview) => renderToStaticMarkup(createElement(TregKeyPool, { initial: ov }));
const row = (h: string, n: number) => h.split(`data-testid="pool-row-${n}"`)[1].split("</tr>")[0];

describe("the status cell never hides a dead key", () => {
  it("a revoked key whose reason is an account refusal reads «الحساب موقوف»; a 403 streak reads «يرفض المزود طلباته»", () => {
    expect(statusView({ status: "revoked", statusReason: "org_suspended", deadWarning: false })).toEqual({ text: "الحساب موقوف", tone: "bad" });
    expect(statusView({ status: "revoked", statusReason: "account_disabled" }).text).toBe("الحساب موقوف");
    expect(statusView({ status: "revoked", statusReason: "auth_403_repeated" }).text).toBe("يرفض المزود طلباته");
    expect(statusView({ status: "revoked", statusReason: "auth_401" }).text).toBe("ملغى");
  });
  it("«connected» with calls failing since the last answered one reads «لا يرد على الطلبات» in the bad colour", () => {
    expect(statusView({ status: "connected", statusReason: null, deadWarning: true })).toEqual({ text: "لا يرد على الطلبات", tone: "bad" });
    expect(statusView({ status: "unknown", statusReason: null, deadWarning: true }).text).toBe("لا يرد على الطلبات");
    expect(statusView({ status: "connected", statusReason: null, deadWarning: false })).toEqual({ text: "متصل", tone: "ok" });
    expect(statusView({ status: "out_of_balance", statusReason: "http_402" }).text).toBe("الرصيد خلص");
  });
  it("the live key #2 as the table would have shown it: «متصل» by the free reads, 24 failed calls since 01:09", () => {
    const h = html(overview([
      key({ number: 5, isMain: true, label: "الرئيسي", chainPosition: 9, balanceUsd: 7.23 }),
      key({ number: 2, isActive: true, callHealth: { lastOkAt: ago(15 * 3_600_000), lastFailedAt: ago(60_000), failedSinceOk: 24 }, deadWarning: true }),
    ]));
    const r = row(h, 2);
    expect(r).toContain("لا يرد على الطلبات");
    expect(r).not.toContain(">متصل<");
    expect(r).toContain("فشل ٢٤ بعده");
  });
});

describe("«آخر طلب ناجح» on every row", () => {
  it("is the time of the last answered call with the failures after it", () => {
    expect(lastOkLine({ callHealth: { lastOkAt: ago(3 * 3_600_000), lastFailedAt: null, failedSinceOk: 0 } }, true)).toContain("آخر طلب ناجح: منذ ٣ ساعات");
    expect(lastOkLine({ callHealth: { lastOkAt: ago(15 * 3_600_000), lastFailedAt: null, failedSinceOk: 24 } }, true)).toContain("فشل ٢٤ بعده");
  });
  it("says so when the key never answered, made no call, or the SQL for the figure is not applied", () => {
    expect(lastOkLine({ callHealth: { lastOkAt: null, lastFailedAt: ago(1000), failedSinceOk: 5 } }, true)).toBe("لا طلب ناجح مسجَّل · فشل ٥");
    expect(lastOkLine({ callHealth: null }, true)).toBe("لا طلب مسجَّل");
    expect(lastOkLine({ callHealth: null }, false)).toContain("غير متاح");
  });
  it("is rendered in each row (testid last-ok-N), with Arabic-Indic digits", () => {
    const h = html(overview([key({ number: 1, isMain: true, callHealth: { lastOkAt: ago(2 * 3_600_000), lastFailedAt: null, failedSinceOk: 0 } }), key({ number: 2, isActive: true })]));
    expect(h).toContain('data-testid="last-ok-1"');
    expect(h).toContain('data-testid="last-ok-2"');
    expect(row(h, 1)).toMatch(/آخر طلب ناجح: منذ ساعتين/);
    expect(html(overview([key({ number: 1, isMain: true })], { callHealthReady: false }))).toContain("غير متاح (ملف ٠٧ لم يُطبَّق)");
  });
});

describe("«افحص الآن» per pool key and the checker box", () => {
  const h = html(overview([key({ number: 1, isMain: true, chainPosition: 9 }), key({ number: 2, isActive: true }), key({ number: 3 })]));
  it("every row has one «افحص الآن» (the active key's is the visible button, the others' is in the menu)", () => {
    for (const n of [1, 2, 3]) expect(row(h, n)).toContain(`data-testid="check-now-${n}"`);
    expect(row(h, 2).split("<details")[0]).toContain(">افحص الآن<");
    expect(row(h, 3).split("<details")[1]).toContain(">افحص الآن<");
  });
  it("the box: a password field with no autocomplete, a button «افحص», the cost and the limit stated, and nothing that can hold a key in the markup", () => {
    const box = h.split('data-testid="key-checker"')[1].split("</div></div>")[0];
    expect(box).toMatch(/<input[^>]*type="password"[^>]*autoComplete="off"|<input[^>]*autoComplete="off"[^>]*type="password"/);
    expect(box).toContain("افحص");
    expect(box).toContain("٠٫٠٠٠١٥ دولار");
    expect(box).toContain("٥ فحوص في الساعة");
    expect(box).toContain("ويُمسح من الحقل فور الإرسال");
    expect(box).not.toMatch(/value="[^"]+"/);
    expect(h).not.toMatch(/ciphertext|plaintext|v1\.[A-Za-z0-9_-]{16}\./);
  });
  it("the pasted key leaves the field BEFORE anything is awaited, and is never kept in the report state", () => {
    const src = readFileSync("src/components/admin/TregKeyPool.tsx", "utf8");
    expect(src).toContain('const checkPasted = () => { const k = probe; setProbe(""); void runCheck("المفتاح الملصوق", { action: "check_key", key: k }); };');
    expect(src).not.toMatch(/setReport\([^)]*(probe|key)\b/);
    expect(src).not.toMatch(/localStorage|sessionStorage|console\./);
  });
});

describe("the answer of one check", () => {
  const report = (over: Partial<PublicKeyCheckReport> = {}): PublicKeyCheckReport => ({
    verdict: "suspended", statusAr: "الحساب موقوف", balanceUsd: 0.912244, providerText: "org suspended", noteAr: null, costUsd: 0.00015,
    steps: [{ name: "identity", ran: true, ok: true, httpStatus: 200 }, { name: "balance", ran: true, ok: true, httpStatus: null }, { name: "data", ran: true, ok: false, httpStatus: 403 }], ...over,
  });
  it("shows الحالة، الرصيد، ردّ المزود، the three steps and what the call cost", () => {
    const h = renderToStaticMarkup(createElement(KeyCheckResult, { title: "المفتاح رقم ٢", r: report() }));
    for (const word of ["المفتاح رقم ٢", "الحالة: ", "الحساب موقوف", "الرصيد: ", "ردّ المزود: ", "org suspended", "قراءة الهوية: نجح", "قراءة الرصيد: نجح", "طلب حقيقي واحد: لم ينجح (٤٠٣)", "تكلفة الطلب: "]) expect(h, word).toContain(word);
    expect(h).toContain("٠.٩١٢٢ دولار");                       // the table's own balance format
    expect(h).toContain("٠٫٠٠٠١٥ دولار");
  });
  it("«غير متاح» for an unreadable balance, no provider line when the provider said nothing, the cap note and skipped steps when the call did not run", () => {
    const h = renderToStaticMarkup(createElement(KeyCheckResult, { title: "t", r: report({ verdict: "unknown", statusAr: "غير معروف", balanceUsd: null, providerText: null, costUsd: 0, noteAr: "لم يُرسَل الطلب الحقيقي: بلغ الإنفاق اليومي على المزود حدّه.", steps: [{ name: "identity", ran: true, ok: true, httpStatus: 200 }, { name: "balance", ran: true, ok: false, httpStatus: null }, { name: "data", ran: false, ok: null, httpStatus: null }] }) }));
    expect(h).toContain("الرصيد: غير متاح");
    expect(h).not.toContain("ردّ المزود");
    expect(h).toContain("بلغ الإنفاق اليومي");
    expect(h).toContain("طلب حقيقي واحد: لم يُنفَّذ");
    expect(h).not.toContain("تكلفة الطلب");
  });
});
