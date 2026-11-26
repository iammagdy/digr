import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE METHODOLOGY PURCHASE FOR AN OLD «FACEBOOK TOPIC REPORT» JOB (DT-20261126-wl4-ph1b). The route spends points, so the removed report's saved data is refused with an honest Arabic 410
 * BEFORE anything is built, saved or charged. A legacy job without that key is bought exactly as before: one charge, one saved file.
 */
const world = vi.hoisted(() => ({
  data: null as null | Record<string, unknown>,
  uploads: [] as string[],
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  ledger: [] as string[],
}));

vi.mock("../src/lib/supabase/server", () => {
  const chain = (result: () => any): any => {
    const first = () => { const r = result(); return Array.isArray(r.data) ? { data: r.data[0] ?? null, error: null } : r; };
    const c: any = {
      select: () => c, eq: () => c, in: () => c, gt: () => c, not: () => c, order: () => c, limit: () => c,
      maybeSingle: async () => first(), single: async () => first(),
      then: (resolve: (v: unknown) => unknown) => resolve(result()),
    };
    return c;
  };
  const from = (table: string) => {
    if (table === "jobs") return chain(() => ({ data: { id: "job_old1", user_id: "owner-1", status: "completed", created_at: "2026-11-04T07:10:14Z" }, error: null }));
    if (table === "credit_ledger") return chain(() => ({ data: world.ledger.map((id) => ({ id, delta: -50 })), error: null }));
    return chain(() => ({ data: table === "job_group_parts" ? null : [], error: null }));
  };
  const storage = {
    from: () => ({
      download: async (path: string) => (/data\.json$/.test(path) && world.data ? { data: { text: async () => JSON.stringify(world.data) }, error: null } : { data: null, error: new Error("not found") }),
      upload: async (path: string) => { world.uploads.push(path); return { error: null }; },
      remove: async () => ({ error: null }),
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.example/${path}` }, error: null }),
    }),
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    world.rpc.push({ name, args });
    if (name !== "purchase_methodology_atomic") return { data: null, error: null };
    world.ledger.push(`chg_meth_${args.p_job_id}`);
    return { data: { success: true, already_purchased: false, balance: 950, charged: Number(args.p_amount) }, error: null };
  };
  return {
    createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: "owner-1", app_metadata: {}, user_metadata: {} } }, error: null })) } })),
    createAdminClient: vi.fn(() => ({ from, storage, rpc })),
  };
});

import { POST } from "../src/app/api/jobs/[id]/methodology/route";
import { METHODOLOGY_POINTS } from "../src/lib/methodologyOffer";

const ROWS = [{ video_url: "https://example.com/p1", comment_text: "تعليق أول", author: "أحمد" }, { video_url: "https://example.com/p1", comment_text: "تعليق ثانٍ", author: "منى" }];
const buy = () => POST(
  new NextRequest("http://localhost/api/jobs/job_old1/methodology", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify({ confirmed: true, expectedPoints: METHODOLOGY_POINTS }) }),
  { params: Promise.resolve({ id: "job_old1" }) },
);

beforeEach(() => { world.data = null; world.uploads = []; world.rpc = []; world.ledger = []; vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("the removed report's saved data: refused before anything is built, saved or charged", () => {
  it("410, the Arabic message says no points were taken, no file saved, no purchase call, no ledger row", async () => {
    world.data = { metadata: { title: "old", facebookReport: { v: 1, posts: [{ id: "p1" }] } }, rows: ROWS };
    const res = await buy();
    const json = await res.json();
    expect(res.status).toBe(410);
    expect(json.success).toBe(false);
    expect(json.error).toContain("لم يعد متاحًا");
    expect(json.error).toContain("لم يتم خصم أي نقاط");
    expect(world.uploads).toEqual([]);
    expect(world.rpc).toEqual([]);
    expect(world.ledger).toEqual([]);
  });
});

describe("counter-case: an ordinary legacy job is bought exactly as before", () => {
  it("200, one saved file, ONE purchase call of the methodology price, one ledger row", async () => {
    world.data = { metadata: { title: "plain", platform: "web" }, rows: ROWS };
    const res = await buy();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(world.uploads).toEqual(["owner-1/job_old1/methodology-addon.pdf"]);
    expect(world.rpc).toHaveLength(1);
    expect(world.rpc[0].args).toMatchObject({ p_job_id: "job_old1", p_amount: METHODOLOGY_POINTS });
    expect(world.ledger).toEqual(["chg_meth_job_old1"]);
  });
});
