import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { GROUP_PARTS_TITLE_AR, GROUP_PARTS_UNAVAILABLE_AR, groupPartLinkAr } from "../src/lib/multiProvider/copy";
import { REQUEST_STATUS_LABEL_AR, resolveRequestKind } from "../src/lib/jobs/requestStatus";
import GroupPartsList from "../src/components/mission/GroupPartsList";

// Module mocks for route testing
let mockUser: { id: string } | null = { id: "user_owner" };
let mockAdminDb: any = null;

vi.mock("@/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: mockUser } })),
    },
  })),
  createAdminClient: vi.fn(() => mockAdminDb),
}));

// Import GET handler after mock setup
import { GET } from "../src/app/api/jobs/[id]/group-parts/route";

interface FakeWorld {
  jobGroupParts: Array<{ group_id: string; part_index: number; job_id: string }>;
  jobGroups: Array<{ id: string; user_id: string; parts_planned: number }>;
  jobs: Array<{
    id: string;
    user_id: string;
    status: string;
    delivered_units: number | null;
    target_volume_max: number | null;
    charged_credits: number | null;
  }>;
  errors?: {
    job_group_parts?: any;
    job_groups?: any;
    jobs?: any;
  };
  hangs?: {
    job_group_parts?: boolean;
    job_groups?: boolean;
    jobs?: boolean;
  };
}

function createFakeDb(world: FakeWorld, queryRecorder?: any[]) {
  return {
    from: (table: string) => {
      let selectedCols = "*";
      const eqFilters: Record<string, any> = {};
      let inFilter: { col: string; vals: any[] } | null = null;
      let orderCol: string | null = null;
      let isMaybeSingle = false;

      const builder: any = {
        select: (cols: string) => {
          selectedCols = cols;
          return builder;
        },
        eq: (col: string, val: any) => {
          eqFilters[col] = val;
          return builder;
        },
        in: (col: string, vals: any[]) => {
          inFilter = { col, vals };
          return builder;
        },
        order: (col: string) => {
          orderCol = col;
          return builder;
        },
        maybeSingle: () => {
          isMaybeSingle = true;
          return builder;
        },
        then: (onfulfilled: any, onrejected: any) => {
          if (queryRecorder) {
            queryRecorder.push({
              table,
              selectedCols,
              eqFilters: { ...eqFilters },
              inFilter: inFilter ? { ...inFilter } : null,
              orderCol,
              isMaybeSingle,
            });
          }

          if (world.hangs?.[table as keyof typeof world.hangs]) {
            return new Promise(() => {}).then(onfulfilled, onrejected);
          }

          if (world.errors?.[table as keyof typeof world.errors]) {
            return Promise.resolve({
              data: null,
              error: world.errors[table as keyof typeof world.errors],
            }).then(onfulfilled, onrejected);
          }

          if (table === "job_group_parts") {
            let rows = [...world.jobGroupParts];
            if (eqFilters.job_id !== undefined) {
              rows = rows.filter((r) => r.job_id === eqFilters.job_id);
            }
            if (eqFilters.group_id !== undefined) {
              rows = rows.filter((r) => r.group_id === eqFilters.group_id);
            }
            if (orderCol === "part_index") {
              rows.sort((a, b) => a.part_index - b.part_index);
            }
            const data = isMaybeSingle ? (rows[0] ?? null) : rows;
            return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
          }

          if (table === "job_groups") {
            let rows = [...world.jobGroups];
            if (eqFilters.id !== undefined) {
              rows = rows.filter((r) => r.id === eqFilters.id);
            }
            const data = isMaybeSingle ? (rows[0] ?? null) : rows;
            return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
          }

          if (table === "jobs") {
            let rows = [...world.jobs];
            if (eqFilters.user_id !== undefined) {
              rows = rows.filter((r) => r.user_id === eqFilters.user_id);
            }
            if (inFilter) {
              const filterVals = new Set(inFilter.vals);
              rows = rows.filter((r) => filterVals.has((r as any)[inFilter!.col]));
            }
            const data = isMaybeSingle ? (rows[0] ?? null) : rows;
            return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
          }

          return Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected);
        },
      };

      return builder;
    },
  };
}

