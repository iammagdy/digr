import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STATUS_AR, TregKeyPool, chainOrder } from "../src/components/admin/TregKeyPool";
import type { PoolKeyView, PoolOverview } from "../src/lib/server/tregPoolAdmin";

const key = (over: Partial<PoolKeyView> & { number: number }): PoolKeyView => ({
  id: `id-${over.number}`, label: `اختبار-${over.number}`, isMain: false, inChain: true, chainPosition: over.number, isActive: false, last4: `k${over.number}x${over.number}`, accountEmail: `k${over.number}@example.test`,
  status: "connected", statusReason: null, statusCheckedAt: new Date(Date.now() - 120_000).toISOString(), balanceUsd: 0.91, balanceCheckedAt: null, spend: { calls: 0, usd: 0, todayUsd: 0, lastCallAt: null }, ...over,
});
const overview = (over: Partial<PoolOverview> = {}): PoolOverview => ({
  ready: true, rolloutOn: false, generation: 0, minBalanceUsd: 0.01, lastHealthRunAt: null, events: [], legacy: { source: "env", last4: "Az7w" }, workerEnvLast4: null, workerSeenAt: null, workerMismatch: false, noticesAr: [],
  keys: [key({ number: 1, isMain: true, label: "الرئيسي", chainPosition: 9, balanceUsd: 12.4 }), key({ number: 2, isActive: true, spend: { calls: 4, usd: 0.09, todayUsd: 0.09, lastCallAt: null } }), key({ number: 3, status: "revoked", balanceUsd: null }), key({ number: 4, status: "out_of_balance", inChain: false })],
  activeKeyId: "id-2", ...over,
});
const html = (ov: PoolOverview) => renderToStaticMarkup(createElement(TregKeyPool, { initial: ov }));

describe("the admin key pool table", () => {
  it("numbered rows with label, e-mail, last 4 only, balance, status words, last check, spend, the main mark and the active mark", () => {
    const h = html(overview());
    for (const word of ["مجمّع مفاتيح TREG", "بريد الحساب", "آخر ٤", "الرصيد المتبقي", "الحالة", "الاستهلاك", "الرئيسي / الافتراضي", "نشط الآن", "متصل", "ملغى", "الرصيد خلص", "خارج السلسلة"]) expect(h, word).toContain(word);
    expect(h).toContain("••••k1x1");
    expect(h).toContain("k2@example.test");
    expect(h).toContain("منذ دقيقتين");
    expect(h).toContain("٤ استدعاء");
    for (const n of [1, 2, 3, 4]) expect(h).toContain(`data-testid="pool-row-${n}"`);
    expect(Object.values(STATUS_AR)).toEqual(["متصل", "خطأ", "ملغى", "الرصيد خلص", "لم يُفحص"]);
  });

  it("the switch is OFF by default: says so, offers «تشغيل المجمّع», and the main key can only be replaced (no delete button on its row)", () => {
    const h = html(overview());
    expect(h).toContain("المجمّع مغلق");
    expect(h).toContain("تشغيل المجمّع");
    expect(h).not.toContain("إيقاف المجمّع");
    const mainRow = h.split('data-testid="pool-row-1"')[1].split("</tr>")[0];
    expect(mainRow).toContain("استبدال");
    expect(mainRow).not.toContain(">حذف<");
    expect(mainRow).toContain("لا يُحذف");
    const activeRow = h.split('data-testid="pool-row-2"')[1].split("</tr>")[0];
    expect(activeRow).toContain("title=\"هذا المفتاح قيد الاستخدام");
    expect(h.split('data-testid="pool-row-3"')[1].split("</tr>")[0]).toContain(">حذف<");
  });

  it("ON: says the platform uses the active key and offers the way back", () => {
    const h = html(overview({ rolloutOn: true }));
    expect(h).toContain("المجمّع يعمل");
    expect(h).toContain("إيقاف المجمّع (العودة للوضع الحالي)");
    expect(h).toContain("رقم ٢");
  });

  it("with no main key it offers the one-click adoption and warns; no key string can appear in the markup", () => {
    const h = html(overview({ keys: [], activeKeyId: null, noticesAr: ["لا يوجد مفتاح رئيسي بعد."] }));
    expect(h).toContain("اعتماد المفتاح الحالي كمفتاح رئيسي");
    expect(h).toContain("لا يوجد مفتاح رئيسي بعد.");
    expect(html(overview())).not.toMatch(/ciphertext|plaintext|v1\.[A-Za-z0-9_-]{16}\./);
  });

  it("the chain order the screen shows: pool keys by position, the MAIN key after them, keys outside the chain last", () => {
    const keys = overview().keys;
    expect(chainOrder(keys).map((k) => k.number)).toEqual([2, 3, 1, 4]);
    const reordered = keys.map((k) => (k.number === 3 ? { ...k, chainPosition: 0 } : k));
    expect(chainOrder(reordered).map((k) => k.number)).toEqual([3, 2, 1, 4]);
  });

  it("the TREG tab mounts the pool section and keeps today's key section, labelled as the key used while the pool is off", async () => {
    const src = (await import("node:fs")).readFileSync("src/components/admin/ProviderTab.tsx", "utf8");
    expect(src).toContain('provider === "treg" && <TregKeyPool />');
    expect(src).toContain("هذا هو المفتاح الذي تستخدمه المنصة عندما يكون المجمّع أعلاه مغلقًا");
    expect(src).toContain("استبدال المفتاح");
  });
});
