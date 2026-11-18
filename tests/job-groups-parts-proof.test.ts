import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GROUP_PARTS_UNAVAILABLE_AR } from "../src/lib/multiProvider/copy";
import GroupPartsList from "../src/components/mission/GroupPartsList";

/**
 * PR-12 proof (D-0068, QA gaps of tests/job-groups-parts-access.test.tsx), a NEW independent file:
 *  1. aria-current belongs to the CURRENT part's link ONLY: the rendered HTML is parsed link by link (no "appears somewhere" check).
 *  2. errors, timeouts and thrown rejections are exercised on EACH of the four reads of group-parts/route.ts, in order:
 *       R1 job_group_parts (lookup of the job's part), R2 job_groups (owner + parts_planned), R3 job_group_parts (the group's parts), R4 jobs (status of the parts).
 *     Each failure is injected on exactly ONE read (by table AND call number, because job_group_parts is read twice); the test asserts the answer,
 *     that nothing of the group leaks, and that NO later read was made.
 * Nothing here changes route or component code.
 */

let mockUser: { id: string } | null = { id: "user_owner" };
let mockAdminDb: any = null;
vi.mock("@/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: mockUser } })) } })),
  createAdminClient: vi.fn(() => mockAdminDb),
}));
import { GET } from "../src/app/api/jobs/[id]/group-parts/route";

type Kind = "error" | "hang" | "throw";
interface Failure { table: string; nth: number; kind: Kind; error?: any }

const WORLD = {
  parts: [
    { group_id: "grp_1", part_index: 1, job_id: "job_part_1" },
    { group_id: "grp_1", part_index: 2, job_id: "job_part_2" },
    { group_id: "grp_1", part_index: 3, job_id: "job_part_3" },
  ],
  groups: [{ id: "grp_1", user_id: "user_owner", parts_planned: 3 }],
  jobs: [
    { id: "job_part_1", user_id: "user_owner", status: "completed", delivered_units: 40, target_volume_max: 40, charged_credits: 400 },
    { id: "job_part_2", user_id: "user_owner", status: "completed", delivered_units: 35, target_volume_max: 40, charged_credits: 350 },
    { id: "job_part_3", user_id: "user_owner", status: "failed", delivered_units: 0, target_volume_max: 40, charged_credits: 0 },
  ],
};

/** reads are recorded as "<table>#<n>" in the order they are AWAITED; a failure is injected on one (table, n) only. */
function makeDb(failure: Failure | null) {
  const calls: Record<string, number> = {};
  const reads: string[] = [];
  const db = {
    reads,
    from: (table: string) => {
      const n = (calls[table] = (calls[table] ?? 0) + 1);
      const eq: Record<string, any> = {};
      let inF: any[] | null = null;
      const builder: any = {
        select: () => builder,
        eq: (c: string, v: any) => { eq[c] = v; return builder; },
        in: (_c: string, v: any[]) => { inF = v; return builder; },
        order: () => builder,
        maybeSingle: () => { builder.single = true; return builder; },
        then: (ok: any, bad: any) => {
          reads.push(`${table}#${n}`);
          if (failure && failure.table === table && failure.nth === n) {
            if (failure.kind === "hang") return new Promise(() => {}).then(ok, bad);
            if (failure.kind === "throw") return Promise.reject(new Error("db exploded")).then(ok, bad);
            return Promise.resolve({ data: null, error: failure.error ?? { code: "XX000", message: "db error" } }).then(ok, bad);
          }
          let rows: any[] = [];
          if (table === "job_group_parts") rows = WORLD.parts.filter((r) => (eq.job_id === undefined || r.job_id === eq.job_id) && (eq.group_id === undefined || r.group_id === eq.group_id)).sort((a, b) => a.part_index - b.part_index);
          if (table === "job_groups") rows = WORLD.groups.filter((r) => eq.id === undefined || r.id === eq.id);
          if (table === "jobs") rows = WORLD.jobs.filter((r) => (eq.user_id === undefined || r.user_id === eq.user_id) && (inF === null || inF.includes(r.id)));
          return Promise.resolve({ data: builder.single ? (rows[0] ?? null) : rows, error: null }).then(ok, bad);
        },
      };
      return builder;
    },
  };
  return db;
}
const get = (id = "job_part_2") => GET(new NextRequest(`https://site.test/api/jobs/${id}/group-parts`, { headers: { authorization: "Bearer t" } }), { params: Promise.resolve({ id }) });

