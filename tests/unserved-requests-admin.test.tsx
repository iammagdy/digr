import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ admin: true, rows: [] as any[], failed: false }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: async () => (state.admin ? { ok: true, ctx: {} } : { ok: false, response: new Response(JSON.stringify({ error: "x" }), { status: 403 }) }),
}));
vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: () => {
    const chain: any = {};
    for (const m of ["select", "order"]) chain[m] = () => chain;
    chain.limit = async () => (state.failed ? { data: null, error: { message: "x" } } : { data: state.rows, error: null });
    return { from: (table: string) => { if (table !== "capability_requests") throw new Error(`unexpected table ${table}`); return chain; } };
  },
}));

import { GET } from "../src/app/api/admin/unserved-requests/route";
import AdminUnservedRequestsPage from "../src/app/admin/requests/page";
import { ADMIN_PAGES, adminHref } from "../src/components/admin/icons";
import { parseUnservedRow, summarizeUnserved } from "../src/lib/server/unservedRequests";

const rows = [
  { id: "1", user_id: "u1", query: "news_articles+price_series: اسحب كل أخبار الدولار من الجرايد", created_at: "2026-10-21T10:00:00Z" },
  { id: "2", user_id: "u2", query: "news_articles: أخبار الانتخابات من الصحف", created_at: "2026-10-21T10:05:00Z" },
  { id: "3", user_id: "u3", query: "competitor_ads: إعلانات المنافسين", created_at: "2026-10-21T10:06:00Z" },
  { id: "4", user_id: "u4", query: "تيك توك: شيء قديم من الذكاء الاصطناعي", created_at: "2026-10-21T10:07:00Z" },
];

describe("the unserved-requests list", () => {
  it("reads the family and the customer's words from a stored row", () => {
    const item = parseUnservedRow(rows[0]);
    expect(item.families).toEqual(["news_articles", "price_series"]);
    expect(item.textAr).toBe("اسحب كل أخبار الدولار من الجرايد");
    expect(item.familiesAr.join(" ")).not.toMatch(/[A-Za-z]/);
    expect(parseUnservedRow(rows[3]).families).toEqual([]);
  });
  it("counts per family, most asked first, with the older rows under «other»", () => {
    const summary = summarizeUnserved(rows);
    expect(summary.total).toBe(4);
    expect(summary.byFamily[0]).toMatchObject({ family: "news_articles", count: 2 });
    expect(summary.byFamily.map((f) => f.family)).toEqual(expect.arrayContaining(["price_series", "competitor_ads", "other"]));
  });
  it("is in the admin menu", () => {
    expect(ADMIN_PAGES.map(([id]) => id)).toContain("requests");
    expect(adminHref("requests")).toBe("/admin/requests");
  });
  it("the route answers an admin with the summary, a non-admin with 403 and no data, and a read failure with a plain error", async () => {
    state.admin = true; state.rows = rows; state.failed = false;
    const ok = await GET(new Request("http://x/api/admin/unserved-requests") as any);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.total).toBe(4);
    state.admin = false;
    const denied = await GET(new Request("http://x/api/admin/unserved-requests") as any);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toContain("الجرايد");
    state.admin = true; state.failed = true;
    const failed = await GET(new Request("http://x/api/admin/unserved-requests") as any);
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toBe("تعذّر قراءة الطلبات الآن.");
  });
  it("the page renders its two Arabic sections", () => {
    const html = renderToStaticMarkup(createElement(AdminUnservedRequestsPage as any));
    expect(html).toContain("ما الذي طلبه العملاء ولا نبيعه");
    expect(html).toContain("آخر الطلبات");
  });
});
