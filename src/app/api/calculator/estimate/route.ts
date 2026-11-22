import { NextRequest, NextResponse } from "next/server";
import { loadCustomerMission } from "@/lib/agentMission/customerActions";
import { RESEARCH_GROUP_MAX_PARTS } from "@/lib/agentMission/researchGroup";
import { TEMPORARY_FAILURE_NO_CHARGE_AR } from "@/lib/customerError";
import { calculatorCardOf, type CalculatorCard } from "@/lib/missionEstimate";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { PUBLIC_LIMITS_PER_MINUTE, RATE_LIMITED_MESSAGE_AR, clientKey, createRateLimiter } from "@/lib/server/publicRateLimit";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ windowMs: 60_000, max: PUBLIC_LIMITS_PER_MINUTE.estimate });
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

function failure(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status, headers: PRIVATE_HEADERS });
}

export async function POST(req: NextRequest) {
  const decision = limiter.check(clientKey(req.headers));
  if (!decision.allowed) {
    return NextResponse.json({ success: false, error: RATE_LIMITED_MESSAGE_AR }, {
      status: 429, headers: { ...PRIVATE_HEADERS, "Retry-After": String(decision.retryAfterSeconds) },
    });
  }

  const body = await req.json().catch(() => null);
  const ids: unknown = body?.missionIds;
  if (!body || Object.keys(body).length !== 1 || !Array.isArray(ids) ||
      ids.length < 1 || ids.length > RESEARCH_GROUP_MAX_PARTS ||
      !ids.every((id): id is string => typeof id === "string" && safeMissionId(id) !== null) ||
      new Set(ids).size !== ids.length) {
    return failure(400, "بيانات الطلب غير صالحة.");
  }

  const auth = await resolveMissionViewer(req);
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", PRIVATE_HEADERS["Cache-Control"]);
    return auth.response;
  }

  try {
    const client = createAdminClient();
    const { userId, isGuest } = auth.viewer;
    const cards: Array<{ missionId: string; card: CalculatorCard }> = [];
    for (const missionId of ids) {
      const result = await loadCustomerMission(client, { id: missionId, userId, isGuest });
      if (!result.ok) return failure(result.status, result.error);
      cards.push({ missionId, card: calculatorCardOf(result.view) });
    }
    return NextResponse.json({ success: true, cards }, { headers: PRIVATE_HEADERS });
  } catch {
    return failure(503, TEMPORARY_FAILURE_NO_CHARGE_AR);
  }
}