beforeEach(() => { mockUser = { id: "user_owner" }; mockAdminDb = null; });
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------------------------------------------------------------------------------
describe("aria-current is on the CURRENT part's link only (rendered HTML parsed link by link)", () => {
  const parts = [
    { index: 1, jobId: "job_part_1", status: "completed", delivered: 40, requested: 40 },
    { index: 2, jobId: "job_part_2", status: "completed", delivered: 35, requested: 40 },
    { index: 3, jobId: "job_part_3", status: "failed", delivered: 0, requested: 40 },
  ];
  /** every group-part link of the rendered HTML: its href and its aria-current attribute (null when the attribute is absent). */
  const links = (html: string) =>
    [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes('data-testid="group-part-link"')).map((tag) => ({
      href: /href="([^"]*)"/.exec(tag)?.[1] ?? null,
      ariaCurrent: /\baria-current="([^"]*)"/.exec(tag)?.[1] ?? null,
      hasAttr: /\baria-current\b/.test(tag),
    }));
  const render = (currentJobId: string, list = parts, total = 3) => renderToStaticMarkup(createElement(GroupPartsList, { parts: list, total, currentJobId }));

  it.each(parts.map((p) => p.jobId))("current = %s: exactly that link has aria-current=\"page\"; the other two links have no aria-current attribute at all", (current) => {
    const ls = links(render(current));
    expect(ls.map((l) => l.href)).toEqual(parts.map((p) => `/dashboard/requests/${p.jobId}`));
    for (const l of ls) {
      if (l.href === `/dashboard/requests/${current}`) { expect(l.ariaCurrent).toBe("page"); }
      else { expect(l.hasAttr).toBe(false); expect(l.ariaCurrent).toBeNull(); }
    }
    expect(ls.filter((l) => l.ariaCurrent === "page").length).toBe(1);
    expect((render(current).match(/aria-current/g) || []).length).toBe(1);   // and nowhere else in the markup
  });
  it("the current job is not one of the parts => no link has aria-current", () => {
    const html = render("some_other_job");
    expect(links(html).length).toBe(3);
    expect(links(html).filter((l) => l.hasAttr)).toEqual([]);
    expect(html).not.toContain("aria-current");
  });
  it("a job id that needs URL encoding: the matching link is the current one (compared on the raw id, href encoded)", () => {
    const odd = [{ index: 1, jobId: "job part/1", status: "completed", delivered: 5, requested: 5 }, { index: 2, jobId: "job_part_2", status: "completed", delivered: 5, requested: 5 }];
    const ls = links(render("job part/1", odd, 2));
    expect(ls.map((l) => l.href)).toEqual([`/dashboard/requests/${encodeURIComponent("job part/1")}`, "/dashboard/requests/job_part_2"]);
    expect(ls.map((l) => l.ariaCurrent)).toEqual(["page", null]);
  });
  it("two parts, 2 of 2: aria-current on the second only", () => {
    const ls = links(render("job_part_2", parts.slice(0, 2), 2));
    expect(ls.map((l) => l.ariaCurrent)).toEqual([null, "page"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
describe("group-parts route: the baseline order of the four reads", () => {
  it("owner, 3 parts => 200 with the parts in order; reads are exactly R1 job_group_parts#1, R2 job_groups#1, R3 job_group_parts#2, R4 jobs#1", async () => {
    mockAdminDb = makeDb(null);
    const res = await get(); const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true); expect(body.total).toBe(3);
    expect(body.parts.map((p: any) => [p.index, p.jobId, p.status, p.delivered, p.requested, p.charged])).toEqual([
      [1, "job_part_1", "completed", 40, 40, 400], [2, "job_part_2", "completed", 35, 40, 350], [3, "job_part_3", "failed", 0, 40, 0],
    ]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mockAdminDb.reads).toEqual(["job_group_parts#1", "job_groups#1", "job_group_parts#2", "jobs#1"]);
  });
});

describe("group-parts route: an error, a timeout or a thrown rejection on EACH read answers 503 and stops (no later read, nothing leaked)", () => {
  const READS: { name: string; table: string; nth: number; before: string[] }[] = [
    { name: "R1 job_group_parts (lookup of the job's part)", table: "job_group_parts", nth: 1, before: [] },
    { name: "R2 job_groups (owner and parts_planned)", table: "job_groups", nth: 1, before: ["job_group_parts#1"] },
    { name: "R3 job_group_parts (the group's parts)", table: "job_group_parts", nth: 2, before: ["job_group_parts#1", "job_groups#1"] },
    { name: "R4 jobs (status of the parts)", table: "jobs", nth: 1, before: ["job_group_parts#1", "job_groups#1", "job_group_parts#2"] },
  ];
  const expectUnavailable = async (res: Response) => {
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: GROUP_PARTS_UNAVAILABLE_AR });   // exactly the S-copy: no parts, no total, no group id
  };
  for (const r of READS) {
    const reads = (db: any) => [...r.before, `${r.table}#${r.nth}`];
    it(`${r.name}: a database error (XX000) => 503, reads stop at this read`, async () => {
      mockAdminDb = makeDb({ table: r.table, nth: r.nth, kind: "error", error: { code: "XX000", message: "internal error" } });
      await expectUnavailable(await get());
      expect(mockAdminDb.reads).toEqual(reads(mockAdminDb));
    });
    it(`${r.name}: a timeout (4 s) => 503, reads stop at this read`, async () => {
      vi.useFakeTimers();
      mockAdminDb = makeDb({ table: r.table, nth: r.nth, kind: "hang" });
      const p = get(); await vi.advanceTimersByTimeAsync(4_500);
      await expectUnavailable(await p);
      expect(mockAdminDb.reads).toEqual(reads(mockAdminDb));
    });
    it(`${r.name}: a rejected read => 503 through the outer guard, reads stop at this read`, async () => {
      mockAdminDb = makeDb({ table: r.table, nth: r.nth, kind: "throw" });
      await expectUnavailable(await get());
      expect(mockAdminDb.reads).toEqual(reads(mockAdminDb));
    });
  }
  it("a read that answers just before the 4 s limit is still served (3.9 s on R4)", async () => {
    vi.useFakeTimers();
    const slow = makeDb(null); const orig = slow.from;
    slow.from = (table: string) => { const b: any = orig(table); if (table !== "jobs") return b; const t = b.then; b.then = (ok: any, bad: any) => new Promise((res) => setTimeout(res, 3_900)).then(() => t(ok, bad)); return b; };
    mockAdminDb = slow;
    const p = get(); await vi.advanceTimersByTimeAsync(4_500);
    const res = await p;
    expect(res.status).toBe(200); expect((await res.json()).parts.length).toBe(3);
  });
  for (const code of ["42P01", "PGRST205"]) {
    it(`a missing schema (${code}) on R1 or R2 is NOT an error: 200 with no parts and total 0, later reads not made`, async () => {
      for (const [table, nth, seen] of [["job_group_parts", 1, ["job_group_parts#1"]], ["job_groups", 1, ["job_group_parts#1", "job_groups#1"]]] as [string, number, string[]][]) {
        mockAdminDb = makeDb({ table, nth, kind: "error", error: { code, message: "relation does not exist" } });
        const res = await get(); const body = await res.json();
        expect(res.status).toBe(200); expect(body).toEqual({ success: true, parts: [], total: 0 });
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(mockAdminDb.reads).toEqual(seen);
      }
    });
    it(`the same missing-schema code on the LATER reads R3 and R4 is a failure (503), as the route is written`, async () => {
      for (const [table, nth] of [["job_group_parts", 2], ["jobs", 1]] as [string, number][]) {
        mockAdminDb = makeDb({ table, nth, kind: "error", error: { code, message: "relation does not exist" } });
        await expectUnavailable(await get());
      }
    });
  }
  it("a group of another owner and a job that is no group part both answer the same empty 200 (no leak, no later read after R2 / R1)", async () => {
    mockUser = { id: "user_other" };
    mockAdminDb = makeDb(null);
    const other = await get(); expect(other.status).toBe(200); expect(await other.json()).toEqual({ success: true, parts: [], total: 0 });
    expect(mockAdminDb.reads).toEqual(["job_group_parts#1", "job_groups#1"]);
    mockUser = { id: "user_owner" }; mockAdminDb = makeDb(null);
    const none = await get("job_not_a_part"); expect(none.status).toBe(200); expect(await none.json()).toEqual({ success: true, parts: [], total: 0 });
    expect(mockAdminDb.reads).toEqual(["job_group_parts#1"]);
  });
});
