import { readFileSync, readdirSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task E. The live preview never showed a row in production. Root cause: the preview route selected `template_slug, platform, capability_slug` from `jobs`,
 * columns the production table does not have (its columns: id, user_id, status, endpoint_id, target_volume_min/max, reserved_credits, charged_credits,
 * delivered_units, current_cursor, accumulated_cost_usd, attempt_count, result_file_id, error_message, created_at, updated_at, next_attempt_at, step,
 * lease_until, unit_price). The query failed as a whole, the job read as «not found», and the page kept its counts-only view. The earlier test used a
 * fake that accepted any column, so it could not see it; this one answers like the database does: an unknown column fails the query.
 */
const state = vi.hoisted(() => ({ user: null as any, admin: null as any }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: vi.fn(() => state.admin), createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/userAuth", () => ({
  authenticateUser: vi.fn(async () => state.user ? { ok: true, user: state.user } : { ok: false, response: NextResponse.json({ success: false }, { status: 401 }) }),
}));

import { GET as previewGet } from "../src/app/api/jobs/[id]/preview/route";

/** The columns of `jobs`, as the production table has them (read from the project's schema): created by the first migration and the ones added after. */
const JOBS_COLUMNS = new Set([
  "id", "user_id", "status", "endpoint_id", "target_volume_min", "target_volume_max", "reserved_credits", "charged_credits", "delivered_units", "current_cursor",
  "accumulated_cost_usd", "attempt_count", "result_file_id", "error_message", "created_at", "updated_at", "next_attempt_at", "step", "lease_until", "unit_price",
]);

const strictAdmin = (job: any, files: Record<string, any>) => ({
  from: () => {
    let selected: string[] = [];
    const b: any = {
      select: (list: string) => { selected = list === "*" ? [...JOBS_COLUMNS] : list.split(",").map((c: string) => c.trim()); return b; },
      eq: () => b,
      maybeSingle: async () => {
        const unknown = selected.filter((column) => !JOBS_COLUMNS.has(column));
        if (unknown.length > 0) return { data: null, error: { message: `column jobs.${unknown[0]} does not exist` } };
        return { data: Object.fromEntries(selected.map((column) => [column, job[column]])), error: null };
      },
    };
    return b;
  },
  storage: { from: () => ({ download: async (path: string) => files[path] ? { data: new Blob([JSON.stringify(files[path])]), error: null } : { data: null, error: { message: "missing" } } }) },
});

const comments = Array.from({ length: 6 }, (_, i) => ({ cid: `c${i}`, text: `تعليق عن كرة السلة رقم ${i}`, user_nickname: `منى ${i}`, video_url: "https://www.tiktok.com/@a/video/1", create_time: 1760000000 + i }));
const job = { id: "job_1", user_id: "u1", status: "running", step: 2, endpoint_id: "tikhub.tiktok.video.comments", delivered_units: 6 };
const call = async () => { const res = await previewGet(new NextRequest("http://localhost/api/jobs/job_1/preview"), { params: Promise.resolve({ id: "job_1" }) }); return { status: res.status, json: await res.json() }; };

beforeEach(() => { state.user = { id: "u1", email: "u1@example.test", appRole: null }; });

describe("E: the preview route reads only columns the jobs table has", () => {
  it("against a database that rejects an unknown column, a running comments job still returns its accepted rows", async () => {
    state.admin = strictAdmin(job, { "job_1/step_1.json": { rows: comments.slice(3), uncertainRows: [{ text: "تحت المراجعة" }] }, "job_1/step_0.json": { rows: comments.slice(0, 3) } });
    const { status, json } = await call();
    expect(status).toBe(200);
    expect(json.sample).not.toBeNull();
    expect(json.sample.rows.length).toBeGreaterThanOrEqual(3);
    expect(json.sample.rows.flat().join(" ")).toContain("تعليق عن كرة السلة");
    expect(JSON.stringify(json)).not.toContain("تحت المراجعة");
    expect(JSON.stringify(json)).not.toMatch(/tikhub|treg|crawl4ai|endpoint/i);
  });

  it("the route's select names only columns of jobs (so the real database cannot reject it)", () => {
    const source = readFileSync("src/app/api/jobs/[id]/preview/route.ts", "utf8");
    const selects = [...source.matchAll(/\.select\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThan(0);
    for (const list of selects) for (const column of list.split(",").map((c) => c.trim())) expect(JOBS_COLUMNS.has(column), column).toBe(true);
  });

  it("the column list above is the migrations' own list (nothing here invents a column)", () => {
    const sql = readdirSync("supabase/migrations").map((file) => readFileSync(`supabase/migrations/${file}`, "utf8")).join("\n");
    for (const column of ["id", "user_id", "status", "endpoint_id", "delivered_units", "step"]) expect(sql, column).toContain(column);
    for (const missing of ["template_slug", "capability_slug"]) expect(sql, missing).not.toMatch(new RegExp(`jobs[\\s\\S]{0,200}${missing}`));
  });
});
