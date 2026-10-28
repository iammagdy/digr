import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { createRecipesConstraintDb } from "./helpers/recipesConstraintDb";
import { RECIPE_SEEDS, SEED_FIXTURES, recipeInsertErrorAr, seedRecipes, seedRow } from "../src/lib/modelPlanner/recipeSeeds";
import { loadTregCatalog } from "../src/lib/treg/catalog";

const state = vi.hoisted(() => ({ admin: true as boolean, client: null as any }));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin ? { ok: true, ctx: { adminId: "adm-1", audit: vi.fn(async () => undefined) } } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));

const catalog = loadTregCatalog();
const endpointsOfSeeds = [...new Set(RECIPE_SEEDS.flatMap((s) => s.plan.steps.map((st: any) => String(st.endpointId))))];
/** Three real successful exploration calls with a cost, per endpoint: a real measurement (MIN_OBSERVATIONS). */
const measureAll = (db: ReturnType<typeof createRecipesConstraintDb>, ids = endpointsOfSeeds) => db.seed("exploration_calls", ids.flatMap((id) => [0.004, 0.005, 0.006].map((c) => ({ endpoint_id: id, cost_usd: c, http_status: 200, rows_returned: 5, created_at: "2026-10-27T10:00:00Z" }))));

describe("the 8 seeds against the recipes table AS APPLIED (constraints read back from production)", () => {
  it("REPRODUCES production: the first version inserted every seed as `reviewed` with no reviewer, no review date and no fixture ref, and all 8 were refused by recipes_review_complete", async () => {
    const db = createRecipesConstraintDb();
    expect(RECIPE_SEEDS).toHaveLength(8);
    for (const s of RECIPE_SEEDS) {
      const old = { ...seedRow(s).row, status: "reviewed" as const, reviewed_by: null, reviewed_at: null, fixture_refs: [] as unknown[] };
      const { error } = await db.from("recipes").insert(old);
      expect(error?.message).toBe('new row for relation "recipes" violates check constraint "recipes_review_complete"');
      expect(error?.code).toBe("23514");
    }
    expect(db.failures).toHaveLength(8);
    expect(db.rows("recipes")).toHaveLength(0);
  });

  it("the constraint stand-in is faithful: slug, version, JSON types, snapshot hash, unique (slug, version) and one reviewed version per slug all refuse what the real table refuses", async () => {
    const db = createRecipesConstraintDb();
    const good = { ...seedRow(RECIPE_SEEDS[0]).row };
    const refused = async (patch: Record<string, unknown>, name: string) => expect((await db.from("recipes").insert({ ...good, ...patch })).error?.message, name).toContain(`"${name}"`);
    await refused({ slug: "Bad Slug" }, "recipes_slug_check");
    await refused({ version: 0 }, "recipes_version_check");
    await refused({ params_template: [] }, "recipes_params_template_check");
    await refused({ field_map: "x" }, "recipes_field_map_check");
    await refused({ price_basis: null }, "recipes_price_basis_check");
    await refused({ fixture_refs: {} }, "recipes_fixture_refs_check");
    await refused({ catalog_snapshot_sha256: "abc" }, "recipes_catalog_snapshot_sha256_check");
    expect((await db.from("recipes").insert(good)).error).toBeNull();
    expect((await db.from("recipes").insert(good)).error?.message).toContain("recipes_slug_version_key");
    const reviewed = { ...good, version: 2, status: "reviewed", reviewed_by: "adm", reviewed_at: "2026-10-28T00:00:00Z", fixture_refs: [{ path: "x" }] };
    expect((await db.from("recipes").insert(reviewed)).error).toBeNull();
    expect((await db.from("recipes").insert({ ...reviewed, version: 3 })).error?.message).toContain("recipes_one_reviewed_per_slug");
  });

  it("with NO real measurement all 8 go in as DRAFTS with the catalog cost marked estimated, and none fails; pressing again adds nothing and changes nothing", async () => {
    const db = createRecipesConstraintDb();
    const report = await seedRecipes(db, { adminId: "adm-1", catalog });
    expect({ inserted: report.inserted, present: report.present, failed: report.failed, tableApplied: report.tableApplied }).toEqual({ inserted: 8, present: 0, failed: 0, tableApplied: true });
    expect(db.failures).toEqual([]);
    expect(report.items.map((i) => i.title)).toEqual(RECIPE_SEEDS.map((s) => s.title));
    for (const item of report.items) expect(item).toMatchObject({ state: "inserted", status: "draft", costBasis: "estimated" });
    for (const row of db.rows("recipes")) {
      expect(row).toMatchObject({ status: "draft", reviewed_by: null, created_by: "seed" });
      expect(row.price_basis.costEstimated).toBe(true);
      expect(Object.values(row.price_basis.costBasis)).not.toContain("measured");
      expect(Object.keys(row.price_basis.catalogCostUsd).length).toBeGreaterThan(0);
      expect(row.fixture_refs.length).toBeGreaterThan(0);
    }
    const again = await seedRecipes(db, { adminId: "adm-1", catalog });
    expect({ inserted: again.inserted, present: again.present, failed: again.failed }).toEqual({ inserted: 0, present: 8, failed: 0 });
    expect(db.rows("recipes")).toHaveLength(8);
  });

  it("a seed whose every endpoint has a REAL measured cost (3 or more real calls) goes in `reviewed`, with the pressing admin as reviewer, the date and its fixture refs; a partly measured seed stays a draft", async () => {
    const db = createRecipesConstraintDb();
    measureAll(db, endpointsOfSeeds.filter((id) => id !== "icypeas.people.search"));
    const report = await seedRecipes(db, { adminId: "adm-1", catalog, now: new Date("2026-10-28T09:00:00Z") });
    expect(report.failed).toBe(0);
    expect(report.items.filter((i) => i.status === "reviewed")).toHaveLength(7);
    const people = report.items.find((i) => i.title === "صنّاع القرار")!;
    expect(people).toMatchObject({ status: "draft", costBasis: "estimated" });
    const x = db.rows("recipes").find((r: any) => r.endpoint_id === "anyapi.x.user.posts");
    expect(x).toMatchObject({ status: "reviewed", reviewed_by: "adm-1", reviewed_at: "2026-10-28T09:00:00.000Z" });
    expect(x.fixture_refs.map((f: any) => f.path)).toContain("tests/fixtures/replay/real-rows_anyapi.x.user.posts.json");
    expect(x.price_basis).toMatchObject({ costEstimated: false });
    expect(x.price_basis.measuredAvgCallUsd["anyapi.x.user.posts"]).toBeCloseTo(0.005, 6);
    // proven but nobody to name as reviewer: a draft, never a reviewed row without a reviewer
    const db2 = createRecipesConstraintDb();
    measureAll(db2);
    const noAdmin = await seedRecipes(db2, { catalog });
    expect(noAdmin.failed).toBe(0);
    expect(noAdmin.items.every((i) => i.status === "draft")).toBe(true);
  });

  it("if the table still refuses the review, the seed is kept as a draft and the item says why; every fixture ref points at a file that exists", async () => {
    const db = createRecipesConstraintDb();
    measureAll(db);
    const strict = { ...db, from: (t: string) => { const b: any = db.from(t); return t !== "recipes" ? b : Object.assign(Object.create(b), { insert: (row: any) => (row.status === "reviewed" ? Promise.resolve({ data: null, error: { code: "23514", message: 'new row for relation "recipes" violates check constraint "recipes_review_complete"' } }) : b.insert(row)) }); } };
    const report = await seedRecipes(strict, { adminId: "adm-1", catalog });
    expect(report).toMatchObject({ inserted: 8, failed: 0 });
    expect(report.items[0].noteAr).toContain("رفض الجدول المراجعة");
    expect(db.rows("recipes").every((r: any) => r.status === "draft")).toBe(true);
    for (const refs of Object.values(SEED_FIXTURES)) for (const f of refs) expect(existsSync(f.path), f.path).toBe(true);
    for (const id of endpointsOfSeeds) expect(SEED_FIXTURES[id]?.length, id).toBeGreaterThan(0);
  });

  it("a seed that cannot go in is reported with its NAME, the exact Arabic reason and the database's own error: the count is never the only answer", async () => {
    const db = createRecipesConstraintDb();
    const refusing = { ...db, from: (t: string) => { const b: any = db.from(t); return t !== "recipes" ? b : Object.assign(Object.create(b), { insert: () => Promise.resolve({ data: null, error: { code: "42501", message: "permission denied for table recipes" } }) }); } };
    const report = await seedRecipes(refusing, { adminId: "adm-1", catalog });
    expect(report).toMatchObject({ inserted: 0, failed: 8 });
    expect(report.items).toHaveLength(8);
    for (const item of report.items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.reasonAr).toBe("قاعدة البيانات رفضت الصلاحية على جدول الوصفات");
      expect(item.error).toBe("42501: permission denied for table recipes");
    }
    const msg = (name: string) => ({ code: "23514", message: `new row for relation "recipes" violates check constraint "${name}"` });
    expect(recipeInsertErrorAr(msg("recipes_review_complete"))).toContain("اسم المراجع");
    expect(recipeInsertErrorAr(msg("recipes_slug_check"))).toContain("slug");
    expect(recipeInsertErrorAr({ code: "23505", message: 'duplicate key value violates unique constraint "recipes_one_reviewed_per_slug"' })).toContain("مراجَع نافذ");
    expect(recipeInsertErrorAr({ code: "P0001", message: "a reviewed recipe is immutable: create a new version" })).toContain("حارس");
    expect(recipeInsertErrorAr({ code: "XX000", message: "boom" })).toContain("(boom)");
    expect(recipeInsertErrorAr(null)).toContain("غير معروف");
  });
});

