import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ ok: true, rows: [] as any[] }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: async () => auth.ok ? { ok: true, ctx: {} } : { ok: false, response: new Response(JSON.stringify({ error: "x" }), { status: 403 }) },
}));
vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: () => {
    const chain: any = {};
    for (const m of ["select", "or", "order"]) chain[m] = () => chain;
    chain.limit = async () => ({ data: auth.rows, error: null });
    return { from: () => chain };
  },
}));
vi.mock("../src/functions/shared/providerSpend", () => ({
  getProviderBalanceStatus: async () => ({ todaySpendUsd: 0.2, todayCapUsd: 0.8, availableBalanceUsd: 0.5 }),
  getConfiguredProviderCreditUsd: () => 1,
}));
vi.mock("../src/lib/server/providerLimits", () => ({ resolveProviderLimits: async () => ({ limits: { warnPercent: 80 } }) }));

import AdminOperationsPage from "../src/app/admin/operations/page";
import { GET } from "../src/app/api/admin/operations/route";
import { ADMIN_PAGES, adminHref } from "../src/components/admin/icons";
import { REFUND_AFTER_MS, STALLED_AFTER_MS, buildOperationsSnapshot, classifyJob, type JobRowLite } from "../src/lib/server/adminOperations";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const job = (extra: Partial<JobRowLite>): JobRowLite => ({ id: "j", status: "running", lease_until: null, updated_at: iso(0), created_at: iso(-60_000), ...extra });
const provider = { todaySpendUsd: 0.2, todayCapUsd: 0.8, availableBalanceUsd: 0.5, creditUsd: 1, warnPercent: 80 };

describe("job classes", () => {
  it("a live lease is running", () => expect(classifyJob(job({ lease_until: iso(30_000), updated_at: iso(-600_000) }), NOW)).toBe("running"));
  it("no lease and recently touched is not yet stalled", () => {
    expect(classifyJob(job({ updated_at: iso(-60_000) }), NOW)).toBe("running");
    expect(classifyJob(job({ status: "queued", updated_at: iso(-60_000) }), NOW)).toBe("queued");
  });
  it("no live lease for the stalled threshold is stalled, queued or running", () => {
    expect(classifyJob(job({ updated_at: iso(-STALLED_AFTER_MS) }), NOW)).toBe("stalled");
    expect(classifyJob(job({ status: "queued", lease_until: iso(-1000), updated_at: iso(-STALLED_AFTER_MS - 1) }), NOW)).toBe("stalled");
  });
  it("failed counts only inside the last 24 hours; finished jobs are other", () => {
    expect(classifyJob(job({ status: "failed", updated_at: iso(-3_600_000) }), NOW)).toBe("failed_recent");
    expect(classifyJob(job({ status: "failed", updated_at: iso(-90_000_000) }), NOW)).toBe("other");
    expect(classifyJob(job({ status: "completed" }), NOW)).toBe("other");
  });
});

describe("the snapshot", () => {
  it("counts each class once and tells the owner when a stalled job will be refunded", () => {
    const snapshot = buildOperationsSnapshot({
      now: NOW, provider,
      jobs: [
        job({ id: "r1", lease_until: iso(20_000) }),
        job({ id: "q1", status: "queued", created_at: iso(-600_000) }),
        job({ id: "s1", updated_at: iso(-10 * 60_000) }),
        job({ id: "f1", status: "failed", updated_at: iso(-3_600_000), reserved_credits: 120, error_message: "انتهت المهلة" }),
      ],
    });
    expect(snapshot.counts).toEqual({ queued: 1, running: 1, stalled: 1, failedRecent: 1 });
    expect(snapshot.oldestQueuedMinutes).toBe(10);
    expect(snapshot.stalled[0]).toEqual({ id: "s1", idleMinutes: 10, refundInMinutes: Math.ceil((REFUND_AFTER_MS - 10 * 60_000) / 60_000) });
    expect(snapshot.failed[0]).toMatchObject({ id: "f1", reservedCredits: 120, reasonAr: "انتهت المهلة" });
    expect(snapshot.alerts.map((a) => a.level)).toEqual(["bad", "warn"]);
  });

  it("the provider level is ok, then warn at the warn percent, then reached at the cap", () => {
    const level = (spend: number) => buildOperationsSnapshot({ now: NOW, jobs: [], provider: { ...provider, todaySpendUsd: spend } }).provider.level;
    expect([level(0.2), level(0.64), level(0.8), level(2)]).toEqual(["ok", "warn", "reached", "reached"]);
    expect(buildOperationsSnapshot({ now: NOW, jobs: [], provider: { ...provider, todaySpendUsd: 0.9 } }).provider.percentOfCap).toBe(100);
  });

  it("a zero cap with spend reads as reached, a low balance and a long queue raise alerts, a quiet system has none", () => {
    expect(buildOperationsSnapshot({ now: NOW, jobs: [], provider: { ...provider, todayCapUsd: 0, todaySpendUsd: 0.1 } }).provider.level).toBe("reached");
    const busy = buildOperationsSnapshot({ now: NOW, jobs: Array.from({ length: 10 }, (_, i) => job({ id: `q${i}`, status: "queued" })), provider: { ...provider, availableBalanceUsd: 0.1 } });
    expect(busy.alerts.map((a) => a.textAr).join(" ")).toContain("رصيد المزود منخفض");
    expect(busy.alerts.map((a) => a.textAr).join(" ")).toContain("طلب في الانتظار");
    expect(buildOperationsSnapshot({ now: NOW, jobs: [], provider }).alerts).toEqual([]);
  });
});

describe("the route and the page", () => {
  it("refuses a non-admin before reading anything", async () => {
    auth.ok = false;
    expect((await GET({ headers: new Headers() } as any)).status).toBe(403);
    auth.ok = true;
  });

  it("returns the snapshot for an admin, read only", async () => {
    auth.rows = [{ id: "s1", status: "running", lease_until: null, updated_at: new Date(Date.now() - 600_000).toISOString(), created_at: new Date(Date.now() - 900_000).toISOString() }];
    const body = await (await GET({ headers: new Headers() } as any)).json();
    expect(body.counts.stalled).toBe(1);
    expect(body.provider.level).toBe("ok");
    const source = readFileSync("src/app/api/admin/operations/route.ts", "utf8");
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(|credit_ledger/);
  });

  it("is in the admin menu and renders its sections in Arabic", () => {
    expect(ADMIN_PAGES.find(([id]) => id === "operations")![1]).toBe("التشغيل");
    expect(adminHref("operations")).toBe("/admin/operations");
    const html = renderToStaticMarkup(createElement(AdminOperationsPage));
    for (const text of ["قيد التنفيذ", "في الانتظار", "متوقفة", "تنبيهات", "المزود والحد اليومي", "طلبات متوقفة"]) expect(html).toContain(text);
    expect((html.match(/data-testid="ops-tile"/g) || []).length).toBe(4);
  });
});