describe("PR-12: Job Groups Parts Access (§3.10, T8)", () => {
  beforeEach(() => {
    mockUser = { id: "user_owner" };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("T8 Route GET /api/jobs/[id]/group-parts", () => {
    it("(a) a 3-part group, parts 1 and 2 charged (completed), part 3 failed ⇒ GET with ANY of the three ids returns the same 3 parts in order with charged values, total 3", async () => {
      const world: FakeWorld = {
        jobGroups: [
          { id: "grp_3parts", user_id: "user_owner", parts_planned: 3 },
        ],
        jobGroupParts: [
          { group_id: "grp_3parts", part_index: 1, job_id: "job_part_1" },
          { group_id: "grp_3parts", part_index: 2, job_id: "job_part_2" },
          { group_id: "grp_3parts", part_index: 3, job_id: "job_part_3" },
        ],
        jobs: [
          {
            id: "job_part_1",
            user_id: "user_owner",
            status: "completed",
            delivered_units: 40,
            target_volume_max: 40,
            charged_credits: 280,
          },
          {
            id: "job_part_2",
            user_id: "user_owner",
            status: "completed",
            delivered_units: 35,
            target_volume_max: 40,
            charged_credits: 245,
          },
          {
            id: "job_part_3",
            user_id: "user_owner",
            status: "failed",
            delivered_units: 0,
            target_volume_max: 40,
            charged_credits: 0,
          },
        ],
      };
      mockAdminDb = createFakeDb(world);

      const expectedBody = {
        success: true,
        total: 3,
        parts: [
          { index: 1, jobId: "job_part_1", status: "completed", delivered: 40, requested: 40, charged: 280 },
          { index: 2, jobId: "job_part_2", status: "completed", delivered: 35, requested: 40, charged: 245 },
          { index: 3, jobId: "job_part_3", status: "failed", delivered: 0, requested: 40, charged: 0 },
        ],
      };

      for (const targetId of ["job_part_1", "job_part_2", "job_part_3"]) {
        const req = new NextRequest(`http://localhost/api/jobs/${targetId}/group-parts`);
        const res = await GET(req, { params: Promise.resolve({ id: targetId }) });
        expect(res.status).toBe(200);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        const json = await res.json();
        expect(json).toEqual(expectedBody);
      }
    });

    it("(b) the fake user also owns 6,000 newer ordinary jobs and the recorder shows NO jobs query without .in('id', …)", async () => {
      const ordinaryJobs = Array.from({ length: 6000 }, (_, i) => ({
        id: `job_ord_${i}`,
        user_id: "user_owner",
        status: "completed",
        delivered_units: 10,
        target_volume_max: 10,
        charged_credits: 70,
      }));

      const world: FakeWorld = {
        jobGroups: [{ id: "grp_b", user_id: "user_owner", parts_planned: 2 }],
        jobGroupParts: [
          { group_id: "grp_b", part_index: 1, job_id: "job_b1" },
          { group_id: "grp_b", part_index: 2, job_id: "job_b2" },
        ],
        jobs: [
          {
            id: "job_b1",
            user_id: "user_owner",
            status: "completed",
            delivered_units: 40,
            target_volume_max: 40,
            charged_credits: 280,
          },
          {
            id: "job_b2",
            user_id: "user_owner",
            status: "completed",
            delivered_units: 40,
            target_volume_max: 40,
            charged_credits: 280,
          },
          ...ordinaryJobs,
        ],
      };

      const queryRecorder: any[] = [];
      mockAdminDb = createFakeDb(world, queryRecorder);

      const req = new NextRequest("http://localhost/api/jobs/job_b1/group-parts");
      const res = await GET(req, { params: Promise.resolve({ id: "job_b1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.parts).toHaveLength(2);

      const jobsQueries = queryRecorder.filter((q) => q.table === "jobs");
      expect(jobsQueries.length).toBeGreaterThan(0);
      for (const q of jobsQueries) {
        expect(q.inFilter).not.toBeNull();
        expect(q.inFilter.col).toBe("id");
        expect(q.inFilter.vals).toEqual(["job_b1", "job_b2"]);
      }
    });

    it("(c) 40 parts ⇒ 40 entries", async () => {
      const partsPlanned = 40;
      const jobGroupParts = Array.from({ length: partsPlanned }, (_, i) => ({
        group_id: "grp_40",
        part_index: i + 1,
        job_id: `job_p_${i + 1}`,
      }));
      const jobs = Array.from({ length: partsPlanned }, (_, i) => ({
        id: `job_p_${i + 1}`,
        user_id: "user_owner",
        status: "completed",
        delivered_units: 40,
        target_volume_max: 40,
        charged_credits: 280,
      }));

      const world: FakeWorld = {
        jobGroups: [{ id: "grp_40", user_id: "user_owner", parts_planned: partsPlanned }],
        jobGroupParts,
        jobs,
      };
      mockAdminDb = createFakeDb(world);

      const req = new NextRequest("http://localhost/api/jobs/job_p_1/group-parts");
      const res = await GET(req, { params: Promise.resolve({ id: "job_p_1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.total).toBe(40);
      expect(json.parts).toHaveLength(40);
      for (let i = 0; i < 40; i++) {
        expect(json.parts[i].index).toBe(i + 1);
        expect(json.parts[i].jobId).toBe(`job_p_${i + 1}`);
      }
    });

    it("(d) another user's part id ⇒ 200 parts [] (no leak)", async () => {
      const world: FakeWorld = {
        jobGroups: [{ id: "grp_other", user_id: "other_user", parts_planned: 3 }],
        jobGroupParts: [
          { group_id: "grp_other", part_index: 1, job_id: "job_other_1" },
          { group_id: "grp_other", part_index: 2, job_id: "job_other_2" },
        ],
        jobs: [
          {
            id: "job_other_1",
            user_id: "other_user",
            status: "completed",
            delivered_units: 40,
            target_volume_max: 40,
            charged_credits: 280,
          },
        ],
      };
      mockAdminDb = createFakeDb(world);

      const req = new NextRequest("http://localhost/api/jobs/job_other_1/group-parts");
      const res = await GET(req, { params: Promise.resolve({ id: "job_other_1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true, parts: [], total: 0 });
    });

    it("(e) an ordinary job ⇒ parts []", async () => {
      const world: FakeWorld = {
        jobGroups: [],
        jobGroupParts: [],
        jobs: [
          {
            id: "job_ordinary",
            user_id: "user_owner",
            status: "completed",
            delivered_units: 20,
            target_volume_max: 20,
            charged_credits: 140,
          },
        ],
      };
      mockAdminDb = createFakeDb(world);

      const req = new NextRequest("http://localhost/api/jobs/job_ordinary/group-parts");
      const res = await GET(req, { params: Promise.resolve({ id: "job_ordinary" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true, parts: [], total: 0 });
    });

    it.each([
      ["code 42P01", { code: "42P01", message: "relation does not exist" }],
      ["code PGRST205", { code: "PGRST205", message: "table not found" }],
      ["message Could not find the table", { message: "Could not find the table in the schema cache" }],
    ])("(f) job_group_parts error %s ⇒ parts []", async (_label, error) => {
      const world: FakeWorld = {
        jobGroups: [],
        jobGroupParts: [],
        jobs: [],
        errors: { job_group_parts: error },
      };
      mockAdminDb = createFakeDb(world);

      const req = new NextRequest("http://localhost/api/jobs/job_any_1/group-parts");
      const res = await GET(req, { params: Promise.resolve({ id: "job_any_1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true, parts: [], total: 0 });
    });

    it("(f) error XX000 ⇒ 503 GROUP_PARTS_UNAVAILABLE_AR", async () => {
      const world: FakeWorld = {
        jobGroups: [],
        jobGroupParts: [],
        jobs: [],
        errors: { job_group_parts: { code: "XX000", message: "internal db crash" } },
      };
      mockAdminDb = createFakeDb(world);

      const req = new NextRequest("http://localhost/api/jobs/job_any_1/group-parts");
      const res = await GET(req, { params: Promise.resolve({ id: "job_any_1" }) });
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json).toEqual({ success: false, error: GROUP_PARTS_UNAVAILABLE_AR });
    });

    it("(f) never-resolving read ⇒ 503 GROUP_PARTS_UNAVAILABLE_AR within 4 s", async () => {
      vi.useFakeTimers();
      const world: FakeWorld = {
        jobGroups: [],
        jobGroupParts: [],
        jobs: [],
        hangs: { job_group_parts: true },
      };
      mockAdminDb = createFakeDb(world);

      const req = new NextRequest("http://localhost/api/jobs/job_any_1/group-parts");
      const resPromise = GET(req, { params: Promise.resolve({ id: "job_any_1" }) });

      await vi.advanceTimersByTimeAsync(4000);
      const res = await resPromise;
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json).toEqual({ success: false, error: GROUP_PARTS_UNAVAILABLE_AR });
      vi.useRealTimers();
    });

    it("(g) no user ⇒ 401; bad id ⇒ 400", async () => {
      // 1. no user => 401
      mockUser = null;
      const reqAuth = new NextRequest("http://localhost/api/jobs/job_valid_1/group-parts");
      const resAuth = await GET(reqAuth, { params: Promise.resolve({ id: "job_valid_1" }) });
      expect(resAuth.status).toBe(401);
      const jsonAuth = await resAuth.json();
      expect(jsonAuth).toEqual({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." });

      // 2. bad id => 400
      mockUser = { id: "user_owner" };
      for (const badId of ["", "a".repeat(121), "<script>", "id with spaces", "job;drop"]) {
        const reqBad = new NextRequest(`http://localhost/api/jobs/bad/group-parts`);
        const resBad = await GET(reqBad, { params: Promise.resolve({ id: badId }) });
        expect(resBad.status).toBe(400);
        const jsonBad = await resBad.json();
        expect(jsonBad).toEqual({ success: false, error: "معرف الطلب مطلوب" });
      }
    });
  });

  describe("T8 Component GroupPartsList", () => {
    it("3 parts ⇒ 3 links with hrefs /dashboard/requests/<jobId> and texts «الجزء ١ من ٣» …, aria-current on the current one", () => {
      const parts = [
        { index: 1, jobId: "job_part_1", status: "completed", delivered: 40, requested: 40 },
        { index: 2, jobId: "job_part_2", status: "completed", delivered: 35, requested: 40 },
        { index: 3, jobId: "job_part_3", status: "failed", delivered: 0, requested: 40 },
      ];

      const html = renderToStaticMarkup(
        createElement(GroupPartsList, {
          parts,
          total: 3,
          currentJobId: "job_part_2",
        })
      );

      expect(html).toContain('data-testid="group-parts"');
      expect(html).toContain(GROUP_PARTS_TITLE_AR);

      // Links check
      expect(html).toContain('href="/dashboard/requests/job_part_1"');
      expect(html).toContain(groupPartLinkAr(1, 3)); // «الجزء ١ من ٣»
      expect(html).toContain(REQUEST_STATUS_LABEL_AR.done); // «مكتمل»

      expect(html).toContain('href="/dashboard/requests/job_part_2"');
      expect(html).toContain(groupPartLinkAr(2, 3)); // «الجزء ٢ من ٣»
      expect(html).toContain(REQUEST_STATUS_LABEL_AR.partial); // «مكتمل جزئيًا»
      expect(html).toContain('aria-current="page"');

      expect(html).toContain('href="/dashboard/requests/job_part_3"');
      expect(html).toContain(groupPartLinkAr(3, 3)); // «الجزء ٣ من ٣»
      expect(html).toContain(REQUEST_STATUS_LABEL_AR.refunded); // «تعذر التنفيذ · حجز مؤقت مُحرَّر»
    });

    it("1 part with total 1 ⇒ empty", () => {
      const parts = [
        { index: 1, jobId: "job_part_1", status: "completed", delivered: 40, requested: 40 },
      ];

      const html = renderToStaticMarkup(
        createElement(GroupPartsList, {
          parts,
          total: 1,
          currentJobId: "job_part_1",
        })
      );

      expect(html).toBe("");
    });
  });

  describe("T8 Page wiring static assertions", () => {
    it("page.tsx imports GroupPartsList and calls /group-parts exactly once inside an effect gated on read === 'done' && jobId", () => {
      const pageSource = readFileSync("src/app/dashboard/requests/[id]/page.tsx", "utf-8");

      // imports GroupPartsList
      expect(pageSource).toMatch(/import\s+GroupPartsList\s+from\s+["']@\/components\/mission\/GroupPartsList["']/);

      // calls /group-parts exactly once
      const groupPartsCalls = pageSource.match(/\/group-parts/g);
      expect(groupPartsCalls).not.toBeNull();
      expect(groupPartsCalls!.length).toBe(1);

      // gated on read === "done" && jobId
      expect(pageSource).toMatch(/if\s*\(\s*read\s*!==\s*["']done["']\s*\|\|\s*!jobId\s*\)\s*return;/);

      // renders GroupPartsList directly after </header>
      expect(pageSource).toMatch(/<\/header>[\s\S]*?<GroupPartsList/);
    });
  });
});
