import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import { EXPLORATION_TABLE, PLANNER_EVENT_ROW_ENDPOINT } from "@/lib/modelPlanner/exploration";
import { PLANNING_STEP_TITLES, currentLineAr, planningSteps, type PlannerEvent, type PlannerEventKind } from "@/lib/missionView";

export const dynamic = "force-dynamic";

const KINDS: ReadonlySet<string> = new Set(["understood", "searched", "sampled", "sample_slow", "switched", "adjusting", "planned", "asked", "stopped"]);

/**
 * The planning steps of ONE chat turn, as they really happen: the planner writes an event row for everything it does (it understood, it searched, it took a sample, it replaced a source,
 * it priced the plan) and the steps and their states are made from those rows. Read only, the customer's own rows only. The page asks every few seconds while it waits for the plan.
 */
export async function GET(req: NextRequest) {
  try {
    const requestId = String(req.nextUrl.searchParams.get("requestId") ?? "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return NextResponse.json({ success: false, error: "bad_request" }, { status: 400 });
    const auth = await authenticateUser(req);
    if (!auth.ok) return auth.response;
    const { data } = await createAdminClient().from(EXPLORATION_TABLE).select("params_digest, created_at").eq("request_id", requestId).eq("user_id", auth.user.id).eq("endpoint_id", PLANNER_EVENT_ROW_ENDPOINT).order("created_at", { ascending: true }).limit(60);
    const events: PlannerEvent[] = (Array.isArray(data) ? data : []).flatMap((r: any) => {
      const d = r?.params_digest;
      if (!d || typeof d !== "object" || !KINDS.has(String(d.kind))) return [];
      return [{ kind: d.kind as PlannerEventKind, at: Date.parse(String(r.created_at)) || Number(d.at) || 0, ...(typeof d.n === "number" ? { n: d.n } : {}), ...(typeof d.rows === "number" ? { rows: d.rows } : {}) }];
    });
    const last = events[events.length - 1]?.kind;
    const finished = last === "planned" ? "plan" : last === "asked" ? "asked" : last === "stopped" ? "stopped" : null;
    const steps = planningSteps(events, { finished });
    return NextResponse.json({ success: true, finished, steps, currentLineAr: currentLineAr(steps) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    console.warn("[chat:planning_events_failed]", String(err?.message || "").slice(0, 120));
    return NextResponse.json({ success: true, finished: null, steps: planningSteps([]), currentLineAr: PLANNING_STEP_TITLES[0] });
  }
}
