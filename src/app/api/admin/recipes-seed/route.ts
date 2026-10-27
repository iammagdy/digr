import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";
import { RECIPE_SEEDS, seedRecipes } from "../../../../lib/modelPlanner/recipeSeeds";

export const dynamic = "force-dynamic";

/** Admin only: the reviewed recipes the button «تحميل الوصفات المثبتة» loads. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ success: true, recipes: RECIPE_SEEDS.map((s) => s.title) });
}

/** Admin only: inserts the reviewed recipes that are missing (never changes or deletes a saved one). The recipes table must be applied (docs/proposals/agent-loop/01_recipes.sql). */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const report = await seedRecipes(createAdminClient());
  return NextResponse.json({ success: true, ...report });
}
