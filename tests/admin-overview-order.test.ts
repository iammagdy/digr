import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DT-20261118-06 PR 2 (a follow-up of PR 1, Gate 1 P2-5): the overview reads the missions in pages with `.range()`; with ONE ordering key (`created_at`) rows that share the same instant can swap places between two page reads and one is skipped or read
 * twice. `id` is the second ordering key, so the order is total and a page boundary can never lose a row.
 */
const state = vi.hoisted(() => ({ orders: [] as Array<[string, boolean | undefined]> }));
vi.mock("../src/lib/server/adminAuth", () => ({ authenticateAdmin: vi.fn(async () => ({ ok: true, ctx: { adminId: "adm-1", audit: vi.fn() } })), Query: {} }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(),
  createAdminClient: () => ({
    from: () => {
      const chain: any = {
        select: () => chain, gte: () => chain, lt: () => chain, lte: () => chain, gt: () => chain, neq: () => chain, in: () => chain, eq: () => chain, is: () => chain, not: () => chain,
        order: (col: string, o?: { ascending?: boolean }) => { state.orders.push([col, o?.ascending]); return chain; },
        range: async () => ({ data: [], error: null }),
        limit: async () => ({ data: [], error: null }),
      };
      return chain;
    },
  }),
}));
import { GET } from "../src/app/api/admin/overview/route";

describe("the overview's paged read orders by created_at then by id", () => {
  beforeEach(() => { state.orders = []; });
  it("the window read asks for created_at (newest first) and then id (newest first): a total order", async () => {
    const r = await GET(new NextRequest("http://x/api/admin/overview?range=30"));
    expect(r.status).toBe(200);
    const window = state.orders.slice(0, 2);
    expect(window).toEqual([["created_at", false], ["id", false]]);
  });
});
