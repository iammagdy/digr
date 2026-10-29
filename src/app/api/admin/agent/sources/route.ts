import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../../lib/supabase/server";
import { loadSourceHealth } from "../../../../../lib/agentMission/adminActions";

export const dynamic = "force-dynamic";

/** Admin only. The health of the sources the agent calls (demoted or skipped for the time window, with the reason) and what each really cost per row. Read only. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json(await loadSourceHealth(createAdminClient()));
}
