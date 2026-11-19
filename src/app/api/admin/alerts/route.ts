import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin, Query } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { MISSION_TABLE } from "@/lib/agentMission/constants";
import { ADDON_MARKER_COLUMN, withoutAddonRows } from "@/lib/agentMission/addonMarker";

export const dynamic = "force-dynamic";

/** The most failed missions one bell read looks at (the API's own page size); more is a lower bound. */
const FAILED_READ_CAP = 1000;

/**
 * Admin bell: pending top-ups, new users (today) and failed requests (last 24h).
 * DT-20261118-06: the failed requests are the `missions` rows that ended «failed» in the last 24 h (a customer request is inserted there only; `jobs` holds just the money
 * record of an approved mission). Add-on rows (a paid review or fix) are not requests. The keys stay `failedJobs` / `failedTotal` so the shell's bell is unchanged.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables, users } = auth.ctx;
  const dayAgo = new Date(Date.now() - 86400000).toISOString();

  const [pending, failed, newUsers] = await Promise.all([
    tables.listRows({ databaseId: "digr", tableId: "topups", queries: [Query.equal("status", "pending"), Query.orderDesc("createdAt"), Query.limit(10)] }),
    createAdminClient().from(MISSION_TABLE).select(`id,reserved_points,created_at,updated_at,${ADDON_MARKER_COLUMN}`).eq("status", "failed").gte("updated_at", dayAgo).order("updated_at", { ascending: false }).limit(FAILED_READ_CAP),
    users.list({ queries: [Query.greaterThanEqual("registration", dayAgo), Query.orderDesc("registration"), Query.limit(5)] }),
  ]);
  if (failed.error) return NextResponse.json({ error: "تعذّر قراءة المهام الآن." }, { status: 500 });
  const failedRows = withoutAddonRows((failed.data ?? []) as Array<{ id: string; reserved_points: number | null; created_at: string; addon?: unknown }>);

  return NextResponse.json({
    pendingTopups: pending.rows.map((r: any) => ({ id: r.$id, senderName: r.senderName || "", reference: r.reference, amountEgp: r.amountEgp, createdAt: r.createdAt })),
    pendingTotal: pending.total,
    newUsers: { total: newUsers.total, latest: newUsers.users[0] ? { name: newUsers.users[0].name, at: newUsers.users[0].registration } : null },
    failedJobs: failedRows.slice(0, 5).map((m) => ({ id: m.id, reservedCredits: m.reserved_points ?? 0, createdAt: m.created_at })),
    failedTotal: failedRows.length,
  });
}
