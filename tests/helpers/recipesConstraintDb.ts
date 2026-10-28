import { createMemoryDb } from "./memoryDb";

/**
 * A stand-in for the `recipes` table AS APPLIED in production (read back with SELECT from pg_constraint on 2026-10-28): every CHECK, the primary key, UNIQUE (slug, version), the partial unique
 * index «one reviewed version per slug» and the BEFORE UPDATE OR DELETE guard. Constraints are checked in the order of their names, as Postgres does, and a failure answers the error text
 * Postgres gives («new row for relation "recipes" violates check constraint "recipes_review_complete"», code 23514). Every other table is the ordinary in-memory one.
 */
const isObject = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);

export const RECIPE_CHECKS: Array<[string, (r: any) => boolean]> = [
  ["recipes_catalog_snapshot_sha256_check", (r) => r.catalog_snapshot_sha256 == null || /^[0-9a-f]{64}$/.test(String(r.catalog_snapshot_sha256))],
  ["recipes_endpoint_id_check", (r) => typeof r.endpoint_id === "string" && r.endpoint_id.length >= 3 && r.endpoint_id.length <= 200],
  ["recipes_field_map_check", (r) => isObject(r.field_map)],
  ["recipes_fixture_refs_check", (r) => Array.isArray(r.fixture_refs)],
  ["recipes_params_template_check", (r) => isObject(r.params_template)],
  ["recipes_price_basis_check", (r) => isObject(r.price_basis)],
  ["recipes_review_complete", (r) => r.status !== "reviewed" || (r.reviewed_by != null && r.reviewed_at != null && Array.isArray(r.fixture_refs) && r.fixture_refs.length >= 1)],
  ["recipes_slug_check", (r) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(String(r.slug))],
  ["recipes_status_check", (r) => ["draft", "reviewed", "retired"].includes(r.status)],
  ["recipes_version_check", (r) => Number.isInteger(r.version) && r.version >= 1],
];

export function createRecipesConstraintDb() {
  const db = createMemoryDb();
  const inserted: any[] = [];
  const failures: Array<{ slug: string; code: string; message: string }> = [];
  const recipeRows = () => db.rows("recipes");
  const insert = (input: any) => {
    const row = { status: "draft", fixture_refs: [], created_by: "agent", reviewed_by: null, reviewed_at: null, catalog_snapshot_sha256: null, ...input };
    const fail = (code: string, message: string) => { failures.push({ slug: String(row.slug), code, message }); return Promise.resolve({ data: null, error: { code, message } }); };
    for (const [name, ok] of RECIPE_CHECKS) if (!ok(row)) return fail("23514", `new row for relation "recipes" violates check constraint "${name}"`);
    if (recipeRows().some((r: any) => r.slug === row.slug && r.version === row.version)) return fail("23505", 'duplicate key value violates unique constraint "recipes_slug_version_key"');
    if (row.status === "reviewed" && recipeRows().some((r: any) => r.slug === row.slug && r.status === "reviewed")) return fail("23505", 'duplicate key value violates unique constraint "recipes_one_reviewed_per_slug"');
    recipeRows().push({ id: `rcp_${recipeRows().length + 1}`, created_at: new Date().toISOString(), ...row });
    inserted.push(row);
    return Promise.resolve({ data: row, error: null });
  };
  const client = {
    ...db,
    from: (t: string) => {
      const b = db.from(t);
      return t === "recipes" ? Object.assign(Object.create(b), { insert }) : b;
    },
  };
  return Object.assign(client, { inserted, failures });
}