describe("the admin route and the screen", () => {
  const post = () => import("../src/app/api/admin/recipes-seed/route").then((m) => m.POST(new NextRequest("http://127.0.0.1:3000/api/admin/recipes-seed", { method: "POST" })));

  it("admin only; an admin gets every seed with its state, and the pressing admin is the reviewer of a proven one", async () => {
    state.admin = false;
    state.client = createRecipesConstraintDb();
    expect((await post()).status).toBe(403);
    state.admin = true;
    measureAll(state.client);
    const body = await (await post()).json();
    expect(body).toMatchObject({ success: true, inserted: 8, failed: 0 });
    expect(body.items).toHaveLength(8);
    expect(state.client.rows("recipes")[0]).toMatchObject({ status: "reviewed", reviewed_by: "adm-1" });
  });

  it("the screen lists each seed by name with its state and, for a failure, the Arabic reason and the database's text; the tracing includes the catalog for the route", () => {
    const page = readFileSync("src/app/admin/planner-selftest/page.tsx", "utf-8");
    for (const needle of ["recipes-seed-items", "seed-reason", "it.reasonAr", "it.error", "it.title", "SEED_STATE_AR", "مراجَعة", "مسودة"]) expect(page, needle).toContain(needle);
    expect(readFileSync("next.config.mjs", "utf-8")).toContain('"/api/admin/recipes-seed": ["./data/treg/treg_catalog_sellable.json"]');
  });
});
