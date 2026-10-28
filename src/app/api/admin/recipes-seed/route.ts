import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";
import { RECIPE_SEEDS, seedRecipes } from "../../../../lib/modelPlanner/recipeSeeds";
import { loadTregCatalog } from "../../../../lib/treg/catalog";

export const dynamic = "force-dynamic";

/** Admin only: the reviewed recipes the button «تحميل الوصفات المثبتة» loads. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ success: true, recipes: RECIPE_SEEDS.map((s) => s.title) });
}

/**
 * Admin only: inserts the pinned recipes that are missing (never changes or deletes a saved one). The recipes table must be applied (docs/proposals/agent-loop/01_recipes.sql).
 * A seed proven by real measurements goes in `reviewed` with the pressing admin as its reviewer; one without goes in as a `draft` with the catalog cost marked estimated.
 * The answer lists every seed with its state and, for a failure, the exact Arabic reason and the database's own text.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  let catalog = null;
  try { catalog = loadTregCatalog(); } catch { /* the catalog cost is an estimate only: the seeds go in without it */ }
  const report = await seedRecipes(createAdminClient(), { adminId: auth.ctx.adminId, catalog });
  return NextResponse.json({ success: true, ...report });
}
